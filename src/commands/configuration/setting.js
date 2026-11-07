'use strict';
// commands/configuration/setting.js — ⚙️ `/setting`, le panel de configuration.
//
// Un seul point d'entrée pour TOUT le bot :
//   • neuf domaines, l'état réel de chacun et les valeurs déjà configurées ;
//   • un **champ par module** dans chaque domaine, disant exactement comment
//     l'ouvrir (réglage sur place, panneau dédié ou commande à lancer) ;
//   • 🎛️ une **console de toutes les commandes** : le bot entier, page par page,
//     chacune lançable depuis le menu — on configure donc en exécutant ;
//   • 🩺 un diagnostic qui dit précisément quoi corriger.
//
// Chaque module ouvert ici garde ses propres gardes : permissions Discord et
// licence restent vérifiées, exactement comme si la commande était tapée.
//
// Le routage des composants vit dans un collecteur (comme en v2) : le message
// est éphémère et lié à son auteur, un collecteur de 15 minutes suffit et évite
// de laisser traîner un panel public modifiable.
//
// Les identifiants internes des composants restent préfixés `panel_` : ils sont
// partagés avec le Centre de protection (utils/protectionHub.js) et référencés
// comme composants du collecteur dans events/core/interactionCreate.js. Les
// renommer casserait la navigation existante sans rien apporter à l'utilisateur.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const Server = require('../../models/Server');
const licenseGate = require('../../utils/licenseGate');
const hub = require('../../utils/protectionHub');
const panelV3 = require('../../utils/panelV3');
const panelConfig = require('../../utils/panelConfig');
const configFlow = require('../../utils/panelConfigFlow');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// Anciens noms de modules (panel v2) → valeur v3.
const MODULE_ALIASES = { warnconfig: 'warn' };

// ─── Contexte ───────────────────────────────────────────────────────────────

async function loadLicense(guildId) {
  return panelV3.withTimeout(
    licenseGate.getLicenseStatus(guildId).catch(() => null),
    1200,
    null,
  );
}

async function loadProtection(guild) {
  try {
    const configs = await hub.collectProtectionConfig(guild.id);
    return hub.buildState(configs, guild);
  } catch (err) {
    console.error('panel → centre de protection:', err.message);
    return hub.buildState({}, guild);
  }
}

/** Tout ce qu'il faut pour rendre n'importe quel écran du panel. */
async function loadContext(guild) {
  const [protection, configs, license] = await Promise.all([
    loadProtection(guild),
    panelV3.fetchConfigs(guild.id),
    loadLicense(guild.id),
  ]);
  const status = panelV3.buildStatus(configs, { protection, guild });
  const report = panelV3.runDiagnostics({ guild, configs, status, protection, license });
  return { protection, configs, license, status, report };
}

function homePayload(ctx, guild) {
  return {
    embeds: [panelV3.buildHomeEmbed(ctx.status, {
      guild, protection: ctx.protection, license: ctx.license, diagnostic: ctx.report,
      editable: editableModuleCount(),
    })],
    components: panelV3.homeComponents(),
  };
}

/** Nombre de modules distincts réglables sans quitter le panel. */
function editableModuleCount() {
  const values = new Set();
  for (const section of panelV3.SECTIONS) {
    for (const module of section.modules) {
      if (isInlineEditable(module.value)) values.add(module.value);
    }
  }
  return values.size;
}

function sectionPayload(sectionId, ctx, guild) {
  return {
    embeds: [panelV3.buildSectionEmbed(sectionId, ctx.status, { guild, editable: isInlineEditable })],
    components: panelV3.sectionComponents(sectionId),
  };
}

/** Options communes des vues de la console (état réel + verrous de licence). */
function consoleOptions(ctx, { category = panelV3.ALL_CATEGORY, page = 0 } = {}) {
  return {
    status: ctx?.status || null,
    isLocked: name => licenseGate.isLicenseRequired(name),
    category,
    page,
  };
}

function consolePayload(client, ctx, opts = {}) {
  const options = consoleOptions(ctx, opts);
  return {
    embeds: [panelV3.buildConsoleEmbed(client, options)],
    components: panelV3.consoleComponents(client, options),
  };
}

function diagnosticPayload(ctx, guild) {
  return {
    embeds: [panelV3.buildDiagnosticEmbed(ctx.report, { guild })],
    components: panelV3.diagnosticComponents(ctx.report),
  };
}

