'use strict';
// utils/boundedCache.js — Cache mémoire BORNÉ (LRU + TTL optionnel).
//
// Motif : le bot garde en mémoire une foule de petites tables (config par
// serveur, sessions vocales, cooldowns…). Une `Map` nue grandit avec le nombre
// de serveurs et ne redescend jamais : sur un bot qui rejoint des milliers de
// serveurs, c'est une fuite mémoire qui finit par tuer le processus.
//
// Ce module remplace ces `Map` par un cache qui :
//   • ne dépasse JAMAIS `max` entrées (éviction du moins récemment utilisé) ;
//   • oublie tout seul les entrées périmées (`ttl` en millisecondes) ;
//   • sait mémoriser une valeur négative (`null`) — indispensable pour ne pas
//     requêter en boucle un serveur qui n'a pas de configuration ;
//   • expose quelques compteurs (`stats()`) pour le diagnostic.
//
// Aucune dépendance, aucun timer : la purge est paresseuse (sur lecture) et
// peut être forcée (`purge()`), ce qui évite de garder un intervalle ouvert
// dans les tests.

const DEFAULT_MAX = 5000;

function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Crée un cache borné.
 *
 * @param {object}   [options]
 * @param {number}   [options.max]      Nombre maximal d'entrées (défaut 5000).
 * @param {number}   [options.ttl]      Durée de vie d'une entrée en ms (0 = aucune).
 * @param {string}   [options.name]     Nom affiché dans les statistiques.
 * @param {Function} [options.onEvict]  Appelé (clé, valeur, raison) à l'éviction.
 */
function createBoundedCache({ max = DEFAULT_MAX, ttl = 0, name = 'cache', onEvict = null } = {}) {
  const store = new Map();
  const limit = Math.max(1, Math.trunc(max) || DEFAULT_MAX);
  const lifetime = Math.max(0, Math.trunc(ttl) || 0);

  const counters = { hits: 0, misses: 0, expired: 0, evicted: 0, stale: 0, sets: 0 };

  function isStale(entry, now) {
    return lifetime > 0 && entry.expiresAt !== 0 && now >= entry.expiresAt;
  }

  function drop(key, reason) {
    const entry = store.get(key);
    if (entry === undefined) return false;
    store.delete(key);
    if (onEvict) {
      try { onEvict(key, entry.value, reason); } catch { /* un cache n'échoue jamais */ }
    }
    return true;
  }

  function trim() {
    while (store.size > limit) {
      // La Map conserve l'ordre d'insertion : la première clé est la plus
      // anciennement utilisée (chaque lecture repousse sa clé en fin).
      const oldest = store.keys().next();
      if (oldest.done) break;
      counters.evicted++;
      drop(oldest.value, 'lru');
    }
  }

  function get(key) {
    const entry = store.get(key);
    if (entry === undefined) {
      counters.misses++;
      return undefined;
    }
    if (isStale(entry, Date.now())) {
      counters.expired++;
      drop(key, 'expired');
      counters.misses++;
      return undefined;
    }
    // Repousse la clé en fin de Map = « récemment utilisée ».
    store.delete(key);
    store.set(key, entry);
    counters.hits++;
    return entry.value;
  }

  function has(key) {
    const entry = store.get(key);
    if (entry === undefined) return false;
    if (isStale(entry, Date.now())) {
      counters.expired++;
      drop(key, 'expired');
      return false;
    }
    return true;
  }

  function set(key, value, { ttl: entryTtl } = {}) {
    const ms = entryTtl === undefined ? lifetime : Math.max(0, Math.trunc(entryTtl) || 0);
    counters.sets++;
    drop(key, 'overwrite');
    store.set(key, { value, expiresAt: ms > 0 ? Date.now() + ms : 0 });
    trim();
    return value;
  }

  /** Lit la valeur, ou la calcule (et la mémorise) si absente/périmée. */
  async function remember(key, producer, { ttl: entryTtl, rememberNull = true } = {}) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    if (cached === null && rememberNull) return null;

    const value = await producer();
    if (value === null && !rememberNull) return null;
    set(key, value, { ttl: entryTtl });
    return value;
  }

  function purge() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of store) {
      if (isStale(entry, now)) {
        store.delete(key);
        removed++;
        counters.expired++;
      }
    }
    return removed;
  }

  function stats() {
    return {
      name,
      size: store.size,
      max: limit,
      ttl: lifetime,
      ...counters,
      hitRate: counters.hits + counters.misses > 0
        ? Number((counters.hits / (counters.hits + counters.misses)).toFixed(3))
        : null,
    };
  }

  return {
    get,
    set,
    has,
    remember,
    delete: key => drop(key, 'delete'),
    clear: () => { store.clear(); },
    purge,
    stats,
    resetStats: () => { for (const k of Object.keys(counters)) counters[k] = 0; },
    keys: () => [...store.keys()],
    values: () => [...store.values()].map(entry => entry.value),
    entries: () => [...store.entries()].map(([key, entry]) => [key, entry.value]),
    get size() { return store.size; },
    get max() { return limit; },
  };
}

module.exports = { createBoundedCache, envInt, DEFAULT_MAX };
