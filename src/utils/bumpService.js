'use strict';
// utils/bumpService.js — Cœur du système de bump (une seule vérité).
//
// Un seul point d'entrée : la commande /bump de REZO.
//
// Ce module garantit les points qui faisaient défaut :
//   1. le cooldown est réservé ATOMIQUEMENT en base — deux bumps simultanés ne
//      peuvent pas être comptés deux fois ;
//   2. les récompenses (coins, streak, badges, historique) sont identiques quel
//      que soit le chemin, y compris pour un bump DISBOARD ;
//   3. la carte de félicitations est envoyée en message privé au membre, avec un
//      repli dans le salon si ses MP sont fermés ;
//   4. une panne de dessin, de MP ou d'annonce réseau ne casse jamais le bump.
//
// Seul le /bump de REZO est concerné : aucun autre bot de bump n'est écouté.
const { EmbedBuilder } = require('discord.js');
const Server = require('../models/Server');
const User = require('../models/User');
const Balance = require('../models/Balance');
const BumpHistory = require('../models/BumpHistory');
const {
  BUMP_COOLDOWN_MS, BUMP_COINS_REWARD, computeScore, dayKey,
} = require('./bumpNetwork');
const { checkAndAwardMilestones } = require('./bumpFeatures');
const { BUMP_CARD_FILENAME } = require('./bumpCard');
const { COLORS } = require('./embeds');

// ─── Calculs purs ────────────────────────────────────────────────────────────

/** Bonus de coins selon la streak du serveur (barème historique conservé). */
function streakBonusFor(streak) {
  if (Number(streak) >= 30) return 75;
  if (Number(streak) >= 7) return 25;
  return 0;
}

/** Timestamp Discord du prochain bump possible. */
function nextBumpTimestamp(from = Date.now()) {
  return Math.floor((from + BUMP_COOLDOWN_MS) / 1000);
}

function displayNameOf(member) {
  return String(member?.displayName || member?.user?.username || member?.username || 'Membre').trim() || 'Membre';
}

// ─── Réservation atomique du bump ────────────────────────────────────────────

/**
 * Réserve le bump en base. Renvoie { ok:false, reason } sans rien modifier si le
 * serveur est blacklisté ou si le cooldown court encore.
 *
 * La seconde requête est la garde anti-double-bump : elle ne met à jour que si
 * `lastBump` est encore assez ancien. Deux appels simultanés ne peuvent donc pas
 * incrémenter les compteurs deux fois.
 */
async function claimBump(guild, userId = null, now = new Date()) {
  const guildId = guild?.id;
  if (!guildId) return { ok: false, reason: 'no_guild' };

  await Server.updateOne(
    { guildId },
    {
      $setOnInsert: {
        guildId,
        guildName: guild.name || '',
        guildIcon: guild.iconURL?.({ dynamic: true }) || null,
        memberCount: guild.memberCount || 0,
      },
    },
    { upsert: true },
  );

  const before = await Server.findOne({ guildId }).lean();
  if (!before) return { ok: false, reason: 'no_server' };
  if (before.blacklisted) return { ok: false, reason: 'blacklisted', server: before };

  const lastTs = before.lastBump ? new Date(before.lastBump).getTime() : 0;
  const remainingMs = Math.max(0, BUMP_COOLDOWN_MS - (now.getTime() - lastTs));
  if (remainingMs > 0) return { ok: false, reason: 'cooldown', remainingMs, server: before };

  const server = await Server.findOneAndUpdate(
    {
      guildId,
      $or: [
        { lastBump: null },
        { lastBump: { $lte: new Date(now.getTime() - BUMP_COOLDOWN_MS) } },
      ],
    },
    {
      $set: {
        lastBump: now,
        lastBumpedBy: userId || null,
        reminderSent: false,
        guildName: guild.name || before.guildName || '',
        memberCount: guild.memberCount || before.memberCount || 0,
      },
      $inc: { bumpCount: 1, weeklyBumps: 1, monthlyBumps: 1 },
    },
    { new: true },
  );

  // Quelqu'un a réservé le bump entre la lecture et l'écriture.
  if (!server) {
    const current = await Server.findOne({ guildId }).lean();
    const currentLast = current?.lastBump ? new Date(current.lastBump).getTime() : 0;
    return {
      ok: false,
      reason: 'cooldown',
      remainingMs: Math.max(0, BUMP_COOLDOWN_MS - (now.getTime() - currentLast)),
      server: current,
    };
  }

  // ── Streak (jours consécutifs) ────────────────────────────────────────────
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  let streak;
  if (server.lastStreakDate === today) streak = Math.max(1, Number(server.bumpStreak) || 1);
  else if (server.lastStreakDate === yesterday) streak = (Number(server.bumpStreak) || 0) + 1;
  else streak = 1;

  if (streak !== server.bumpStreak || server.lastStreakDate !== today) {
    await Server.updateOne({ guildId }, { $set: { bumpStreak: streak, lastStreakDate: today } });
    server.bumpStreak = streak;
    server.lastStreakDate = today;
  }

  return { ok: true, server };
}

