'use strict';
// utils/aiQuotaEngine.js — Logique pure : détection d'erreur de quota, rotation de
// modèle, calcul de cooldown. Aucune dépendance réseau/Discord/DB.

const DEFAULT_COOLDOWN_MINUTES = 60;

/**
 * Détecte si une erreur renvoyée par l'API Gemini correspond à un dépassement de quota
 * (HTTP 429 / RESOURCE_EXHAUSTED), par opposition à une autre erreur (réseau, clé invalide...).
 */
function isQuotaError(err) {
  if (!err) return false;
  const status = err.status || err.code || err.response?.status;
  if (status === 429) return true;
  const msg = `${err.message || ''} ${JSON.stringify(err.errorDetails || err.details || '')}`.toLowerCase();
  return /resource_exhausted|quota|rate limit|too many requests/.test(msg);
}

/**
 * @param {Date|null} now
 * @param {number} minutes
 */
function computeCooldownUntil(now = new Date(), minutes = DEFAULT_COOLDOWN_MINUTES) {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Choisit le premier modèle de la chaîne qui n'est PAS actuellement en cooldown.
 * @param {string[]} modelChain - ordre de préférence
 * @param {Object<string, {unavailableUntil: Date|null}>} statusMap - état par modèle
 * @param {Date} [now]
 * @returns {{ model: string|null, allExhausted: boolean }}
 */
function pickAvailableModel(modelChain, statusMap = {}, now = new Date()) {
  if (!modelChain?.length) return { model: null, allExhausted: true };

  for (const model of modelChain) {
    const status = statusMap[model];
    const until = status?.unavailableUntil ? new Date(status.unavailableUntil) : null;
    if (!until || until <= now) {
      return { model, allExhausted: false };
    }
  }

  // Tous en cooldown : on retourne celui qui se libère le plus tôt (pour affichage/retry proche)
  let soonest = modelChain[0];
  let soonestTime = statusMap[soonest]?.unavailableUntil ? new Date(statusMap[soonest].unavailableUntil) : now;
  for (const model of modelChain) {
    const until = statusMap[model]?.unavailableUntil ? new Date(statusMap[model].unavailableUntil) : now;
    if (until < soonestTime) { soonest = model; soonestTime = until; }
  }
  return { model: null, allExhausted: true, soonestAvailable: soonest, soonestAt: soonestTime };
}

/**
 * Parse une chaîne "modelA, modelB, modelC" saisie dans un modal en tableau propre.
 */
function parseModelChainInput(input) {
  return String(input || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

module.exports = { isQuotaError, computeCooldownUntil, pickAvailableModel, parseModelChainInput, DEFAULT_COOLDOWN_MINUTES };
