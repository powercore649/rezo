'use strict';
// utils/setupHub.js — Arrivée du bot : salon administrateur + installation.
//
// À l'arrivée sur un serveur, REZO crée un salon privé que seuls les
// administrateurs voient, puis y publie un embed avec un bouton **Start here**.
// Ce bouton ouvre le programme d'installation : la liste réelle des modules
// absents, ce que chacun apporte, et une installation en un clic.
//
// Principes :
//   • rien n'est activé sans un clic explicite — le programme propose, il
//     n'impose pas ;
//   • l'installation réutilise exactement le moteur de l'autopilote
//     (buildPlan / applyPlan / createMissingChannels) : une seule vérité ;
//   • les actions qui modifient la configuration passent le même contrôle de
//     licence que `/autopilote`, sans contournement ;
//   • le salon n'est créé qu'une fois : le document SetupHub sert de mémoire.
//
// Les constructeurs d'embeds et de composants sont purs : ils se vérifient
// hors-ligne, sans client Discord ni base de données.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const SetupHub = require('../models/SetupHub');
const { COLORS } = require('./embeds');
const brand = require('./brand');
const ui = require('./ui');
const { e, emojiObject } = require('./emojiSync');

// Les boutons ne portent aucun emoji, custom compris : le libellé suffit. Les
// emojis animés sont réservés aux options des menus de sélection.
function setupButton(customId, label, style) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}
const { MODULES, CATEGORIES } = require('./efficiencyScore');
const autopilot = require('./autopilot');

const CHANNEL_NAME = 'rezo-admin';
const MAX_SELECT_OPTIONS = 25;
const MAX_OVERWRITES = 12;

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function clip(text, max = 100) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function moduleMeta(key) {
  return MODULES.find(module => module.key === key) || null;
}

/**
 * Décide qui peut utiliser le programme d'installation.
 * Pur : testable sans objet Discord.
 */
function decideSetupAccess({ isOwner = false, isAdmin = false, isManager = false } = {}) {
  if (isOwner) return { allowed: true, reason: 'owner' };
  if (isAdmin) return { allowed: true, reason: 'admin' };
  if (isManager) return { allowed: true, reason: 'manager' };
  return { allowed: false, reason: 'denied' };
}

function memberAccess(interaction) {
  const has = permission => Boolean(interaction.memberPermissions?.has?.(permission));
  return decideSetupAccess({
    isOwner: interaction.guild?.ownerId === interaction.user?.id,
    isAdmin: has(PermissionFlagsBits.Administrator),
    isManager: has(PermissionFlagsBits.ManageGuild),
  });
}

// ─── Rendu : message d'arrivée ───────────────────────────────────────────────
// Règle de mise en forme : un titre sans emoji, un filet, trois lignes utiles.
// Les glyphes de marque (▬ ▰ ▱) portent le rythme ; les emojis ne décorent rien.
function buildStartEmbed({ guild, client }) {
  const icon = client?.user?.displayAvatarURL?.({ size: 256 }) || undefined;
  const author = client?.user?.username ? { name: client.user.username, iconURL: icon } : null;
  return ui.panelEmbed({
    author,
    title: `${e('arrow')} Installer REZO`,
    subtitle: 'Première mise en route',
    description: [
      `Sur **${guild.name}**, ce salon est privé : seuls les administrateurs le voient.`,
      '',
      '**1**   Clique sur **Commencer**.',
      '**2**   Le programme ne montre que ce qui manque encore.',
      '**3**   Chaque réglage reste modifiable dans `/setting`.',
      '',
      'Rien n’est activé sans ton clic.',
    ].join('\n'),
    fields: [
      { name: `${e('shield')} Sécurité`, value: 'Anti-raid, captcha, auto-modération', inline: true },
      { name: `${e('party')} Communauté`, value: 'Bienvenue, niveaux, autorôle', inline: true },
      { name: `${e('pin')} Gestion`, value: 'Logs, tickets, signalements', inline: true },
    ],
    footer: 'Installation',
  });
}

function buildStartRow() {
  return new ActionRowBuilder().addComponents(
    setupButton('setup_start', 'Commencer', ButtonStyle.Primary),
    setupButton('setup_help', 'Ce que ça fait', ButtonStyle.Secondary),
  );
}

// ─── Rendu : programme d'installation ────────────────────────────────────────
function missingModules(score) {
  const missing = Array.isArray(score?.missing) ? score.missing : [];
  return missing.filter(module => module && module.key);
}

