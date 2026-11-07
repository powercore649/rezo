'use strict';
// commands/securite/anti-nuke.js — Sentinel : panneau de la protection anti-nuke.
//
// Protège le serveur contre la destruction massive : suppression de salons et de
// rôles, bans/kicks en rafale, création de webhooks et ajout de bots, escalade de
// permissions. La détection vient du journal d'audit (qui a fait quoi), la
// décision du moteur pur (utils/antinukeEngine.js) et l'action d'utils/antinukeActions.js.
//
// Panneau unique, sans collecteur : les composants `an_*` sont routés de façon
// persistante par events/interactionCreate.js (le panneau reste donc utilisable
// au-delà des 10 minutes d'un collecteur classique).

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const {
  getConfig, applyLevel, setPanic, tracker, ensureQuarantineRole,
} = require('../../utils/antinukeActions');
const {
  LEVELS, THRESHOLD_KEYS, ACTIONS, effectiveThresholds, describeAction,
  formatIncident,
} = require('../../utils/antinukeEngine');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

const LEVEL_LABELS = {
  surveillance: '👁️ Surveillance — tolérant, journalise beaucoup',
  normal:       '⚖️ Normal — équilibré (recommandé)',
  strict:       '🔴 Strict — réagit au moindre écart',
};

const PUNISHMENT_LABELS = {
  none:        '📝 Journaliser seulement (aucune sanction)',
  removeRoles: '🎭 Retirer tous les rôles de l\'auteur',
  quarantine:  '🔒 Mettre l\'auteur en quarantaine',
  ban:         '🔨 Bannir l\'auteur',
};

const BOT_PERMISSIONS = [
  ['ViewAuditLog', 'Voir le journal d\'audit'],
  ['ManageRoles', 'Gérer les rôles'],
  ['ManageChannels', 'Gérer les salons'],
  ['BanMembers', 'Bannir des membres'],
  ['KickMembers', 'Expulser des membres'],
];

const THRESHOLD_LABELS = {
  channelDelete: 'Salons supprimés',
  roleDelete:    'Rôles supprimés',
  ban:           'Bans',
  kick:          'Kicks',
  webhookCreate: 'Webhooks créés',
};

function parseBool(raw, fallback = false) {
  const v = String(raw || '').toLowerCase().trim();
  if (['oui', 'yes', '1', 'true', 'on', 'activé', 'active'].includes(v)) return true;
  if (['non', 'no', '0', 'false', 'off', 'désactivé', 'desactive'].includes(v)) return false;
  return fallback;
}

function missingPermissions(guild) {
  const me = guild.members.me;
  if (!me) return BOT_PERMISSIONS.map(([name]) => name);
  return BOT_PERMISSIONS.filter(([name]) => !me.permissions.has(PermissionFlagsBits[name])).map(([name]) => name);
}

function restoreLabel(config) {
  const { channels, roles } = config.restore || {};
  if (channels && roles) return '♻️ Salons + rôles';
  if (channels) return '♻️ Salons seuls';
  if (roles) return '♻️ Rôles seuls';
  return '♻️ Réparation OFF';
}

function plainIncidents(config) {
  return (config.incidents || []).map(i => (typeof i.toObject === 'function' ? i.toObject() : i));
}

