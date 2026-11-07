'use strict';
// utils/captchaEngine.js — Logique métier pure du captcha (aucune dépendance Discord/Canvas/DB)

/**
 * @param {Date} accountCreatedAt
 * @param {number} minDays - 0 = désactivé
 * @param {Date} [now]
 */
function checkAccountAge(accountCreatedAt, minDays, now = new Date()) {
  if (!minDays || minDays <= 0) return { ok: true };
  const ageDays = (now.getTime() - new Date(accountCreatedAt).getTime()) / 86_400_000;
  if (ageDays >= minDays) return { ok: true };
  return { ok: false, ageDays: Math.floor(ageDays * 10) / 10 };
}

/**
 * @param {string[]} memberRoleIds
 * @param {string|null} bypassRoleId
 */
function checkBypass(memberRoleIds = [], bypassRoleId) {
  if (!bypassRoleId) return false;
  return memberRoleIds.includes(bypassRoleId);
}

/**
 * Compare la réponse fournie au code attendu.
 * @param {string} input
 * @param {string} expected
 * @param {boolean} caseSensitive
 */
function compareAnswer(input, expected, caseSensitive = false) {
  const a = String(input ?? '').trim();
  const b = String(expected ?? '').trim();
  if (caseSensitive) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * @param {number} currentRegenerations
 * @param {number} maxRegenerations - 0 = pas de régénération autorisée
 */
function canRegenerate(currentRegenerations, maxRegenerations) {
  return (currentRegenerations || 0) < (maxRegenerations || 0);
}

/**
 * @param {number} currentAttempts (déjà incrémenté pour la tentative en cours)
 * @param {number} maxAttempts
 */
function attemptsExhausted(currentAttempts, maxAttempts) {
  return currentAttempts >= maxAttempts;
}

module.exports = { checkAccountAge, checkBypass, compareAnswer, canRegenerate, attemptsExhausted };
