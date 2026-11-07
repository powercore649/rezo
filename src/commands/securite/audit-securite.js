'use strict';
// commands/securite/audit-securite.js — Audit de sécurité du serveur.
//
// Passe le serveur au crible (permissions, bots, rôles, modules de protection,
// sauvegardes, webhooks), rend un score sur 100 avec les points à corriger et
// propose les correctifs applicables en un clic.
//
// La notation est pure (utils/securityAudit.js) ; ce fichier ne fait que
// collecter les faits et afficher le rapport.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { buildAuditReport, scoreBar, severityLabel } = require('../../utils/securityAudit');

// Permissions dont la présence sur un rôle de confiance est une porte ouverte.
const DANGEROUS_FLAGS = ['ManageRoles', 'ManageChannels', 'ManageWebhooks', 'ManageGuild'];

const FIX_LABELS = {
  verification: 'Niveau de vérification',
  mfa: '2FA du staff',
  content_filter: 'Filtre de contenu',
  notifications: 'Notifications',
};

// ─── Collecte des faits (impur : c'est ici que le serveur est interrogé) ─────
async function collectGuildFacts(guild, configs = {}) {
  const { antiNuke = null, antiraid = null, captcha = null, automod = null, honeypotCount = 0, backupAt = null } = configs;
  const me = guild.members.me;
  const everyone = guild.roles.everyone;

  const everyoneDangerousPerms = DANGEROUS_FLAGS
    .filter(name => everyone.permissions.has(PermissionFlagsBits[name]))
    .concat(everyone.permissions.has(PermissionFlagsBits.Administrator) ? ['Administrateur'] : []);

  const roles = [...guild.roles.cache.values()].filter(r => r.id !== guild.id);
  const adminRoles = roles.filter(r => !r.managed && r.permissions.has(PermissionFlagsBits.Administrator)).map(r => r.name);
  const dangerousRoleCount = roles.filter(
    r => !r.managed && DANGEROUS_FLAGS.some(name => r.permissions.has(PermissionFlagsBits[name])),
  ).length;

  // Le cache des membres peut être partiel : on le complète seulement si le
  // serveur est assez petit pour que ce soit raisonnable.
  if (guild.memberCount <= 1000 && guild.members.cache.size < guild.memberCount) {
    await guild.members.fetch().catch(() => null);
  }
  const adminMembers = [...guild.members.cache.values()]
    .filter(m => !m.user.bot && m.permissions.has(PermissionFlagsBits.Administrator))
    .map(m => `${m.user.tag}`);
  const adminBots = [...guild.members.cache.values()]
    .filter(m => m.user.bot && m.id !== me?.id && m.permissions.has(PermissionFlagsBits.Administrator))
    .map(m => m.user.username);

  const webhooks = await guild.fetchWebhooks().catch(() => null);
  const backupAgeDays = backupAt
    ? Math.floor((Date.now() - new Date(backupAt).getTime()) / 86_400_000)
    : null;

  return {
    guildName: guild.name,
    verificationLevel: guild.verificationLevel,
    mfaLevel: guild.mfaLevel,
    explicitContentFilter: guild.explicitContentFilter,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    everyoneDangerousPerms,
    adminRoles,
    adminMembers,
    adminBots,
    dangerousRoleCount,
    webhookCount: webhooks?.size ?? 0,
    backupAgeDays,
    modules: {
      antiNuke: Boolean(antiNuke?.enabled),
      antiraid: Boolean(antiraid?.enabled),
      captcha: Boolean(captcha?.enabled),
      automod: Boolean(automod && (automod.spamEnabled || automod.raidEnabled || automod.linksEnabled || automod.capsEnabled)),
      honeypot: honeypotCount > 0,
      logChannel: Boolean(antiNuke?.logChannelId || antiraid?.logChannelId || automod?.logChannelId),
    },
  };
}

// ─── Lecture des modules de sécurité en base ─────────────────────────────────
async function loadSecurityState(guildId) {
  const AntiNuke = require('../../models/AntiNuke');
  const { AntiRaid, AntiRaidHoneypot } = require('../../models/AntiRaid');
  const { CaptchaConfig } = require('../../models/Captcha');
  const AutoMod = require('../../models/AutoMod');
  const Honeypot = require('../../models/Honeypot');
  const ServerBackup = require('../../models/ServerBackup');

  const [antiNuke, antiraid, captcha, automod, hpA, hpB, backup] = await Promise.all([
    AntiNuke.findOne({ guildId }).lean().catch(() => null),
    AntiRaid.findOne({ guildId }).lean().catch(() => null),
    CaptchaConfig.findOne({ guildId }).lean().catch(() => null),
    AutoMod.findOne({ guildId }).lean().catch(() => null),
    AntiRaidHoneypot.countDocuments({ guildId }).catch(() => 0),
    Honeypot.countDocuments({ guildId }).catch(() => 0),
    ServerBackup.findOne({ guildId }).sort({ createdAt: -1 }).lean().catch(() => null),
  ]);

  return {
    antiNuke, antiraid, captcha, automod,
    honeypotCount: (hpA || 0) + (hpB || 0),
    backupAt: backup?.createdAt || null,
  };
}

