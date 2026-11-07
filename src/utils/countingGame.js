'use strict';
// utils/countingGame.js — Logique du Counting Game (appelée depuis events/messageCreate.js)

const CountingGame = require('../models/CountingGame');
const {
  buildSuccessEmbed,
  buildFailEmbed,
  buildSameUserEmbed,
  buildRewardEmbed,
} = require('./countingEmbeds');

function pickNextSecretTarget(cfg, fromCount) {
  const min = Math.max(1, cfg.secretMin || 10);
  const max = Math.max(min, cfg.secretMax || 100);
  return fromCount + (Math.floor(Math.random() * (max - min + 1)) + min);
}

async function grantReward(message, cfg, kind, number) {
  cfg.totalWins += 1;

  if (cfg.rewardRoleId && message.member) {
    await message.member.roles.add(cfg.rewardRoleId).catch(() => {});
  }

  const embed = buildRewardEmbed({
    user: message.author.id,
    number,
    kind,
    roleId: cfg.rewardRoleId,
    customMessage: cfg.rewardMessage,
  });
  await message.channel.send({ content: `🎁 <@${message.author.id}>`, embeds: [embed] }).catch(() => {});
}

// ─── Point d'entrée : traite un message envoyé dans un salon de counting ──────
// Retourne true si le message a été géré (le caller doit alors s'arrêter là).
const readCountingGame = require('./guildConfigCache').registerModel(CountingGame, { cacheHits: false });
async function handleCountingMessage(message) {
  if (!message.guild || message.author.bot) return false;

  // Absences mises en cache (l'immense majorité des salons ne sont pas des
  // salons de comptage) : le document présent, lui, est muté puis sauvegardé
  // juste après, il doit donc rester un vrai document Mongoose.
  const cfg = await readCountingGame({
    guildId: message.guild.id, enabled: true, channelId: message.channel.id,
  });
  if (!cfg) return false;

  const raw = message.content.trim();

  // ── Message non numérique dans le salon de compte ──────────────────────
  if (!/^\d+$/.test(raw)) {
    if (cfg.deleteWrongMessages) await message.delete().catch(() => {});
    return true;
  }

  const given    = parseInt(raw, 10);
  const expected = cfg.currentCount + 1;
  const sameUserTwice = !cfg.allowSameUserTwice && cfg.lastUserId === message.author.id;

  // ── Échec : mauvais nombre ou même utilisateur deux fois d'affilée ─────
  if (given !== expected || sameUserTwice) {
    if (cfg.deleteWrongMessages) await message.delete().catch(() => {});

    if (cfg.currentCount > cfg.bestStreak) cfg.bestStreak = cfg.currentCount;
    cfg.totalFails += 1;

    const embed = sameUserTwice
      ? buildSameUserEmbed({ user: `<@${message.author.id}>`, expected, resetOnFail: cfg.resetOnFail, highestCount: cfg.highestCount })
      : buildFailEmbed({ user: `<@${message.author.id}>`, given, expected, resetOnFail: cfg.resetOnFail, highestCount: cfg.highestCount });

    const errorMsg = await message.channel.send({ embeds: [embed] }).catch(() => null);
    if (errorMsg) {
      setTimeout(() => errorMsg.delete().catch(() => {}), 10_000);
    }

    if (cfg.resetOnFail) {
      cfg.currentCount = 0;
      cfg.lastUserId   = null;
    }
    cfg.updatedAt = new Date();
    await cfg.save();
    return true;
  }

  // ── Succès : on supprime le message et le bot poste l'embed à la place ──
  cfg.currentCount = given;
  cfg.lastUserId   = message.author.id;
  if (given > cfg.highestCount) cfg.highestCount = given;

  const authorId = message.author.id;
  await message.delete().catch(() => {});
  await message.channel.send({ embeds: [buildSuccessEmbed({ userId: authorId, number: given })] }).catch(() => {});

  const isMilestone = (cfg.rewardMode === 'milestone' || cfg.rewardMode === 'both')
    && cfg.milestoneEvery > 0 && given % cfg.milestoneEvery === 0;
  const isSecretHit = (cfg.rewardMode === 'secret' || cfg.rewardMode === 'both')
    && cfg.secretTarget !== null && given === cfg.secretTarget;

  if (isSecretHit) {
    await grantReward(message, cfg, 'secret', given);
    cfg.secretTarget = pickNextSecretTarget(cfg, given);
  } else if (isMilestone) {
    await grantReward(message, cfg, 'milestone', given);
  }

  cfg.updatedAt = new Date();
  await cfg.save();
  return true;
}

module.exports = { handleCountingMessage, pickNextSecretTarget };
