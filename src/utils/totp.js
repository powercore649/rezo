'use strict';
// utils/totp.js — TOTP (RFC 6238) + Base32 (RFC 4648), sans dépendance externe.
//
// Utilisé par /authentificator (2FA) et par le système de récupération. Trois
// règles de robustesse, apprises à la dure :
//   1. un code de mauvaise longueur ne doit JAMAIS faire planter la commande —
//      `crypto.timingSafeEqual` lève une exception si les tampons diffèrent ;
//   2. un code ne doit pas pouvoir être rejoué pendant sa fenêtre de validité —
//      d'où `matchCounter`, qui renvoie le compteur effectivement consommé ;
//   3. un secret vide ou illisible doit être refusé, pas « calculé ».

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;

// ─── Base32 ────────────────────────────────────────────────────────────────
function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');

  let output = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.substring(i, i + 5).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return output;
}

/** Retire espaces, tirets et remplissage : un secret recopié à la main reste lisible. */
function normalizeBase32(str) {
  return String(str ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
}

function base32Decode(str) {
  const clean = normalizeBase32(str);
  let bits = '';
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// ─── Génération du secret ────────────────────────────────────────────────────
function generateSecret(byteLength = 20) {
  return base32Encode(crypto.randomBytes(byteLength));
}

// ─── URI otpauth:// (QR code ou saisie manuelle) ─────────────────────────────
function generateURI(secretBase32, accountLabel, issuer = 'REZO') {
  const account = String(accountLabel || 'compte').replace(/[:]/g, '-');
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: normalizeBase32(secretBase32),
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ─── HOTP : un code pour un compteur donné ──────────────────────────────────
function hotp(secretBase32, counter, digits = DEFAULT_DIGITS) {
  const key = base32Decode(secretBase32);
  if (!key.length) return null; // secret vide / illisible : aucun code possible

  const count = BigInt(Math.floor(counter));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(count);

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binCode % 10 ** digits).padStart(digits, '0');
}

function generateTOTP(secretBase32, { period = DEFAULT_PERIOD, digits = DEFAULT_DIGITS, forTime = Date.now() } = {}) {
  return hotp(secretBase32, Math.floor(forTime / 1000 / period), digits);
}

// ─── Vérification ───────────────────────────────────────────────────────────
function cleanToken(token) {
  return String(token ?? '').replace(/[\s-]+/g, '');
}

/**
 * Cherche le compteur qui produit `token` dans la fenêtre de tolérance.
 * @returns {number|null} le compteur consommé (à mémoriser pour l'anti-rejeu),
 *   ou null si le code ne correspond à aucun pas de temps.
 */
function matchCounter(secretBase32, token, {
  period = DEFAULT_PERIOD,
  digits = DEFAULT_DIGITS,
  window = 1,
  forTime = Date.now(),
} = {}) {
  const value = cleanToken(token);
  // Longueur stricte : « 12345 » ne doit pas devenir « 012345 » par complément.
  if (value.length !== digits || !/^\d+$/.test(value)) return null;

  const key = base32Decode(secretBase32);
  if (!key.length) return null;

  const current = Math.floor(forTime / 1000 / period);
  const given = Buffer.from(value);
  for (let offset = -Math.abs(window); offset <= Math.abs(window); offset++) {
    const candidate = hotp(secretBase32, current + offset, digits);
    if (!candidate) continue;
    const expected = Buffer.from(candidate);
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
      return current + offset;
    }
  }
  return null;
}

/** Vérification simple (usage ponctuel) — voir `matchCounter` pour l'anti-rejeu. */
function verifyTOTP(secretBase32, token, options = {}) {
  return matchCounter(secretBase32, token, options) !== null;
}

/** Combien de secondes reste-t-il avant le prochain code ? (affichage) */
function secondsRemaining({ period = DEFAULT_PERIOD, forTime = Date.now() } = {}) {
  const elapsed = (forTime / 1000) % period;
  return Math.max(0, Math.ceil(period - elapsed));
}

module.exports = {
  BASE32_ALPHABET,
  DEFAULT_PERIOD,
  DEFAULT_DIGITS,
  base32Encode,
  base32Decode,
  normalizeBase32,
  generateSecret,
  generateURI,
  hotp,
  generateTOTP,
  matchCounter,
  verifyTOTP,
  secondsRemaining,
};
