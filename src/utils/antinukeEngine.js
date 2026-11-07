'use strict';
// utils/antinukeEngine.js — Logique métier pure de la protection anti-nuke.
//
// Aucune dépendance Discord ni MongoDB : tout est testable hors-ligne
// (voir tests/antinuke-smoke.js). L'orchestration Discord vit dans
// src/utils/antinukeActions.js, la configuration par serveur dans
// src/models/AntiNuke.js et l'écoute du journal d'audit dans
// src/events/security/antiNuke.js.

const MAX_INCIDENTS = 25;// ─── Catalogue des actions surveillées ───────────────────────────────────────
// weight   : gravité utilisée pour pondérer un incident (0-10)
// threshold: true → le seuil configuré s'applique (sinon l'action frappe au 1er coup)
// enforce  : true → l'action peut déclencher une sanction automatique
// logging  : true → l'action est journalisée même sous le seuil / sans sanction
const ACTIONS = {
  channelDelete:    { label: 'Salon supprimé',                 emoji: '🗑️', severity: 'critique', weight: 10, threshold: true,  enforce: true,  logging: true  },
  roleDelete:       { label: 'Rôle supprimé',                  emoji: '🎭', severity: 'eleve',    weight: 8,  threshold: true,  enforce: true,  logging: true  },
  botAdd:           { label: 'Bot ajouté',                     emoji: '🤖', severity: 'critique', weight: 9,  threshold: false, enforce: true,  logging: true  },
  memberRoleUpdate: { label: 'Permission dangereuse accordée', emoji: '🔑', severity: 'critique', weight: 9,  threshold: false, enforce: true,  logging: true  },
  ban:              { label: 'Membre banni',                   emoji: '🔨', severity: 'eleve',    weight: 6,  threshold: true,  enforce: true,  logging: false },
  webhookCreate:    { label: 'Webhook créé',                   emoji: '🪝', severity: 'eleve',    weight: 5,  threshold: true,  enforce: true,  logging: true  },
  kick:             { label: 'Membre expulsé',                 emoji: '👢', severity: 'moyen',    weight: 4,  threshold: true,  enforce: true,  logging: false },
  guildUpdate:      { label: 'Serveur modifié',                emoji: '⚙️', severity: 'eleve',    weight: 7,  threshold: false, enforce: false, logging: true  },
  emojiDelete:      { label: 'Emoji supprimé',                 emoji: '😢', severity: 'faible',   weight: 2,  threshold: false, enforce: false, logging: true  },
};

const TRACKED = Object.keys(ACTIONS);

// ─── Niveaux de sensibilité ──────────────────────────────────────────────────
// Un niveau fixe à la fois la fenêtre d'analyse et les seuils par action.
const LEVELS = {
  surveillance: { windowSec: 60, thresholds: { channelDelete: 6, roleDelete: 6, ban: 8,  kick: 12, webhookCreate: 5 } },
  normal:       { windowSec: 45, thresholds: { channelDelete: 3, roleDelete: 3, ban: 5,  kick: 8,  webhookCreate: 3 } },
  strict:       { windowSec: 30, thresholds: { channelDelete: 2, roleDelete: 2, ban: 3,  kick: 4,  webhookCreate: 2 } },
};

const DEFAULT_LEVEL = 'normal';
const THRESHOLD_KEYS = ['channelDelete', 'roleDelete', 'ban', 'kick', 'webhookCreate'];

function isLevel(level) { return Object.prototype.hasOwnProperty.call(LEVELS, level); }

/**
 * Seuils + fenêtre correspondant à un niveau de sensibilité.
 * @param {string} level
 * @returns {{ windowSec:number, thresholds:Object }}
 */
function thresholdsFor(level) {
  const picked = LEVELS[isLevel(level) ? level : DEFAULT_LEVEL];
  return { windowSec: picked.windowSec, thresholds: { ...picked.thresholds } };
}

/**
 * Le serveur a-t-il surchargé ses seuils ? (sinon ceux du niveau s'appliquent)
 * @param {{thresholds?:Object, windowSec?:number, level?:string}} config
 * @returns {{ windowSec:number, thresholds:Object, custom:boolean }}
 */
function effectiveThresholds(config = {}) {
  const base = thresholdsFor(config.level);
  const thresholds = { ...base.thresholds };
  let custom = false;
  for (const key of THRESHOLD_KEYS) {
    const value = config.thresholds?.[key];
    if (Number.isFinite(value) && value > 0 && value !== base.thresholds[key]) {
      thresholds[key] = value;
      custom = true;
    }
  }
  const windowSec = Number.isFinite(config.windowSec) && config.windowSec > 0 ? config.windowSec : base.windowSec;
  return { windowSec, thresholds, custom };
}

