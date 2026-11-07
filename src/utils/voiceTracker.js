// utils/voiceTracker.js — Suivi du temps passé en vocal (sessions en mémoire + persistance périodique)
const { ChannelType } = require('discord.js');
const VoiceStats = require('../models/VoiceStats');
const VoiceConfig = require('../models/VoiceConfig');

// clé: `${guildId}:${userId}` -> { joinedAt: timestamp du début de session (ou du dernier checkpoint), channelId }
const sessions = new Map();

async function getOrCreateConfig(guildId) {
  let cfg = await VoiceConfig.findOne({ guildId });
  if (!cfg) cfg = await VoiceConfig.create({ guildId });
  return cfg;
}

async function getOrCreateStats(guildId, userId) {
  let doc = await VoiceStats.findOne({ guildId, userId });
  if (!doc) doc = await VoiceStats.create({ guildId, userId });
  return doc;
}

// Un salon compte pour le suivi s'il existe, n'est pas le salon AFK, et n'est pas dans la liste d'exclusion
function isTrackable(channel, guild, cfg) {
  if (!channel) return false;
  if (guild.afkChannelId && channel.id === guild.afkChannelId) return false;
  if (cfg.excludedChannels.includes(channel.id)) return false;
  return true;
}

function startSession(guildId, userId, channelId) {
  const key = `${guildId}:${userId}`;
  if (sessions.has(key)) return; // déjà en session (ex: changement de salon trackable → trackable)
  sessions.set(key, { joinedAt: Date.now(), channelId });
}

function updateSessionChannel(guildId, userId, channelId) {
  const key = `${guildId}:${userId}`;
  const s = sessions.get(key);
  if (s) s.channelId = channelId;
}

async function endSession(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  const elapsedSec = Math.max(0, Math.floor((Date.now() - s.joinedAt) / 1000));
  if (elapsedSec === 0) return;
  await VoiceStats.updateOne(
    { guildId, userId },
    { $inc: { totalSeconds: elapsedSec, sessions: 1 }, $set: { lastSeen: new Date() } },
    { upsert: true },
  );
}

// Additionne le temps écoulé depuis le dernier checkpoint SANS fermer la session
// (utilisé par le flush périodique pour limiter la perte de données en cas de crash)
async function checkpointAll() {
  const now = Date.now();
  for (const [key, s] of sessions.entries()) {
    const elapsedSec = Math.max(0, Math.floor((now - s.joinedAt) / 1000));
    if (elapsedSec === 0) continue;
    const [guildId, userId] = key.split(':');
    s.joinedAt = now; // reset du checkpoint
    await VoiceStats.updateOne(
      { guildId, userId },
      { $inc: { totalSeconds: elapsedSec }, $set: { lastSeen: new Date() } },
      { upsert: true },
    ).catch(err => console.error('[voiceTracker] checkpoint:', err.message));
  }
}

function startPeriodicFlush(intervalMs = 5 * 60 * 1000) {
  setInterval(() => checkpointAll().catch(err => console.error('[voiceTracker] flush:', err.message)), intervalMs);
}

// Temps total "live" d'un membre = temps déjà enregistré en base + temps de la session en cours (si active)
function getLiveElapsedSeconds(guildId, userId) {
  const s = sessions.get(`${guildId}:${userId}`);
  if (!s) return 0;
  return Math.max(0, Math.floor((Date.now() - s.joinedAt) / 1000));
}

function isInSession(guildId, userId) {
  return sessions.has(`${guildId}:${userId}`);
}

// Reprend le suivi des membres déjà en vocal au moment du démarrage/redémarrage du bot
// (le temps AVANT le redémarrage n'est pas récupérable, mais le suivi continue proprement après)
async function initFromCurrentState(client) {
  let picked = 0;
  for (const guild of client.guilds.cache.values()) {
    const cfg = await getOrCreateConfig(guild.id).catch(() => null);
    if (!cfg || !cfg.enabled) continue;
    const voiceChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice);
    for (const channel of voiceChannels.values()) {
      if (!isTrackable(channel, guild, cfg)) continue;
      for (const member of channel.members.values()) {
        if (member.user.bot) continue;
        startSession(guild.id, member.id, channel.id);
        picked++;
      }
    }
  }
  return picked;
}

module.exports = {
  getOrCreateConfig,
  getOrCreateStats,
  isTrackable,
  startSession,
  updateSessionChannel,
  endSession,
  checkpointAll,
  startPeriodicFlush,
  getLiveElapsedSeconds,
  isInSession,
  initFromCurrentState,
};
