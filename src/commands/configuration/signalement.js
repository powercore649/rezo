// commands/configuration/signalement.js — SYSTÈME DE SIGNALEMENT COMPLET
//
// /signalement : UNE commande, UN panneau (comme /reglement, /welcome panel).
//   Côté config staff  : activer, salon des signalements, types, permissions,
//                        cooldown, anonymat, accusé de réception DM, stats,
//                        publication du bouton « Signaler » dans un salon.
//   Côté membres       : bouton public « Signaler » (persistant) → formulaire
//                        en 2 étapes (motif puis détails) ; les signalements
//                        arrivent dans le salon staff avec boutons Traiter /
//                        Rejeter / Bannir / Warn + lien vers le contexte.
//
// Conventions customId : sigm_ (modaux), sigs_ (menus), sig_ (boutons staff),
//                        sig_open_ (bouton public)
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
} = require('discord.js');
const { Config, Report } = require('../../models/Signalement');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');

const REASONS = [
  { value: 'harcelement',  label: '🚫 Harcèlement / insultes' },
  { value: 'spam',         label: '📣 Spam / flood' },
  { value: 'pub',          label: '🔗 Publicité non autorisée' },
  { value: 'contenu',      label: '🔞 Contenu inapproprié' },
  { value: 'arnaque',      label: '💸 Arnaque / scam' },
  { value: 'menace',       label: '⚠️ Menace / comportement dangereux' },
  { value: 'raid',         label: '💥 Raid / brigade' },
  { value: 'autre',        label: '❓ Autre' },
];

const COOLDOWNS = new Map(); // `${guildId}:${userId}` -> timestamp dernier signalement

function reasonLabel(value) {
  return REASONS.find(r => r.value === value)?.label || value;
}

// ─── Embed du panneau staff ───────────────────────────────────────────────────
function buildPanel(cfg, guild, note = null) {
  const t = cfg.types;
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🚨 Panneau des signalements')
    .setDescription(
      'Configurez **tout** le système de signalement depuis ce panneau.\n'
      + `\n**⚡ État :** ${cfg.enabled ? '🟢 Activé' : '🔴 Désactivé'}`
      + `\n**📥 Salon des signalements :** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*Non défini*'}`
      + `\n**👤 Membres visables :** ${t.member ? '✅' : '❌'}  •  **💬 Messages :** ${t.message ? '✅' : '❌'}`
      + `\n**🔐 Qui peut signaler :** ${cfg.rolesAllowed.length ? cfg.rolesAllowed.map(r => `<@&${r}>`).join(', ') : '*Tout le monde*'}`
      + `\n**⏱️ Cooldown :** ${cfg.cooldownSec}s entre chaque signalement`
      + `\n**🕵️ Anonymat :** ${cfg.anonymous ? 'Activé (staff ne voit pas l\'auteur)' : 'Désactivé (auteur visible du staff)'}`
      + `\n**📨 Accusé de réception DM :** ${cfg.autoAlertUser ? 'Activé' : 'Désactivé'}`
      + `\n**📊 Traités :** ✅ ${cfg.stats.resolved}  •  ❌ ${cfg.stats.rejected}  •  ⏳ en attente : ${cfg.stats.pending}`
      + (note ? `\n\n${note}` : ''),
    )
    .setFooter({ text: 'Les membres signalent via le bouton « Signaler » ou en MP au bot' });

  // ⚠️ Discord limite un message à 5 rangées de composants — tout doit tenir dedans.
  // Row 1 : boutons (toggle, accusé DM, anonymat, cooldown cyclique, stats)
  const stateRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sig_toggle').setLabel(cfg.enabled ? 'Désactiver' : 'Activer')
      .setEmoji(cfg.enabled ? '⏸️' : '⚡').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('sig_dm_toggle').setLabel(`DM : ${cfg.autoAlertUser ? 'ON' : 'OFF'}`)
      .setEmoji('📨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sig_anon_toggle').setLabel(`Anonyme : ${cfg.anonymous ? 'ON' : 'OFF'}`)
      .setEmoji('🕵️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sig_cooldown').setLabel(`Cooldown : ${cfg.cooldownSec}s`)
      .setEmoji('⏱️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sig_stats').setLabel('Stats').setEmoji('📊').setStyle(ButtonStyle.Primary),
  );

  const typeRow = new ActionRowBuilder().addComponents(
    // maxValues = nombre d'options : les 2 peuvent être « default » simultanément
    new StringSelectMenuBuilder().setCustomId('sigs_types').setPlaceholder('🧩 Types de signalement acceptés…').setMinValues(0).setMaxValues(2).addOptions([
      { label: 'Membres (mention / ID)', value: 'member', emoji: '👤', default: t.member },
      { label: 'Messages (lien ou ID)', value: 'message', emoji: '💬', default: t.message },
    ]),
  );

  const permsRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('sigs_roles').setPlaceholder('🔐 Restreindre à des rôles (vide = tout le monde)').setMinValues(0).setMaxValues(5),
  );

  const logRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('sigs_log').setPlaceholder('📥 Salon où recevoir les signalements…').addChannelTypes(ChannelType.GuildText),
  );

  const pubRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('sigs_public').setPlaceholder('📌 Publier le bouton « Signaler » dans…').addChannelTypes(ChannelType.GuildText),
  );

  return { embeds: [embed], components: [stateRow, typeRow, permsRow, logRow, pubRow] };
}

