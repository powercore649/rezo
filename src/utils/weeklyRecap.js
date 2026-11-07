'use strict';
// utils/weeklyRecap.js — Moteur du récap hebdomadaire d'activité.
//
// Calcule l'activité de la période écoulée (messages, XP, évolution des
// membres, bumps réseau, top membres, sanctions) à partir des instantanés
// cumulés, construit l'embed et le publie dans le salon configuré.
//
// Appelé chaque minute par le cron de src/index.js : pour chaque serveur dont
// l'expression cron correspond à l'instant courant, le récap est envoyé et
// l'instantané de référence est mis à jour.

const { EmbedBuilder } = require('discord.js');
const WeeklyRecap = require('../models/WeeklyRecap');
const XP = require('../models/XP');
const BumpHistory = require('../models/BumpHistory');
const Warn = require('../models/Warn');
const { COLORS } = require('./embeds');
const { isLicensed } = require('./licenseGate');
const { cronMatchesNow, buildSnapshot, computeRecapStats } = require('./weeklyRecapStats');

const DEFAULT_SCHEDULE = '0 18 * * 0';
const DEFAULT_PERIOD_MS = 7 * 86_400_000;

// ── Instantané de référence à partir des données XP du serveur ───────────────
async function buildGuildSnapshot(guild) {
  const docs = await XP.find({ guildId: guild.id })
    .select('userId messages totalXp')
    .lean();
  return buildSnapshot(docs, guild.memberCount || 0, new Date());
}

