// utils/prefixCommands.js — Système hybride REZO : préfixe texte → commandes slash
//
// Les 100+ commandes du bot restent écrites une seule fois, en slash. Ce module
// transforme un message texte "b!ping arg1 arg2" en fausse interaction Discord
// hydratée (options complètes, reply/defer/editReply/followUp, user/channel/role
// résolus) puis appelle le execute() réel de la commande. Zéro duplication, et
// un préfixe personnalisable par serveur via /prefix.
//
// Garanties :
//   • les commandes à modals/menus/choix fixes refusées proprement (pas un flux
//     reproductible en message texte)
//   • toutes les réponses sont postées dans le salon, jamais en MP — même pour
//     les commandes qui demandent une réponse éphémère
//   • permissions, isOwner, cooldowns et logs s'appliquent à l'identique
const { EmbedBuilder, MessageFlags } = require('discord.js');
const PrefixConfig = require('../models/PrefixConfig');
const { COLORS } = require('./embeds');
const { createBoundedCache } = require('./boundedCache');

// ─── Cache en mémoire : guildId → config simple ───────────────────────────────
// BORNÉ (LRU) : ce chemin est traversé à chaque message, et une Map nue
// conservait une entrée pour chacun des serveurs traversés.
const cache = createBoundedCache({ max: 20_000, ttl: 0, name: 'prefix-config' });
const NEG_TTL = 120_000; // serveur sans config : re-vérifie toutes les 2 min
const negStamp = createBoundedCache({ max: 20_000, ttl: NEG_TTL, name: 'prefix-negatif' });

function invalidate(guildId) {
  cache.delete(guildId);
  negStamp.delete(guildId);
}

async function getGuildConfig(guildId) {
  const cached = cache.get(guildId);
  if (cached !== undefined) return cached;

  const negAt = negStamp.get(guildId);
  if (negAt && Date.now() - negAt < NEG_TTL) return null;

  let cfg = null;
  try {
    cfg = await PrefixConfig.findOne({ guildId }).lean();
  } catch (err) {
    console.error('[prefixCommands] lecture config:', err.message);
    return null;
  }

  if (!cfg || !cfg.enabled || !cfg.prefix) {
    negStamp.set(guildId, Date.now());
    cache.set(guildId, null);
    return null;
  }

  cache.set(guildId, cfg);
  negStamp.delete(guildId);
  return cfg;
}

async function initCache(client) {
  try {
    const docs = await PrefixConfig.find({ enabled: true }).lean();
    for (const doc of docs) cache.set(doc.guildId, doc);
    if (docs.length) console.log(`✅ Cache préfixe amorcé pour ${docs.length} serveur(s)`);
  } catch (err) {
    console.error('[prefixCommands] initCache:', err.message);
  }
}

// ─── Types d'options Discord ──────────────────────────────────────────────────
function optType(opt) {
  const map = {
    3: 'string', 4: 'int', 5: 'bool', 6: 'user', 7: 'channel',
    8: 'role', 9: 'mentionable', 10: 'float', 11: 'attachment',
  };
  return map[opt.type] || null;
}

