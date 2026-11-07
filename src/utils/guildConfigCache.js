'use strict';
// utils/guildConfigCache.js — Lecture de configuration par serveur, mise en cache.
//
// LE PROBLÈME : dans un bot multi-serveurs, chaque message déclenche une dizaine
// de lectures « ce serveur a-t-il activé tel module ? ». Sur 10 000 serveurs et
// quelques dizaines de messages par seconde, ces lectures sont la première cause
// de charge MongoDB — et la première cause de plantage quand la base sature.
//
// LA RÉPONSE : ces configurations changent rarement (quelques clics par mois) et
// sont lues en permanence. On les garde donc en mémoire un court instant :
//
//   • cache borné (LRU + TTL) — le nombre de serveurs n'augmente pas la mémoire ;
//   • mémorisation NÉGATIVE — un serveur sans configuration ne provoque pas une
//     requête à chaque message ;
//   • mutualisation des requêtes en vol — 50 messages simultanés du même serveur
//     ne produisent qu'UNE requête ;
//   • invalidation AUTOMATIQUE — dès qu'une commande écrit la configuration, les
//     hooks Mongoose purgent l'entrée : le panel et les commandes restent exacts,
//     sans qu'aucune commande n'ait à le savoir ;
//   • repli sûr — si la base est coupée, on renvoie `null` immédiatement au lieu
//     de laisser la requête pendre dix secondes (le bot continue de fonctionner).
//
// Réglages (.env, tous optionnels) :
//   DB_CACHE_TTL=60000        durée de vie d'une configuration (ms)
//   DB_CACHE_NEG_TTL=300000   durée de vie d'une absence de configuration (ms)
//   DB_CACHE_MAX=20000        nombre maximal d'entrées gardées en mémoire

const { createBoundedCache, envInt } = require('./boundedCache');

// Opérations d'écriture Mongoose après lesquelles une entrée peut être fausse.
const WRITE_OPS = [
  'findOneAndUpdate', 'findByIdAndUpdate', 'findOneAndReplace',
  'findOneAndDelete', 'findByIdAndDelete',
  'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'insertMany', 'bulkWrite', 'save',
];

let cache = null;
let inflight = null;
const registered = new Map(); // nom du modèle → { model, ttl, negTtl, hits, gated }
const counters = { queries: 0, coalesced: 0, errors: 0, timeouts: 0, invalidations: 0 };

// Une base muette ne doit pas figer le traitement d'un message : on abandonne
// la lecture au bout de DB_CACHE_TIMEOUT (ms) et on continue sans configuration.
const ABANDONED = Symbol('lecture abandonnée');

function settings() {
  return {
    ttl: envInt('DB_CACHE_TTL', 60_000, { min: 0 }),
    negTtl: envInt('DB_CACHE_NEG_TTL', 300_000, { min: 0 }),
    max: envInt('DB_CACHE_MAX', 20_000, { min: 10 }),
  };
}

/** Cache partagé (créé au premier usage : les tests peuvent régler .env avant). */
function store() {
  if (cache) return cache;
  const { ttl, max } = settings();
  cache = createBoundedCache({ max, ttl: 0, name: 'guild-config' }); // TTL géré par entrée
  inflight = new Map();
  return cache;
}

/** Clé stable : l'ordre des champs d'un filtre ne doit pas créer deux entrées. */
function stableKey(value) {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return `D:${value.getTime()}`;
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${k}:${stableKey(value[k])}`).join(',')}}`;
  }
  return `${typeof value}:${String(value)}`;
}

function keyFor(model, filter) {
  return `${model.modelName}|${stableKey(filter)}`;
}

/** Identifiants de serveur présents dans un filtre (pour l'invalidation ciblée). */
function guildIdsIn(source) {
  const raw = source && typeof source === 'object' ? source.guildId : undefined;
  if (typeof raw === 'string') return [raw];
  if (raw && typeof raw === 'object') {
    if (typeof raw.$eq === 'string') return [raw.$eq];
    if (Array.isArray(raw.$in)) return raw.$in.filter(v => typeof v === 'string');
  }
  return [];
}