function backRow({ diagnostic = true } = {}) {
  const buttons = [
    new ButtonBuilder().setCustomId('panel_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  ];
  if (diagnostic) {
    buttons.push(new ButtonBuilder().setCustomId('panel_diag').setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Success));
  }
  return new ActionRowBuilder().addComponents(...buttons);
}

// ─── Centre de protection (inchangé, relooké) ───────────────────────────────

async function showProtection(interaction) {
  const state = await loadProtection(interaction.guild);
  const payload = { embeds: [hub.buildEmbed(state, interaction.guild)], components: hub.buildComponents(state) };

  if (interaction.replied || interaction.deferred) return interaction.editReply(payload).catch(() => {});
  if (interaction.isButton?.() || interaction.isAnySelectMenu?.() || interaction.isStringSelectMenu?.()) {
    return interaction.update(payload);
  }
  return interaction.editReply(payload);
}

function showGuide(interaction, client, module, note = null) {
  const command = commandOfModule(client, module);
  const plan = command ? panelV3.planForCommand(jsonOf(command)) : null;

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📌 ${module.label}`)
    .setDescription([
      note ? `${note}\n` : null,
      plan?.mode === 'run'
        ? 'Ce module garde sa propre commande — tu peux la lancer directement d’ici.'
        : 'Ce module se configure en plusieurs étapes : sa commande reste la voie la plus complète.',
      '',
      plan ? `📖 \`${plan.usage}\`` : (module.guide || '`/help` — retrouver la commande correspondante'),
    ].filter(line => line !== null).join('\n'));

  const buttons = [];
  if (plan?.mode === 'run') {
    buttons.push(new ButtonBuilder()
      .setCustomId(`panel_exec:${module.value}`)
      .setLabel('Exécuter la commande').setEmoji('▶️')
      .setStyle(ButtonStyle.Success));
  }
  buttons.push(new ButtonBuilder().setCustomId('panel_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Secondary));

  return interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(...buttons)] });
}

// Une commande protégée par `default_member_permissions` reste protégée ici.
function permissionDenied(interaction, cmd) {
  const raw = cmd?.data?.default_member_permissions;
  if (!raw) return null;
  let bit;
  try { bit = BigInt(raw); } catch { return null; }
  if (interaction.memberPermissions?.has?.(bit)) return null;
  return errorEmbed(
    'Permission manquante',
    'Cette section demande une permission Discord que tu n\'as pas. Elle reste accessible à un membre du staff qui la possède via sa commande dédiée.',
  );
}

// ─── Exécution d'une commande depuis le panel ───────────────────────────────
//
// « Configurer en exécutant » : plutôt que de réimplémenter les réglages, le
// panel lance la vraie commande avec une interaction qui imite un lancement
// slash (sous-commande de configuration choisie, aucun autre argument). Le
// module garde ainsi ses gardes, sa licence, ses permissions et son panneau.
// Une commande qui réclame des arguments n'est jamais lancée au hasard : on
// affiche son usage exact et ses sous-commandes.

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function jsonOf(command) {
  return typeof command?.data?.toJSON === 'function' ? command.data.toJSON() : (command?.data || {});
}

/** La commande qui ouvre (ou configure) un module du panel. */
function commandOfModule(client, module) {
  if (!module) return null;
  return client?.commands?.get?.(module.command || module.value) || null;
}

async function replyEphemeral(interaction, embed) {
  const payload = { embeds: [embed], ephemeral: true };
  try {
    if (interaction.deferred && !interaction.replied) return await interaction.editReply(payload);
    if (interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch {
    return null;
  }
}

/** Mode d'emploi d'une commande qui ne peut pas démarrer sans arguments. */
function usageEmbed(name, cmd, { note = null } = {}) {
  const json = jsonOf(cmd);
  const plan = panelV3.planForCommand(json);
  const subcommands = panelV3.subcommandCandidates(json.options || []);

  const lines = [
    note ? `${note}\n` : null,
    plan.reason === 'arguments'
      ? `Cette commande réclame des arguments : **${(plan.required || []).join('**, **')}**.`
      : 'Cette commande se pilote par sous-commande : voici les chemins exacts.',
    '',
    `📖 \`${plan.usage}\``,
  ].filter(line => line !== null);

  if (subcommands.length) {
    lines.push('', '**Sous-commandes**');
    for (const candidate of subcommands.slice(0, 12)) {
      const label = `${candidate.group ? `${candidate.group} ` : ''}${candidate.sub.name}`;
      lines.push(`• \`/${name} ${label}\` — ${clip(candidate.sub.description || 'sans description', 70)}`);
    }
  }

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`📖 /${name}`)
    .setDescription(clip(lines.join('\n'), 4000));
}

async function showUsage(interaction, client, name, { note = null } = {}) {
  const cmd = client?.commands?.get?.(name);
  if (!cmd) {
    return replyEphemeral(interaction, errorEmbed('Commande introuvable', `\`/${name}\` n’est plus chargée. Rouvre \`/setting\` pour actualiser.`));
  }
  const payload = {
    embeds: [usageEmbed(name, cmd, { note })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
    )],
  };
  if (interaction.replied || interaction.deferred) return replyEphemeral(interaction, payload.embeds[0]);
  return interaction.update(payload).catch(() => replyEphemeral(interaction, payload.embeds[0]));
}