function parseIdLike(str) {
  const m = String(str).match(/^(?:<@!?$|<@&|<#)?(\d{17,20})>?$/);
  return m ? m[1] : null;
}

function parseValue(raw, kind) {
  const str = String(raw ?? '').trim();
  if (!str) return undefined;
  switch (kind) {
    case 'int': {
      const n = Number.parseInt(str, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'float': {
      const n = Number.parseFloat(str.replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'bool':
      return ['1', 'true', 'vrai', 'oui', 'yes', 'on', 'y', 'o'].includes(str.toLowerCase());
    case 'user':
    case 'channel':
    case 'role':
    case 'mentionable':
      return parseIdLike(str) ?? str; // ID brut ou nom — résolu par hydrateOptions
    default:
      return str;
  }
}

function parseArgs(content) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(content)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ─── Résolution de la commande ────────────────────────────────────────────────
function resolveCommand(client, tokens) {
  if (!tokens.length) return null;
  const name1 = tokens[0];
  const sub1 = tokens[1];

  let cmd = client.commands.get(name1);
  if (cmd) {
    const json = cmd.data.toJSON();
    const opts = json.options || [];
    const subs = opts.filter(o => o.type === 1 || o.type === 2);

    if (!subs.length) {
      // commande simple : tous les tokens suivants sont des arguments
      return { command: cmd, json, rootOpts: opts, groupName: null, subName: null, rest: tokens.slice(1) };
    }

    const sub = opts.find(o => (o.type === 1 || o.type === 2) && o.name === sub1);
    if (sub && sub.type === 1) {
      return { command: cmd, json, rootOpts: sub.options || [], groupName: null, subName: sub.name, rest: tokens.slice(2) };
    }
    if (sub && sub.type === 2) {
      // "b!config bump set" : sub1 est un groupe, tokens[2] la sous-commande
      const subSub = (sub.options || []).find(s => s.name === tokens[2]);
      if (subSub) {
        return {
          command: cmd, json,
          rootOpts: subSub.options || [],
          groupName: sub.name, subName: subSub.name,
          rest: tokens.slice(3),
        };
      }
    }

    // Une seule sous-commande et l'utilisateur ne l'a pas tapée → on l'assume
    if (subs.length === 1 && subs[0].type === 1) {
      return { command: cmd, json, rootOpts: subs[0].options || [], groupName: null, subName: subs[0].name, rest: tokens.slice(2) };
    }

    // Plusieurs sous-commandes, aucune valide → erreur "choisis une sous-commande"
    return { command: cmd, json, rootOpts: null, groupName: null, subName: null, rest: [] };
  }

  // Groupe dont le nom de commande racine n'existe pas seul (rare)
  for (const [, c] of client.commands) {
    const json = c.data.toJSON();
    const grp = (json.options || []).find(
      o => o.type === 2 && o.name === name1 && (o.options || []).some(s => s.name === sub1),
    );
    if (grp) {
      const sub = grp.options.find(s => s.name === sub1);
      return { command: c, json, rootOpts: sub.options || [], groupName: grp.name, subName: sub.name, rest: tokens.slice(2) };
    }
  }

  return null;
}

// ─── Fausse interaction ───────────────────────────────────────────────────────
function makeFakeInteraction({ message, client, cfg, commandName, groupName, subName, resolvedOpts }) {
  const guild = message.guild;
  const guildId = guild?.id ?? null;

  let deferred = false;
  let replied = false;
  let replyTarget = null;

  const withHint = (payload) => {
    if (!cfg.showHint || !guildId) return payload;
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setDescription(`⚙️ Commande exécutée avec le préfixe \`${cfg.prefix}\` — équivalent slash : \`/${commandName}${subName ? ` ${subName}` : ''}\`.`);
    return { ...payload, embeds: [...(payload.embeds || []), embed] };
  };

  // Toujours dans le salon : une réponse de commande préfixée n'est jamais
  // envoyée en MP, même si la commande demandait une réponse éphémère.
  const send = async (payload) => message.channel.send(payload).catch(() => null);

  const interaction = {
    id: `prefix_${message.id}`,
    applicationId: client.user.id,
    type: 2,
    user: message.author,
    member: message.member ?? null,
    guild, guildId,
    channel: message.channel,
    channelId: message.channel?.id,
    client,
    createdTimestamp: Date.now(),
    locale: guild?.preferredLocale ?? 'fr',
    guildLocale: guild?.preferredLocale ?? 'fr',
    appPermissions: message.channel?.permissionsFor?.(client.user) ?? null,
    memberPermissions: message.member?.permissions ?? null,
    token: `prefix_${message.id}_${Date.now()}`,
    version: 1,
    deferred: false,
    replied: false,
    ephemeral: null,
    inGuild: () => Boolean(guildId),
    inCachedGuild: () => Boolean(guild),
    inRawGuild: () => false,

    commandName,
    commandType: 1,
    commandGuildId: guildId,
    commandId: null,
    isChatInputCommand: () => true,
    isRepliable: () => true,

    options: {
      data: resolvedOpts,
      get: (name) => resolvedOpts.find(o => o.name === name) ?? null,
      getString: (name) => {
        const o = resolvedOpts.find(x => x.name === name);
        return o ? String(o.value) : null;
      },
      getInteger: (name) => {
        const o = resolvedOpts.find(x => x.name === name);
        if (!o) return null;
        const n = Number(o.value);
        return Number.isFinite(n) ? n : null;
      },
      getNumber: (name) => {
        const o = resolvedOpts.find(x => x.name === name);
        if (!o) return null;
        const n = Number(o.value);
        return Number.isFinite(n) ? n : null;
      },
      getBoolean: (name) => {
        const o = resolvedOpts.find(x => x.name === name);
        return o ? Boolean(o.value) : null;
      },
      getUser: (name) => resolvedOpts.find(x => x.name === name)?.user ?? null,
      getMember: (name) => resolvedOpts.find(x => x.name === name)?.member ?? null,
      getChannel: (name) => resolvedOpts.find(x => x.name === name)?.channel ?? null,
      getRole: (name) => resolvedOpts.find(x => x.name === name)?.role ?? null,
      getMentionable: (name) => {
        const o = resolvedOpts.find(x => x.name === name);
        return o?.user ?? o?.role ?? o?.value ?? null;
      },
      getAttachment: () => null,
      getSubcommand: () => subName,
      getSubcommandGroup: () => groupName,
    },

    async reply(payload = {}) {
      if (replied || deferred) throw new Error('INTERACTION_ALREADY_REPLIED');
      const ephemeral = payload?.ephemeral === true
        || Boolean(payload?.flags && (Number(payload.flags) & MessageFlags.Ephemeral));
      deferred = true; replied = true;
      interaction.deferred = true; interaction.replied = true;
      interaction.ephemeral = ephemeral ? 'ephemeral' : false;
      replyTarget = await send(withHint(payload));
      return replyTarget;
    },

    async deferReply(payload = {}) {
      if (deferred) throw new Error('INTERACTION_ALREADY_DEFERRED');
      const ephemeral = payload?.ephemeral === true
        || Boolean(payload?.flags && (Number(payload.flags) & MessageFlags.Ephemeral));
      deferred = true;
      interaction.deferred = true;
      interaction.ephemeral = ephemeral ? 'ephemeral' : false;
      message.channel.sendTyping?.().catch(() => {});
      return null;
    },

    async editReply(payload = {}) {
      if (replyTarget) return replyTarget.edit(payload).catch(() => null);
      // defer sans envoi préalable : on poste maintenant
      replyTarget = await send(payload);
      interaction.replied = true;
      return replyTarget;
    },

    async followUp(payload = {}) {
      if (!replyTarget && !interaction.replied) {
        const sent = await send(withHint(payload));
        interaction.replied = true;
        replyTarget = sent;
        return sent;
      }
      return send(payload);
    },

    async showModal() { throw new Error('PREFIX_MODAL_UNSUPPORTED'); },
    async deferUpdate() { throw new Error('PREFIX_COMPONENT_UNSUPPORTED'); },
    async update() { throw new Error('PREFIX_COMPONENT_UNSUPPORTED'); },
  };

  return interaction;
}

// ─── Hydratation des options ──────────────────────────────────────────────────
async function hydrateOptions(interaction, rootOpts, tokens) {
  const resolved = [];
  const missing = [];
  const choiceErrors = [];
  let ti = 0;

  for (const opt of rootOpts) {
    const kind = optType(opt);
    const raw = tokens[ti];
    const hasArg = raw !== undefined && raw !== '';

    if (!hasArg) {
      if (opt.required) missing.push(opt.name);
      continue;
    }
    ti += 1;

    // Options à choix fixes : accepte la valeur OU le libellé (insensible à la casse)
    if (Array.isArray(opt.choices) && opt.choices.length) {
      const needle = String(raw).toLowerCase();
      const hit = opt.choices.find(
        c => String(c.value).toLowerCase() === needle || String(c.name).toLowerCase() === needle,
      );
      if (hit) {
        resolved.push({ name: opt.name, type: opt.type, value: hit.value });
        continue;
      }
      choiceErrors.push({
        name: opt.name,
        liste: opt.choices.slice(0, 8).map(c => `\`${c.value}\``).join(', '),
      });
      if (opt.required) missing.push(opt.name);
      continue;
    }

    const value = parseValue(raw, kind);
    if (value === undefined) {
      if (opt.required) missing.push(opt.name);
      continue;
    }

    if (kind === 'user' || kind === 'mentionable') {
      const id = parseIdLike(raw);
      let member = null;
      if (id) {
        member = interaction.guild?.members?.cache?.get(id)
          || await interaction.guild?.members?.fetch(id).catch(() => null);
      } else {
        const needle = String(raw).replace(/^@/, '').toLowerCase();
        member = interaction.guild?.members?.cache?.find(
          mm => mm.user.username.toLowerCase() === needle || mm.displayName?.toLowerCase() === needle,
        ) ?? null;
        if (!member) member = await interaction.guild?.members?.search({ query: String(raw), limit: 1 }).then(r => r.first()).catch(() => null);
      }
      if (member) {
        resolved.push({ name: opt.name, type: opt.type, value: member.id, user: member.user, member });
        continue;
      }
      // peut-être un rôle (mentionable)
      if (kind === 'mentionable') {
        const role = resolveRole(interaction, raw);
        if (role) { resolved.push({ name: opt.name, type: opt.type, value: role.id, role }); continue; }
      }
      if (opt.required) missing.push(opt.name);
      continue;
    }

    if (kind === 'channel') {
      const id = parseIdLike(raw);
      let ch = id ? interaction.guild?.channels?.cache.get(id) : null;
      if (!ch) ch = interaction.guild?.channels?.cache.find(c => c.name === String(raw).replace(/^#/, ''));
      if (ch) { resolved.push({ name: opt.name, type: opt.type, value: ch.id, channel: ch }); continue; }
      if (opt.required) missing.push(opt.name);
      continue;
    }

    if (kind === 'role') {
      const role = resolveRole(interaction, raw);
      if (role) { resolved.push({ name: opt.name, type: opt.type, value: role.id, role }); continue; }
      if (opt.required) missing.push(opt.name);
      continue;
    }

    resolved.push({ name: opt.name, type: opt.type, value });
  }

  return { resolved, missing, choiceErrors };
}

function resolveRole(interaction, raw) {
  const id = parseIdLike(raw);
  const guild = interaction.guild;
  let role = id ? guild?.roles?.cache.get(id) : null;
  if (!role) {
    const needle = String(raw).replace(/^@/, '').toLowerCase();
    role = guild?.roles?.cache.find(r => r.name.toLowerCase() === needle) ?? null;
  }
  return role;
}

// ─── Aide à l'usage ───────────────────────────────────────────────────────────
function buildUsage(prefix, json, groupName, subName, rootOpts) {
  const args = (rootOpts || [])
    .map(o => (o.required ? `<${o.name}>` : `[${o.name}]`))
    .join(' ');
  return `Usage : \`${prefix}${json.name}${groupName ? ` ${groupName}` : ''}${subName ? ` ${subName}` : ''}${args ? ` ${args}` : ''}\``;
}

// ─── Commandes personnalisées (créées par les membres via /custom) ───────────
// Quand un déclencheur n'est aucune commande du bot, on regarde s'il s'agit
// d'une commande personnalisée du serveur (b!ma-commande). Retourne true si le
// message a été traité (ou refusé explicitement), false si vraiment inconnu.
async function tryCustomCommand({ message, tokens }) {
  const engine = require('./customCommands');
  const name = engine.normalizeName(tokens[0]);
  if (!name) return false;

  const found = await engine.getForUse({
    guildId: message.guildId,
    name,
    userId: message.author.id,
    memberRoleIds: message.member?.roles?.cache ? [...message.member.roles.cache.keys()] : [],
  });

  // Vraiment inconnue : on laisse le message « Commande inconnue » habituel.
  if (!found.ok && found.code === 'NOT_FOUND') return false;

  if (!found.ok) {
    await message.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warning).setDescription(found.message)],
    }).catch(() => {});
    return true;
  }

  const run = await engine.runCustomCommand({
    doc: found.doc,
    userId: message.author.id,
    username: message.author.username,
    displayName: message.member?.displayName || message.author.username,
    memberRoleIds: message.member?.roles?.cache ? [...message.member.roles.cache.keys()] : [],
    guildName: message.guild?.name,
    channelId: message.channelId,
    args: tokens.slice(1).join(' '),
  });

  if (!run.ok) {
    await message.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warning).setDescription(run.message)],
    }).catch(() => {});
    return true;
  }

  await message.channel.send(run.payload).catch(() => {});
  return true;
}

