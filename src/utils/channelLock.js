'use strict';
// utils/channelLock.js — Définition UNIQUE de ce qu'est un « salon verrouillé ».
//
// Un salon est verrouillé quand @everyone y est explicitement privé d'écriture :
//   • texte / annonces / forum / catégorie → SendMessages refusé ;
//   • vocal / conférence                   → Connect refusé.
//
// Pourquoi ce module existe : la sauvegarde doit capturer exactement ce que la
// restauration sait reposer. Une seule définition, utilisée des deux côtés,
// interdit le cas absurde où le bot archive un verrou qu'il refuse ensuite de
// remettre. Le verrou d'écriture refuse aussi SendMessagesInThreads : sans ça,
// un salon « verrouillé » resterait bavard dans ses fils.

const { ChannelType, OverwriteType, PermissionsBitField } = require('discord.js');

const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]
  .filter(value => value !== undefined));

const THREAD_TYPES = new Set([
  ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread,
].filter(value => value !== undefined));

function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return [...collection];
  if (typeof collection.values === 'function') return [...collection.values()];
  if (typeof collection.map === 'function') return collection.map(v => v);
  return [];
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isVoice(type) {
  return VOICE_TYPES.has(toInt(type, -1));
}

// Un fil de discussion n'a pas de permissions propres : il hérite du salon
// parent. Le verrouiller est donc impossible (et le dire vaut mieux que mentir).
function isThreadChannel(channelOrType) {
  const type = channelOrType && typeof channelOrType === 'object' ? channelOrType.type : channelOrType;
  return THREAD_TYPES.has(toInt(type, -1));
}

// Permission qui matérialise le verrou.
function lockFlagFor(type) {
  return isVoice(type) ? 'Connect' : 'SendMessages';
}

// Overwrite de @everyone (son ID est celui du serveur). Accepte aussi bien un
// salon vivant (manager avec .cache) qu'une entrée sérialisée (tableau).
function everyoneOverwrite(channel, guildId) {
  const id = String(guildId || '');
  if (!id) return null;
  const raw = channel?.permissionOverwrites?.cache ?? channel?.permissionOverwrites ?? [];
  return values(raw).find(overwrite => overwrite
    && String(overwrite.id) === id
    && toInt(overwrite.type, OverwriteType.Role) === OverwriteType.Role) || null;
}

function denies(overwrite, flag) {
  const bit = PermissionsBitField.Flags[flag];
  if (bit === undefined) return false;
  let deny = 0n;
  try {
    deny = BigInt(overwrite?.deny?.bitfield ?? overwrite?.deny ?? 0);
  } catch {
    return false;
  }
  return (deny & bit) === bit;
}

// Verrou porté par l'overwrite @everyone du salon (jamais les droits de base du
// rôle : sinon tout salon d'un serveur où @everyone est muet paraîtrait verrouillé).
function isLocked(channel, guildId) {
  const overwrite = everyoneOverwrite(channel, guildId);
  return overwrite ? denies(overwrite, lockFlagFor(channel?.type)) : false;
}

// Une entrée de sauvegarde peut affirmer le verrou (`locked: true`) : c'est ce
// qui permet de le reposer MÊME quand son overwrite @everyone a été écarté.
// Sinon — sauvegarde antérieure, champ absent ou `false` par défaut — on lit le
// verrou réel dans les overwrites : un `false` ne doit jamais masquer un vrai
// verrou, la restauration ne prend que le côté prudent.
function isEntryLocked(entry, guildId) {
  if (entry?.locked === true) return true;
  return isLocked(entry, guildId);
}

// Charge utile d'un overwrite @everyone : false = refusé, null = neutre (la
// permission redevient celle héritée du rôle @everyone).
function lockPayload(type, locked = true) {
  if (isVoice(type)) return { Connect: locked ? false : null };
  return locked
    ? { SendMessages: false, SendMessagesInThreads: false }
    : { SendMessages: null, SendMessagesInThreads: null };
}

// Applique (ou retire) le verrou. Idempotent : un salon déjà dans l'état demandé
// ne provoque aucun appel réseau inutile.
async function setChannelLock(channel, guild, { locked = true, reason = null } = {}) {
  if (!channel) return { ok: false, reason: 'missing-channel' };
  if (isThreadChannel(channel)) return { ok: false, reason: 'thread' };

  const guildId = guild?.id ?? channel.guild?.id;
  if (!guildId) return { ok: false, reason: 'missing-guild' };
  if (typeof channel?.permissionOverwrites?.edit !== 'function') {
    return { ok: false, reason: 'unsupported' };
  }

  const flag = lockFlagFor(channel.type);
  const wasLocked = isLocked(channel, guildId);
  if (wasLocked === Boolean(locked)) return { ok: true, changed: false, flag, wasLocked };

  await channel.permissionOverwrites.edit(String(guildId), lockPayload(channel.type, locked), {
    type: OverwriteType.Role,
    ...(reason ? { reason: String(reason).slice(0, 512) } : {}),
  });
  return { ok: true, changed: true, flag, wasLocked };
}

module.exports = {
  VOICE_TYPES,
  THREAD_TYPES,
  isVoice,
  isThreadChannel,
  lockFlagFor,
  everyoneOverwrite,
  denies,
  isLocked,
  isEntryLocked,
  lockPayload,
  setChannelLock,
};