/**
 * Lance une commande du bot depuis le panel, avec les mêmes gardes que la
 * commande tapée à la main : licence, puis permissions Discord du module.
 */
async function runCommand(interaction, client, name) {
  const cmd = client?.commands?.get?.(name);
  if (!cmd?.execute) {
    return replyEphemeral(interaction, errorEmbed('Commande introuvable', `\`/${name}\` n’est plus chargée. Rouvre \`/setting\` pour actualiser.`));
  }

  if (interaction.guild && licenseGate.isLicenseRequired(name)) {
    const access = await licenseGate.checkAccessBounded(interaction.guild.id, name);
    if (!access) return replyEphemeral(interaction, licenseGate.unavailableEmbed(name));
    const fullOnly = licenseGate.requiresFullLicense(name);
    if (!access.ok || (fullOnly && access.reason === 'trial')) {
      return replyEphemeral(interaction, fullOnly && access.reason === 'trial'
        ? licenseGate.fullLicenseEmbed(name)
        : licenseGate.lockEmbed(name, { access }));
    }
  }

  const denied = permissionDenied(interaction, cmd);
  if (denied) return replyEphemeral(interaction, denied);

  const plan = panelV3.planForCommand(jsonOf(cmd));
  if (plan.mode !== 'run') return showUsage(interaction, client, name);

  try {
    await cmd.execute(panelV3.executionInteraction(interaction, plan), client);
  } catch (err) {
    console.error(`setting → exécution de /${name} :`, err.message);
    await showUsage(interaction, client, name, {
      note: 'La commande n’a pas pu démarrer seule — voici son mode d’emploi.',
    });
  }
}