// ─── Récompenses ─────────────────────────────────────────────────────────────

/**
 * Crédite le membre : stats utilisateur, coins, badges de jalon, historique.
 * Ne lève jamais : un échec partiel ne doit pas annuler le bump déjà réservé.
 */
async function rewardBumper(guild, userId, server) {
  const streakBonus = streakBonusFor(server.bumpStreak);
  const totalReward = BUMP_COINS_REWARD + streakBonus;
  const result = { totalReward, streakBonus, newBadges: [], userStats: null };

  await Server.updateOne(
    { guildId: guild.id },
    { $inc: { totalCoinsEarned: totalReward } },
  ).catch((err) => console.error('❌ bump — totalCoinsEarned:', err.message));

  if (!userId) return result;

  try {
    result.userStats = await User.findOneAndUpdate(
      { userId, guildId: guild.id },
      {
        $inc: {
          bumps: 1,
          weeklyBumps: 1,
          monthlyBumps: 1,
          coinsEarned: totalReward,
        },
        $set: { lastBump: new Date() },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.error('❌ bump — stats membre:', err.message);
  }

  await Balance.findOneAndUpdate(
    { userId, guildId: guild.id },
    { $inc: { coins: totalReward } },
    { upsert: true },
  ).catch((err) => console.error('❌ bump — coins:', err.message));

  try {
    result.newBadges = await checkAndAwardMilestones(guild.id, userId, {
      bumpStreak: server.bumpStreak,
      totalUserBumps: result.userStats?.bumps,
    }) || [];
  } catch (err) {
    console.error('❌ bump — badges:', err.message);
  }

  await BumpHistory.create({
    guildId: guild.id,
    userId,
    guildName: guild.name || null,
    coinsEarned: totalReward,
    streakAtTime: server.bumpStreak,
  }).catch((err) => console.error('❌ bump — historique:', err.message));

  return result;
}

// ─── Message de félicitations ────────────────────────────────────────────────

function buildCongratulationEmbed({
  guild,
  member,
  server,
  totalReward = 0,
  streakBonus = 0,
  newBadges = [],
  source = 'REZO',
  hasCard = false,
} = {}) {
  const name = displayNameOf(member);
  const nextTs = nextBumpTimestamp();

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setAuthor({ name: `Bump ${source === 'REZO' ? 'REZO' : source} enregistré` })
    .setTitle(`🎉 Félicitations ${name} !`)
    .setDescription(
      `Ton bump pour **${guild?.name || server?.guildName || 'le serveur'}** est bien enregistré. `
      + 'Merci de faire vivre la communauté ! 🚀',
    )
    .addFields(
      { name: '🚀 Bumps du serveur', value: `**${Number(server?.bumpCount || 0).toLocaleString('fr-FR')}**`, inline: true },
      { name: '🔥 Streak', value: `**${Number(server?.bumpStreak || 0)}** jour(s)`, inline: true },
      {
        name: '🪙 Récompense',
        value: `**+${Number(totalReward).toLocaleString('fr-FR')} coins**${streakBonus > 0 ? ` *(+${streakBonus} bonus streak)*` : ''}`,
        inline: true,
      },
      { name: '📊 Score réseau', value: `**${computeScore(server || {})}** pts`, inline: true },
      { name: '⏰ Prochain bump', value: `<t:${nextTs}:R>`, inline: true },
    )
    .setFooter({ text: `REZO • bump ${source}` })
    .setTimestamp();

  if (hasCard) embed.setImage(`attachment://${BUMP_CARD_FILENAME}`);

  if (newBadges.length > 0) {
    embed.addFields({
      name: '🏅 Nouveau(x) badge(s) !',
      value: newBadges.map((b) => `${b.emoji} **${b.name}**`).join('\n'),
    });
  }

  return embed;
}

/** Message privé de félicitations. Renvoie true si le MP est parti. */
async function sendBumpDm({ member, embed, card }) {
  const target = member?.user || member;
  if (!target?.send) return false;

  try {
    await target.send({
      embeds: [embed],
      files: card ? [{ attachment: card, name: BUMP_CARD_FILENAME }] : [],
    });
    return true;
  } catch (err) {
    // MP fermés : ce n'est pas une erreur du bump, le canal reste informé.
    console.warn(`⚠️ bump — MP impossible pour ${target.id || 'le membre'}: ${err.message}`);
    return false;
  }
}

module.exports = {
  streakBonusFor,
  nextBumpTimestamp,
  claimBump,
  rewardBumper,
  buildCongratulationEmbed,
  sendBumpDm,
  BUMP_CARD_FILENAME,
};
