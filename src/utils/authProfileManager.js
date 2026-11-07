// utils/authProfileManager.js — Logique centrale du système d'authentification personnel
'use strict';

const crypto = require('crypto');
const AuthProfile = require('../models/AuthProfile');
const totp = require('./totp');
const { COLORS } = require('./embeds');

const MAX_LOGS = 50;
const PIN_LOCK_THRESHOLD = 5;
const PIN_LOCK_DURATION_MS = 15 * 60 * 1000; // 15 min
const MAX_PASSKEYS = 5;
const FORGOT_DELAY_MS = 60 * 60 * 1000; // 1h de délai de sûreté avant réinitialisation

// ─── Clé de chiffrement AES-256-GCM pour les secrets 2FA ────────────────────
// Doit être une chaîne hex de 64 caractères (32 octets) dans .env → AUTH_ENCRYPTION_KEY
//
// Pourquoi un contrôle aussi strict : sans clé valide, chiffrer un secret 2FA
// est impossible — et l'erreur doit être EXPLIQUÉE à l'utilisateur, pas laisser
// une interaction sans réponse (le cas avant : `getEncKey()` levait au milieu
// du gestionnaire de bouton).
const KEY_RE = /^[0-9a-f]{64}$/i;
const NO_KEY_MESSAGE =
  'AUTH_ENCRYPTION_KEY manquant ou invalide dans .env (chaîne hex de 64 caractères attendue). ' +
  'Générez-la avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

function isEncryptionAvailable(env = process.env) {
  return KEY_RE.test(String(env.AUTH_ENCRYPTION_KEY || ''));
}

function getEncKey() {
  const raw = String(process.env.AUTH_ENCRYPTION_KEY || '');
  if (!KEY_RE.test(raw)) {
    const err = new Error(NO_KEY_MESSAGE);
    err.code = 'AUTH_NO_KEY';
    throw err;
  }
  return Buffer.from(raw, 'hex');
}

function encryptionError(err) {
  const error = new Error(
    err?.code === 'AUTH_NO_KEY'
      ? NO_KEY_MESSAGE
      : 'Le secret 2FA enregistré est illisible (clé de chiffrement changée ?). Réactivez la 2FA.',
  );
  error.code = err?.code === 'AUTH_NO_KEY' ? 'AUTH_NO_KEY' : 'AUTH_BAD_CIPHER';
  return error;
}

