'use strict';
// utils/pingGuardEngine.js — Décisions pures de la garde anti-ping et des salons.
//
// Aucune dépendance Discord ni MongoDB : tout est testable hors-ligne (voir
// tests/ping-guard.test.js). L'application réelle (suppression, timeout, ban,
// reconstruction) vit dans utils/pingGuard.js.
//
// Deux principes :
//   • ne jamais bloquer un membre qui a le DROIT de le faire — la permission
//     « Mentionner @everyone » couvre @everyone, @here et les mentions de rôles ;
//   • ne jamais confondre un nom de salon légitime avec une attaque — la liste
//     de mots-clés est faite de formules entières (« hacked by »), pas de mots
//     isolés comme « raid », qui servent aussi à des salons d'organisation.

const { channelRestoreOptions } = require('./antinukeEngine');

// ─── Bornes ──────────────────────────────────────────────────────────────────
// Un document abîmé (valeur texte, négative, énorme) ne doit ni désactiver la
// protection ni créer une sanction absurde : tout est ramené dans un intervalle.
function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function boundedBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function boundedList(value, max = 50) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const id = String(item || '').trim();
    if (!id) continue;
    seen.add(id);
    if (seen.size >= max) break;
  }
  return [...seen];
}

const DEFAULT_KEYWORDS = [
  'nuke',
  'nuked',
  'hacked by',
  'hacké par',
  'free nitro',
  'nitro gratuit',
  'gift nitro',
  'raid tool',
  'token grabber',
  'token grab',
];

const MAX_KEYWORDS = 30;
const PUNISHMENTS = ['delete', 'timeout', 'kick', 'ban'];

const DEFAULTS = {
  enabled: true,
  blockEveryone: true,
  blockHere: true,
  maxRoleMentions: 3,
  maxUserMentions: 6,
  punishment: 'timeout',
  timeoutMin: 10,
  strikesBeforeBan: 3,
  strikeWindowMin: 60,
  exemptRoles: [],
  exemptChannels: [],
  trustedUsers: [],
  trustedRoles: [],
};

const CHANNEL_DEFAULTS = {
  enabled: true,
  deleteChannel: true,
  banAuthor: true,
  restoreDeleted: true,
  restoreWindowMin: 15,
};

/** Liste de mots-clés utilisable : minuscules, uniques, bornée. */
function normalizeKeywords(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  for (const raw of source) {
    const word = String(raw || '').trim().toLowerCase().slice(0, 40);
    if (word.length < 3) continue;
    seen.add(word);
    if (seen.size >= MAX_KEYWORDS) break;
  }
  return seen.size ? [...seen] : [...DEFAULT_KEYWORDS];
}

function normalizePunishment(value, fallback = DEFAULTS.punishment) {
  const clean = String(value || '').trim().toLowerCase();
  return PUNISHMENTS.includes(clean) ? clean : fallback;
}

/**
 * Ramène un document (ou un objet partiel) à une configuration sûre.
 * @param {object} raw
 * @returns {object}
 */
function normalizeConfig(raw = {}) {
  const guard = raw?.channelGuard || {};
  return {
    enabled:          boundedBool(raw.enabled, DEFAULTS.enabled),
    blockEveryone:    boundedBool(raw.blockEveryone, DEFAULTS.blockEveryone),
    blockHere:        boundedBool(raw.blockHere, DEFAULTS.blockHere),
    maxRoleMentions:  boundedInt(raw.maxRoleMentions, DEFAULTS.maxRoleMentions, 0, 25),
    maxUserMentions:  boundedInt(raw.maxUserMentions, DEFAULTS.maxUserMentions, 0, 50),
    punishment:       normalizePunishment(raw.punishment),
    timeoutMin:       boundedInt(raw.timeoutMin, DEFAULTS.timeoutMin, 1, 40_320),
    strikesBeforeBan: boundedInt(raw.strikesBeforeBan, DEFAULTS.strikesBeforeBan, 1, 10),
    strikeWindowMin:  boundedInt(raw.strikeWindowMin, DEFAULTS.strikeWindowMin, 1, 1440),
    exemptRoles:      boundedList(raw.exemptRoles),
    exemptChannels:   boundedList(raw.exemptChannels),
    trustedUsers:     boundedList(raw.trustedUsers),
    trustedRoles:     boundedList(raw.trustedRoles),
    channelGuard: {
      enabled:          boundedBool(guard.enabled, CHANNEL_DEFAULTS.enabled),
      deleteChannel:    boundedBool(guard.deleteChannel, CHANNEL_DEFAULTS.deleteChannel),
      banAuthor:        boundedBool(guard.banAuthor, CHANNEL_DEFAULTS.banAuthor),
      restoreDeleted:   boundedBool(guard.restoreDeleted, CHANNEL_DEFAULTS.restoreDeleted),
      restoreWindowMin: boundedInt(guard.restoreWindowMin, CHANNEL_DEFAULTS.restoreWindowMin, 1, 1440),
      keywords:         normalizeKeywords(guard.keywords),
    },
  };
}

