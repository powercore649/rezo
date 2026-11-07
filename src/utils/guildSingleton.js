'use strict';
// utils/guildSingleton.js — Un seul document de configuration par serveur.
//
// 48 modules écrivent `if (!cfg) cfg = await Model.create({ guildId })`. Quand
// deux actions arrivent en même temps sur un serveur qui n'a encore AUCUN
// document (deux admins qui ouvrent le panel, un événement plus un clic, un
// redémarrage qui rejoue une file), les deux `create` partent ensemble :
//   • le premier insère,
//   • le second casse sur l'index unique `guildId_1`.
// Le module affiche alors « une erreur est survenue » et ne marche plus du tout.
// C'est exactement l'E11000 observé sur `bumpify.xpconfigs`.
//
// On ne peut pas avaler l'erreur globalement : pour une clé métier (clé de
// licence, vote, article déjà annoncé), un doublon DOIT rester une erreur
// visible. La règle est donc étroite, et c'est ce qui la rend sûre :
//
//   uniquement un doublon dont la clef unique est EXACTEMENT `{ guildId: 1 }`.
//
// Une telle contrainte désigne par construction un document unique par serveur
// (un `Welcome`, un `PrefixConfig`, un `XPConfig`…). Le document que l'autre
// appel vient d'insérer est donc *la même chose* que celui qu'on voulait créer :
// on le relit et on le renvoie. Aucune donnée n'est inventée, aucune config
// n'est écrasée, et l'appelant reçoit un document utilisable.
//
// Tout le reste (index composé, code d'erreur différent, insertions en lot)
// remonte inchangé.
//
// Un modèle peut se retirer explicitement quand le doublon est une information
// et non une course : `schema.set('guildSingletonGuard', false)`. C'est le cas
// de `Trial` (« essai déjà utilisé ») et de `License` (« serveur déjà
// licencié ») : y répondre par le document existant ferait croire à un succès.

const PATCHED = Symbol.for('rezo.guildSingleton');
const INSTALLED = Symbol.for('rezo.guildSingleton.installed');

/**
 * Vrai si l'erreur est un doublon sur la seule clef `guildId`.
 * `keyPattern` manque parfois selon le driver : on retombe sur le message.
 */
function isGuildSingletonConflict(err) {
  if (!err || err.code !== 11000) return false;

  const pattern = err.keyPattern;
  if (pattern && typeof pattern === 'object') {
    const keys = Object.keys(pattern);
    return keys.length === 1 && keys[0] === 'guildId';
  }
  return /index:\s*guildId_1\b/.test(String(err.message || ''));
}

/**
 * Construit un `create` qui rattrape la seule course sur `{ guildId }`.
 * @param {Function} baseCreate `create` d'origine
 * @param {(self:any)=>any} [resolve] modèle à interroger (utile pour les tests)
 */
function makePatchedCreate(baseCreate, resolve = null) {
  return async function patchedCreate(...args) {
    try {
      return await baseCreate.apply(this, args);
    } catch (err) {
      if (!isGuildSingletonConflict(err)) throw err;

      const target = args[0];
      // Insertions en lot ou signature exotique : on ne devine rien.
      if (args.length > 2 || Array.isArray(target) || !target || typeof target !== 'object') throw err;
      if (!target.guildId) throw err;

      const model = resolve ? resolve(this) : this;
      if (!model || typeof model.findOne !== 'function') throw err;

      const existing = await model.findOne({ guildId: target.guildId });
      if (existing) return existing;
      throw err;
    }
  };
}

/** Enveloppe `create` d'un modèle déjà compilé (ou d'un objet de test). */
function wrapCreate(Model, baseCreate) {
  if (!Model || Model[PATCHED]) return Model;
  const patched = makePatchedCreate(baseCreate, () => Model);
  try {
    Object.defineProperty(patched, PATCHED, { value: true });
    Model.create = patched;
  } catch {
    // Modèle gelé : on laisse son `create` d'origine.
  }
  return Model;
}

/** Le modèle a-t-il demandé à rester en dehors du garde-fou ? */
function optedOut(schema) {
  return Boolean(schema && schema.options && schema.options.guildSingletonGuard === false);
}

/** Traite un modèle existant, en ignorant ceux qui n'ont pas de `guildId`. */
function patchModel(Model, baseCreate) {
  if (!Model || Model[PATCHED]) return Model;
  const schema = Model.schema;
  if (schema && typeof schema.path === 'function' && !schema.path('guildId')) return Model;
  if (optedOut(schema)) return Model;
  return wrapCreate(Model, baseCreate);
}

/**
 * Installe le garde-fou. Idempotent : un second appel ne réenveloppe rien.
 * À appeler AVANT que les modèles soient compilés (plugin global), puis une
 * seconde fois après la connexion pour rattraper les modèles déjà chargés.
 */
function installGuildSingletonGuard(mongoose) {
  if (!mongoose || mongoose[INSTALLED]) return mongoose;

  const baseCreate = mongoose.Model && mongoose.Model.create;
  if (typeof baseCreate !== 'function') return mongoose;
  Object.defineProperty(mongoose, INSTALLED, { value: true });

  // Plugin : s'applique à chaque modèle compilé ensuite. Les commandes sont
  // chargées après le noyau, donc après cette ligne.
  mongoose.plugin(function guildSingletonPlugin(schema) {
    if (!schema || typeof schema.path !== 'function' || !schema.path('guildId')) return;
    if (!schema.statics || optedOut(schema)) return;
    const patched = makePatchedCreate(baseCreate);
    Object.defineProperty(patched, PATCHED, { value: true });
    schema.statics.create = patched;
  });

  // Modèles compilés avant l'installation (require en amont, tests…).
  for (const name of mongoose.modelNames()) {
    patchModel(mongoose.model(name), baseCreate);
  }
  return mongoose;
}

module.exports = {
  isGuildSingletonConflict,
  optedOut,
  makePatchedCreate,
  wrapCreate,
  patchModel,
  installGuildSingletonGuard,
};