function encrypt(text) {
  let key;
  try {
    key = getEncKey();
  } catch (err) {
    throw encryptionError(err);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payloadB64) {
  let key;
  try {
    key = getEncKey();
  } catch (err) {
    throw encryptionError(err);
  }
  try {
    const buf = Buffer.from(String(payloadB64), 'base64');
    if (buf.length < 29) throw new Error('charge utile trop courte');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (err) {
    throw encryptionError(err);
  }
}

// ─── Hachage PIN / codes de secours (scrypt) ─────────────────────────────────
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  return { hash, salt };
}

function verifySecret(secret, hash, salt) {
  if (!hash || !salt) return false;
  const attempt = crypto.scryptSync(String(secret), salt, 64).toString('hex');
  const a = Buffer.from(attempt, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Force du PIN ─────────────────────────────────────────────────────────
const WEAK_PINS = new Set([
  '1234', '4321', '0000', '1111', '1212', '2121', '2580', '1010', '0101',
  '123456', '654321', '000000', '111111', '121212', '123123', '112233', '332211',
  '12345', '54321', '6969', '4242',
]);

function isPinWeak(pin) {
  const s = String(pin ?? '').trim();
  if (!/^\d{4,8}$/.test(s)) return true; // format inattendu = considéré faible
  if (WEAK_PINS.has(s)) return true;
  if (/^(\d)\1+$/.test(s)) return true;      // 1111, 777777…
  if (/^(\d\d)\1+$/.test(s)) return true;   // 121212, 123123…

  // Suite croissante ou décroissante de 3 chiffres ou plus : 1234, 9876, 0123…
  const ascending = '0123456789';
  const descending = '9876543210';
  if (ascending.includes(s) || descending.includes(s)) return true;

  // Suite de 3+ chiffres consécutifs n'importe où dans le PIN (ex. 12945678).
  for (let i = 0; i <= s.length - 3; i++) {
    const a = Number(s[i]);
    const b = Number(s[i + 1]);
    const c = Number(s[i + 2]);
    if ((b === a + 1 && c === b + 1) || (b === a - 1 && c === b - 1)) return true;
  }
  return false;
}

// ─── Récupération / création du profil ───────────────────────────────────
async function getOrCreateProfile(userId) {
  let profile = await AuthProfile.findOne({ userId });
  if (!profile) profile = await AuthProfile.create({ userId });
  return profile;
}

// ─── Logs ──────────────────────────────────────────────────────────────────
async function addLog(profile, action, detail = '') {
  profile.logs.unshift({ action, detail, date: new Date() });
  if (profile.logs.length > MAX_LOGS) profile.logs = profile.logs.slice(0, MAX_LOGS);
  await profile.save();
}

const LOG_LABELS = {
  pin_set:        '🔢 Code PIN défini',
  pin_changed:    '🔢 Code PIN modifié',
  pin_failed:     '⚠️ Tentative de PIN échouée',
  pin_locked:     '🔒 Compte verrouillé (trop de tentatives)',
  twofa_enabled:  '⏱️ 2FA activée',
  twofa_disabled: '⏱️ 2FA désactivée',
  passkey_added:  '🔑 Passkey ajoutée',
  passkey_used:   '🔑 Passkey utilisée',
  passkey_revoked:'🔑 Passkey révoquée',
  forgot_requested: '🆘 Réinitialisation demandée',
  forgot_completed: '🆘 Tous les moyens d\'authentification ont été réinitialisés',
  forgot_cancelled: '🆘 Demande de réinitialisation annulée',
};

function formatLog(entry) {
  const label = LOG_LABELS[entry.action] || entry.action;
  const ts = Math.floor(new Date(entry.date).getTime() / 1000);
  return `<t:${ts}:R> — ${label}${entry.detail ? ` · ${entry.detail}` : ''}`;
}

// ─── Grade de sécurité ────────────────────────────────────────────────────
// F: rien configuré · E: PIN faible seul · D: PIN correct seul
// C: PIN + (2FA ou Passkey) · B: PIN + 2FA + Passkey · A: B + PIN fort + aucun verrou récent
function computeGrade(profile) {
  const hasPin = !!profile.pin?.isSet;
  const pinWeak = !!profile.pin?.weak;
  const has2FA = !!profile.twoFA?.enabled;
  const activePasskeys = (profile.passkeys || []).filter(p => !p.used).length;
  const hasPasskey = activePasskeys > 0;

  let grade = 'F';
  if (hasPin && pinWeak) grade = 'E';
  else if (hasPin && !pinWeak) grade = 'D';
  if (hasPin && (has2FA || hasPasskey)) grade = 'C';
  if (hasPin && has2FA && hasPasskey) grade = 'B';
  if (hasPin && !pinWeak && has2FA && hasPasskey) grade = 'A';

  const GRADE_META = {
    A: { emoji: '🟩', color: 0x57F287, tip: 'Excellent ! Votre compte est très bien protégé.' },
    B: { emoji: '🟫', color: COLORS.wine, tip: 'Très bon niveau de sécurité.' },
    C: { emoji: '🟨', color: 0xFEE75C, tip: 'Ajoutez une Passkey ou activez la 2FA pour améliorer votre grade.' },
    D: { emoji: '🟧', color: 0xF39C12, tip: 'Activez la 2FA pour améliorer votre grade de sécurité.' },
    E: { emoji: '🟧', color: 0xE67E22, tip: 'Votre code PIN est trop simple. Changez-le puis activez la 2FA.' },
    F: { emoji: '🟥', color: 0xED4245, tip: 'Aucune protection configurée ! Définissez un code PIN dès maintenant.' },
  };

  return { grade, ...GRADE_META[grade] };
}

// ─── PIN : vérification avec verrouillage anti-bruteforce ───────────────────
async function checkPin(profile, attempt) {
  if (!profile.pin?.isSet) return { ok: false, notSet: true };

  if (profile.pin.lockedUntil && profile.pin.lockedUntil > new Date()) {
    const remaining = Math.max(1, Math.ceil((profile.pin.lockedUntil.getTime() - Date.now()) / 60000));
    return { ok: false, locked: true, remainingMinutes: remaining };
  }

  // Verrou expiré : on repart d'un compteur propre plutôt que de le traîner.
  if (profile.pin.lockedUntil && profile.pin.lockedUntil <= new Date()) {
    profile.pin.lockedUntil = null;
    profile.pin.failedAttempts = 0;
  }

  if (verifySecret(attempt, profile.pin.hash, profile.pin.salt)) {
    profile.pin.failedAttempts = 0;
    profile.pin.lockedUntil = null;
    await profile.save();
    return { ok: true };
  }

  profile.pin.failedAttempts = (profile.pin.failedAttempts || 0) + 1;
  const attempts = profile.pin.failedAttempts;

  // addLog() enregistre le profil : une seule écriture en base par essai raté.
  if (attempts >= PIN_LOCK_THRESHOLD) {
    profile.pin.lockedUntil = new Date(Date.now() + PIN_LOCK_DURATION_MS);
    profile.pin.failedAttempts = 0;
    await addLog(profile, 'pin_locked', `${attempts} essais`);
    return { ok: false, locked: true, remainingMinutes: Math.ceil(PIN_LOCK_DURATION_MS / 60000), justLocked: true };
  }

  await addLog(profile, 'pin_failed', `${attempts}/${PIN_LOCK_THRESHOLD}`);
  return { ok: false, locked: false, remainingAttempts: PIN_LOCK_THRESHOLD - attempts };
}

// ─── 2FA : vérification avec protection contre le rejeu ──────────────────────
// Un code TOTP reste valable ~30 s : sans mémoire du dernier compteur utilisé,
// le même code peut être présenté deux fois. On refuse donc tout compteur déjà
// consommé, et on enregistre celui qui vient de l'être.
async function consumeTotp(profile, code, { window = 1, forTime = Date.now() } = {}) {
  if (!profile.twoFA?.enabled || !profile.twoFA?.secretEnc) return { ok: false, reason: 'disabled' };

  let secret;
  try {
    secret = decrypt(profile.twoFA.secretEnc);
  } catch (err) {
    return { ok: false, reason: 'unreadable', error: err };
  }

  const counter = totp.matchCounter(secret, code, { window, forTime });
  if (counter === null) return { ok: false, reason: 'invalid' };

  const last = Number.isFinite(profile.twoFA.lastCounter) ? profile.twoFA.lastCounter : -1;
  if (counter <= last) return { ok: false, reason: 'replay' };

  profile.twoFA.lastCounter = counter;
  await profile.save();
  return { ok: true, counter };
}

// ─── Codes de secours (Passkeys) : consommation à usage unique ────────────────
function findPasskey(profile, code) {
  const raw = String(code ?? '').replace(/[\s-]+/g, '').toUpperCase();
  if (raw.length < 8) return null;
  const passkeys = Array.isArray(profile.passkeys) ? profile.passkeys : [];
  for (const passkey of passkeys) {
    if (passkey.used) continue;
    if (verifySecret(raw, passkey.codeHash, passkey.salt)) return passkey;
  }
  return null;
}

async function consumePasskey(profile, code) {
  const passkey = findPasskey(profile, code);
  if (!passkey) return null;
  passkey.used = true;
  passkey.lastUsedAt = new Date();
  await profile.save();
  await addLog(profile, 'passkey_used', passkey.label);
  return passkey;
}

module.exports = {
  encrypt,
  decrypt,
  isEncryptionAvailable,
  hashSecret,
  verifySecret,
  isPinWeak,
  getOrCreateProfile,
  addLog,
  formatLog,
  computeGrade,
  checkPin,
  consumeTotp,
  findPasskey,
  consumePasskey,
  MAX_PASSKEYS,
  FORGOT_DELAY_MS,
  PIN_LOCK_THRESHOLD,
  PIN_LOCK_DURATION_MS,
};
