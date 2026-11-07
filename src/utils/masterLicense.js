'use strict';
// utils/masterLicense.js — Licence maître du système de licence REZO.
//
// Problème : le dépôt est public. Sans garde-fou, n'importe quelle copie du bot
// peut appeler `licenseIssuer.issueKey()` ou `licenseGate.createLicense()` et
// fabriquer des clés `REZO-…`, donc s'offrir — ou revendre — les modules
// premium. Une simple vérification en base ne suffit pas : celui qui contrôle
// la base écrit le document qu'il veut.
//
// Réponse : une licence maître signée en Ed25519.
//   • la clé PUBLIQUE vit dans le dépôt (`src/data/masterLicensePublicKey.pem`) ;
//   • la clé PRIVÉE n'existe que dans le `.env` de l'instance émettrice
//     (`MASTER_SIGNING_KEY`, jamais versionnée) ;
//   • `MASTER_LICENSE` contient un jeton signé, de portée « issuer » et daté.
//
// Le bot vérifie ce jeton avant CHAQUE émission. Cloner le dépôt ne donne donc
// pas le droit d'émettre : sans la clé privée, impossible de produire une
// signature valide. Le contrôle est local (aucun appel réseau) : une panne de
// réseau ne peut pas couper le système de licence.
//
// Format du jeton : `rezomaster1.<charge utile base64url>.<signature base64url>`
// La signature couvre la chaîne `rezomaster1.<charge utile>` telle quelle.
// Charge utile : { v: 1, scope: 'issuer', sub, iat, exp, note } (dates en s).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'rezomaster1';
const TOKEN_VERSION = 1;
const SCOPE = 'issuer';
const PUBLIC_KEY_PATH = path.join(__dirname, '..', 'data', 'masterLicensePublicKey.pem');
const CACHE_TTL_MS = 60_000;
// Tolérance d'horloge : une instance un peu en avance ne doit pas être refusée.
const CLOCK_SKEW_MS = 5 * 60_000;

// Messages affichés à l'owner : dire précisément ce qui manque, jamais un
// « erreur inconnue » qui laisse croire à une panne.
const REASONS = {
  missing:        'Aucune licence maître : `MASTER_LICENSE` est vide. L’émission de clés est verrouillée.',
  no_public_key:  'Clé publique absente (`src/data/masterLicensePublicKey.pem`) : la licence maître est invérifiable.',
  format:         'Jeton de licence maître illisible (format inattendu).',
  signature:      'Signature de la licence maître invalide : le jeton a été modifié ou signé par une autre clé.',
  scope:          'Ce jeton n’autorise pas l’émission de clés (portée ≠ « issuer »).',
  expired:        'Licence maître expirée : signe un nouveau jeton avec `npm run master:sign`.',
  not_yet_valid:  'Licence maître datée dans le futur : vérifie l’horloge de la machine.',
  public_key:     'Clé publique illisible : vérifie `src/data/masterLicensePublicKey.pem`.',
  valid:          'Licence maître valide.',
};

function message(reason) {
  return REASONS[reason] || 'Licence maître invalide.';
}

// ── Encodage ─────────────────────────────────────────────────────────────────
function toB64url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromB64url(text) {
  return Buffer.from(String(text), 'base64url');
}

// ── Clés ─────────────────────────────────────────────────────────────────────
// La clé peut être fournie en PEM sur une ligne (`\\n` échappés) via
// `MASTER_PUBLIC_KEY` : pratique en hébergement où l'on ne peut pas déposer de
// fichier. Sinon, c'est le fichier du dépôt qui fait foi.
function loadPublicKey() {
  const inline = String(process.env.MASTER_PUBLIC_KEY || '').trim();
  if (inline) return inline.replace(/\\n/g, '\n');
  try {
    return fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
  } catch {
    return null;
  }
}