// ── Activité ponctuelle (nécessite une fenêtre temporelle) ───────────────────
async function gatherPeriodActivity(guildId, since) {
  const [bumps, topBumpers, warnings, gone] = await Promise.all([
    BumpHistory.countDocuments({ guildId, createdAt: { $gte: since } }).catch(() => 0),
    BumpHistory.aggregate([
      { $match: { guildId, createdAt: { $gte: since } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 3 },
    ]).catch(() => []),
    Warn.countDocuments({ guildId, createdAt: { $gte: since } }).catch(() => 0),
    BumpHistory.distinct('userId', { guildId, createdAt: { $gte: since } }).catch(() => []),
  ]);

  return { bumps, topBumpers, warnings, uniqueBumpers: gone.length };
}

// ── Formatage ────────────────────────────────────────────────────────────────
function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function memberEmoji(delta) {
  if (delta > 0) return '📈';
  if (delta < 0) return '📉';
  return '➖';
}

function formatMemberLine(delta, total) {
  return `${memberEmoji(delta)} **${signed(delta)}** ce récap · **${total}** au total`;
}

// ── Construction de l'embed ──────────────────────────────────────────────────
function buildRecapEmbed(client, guild, cfg, context) {
  const { stats, bumps, topBumpers, warnings, periodStart } = context;
  const sections = cfg.sections || {};

  const startTs = Math.floor(periodStart.getTime() / 1000);
  const endTs   = Math.floor(Date.now() / 1000);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({
      name:  `Récap hebdo — ${guild.name}`,
      iconURL: guild.iconURL?.({ dynamic: true }) || client.user.displayAvatarURL(),
    })
    .setTitle('📊 Activité de la semaine')
    .setDescription(
      `Période du <t:${startTs}:D> au <t:${endTs}:D>\n` +
      `👥 **${stats.activeMembers}** membre(s) actif(s) sur la période`,
    );

  if (sections.messages !== false) {
    embed.addFields({
      name:  '💬 Messages envoyés',
      value: `**${stats.messages.toLocaleString('fr-FR')}**`,
      inline: true,
    });
  }

  if (sections.xp !== false) {
    embed.addFields({
      name:  '⭐ XP gagné',
      value: `**${stats.xp.toLocaleString('fr-FR')}**`,
      inline: true,
    });
  }

  if (sections.members !== false) {
    embed.addFields({
      name:  '👥 Évolution des membres',
      value: formatMemberLine(stats.memberDelta, stats.memberCount),
      inline: true,
    });
  }

  if (sections.bumps !== false) {
    embed.addFields({
      name:  '🚀 Bumps réseau',
      value: bumps > 0
        ? `**${bumps}** par **${context.uniqueBumpers}** membre(s)`
        : '*Aucun bump cette semaine*',
      inline: true,
    });
  }

  if (sections.moderation === true) {
    embed.addFields({
      name:  '🛡️ Sanctions',
      value: warnings > 0 ? `**${warnings}** avertissement(s)` : '*Aucune sanction*',
      inline: true,
    });
  }

  // Top membres (une seule ligne par membre, max 5)
  if (sections.topMembers !== false && stats.topMembers.length > 0) {
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const lines = stats.topMembers.map((m, i) =>
      `${medals[i] || '•'} <@${m.userId}> — **${m.messages.toLocaleString('fr-FR')}** message(s)`,
    );
    embed.addFields({ name: '🏆 Top activité', value: lines.join('\n') });
  }

  // Top bumpers
  if (sections.bumps !== false && topBumpers.length > 0) {
    const lines = topBumpers.map((b, i) =>
      `${i + 1}. <@${b._id}> — **${b.count}** bump(s)`,
    );
    embed.addFields({ name: '🔥 Top bumpers', value: lines.join('\n') });
  }

  if (stats.messages === 0 && bumps === 0 && stats.topMembers.length === 0) {
    embed.addFields({
      name:  '💤 Semaine calme',
      value: 'Aucune activité détectée sur la période. Réveillez votre communauté !',
    });
  }

  embed
    .setFooter({ text: 'REZO • Récap hebdomadaire automatique' })
    .setTimestamp();

  return embed;
}

// ── Génère le récap d'un serveur (sans l'envoyer) ────────────────────────────
// Retourne { embed, content, snapshot } — `snapshot` est le nouvel instantané
// à enregistrer après envoi.
async function generateRecap(client, guild, cfg) {
  const previousSnapshot = cfg.snapshot || {};
  const periodStart = previousSnapshot.takenAt
    ? new Date(previousSnapshot.takenAt)
    : new Date(Date.now() - DEFAULT_PERIOD_MS);

  const [snapshot, activity] = await Promise.all([
    buildGuildSnapshot(guild),
    gatherPeriodActivity(guild.id, periodStart),
  ]);

  const stats = computeRecapStats(snapshot, previousSnapshot);

  const embed = buildRecapEmbed(client, guild, cfg, {
    stats,
    bumps: activity.bumps,
    topBumpers: activity.topBumpers,
    warnings: activity.warnings,
    periodStart,
    uniqueBumpers: activity.uniqueBumpers,
  });

  const content = cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : undefined;

  return { embed, content, snapshot };
}

// ── Publication périodique (appelée par le cron de src/index.js) ─────────────
async function sendWeeklyRecaps(client) {
  let configs;
  try {
    configs = await WeeklyRecap.find({ enabled: true, channelId: { $ne: null } });
  } catch (err) {
    console.error('❌ weeklyRecap — lecture config:', err.message);
    return 0;
  }

  const now = new Date();
  let sent = 0;

  for (const cfg of configs) {
    try {
      if (!cronMatchesNow(cfg.schedule || DEFAULT_SCHEDULE, now)) continue;

      // ── Verrou de licence — pas de récap automatique sans licence active ──
      const licensed = await isLicensed(cfg.guildId).catch(() => false);
      if (!licensed) continue;

      const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
      if (!guild) continue;

      const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
      if (!channel?.isTextBased()) continue;

      const { embed, content, snapshot } = await generateRecap(client, guild, cfg);

      await channel.send({ content, embeds: [embed] }).catch(() => {});

      cfg.snapshot   = snapshot;
      cfg.lastSentAt = new Date();
      await cfg.save();
      sent++;
    } catch (err) {
      console.error(`❌ weeklyRecap (${cfg.guildId}):`, err.message);
    }
  }

  return sent;
}

module.exports = {
  DEFAULT_SCHEDULE,
  buildGuildSnapshot,
  gatherPeriodActivity,
  buildRecapEmbed,
  generateRecap,
  sendWeeklyRecaps,
};
