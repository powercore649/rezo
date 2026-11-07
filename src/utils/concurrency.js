'use strict';
// utils/concurrency.js — Parallélisme BORNÉ pour les traitements multi-serveurs.
//
// Les planificateurs et les crons parcourent tous les serveurs configurés :
// `for (const cfg of configs) { await fetch(...) }`. Sur quelques serveurs, la
// boucle séquentielle suffit ; sur plusieurs milliers, elle met des minutes,
// deux exécutions se chevauchent et le travail s'empile (doublons, mémoire).
//
// `mapLimit` exécute le même travail avec au plus `limit` opérations en vol :
// assez pour absorber la latence réseau, jamais assez pour saturer la base,
// l'API Discord ou la mémoire.
//
// Règle de sûreté : une erreur sur un élément n'interrompt JAMAIS les autres
// (chaque serveur est isolé). L'appelant reçoit, pour chaque élément, soit
// `{ ok: true, value }`, soit `{ ok: false, error }`.

const DEFAULT_LIMIT = 8;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback;
}

/** Borne de parallélisme par défaut (réglable par CONCURRENCY_LIMIT). */
function defaultLimit() {
  return envInt('CONCURRENCY_LIMIT', DEFAULT_LIMIT);
}

/**
 * Applique `worker` à chaque élément avec au plus `limit` en vol.
 * L'ordre du tableau de sortie est celui des entrées.
 *
 * @param {Iterable} items
 * @param {number|Function} limit  Nombre d'opérations simultanées.
 * @param {Function} worker        async (item, index) => value
 * @returns {Promise<Array<{ok: boolean, value?: any, error?: Error}>>}
 */
async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [...items];
  const size = Math.max(1, Math.min(Math.trunc(Number(limit)) || DEFAULT_LIMIT, list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;

  async function run() {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = { ok: true, value: await worker(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, run));
  return results;
}

/**
 * Variante utilitaire : ne renvoie que les valeurs réussies, et signale les
 * échecs via `onError(item, error)` (utilisée par les planificateurs qui
 * veulent simplement ignorer proprement un serveur en panne).
 */
async function forEachLimit(items, limit, worker, { onError = null } = {}) {
  const list = Array.isArray(items) ? items : [...items];
  const outcomes = await mapLimit(list, limit, worker);
  const errors = [];
  outcomes.forEach((outcome, index) => {
    if (!outcome.ok) {
      errors.push({ item: list[index], error: outcome.error });
      if (onError) {
        try { onError(list[index], outcome.error); } catch { /* jamais bloquant */ }
      }
    }
  });
  return { processed: list.length, failed: errors.length, errors };
}

/**
 * Empêche deux exécutions simultanées d'une même tâche de se chevaucher : si la
 * précédente tourne encore, la nouvelle est ignorée (et signalée), au lieu de
 * s'empiler et de doubler les envois.
 *
 * @param {Function} task        Tâche à protéger.
 * @param {Function} [onSkip]    Appelé quand une exécution est ignorée.
 */
function serialized(task, { onSkip = null, name = 'tâche' } = {}) {
  let running = null;
  return async function run(...args) {
    if (running) {
      if (onSkip) {
        try { onSkip(name); } catch { /* ignore */ }
      }
      return { skipped: true, reason: 'exécution précédente en cours', name };
    }
    running = Promise.resolve()
      .then(() => task.apply(this, args))
      .finally(() => { running = null; });
    return running;
  };
}

/** Découpe une liste en tranches de `size` (traitement par lots « IN (...) »). */
function chunk(items, size = 50) {
  const list = Array.isArray(items) ? items : [...items];
  const step = Math.max(1, Math.trunc(size));
  const out = [];
  for (let i = 0; i < list.length; i += step) out.push(list.slice(i, i + step));
  return out;
}

module.exports = { mapLimit, forEachLimit, serialized, chunk, defaultLimit, DEFAULT_LIMIT };