// ─── Étape 2 : formulaire de détails (modal) ─────────────────────────────────
function buildDetailsModal(reasonValue, targetId = null, messageId = null) {
  // CustomId : sigm_submit_<motif>[_<targetId>|_libre][_<messageId>]
  const suffix = `_${reasonValue}${targetId ? `_${targetId}` : '_libre'}${messageId ? `_${messageId}` : ''}`;
  const modal = new ModalBuilder().setCustomId(`sigm_submit${suffix}`).setTitle('🚨 Signaler — détails');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sigm_details').setLabel('Décrivez le problème (obligatoire)')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sigm_proof').setLabel('Lien de preuve (image ou message, optionnel)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300),
    ),
  );
  return { modal, reasonValue };
}

// ─── Étape 1 : choix du motif (menu éphémère) ────────────────────────────────
function buildReasonMenu(targetId = null, messageId = null) {
  const prefix = targetId ? `sigr_m_${targetId}${messageId ? `_${messageId}` : ''}` : 'sigr_libre';
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(prefix).setPlaceholder('🚩 Motif du signalement…').addOptions(REASONS),
  );
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.warning)
      .setTitle('🚨 Signaler — étape 1/2 : le motif')
      .setDescription(targetId ? `Membre visé : <@${targetId}>` : 'Choisissez le motif de votre signalement.')],
    components: [row],
    ephemeral: true,
  };
}

// ─── Envoi au salon staff ─────────────────────────────────────────────────────
function buildStaffEmbed(report, guild, { anonymous } = {}) {
  const targetLine = report.targetType === 'message' && report.contextUrl
    ? `[Message visé](${report.contextUrl})`
    : report.targetId ? `<@${report.targetId}> (\`${report.targetId}\`)`
    : '*Signalement libre*';
  const authorLine = anonymous ? '*Anonyme*' : `<@${report.reporterId}> (\`${report.reporterId}\`)`;

  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle(`🚨 Signalement — ${reasonLabel(report.reason)}`)
    .setDescription(
      `**Signaleur :** ${authorLine}`
      + `\n**Cible :** ${targetLine}`
      + `\n**Type :** ${report.targetType === 'member' ? '👤 Membre' : report.targetType === 'message' ? '💬 Message' : '📄 Libre'}`
      + `\n**Salon :** ${report.channelId ? `<#${report.channelId}>` : '*—*'}`
      + `\n\n**📝 Détails :**\n> ${report.details?.slice(0, 900) || '*Aucun détail*'}`
      + (report.proofUrl ? `\n\n**🔗 Preuve :** ${report.proofUrl}` : ''),
    )
    .setFooter({ text: `Signalement #${report._id.toString().slice(-6)} • ${guild.name}` })
    .setTimestamp();
}

function buildStaffRow(reportId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sig_handle_${reportId}`).setLabel('Traiter').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sig_reject_${reportId}`).setLabel('Rejeter').setEmoji('🗑️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sig_goto_${reportId}`).setLabel('Voir le contexte').setEmoji('🔍').setStyle(ButtonStyle.Secondary).setDisabled(true),
    ),
  ];
}

