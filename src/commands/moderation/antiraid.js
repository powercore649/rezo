'use strict';
// commands/antiraid.js — Protection anti-raid complète avec panneau de configuration unique.
// - Détection de raids de masse (fenêtre glissante) + wave raids (arrivées progressives)
// - Quarantaine automatique (rôles retirés, restaurés à la fin du raid)
// - Réponse automatique : captcha, kick des comptes récents, verrouillage d'urgence
// - Honeypots : salons pièges où écrire = ban immédiat (bot confirmé)
// - Whitelist / anti-liste, statut en direct, logs dédiés
// Logique pure : utils/antiraidEngine.js — Orchestration : utils/antiraidActions.js

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const { AntiRaid, AntiRaidHoneypot: Honeypot, MODES } = require('../../models/AntiRaid');
const {
  getConfig, lockAll, endRaid, releaseQuarantine, sendHoneypotMessage,
  logAction, logEmbed, HONEYPOT_MSG,
} = require('../../utils/antiraidActions');
const { modeDefaults } = require('../../utils/antiraidEngine');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');

const MODE_LABELS = {
  monitor: '👁️ Surveillance',
  normal:  '⚖️ Équilibré',
  strict:  '🔴 Strict',
};

function parseIds(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map(s => {
      const m = s.match(/^(?:<@!?|<@&)?(\d{17,20})>?$/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

function parseBool(raw, fallback = false) {
  const v = String(raw || '').toLowerCase().trim();
  if (['oui', 'yes', '1', 'true', 'on', 'activé', 'active'].includes(v)) return true;
  if (['non', 'no', '0', 'false', 'off', 'désactivé', 'desactive'].includes(v)) return false;
  return fallback;
}

// ─── Panneau ──────────────────────────────────────────────────────────────────
async function buildPanel(cfg, client) {
  const quarantined = (cfg.quarantined || []).length;
  const md = modeDefaults(cfg.mode);
  const hpCount = await Honeypot.countDocuments({ guildId: cfg.guildId });

  const embed = new EmbedBuilder()
    .setColor(cfg.raidActive ? COLORS.error : (cfg.enabled ? COLORS.success : COLORS.primary))
    .setTitle(`🛡️ Anti-raid — ${cfg.raidActive ? '🚨 RAID EN COURS' : 'Configuration'}`)
    .setDescription('Panneau unique : tous les systèmes anti-raid du bot se règlent ici. La détection surveille les arrivées massives, la quarantaine isole les comptes suspects, les honeypots piègent les bots.')
    .addFields(
      { name: '📢 Protection',      value: cfg.enabled ? '🟢 Activée' : '🔴 Désactivée', inline: true },
      { name: '🎚️ Niveau',          value: MODE_LABELS[cfg.mode] || cfg.mode, inline: true },
      { name: '📋 Logs',            value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*Aucun*', inline: true },
      { name: '🚪 Détection',       value: `≥ ${cfg.joinsThreshold} arrivées / ${cfg.joinsWindowSec}s`, inline: true },
      { name: '🕵️ Suspects',        value: `≥ ${cfg.suspicionThreshold} comptes suspects`, inline: true },
      { name: '🎂 Âge min. compte', value: cfg.minAccountAgeDays > 0 ? `${cfg.minAccountAgeDays} j` : '*Désactivé*', inline: true },
      { name: '🔒 Quarantaine',     value: `${cfg.quarantineOnJoin ? '🟢 ON' : '🔴 OFF'} · rôle : ${cfg.quarantineRoleId ? '<@&' + cfg.quarantineRoleId + '>' : 'auto'}${cfg.quarantineDurationMin > 0 ? ` · ${cfg.quarantineDurationMin} min` : ''}`, inline: true },
      { name: '🌊 Wave raids',      value: cfg.waveEnabled ? `🟢 ≥ ${cfg.waveThreshold} / ${cfg.wavePeriodMin} min` : '🔴 OFF', inline: true },
      { name: '🤖 Réponse raid',    value: [cfg.response?.verification && 'captcha', cfg.response?.kickNewAccounts && 'kick récents', cfg.response?.lockdown && 'verrouillage', cfg.response?.blockInvites && 'invitations bloquées'].filter(Boolean).join(' + ') || '*aucune*', inline: true },
      { name: '🍯 Honeypots',       value: `${hpCount} salon(s)`, inline: true },
      { name: '📛 Whitelist',       value: `${(cfg.whitelistedRoleIds || []).length} rôle(s) · ${(cfg.whitelistedUserIds || []).length} user`, inline: true },
      { name: '⛔ Anti-liste',      value: `${(cfg.bannedUserIds || []).length} user · ${cfg.bannedBan ? 'ban' : cfg.bannedKick ? 'kick' : 'aucune action'}`, inline: true },
      { name: '🚨 État',            value: `${cfg.raidActive ? `**RAID ACTIF** depuis <t:${Math.floor(new Date(cfg.raidDetectedAt || Date.now()).getTime() / 1000)}:R>` : '✅ Aucun raid'}\nVerrouillage : ${cfg.lockdownActive ? '🔒 ACTIF' : 'ouvert'} · Quarantaine : ${quarantined} membre(s)`, inline: false },
      { name: '📊 Historique',      value: `${cfg.raidCount} raid(s) détecté(s) au total${cfg.lastRaidInfo ? `\nDernier : ${cfg.lastRaidInfo}` : ''}`, inline: false },
    )
    .setFooter({ text: `Défauts du niveau ${cfg.mode} : ≥${md.joinsThreshold}/ ${md.joinsWindowSec}s · suspects ≥${md.suspicionThreshold} (personnalisable)` })
    .setTimestamp();

  // ⚠️ Discord : un select menu occupe TOUTE la largeur d'une rangée — jamais
  // de boutons ni de second select dans la même rangée (50035 WIDTH_EXCEEDED).
  // Rangée 1 — activation + statut + actualiser (boutons)
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('arm_toggle').setLabel(cfg.enabled ? '🔴 Désactiver' : '🟢 Activer').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success).setEmoji('🛡️'),
    new ButtonBuilder().setCustomId('arm_status').setLabel('Statut en direct').setEmoji('📊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('arm_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  // Rangée 2 — salon de logs (menu seul)
  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('arms_log').setPlaceholder('📋 Salon de logs anti-raid…').addChannelTypes(ChannelType.GuildText),
  );

  // Rangée 3 — niveau de protection (menu seul)
  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('arms_mode').setPlaceholder('🎚️ Niveau de protection…').addOptions(
      MODES.map(m => ({ label: MODE_LABELS[m], value: m, default: cfg.mode === m })),
    ),
  );

  // Rangée 4 — réglages de détection et de réponse (boutons)
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('arm_thresholds').setLabel('Détection').setStyle(ButtonStyle.Secondary).setEmoji('📊'),
    new ButtonBuilder().setCustomId('arm_wave').setLabel(`Wave : ${cfg.waveEnabled ? 'ON' : 'OFF'}`).setEmoji('🌊').setStyle(cfg.waveEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('arm_quarantine').setLabel('Quarantaine').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('arm_response').setLabel('Réponse raid').setEmoji('🤖').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('arm_lockdown').setLabel(cfg.lockdownActive ? 'Déverrouiller' : 'Verrouiller').setEmoji(cfg.lockdownActive ? '🔓' : '🔒').setStyle(cfg.lockdownActive ? ButtonStyle.Success : ButtonStyle.Danger),
  );

  // Rangée 5 — honeypots + listes + fin de raid (boutons)
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('arm_honeypot').setLabel('Honeypots').setEmoji('🍯').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('arm_whitelist').setLabel('Whitelist').setEmoji('📛').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('arm_blacklist').setLabel('Anti-liste').setEmoji('⛔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('arm_endraid').setLabel('Fin de raid').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!cfg.raidActive && !cfg.lockdownActive && !quarantined),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

// ─── Statut en direct (éphémère) ─────────────────────────────────────────────
async function buildStatus(cfg, guild) {
  const now = Date.now();
  const recentJoins = (cfg.joins || []).filter(j => now - j.joinedAt < 10 * 60_000);
  const hps = await Honeypot.find({ guildId: guild.id });
  const avgAge = recentJoins.length
    ? Math.round(recentJoins.reduce((s, j) => s + (j.accountAgeDays || 0), 0) / recentJoins.length)
    : null;

  const embed = new EmbedBuilder()
    .setColor(cfg.raidActive ? COLORS.error : COLORS.primary)
    .setTitle('📊 Statut anti-raid — en direct')
    .setDescription(cfg.raidActive
      ? `🚨 **RAID EN COURS** — détecté <t:${Math.floor(new Date(cfg.raidDetectedAt || now).getTime() / 1000)}:R>\n${cfg.lastRaidInfo || ''}`
      : '✅ Aucun raid en cours.')
    .addFields(
      { name: '🕐 Arrivées (10 min)', value: `${recentJoins.length}`, inline: true },
      { name: '🎂 Âge moyen',         value: avgAge !== null ? `${avgAge} j` : '—', inline: true },
      { name: '🔒 Verrouillage',      value: cfg.lockdownActive ? '🔒 ACTIF' : 'Ouvert', inline: true },
      { name: '🛡️ En quarantaine',   value: `${(cfg.quarantined || []).length} membre(s)`, inline: true },
      { name: '🍯 Honeypots',         value: `${hps.length} salon(s)`, inline: true },
      { name: '📈 Raids totaux',      value: `${cfg.raidCount}`, inline: true },
    );

  if (hps.length) {
    embed.addFields({ name: '🍯 Salons pièges', value: hps.map(h => `• <#${h.channelId}> (${h.strikes} déclenchement(s))`).join('\n'), inline: false });
  }
  return embed;
}

// ═════════════════════════════════════════════════════════════════════════════
const authGate = require('../../utils/authGate');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('🛡️ Protection anti-raid complète — panneau de configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction, client) {
    const cfg = await getConfig(interaction.guild.id);
    const reply = await interaction.reply({ ...(await buildPanel(cfg, client)), ephemeral: true, fetchReply: true });

    // Le collecteur maintient le panneau actif 10 min ; les actions arm_/arms_
    // sont routées de façon persistante par interactionCreate (handleButton/handleSelect).
    const collector = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 10 * 60 * 1000 });
    collector.on('collect', () => {});
    collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Menus (persistants) ───────────────────────────────────────────────────
  async handleSelect(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Anti-raid' }))) return;
    const id = interaction.customId;
    const cfg = await getConfig(interaction.guild.id);

    if (id === 'arms_log') {
      cfg.logChannelId = interaction.values[0];
      await cfg.save();
      await logAction(client, cfg, logEmbed(interaction.guild.id, { color: COLORS.primary, title: '⚙️ Salon de logs anti-raid défini', description: `<#${cfg.logChannelId}> par <@${interaction.user.id}>` }));
      return interaction.update(await buildPanel(cfg, client));
    }

    if (id === 'arms_mode') {
      cfg.mode = interaction.values[0];
      await cfg.save();
      return interaction.update(await buildPanel(cfg, client));
    }

    if (id === 'arms_qrole') {
      cfg.quarantineRoleId = interaction.values[0];
      await cfg.save();
      return interaction.update(await buildPanel(cfg, client));
    }

    if (id === 'arms_wl_role') {
      const roles = interaction.values;
      cfg.whitelistedRoleIds = [...new Set([...(cfg.whitelistedRoleIds || []), ...roles])];
      await cfg.save();
      return interaction.update({ embeds: [successEmbed('Whitelist mise à jour', `${roles.map(r => `<@&${r}>`).join(', ')} ajouté(s) à la whitelist (jamais suspects).`)], components: [] });
    }

    if (id === 'arms_hp_add') {
      const channelId = interaction.values[0];
      const existing = await Honeypot.findOne({ guildId: interaction.guild.id, channelId });
      if (existing) {
        return interaction.update({ embeds: [errorEmbed('Déjà piège', `<#${channelId}> est déjà un honeypot.`)], components: [] });
      }
      const hp = await Honeypot.create({ guildId: interaction.guild.id, channelId });
      await sendHoneypotMessage(client, hp);
      await logAction(client, cfg, logEmbed(interaction.guild.id, { color: COLORS.warning, title: '🍯 Honeypot créé', description: `Salon <#${channelId}> — tout message y sera traité comme une attaque (ban).` }));
      return interaction.update({ embeds: [successEmbed('Honeypot créé', `Le salon <#${channelId}> est désormais un piège.\n⚠️ **Prévenez votre staff** : personne ne doit y écrire, jamais.\n${HONEYPOT_MSG}`)], components: [] });
    }

    if (id === 'arms_hp_remove') {
      const channelId = interaction.values[0];
      const hp = await Honeypot.findOneAndDelete({ guildId: interaction.guild.id, channelId });
      if (hp?.messageId) {
        const ch = interaction.guild.channels.cache.get(channelId);
        const msg = await ch?.messages.fetch(hp.messageId).catch(() => null);
        await msg?.delete().catch(() => {});
      }
      return interaction.update({ embeds: [successEmbed('Honeypot retiré', `Le salon <#${channelId}> n'est plus un piège.`)], components: [] });
    }
  },

  // ─── Boutons (persistants) ────────────────────────────────────────────────
  async handleButton(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Panneau anti-raid' }))) return;
    const id = interaction.customId;
    const guild = interaction.guild;
    const cfg = await getConfig(guild.id);

    if (id === 'arm_refresh') {
      return interaction.update(await buildPanel(cfg, client));
    }

    if (id === 'arm_toggle') {
      cfg.enabled = !cfg.enabled;
      if (cfg.enabled) cfg.raidActive = false;
      await cfg.save();
      await logAction(client, cfg, logEmbed(guild.id, { color: cfg.enabled ? COLORS.success : COLORS.warning, title: cfg.enabled ? '🛡️ Anti-raid activé' : '🛡️ Anti-raid désactivé', description: `Par <@${interaction.user.id}>` }));
      return interaction.update(await buildPanel(cfg, client));
    }

    if (id === 'arm_status') {
      return interaction.reply({ embeds: [await buildStatus(cfg, guild)], ephemeral: true });
    }

    if (id === 'arm_lockdown') {
      const enable = !cfg.lockdownActive;
      const locked = await lockAll(guild, enable);
      cfg.lockdownActive = enable;
      await cfg.save();
      await logAction(client, cfg, logEmbed(guild.id, {
        color: enable ? COLORS.error : COLORS.success,
        title: enable ? '🔒 SERVEUR VERROUILLÉ (manuel)' : '🔓 Serveur déverrouillé',
        description: `${locked} salon(s) · par <@${interaction.user.id}>`,
      }));
      return interaction.update(await buildPanel(cfg, client));
    }

    if (id === 'arm_endraid') {
      const actions = await endRaid(client, guild, cfg);
      return interaction.reply({
        embeds: [successEmbed('Fin du raid', actions.length ? actions.join('\n') : 'Aucune action à annuler — l\'état a été réinitialisé.')],
        ephemeral: true,
      });
    }

    if (id === 'arm_release_q') {
      const released = await releaseQuarantine(client, guild, cfg);
      return interaction.reply({
        embeds: [successEmbed('Quarantaine levée', released ? `${released} membre(s) restauré(s) avec leurs rôles.` : 'Aucun membre en quarantaine.')],
        ephemeral: true,
      });
    }

    // ── Modaux de configuration ──
    if (id === 'arm_thresholds') {
      const modal = new ModalBuilder().setCustomId('armm_thresholds').setTitle('🚪 Détection de raid');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('joins_threshold').setLabel(`Arrivées déclenchant un raid (déf. ${modeDefaults(cfg.mode).joinsThreshold})`).setStyle(TextInputStyle.Short).setValue(String(cfg.joinsThreshold)).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('joins_window').setLabel(`Fenêtre en secondes (déf. ${modeDefaults(cfg.mode).joinsWindowSec})`).setStyle(TextInputStyle.Short).setValue(String(cfg.joinsWindowSec)).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('suspicion').setLabel(`Seuil comptes suspects (déf. ${modeDefaults(cfg.mode).suspicionThreshold})`).setStyle(TextInputStyle.Short).setValue(String(cfg.suspicionThreshold)).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min_age').setLabel('Âge min. du compte en jours (0 = off)').setStyle(TextInputStyle.Short).setValue(String(cfg.minAccountAgeDays)).setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    if (id === 'arm_wave') {
      const modal = new ModalBuilder().setCustomId('armm_wave').setTitle('🌊 Wave raids');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wave_enabled').setLabel('Activer la détection wave ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.waveEnabled ? 'oui' : 'non').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wave_period').setLabel('Période d\'analyse en minutes').setStyle(TextInputStyle.Short).setValue(String(cfg.wavePeriodMin)).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wave_threshold').setLabel('Arrivées sur la période déclenchant un raid').setStyle(TextInputStyle.Short).setValue(String(cfg.waveThreshold)).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto_resolve').setLabel('Fin auto du verrouillage (min, 0=off)').setStyle(TextInputStyle.Short).setValue(String(cfg.autoResolveMin)).setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    if (id === 'arm_quarantine') {
      const modal = new ModalBuilder().setCustomId('armm_quarantine').setTitle('🔒 Quarantaine');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q_enabled').setLabel('Mettre en quarantaine à l\'arrivée ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.quarantineOnJoin ? 'oui' : 'non').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q_duration').setLabel('Libération auto (min, 0 = manuel)').setStyle(TextInputStyle.Short).setValue(String(cfg.quarantineDurationMin)).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q_role').setLabel('Rôle de quarantaine (ID/mention, vide = auto)').setStyle(TextInputStyle.Short).setValue(cfg.quarantineRoleId ? `<@&${cfg.quarantineRoleId}>` : '').setRequired(false)),
      );
      return interaction.showModal(modal);
    }

    if (id === 'arm_response') {
      const modal = new ModalBuilder().setCustomId('armm_response').setTitle('🤖 Réponse automatique au raid');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('resp_verification').setLabel('Captcha pendant le raid ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.response?.verification ? 'oui' : 'non').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('resp_kick').setLabel('Kicker les comptes trop récents ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.response?.kickNewAccounts ? 'oui' : 'non').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('resp_lockdown').setLabel('Verrouiller le serveur ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.response?.lockdown ? 'oui' : 'non').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('resp_invites').setLabel('Suspendre les invitations ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.response?.blockInvites ? 'oui' : 'non').setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    // ── Vues éphémères (listes & honeypots) ──
    if (id === 'arm_whitelist') {
      const menu = new RoleSelectMenuBuilder().setCustomId('arms_wl_role').setPlaceholder('Ajouter des rôles à la whitelist…').setMinValues(1).setMaxValues(10);
      return interaction.reply({
        embeds: [infoEmbed(
          '📛 Whitelist',
          `Les membres avec ces rôles, ou ces utilisateurs, ne sont **jamais** considérés suspects.\n\n**Rôles :** ${(cfg.whitelistedRoleIds || []).map(r => `<@&${r}>`).join(', ') || '*aucun*'}\n**Utilisateurs :** ${(cfg.whitelistedUserIds || []).map(u => `<@${u}>`).join(', ') || '*aucun*'}`,
        )],
        components: [
          new ActionRowBuilder().addComponents(menu),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('arm_wl_users').setLabel('➕ Ajouter des utilisateurs').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('arm_wl_clear').setLabel('🗑️ Vider').setStyle(ButtonStyle.Danger),
          ),
        ],
        ephemeral: true,
      });
    }

    if (id === 'arm_wl_users') {
      const modal = new ModalBuilder().setCustomId('armm_wl_users').setTitle('📛 Whitelist — ajouter des utilisateurs');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wl_users').setLabel('IDs ou mentions (séparés par espace/virgule)').setStyle(TextInputStyle.Paragraph).setPlaceholder('123456789012345678, <@987654321098765432>').setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    if (id === 'arm_wl_clear') {
      cfg.whitelistedRoleIds = [];
      await cfg.save();
      return interaction.update({ embeds: [successEmbed('Whitelist vidée', 'Tous les rôles ont été retirés de la whitelist.')], components: [] });
    }

    if (id === 'arm_blacklist') {
      const modal = new ModalBuilder().setCustomId('armm_blacklist').setTitle('⛔ Anti-liste — ajouter des utilisateurs');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bl_users').setLabel('IDs ou mentions (séparés par espace/virgule)').setStyle(TextInputStyle.Paragraph).setPlaceholder('123456789012345678, <@987654321098765432>').setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('bl_action').setLabel('Action à l\'arrivée : kick ou ban').setStyle(TextInputStyle.Short).setValue(cfg.bannedBan ? 'ban' : 'kick').setRequired(true)),
      );
      return interaction.showModal(modal);
    }

    if (id === 'arm_bl_clear') {
      cfg.bannedUserIds = [];
      await cfg.save();
      return interaction.update({ embeds: [successEmbed('Anti-liste vidée', 'Tous les utilisateurs ont été retirés.')], components: [] });
    }

    if (id === 'arm_honeypot') {
      const hps = await Honeypot.find({ guildId: guild.id });
      const addMenu = new ChannelSelectMenuBuilder().setCustomId('arms_hp_add').setPlaceholder('Ajouter un salon piège…').addChannelTypes(ChannelType.GuildText);
      const rows = [new ActionRowBuilder().addComponents(addMenu)];
      if (hps.length) {
        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('arms_hp_remove').setPlaceholder('Retirer un piège existant…').addOptions(
            hps.map(h => ({ label: `Retirer #${h.channelId}`, value: h.channelId, description: `${h.strikes} déclenchement(s)` })),
          ),
        ));
      }
      return interaction.reply({
        embeds: [infoEmbed(
          '🍯 Honeypots — salons pièges',
          `Un honeypot est un salon qui semble être une « porte d'entrée » pour les bots. **Tout message envoyé dedans = ban immédiat** (le compte est un bot confirmé).\n\n**Actifs :** ${hps.length ? hps.map(h => `<#${h.channelId}>`).join(', ') : '*aucun*'}\n\n⚠️ Prévenez votre staff : personne ne doit y écrire, jamais.`,
        )],
        components: rows,
        ephemeral: true,
      });
    }

    return interaction.reply({ embeds: [errorEmbed('Action inconnue', 'Ce bouton n\'est plus valide — rouvrez `/antiraid`.')], ephemeral: true });
  },

  // ─── Modaux (persistants) ─────────────────────────────────────────────────
  async handleModal(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Anti-raid' }))) return;
    const id = interaction.customId;
    const guild = interaction.guild;
    const cfg = await getConfig(guild.id);

    if (id === 'armm_thresholds') {
      const jt = parseInt(interaction.fields.getTextInputValue('joins_threshold'), 10);
      const jw = parseInt(interaction.fields.getTextInputValue('joins_window'), 10);
      const sp = parseInt(interaction.fields.getTextInputValue('suspicion'), 10);
      const ma = parseInt(interaction.fields.getTextInputValue('min_age'), 10);
      if ([jt, jw, sp, ma].some(v => isNaN(v) || v < 0) || jt < 2 || jw < 5 || jw > 3600) {
        return interaction.reply({ embeds: [errorEmbed('Valeurs invalides', 'Arrivées ≥ 2, fenêtre entre 5 et 3600 s, seuils positifs.')], ephemeral: true });
      }
      cfg.joinsThreshold = Math.min(jt, 200);
      cfg.joinsWindowSec = Math.min(jw, 3600);
      cfg.suspicionThreshold = Math.min(sp, 200);
      cfg.minAccountAgeDays = Math.min(ma, 365);
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Détection mise à jour', `Raid si ≥ **${cfg.joinsThreshold}** arrivées / **${cfg.joinsWindowSec}s** · suspects ≥ **${cfg.suspicionThreshold}** · âge min. **${cfg.minAccountAgeDays > 0 ? cfg.minAccountAgeDays + ' j' : 'désactivé'}**`)], ephemeral: true });
    }

    if (id === 'armm_wave') {
      const we = parseBool(interaction.fields.getTextInputValue('wave_enabled'), cfg.waveEnabled);
      const wp = parseInt(interaction.fields.getTextInputValue('wave_period'), 10);
      const wt = parseInt(interaction.fields.getTextInputValue('wave_threshold'), 10);
      const ar = parseInt(interaction.fields.getTextInputValue('auto_resolve'), 10);
      if (isNaN(wp) || isNaN(wt) || isNaN(ar) || wp < 1 || wp > 1440 || wt < 2 || ar < 0) {
        return interaction.reply({ embeds: [errorEmbed('Valeurs invalides', 'Période : 1–1440 min, seuil ≥ 2, auto-résolution ≥ 0.')], ephemeral: true });
      }
      cfg.waveEnabled = we;
      cfg.wavePeriodMin = wp;
      cfg.waveThreshold = Math.min(wt, 1000);
      cfg.autoResolveMin = Math.min(ar, 1440);
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Wave raids mis à jour', `Détection wave : **${we ? 'ON' : 'OFF'}** · raid si ≥ **${cfg.waveThreshold}** arrivées / **${wp} min** · auto-déverrouillage : ${ar > 0 ? `${ar} min` : 'manuel'}`)], ephemeral: true });
    }

    if (id === 'armm_quarantine') {
      const qe = parseBool(interaction.fields.getTextInputValue('q_enabled'), cfg.quarantineOnJoin);
      const qd = parseInt(interaction.fields.getTextInputValue('q_duration'), 10);
      if (isNaN(qd) || qd < 0 || qd > 10080) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Durée entre 0 et 10080 minutes (7 jours).')], ephemeral: true });
      }
      // Rôle de quarantaine : ID/mention, ou vide / "auto" / "0" = détection auto
      const qRoleRaw = (interaction.fields.getTextInputValue('q_role') || '').trim();
      let qRole = null;
      if (qRoleRaw && !['0', 'auto', 'aucun'].includes(qRoleRaw.toLowerCase())) {
        qRole = parseIds(qRoleRaw)[0] || null;
        if (!qRole) {
          return interaction.reply({ embeds: [errorEmbed('ID de rôle invalide', 'Fournissez un ID de rôle (17–20 chiffres) ou une mention `<@&…>`, ou laissez vide.')], ephemeral: true });
        }
      }
      cfg.quarantineOnJoin = qe;
      cfg.quarantineDurationMin = qd;
      cfg.quarantineRoleId = qRole;
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Quarantaine mise à jour', `Quarantaine à l'arrivée : **${qe ? 'ON' : 'OFF'}** · rôle : ${qRole ? `<@&${qRole}>` : 'auto'} · libération : ${qd > 0 ? `auto après ${qd} min` : 'manuelle (bouton Fin de raid / levée manuelle)'}`)], ephemeral: true });
    }

    if (id === 'armm_response') {
      cfg.response = cfg.response || {};
      cfg.response.verification = parseBool(interaction.fields.getTextInputValue('resp_verification'), cfg.response.verification);
      cfg.response.kickNewAccounts = parseBool(interaction.fields.getTextInputValue('resp_kick'), cfg.response.kickNewAccounts);
      cfg.response.lockdown = parseBool(interaction.fields.getTextInputValue('resp_lockdown'), cfg.response.lockdown);
      cfg.response.blockInvites = parseBool(interaction.fields.getTextInputValue('resp_invites'), cfg.response.blockInvites);
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Réponse raid mise à jour', `Pendant un raid : ${[cfg.response.verification && 'captcha', cfg.response.kickNewAccounts && 'kick des comptes récents', cfg.response.lockdown && 'verrouillage du serveur', cfg.response.blockInvites && 'invitations suspendues'].filter(Boolean).join(' + ') || 'aucune action automatique'}`)], ephemeral: true });
    }

    if (id === 'armm_blacklist') {
      const users = parseIds(interaction.fields.getTextInputValue('bl_users'));
      if (!users.length) {
        return interaction.reply({ embeds: [errorEmbed('Aucun ID valide', 'Fournissez des IDs d\'utilisateurs (17–20 chiffres) ou des mentions.')], ephemeral: true });
      }
      const action = String(interaction.fields.getTextInputValue('bl_action')).toLowerCase().trim();
      if (action.includes('ban')) { cfg.bannedBan = true; cfg.bannedKick = false; }
      else { cfg.bannedKick = true; cfg.bannedBan = false; }
      cfg.bannedUserIds = [...new Set([...(cfg.bannedUserIds || []), ...users])];
      await cfg.save();
      await logAction(client, cfg, logEmbed(guild.id, { color: COLORS.warning, title: '⛔ Anti-liste mise à jour', description: `${users.map(u => `<@${u}>`).join(', ')} ajouté(s) par <@${interaction.user.id}> — action à l'arrivée : **${cfg.bannedBan ? 'ban' : 'kick'}**` }));
      return interaction.reply({ embeds: [successEmbed('Anti-liste mise à jour', `${users.length} utilisateur(s) ajouté(s). Action à l'arrivée : **${cfg.bannedBan ? 'ban définitif' : 'kick'}**.`)], ephemeral: true });
    }

    if (id === 'armm_wl_users') {
      const users = parseIds(interaction.fields.getTextInputValue('wl_users'));
      if (!users.length) {
        return interaction.reply({ embeds: [errorEmbed('Aucun ID valide', 'Fournissez des IDs d\'utilisateurs (17–20 chiffres) ou des mentions.')], ephemeral: true });
      }
      cfg.whitelistedUserIds = [...new Set([...(cfg.whitelistedUserIds || []), ...users])];
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Whitelist mise à jour', `${users.length} utilisateur(s) ajouté(s) à la whitelist.`)], ephemeral: true });
    }
  },
};
