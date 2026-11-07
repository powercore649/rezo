'use strict';
// utils/commandVaultEngine.js — Décisions pures du coffre d'accès.
//
// Aucune dépendance Discord ni MongoDB : tout est testable hors-ligne (voir
// tests/command-vault.test.js). Le code d'accès est haché avec scrypt et un sel
// aléatoire ; la comparaison est à temps constant. Rien n'est jamais stocké en
// clair, et aucun mécanisme ne permet de retrouver un code oublié : on en
// définit un nouveau.
//
// Ce système est volontairement SÉPARÉ du système de licences : il ne vérifie
// ni abonnement, ni clé, ni serveur distant. Il répond à une seule question :
// « cette personne a-t-elle le droit d'ouvrir ce panneau sur ce serveur ? »

const crypto = require('crypto');

const MIN_CODE_LENGTH = 8;
const MAX_CODE_LENGTH = 128;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;
const SESSION_MS = 10 * 60_000;
const MAX_FAILURES = 50;

// Paramètres scrypt : coût raisonnable pour une commande manuelle (~50 ms), très
// loin du brute-force confortable pour un code de 8 caractères.
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };

/**
 * Hache un code avec un sel (aléatoire si absent).
 * @param {string} code
 * @param {string} [salt] sel hexadécimal (pour vérifier un code existant)
 * @returns {{salt:string, hash:string}}
 */
function hashCode(code, salt) {
  const useSalt = typeof salt === 'string' && salt.length ? salt : crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(String(code), useSalt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
    .toString('hex');
  return { salt: useSalt, hash };
}

/**
 * Vérifie un code contre un hachage stocké, à temps constant.
 * @param {string} code
 * @param {{salt?:string, hash?:string}} stored
 * @returns {boolean}
 */
function verifyCode(code, stored = {}) {
  if (!stored || !stored.salt || !stored.hash) return false;
  let computed;
  try {
    computed = Buffer.from(hashCode(code, stored.salt).hash, 'hex');
  } catch (_) {
    return false;
  }
  const expected = Buffer.from(String(stored.hash), 'hex');
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
}

/**
 * Un code est-il acceptable ? (longueur, contenu)
 * @param {string} code
 * @returns {{ok:boolean, reason:string|null}}
 */
function validateCode(code) {
  const value = String(code ?? '');
  if (!value.trim()) return { ok: false, reason: 'le code est vide' };
  if (value.length < MIN_CODE_LENGTH) return { ok: false, reason: `il faut au moins ${MIN_CODE_LENGTH} caractères` };
  if (value.length > MAX_CODE_LENGTH) return { ok: false, reason: `il faut au plus ${MAX_CODE_LENGTH} caractères` };
  if (/^\s|\s$/.test(value)) return { ok: false, reason: 'les espaces en début et en fin sont ambigus' };
  return { ok: true, reason: null };
}

/**
 * Décide de l'accès.
 * Ordre : propriétaire → membre autorisé → rôle autorisé → verrouillage →
 * code exigé → refus (aucun code défini).
 * @param {{userId?:string, guildOwnerId?:string, roleIds?:string[], authorizedUsers?:string[],
 *          authorizedRoles?:string[], hasCode?:boolean, lockedUntil?:number, now?:number}} subject
 * @returns {{allowed:boolean, reason:string, needsCode:boolean, retryAt?:number}}
 */
function decideAccess(subject = {}) {
  const {
    userId, guildOwnerId = null, roleIds = [],
    authorizedUsers = [], authorizedRoles = [],
    hasCode = false, lockedUntil = 0, now = Date.now(),
  } = subject;

  if (!userId) return { allowed: false, reason: 'denied', needsCode: false };
  if (guildOwnerId && userId === guildOwnerId) return { allowed: true, reason: 'owner', needsCode: false };
  if ((authorizedUsers || []).includes(userId)) return { allowed: true, reason: 'authorized', needsCode: false };
  if ((authorizedRoles || []).length && (roleIds || []).some(id => authorizedRoles.includes(id))) {
    return { allowed: true, reason: 'role', needsCode: false };
  }
  if (Number(lockedUntil) > now) {
    return { allowed: false, reason: 'locked', needsCode: false, retryAt: Number(lockedUntil) };
  }
  if (hasCode) return { allowed: false, reason: 'code-required', needsCode: true };
  return { allowed: false, reason: 'no-code', needsCode: false };
}

/**
 * Enregistre un échec et renvoie la nouvelle entrée.
 * Cinq échecs dans la fenêtre verrouillent l'accès quinze minutes ; la fenêtre
 * glisse, donc un utilisateur qui se trompe une fois par semaine n'est jamais
 * verrouillé.
 * @param {{userId?:string, count?:number, lastAt?:number}} previous
 * @param {number} [now]
 */
function registerFailure(previous = {}, now = Date.now()) {
  const lastAt = Number(previous.lastAt) || 0;
  const stale = !lastAt || now - lastAt > FAILURE_WINDOW_MS;
  const count = (stale ? 0 : Number(previous.count) || 0) + 1;
  const locked = count >= MAX_ATTEMPTS;
  return {
    userId: previous.userId || null,
    count,
    lastAt: now,
    lockedUntil: locked ? now + LOCK_MS : 0,
  };
}

/** Millisecondes restantes avant la fin d'un verrouillage (0 si expiré). */
function remainingLockMs(lockedUntil, now = Date.now()) {
  return Math.max(0, Number(lockedUntil || 0) - now);
}

/** Tentatives restantes avant verrouillage. */
function remainingAttempts(count) {
  return Math.max(0, MAX_ATTEMPTS - (Number(count) || 0));
}

function describeReason(reason) {
  switch (reason) {
    case 'owner':      return 'propriétaire du serveur';
    case 'authorized': return 'membre autorisé';
    case 'role':       return 'rôle autorisé';
    case 'session':    return 'session déverrouillée (10 min)';
    case 'disabled':   return 'protection désactivée sur ce serveur';
    default:           return 'accès non autorisé';
  }
}

/**
 * Message de refus prêt à afficher, sans jamais révéler le code ni un hachage.
 * @param {{reason:string, retryAt?:number}} decision
 */
function describeDenial(decision = {}) {
  switch (decision.reason) {
    case 'locked': {
      const minutes = Math.max(1, Math.ceil(remainingLockMs(decision.retryAt) / 60_000));
      return `⛔ Accès verrouillé après trop de codes incorrects. Réessaie dans **${minutes} min**.`;
    }
    case 'no-code':
      return '🔐 Aucun code d’accès n’est défini : seul le **propriétaire** peut ouvrir ce panneau. Il peut définir un code, ou autoriser des membres et des rôles, depuis la section **Accès**.';
    case 'denied':
      return '⛔ Accès refusé : ce panneau est protégé.';
    default:
      return '⛔ Accès refusé.';
  }
}

module.exports = {
  MIN_CODE_LENGTH,
  MAX_CODE_LENGTH,
  MAX_ATTEMPTS,
  LOCK_MS,
  FAILURE_WINDOW_MS,
  SESSION_MS,
  MAX_FAILURES,
  SCRYPT,
  hashCode,
  verifyCode,
  validateCode,
  decideAccess,
  registerFailure,
  remainingLockMs,
  remainingAttempts,
  describeReason,
  describeDenial,
};