// ─── Panneau ─────────────────────────────────────────────────────────────────
async function buildPanel(config, guild) {
  const { windowSec, thresholds, custom } = effectiveThresholds(config);
  const missing = missingPermissions(guild);
  const incidents = plainIncidents(config);

  const seuils = THRESHOLD_KEYS
    .map(key => `${ACTIONS[key].emoji} ${ACTIONS[key].label} : **${thresholds[key]}**`)
    .join(' · ');

  const embed = new EmbedBuilder()
    .setColor(!config.enabled ? COLORS.primary : (config.panicActive ? COLORS.error : COLORS.success))
    .setTitle(`🛡️ Sentinel — protection anti-nuke de ${guild.name}`)
    .setDescription(
      '> Sentinel surveille le **journal d\'audit** : suppressions de salons/rôles, bans et kicks en rafale, ' +
      'webhooks et bots ajoutés, permissions dangereuses accordées. Au-delà du seuil, l\'auteur est sanctionné ' +
      'et ce qui vient d\'être détruit est **reconstruit automatiquement**.\n' +
      (custom ? '> 📌 Les seuils de ce serveur ont été **personnalisés** (ils ne suivent plus le niveau choisi).' : ''),
    )
    .addFields(
      { name: '📢 Protection',  value: config.enabled ? '🟢 Activée' : '🔴 Désactivée', inline: true },
      { name: '🎚️ Niveau',      value: `${config.level} · fenêtre ${windowSec}s`, inline: true },
      { name: '⚖️ Sanction',    value: `\`${config.punishment}\``, inline: true },
      { name: '📋 Logs',        value: config.logChannelId ? `<#${config.logChannelId}>` : '*Salon automatique*', inline: true },
      { name: '♻️ Réparation',  value: restoreLabel(config), inline: true },
      { name: '🚨 Confinement', value: config.lockdownOnNuke ? `🟢 Verrouille tout (levée auto : ${config.panicAutoMin} min)` : '🔴 Désactivé', inline: true },
      { name: '🎯 Seuils', value: seuils, inline: false },
      { name: '🗂️ Historique', value: `${config.stats?.prevented || 0} attaque(s) bloquée(s) · ${incidents.length} incident(s) enregistré(s)${config.stats?.lastIncidentAt ? `\nDernier : <t:${Math.floor(new Date(config.stats.lastIncidentAt).getTime() / 1000)}:R>` : ''}`, inline: false },
      { name: '📛 Confiance', value: `${(config.whitelistRoles || []).map(r => `<@&${r}>`).join(', ') || '*aucun rôle*'} · ${(config.whitelistUsers || []).length} utilisateur(s) — jamais surveillés`, inline: false },
      { name: '✅ Prérequis bot', value: missing.length ? `⚠️ Il manque : ${missing.join(', ')}` : 'Toutes les permissions nécessaires sont accordées', inline: false },
    )
    .setFooter({ text: 'REZO • Sentinel — la sanction s\'applique à l\'auteur de l\'action, jamais à ses victimes' })
    .setTimestamp();

  // ⚠️ Un select menu occupe toute la largeur d'une rangée : jamais de bouton
  // dans la même rangée (erreur Discord 50035 WIDTH_EXCEEDED).
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('an_toggle').setLabel(config.enabled ? '🔴 Désactiver' : '🟢 Activer').setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('an_status').setLabel('Statut').setEmoji('📊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('an_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('an_panic').setLabel(config.panicActive ? 'Déverrouiller' : 'Mode panique').setEmoji('🚨').setStyle(config.panicActive ? ButtonStyle.Success : ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('an_log').setPlaceholder('📋 Salon des alertes Sentinel…').addChannelTypes(ChannelType.GuildText),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('an_level').setPlaceholder('🎚️ Sensibilité…').addOptions(
      Object.keys(LEVELS).map(level => ({ label: LEVEL_LABELS[level], value: level, default: config.level === level })),
    ),
  );

  const row4 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('an_punish').setPlaceholder('⚖️ Sanction automatique…').addOptions(
      Object.entries(PUNISHMENT_LABELS).map(([value, label]) => ({ label, value, default: config.punishment === value })),
    ),
  );

  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('an_thresholds').setLabel('Seuils').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('an_whitelist').setLabel('Confiance').setEmoji('📛').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('an_restore').setLabel('Réparation').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('an_confinement').setLabel(config.lockdownOnNuke ? 'Confinement ON' : 'Confinement OFF').setEmoji('🚧').setStyle(config.lockdownOnNuke ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('an_incidents').setLabel('Incidents').setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

// ─── Vues éphémères ──────────────────────────────────────────────────────────
async function buildStatusEmbed(config, guild) {
  const { windowSec } = effectiveThresholds(config);
  const now = Date.now();
  const live = [];
  const prefix = `${guild.id}:`;
  for (const [key, hits] of tracker) {
    if (!key.startsWith(prefix)) continue;
    const fresh = hits.filter(t => now - t < windowSec * 1000);
    if (!fresh.length) continue;
    const [, userId, action] = key.split(':');
    const meta = describeAction(action);
    live.push(`${meta?.emoji || '⚠️'} ${meta?.label || action} ×**${fresh.length}** — <@${userId}>`);
  }

  const embed = new EmbedBuilder()
    .setColor(config.enabled ? COLORS.info : COLORS.warning)
    .setTitle('📊 Sentinel — statut en direct')
    .setDescription(config.enabled ? 'Surveillance active.' : '⚠️ Sentinel est **désactivé** : aucune action n\'est détectée.')
    .addFields(
      { name: '🎚️ Fenêtre d\'analyse', value: `${windowSec}s`, inline: true },
      { name: '⚖️ Sanction', value: `\`${config.punishment}\``, inline: true },
      { name: '🚨 Confinement', value: config.panicActive ? `🔒 ACTIF depuis <t:${Math.floor(new Date(config.panicSince || now).getTime() / 1000)}:R>` : '✅ Inactif', inline: true },
      { name: '👀 Compteurs en cours', value: live.length ? live.join('\n') : '*aucune action sensible ces dernières minutes*', inline: false },
      { name: '🛡️ Quarantaine', value: config.quarantineRoleId ? `<@&${config.quarantineRoleId}>` : '*créé automatiquement au besoin*', inline: true },
    )
    .setFooter({ text: 'REZO • Sentinel — compteurs remis à zéro à chaque redémarrage' })
    .setTimestamp();
  return embed;
}

function buildIncidentsEmbed(config) {
  const incidents = plainIncidents(config).slice().reverse().slice(0, 10);
  const embed = new EmbedBuilder()
    .setColor(incidents.length ? COLORS.warning : COLORS.info)
    .setTitle('🗂️ Sentinel — incidents enregistrés')
    .setDescription(incidents.length
      ? incidents.map(i => formatIncident(i)).join('\n\n')
      : 'Aucune attaque bloquée pour le moment. 🎉')
    .setFooter({ text: `REZO • Sentinel — ${config.stats?.prevented || 0} attaque(s) bloquée(s) au total · 10 derniers incidents` })
    .setTimestamp();
  return embed;
}

function buildWhitelistView(config) {
  const roles = config.whitelistRoles || [];
  const users = config.whitelistUsers || [];
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📛 Liste de confiance Sentinel')
    .setDescription(
      'Les membres de confiance (propriétaire, rôles et utilisateurs ci-dessous) ne sont **jamais** surveillés. ' +
      'Ajoutez-y les bots de gestion légitimes et les administrateurs en qui vous avez totalement confiance.',
    )
    .addFields(
      { name: '🎭 Rôles', value: roles.length ? roles.map(r => `<@&${r}>`).join('\n') : '*aucun*', inline: true },
      { name: '👤 Utilisateurs', value: users.length ? users.map(u => `<@${u}>`).join('\n') : '*aucun*', inline: true },
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('an_wl_roles').setPlaceholder('➕ Ajouter des rôles de confiance…').setMinValues(1).setMaxValues(10),
      ),
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('an_wl_users').setPlaceholder('➕ Ajouter des utilisateurs de confiance…').setMinValues(1).setMaxValues(10),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('an_wl_clear_roles').setLabel('Vider les rôles').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('an_wl_clear_users').setLabel('Vider les utilisateurs').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

// ─── Modaux ──────────────────────────────────────────────────────────────────
function thresholdsModal(config) {
  const { thresholds } = effectiveThresholds(config);
  const modal = new ModalBuilder().setCustomId('an_modal_thresholds').setTitle('📊 Seuils anti-nuke');
  for (const key of THRESHOLD_KEYS) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(key)
          .setLabel(`${THRESHOLD_LABELS[key]} avant sanction (1-50)`)
          .setStyle(TextInputStyle.Short)
          .setValue(String(thresholds[key]))
          .setRequired(true)
          .setMaxLength(2),
      ),
    );
  }
  return modal;
}