// ─── Rapport ─────────────────────────────────────────────────────────────────
function buildReportEmbed(report, guild) {
  const failedFields = report.checks
    .filter(c => !c.ok)
    .map(c => ({
      name: `${severityLabel(c.severity)} — ${c.label}`,
      value: c.advice + (c.details?.length ? `\n${c.details.slice(0, 10).map(d => `• ${d}`).join('\n')}` : ''),
      inline: false,
    }));

  const okLabels = report.checks.filter(c => c.ok).map(c => `✅ ${c.label}`);

  const embed = new EmbedBuilder()
    .setColor(report.score >= 90 ? COLORS.success : report.score >= 55 ? COLORS.warning : COLORS.error)
    .setTitle(`${report.emoji} Audit de sécurité — ${guild.name}`)
    .setDescription(
      `\`${scoreBar(report.score)}\` **${report.score}/100** — ${report.grade}\n` +
      `> ${report.advice}\n` +
      `> **${report.passed}/${report.total}** point(s) conforme(s) · **${report.failed.length}** à corriger (classés par gravité).`,
    )
    .addFields(failedFields.length ? failedFields : [{ name: '🎉 Aucun point à corriger', value: 'Tous les contrôles passent.', inline: false }])
    .addFields({ name: '✅ Points conformes', value: okLabels.length ? okLabels.join('\n').slice(0, 1024) : '*aucun*', inline: false })
    .setFooter({ text: 'REZO • Audit de sécurité — relance après chaque correction' })
    .setTimestamp();

  return embed;
}

function buildFixRows(report) {
  const fixes = report.checks.filter(c => !c.ok && c.fix).map(c => c.fix);
  const buttons = fixes.slice(0, 4).map(fix => new ButtonBuilder()
    .setCustomId(`auf_${fix.type}`)
    .setLabel(fix.label || FIX_LABELS[fix.type] || fix.type)
    .setStyle(ButtonStyle.Success));
  const rows = [];
  if (buttons.length) rows.push(new ActionRowBuilder().addComponents(...buttons));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('auf_reload').setLabel('Relancer l\'audit').setEmoji('🔄').setStyle(ButtonStyle.Primary),
  ));
  return rows;
}

// Valeur appliquée par correctif (niveaux Discord).
const FIX_VALUES = { verification: 2, mfa: 1, content_filter: 2, notifications: 1 };

// Chaque correctif : application + description du résultat
const FIXES = {
  verification: {
    apply: (guild, value) => guild.setVerificationLevel(value),
    describe: 'Niveau de vérification réglé sur **Moyen** : les comptes trop jeunes ne peuvent plus écrire avant vérification.',
  },
  mfa: {
    apply: (guild, value) => guild.setMFALevel(value),
    describe: 'La **2FA** est désormais exigée pour les actions de modération.',
  },
  content_filter: {
    apply: (guild, value) => guild.setExplicitContentFilter(value),
    describe: 'Le filtre de contenu explicite s\'applique maintenant à **tous les membres**.',
  },
  notifications: {
    apply: (guild, value) => guild.setDefaultMessageNotifications(value),
    describe: 'Les notifications par défaut sont réglées sur **mentions uniquement**.',
  },
};

// ═════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('audit-securite')
    .setDescription('🔍 Auditer la sécurité du serveur (permissions, bots, protections) et corriger en un clic')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const state = await loadSecurityState(guild.id);
    const facts = await collectGuildFacts(guild, state);
    const report = buildAuditReport(facts);

    return interaction.editReply({ embeds: [buildReportEmbed(report, guild)], components: buildFixRows(report) });
  },

  // ─── Correctifs (route persistante : auf_*) ─────────────────────────────────
  async handleButton(interaction) {
    const id = interaction.customId;
    const guild = interaction.guild;

    if (id === 'auf_reload') {
      await interaction.deferUpdate();
      const state = await loadSecurityState(guild.id);
      const facts = await collectGuildFacts(guild, state);
      const report = buildAuditReport(facts);
      return interaction.editReply({ embeds: [buildReportEmbed(report, guild)], components: buildFixRows(report) });
    }

    const type = id.replace('auf_', '');
    const fix = FIXES[type];
    if (!fix) {
      return interaction.reply({ embeds: [errorEmbed('Correctif inconnu', 'Relance `/audit-securite`.')], ephemeral: true });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur** pour appliquer ce correctif.')], ephemeral: true });
    }

    try {
      await fix.apply(guild, FIX_VALUES[type] ?? 1);
    } catch (err) {
      const hint = type === 'mfa'
        ? 'La 2FA ne peut être exigée que par le **propriétaire** du serveur, et uniquement s\'il a lui-même activé la double authentification sur son compte Discord.'
        : 'Vérifie que le bot a bien la permission **Gérer le serveur** et qu\'il est au-dessus dans la hiérarchie.';
      return interaction.reply({ embeds: [errorEmbed('Correctif refusé par Discord', `${hint}\n\n\`${err.message}\``)], ephemeral: true });
    }

    return interaction.reply({
      embeds: [
        successEmbed('Correctif appliqué', fix.describe),
        infoEmbed('Prochaine étape', 'Clique sur **Relancer l\'audit** dans le rapport ci-dessus pour vérifier ton nouveau score.'),
      ],
      ephemeral: true,
    });
  },

  __testables: { collectGuildFacts, buildReportEmbed, buildFixRows, loadSecurityState, FIXES },
};