/** Le seuil d'une action donnée (1 par défaut : les actions non listées frappent au premier coup). */
function thresholdOf(config, action) {
  if (!ACTIONS[action]?.threshold) return 1;
  return effectiveThresholds(config).thresholds[action] ?? 1;
}

/** Fiche d'une action (`null` si inconnue). */
function describeAction(action) {
  const meta = ACTIONS[action];
  return meta ? { action, ...meta } : null;
}

function isTracked(action) { return Boolean(ACTIONS[action]); }

/** L'action peut-elle déclencher une sanction automatique ? */
function isEnforced(action) { return Boolean(ACTIONS[action]?.enforce); }

/** Faut-il journaliser cette action même sans sanction ? (`journalSensitive`). */
function shouldLog(config, action) {
  if (!ACTIONS[action]?.logging) return false;
  return config?.journalSensitive !== false;
}

// ─── Fenêtre glissante (en mémoire, une Map par processus) ───────────────────
/**
 * Enregistre un coup et renvoie le nombre de coups dans la fenêtre.
 * @param {Map<string, number[]>} store
 * @param {string} key
 * @param {number} [now]
 * @param {number} [windowMs]
 * @returns {number}
 */
function bump(store, key, now = Date.now(), windowMs = 45_000) {
  if (!(store instanceof Map)) throw new TypeError('bump : store doit être une Map');
  const kept = (store.get(key) || []).filter(t => now - t < windowMs && t <= now);
  kept.push(now);
  store.set(key, kept);
  return kept.length;
}

/** Compte les coups sans en enregistrer un nouveau. */
function peek(store, key, now = Date.now(), windowMs = 45_000) {
  if (!(store instanceof Map)) return 0;
  return (store.get(key) || []).filter(t => now - t < windowMs && t <= now).length;
}

/** Oublie une clé (ex. après une sanction). */
function forget(store, key) { store.delete(key); }

/**
 * Purge les entrées périmées : garde la mémoire bornée sur les gros serveurs.
 * @returns {number} nombre de clés supprimées
 */
function pruneStore(store, now = Date.now(), windowMs = 45_000) {
  let removed = 0;
  for (const [key, hits] of store) {
    const kept = hits.filter(t => now - t < windowMs);
    if (kept.length === 0) { store.delete(key); removed++; }
    else store.set(key, kept);
  }
  return removed;
}

/** Clé de fenêtre : une fenêtre par serveur, par auteur et par type d'action. */
function trackerKey(guildId, userId, action) { return `${guildId}:${userId}:${action}`; }

// ─── Décision ────────────────────────────────────────────────────────────────
/**
 * Le seuil est-il franchi ?
 * @param {{thresholds?:Object, windowSec?:number, level?:string}} config
 * @param {string} action
 * @param {number} count
 * @returns {{ exceeded:boolean, threshold:number, count:number, severity:string, weight:number }}
 */
function evaluate(config, action, count) {
  const meta = ACTIONS[action];
  const threshold = thresholdOf(config, action);
  const n = Number.isFinite(count) ? count : 0;
  return {
    exceeded: n >= threshold,
    threshold,
    count: n,
    severity: meta?.severity || 'moyen',
    weight: meta?.weight || 0,
  };
}

// ─── Confiance (whitelist) ───────────────────────────────────────────────────
/**
 * Un auteur est-il hors surveillance ?
 * Le propriétaire du serveur, le bot lui-même et tout membre portant un rôle
 * whitelisté ou présent dans la liste d'utilisateurs ne sont jamais sanctionnés.
 * @param {{whitelistUsers?:string[], whitelistRoles?:string[]}} config
 * @param {{ userId?:string, roleIds?:string[], guildOwnerId?:string, clientId?:string }} subject
 * @returns {{ trusted:boolean, reason:string|null }}
 */
function isTrusted(config, subject = {}) {
  const { userId, roleIds = [], guildOwnerId = null, clientId = null } = subject;
  if (!userId) return { trusted: false, reason: null };
  if (clientId && userId === clientId) return { trusted: true, reason: 'le bot lui-même' };
  if (guildOwnerId && userId === guildOwnerId) return { trusted: true, reason: 'propriétaire du serveur' };
  if ((config?.whitelistUsers || []).includes(userId)) return { trusted: true, reason: 'liste de confiance' };
  const whitelistedRoles = config?.whitelistRoles || [];
  const matched = (roleIds || []).find(id => whitelistedRoles.includes(id));
  if (matched) return { trusted: true, reason: `rôle de confiance <@&${matched}>` };
  return { trusted: false, reason: null };
}

// ─── Incidents ───────────────────────────────────────────────────────────────
/**
 * Construit un incident prêt à être poussé dans la config.
 */
function buildIncident({ userId = null, userTag = null, action = null, count = 0, threshold = 0, punishment = 'none', restored = null, at = new Date() } = {}) {
  return { at, userId, userTag, action, count, threshold, punishment, restored };
}

