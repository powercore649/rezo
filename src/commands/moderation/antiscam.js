'use strict';
// commands/antiscam.js — Centre anti-scam REZO (v2) : panel avancé.
//
// Deux systèmes coopèrent, tous deux gérés ici :
//   1. RÉSEAU D'ALERTES — abonnement du serveur (réception des scams validés
//      sur tous les serveurs REZO), salon d'alertes, filtre de types, seuil de
//      votes, salon de validation des signalements locaux (formulaire /scam).
//   2. SCAN D'IMAGES OCR (hérité, conservé) — détection d'arnaques par image
//      via antiScamScan.js (moteur utils/antiScam.js, inchangé).
//
// Routage persistant `_asc_` (boutons/menus) + `ascm_` (modaux) via
// interactionCreate.js, comme /honeypot et /antiraid. Sous-vues navigables :
// réseau, validation, scan d'images, exemptions, stats.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, PermissionFlagsBits, ChannelType,
} = require('discord.js');
const ScamAlertConfig = require('../../models/ScamAlertConfig');
const { ScamAlert } = require('../../models/ScamAlert');
const AntiScamConfig = require('../../models/AntiScamConfig');const { TYPE_INFO, typeLabel, buildAlertEmbed, } = require('../../utils/scamAlertActions');
const { RULES, CATEGORY_TO_CONFIG_FLAG, KEYWORDS_RULES, analyzeText, scanMessage } = require('../../utils/antiScam');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

const ACTION_LABELS = {
  none: 'Aucune (alerte uniquement)',
  warn: '⚠️ Avertissement',
  mute: '🔇 Mute temporaire',
  kick: '👢 Kick',
  ban:  '🔨 Ban',
};

const DURATIONS = [
  { label: '30 minutes', value: 30 },
  { label: '1 heure',    value: 60 },
  { label: '6 heures',   value: 360 },
  { label: '1 jour',     value: 1440 },
  { label: '7 jours',    value: 10080 },
];

async function getOrCreate(guildId) {
  let cfg = await ScamAlertConfig.findOne({ guildId });
  if (!cfg) cfg = await ScamAlertConfig.create({ guildId });
  return cfg;
}

async function getOrCreateOcr(guildId) {
  let cfg = await AntiScamConfig.findOne({ guildId });
  if (!cfg) cfg = await AntiScamConfig.create({ guildId });
  return cfg;
}

// ─── Embed principal ─────────────────────────────────────────────────────────
function buildPanelEmbed(cfg, ocr, stats) {
  const filterTxt = cfg.typeFilter.length
    ? cfg.typeFilter.map(t => typeLabel(t)).join(' · ')
    : '*Tous les types*';

  return new EmbedBuilder()
    .setColor(cfg.subscribed ? COLORS.error : COLORS.primary)
    .setTitle('🛡️ Centre anti-scam — Réseau d\'alertes REZO')
    .setDescription(
      'Le réseau d\'alertes scams connecte tous les serveurs REZO : quand un arnaqueur est signalé et validé ' +
      'sur un serveur, **tous les autres reçoivent l\'alerte** et votent pour confirmer. ' +
      'Les membres signalent avec `/scam` (formulaire public), le staff valide ici.\n\n' +
      '*(+ Détection de textes, liens et arnaques dans les messages.)*',
    )
    .addFields(
      { name: '📡 Réseau', value: cfg.subscribed ? '**Abonné** — alertes reçues' : '**Non abonné**', inline: true },
      { name: '🔔 Salon d\'alertes', value: cfg.scamChannelId ? `<#${cfg.scamChannelId}>` : '*Non défini*', inline: true },
      { name: '🗳️ Votes min.', value: `**${cfg.minVotes}**`, inline: true },
      { name: '📝 Signalements', value: cfg.reportsEnabled ? '**Ouverts** (`/scam`)' : '**Fermés**', inline: true },
      { name: '⚖️ Validation', value: cfg.autoApprove ? '**Auto** (publication directe)' : cfg.reviewChannelId ? `Salon : <#${cfg.reviewChannelId}>` : '*Salon non défini* ✏️', inline: true },
      { name: '⏱️ Cooldown', value: `**${cfg.cooldownMinutes}** min`, inline: true },
      { name: '🔎 Filtre de types', value: filterTxt, inline: false },
      { name: '📸 Scan d\'images', value: ocr.enabled ? `**Actif** — seuil ${ocr.threshold}% · action ${ACTION_LABELS[ocr.action]}` : '**Inactif**', inline: false },
      { name: '📊 Activité', value: `Alertes reçues : **${stats.alertsReceived}** · Signalements envoyés : **${stats.reportsSent}**\nDossiers du serveur : **${stats.totalReports}** (dont **${stats.approved}** validés, **${stats.pending}** en attente)`, inline: false },
    )
    .setFooter({ text: 'REZO • Centre anti-scam v2' })
    .setTimestamp();
}