async function deliverToStaff(client, report, guild, cfg) {
  const channel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  const rows = buildStaffRow(report._id.toString());
  if (report.targetId) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sig_warn_${report._id}`).setLabel('Warn').setEmoji('⚠️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sig_ban_${report._id}`).setLabel('Ban').setEmoji('🔨').setStyle(ButtonStyle.Danger),
    ));
  }
  const msg = await channel.send({
    content: cfg.anonymous ? '🚨 **Nouveau signalement anonyme**' : '🚨 **Nouveau signalement**',
    embeds: [buildStaffEmbed(report, guild, { anonymous: cfg.anonymous })],
    components: rows,
  }).catch(() => null);
  if (msg) {
    report.staffMsgId = msg.id;
    await report.save().catch(() => {});
  }
  return msg;
}

// Statuts : mise à jour du compteur + fin de vie du message staff
async function setStatus(report, status, handledBy, action = '', note = '') {
  const cfg = await Config.findOne({ guildId: report.guildId });
  if (cfg && report.status === 'pending' && status !== 'pending') {
    cfg.stats.pending = Math.max(0, cfg.stats.pending - 1);
    if (status === 'resolved') cfg.stats.resolved += 1;
    if (status === 'rejected') cfg.stats.rejected += 1;
    cfg.updatedAt = new Date();
    await cfg.save().catch(() => {});
  }
  report.status = status;
  report.handledBy = handledBy;
  report.handledAt = new Date();
  report.action = action;
  report.note = note;
  await report.save();
}