/** Ajoute un incident en gardant les MAX_INCIDENTS plus récents (retourne une nouvelle liste). */
function capIncidents(incidents = [], limit = MAX_INCIDENTS) {
  const list = Array.isArray(incidents) ? [...incidents] : [];
  return list.length > limit ? list.slice(list.length - limit) : list;
}

/** Ligne lisible d'un incident (une par incident, pour un embed). */
function formatIncident(incident) {
  const meta = describeAction(incident?.action) || { emoji: '⚠️', label: incident?.action || 'Action' };
  const when = incident?.at ? Math.floor(new Date(incident.at).getTime() / 1000) : null;
  const author = incident?.userId ? `<@${incident.userId}>` : 'inconnu';
  const restored = incident?.restored ? `\n    └ ♻️ ${incident.restored}` : '';
  return `${meta.emoji} **${meta.label}** ×${incident?.count ?? 0} par ${author}${when ? ` — <t:${when}:R>` : ''}` +
    `\n    └ sanction : \`${incident?.punishment || 'none'}\`${restored}`;
}

// ─── Réparation (reconstruction depuis l'entrée d'audit) ─────────────────────
/**
 * Options de création d'un salon recréé à l'identique après suppression.
 * Les overwrites sont conservés : leur nettoyage éventuel est fait par l'appelant.
 * @param {{name?:string, type?:number, parentId?:string|null, topic?:string|null, nsfw?:boolean,
 *          rateLimitPerUser?:number, bitrate?:number, userLimit?:number, position?:number, reason?:string}} meta
 */
function channelRestoreOptions(meta = {}) {
  const name = String(meta.name ?? 'salon-restaure');
  const options = {
    name,
    type: meta.type,
    reason: meta.reason || 'Anti-nuke : salon restauré automatiquement',
  };
  if (meta.parentId) options.parent = meta.parentId;
  if (Number.isFinite(meta.position)) options.position = meta.position;
  if (meta.topic != null) options.topic = String(meta.topic);
  if (typeof meta.nsfw === 'boolean') options.nsfw = meta.nsfw;
  if (Number.isFinite(meta.rateLimitPerUser) && meta.rateLimitPerUser > 0) options.rateLimitPerUser = meta.rateLimitPerUser;
  if (Number.isFinite(meta.bitrate) && meta.bitrate > 0) options.bitrate = meta.bitrate;
  if (Number.isFinite(meta.userLimit) && meta.userLimit > 0) options.userLimit = meta.userLimit;
  if (Array.isArray(meta.permissionOverwrites) && meta.permissionOverwrites.length) {
    options.permissionOverwrites = meta.permissionOverwrites;
  }
  return options;
}

/**
 * Options de création d'un rôle recréé à l'identique après suppression.
 * Ne traite jamais `@everyone` (jamais supprimable) ni un rôle géré (bot/intégration).
 * @param {{name?:string, color?:number, hoist?:boolean, mentionable?:boolean, permissions?:string|bigint}} meta
 * @returns {Object|null} null si le rôle n'est pas reconstructible
 */
function roleRestoreOptions(meta = {}) {
  const name = meta.name ? String(meta.name) : null;
  if (!name || name === '@everyone') return null;
  if (meta.managed) return null;
  const options = {
    name,
    color: Number.isFinite(meta.color) ? meta.color : 0,
    hoist: Boolean(meta.hoist),
    mentionable: Boolean(meta.mentionable),
    reason: meta.reason || 'Anti-nuke : rôle restauré automatiquement',
  };
  if (meta.permissions != null) {
    try { options.permissions = BigInt(meta.permissions); } catch { /* permissions illisibles : rôle sans permission */ }
  }
  return options;
}

/** Résumé humain d'une sanction appliquée. */
function describePunishment(punishment) {
  switch (punishment) {
    case 'ban':         return 'banni du serveur';
    case 'quarantine':  return 'mis en quarantaine (tous les rôles retirés)';
    case 'removeRoles': return 'dépouillé de ses rôles';
    case 'none':        return 'aucune sanction (mode journalisation)';
    default:            return String(punishment);
  }
}

module.exports = {
  MAX_INCIDENTS,
  ACTIONS,
  TRACKED,
  THRESHOLD_KEYS,
  LEVELS,
  DEFAULT_LEVEL,
  isLevel,
  thresholdsFor,
  effectiveThresholds,
  thresholdOf,
  describeAction,
  isTracked,
  isEnforced,
  shouldLog,
  bump,
  peek,
  forget,
  pruneStore,
  trackerKey,
  evaluate,
  isTrusted,
  buildIncident,
  capIncidents,
  formatIncident,
  channelRestoreOptions,
  roleRestoreOptions,
  describePunishment,
};