/** Course entre la requête et un délai maximal. */
async function readWithTimeout(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer = null;
  // Pas de `unref()` ici : ce minuteur est le seul à pouvoir débloquer la
  // course, l'enlever ferait sortir le processus avant l'abandon.
  const guard = new Promise(resolve => { timer = setTimeout(() => resolve(ABANDONED), ms); });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Invalidation ────────────────────────────────────────────────────────────

function invalidateKeysFor(modelName, guildIds = null) {
  const target = store();
  const wanted = guildIds && guildIds.length ? new Set(guildIds.map(String)) : null;
  let removed = 0;
  for (const [key, entry] of target.entries()) {
    if (!key.startsWith(`${modelName}|`)) continue;
    if (wanted && !(entry && entry.guildId && wanted.has(String(entry.guildId)))) continue;
    if (target.delete(key)) removed++;
    inflight.delete(key);
  }
  counters.invalidations += removed;
  return removed;
}

/** Purge une entrée précise (filtre donné), un modèle entier, ou tout. */
function invalidate(modelOrName, filter = null) {
  if (!modelOrName) return invalidateAll();
  const name = typeof modelOrName === 'string' ? modelOrName : modelOrName.modelName;
  if (filter) {
    const key = `${name}|${stableKey(filter)}`;
    const removed = store().delete(key) ? 1 : 0;
    inflight.delete(key);
    counters.invalidations += removed;
    return removed;
  }
  return invalidateKeysFor(name, null);
}

/** Purge ciblée d'un serveur (toutes les configurations en cache pour lui). */
function invalidateGuild(guildId) {
  if (!guildId) return 0;
  const id = String(guildId);
  let removed = 0;
  for (const name of registered.keys()) removed += invalidateKeysFor(name, [id]);
  return removed;
}

function invalidateAll() {
  const target = store();
  const removed = target.size;
  target.clear();
  inflight.clear();
  counters.invalidations += removed;
  return removed;
}

// ─── Lecture mise en cache ───────────────────────────────────────────────────

/**
 * Convertit en `Map` les champs de type `Map` du schéma (Mongoose les rend en
 * objet simple après `.lean()`, alors que le code appelant fait `cfg.x.get(...)`).
 */
function hydrateMaps(doc, mapPaths) {
  if (!doc || !mapPaths || !mapPaths.length) return doc;
  for (const path of mapPaths) {
    const value = doc[path];
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Map)) {
      doc[path] = new Map(Object.entries(value));
    }
  }
  return doc;
}

/**
 * `Model.findOne(filter).lean()` avec cache. Renvoie un objet simple, ou `null`.
 *
 * @param {object} Model  Modèle Mongoose.
 * @param {object} filter Filtre (doit contenir `guildId` pour l'invalidation ciblée).
 * @param {object} [options]
 *   ttl / negTtl   durées de vie
 *   guildId        identifiant serveur (invalidation ciblée)
 *   mapPaths       champs `Map` à reconstruire après `.lean()`
 *   cacheHits      `false` = ne mémoriser QUE les absences. À utiliser quand le
 *                  document renvoyé est ensuite muté puis `save()` : il doit
 *                  rester un vrai document Mongoose.
 */