// ═════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('anti-nuke')
    .setDescription('🛡️ Sentinel — protection anti-nuke (destruction massive, webhooks, bots, permissions)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const config = await getConfig(interaction.guild.id);
    return interaction.reply({ ...(await buildPanel(config, interaction.guild)), ephemeral: true });
  },

  // ─── Boutons (persistants, routés par interactionCreate) ───────────────────
  async handleButton(interaction, client) {
    const id = interaction.customId;
    const guild = interaction.guild;
    const config = await getConfig(guild.id);

    if (id === 'an_refresh') return interaction.update(await buildPanel(config, guild));

    if (id === 'an_toggle') {
      config.enabled = !config.enabled;
      await config.save();
      if (config.enabled) {
        const missing = missingPermissions(guild);
        if (missing.length) {
          await interaction.followUp({
            embeds: [errorEmbed('Permissions manquantes', `Sentinel ne pourra pas agir complètement : il manque **${missing.join(', ')}**. Accordez-les pour une protection totale.`)],
            ephemeral: true,
          }).catch(() => {});
        }
        await ensureQuarantineRole(guild, config).catch(() => {});
      }
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'an_status') {
      return interaction.reply({ embeds: [await buildStatusEmbed(config, guild)], ephemeral: true });
    }

    if (id === 'an_panic') {
      const locked = await setPanic(guild, config, !config.panicActive, { userId: interaction.user.id });
      await interaction.reply({
        embeds: [config.panicActive
          ? successEmbed('Mode panique activé', `${locked} salon(s) verrouillé(s). Seul le staff peut écrire.\nLève-le avec le bouton **🚨 Mode panique** ou automatiquement après ${config.panicAutoMin} min.`)
          : successEmbed('Mode panique levé', `${locked} salon(s) déverrouillé(s).`)],
        ephemeral: true,
      });
      return interaction.message?.edit(await buildPanel(config, guild)).catch(() => {});
    }

    if (id === 'an_thresholds') return interaction.showModal(thresholdsModal(config));

    if (id === 'an_whitelist') return interaction.reply({ ...buildWhitelistView(config), ephemeral: true });

    if (id === 'an_restore') {
      const { channels, roles } = config.restore || {};
      // Cycle : tout → salons → rôles → rien → tout
      if (channels && roles)      config.restore = { channels: true, roles: false };
      else if (channels)          config.restore = { channels: false, roles: true };
      else if (roles)             config.restore = { channels: false, roles: false };
      else                        config.restore = { channels: true, roles: true };
      await config.save();
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'an_confinement') {
      // Cycle : OFF → ON 15 min → ON 30 min → ON 60 min → OFF.
      // Le confinement est un pis-aller : il a toujours une fin, jamais d'oubli.
      if (!config.lockdownOnNuke)      { config.lockdownOnNuke = true; config.panicAutoMin = 15; }
      else if (config.panicAutoMin === 15) config.panicAutoMin = 30;
      else if (config.panicAutoMin === 30) config.panicAutoMin = 60;
      else                             { config.lockdownOnNuke = false; }
      await config.save();
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'an_incidents') {
      return interaction.reply({ embeds: [buildIncidentsEmbed(config)], ephemeral: true });
    }

    // ── Liste de confiance (vue éphémère) ──
    if (id === 'an_wl_clear_roles' || id === 'an_wl_clear_users') {
      if (id === 'an_wl_clear_roles') config.whitelistRoles = [];
      else config.whitelistUsers = [];
      await config.save();
      return interaction.update(buildWhitelistView(config));
    }

    return interaction.reply({ embeds: [errorEmbed('Action inconnue', 'Ce bouton n\'est plus valide — rouvrez `/anti-nuke`.')], ephemeral: true });
  },

  // ─── Menus (persistants) ───────────────────────────────────────────────────
  async handleSelect(interaction, client) {
    const id = interaction.customId;
    const guild = interaction.guild;
    const config = await getConfig(guild.id);

    if (id === 'an_log') {
      config.logChannelId = interaction.values[0];
      await config.save();
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'an_level') {
      applyLevel(config, interaction.values[0]);
      await config.save();
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'an_punish') {
      config.punishment = interaction.values[0];
      await config.save();
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'an_wl_roles') {
      config.whitelistRoles = [...new Set([...(config.whitelistRoles || []), ...interaction.values])];
      await config.save();
      return interaction.update(buildWhitelistView(config));
    }

    if (id === 'an_wl_users') {
      config.whitelistUsers = [...new Set([...(config.whitelistUsers || []), ...interaction.values])];
      await config.save();
      return interaction.update(buildWhitelistView(config));
    }
  },

  // ─── Modaux (persistants) ─────────────────────────────────────────────────
  async handleModal(interaction, client) {
    if (interaction.customId !== 'an_modal_thresholds') return;
    const config = await getConfig(interaction.guildId);

    const values = {};
    for (const key of THRESHOLD_KEYS) {
      const parsed = parseInt(interaction.fields.getTextInputValue(key), 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
        return interaction.reply({
          embeds: [errorEmbed('Valeurs invalides', 'Chaque seuil doit être un nombre entier entre **1** et **50**.')],
          ephemeral: true,
        });
      }
      values[key] = parsed;
    }

    config.thresholds = { ...(config.thresholds?.toObject?.() ?? config.thresholds), ...values };
    await config.save();

    return interaction.reply({
      embeds: [successEmbed('Seuils mis à jour', Object.entries(values).map(([key, value]) => `${THRESHOLD_LABELS[key]} : **${value}**`).join('\n'))],
      ephemeral: true,
    });
  },

  // ─── Exports de test ─────────────────────────────────────────────────────
  __testables: { parseBool, restoreLabel, buildPanel, buildWhitelistView, buildStatusEmbed, buildIncidentsEmbed, thresholdsModal },
};