// ─── Mentions ────────────────────────────────────────────────────────────────
// Discord ne ping pas à l'intérieur d'un bloc de code, et `\@everyone` est un
// texte échappé : les compter comme des pings punirait des explications
// techniques parfaitement légitimes (« tape @everyone dans un bloc de code »).
function stripNonPinging(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\\@/g, '');
}

// `@everyone-ish` n'est pas une mention : Discord exige que le jeton s'arrête
// après le mot. On refuse donc tout caractère de mot ou tiret juste après.
const EVERYONE_RE = /(^|[\s(.,;:!?«»"'])\@everyone(?![\w-])/i;
const HERE_RE = /(^|[\s(.,;:!?«»"'])\@here(?![\w-])/i;

const RULES = {
  everyone:  { label: '@everyone sans autorisation', short: 'everyone' },
  here:      { label: '@here sans autorisation',     short: 'here' },
  roleMass:  { label: 'mentions de rôles en masse',  short: 'role-mass' },
  userMass:  { label: 'mentions de membres en masse',short: 'user-mass' },
};

function describeRule(rule) {
  return RULES[rule]?.label || 'mention abusive';
}

/**
 * Analyse un message au regard des règles anti-ping.
 * @param {{content?:string, roleMentions?:number, userMentions?:number, canMentionEveryone?:boolean}} message
 * @param {object} config configuration normalisée (ou brute)
 * @returns {{violation:boolean, rule:string|null, count:number, detail:string|null}}
 */
function analyzeMessage(message = {}, config = {}) {
  const cfg = config?.channelGuard ? config : normalizeConfig(config);
  const text = stripNonPinging(message.content);
  const canMentionEveryone = message.canMentionEveryone === true;
  const roleMentions = Number.isFinite(message.roleMentions) ? Math.max(0, message.roleMentions) : 0;
  const userMentions = Number.isFinite(message.userMentions) ? Math.max(0, message.userMentions) : 0;

  if (canMentionEveryone) {
    // Le staff garde la main : on ne filtre que les mentions de MEMBRES en masse,
    // qui n'ont jamais besoin d'une permission spéciale pour être abusives.
    if (cfg.maxUserMentions > 0 && userMentions >= cfg.maxUserMentions) {
      return { violation: true, rule: 'userMass', count: userMentions, detail: `${userMentions} mentions de membres` };
    }
    return { violation: false, rule: null, count: 0, detail: null };
  }

  if (cfg.blockEveryone && EVERYONE_RE.test(text)) {
    return { violation: true, rule: 'everyone', count: 1, detail: 'mention @everyone sans la permission Discord' };
  }
  if (cfg.blockHere && HERE_RE.test(text)) {
    return { violation: true, rule: 'here', count: 1, detail: 'mention @here sans la permission Discord' };
  }
  if (cfg.maxRoleMentions > 0 && roleMentions >= cfg.maxRoleMentions) {
    return { violation: true, rule: 'roleMass', count: roleMentions, detail: `${roleMentions} rôles mentionnés` };
  }
  if (cfg.maxUserMentions > 0 && userMentions >= cfg.maxUserMentions) {
    return { violation: true, rule: 'userMass', count: userMentions, detail: `${userMentions} membres mentionnés` };
  }
  return { violation: false, rule: null, count: 0, detail: null };
}

/**
 * Neutralise les mentions d'un texte destiné à être réaffiché (log, alerte) :
 * un embed de journal ne doit jamais re-pinguer le serveur.
 */
function sanitizeMentions(text, limit = 300) {
  return String(text || '')
    .replace(/@everyone/gi, '@\u200beveryone')
    .replace(/@here/gi, '@\u200bhere')
    .replace(/<@&?\d+>/g, '[mention]')
    .slice(0, limit);
}

/**
 * Sanction à appliquer pour la récidive n° `strike`.
 * La 1re reste la sanction configurée ; au seuil de récidives, c'est le ban.
 * @param {object} config
 * @param {number} strike 1 = premier manquement dans la fenêtre
 * @returns {'delete'|'timeout'|'kick'|'ban'}
 */
function sanctionForStrike(config, strike) {
  const cfg = config?.channelGuard ? config : normalizeConfig(config);
  const n = Number.isFinite(strike) && strike > 0 ? Math.trunc(strike) : 1;
  if (n >= cfg.strikesBeforeBan) return 'ban';
  return cfg.punishment;
}

function describeSanction(sanction) {
  switch (sanction) {
    case 'ban':     return 'bannissement';
    case 'kick':    return 'expulsion';
    case 'timeout': return 'exclusion temporaire';
    case 'delete':  return 'suppression du message';
    default:        return String(sanction || 'aucune');
  }
}

// ─── Noms de salons ──────────────────────────────────────────────────────────
const INVITE_RE = /(?:discord\.gg|discord\.me|dsc\.gg|discord(?:app)?\.com\/invite)\S*/i;
const URL_RE = /https?:\/\//i;
const MENTION_RE = /(^|[^a-z0-9])@(everyone|here)\b|(?:<@[!&]?\d+>)/i;

/**
 * Le nom d'un salon est-il un vecteur d'attaque ?
 * @param {string} name
 * @param {string[]} [keywords] liste fournie par le serveur (vide = défauts)
 * @returns {{suspicious:boolean, reason:string|null, detail:string|null, keyword:string|null}}
 */
function channelNameVerdict(name, keywords) {
  const raw = String(name || '');
  const text = raw.toLowerCase();
  if (!text.trim()) return { suspicious: false, reason: null, detail: null, keyword: null };

  if (INVITE_RE.test(text)) {
    return { suspicious: true, reason: 'invite', detail: 'invitation Discord dans le nom', keyword: null };
  }
  if (MENTION_RE.test(raw)) {
    return { suspicious: true, reason: 'mention', detail: 'mention de masse dans le nom', keyword: null };
  }
  if (URL_RE.test(text)) {
    return { suspicious: true, reason: 'lien', detail: 'lien externe dans le nom', keyword: null };
  }

  // « free-nitro-ici » et « free_nitro » doivent être comparés comme des mots :
  // sans cette normalisation, les séparateurs des noms de salons font échouer
  // la recherche de formules contenant un espace.
  const words = text.replace(/[-_.]+/g, ' ');
  const list = normalizeKeywords(keywords);
  const hit = list.find(word => words.includes(word));
  if (hit) {
    return { suspicious: true, reason: 'keyword', detail: `formule « ${hit} »`, keyword: hit };
  }
  return { suspicious: false, reason: null, detail: null, keyword: null };
}

/**
 * Instantané d'un salon au moment de sa suppression, assez complet pour le
 * reconstruire à l'identique (nom, type, catégorie, position, sujet, lenteur,
 * bitrate, limite vocale, permissions).
 * @param {object} channel salon discord.js
 * @returns {object|null}
 */
function channelSnapshot(channel) {
  if (!channel || typeof channel.name !== 'string') return null;
  const collection = channel.permissionOverwrites?.cache;
  const overwrites = [];
  if (collection?.values) {
    for (const overwrite of collection.values()) {
      overwrites.push({
        id: overwrite.id,
        type: overwrite.type,
        allow: String(overwrite.allow?.bitfield ?? overwrite.allow ?? '0'),
        deny: String(overwrite.deny?.bitfield ?? overwrite.deny ?? '0'),
      });
    }
  }
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId ?? null,
    position: Number.isFinite(channel.rawPosition) ? channel.rawPosition : (channel.position ?? null),
    topic: channel.topic ?? null,
    nsfw: channel.nsfw === true,
    rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    bitrate: channel.bitrate ?? null,
    userLimit: channel.userLimit ?? null,
    permissionOverwrites: overwrites,
  };
}

/**
 * Options de création pour reconstruire un salon depuis un instantané.
 * Renvoie null si l'instantané est inutilisable (pas de nom).
 * @param {object} snapshot
 * @returns {object|null}
 */
function restoreOptionsFromSnapshot(snapshot) {
  if (!snapshot?.name) return null;
  return channelRestoreOptions({
    name: snapshot.name,
    type: snapshot.type,
    parentId: snapshot.parentId ?? null,
    position: snapshot.position ?? undefined,
    topic: snapshot.topic ?? null,
    nsfw: snapshot.nsfw ?? false,
    rateLimitPerUser: snapshot.rateLimitPerUser ?? 0,
    bitrate: snapshot.bitrate ?? null,
    userLimit: snapshot.userLimit ?? null,
    permissionOverwrites: snapshot.permissionOverwrites || [],
    reason: 'REZO — salon restauré après suppression suspecte',
  });
}

// ─── Confiance ───────────────────────────────────────────────────────────────
/**
 * Un auteur échappe-t-il à la garde des salons ?
 * Propriétaire, bot lui-même, listes de confiance et rôles de confiance.
 * @param {{userId?:string, guildOwnerId?:string, clientId?:string, roleIds?:string[]}} subject
 * @param {object} config
 */
function isTrusted(subject = {}, config = {}) {
  const cfg = config?.channelGuard ? config : normalizeConfig(config);
  const { userId, guildOwnerId = null, clientId = null, roleIds = [] } = subject;
  if (!userId) return false;
  if (guildOwnerId && userId === guildOwnerId) return true;
  if (clientId && userId === clientId) return true;
  if (cfg.trustedUsers.includes(userId)) return true;
  return (roleIds || []).some(id => cfg.trustedRoles.includes(id));
}

module.exports = {
  DEFAULT_KEYWORDS,
  DEFAULTS,
  CHANNEL_DEFAULTS,
  PUNISHMENTS,
  MAX_KEYWORDS,
  RULES,
  boundedInt,
  normalizeKeywords,
  normalizePunishment,
  normalizeConfig,
  stripNonPinging,
  analyzeMessage,
  sanitizeMentions,
  sanctionForStrike,
  describeSanction,
  describeRule,
  channelNameVerdict,
  channelSnapshot,
  restoreOptionsFromSnapshot,
  isTrusted,
};