/** Paire Ed25519 neuve, en PEM (utilisée par le script et les tests). */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/**
 * Signe une charge utile et renvoie le jeton compact.
 * @param {object} payload  { sub?, iat?, exp?, note? } — iat/exp en secondes
 * @param {string} privateKeyPem
 */
function signToken(payload = {}, privateKeyPem) {
  if (!privateKeyPem) throw new Error('signToken : clé privée requise');
  const body = {
    v: TOKEN_VERSION,
    scope: SCOPE,
    ...payload,
  };
  const encoded = toB64url(JSON.stringify(body));
  const signed = `${PREFIX}.${encoded}`;
  const signature = crypto.sign(null, Buffer.from(signed), privateKeyPem);
  return `${signed}.${toB64url(signature)}`;
}

/**
 * Vérifie un jeton. Ne lève jamais : renvoie une décision explicite.
 * @returns {{ok:boolean, reason:string, message:string, payload?:object, expiresAt?:Date}}
 */
function verifyToken(token, { publicKey = null, now = Date.now() } = {}) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, reason: 'missing', message: message('missing') };

  const key = publicKey || loadPublicKey();
  if (!key) return { ok: false, reason: 'no_public_key', message: message('no_public_key') };

  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return { ok: false, reason: 'format', message: message('format') };
  }

  const [, encoded, signature] = parts;
  let payload;
  try {
    payload = JSON.parse(fromB64url(encoded).toString('utf8'));
  } catch {
    return { ok: false, reason: 'format', message: message('format') };
  }

  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(`${PREFIX}.${encoded}`),
      key,
      fromB64url(signature),
    );
  } catch {
    return { ok: false, reason: 'public_key', message: message('public_key') };
  }
  if (!valid) return { ok: false, reason: 'signature', message: message('signature') };

  if (!payload || payload.v !== TOKEN_VERSION) {
    return { ok: false, reason: 'format', message: message('format') };
  }
  if (payload.scope !== SCOPE) {
    return { ok: false, reason: 'scope', message: message('scope'), payload };
  }

  const exp = Number(payload.exp) * 1000;
  const iat = Number(payload.iat) * 1000;
  if (!Number.isFinite(exp)) {
    return { ok: false, reason: 'format', message: message('format'), payload };
  }
  if (now > exp) {
    return { ok: false, reason: 'expired', message: message('expired'), payload, expiresAt: new Date(exp) };
  }
  if (Number.isFinite(iat) && iat - CLOCK_SKEW_MS > now) {
    return { ok: false, reason: 'not_yet_valid', message: message('not_yet_valid'), payload, expiresAt: new Date(exp) };
  }

  return { ok: true, reason: 'valid', message: message('valid'), payload, expiresAt: new Date(exp) };
}

// ── État courant (avec cache) ────────────────────────────────────────────────
// Une vérification Ed25519 est peu coûteuse, mais elle est appelée à chaque
// émission : un cache de 60 s suffit et évite de relire le fichier à chaque fois.
let cache = null;

function status({ token = process.env.MASTER_LICENSE, publicKey = null, now = Date.now() } = {}) {
  const raw = String(token || '').trim();
  if (!publicKey && cache && cache.token === raw && now - cache.checkedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  const value = verifyToken(raw, { publicKey, now });
  if (!publicKey) cache = { token: raw, checkedAt: now, value };
  return value;
}

/** Décision d'émission : `{ ok:false, code:'master_locked', … }` si verrouillé. */
function guard(options = {}) {
  const state = status(options);
  if (state.ok) return state;
  return { ...state, ok: false, code: 'master_locked' };
}

/** Vide le cache (script, tests, changement de `.env` à chaud). */
function resetCache() {
  cache = null;
}

module.exports = {
  PREFIX,
  TOKEN_VERSION,
  SCOPE,
  PUBLIC_KEY_PATH,
  CACHE_TTL_MS,
  REASONS,
  message,
  loadPublicKey,
  generateKeyPair,
  signToken,
  verifyToken,
  status,
  guard,
  resetCache,
};