// ─── Composants du panneau (règle Discord : un select = une rangée entière) ──
function buildPanelComponents(cfg) {
  // R1 — boutons d'état
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('_asc_network_toggle')
      .setLabel(cfg.subscribed ? 'Quitter le réseau' : 'Rejoindre le réseau')
      .setEmoji(cfg.subscribed ? '📡' : '🚀')
      .setStyle(cfg.subscribed ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('_asc_reports_toggle').setLabel(`Signalements : ${cfg.reportsEnabled ? 'OUVERTS' : 'FERMÉS'}`).setEmoji('📝').setStyle(cfg.reportsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('_asc_auto_toggle').setLabel(`Auto-approbation : ${cfg.autoApprove ? 'ON' : 'OFF'}`).setEmoji('⚡').setStyle(cfg.autoApprove ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  // R2 — types de scams reçus (menu seul, multi-select)
  const r2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('_asc_types')
      .setPlaceholder('🔎 Types de scams reçus (actuel : ' + (cfg.typeFilter.length ? `${cfg.typeFilter.length} sélectionné(s)` : 'tous') + ')')
      .setMinValues(0).setMaxValues(Object.keys(TYPE_INFO).length)
      .addOptions(Object.entries(TYPE_INFO).map(([value, info]) => ({
        label: info.label, value, emoji: info.emoji,
        default: cfg.typeFilter.includes(value),
      }))),
  );

  // R3 — seuil de votes (menu seul)
  const r3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('_asc_minvotes').setPlaceholder('🗳️ Votes minimum pour afficher une alerte…').addOptions(
      [1, 2, 3, 5, 10, 15, 20].map(n => ({ label: `${n} vote(s) « scam confirmé »`, value: String(n), default: cfg.minVotes === n })),
    ),
  );

  // R4 — salon d'alertes (menu seul)
  const r4 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('_asc_scamchannel')
      .setPlaceholder('🔔 Salon où recevoir les alertes du réseau…')
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(0).setMaxValues(1),
  );

  // R5 — navigation sous-vues
  const r5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('_asc_review_view').setLabel('Validation').setEmoji('⚖️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('_asc_pending_view').setLabel('Dossiers').setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('_asc_ocr_view').setLabel('Scan d\'images').setEmoji('📸').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('_asc_stats_view').setLabel('Statistiques').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('_asc_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  return [r1, r2, r3, r4, r5];
}

// ─── Sous-vue : validation des signalements locaux ───────────────────────────
function buildReviewView(cfg) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('⚖️ Validation des signalements')
      .setDescription(
        'Chaque signalement `/scam` arrive ici en **carte pending** avec deux boutons :\n' +
        '✅ **Valider & diffuser** → alerte envoyée à tous les serveurs abonnés\n' +
        '⛔ **Rejeter** → dossier archivé, aucune diffusion\n\n' +
        '**Auto-approbation ON** : publication immédiate sans validation (déconseillé — risque de faux signalements).',
      )
      .addFields(
        { name: 'Salon de validation', value: cfg.reviewChannelId ? `<#${cfg.reviewChannelId}>` : '*Non défini* — les signalements restent enregistrés mais non diffusés', inline: false },
        { name: 'Preuve obligatoire', value: cfg.requiredProof ? '✅ Oui' : '❌ Non', inline: true },
        { name: 'Cooldown', value: `${cfg.cooldownMinutes} min`, inline: true },
        { name: 'Bannis du formulaire', value: cfg.blacklistReporters.length ? cfg.blacklistReporters.map(id => `<@${id}>`).join(', ') : '*Aucun*', inline: false },
      )],
    components: [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId('_asc_reviewchannel')
          .setPlaceholder('⚖️ Salon où valider les signalements…')
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(0).setMaxValues(1),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('_asc_proof_toggle').setLabel(`Preuve requise : ${cfg.requiredProof ? 'ON' : 'OFF'}`).setEmoji('📎').setStyle(cfg.requiredProof ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('_asc_cooldown_modal').setLabel('Cooldown').setEmoji('⏱️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('_asc_back').setLabel('Retour au panneau').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}  // ─── Sous-vue : détection de textes / liens / arnaques ───────────────────────
  function buildDetectView(ocr) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(ocr.enabled ? COLORS.error : COLORS.primary)
      .setTitle('🔍 Détection d\'arnaques — texte, liens, mentions')
      .setDescription(
        'Analyse de tout le contenu des messages : texte, liens, mentions, snippets de preuves.\n' +
        'Le score de suspicion (0-100) déclenche l\'action choisie.',
      )
      .addFields(
        { name: 'État', value: ocr.enabled ? '**Activé**' : '**Désactivé**', inline: true },
        { name: 'Seuil', value: `**${ocr.threshold}%**`, inline: true },
        { name: 'Action', value: ACTION_LABELS[ocr.action], inline: true },
        { name: 'Durée mute', value: ocr.action === 'mute' ? `${ocr.muteDuration} min` : '—', inline: true },
        { name: 'Suppr. message', value: ocr.deleteMessage ? '✅ Oui' : '❌ Non', inline: true },
        { name: 'Salon d\'alerte', value: ocr.logChannelId ? `<#${ocr.logChannelId}>` : '*Aucun*', inline: true },
        { name: 'Catégories', value: `🪙 Crypto ${ocr.detectCrypto ? '✅' : '❌'} · ⏰ Urgence ${ocr.detectUrgency ? '✅' : '❌'}\n🎭 Usurpation ${ocr.detectImpersonation ? '✅' : '❌'} · 💰 Financier ${ocr.detectFinancial ? '✅' : '❌'}`, inline: false },
        { name: 'Mots-clés personnalisés', value: ocr.customKeywords.length ? ocr.customKeywords.map(k => `\`${k}\``).join(', ') : '*Aucun*', inline: false },
        { name: 'Stats', value: `${ocr.totalScanned} image(s) scannée(s) · ${ocr.totalDetected} détection(s)`, inline: false },
      )],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('_asc_ocr_toggle').setLabel(ocr.enabled ? 'Désactiver' : 'Activer').setEmoji(ocr.enabled ? '🔴' : '🟢').setStyle(ocr.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('_asc_ocr_delete_toggle').setLabel(`Suppr. message : ${ocr.deleteMessage ? 'ON' : 'OFF'}`).setEmoji('🗑️').setStyle(ocr.deleteMessage ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('_asc_ocr_settings').setLabel('Seuil & action').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('_asc_ocr_cats').setPlaceholder('🧩 Catégories de détection…').setMinValues(0).setMaxValues(4).addOptions(
          [
            { value: 'crypto', label: 'Crypto / faux giveaways', emoji: '🪙' },
            { value: 'urgency', label: 'Incitation à l\'action / urgence', emoji: '⏰' },
            { value: 'impersonation', label: 'Usurpation de marque', emoji: '🎭' },
            { value: 'financial', label: 'Propositions financières', emoji: '💰' },
          ].map(o => ({ ...o, default: ocr[`detect${o.value[0].toUpperCase()}${o.value.slice(1)}`] !== false })),
        ),
      ),
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId('_asc_ocr_logchannel')
          .setPlaceholder('🔔 Salon d\'alerte du scan d\'images…')
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(0).setMaxValues(1),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('_asc_ocr_keywords_modal').setLabel('Mots-clés personnalisés').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('_asc_ocr_exempt_view').setLabel('Exemptions').setEmoji('🛂').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('_asc_back').setLabel('Retour au panneau').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ─── Sous-vue : exemptions du scan d'images ──────────────────────────────────
function buildExemptView(ocr) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('🛂 Exemptions du scan d\'images')
      .setDescription(
        `**Rôles exemptés (${ocr.exemptRoles.length}) :** ${ocr.exemptRoles.length ? ocr.exemptRoles.map(r => `<@&${r}>`).join(' · ') : '*aucun*'}\n` +
        `**Salons exemptés (${ocr.exemptChannels.length}) :** ${ocr.exemptChannels.length ? ocr.exemptChannels.map(c => `<#${c}>`).join(' · ') : '*aucun*'}`,
      )],
    components: [
      ...(ocr.exemptRoles.length ? [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('_asc_ocr_exempt_roles_remove').setPlaceholder('➖ Retirer un rôle exempté…').setMinValues(1)
          .setMaxValues(Math.min(ocr.exemptRoles.length, 25))
          .addOptions(ocr.exemptRoles.slice(0, 25).map(id => ({ label: `Rôle ${id}`, value: id }))),
      )] : []),
      ...(ocr.exemptChannels.length ? [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('_asc_ocr_exempt_channels_remove').setPlaceholder('➖ Retirer un salon exempté…').setMinValues(1)
          .setMaxValues(Math.min(ocr.exemptChannels.length, 25))
          .addOptions(ocr.exemptChannels.slice(0, 25).map(id => ({ label: `Salon ${id}`, value: id }))),
      )] : []),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('_asc_ocr_exempt_add').setLabel('Ajouter…').setEmoji('➕').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('_asc_ocr_view').setLabel('Retour scan d\'images').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function buildStatsView(guildId) {
  const [total, pending, approved, rejected, byType, recent] = await Promise.all([
    ScamAlert.countDocuments({ sourceGuildId: guildId }).catch(() => 0),
    ScamAlert.countDocuments({ sourceGuildId: guildId, status: 'pending' }).catch(() => 0),
    ScamAlert.countDocuments({ sourceGuildId: guildId, status: 'approved' }).catch(() => 0),
    ScamAlert.countDocuments({ sourceGuildId: guildId, status: 'rejected' }).catch(() => 0),
    ScamAlert.aggregate([{ $match: { sourceGuildId: guildId } }, { $group: { _id: '$type', count: { $sum: 1 } } }]).catch(() => []),
    ScamAlert.find({ sourceGuildId: guildId }).sort({ createdAt: -1 }).limit(5).lean().catch(() => []),
  ]);

  const typeLines = byType.length
    ? byType.map(t => `${typeLabel(t._id)} : **${t.count}**`).join('\n')
    : '*Aucun signalement*';
  const recentLines = recent.length
    ? recent.map(r => {
        const st = { pending: '🟡', approved: '✅', rejected: '⛔' }[r.status] || '🟡';
        return `${st} ${typeLabel(r.type)} — **${r.name}** <t:${Math.floor(new Date(r.createdAt).getTime() / 1000)}:R>`;
      }).join('\n')
    : '*Aucun*';

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📊 Anti-scam — Statistiques du serveur')
    .addFields(
      { name: 'Dossiers', value: `Total : **${total}**\n🟡 En attente : **${pending}**\n✅ Validés : **${approved}**\n⛔ Rejetés : **${rejected}**`, inline: true },
      { name: 'Par type', value: typeLines, inline: true },
      { name: 'Derniers signalements', value: recentLines, inline: false },
    )
    .setFooter({ text: 'REZO • Centre anti-scam v2' })
    .setTimestamp();
}

async function refreshPanel(interaction) {
  const cfg = await getOrCreate(interaction.guild.id);
  const ocr = await getOrCreateOcr(interaction.guild.id);
  const stats = {
    alertsReceived: cfg.alertsReceived,
    reportsSent: cfg.reportsSent,
    totalReports: await ScamAlert.countDocuments({ sourceGuildId: interaction.guild.id }).catch(() => 0),
    approved: await ScamAlert.countDocuments({ sourceGuildId: interaction.guild.id, status: 'approved' }).catch(() => 0),
    pending: await ScamAlert.countDocuments({ sourceGuildId: interaction.guild.id, status: 'pending' }).catch(() => 0),
  };
  return interaction.update({ embeds: [buildPanelEmbed(cfg, ocr, stats)], components: buildPanelComponents(cfg) });
}

// ═════════════════════════════════════════════════════════════════════════════
const authGate = require('../../utils/authGate');

module.exports = {
  getOrCreate,
  getOrCreateOcr,
  buildPanelEmbed,
  buildPanelComponents,

  data: new SlashCommandBuilder()
    .setName('antiscam')
    .setDescription('🛡️ Centre anti-scam : réseau d\'alertes scams + scan d\'images OCR')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);
    const ocr = await getOrCreateOcr(interaction.guild.id);
    const stats = {
      alertsReceived: cfg.alertsReceived,
      reportsSent: cfg.reportsSent,
      totalReports: await ScamAlert.countDocuments({ sourceGuildId: interaction.guild.id }).catch(() => 0),
      approved: await ScamAlert.countDocuments({ sourceGuildId: interaction.guild.id, status: 'approved' }).catch(() => 0),
      pending: await ScamAlert.countDocuments({ sourceGuildId: interaction.guild.id, status: 'pending' }).catch(() => 0),
    };

    const reply = await interaction.reply({
      embeds: [buildPanelEmbed(cfg, ocr, stats)],
      components: buildPanelComponents(cfg),
      ephemeral: true,
      fetchReply: true,
    });

    // Collecteur interne 10 min ; les ids `_asc_` restent routés en persistant
    const col = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 10 * 60 * 1000 });
    col.on('collect', () => {});
    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Boutons & actions du panel (collecteur + routage persistant `_asc_`) ─
  async handleButton(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Centre anti-scam' }))) return;
    const id = interaction.customId;
    const cfg = await getOrCreate(interaction.guild.id);

    const needScamChannel = async () => {
      if (!cfg.scamChannelId) {
        await interaction.reply({
          embeds: [errorEmbed('Salon d\'alertes requis', 'Choisis d\'abord un **salon d\'alertes** (menu « 🔔 Salon où recevoir les alertes ») avant de rejoindre le réseau.')],
          ephemeral: true,
        }).catch(() => {});
        return false;
      }
      return true;
    };

    // ── Réseau ───────────────────────────────────────────────────────────
    if (id === '_asc_network_toggle') {
      if (!cfg.subscribed && !(await needScamChannel())) return;
      cfg.subscribed = !cfg.subscribed;
      await cfg.save();
      return refreshPanel(interaction);
    }

    if (id === '_asc_reports_toggle') {
      cfg.reportsEnabled = !cfg.reportsEnabled;
      await cfg.save();
      return refreshPanel(interaction);
    }

    if (id === '_asc_auto_toggle') {
      cfg.autoApprove = !cfg.autoApprove;
      await cfg.save();
      return refreshPanel(interaction);
    }

    if (id === '_asc_refresh') return refreshPanel(interaction);
    if (id === '_asc_back') return refreshPanel(interaction);

    // ── Sous-vues ────────────────────────────────────────────────────────
    if (id === '_asc_review_view') return interaction.update(buildReviewView(cfg));

    if (id === '_asc_proof_toggle') {
      cfg.requiredProof = !cfg.requiredProof;
      await cfg.save();
      return interaction.update(buildReviewView(cfg));
    }

    if (id === '_asc_cooldown_modal') {
      const modal = new ModalBuilder().setCustomId('ascm_cooldown').setTitle('Cooldown anti-spam des signalements');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('asc_cooldown').setLabel('Minutes entre 2 signalements (0 = aucun)')
          .setStyle(TextInputStyle.Short).setValue(String(cfg.cooldownMinutes)).setMaxLength(4).setRequired(true),
      ));
      return interaction.showModal(modal);
    }

    if (id === '_asc_ocr_view') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      return interaction.update(buildDetectView(ocr));
    }

    if (id === '_asc_ocr_toggle') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      ocr.enabled = !ocr.enabled;
      await ocr.save();
      return interaction.update(buildDetectView(ocr));
    }

    if (id === '_asc_ocr_delete_toggle') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      ocr.deleteMessage = !ocr.deleteMessage;
      await ocr.save();
      return interaction.update(buildDetectView(ocr));
    }

    if (id === '_asc_ocr_settings') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      const modal = new ModalBuilder().setCustomId('ascm_ocr_settings').setTitle('Scan d\'images — seuil & action');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('asc_threshold').setLabel('Seuil de suspicion 0-100 (défaut 60)')
            .setStyle(TextInputStyle.Short).setValue(String(ocr.threshold)).setMaxLength(3).setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('asc_action').setLabel('Action : none / warn / mute / kick / ban')
            .setStyle(TextInputStyle.Short).setValue(ocr.action).setMaxLength(10).setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('asc_mutedur').setLabel('Durée du mute en minutes (si action = mute)')
            .setStyle(TextInputStyle.Short).setValue(String(ocr.muteDuration)).setMaxLength(6).setRequired(false),
        ),
      );
      return interaction.showModal(modal);
    }

    if (id === '_asc_ocr_keywords_modal') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      const modal = new ModalBuilder().setCustomId('ascm_ocr_keywords').setTitle('Mots-clés personnalisés du scan');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('asc_keywords').setLabel('Mots-clés séparés par des virgules')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(ocr.customKeywords.join(', ').slice(0, 1000) || '')
          .setMaxLength(1000).setRequired(false),
      ));
      return interaction.showModal(modal);
    }

    if (id === '_asc_ocr_exempt_view') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      return interaction.update(buildExemptView(ocr));
    }

    if (id === '_asc_ocr_exempt_add') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      // Réutilise la vue exemptions avec un modal de sélection par ID
      const modal = new ModalBuilder().setCustomId('ascm_ocr_exempt_add').setTitle('Ajouter une exemption');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('asc_exempt_roles').setLabel('IDs de rôles (séparés par des espaces)')
            .setStyle(TextInputStyle.Short).setValue('').setMaxLength(400).setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('asc_exempt_channels').setLabel('IDs de salons (séparés par des espaces)')
            .setStyle(TextInputStyle.Short).setValue('').setMaxLength(400).setRequired(false),
        ),
      );
      return interaction.showModal(modal);
    }

    if (id === '_asc_stats_view') {
      return interaction.update({ embeds: [await buildStatsView(interaction.guild.id)], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('_asc_back').setLabel('Retour au panneau').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      )] });
    }

    // ── Vue des dossiers en attente ──────────────────────────────────────
    if (id === '_asc_pending_view') {
      const pendingDocs = await ScamAlert.find({ sourceGuildId: interaction.guild.id, status: 'pending' })
        .sort({ createdAt: -1 }).limit(10).lean().catch(() => []);
      const e = new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle('🗂️ Dossiers en attente de validation')
        .setDescription(pendingDocs.length
          ? 'Sélectionne un dossier ci-dessous pour le valider ou le rejeter.'
          : '*Aucun dossier en attente.* Tout est traité ! ✨');
      pendingDocs.forEach((d, idx) => e.addFields({
        name: `#${idx + 1} • ${typeLabel(d.type)} — ${d.name}`,
        value: `Par **${d.reporterTag}** <t:${Math.floor(new Date(d.createdAt).getTime() / 1000)}:R>\n${(d.details || '*sans détail*').slice(0, 120)}`,
      }));
      const rows = [];
      if (pendingDocs.length) {
        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('_asc_pending_pick').setPlaceholder('🗂️ Choisir un dossier à traiter…').setMinValues(1).setMaxValues(1)
            .addOptions(pendingDocs.map((d, idx) => ({
              label: `${d.name} — ${TYPE_INFO[d.type]?.label || d.type}`.slice(0, 100),
              description: `Par ${d.reporterTag}`.slice(0, 100),
              value: String(d._id),
              emoji: TYPE_INFO[d.type]?.emoji || '❓',
            }))),
        ));
      }
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('_asc_back').setLabel('Retour au panneau').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
      ));
      return interaction.update({ embeds: [e], components: rows });
    }

    // Ouverture d'un dossier depuis le select (carte + boutons décision)
    if (id === '_asc_pending_pick') {
      const alert = await ScamAlert.findById(interaction.values[0]).catch(() => null);
      if (!alert) {
        return interaction.reply({ embeds: [errorEmbed('Dossier introuvable', 'Ce signalement a été supprimé.')], ephemeral: true }).catch(() => {});
      }
      return interaction.reply({
        embeds: [buildAlertEmbed(alert)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`scamv_approve_${alert._id}`).setLabel('Valider & diffuser').setStyle(ButtonStyle.Success).setEmoji('✅'),
          new ButtonBuilder().setCustomId(`scamv_reject_${alert._id}`).setLabel('Rejeter').setStyle(ButtonStyle.Danger).setEmoji('⛔'),
        )],
        ephemeral: true,
      }).catch(() => {});
    }
  },

  // ─── Menus du panel (routage persistant `_asc_`) ─────────────────────────
  async handleSelect(interaction) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Centre anti-scam' }))) return;
    const id = interaction.customId;
    const cfg = await getOrCreate(interaction.guild.id);

    if (id === '_asc_types') {
      // Liste vide = tous les types
      cfg.typeFilter = interaction.values;
      await cfg.save();
      return refreshPanel(interaction);
    }

    if (id === '_asc_minvotes') {
      cfg.minVotes = parseInt(interaction.values[0], 10) || 3;
      await cfg.save();
      return refreshPanel(interaction);
    }

    if (id === '_asc_scamchannel') {
      cfg.scamChannelId = interaction.values[0] || null;
      await cfg.save();
      return refreshPanel(interaction);
    }

    if (id === '_asc_reviewchannel') {
      cfg.reviewChannelId = interaction.values[0] || null;
      await cfg.save();
      return interaction.update(buildReviewView(cfg));
    }

    if (id === '_asc_ocr_cats') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      // values contient les catégories cochées ; les non cochées passent à false
      const map = { crypto: 'detectCrypto', urgency: 'detectUrgency', impersonation: 'detectImpersonation', financial: 'detectFinancial' };
      for (const [key, field] of Object.entries(map)) ocr[field] = interaction.values.includes(key);
      await ocr.save();
      return interaction.update(buildDetectView(ocr));
    }

    if (id === '_asc_ocr_logchannel') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      ocr.logChannelId = interaction.values[0] || null;
      await ocr.save();
      return interaction.update(buildDetectView(ocr));
    }

    if (id === '_asc_ocr_exempt_roles_remove') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      ocr.exemptRoles = ocr.exemptRoles.filter(r => !interaction.values.includes(r));
      await ocr.save();
      return interaction.update(buildExemptView(ocr));
    }

    if (id === '_asc_ocr_exempt_channels_remove') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      ocr.exemptChannels = ocr.exemptChannels.filter(c => !interaction.values.includes(c));
      await ocr.save();
      return interaction.update(buildExemptView(ocr));
    }
  },

  // ─── Modaux du panel (routage persistant `ascm_`) ─────────────────────────
  async handleModal(interaction) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Centre anti-scam' }))) return;
    const cfg = await getOrCreate(interaction.guild.id);

    if (interaction.customId === 'ascm_cooldown') {
      const v = parseInt(interaction.fields.getTextInputValue('asc_cooldown'), 10);
      cfg.cooldownMinutes = Math.max(0, Math.min(1440, Number.isNaN(v) ? cfg.cooldownMinutes : v));
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Cooldown mis à jour', `${cfg.cooldownMinutes} minute(s) entre deux signalements.`)], ephemeral: true });
    }

    if (interaction.customId === 'ascm_ocr_settings') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      const th = parseInt(interaction.fields.getTextInputValue('asc_threshold'), 10);
      if (!Number.isNaN(th)) ocr.threshold = Math.max(0, Math.min(100, th));
      const action = interaction.fields.getTextInputValue('asc_action').toLowerCase().trim();
      if (['none', 'warn', 'mute', 'kick', 'ban'].includes(action)) ocr.action = action;
      const dur = parseInt(interaction.fields.getTextInputValue('asc_mutedur'), 10);
      if (!Number.isNaN(dur) && dur > 0) ocr.muteDuration = Math.min(40320, dur);
      await ocr.save();
      return interaction.reply({ embeds: [successEmbed('Scan d\'images mis à jour', `Seuil : **${ocr.threshold}%** · Action : **${ACTION_LABELS[ocr.action]}**${ocr.action === 'mute' ? ` (${ocr.muteDuration} min)` : ''}`)], ephemeral: true });
    }

    if (interaction.customId === 'ascm_ocr_keywords') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      const raw = interaction.fields.getTextInputValue('asc_keywords') || '';
      ocr.customKeywords = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 50);
      await ocr.save();
      return interaction.reply({ embeds: [successEmbed('Mots-clés mis à jour', ocr.customKeywords.length ? ocr.customKeywords.map(k => `\`${k}\``).join(', ') : '*Aucun mot-clé*')], ephemeral: true });
    }

    if (interaction.customId === 'ascm_ocr_exempt_add') {
      const ocr = await getOrCreateOcr(interaction.guild.id);
      const parseIds = (s) => (s || '').match(/\d{5,25}/g) || [];
      const roles = parseIds(interaction.fields.getTextInputValue('asc_exempt_roles'));
      const chans = parseIds(interaction.fields.getTextInputValue('asc_exempt_channels'));
      ocr.exemptRoles = Array.from(new Set([...ocr.exemptRoles, ...roles]));
      ocr.exemptChannels = Array.from(new Set([...ocr.exemptChannels, ...chans]));
      await ocr.save();
      return interaction.reply({ embeds: [successEmbed('Exemptions ajoutées', `${roles.length} rôle(s) · ${chans.length} salon(s)`)], ephemeral: true });
    }
  },

  // ─── Cartes de validation (boutons scamv_approve_/scamv_reject_) ──────────
  async handleDecision(interaction, client) {
    const alertId = interaction.customId.replace(/^scamv_(?:approve|reject)_/, '');
    const alert = await ScamAlert.findById(alertId).catch(() => null);
    if (!alert) {
      return interaction.reply({ embeds: [errorEmbed('Dossier introuvable', 'Ce signalement n\'existe plus.')], ephemeral: true }).catch(() => {});
    }
    if (alert.status !== 'pending') {
      return interaction.reply({ embeds: [errorEmbed('Déjà traité', `Ce dossier a déjà été **${alert.status === 'approved' ? 'validé' : 'rejeté'}**.`)], ephemeral: true }).catch(() => {});
    }

    const { approveAndBroadcast, rejectAlert } = require('../../utils/scamAlertActions');

    if (interaction.customId.startsWith('scamv_approve_')) {
      const reached = await approveAndBroadcast(client, alert, { approver: interaction.user });
      return interaction.update({
        embeds: [buildAlertEmbed(alert)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`scamv_broadcast_${alert._id}`).setLabel(`Diffusé à ${reached} serveur(s)`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        )],
      }).catch(() => {});
    }

    await rejectAlert(alert, interaction.user);
    return interaction.update({
      embeds: [buildAlertEmbed(alert)],
      components: [],
    }).catch(() => {});
  },
};
