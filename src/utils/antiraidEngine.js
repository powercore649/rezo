'use strict';
// utils/antiraidEngine.js — Logique métier pure du moteur anti-raid.
// Aucune dépendance Discord/DB — 100% testable unitairement.
// Le module events/antiraid.js orchestre : il enregistre les arrivées via ce
// moteur puis applique les décisions via l'API Discord.

const MODES = ['monitor', 'normal', 'strict'];

// Effets par défaut selon le niveau de protection (surcharge possible par serveur).
const MODE_DEFAULTS = {
  monitor: { joinsThreshold: 25, joinsWindowSec: 60, suspicionThreshold: 15, waveThreshold: 40, minAccountAgeDays: 3 },
  normal:  { joinsThreshold: 10, joinsWindowSec: 30, suspicionThreshold: 6,  waveThreshold: 25, minAccountAgeDays: 7 },
  strict:  { joinsThreshold: 5,  joinsWindowSec: 20, suspicionThreshold: 3,  waveThreshold: 15, minAccountAgeDays: 14 },
};

function modeDefaults(mode) {
  return { ...(MODE_DEFAULTS[mode] || MODE_DEFAULTS.normal) };
}

// ─── Fenêtre glissante des arrivées ───────────────────────────────────────────
/**
 * Retire du buffer les arrivées plus vieilles que la fenêtre (mute le tableau).
 * @param {Array<{joinedAt:number, userId:string}>} joins
 * @param {number} windowMs
 * @param {number} [now]
 * @returns {Array} le même buffer, nettoyé
 */
function pruneJoins(joins, windowMs, now = Date.now()) {
  const cutoff = now - windowMs;
  while (joins.length && joins[0].joinedAt < cutoff) joins.shift();
  return joins;
}

/**
 * @param {Array<{joinedAt:number}>} joins
 * @param {number} windowMs
 * @param {number} [now]
 * @returns {number} nb d'arrivées dans la fenêtre
 */
function joinsInWindow(joins, windowMs, now = Date.now()) {
  pruneJoins(joins, windowMs, now);
  return joins.length;
}

/**
 * Décide si un raid de masse est détecté.
 * @param {{joinsWindowSec?:number, joinsThreshold?:number}} config
 * @param {Array<{joinedAt:number}>} joins
 * @param {number} [now]
 * @returns {{ raid:boolean, joins:number, threshold:number, windowMs:number }}
 */
function detectRaid(config, joins, now = Date.now()) {
  const windowMs = (config.joinsWindowSec || 30) * 1000;
  const threshold = config.joinsThreshold || 10;
  const count = joinsInWindow(joins, windowMs, now);
  return { raid: count >= threshold, joins: count, threshold, windowMs };
}

// ─── Heuristiques de suspicion ────────────────────────────────────────────────
/**
 * Évalue si un membre qui rejoint le serveur est « suspect ».
 * @param {{minAccountAgeDays?:number, noAvatarSuspect?:boolean, whitelistedRoleIds?:string[], whitelistedUserIds?:string[]}} cfg
 * @param {{id:string, user:{createdTimestamp:number, avatar:string|null}, roles:{cache:Map|Array}}} member
 * @returns {{ suspect:boolean, reasons:string[] }}
 */
function assessJoin(cfg, member) {
  const reasons = [];
  const whitelistedUsers = cfg.whitelistedUserIds || [];
  const whitelistedRoles = cfg.whitelistedRoleIds || [];

  if (whitelistedUsers.includes(member?.id)) return { suspect: false, reasons: ['whitelisted'] };

  const roleIds = member?.roles?.cache
    ? (member.roles.cache instanceof Map ? [...member.roles.cache.keys()] : member.roles.cache.map(r => r.id))
    : [];
  if (roleIds.some(id => whitelistedRoles.includes(id))) return { suspect: false, reasons: ['whitelisted'] };

  const created = member?.user?.createdTimestamp || 0;
  const ageDays = (Date.now() - new Date(created).getTime()) / 86_400_000;
  if ((cfg.minAccountAgeDays || 0) > 0 && ageDays < cfg.minAccountAgeDays) {
    reasons.push(`compte créé il y a ${Math.floor(ageDays)}j (min ${cfg.minAccountAgeDays}j)`);
  }
  if (cfg.noAvatarSuspect && !member?.user?.avatar) reasons.push('pas de avatar');

  return { suspect: reasons.length > 0, reasons };
}