// ─── Commande unique : /signalement ───────────────────────────────────────────
module.exports = {
  REASONS,

  data: new SlashCommandBuilder()
    .setName('signalement')
    .setDescription('🚨 Panneau de gestion complète du système de signalement')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    let cfg = await Config.findOne({ guildId: interaction.guildId });
    if (!cfg) cfg = await Config.create({ guildId: interaction.guildId });
    return interaction.reply({ ...buildPanel(cfg, interaction.guild), ephemeral: true });
  },

  // ── Boutons du panneau + boutons staff sur les signalements ─────────────────
  async handleButton(interaction) {
    const id = interaction.customId;
    const cfg = await Config.findOne({ guildId: interaction.guildId });
    if (!cfg) return;

    if (id === 'sig_toggle') {
      cfg.enabled = !cfg.enabled;
      cfg.updatedAt = new Date();
      await cfg.save();
      return interaction.update(buildPanel(cfg, interaction.guild,
        cfg.enabled ? '⚡ Système **activé**.' : '⏸️ Système **désactivé** — les boutons « Signaler » refusent les demandes.'));
    }

    if (id === 'sig_dm_toggle') {
      cfg.autoAlertUser = !cfg.autoAlertUser;
      cfg.updatedAt = new Date();
      await cfg.save();
      return interaction.update(buildPanel(cfg, interaction.guild, `📨 Accusé de réception DM ${cfg.autoAlertUser ? '**activé**' : '**désactivé**'}.`));
    }

    if (id === 'sig_anon_toggle') {
      cfg.anonymous = !cfg.anonymous;
      cfg.updatedAt = new Date();
      await cfg.save();
      return interaction.update(buildPanel(cfg, interaction.guild, `🕵️ Anonymat ${cfg.anonymous ? '**activé** — le staff ne verra pas l\'auteur' : '**désactivé** — l\'auteur sera visible du staff'}.`));
    }

    // Cooldown cyclique : 15 → 30 → 60 → 120 → 300 → 15
    if (id === 'sig_cooldown') {
      const steps = [15, 30, 60, 120, 300];
      const idx = steps.indexOf(cfg.cooldownSec);
      cfg.cooldownSec = steps[(idx + 1) % steps.length] ?? 60;
      cfg.updatedAt = new Date();
      await cfg.save();
      return interaction.update(buildPanel(cfg, interaction.guild, `⏱️ Cooldown : **${cfg.cooldownSec}s** entre deux signalements.`));
    }

    if (id === 'sig_stats') {
      const recent = await Report.find({ guildId: interaction.guildId }).sort({ createdAt: -1 }).limit(500).lean();
      const byReason = {};
      for (const r of recent) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
      const top = Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const since24 = recent.filter(r => Date.now() - new Date(r.createdAt).getTime() < 86_400_000).length;
      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('📊 Statistiques des signalements')
        .setDescription(
          `**Total :** ${cfg.stats.total}  •  **24 dernières heures :** ${since24}`
          + `\n✅ Traités : **${cfg.stats.resolved}**  •  ❌ Rejetés : **${cfg.stats.rejected}**  •  ⏳ En attente : **${cfg.stats.pending}**`
          + (top.length ? `\n\n**Motifs les plus fréquents :**\n${top.map(([r, n]) => `${reasonLabel(r)} → **${n}**`).join('\n')}` : ''),
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (id === 'sig_list') {
      const pending = await Report.find({ guildId: interaction.guildId, status: 'pending' }).sort({ createdAt: -1 }).limit(15).lean();
      if (!pending.length) {
        return interaction.reply({ embeds: [infoEmbed('Aucun signalement en attente', 'Tout est traité 🎉')], ephemeral: true });
      }
      const embed = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle(`⏳ Signalements en attente (${pending.length})`)
        .setDescription(pending.map(r =>
          `**#${r._id.toString().slice(-6)}** — ${reasonLabel(r.reason)} — par ${cfg.anonymous ? '*anonyme*' : `<@${r.reporterId}>`} — <t:${Math.floor(new Date(r.createdAt).getTime() / 1000)}:R>`,
        ).join('\n'));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (id === 'sig_close') {
      return interaction.update({ embeds: [infoEmbed('Panneau fermé', 'Relancez `/signalement` pour le rouvrir.')], components: [] });
    }

    // ── Traitement d'un signalement (boutons du salon staff) ──────────────
    if (id.startsWith('sig_handle_') || id.startsWith('sig_reject_')) {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Seuls les membres pouvant gérer les messages peuvent traiter les signalements.')], ephemeral: true });
      }
      const reportId = id.replace('sig_handle_', '').replace('sig_reject_', '');
      const report = await Report.findById(reportId);
      if (!report) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Ce signalement n\'existe plus.')], ephemeral: true });
      if (report.status !== 'pending') {
        return interaction.reply({ embeds: [errorEmbed('Déjà traité', `Ce signalement a déjà été ${report.status === 'resolved' ? 'traité' : 'rejeté'} par <@${report.handledBy}>.`)], ephemeral: true });
      }
      const resolved = id.startsWith('sig_handle_');
      await setStatus(report, resolved ? 'resolved' : 'rejected', interaction.user.id, resolved ? 'traité' : 'rejeté');
      const confirm = new EmbedBuilder()
        .setColor(resolved ? COLORS.success : COLORS.error)
        .setTitle(resolved ? '✅ Signalement traité' : '🗑️ Signalement rejeté')
        .setDescription(`Par ${interaction.user} — motif : ${reasonLabel(report.reason)}`)
        .setTimestamp();
      await interaction.message.edit({ embeds: [buildStaffEmbed(report, interaction.guild, { anonymous: cfg.anonymous }).setColor(resolved ? COLORS.success : COLORS.error)], components: [] }).catch(() => {});
      return interaction.reply({ embeds: [confirm], ephemeral: true });
    }

    if (id.startsWith('sig_goto_')) {
      const report = await Report.findById(id.replace('sig_goto_', ''));
      if (!report?.contextUrl) return interaction.reply({ content: 'Aucun contexte disponible.', ephemeral: true });
      return interaction.reply({ content: report.contextUrl, ephemeral: true });
    }

    // Sanctions rapides depuis le salon staff
    if (id.startsWith('sig_ban_')) {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Vous devez pouvoir bannir des membres.')], ephemeral: true });
      }
      const report = await Report.findById(id.replace('sig_ban_', ''));
      if (!report?.targetId) return interaction.reply({ embeds: [errorEmbed('Impossible', 'Aucun membre visé par ce signalement.')], ephemeral: true });
      const target = await interaction.guild.members.fetch(report.targetId).catch(() => null);
      if (!target) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Ce membre n\'est plus sur le serveur.')], ephemeral: true });
      await target.ban({ reason: `Signalement #${report._id.toString().slice(-6)} — par ${interaction.user.tag}` }).catch(() => null);
      await setStatus(report, 'resolved', interaction.user.id, 'ban', 'Membre banni suite au signalement');
      await interaction.message.edit({ embeds: [buildStaffEmbed(report, interaction.guild, { anonymous: cfg.anonymous }).setColor(COLORS.success)], components: [] }).catch(() => {});
      return interaction.reply({ embeds: [successEmbed('Membre banni', `${target.user.tag} a été banni.`)], ephemeral: true });
    }

    if (id.startsWith('sig_warn_')) {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.ModerateMembers)) {
        return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Vous devez pouvoir avertir des membres.')], ephemeral: true });
      }
      const report = await Report.findById(id.replace('sig_warn_', ''));
      if (!report?.targetId) return interaction.reply({ embeds: [errorEmbed('Impossible', 'Aucun membre visé.')], ephemeral: true });
      const target = await interaction.guild.members.fetch(report.targetId).catch(() => null);
      if (!target) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Ce membre n\'est plus sur le serveur.')], ephemeral: true });
      await target.send({
        embeds: [new EmbedBuilder().setColor(COLORS.warning)
          .setTitle(`⚠️ Avertissement — ${interaction.guild.name}`)
          .setDescription(`Vous avez été averti par le staff suite à un signalement.\nMotif : **${reasonLabel(report.reason)}**\n\nMerci de respecter le règlement du serveur.`)],
      }).catch(() => {});
      await setStatus(report, 'resolved', interaction.user.id, 'warn', 'Avertissement envoyé au membre');
      await interaction.message.edit({ embeds: [buildStaffEmbed(report, interaction.guild, { anonymous: cfg.anonymous }).setColor(COLORS.success)], components: [] }).catch(() => {});
      return interaction.reply({ embeds: [successEmbed('Membre averti', `${target.user.tag} a reçu un avertissement en MP.`)], ephemeral: true });
    }

    // ── Bouton PUBLIC « Signaler » (persistant) → étape 1 : le motif ──────
    if (id.startsWith('sig_open_')) {
      return interaction.reply(buildReasonMenu(null, null));
    }

    throw new Error(`SIGNALEMENT_UNKNOWN_BUTTON:${id}`);
  },

  // ── Menus du panneau ─────────────────────────────────────────────────────────
  async handleSelect(interaction) {
    const id = interaction.customId;
    const cfg = await Config.findOne({ guildId: interaction.guildId });
    if (!cfg) return;

    if (id === 'sigs_types') {
      const chosen = interaction.values;
      cfg.types.member = chosen.includes('member');
      cfg.types.message = chosen.includes('message');
      cfg.updatedAt = new Date();
      await cfg.save();
      return interaction.update(buildPanel(cfg, interaction.guild, '🧩 Types mis à jour.'));
    }

    if (id === 'sigs_roles') {
      cfg.rolesAllowed = interaction.values;
      cfg.updatedAt = new Date();
      await cfg.save();
      return interaction.update(buildPanel(cfg, interaction.guild,
        cfg.rolesAllowed.length ? `🔐 Restreint aux rôles : ${cfg.rolesAllowed.map(r => `<@&${r}>`).join(', ')}` : '🔐 Ouvert à tout le monde.'));
    }

    if (id === 'sigs_cooldown') {
      cfg.cooldownSec = parseInt(interaction.values[0], 10);
      cfg.updatedAt = new Date();
      await cfg.save();
      return interaction.update(buildPanel(cfg, interaction.guild, `⏱️ Cooldown : **${cfg.cooldownSec}s**.`));
    }

    if (id === 'sigs_log') {
      cfg.logChannelId = interaction.values[0];
      cfg.updatedAt = new Date();
      await cfg.save();
      return interaction.update(buildPanel(cfg, interaction.guild, `📥 Les signalements arriveront dans <#${cfg.logChannelId}>.`));
    }

    if (id === 'sigs_public') {
      const channelId = interaction.values[0];
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) {
        return interaction.reply({ embeds: [errorEmbed('Salon introuvable', 'Impossible d\'accéder à ce salon.')], ephemeral: true });
      }
      if (!cfg.enabled) {
        return interaction.reply({ embeds: [errorEmbed('Système désactivé', 'Activez d\'abord le système avec le bouton ⚡, puis publiez le bouton « Signaler ».')], ephemeral: true });
      }
      const embed = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle('🚨 Signaler un problème')
        .setDescription('Un membre enfreint le règlement ? Un message pose problème ?\nUtilisez le bouton ci-dessous pour alerter le staff en 30 secondes.\n\n*Le signalement est confidentiel — n\'abusez pas du système.*');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sig_open_generic').setLabel('Signaler').setEmoji('🚨').setStyle(ButtonStyle.Danger),
      );
      const msg = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
      if (!msg) return interaction.reply({ embeds: [errorEmbed('Échec', 'Je n\'ai pas pu envoyer le message (permissions ?).')], ephemeral: true });
      return interaction.reply({ embeds: [successEmbed('Bouton publié', `Le bouton « Signaler » est en place dans <#${channelId}> — [voir le message](${msg.url}).`)], ephemeral: true });
    }
  },

  // ── Modaux (étape 2 du signalement + signalement libre) ──────────────────────
  async handleModal(interaction, client) {
    const id = interaction.customId;
    if (!id.startsWith('sigm_submit')) return;

    const cfg = await Config.findOne({ guildId: interaction.guildId });
    if (!cfg || !cfg.enabled) {
      return interaction.reply({ embeds: [errorEmbed('Système indisponible', 'Le système de signalement est désactivé sur ce serveur.')], ephemeral: true });
    }

    // Permission selon rôles restreints
    if (cfg.rolesAllowed.length) {
      const roleCache = interaction.member?.roles?.cache;
      const memberRoleIds = roleCache ? [...roleCache.keys()] : [];
      if (!cfg.rolesAllowed.some(r => memberRoleIds.includes(r))) {
        return interaction.reply({ embeds: [errorEmbed('Non autorisé', 'Seuls certains rôles peuvent signaler sur ce serveur.')], ephemeral: true });
      }
    }

    // Cooldown anti-spam
    const ck = `${interaction.guildId}:${interaction.user.id}`;
    const last = COOLDOWNS.get(ck) || 0;
    if (Date.now() - last < cfg.cooldownSec * 1000) {
      const wait = Math.ceil((cfg.cooldownSec * 1000 - (Date.now() - last)) / 1000);
      return interaction.reply({ embeds: [errorEmbed('Trop de signalements', `Attendez **${wait}s** avant de signaler à nouveau.`)], ephemeral: true });
    }
    COOLDOWNS.set(ck, Date.now());

    const parts = id.split('_'); // sigm_submit_<motif>[_<targetId>|_libre][_<messageId>]
    const reason = REASONS.some(r => r.value === parts[2]) ? parts[2] : 'autre';
    const rest = parts.slice(3);
    const targetId = rest[0] && rest[0] !== 'libre' ? rest[0] : null;
    const messageId = rest[1] || null;
    const details = interaction.fields.getTextInputValue('sigm_details') || '';
    const proof = (interaction.fields.getTextInputValue('sigm_proof') || '').trim();

    const report = await Report.create({
      guildId: interaction.guildId,
      reporterId: interaction.user.id,
      targetId,
      targetType: messageId ? 'message' : targetId ? 'member' : 'free',
      reason,
      details,
      proofUrl: proof,
      messageId,
      channelId: interaction.channelId,
      contextUrl: messageId && interaction.channelId
        ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${messageId}`
        : '',
    });

    cfg.stats.total += 1;
    cfg.stats.pending += 1;
    cfg.updatedAt = new Date();
    await cfg.save().catch(() => {});

    const staffMsg = await deliverToStaff(client, report, interaction.guild, cfg);

    const confirm = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('🚨 Signalement envoyé')
      .setDescription('Merci ! Le staff a reçu votre signalement et le traitera dès que possible.\n\n*Faux signalements répétés = sanctions.*');
    await interaction.reply({ embeds: [confirm], ephemeral: true }).catch(async () => {
      // Depuis un modal ouvert en MP (pas de salon) : fallback followUp
      await interaction.followUp?.({ embeds: [confirm], ephemeral: true }).catch(() => {});
    });

    if (cfg.autoAlertUser) {
      await interaction.user.send({
        embeds: [new EmbedBuilder().setColor(COLORS.info)
          .setTitle(`📨 Signalement reçu — ${interaction.guild.name}`)
          .setDescription(`Motif : **${reasonLabel(reason)}**\n${staffMsg ? 'Votre signalement a bien été transmis au staff.' : '⚠️ Le salon des signalements est introuvable — contactez un admin.'}`)],
      }).catch(() => {});
    }
  },

  // ── Menu « motif » de l'étape 1 (customId : sigr_m_<target>[_<msg>] | sigr_libre) ──
  async handleReasonMenu(interaction) {
    const id = interaction.customId;
    const reasonValue = interaction.values[0];
    if (!REASONS.some(r => r.value === reasonValue)) {
      return interaction.update({ content: '❌ Motif invalide.', embeds: [], components: [] }).catch(() => {});
    }

    let targetId = null;
    let messageId = null;
    if (id.startsWith('sigr_m_')) {
      const rest = id.slice('sigr_m_'.length);
      const seg = rest.split('_');
      targetId = seg[0] || null;
      messageId = seg[1] || null;
    }

    const { modal } = buildDetailsModal(reasonValue, targetId, messageId);
    return interaction.showModal(modal);
  },

  // Exposés pour les tests
  _internal: { buildPanel, buildDetailsModal, buildReasonMenu, buildStaffEmbed, buildStaffRow, reasonLabel, REASONS },
};