// ─── Ouverture d'un module (licence + permissions respectées) ───────────────
//
// Deux chemins : l'édition en direct quand le module a une configuration
// unique (panelConfig), et le relais vers le panneau dédié de la commande
// (`relay: true`) pour tout le reste.
async function openModule(interaction, client, rawValue, sectionId = null, opts = {}) {
  const value = MODULE_ALIASES[rawValue] || rawValue;

  if (value === 'protection') return showProtection(interaction);
  if (value === 'anti-vpn') return require('../../utils/antiVpnPanel').open(interaction);

  const module = panelV3.moduleByValue(value, sectionId) || panelV3.moduleByValue(value);
  if (!module) {
    return interaction.update({
      embeds: [errorEmbed('Module introuvable', 'Ce module n\'existe plus dans le panel. Rouvre `/setting` pour actualiser.')],
      components: [backRow()],
    });
  }

  const target = module.direct ? (module.command || module.value) : null;
  const gateTarget = target || value;

  if (interaction.guild && licenseGate.isLicenseRequired(gateTarget)) {
    const access = await licenseGate.checkAccessBounded(interaction.guild.id, gateTarget);
    if (!access) return interaction.reply({ embeds: [licenseGate.unavailableEmbed(gateTarget)], ephemeral: true });
    const fullOnly = licenseGate.requiresFullLicense(gateTarget);
    if (!access.ok || (fullOnly && access.reason === 'trial')) {
      const embed = fullOnly && access.reason === 'trial'
        ? licenseGate.fullLicenseEmbed(gateTarget)
        : licenseGate.lockEmbed(gateTarget, { access });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  const cmd = target ? client.commands.get(target) : null;

  const denied = cmd ? permissionDenied(interaction, cmd) : null;
  if (denied) return interaction.reply({ embeds: [denied], ephemeral: true });

  // Édition sur place uniquement si le module expose vraiment des réglages ;
  // sinon on garde le panneau dédié (ou le guide) pour ne jamais afficher
  // un écran vide.
  if (!opts.relay && isInlineEditable(value)) {
    return configFlow.open(interaction, value, {
      hasPanel: hasDedicatedPanel(client, value),
      note: opts.note || null,
      page: opts.page || 0,
    });
  }

  if (!target) return showGuide(interaction, client, module);
  if (!cmd?.execute) return showGuide(interaction, client, module, 'Cette section est momentanément indisponible.');

  try {
    await cmd.execute(interaction, client);
  } catch (err) {
    console.error(`panel → ${target}:`, err.message);
    await interaction.reply({ content: '❌ Une erreur est survenue en ouvrant cette section.', ephemeral: true }).catch(() => {});
  }
}

/** Vrai quand le module a des réglages éditables dans le panel. */
function isInlineEditable(value) {
  if (!panelConfig.isEditable(value)) return false;
  return (panelConfig.describe(value)?.fields?.length || 0) > 0;
}

/** Vrai quand le module possède un panneau dédié ouvrable depuis le panel. */
function hasDedicatedPanel(client, value) {
  const module = panelV3.moduleByValue(MODULE_ALIASES[value] || value);
  if (!module?.direct) return false;
  const target = module.command || module.value;
  return Boolean(client.commands.get(target)?.execute);
}

// ─── Actions d'urgence ──────────────────────────────────────────────────────

async function emergencyEndRaid(interaction, client) {
  const { getConfig, endRaid } = require('../../utils/antiraidActions');
  const cfg = await getConfig(interaction.guild.id);
  const actions = await endRaid(client, interaction.guild, cfg).catch(err => {
    console.error('panel → fin de raid:', err.message);
    return null;
  });
  await interaction.reply({
    embeds: [actions
      ? successEmbed('Fin de raid', actions.length ? actions.map(a => `• ${a}`).join('\n') : 'Aucune action n\'était nécessaire.')
      : errorEmbed('Fin de raid impossible', 'Le serveur n\'a pas pu être mis à jour — réessaie depuis `/antiraid`.')],
    ephemeral: true,
  });
  return refreshProtectionMessage(interaction);
}

async function emergencyUnlock(interaction, client) {
  const { AntiRaid } = require('../../models/AntiRaid');
  const { lockAll } = require('../../utils/antiraidActions');
  const { getConfig: getNukeConfig, setPanic } = require('../../utils/antinukeActions');

  const done = [];
  const raid = await AntiRaid.findOne({ guildId: interaction.guild.id }).catch(() => null);
  if (raid?.lockdownActive) {
    const unlocked = await lockAll(interaction.guild, false).catch(() => 0);
    // On lève uniquement le verrouillage : l'état « raid en cours » reste posé,
    // c'est « Fin de raid » qui le clôt.
    raid.lockdownActive = false;
    await raid.save().catch(() => {});
    done.push(`serveur déverrouillé (${unlocked} salon(s))`);
  }
  const nuke = await getNukeConfig(interaction.guild.id).catch(() => null);
  if (nuke?.panicActive) {
    const unlocked = await setPanic(interaction.guild, nuke, false, { userId: interaction.user.id }).catch(() => 0);
    done.push(`mode panique levé (${unlocked} salon(s))`);
  }

  await interaction.reply({
    embeds: [done.length
      ? successEmbed('Serveur déverrouillé', done.map(d => `• ${d}`).join('\n'))
      : errorEmbed('Rien à déverrouiller', 'Aucun verrouillage ni mode panique n\'est actif.')],
    ephemeral: true,
  });
  return refreshProtectionMessage(interaction);
}

async function refreshProtectionMessage(interaction) {
  const state = await loadProtection(interaction.guild);
  const payload = { embeds: [hub.buildEmbed(state, interaction.guild)], components: hub.buildComponents(state) };
  await interaction.message?.edit(payload).catch(() => {});
  return state;
}

// ─── Commande ───────────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()      .setName('setting')
      .setDescription('⚙️ Panel de configuration — tout le bot réglable et lançable ici même')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: true });

    await Server.findOneAndUpdate(
      { guildId: interaction.guild.id },
      { $setOnInsert: { guildId: interaction.guild.id, guildName: interaction.guild.name } },
      { upsert: true, new: true },
    ).catch(() => null);

    const context = await loadContext(interaction.guild);
    const reply = await interaction.editReply({ ...homePayload(context, interaction.guild), fetchReply: true });

    const goHome = async (i) => {
      const ctx = await loadContext(interaction.guild);
      return i.update(homePayload(ctx, interaction.guild));
    };

    const openSection = async (i, sectionId) => {
      const section = panelV3.sectionById(sectionId);
      if (!section) return goHome(i);
      const ctx = await loadContext(interaction.guild);
      return i.update(sectionPayload(section.id, ctx, interaction.guild));
    };

    const openDiagnostic = async (i) => {
      const ctx = await loadContext(interaction.guild);
      return i.update(diagnosticPayload(ctx, interaction.guild));
    };

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 15 * 60 * 1000,
    });

    col.on('collect', async (i) => {
      try {
        const id = i.customId;

        // ── Édition en direct d'un module (panelConfigFlow) ──────────────
        if (configFlow.isConfigComponent(id)) {
          return configFlow.handle(i, {
            relay: (interaction2, target) => openModule(interaction2, client, target, null, { relay: true }),
            hasPanel: target => hasDedicatedPanel(client, target),
          });
        }

        // ── 🎛️ Console : toutes les commandes du bot ────────────────────
        if (id === 'panel_console') {
          return i.update(consolePayload(client, await loadContext(interaction.guild)));
        }

        if (id === 'panel_console_cat') {
          const ctx = await loadContext(interaction.guild);
          return i.update(consolePayload(client, ctx, { category: i.values[0] }));
        }

        if (id.startsWith('panel_console_page:')) {
          const [, category, page] = id.split(':');
          const ctx = await loadContext(interaction.guild);
          return i.update(consolePayload(client, ctx, { category, page: Number(page) || 0 }));
        }

        // Lancer une commande choisie dans la console.
        if (id.startsWith('panel_console_run:')) return runCommand(i, client, i.values[0]);

        // ▶️ depuis le mode d'emploi d'un module.
        if (id.startsWith('panel_exec:')) {
          const value = id.slice('panel_exec:'.length);
          const module = panelV3.moduleByValue(MODULE_ALIASES[value] || value);
          return runCommand(i, client, module?.command || module?.value || value);
        }

        // ── Navigation principale ────────────────────────────────────────
        if (id === 'panel_home' || id === 'panel_refresh') return goHome(i);
        if (id === 'panel_diag' || id === 'panel_diag_refresh') return openDiagnostic(i);

        // ── Centre de protection ─────────────────────────────────────────
        if (id === 'panel_protection') return showProtection(i);

        if (id === 'panel_protection_refresh') {
          const fresh = await loadProtection(interaction.guild);
          return i.update({ embeds: [hub.buildEmbed(fresh, interaction.guild)], components: hub.buildComponents(fresh) });
        }

        if (id === 'panel_protection_audit') {
          const cmd = client.commands.get('audit-securite');
          if (cmd?.execute) {
            try { return await cmd.execute(i, client); }
            catch (err) { console.error('panel → audit-securite:', err.message); }
          }
          return i.reply({ embeds: [errorEmbed('Audit indisponible', 'Lance `/audit-securite`.')], ephemeral: true });
        }

        if (id === 'panel_protection_unlock' || id === 'panel_protection_endraid') {
          if (!i.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
            return i.reply({ embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur** pour une action d\'urgence.')], ephemeral: true });
          }
          return id === 'panel_protection_unlock' ? emergencyUnlock(i, client) : emergencyEndRaid(i, client);
        }

        if (id === 'panel_protection_system') {
          const key = i.values[0];
          if (!hub.systemByKey(key)) return showProtection(i);
          return openModule(i, client, moduleValueForSystem(key));
        }

        // ── Domaines et modules ─────────────────────────────────────────
        if (id === 'panel_category') return openSection(i, i.values[0]);

        if (id.startsWith('panel_module:')) {
          const sectionId = id.slice('panel_module:'.length);
          return openModule(i, client, i.values[0], sectionId);
        }

        if (id === 'panel_diag_issue') return openModule(i, client, i.values[0]);
      } catch (err) {
        console.error('panel collector:', err.message);
      }
    });

    col.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
  },

  __testables: {
    loadContext,
    loadProtection,
    openModule,
    showProtection,
    showGuide,
    showUsage,
    usageEmbed,
    runCommand,
    consolePayload,
    consoleOptions,
    commandOfModule,
    jsonOf,
    permissionDenied,
    homePayload,
    sectionPayload,
    diagnosticPayload,
    moduleValueForSystem,
    loadLicense,
    hasDedicatedPanel,
    isInlineEditable,
    editableModuleCount,
  },
};

// Correspondance protection → module du panel (/setting).
function moduleValueForSystem(key) {
  const map = {
    captcha: 'captcha',
    joinguard: 'controle-arrivee',
    antiraid: 'antiraid',
    honeypot: 'honeypot',
    automod: 'securite',
    antiscam: 'antiscam',
    antinuke: 'anti-nuke',
    botwatch: 'botwatch',
  };
  return map[key] || key;
}