async function cacheFindOne(Model, filter = {}, options = {}) {
  const target = store();
  const key = keyFor(Model, filter);
  const reg = registered.get(Model.modelName);
  const ttl = options.ttl ?? reg?.ttl ?? settings().ttl;
  const negTtl = options.negTtl ?? reg?.negTtl ?? settings().negTtl;
  const mapPaths = options.mapPaths ?? reg?.mapPaths ?? null;
  const cacheHits = options.cacheHits ?? reg?.cacheHits ?? true;

  const cached = target.get(key);
  if (cached !== undefined) return hydrateMaps(cached.doc ?? null, mapPaths);

  const pending = inflight.get(key);
  if (pending) {
    counters.coalesced++;
    return pending;
  }

  const promise = (async () => {
    counters.queries++;
    // `cacheHits: false` = l'appelant va MUTER puis `save()` le document : il
    // lui faut un vrai document Mongoose, jamais un objet `.lean()`.
    const query = cacheHits ? Model.findOne(filter).lean() : Model.findOne(filter);
    // Si on abandonne la lecture, le rejet éventuel de la requête doit rester
    // silencieux (sinon : « unhandled rejection » et processus fragile).
    if (query && typeof query.catch === 'function') query.catch(() => {});
    const timeout = envInt('DB_CACHE_TIMEOUT', 2500, { min: 0 });
    const doc = await readWithTimeout(query, timeout);
    if (doc === ABANDONED) {
      counters.timeouts++;
      return null; // pas de mise en cache : la base est peut-être juste lente
    }
    const guildId = options.guildId || guildIdsIn(filter)[0] || doc?.guildId || null;
    // Document muté puis sauvegardé ailleurs : on ne mémorise que son absence.
    if (doc === undefined || doc === null) {
      target.set(key, { doc: null, guildId: guildId ? String(guildId) : null }, { ttl: negTtl });
      return null;
    }
    if (!cacheHits) return doc; // document vivant : jamais mémorisé
    // L'entrée porte le document ET l'identifiant serveur : l'invalidation
    // ciblée n'a donc pas besoin de reconstruire la clé.
    target.set(key, { doc, guildId: guildId ? String(guildId) : null }, { ttl });
    return hydrateMaps(doc, mapPaths);
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    counters.errors++;
    return null; // une base en erreur ne doit jamais casser le traitement d'un message
  } finally {
    inflight.delete(key);
  }
}

// ─── Enregistrement d'un modèle ──────────────────────────────────────────────

/**
 * Enregistre un modèle : invalidation automatique à chaque écriture + lecteur lié.
 *
 * @returns {(filter: object, options?: object) => Promise<object|null>} lecteur
 */
function registerModel(Model, { ttl, negTtl, mapPaths = null, cacheHits = true } = {}) {
  if (!Model || !Model.modelName) throw new Error('registerModel : modèle Mongoose attendu');

  const known = registered.get(Model.modelName);
  if (known) {
    // Un appel ultérieur peut préciser un réglage (durée de vie plus courte,
    // champs `Map`, mémoire des seuls absents) : les hooks, eux, ne sont posés qu'une fois.
    if (ttl !== undefined) known.ttl = ttl;
    if (negTtl !== undefined) known.negTtl = negTtl;
    if (mapPaths) known.mapPaths = mapPaths;
    if (cacheHits === false) known.cacheHits = false;
    return reader(Model);
  }

  registered.set(Model.modelName, {
    model: Model,
    ttl: ttl ?? null,
    negTtl: negTtl ?? null,
    mapPaths: mapPaths || null,
    cacheHits: cacheHits !== false,
  });

  const schema = Model.schema;
  if (schema && typeof schema.post === 'function') {
    for (const op of WRITE_OPS) {
      // Post-hook Mongoose : `next()` est appelé immédiatement, rien n'est retardé.
      schema.post(op, function (result, next) {
        try {
          const source = typeof this?.getFilter === 'function' ? this.getFilter() : this;
          const ids = guildIdsIn(source);
          if (ids.length) invalidateKeysFor(Model.modelName, ids);
          else invalidateKeysFor(Model.modelName, null);
        } catch { /* l'invalidation ne doit jamais faire échouer une écriture */ }
        next();
      });
    }
  }
  return reader(Model);
}

/** Lecteur lié à un modèle : `const getAutoMod = reader(AutoMod); await getAutoMod({ guildId })`. */
function reader(Model) {
  return (filter = {}, options = {}) => cacheFindOne(Model, filter, options);
}

function stats() {
  const entries = store().entries();
  const byModel = {};
  let negative = 0;
  for (const [key, entry] of entries) {
    const name = key.slice(0, key.indexOf('|'));
    byModel[name] = (byModel[name] || 0) + 1;
    if (!entry || entry.doc === null) negative++;
  }
  return {
    ttl: settings().ttl,
    negTtl: settings().negTtl,
    max: settings().max,
    entries: entries.length,
    negativeEntries: negative,
    models: registered.size,
    byModel,
    ...counters,
    cache: store().stats(),
  };
}

function reset() {
  if (cache) cache.clear();
  inflight?.clear();
  registered.clear();
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = {
  cacheFindOne,
  registerModel,
  reader,
  invalidate,
  invalidateGuild,
  invalidateAll,
  stats,
  reset,
  stableKey,
  guildIdsIn,
  WRITE_OPS,
  _internals: { store, settings, keyFor },
};