// ─── Wave raids (arrivées progressives sur une longue période) ───────────────
/**
 * Enregistre une arrivée dans le compteur de période (mute config.waveState).
 * @param {{waveState:{windowStart:number, joins:number}|null}} config
 * @param {number} periodMin - durée de la période d'analyse en minutes
 * @param {number} [now]
 * @returns {number} nb d'arrivées sur la période courante
 */
function recordWaveJoin(config, periodMin, now = Date.now()) {
  const periodMs = periodMin * 60_000;
  let st = config.waveState;
  if (!st || typeof st.windowStart !== 'number' || now - st.windowStart >= periodMs) {
    st = { windowStart: now, joins: 1 };
  } else {
    st.joins = (st.joins || 0) + 1;
  }
  config.waveState = st;
  return st.joins;
}

/**
 * @param {number} joinsInPeriod
 * @param {number} threshold
 * @returns {boolean}
 */
function isWaveRaid(joinsInPeriod, threshold) {
  return joinsInPeriod >= threshold;
}

// ─── Réponse automatique ──────────────────────────────────────────────────────
/**
 * @param {{response?:{verification?:boolean, kickNewAccounts?:boolean, lockdown?:boolean, blockInvites?:boolean}}} cfg
 * @returns {{ verification:boolean, kickNewAccounts:boolean, lockdown:boolean, blockInvites:boolean }}
 */
function decideResponse(cfg) {
  const r = cfg?.response || {};
  return {
    verification: !!r.verification,
    kickNewAccounts: !!r.kickNewAccounts,
    lockdown: !!r.lockdown,
    blockInvites: !!r.blockInvites,
  };
}

// ─── Quarantaine ──────────────────────────────────────────────────────────────
/**
 * Quels rôles retirer à l'arrivée (mise en quarantaine) : on garde les rôles
 * whitelistés et le rôle de quarantaine. Les rôles gérés (bots/intégrations)
 * sont filtrés par Discord au moment de l'édition (retraits best-effort).
 * @param {string[]} memberRoleIds
 * @param {{whitelistedRoleIds?:string[], quarantineRoleId?:string|null}} cfg
 * @returns {{ toRemove:string[], kept:string[] }}
 */
function quarantineRoles(memberRoleIds, cfg) {
  const whitelist = new Set([...(cfg.whitelistedRoleIds || []), cfg.quarantineRoleId].filter(Boolean));
  const ids = memberRoleIds || [];
  const toRemove = ids.filter(id => !whitelist.has(id));
  const kept = ids.filter(id => whitelist.has(id));
  return { toRemove, kept };
}

/**
 * Un membre doit-il être traité comme raider connu (anti-liste) ?
 * @param {{bannedUserIds?:string[], bannedKick?:boolean, bannedBan?:boolean}} cfg
 * @param {string} userId
 * @returns {{ banned:boolean, action:'none'|'kick'|'ban' }}
 */
function checkBlacklisted(cfg, userId) {
  if (!(cfg.bannedUserIds || []).includes(userId)) return { banned: false, action: 'none' };
  if (cfg.bannedBan) return { banned: true, action: 'ban' };
  if (cfg.bannedKick) return { banned: true, action: 'kick' };
  return { banned: true, action: 'none' };
}

module.exports = {
  MODES,
  MODE_DEFAULTS,
  modeDefaults,
  pruneJoins, joinsInWindow, detectRaid,
  assessJoin, recordWaveJoin, isWaveRaid,
  decideResponse, quarantineRoles, checkBlacklisted,
};