// ─── Traitement principal ─────────────────────────────────────────────────────
async function handlePrefixMessage(message, client) {
  const guildId = message.guildId;
  if (!guildId || message.author.bot) return false;

  const cfg = await getGuildConfig(guildId);
  if (!cfg) return false;

  const content = message.content ?? '';
  if (!content.startsWith(cfg.prefix)) return false;

  if (Array.isArray(cfg.ignoredChannelIds) && cfg.ignoredChannelIds.includes(message.channelId)) return false;

  const body = content.slice(cfg.prefix.length).trim();
  if (!body) return false;

  const tokens = parseArgs(body);
  const match = resolveCommand(client, tokens);

  if (!match) {
    // ── Conditions d'utilisation — avant même une commande personnalisée ────
    // Un message ne peut pas répondre en éphémère : l'invite est publique,
    // sans mentionner l'auteur, et l'acceptation se fait par bouton.
    const tosGate = require('./tosGate');
    if (!(await tosGate.ensurePrefixAccepted(message))) return true;

    // Commande personnalisée d'un membre ? (`b!ma-commande`)
    const handledCustom = await tryCustomCommand({ message, tokens }).catch(err => {
      console.error('[prefix] commande personnalisée:', err.message);
      return false;
    });
    if (handledCustom) return true;

    await message.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warning)
        .setDescription(`Commande inconnue : \`${tokens[0] ?? ''}\`. Tape \`${cfg.prefix}help\` pour la liste, ou \`/custom panel\` pour tes commandes personnalisées.`)],
    }).catch(() => {});
    return true;
  }

  const { command, json, rootOpts, groupName, subName, rest } = match;

  // ── Conditions d'utilisation — aucune commande sans acceptation ───────────
  const tosGate = require('./tosGate');
  if (!(await tosGate.ensurePrefixAccepted(message))) return true;

  // ── Garde-fou licence — mêmes règles qu'en slash ───────────────────────────
  const { checkAccess, isLicenseRequired, lockEmbed } = require('./licenseGate');
  if (guildId && isLicenseRequired(json.name)) {
    const access = await checkAccess(guildId, json.name);
    if (!access.ok) {
      await message.reply({ embeds: [lockEmbed(json.name, { access })] }).catch(() => {});
      return true;
    }
  }

  // ── Commandes à risque — jamais exécutables en texte ──────────────────────
  // Un message n'a pas de modal : sans ce refus, un membre qui a configuré
  // /authentificator pourrait contourner sa propre protection en tapant
  // `préfixe+warn`. On renvoie donc vers la commande slash (fail closed).
  const authGate = require('./authGate');
  if (authGate.isProtectedCommand(json.name)) {
    await message.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warning)
        .setTitle('🔐 Authentification requise')
        .setDescription(
          `La commande \`${cfg.prefix}${json.name}\` agit sur les membres ou la sécurité du serveur :\n`
          + `elle n'est disponible qu'en version slash \`/${json.name}\`, pour permettre la vérification d'identité.\n\n`
          + 'Configurez ou vérifiez votre protection avec `/authentificator` (PIN · 2FA · code de secours).')],
    }).catch(() => {});
    return true;
  }

  // Sous-commandes multiples, aucune fournie
  if (!rootOpts) {
    const subs = (json.options || []).filter(o => o.type === 1).map(o => `\`${o.name}\``).join(', ');
    await message.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warning)
        .setDescription(`\`/${json.name}\` a plusieurs sous-commandes : ${subs}.\n${buildUsage(cfg.prefix, json, groupName, '<sous-commande>', [])}`)],
    }).catch(() => {});
    return true;
  }

  const fake = makeFakeInteraction({
    message, client, cfg, commandName: json.name, groupName, subName, resolvedOpts: [],
  });

  const { resolved, missing, choiceErrors } = await hydrateOptions(fake, rootOpts, rest);
  fake.options.data = resolved;

  if (choiceErrors.length) {
    await message.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warning)
        .setDescription(choiceErrors.map(e => `Valeur invalide pour **${e.name}** : accepte ${e.liste}.`).join('\n'))],
    }).catch(() => {});
    return true;
  }

  if (missing.length) {
    await message.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warning)
        .setDescription(`Argument manquant : **${missing.join(', ')}**.\n${buildUsage(cfg.prefix, json, groupName, subName, rootOpts)}`)],
    }).catch(() => {});
    return true;
  }

  try {
    await command.execute(fake, client);
    PrefixConfig.updateOne(
      { guildId },
      { $inc: { 'stats.used': 1 }, $set: { 'stats.lastUsedAt': new Date() } },
    ).catch(() => {});
    return true;
  } catch (err) {
    if (err.message === 'PREFIX_MODAL_UNSUPPORTED' || err.message === 'PREFIX_COMPONENT_UNSUPPORTED') {
      await message.reply({
        embeds: [new EmbedBuilder().setColor(COLORS.warning)
          .setDescription(`\`/${json.name}${subName ? ` ${subName}` : ''}\` nécessite un **formulaire/menu interactif** : utilise la version slash \`/${json.name}\`.`)],
      }).catch(() => {});
      return true;
    }
    console.error(`[prefix] /${json.name}:`, err);
    const payload = {
      embeds: [new EmbedBuilder().setColor(COLORS.error)
        .setTitle('❌ Une erreur est survenue')
        .setDescription('Veuillez réessayer dans quelques instants.')],
    };
    try {
      if (fake.deferred && !fake.replied) await fake.editReply(payload);
      else if (!fake.replied) await fake.reply(payload);
      else await message.reply(payload).catch(() => {});
    } catch {
      message.reply(payload).catch(() => {});
    }
    return true;
  }
}

module.exports = {
  handlePrefixMessage,
  tryCustomCommand,
  getGuildConfig,
  initCache,
  invalidate,
  parseArgs,
  resolveCommand,
  hydrateOptions,
  makeFakeInteraction,
  buildUsage,
};