function buildInstallerEmbed({ guild, score, plan, note = null }) {
  const missing = missingModules(score);
  const categories = score?.categories || [];
  const blocked = Array.isArray(plan?.blocked) ? plan.blocked.length : 0;

  const head = [
    `**${guild.name}**`,
    `${ui.progress(score?.percent ?? 0)} · ${score?.activeCount ?? 0}/${score?.moduleCount ?? 0} modules actifs`,
    '',
    missing.length
      ? `${missing.length} module(s) à installer. Choisis-en un dans le menu : chaque fiche dit ce qu’il apporte, ou quelle commande le règle à la main.`
      : 'Tous les modules sont configurés. Chacun reste modifiable dans `/setting`.',
    '',
    'Installation libre : aucune licence ni essai n’est demandé ici.',
  ];
  if (note) head.unshift(note, '');

  const embed = new EmbedBuilder()
    .setColor(missing.length ? COLORS.primary : COLORS.success)
    .setTitle(`${e('cone')} Programme d’installation`)
    .setDescription(head.join('\n').slice(0, 4000));

  if (missing.length) {
    embed.addFields({
      name: `À installer (${missing.length})`,
      value: missing.slice(0, 8)
        .map(module => `${e('arrow')} **${module.label}** — ${clip(module.hint, 80)}`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  if (categories.length) {
    embed.addFields({
      name: 'Couverture par pilier',
      value: categories
        .slice(0, 6)
        .map(cat => `${cat.label} · ${ui.progress(cat.percent, { length: 8, label: false })} ${cat.percent}%`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  if (blocked) {
    embed.addFields({
      name: `${e('cone')} Salons à créer`,
      value: `${blocked} module(s) attendent un salon absent. **Créer les salons** les prépare.`,
    });
  }

  embed.setFooter({ text: brand.footer('Installation · module par module') });
  return embed;
}

function buildModuleEmbed({ guild, score, key, note = null }) {
  const meta = moduleMeta(key);
  const module = (score?.modules || []).find(item => item.key === key) || null;
  if (!meta) {
    return ui.panelEmbed({
      title: `${e('alert')} Module inconnu`,
      description: `Le module \`${clip(key, 60)}\` n’existe pas dans cette version du bot.`,
      color: COLORS.warning,
      footer: 'Installation',
    });
  }

  const category = CATEGORIES.find(cat => cat.key === meta.category);
  const fields = [
    { name: 'Pilier', value: `${category?.emoji ? `${category.emoji} ` : ''}${category?.label || meta.category}`, inline: true },
    { name: 'État', value: module?.ok ? 'Actif' : 'Inactif', inline: true },
    { name: 'Méthode', value: meta.auto ? 'Installable ici' : 'Réglage manuel', inline: true },
    { name: 'Apport', value: clip(meta.hint, 400) },
  ];
  if (!meta.auto && meta.fix) {
    fields.push({ name: 'Commande dédiée', value: `\`${meta.fix}\`` });
  }

  return ui.panelEmbed({
    title: `${e(module?.ok ? 'check' : 'arrow')} ${meta.label}`,
    subtitle: category?.label || null,
    description: [
      note,
      meta.auto
        ? 'L’installation applique des valeurs sûres, immédiatement réversibles depuis `/setting`.'
        : 'Ce module demande un choix humain (salon, rôle, compte externe) : la commande indiquée ouvre son panneau dédié.',
    ].filter(Boolean).join('\n'),
    fields,
    color: module?.ok ? COLORS.success : COLORS.primary,
    footer: `Installation · ${guild.name}`,
  });
}

function buildInstallerComponents({ score, plan, selected = null }) {
  const rows = [];
  const missing = missingModules(score).slice(0, MAX_SELECT_OPTIONS);

  if (selected) {
    rows.push(new ActionRowBuilder().addComponents(
      setupButton(`setup_install:${clip(selected, 60)}`, 'Installer ce module', ButtonStyle.Success),
      setupButton('setup_back', 'Tous les modules', ButtonStyle.Secondary),
    ));
    return rows;
  }

  if (missing.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('setup_pick')
        .setPlaceholder('Choisir un module…')
        .addOptions(missing.map(module => {
          const optionEmoji = emojiObject(module.auto ? 'arrow' : 'pin');
          return {
            label: clip(module.label, 100),
            value: clip(module.key, 100),
            description: clip(module.auto ? module.hint : `${module.hint} · réglage manuel`, 100),
            ...(optionEmoji ? { emoji: optionEmoji } : {}),
          };
        })),
    ));
  }

  const blocked = Array.isArray(plan?.blocked) ? plan.blocked.length : 0;
  rows.push(new ActionRowBuilder().addComponents(
    setupButton('setup_install_auto', 'Installer l’essentiel', ButtonStyle.Success)
      .setDisabled(!missing.some(module => module.auto)),
    setupButton('setup_channels', 'Créer les salons', ButtonStyle.Primary)
      .setDisabled(blocked === 0),
    setupButton('setup_refresh', 'Actualiser', ButtonStyle.Secondary),
  ));

  return rows;
}

// ─── Chargement de l'état ────────────────────────────────────────────────────
async function loadState(guild, { fresh = false } = {}) {
  const { collectState } = require('./efficiencyState');
  const { computeScore } = require('./efficiencyScore');

  const state = await collectState(guild.id, { fresh });
  const score = computeScore(state);
  const picks = autopilot.pickTextChannels(guild, guild.members?.me);
  const memberRole = autopilot.pickRole(guild, 'member');
  const plan = autopilot.buildPlan(state, { ...picks, memberRole });
  return { state, score, plan };
}

// Le score est mis en cache 30 s : après une installation, on le vide pour
// afficher l'état réel et non l'état d'avant le clic.
function invalidateEfficiency(guildId) {
  try {
    const { invalidateState } = require('./efficiencyState');
    if (typeof invalidateState === 'function') invalidateState(guildId);
  } catch (_) { /* cache indisponible : la relecture fraîche reste correcte */ }
}

function panelPayload({ guild, score, plan, selected = null, note = null }) {
  if (selected) {
    return {
      embeds: [buildModuleEmbed({ guild, score, key: selected, note })],
      components: buildInstallerComponents({ score, plan, selected }),
    };
  }
  return {
    embeds: [buildInstallerEmbed({ guild, score, plan, note })],
    components: buildInstallerComponents({ score, plan }),
  };
}

// ─── Aucune licence ──────────────────────────────────────────────────────────
// Le programme d'installation est volontairement LIBRE : il ne consulte ni
// licence, ni essai, ni service distant. Les systèmes qui demandent une licence
// pour être utilisés gardent leur propre verrou à l'usage — mais préparer un
// serveur ne doit jamais être bloqué par un abonnement.

// ─── Installation ────────────────────────────────────────────────────────────
async function installModule({ plan, key }) {
  const steps = (plan?.steps || []).filter(step => step.moduleKey === key);
  if (steps.length) {
    const result = await autopilot.applyPlan({ steps });
    return { type: 'applied', applied: result.applied, failed: result.failed };
  }

  const blocked = (plan?.blocked || []).find(entry => entry.moduleKey === key);
  if (blocked) return { type: 'blocked', blocked };

  const meta = moduleMeta(key);
  return { type: meta?.auto ? 'nothing' : 'manual', meta };
}

function installNote(result) {
  if (result.type === 'applied') {
    const done = result.applied?.length || 0;
    const failed = result.failed || [];
    return [
      done ? `✅ **${done} réglage(s) appliqué(s).**` : '⚠️ Rien n’a pu être appliqué.',
      failed.length ? `Échecs : ${failed.map(item => `${item.label} (${clip(item.error, 60)})`).join(', ')}` : null,
    ].filter(Boolean).join('\n');
  }
  if (result.type === 'blocked') {
    return `⛔ **Salon manquant** : ${clip(result.blocked.reason || 'aucun salon adapté', 160)}. `
      + 'Utilise **🏗️ Créer les salons**, puis relance l’installation.';
  }
  if (result.type === 'manual') {
    return `🛠️ **Réglage manuel** : ce module attend un choix humain. Lance \`${result.meta?.fix || '/setting'}\`.`;
  }
  return 'ℹ️ Aucun réglage à appliquer : ce module est déjà en place.';
}

// ─── Salon d'administration ──────────────────────────────────────────────────
function findExistingChannel(guild) {
  const cache = guild.channels?.cache;
  if (!cache?.values) return null;
  for (const channel of cache.values()) {
    if (channel?.name === CHANNEL_NAME && channel.type === ChannelType.GuildText) return channel;
  }
  return null;
}

function adminOverwrites(guild) {
  const overwrites = [];
  const everyone = guild.roles?.everyone?.id;
  if (everyone) overwrites.push({ id: everyone, deny: [PermissionFlagsBits.ViewChannel] });

  if (guild.ownerId) {
    overwrites.push({
      id: guild.ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  const me = guild.members?.me;
  if (me?.id) {
    overwrites.push({
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    });
  }

  const roles = guild.roles?.cache?.values ? [...guild.roles.cache.values()] : [];
  for (const role of roles) {
    if (overwrites.length >= MAX_OVERWRITES) break;
    if (!role || role.id === everyone) continue;
    if (!role.permissions?.has?.(PermissionFlagsBits.Administrator)) continue;
    overwrites.push({
      id: role.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  return overwrites;
}

async function ensureAdminChannel(guild, client) {
  // 1. Le salon mémorisé existe encore ?
  const stored = await SetupHub.findOne({ guildId: guild.id }).catch(() => null);
  if (stored?.channelId) {
    const existing = guild.channels?.cache?.get?.(stored.channelId)
      || await guild.channels?.fetch?.(stored.channelId).catch(() => null);
    if (existing) return { channel: existing, created: false };
  }

  // 2. Un salon du même nom traîne déjà (réinvitation, redémarrage) ?
  const sameName = findExistingChannel(guild);
  if (sameName) return { channel: sameName, created: false };

  // 3. Création du salon privé.
  try {
    const channel = await guild.channels.create({
      name: CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'Configuration REZO — salon privé, réservé aux administrateurs.',
      permissionOverwrites: adminOverwrites(guild),
      reason: `REZO — salon d’administration créé à l’arrivée sur ${guild.name}`,
    });
    return { channel, created: true };
  } catch (err) {
    console.error(`[setupHub] création du salon (${guild.name}) :`, err.message);
    return { channel: null, created: false, error: err.message };
  }
}

async function postStartMessage(channel, guild, client) {
  try {
    return await channel.send({
      embeds: [buildStartEmbed({ guild, client })],
      components: [buildStartRow()],
    });
  } catch (err) {
    console.error(`[setupHub] envoi du message d’installation (${guild.name}) :`, err.message);
    return null;
  }
}

/**
 * Point d'entrée appelé par l'événement guildCreate.
 * Ne lève jamais : une arrivée ne doit pas échouer à cause de ce salon.
 */
async function onGuildJoin(guild, client) {
  const { channel, created, error } = await ensureAdminChannel(guild, client);
  if (!channel) return { ok: false, error: error || 'salon indisponible' };

  const message = await postStartMessage(channel, guild, client);

  await SetupHub.findOneAndUpdate(
    { guildId: guild.id },
    {
      $set: {
        channelId: channel.id,
        messageId: message?.id || null,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  ).catch(() => {});

  console.log(`🧩 [setupHub] ${guild.name} : salon ${created ? 'créé' : 'réutilisé'} #${channel.name}`);
  return { ok: Boolean(message), channelId: channel.id, messageId: message?.id || null, created };
}

// ─── Interactions ────────────────────────────────────────────────────────────
async function handleSetupInteraction(interaction, client) {
  if (!interaction.inGuild?.()) {
    return interaction.reply({ content: '⛔ Ce panneau ne fonctionne que dans un serveur.', ephemeral: true }).catch(() => {});
  }

  const access = memberAccess(interaction);
  if (!access.allowed) {
    return interaction.reply({
      content: '⛔ Le programme d’installation est réservé aux administrateurs du serveur.',
      ephemeral: true,
    }).catch(() => {});
  }

  const guild = interaction.guild;
  const id = interaction.customId;

  try {
    // ── Ouverture depuis le message d'arrivée ─────────────────────────────
    if (id === 'setup_start') {
      await interaction.deferReply({ ephemeral: true });
      const { score, plan } = await loadState(guild, { fresh: true });
      await SetupHub.updateOne(
        { guildId: guild.id },
        { $inc: { opens: 1 }, $set: { lastOpenAt: new Date() } },
      ).catch(() => {});
      return interaction.editReply(panelPayload({ guild, score, plan }));
    }

    // ── Explication du bouton secondaire ──────────────────────────────────
    if (id === 'setup_help') {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.info)
          .setTitle('🧩 À quoi sert le programme d’installation ?')
          .setDescription([
            'Il compare l’état **réel** du serveur aux modules que REZO sait faire tourner, puis propose ceux qui manquent.',
            '',
            '• **⚙️ Installer ce module** applique des valeurs sûres, tout de suite réversibles.',
            '• **⚡ Installer l’essentiel** active d’un coup tous les modules installables sans choix humain.',
            '• **🏗️ Créer les salons** prépare les salons qui débloquent les modules restants.',
            '• Les modules qui demandent un choix (salon, rôle, compte externe) renvoient vers leur commande dédiée.',
            '',
            'Rien n’est activé sans clic, et tout se règle ensuite dans `/setting`.',
          ].join('\n'))
          .setFooter({ text: brand.footer('Installation') })],
        ephemeral: true,
      }).catch(() => {});
    }

    // ── Navigation ────────────────────────────────────────────────────────
    if (id === 'setup_refresh' || id === 'setup_back') {
      await interaction.deferUpdate();
      const { score, plan } = await loadState(guild, { fresh: id === 'setup_refresh' });
      return interaction.editReply(panelPayload({ guild, score, plan }));
    }

    if (id === 'setup_pick') {
      await interaction.deferUpdate();
      const { score, plan } = await loadState(guild);
      return interaction.editReply(panelPayload({ guild, score, plan, selected: interaction.values[0] }));
    }

    // ── Installation d'un module ──────────────────────────────────────────
    if (id.startsWith('setup_install:')) {
      const key = id.slice('setup_install:'.length);

      await interaction.deferUpdate();
      const before = await loadState(guild, { fresh: true });
      const result = await installModule({ plan: before.plan, key });

      invalidateEfficiency(guild.id);
      const after = await loadState(guild, { fresh: true });
      const note = installNote(result);

      if (result.type === 'applied') {
        await SetupHub.updateOne(
          { guildId: guild.id },
          {
            $inc: { installs: result.applied?.length || 1 },
            $set: { lastInstallAt: new Date() },
          },
        ).catch(() => {});
      }

      return interaction.editReply(panelPayload({ guild, score: after.score, plan: after.plan, selected: key, note }));
    }

    // ── Installation groupée ──────────────────────────────────────────────
    if (id === 'setup_install_auto') {
      await interaction.deferUpdate();
      const before = await loadState(guild, { fresh: true });
      const result = await autopilot.applyPlan(before.plan);

      invalidateEfficiency(guild.id);
      const after = await loadState(guild, { fresh: true });
      const lines = [
        result.applied.length
          ? `✅ **${result.applied.length} module(s) installé(s)** : ${result.applied.map(item => item.label).join(', ')}`
          : '⚠️ Aucun module n’a pu être installé automatiquement.',
        result.failed.length ? `Échecs : ${result.failed.map(item => `${item.label} (${clip(item.error, 50)})`).join(', ')}` : null,
        result.blocked.length ? `${result.blocked.length} module(s) attendent encore un salon.` : null,
      ].filter(Boolean);

      if (result.applied.length) {
        await SetupHub.updateOne(
          { guildId: guild.id },
          { $inc: { installs: result.applied.length }, $set: { lastInstallAt: new Date() } },
        ).catch(() => {});
      }

      return interaction.editReply(panelPayload({
        guild,
        score: after.score,
        plan: after.plan,
        note: clip(lines.join('\n'), 900),
      }));
    }

    // ── Création des salons manquants ─────────────────────────────────────
    if (id === 'setup_channels') {
      await interaction.deferUpdate();
      const before = await loadState(guild, { fresh: true });
      const missing = autopilot.missingChannels(before.plan);
      const { created, failed } = missing.length
        ? await autopilot.createMissingChannels(guild, missing)
        : { created: [], failed: [] };

      invalidateEfficiency(guild.id);
      const after = await loadState(guild, { fresh: true });
      const lines = [
        created.length
          ? `🏗️ **${created.length} salon(s) prêt(s)** : ${created.map(item => `#${item.name}`).join(', ')}`
          : 'ℹ️ Aucun salon à créer.',
        failed.length ? `Échecs : ${failed.map(item => `#${item.name} (${clip(item.error, 40)})`).join(', ')}` : null,
        created.length ? 'Les modules débloqués sont maintenant installables ci-dessous.' : null,
      ].filter(Boolean);

      return interaction.editReply(panelPayload({
        guild,
        score: after.score,
        plan: after.plan,
        note: clip(lines.join('\n'), 900),
      }));
    }
  } catch (err) {
    console.error('[setupHub] interaction :', err);
    const payload = {
      content: '⚠️ Action impossible pour le moment (permission manquante ou base indisponible).',
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
    return interaction.reply(payload).catch(() => {});
  }
}

module.exports = {
  CHANNEL_NAME,
  MAX_SELECT_OPTIONS,
  onGuildJoin,
  handleSetupInteraction,
  ensureAdminChannel,
  adminOverwrites,
  loadState,
  installModule,
  installNote,
  decideSetupAccess,
  memberAccess,
  buildStartEmbed,
  buildStartRow,
  buildInstallerEmbed,
  buildModuleEmbed,
  buildInstallerComponents,
  panelPayload,
  moduleMeta,
};
