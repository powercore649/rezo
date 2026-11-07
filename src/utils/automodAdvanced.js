// utils/automodAdvanced.js — Enforcement de l'auto-modération avancée (Feature 2)
// Tout est encapsulé et défensif : aucune erreur ici ne doit jamais remonter et casser messageCreate.
const { EmbedBuilder } = require('discord.js');
const { COLORS, errorEmbed } = require('../utils/embeds');

// Map<guildId+userId, timestamp[]>  — anti-spam
const { createBoundedCache } = require('./boundedCache');
// BORNÉS : une entrée par membre et par serveur, jamais purgée auparavant.
const spamTimestamps = createBoundedCache({ max: 20_000, ttl: 0, name: 'automod-spam' });
// Map<guildId+userId, { count, history: timestamp[] }> — actions graduelles
const infractionTracker = createBoundedCache({ max: 20_000, ttl: 0, name: 'automod-infractions' });

async function applyAdvancedAction(message, action, reason, muteDurationSeconds) {
  try {
    const member = message.member;
    if (!member) return;

    if (action === 'warn') {
      const warn = await message.channel.send({ embeds: [errorEmbed('Auto-mod avancé', `${message.author}, ${reason}`)] }).catch(() => null);
      if (warn) setTimeout(() => warn.delete().catch(() => {}), 7000);
      return;
    }

    if (action === 'mute') {
      const ms = Math.max(5, muteDurationSeconds || 600) * 1000;
      await member.timeout(ms, `Auto-mod avancé : ${reason}`).catch(() => {});
      return;
    }

    if (action === 'kick') {
      await member.kick(`Auto-mod avancé : ${reason}`).catch(() => {});
      return;
    }

    if (action === 'ban') {
      await member.ban({ reason: `Auto-mod avancé : ${reason}` }).catch(() => {});
      return;
    }
  } catch (_) { /* ne jamais propager */ }
}

async function handleAdvancedAutoMod(message, cfg) {
  try {
    if (!cfg || message.author.bot || !message.guild || !message.member) return;
    const now = Date.now();
    const guildUserKey = `${message.guild.id}:${message.author.id}`;

    // ── Anti-spam ────────────────────────────────────────────────────────────
    if (cfg.antiSpam?.enabled) {
      const windowMs = (cfg.antiSpam.perSeconds || 5) * 1000;
      let arr = spamTimestamps.get(guildUserKey) || [];
      arr = arr.filter(t => now - t < windowMs);
      arr.push(now);
      spamTimestamps.set(guildUserKey, arr);

      if (arr.length >= (cfg.antiSpam.maxMessages || 5)) {
        spamTimestamps.set(guildUserKey, []);
        await applyAdvancedAction(message, 'mute', 'anti-spam (trop de messages)', cfg.antiSpam.muteDurationSeconds);
        await registerInfraction(message, cfg);
        return;
      }
    }

    // ── Anti-mass-mention ─────────────────────────────────────────────────────
    if (cfg.antiMassMention?.enabled) {
      const mentionCount = (message.mentions.users?.size || 0) + (message.mentions.roles?.size || 0);
      if (mentionCount >= (cfg.antiMassMention.maxMentions || 5)) {
        await message.delete().catch(() => {});
        await applyAdvancedAction(message, cfg.antiMassMention.action || 'mute', 'anti-mass-mention', cfg.antiSpam?.muteDurationSeconds);
        await registerInfraction(message, cfg);
        return;
      }
    }

    // ── Filtre de mots ────────────────────────────────────────────────────────
    if (cfg.wordFilter && (cfg.wordFilter.low?.length || cfg.wordFilter.medium?.length || cfg.wordFilter.high?.length)) {
      const content = (message.content || '').toLowerCase();
      const matches = (list) => Array.isArray(list) && list.some(w => w && content.includes(w.toLowerCase()));

      if (matches(cfg.wordFilter.high)) {
        await message.delete().catch(() => {});
        await applyAdvancedAction(message, cfg.wordFilter.highAction || 'kick', 'mot interdit (sévérité haute)', cfg.antiSpam?.muteDurationSeconds);
        await registerInfraction(message, cfg);
        return;
      }
      if (matches(cfg.wordFilter.medium)) {
        await message.delete().catch(() => {});
        await applyAdvancedAction(message, cfg.wordFilter.mediumAction || 'mute', 'mot interdit (sévérité moyenne)', cfg.antiSpam?.muteDurationSeconds);
        await registerInfraction(message, cfg);
        return;
      }
      if (matches(cfg.wordFilter.low)) {
        await message.delete().catch(() => {});
        await applyAdvancedAction(message, cfg.wordFilter.lowAction || 'warn', 'mot interdit (sévérité faible)', cfg.antiSpam?.muteDurationSeconds);
        await registerInfraction(message, cfg);
        return;
      }
    }
  } catch (_) { /* ne jamais propager */ }
}

// ─── Actions graduelles : compte les infractions dans une fenêtre glissante ───
async function registerInfraction(message, cfg) {
  try {
    if (!cfg.graduated?.enabled || !cfg.graduated.thresholds?.length) return;
    const now = Date.now();
    const windowMs = (cfg.graduated.windowSeconds || 3600) * 1000;
    const key = `${message.guild.id}:${message.author.id}`;

    let entry = infractionTracker.get(key) || { history: [] };
    entry.history = entry.history.filter(t => now - t < windowMs);
    entry.history.push(now);
    infractionTracker.set(key, entry);

    const count = entry.history.length;
    const sorted = [...cfg.graduated.thresholds].sort((a, b) => a.count - b.count);
    const triggered = sorted.filter(t => count >= t.count).pop();

    if (triggered) {
      await applyAdvancedAction(message, triggered.action, `action graduelle (${count} infractions)`, cfg.antiSpam?.muteDurationSeconds);
    }
  } catch (_) { /* ne jamais propager */ }
}

module.exports = { handleAdvancedAutoMod };
