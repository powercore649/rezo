// utils/blacklist.js — Blacklist globale de serveurs.
// Un serveur blacklisté ne peut exécuter AUCUNE commande du bot (slash,
// boutons, menus, modaux, préfixe) — et le bot refuse de le rejoindre
// (leave auto via guildCreate). Blacklistable par ID même si le bot n'y est pas.
const mongoose = require('mongoose');

// ── Modèle ────────────────────────────────────────────────────────────────────
const blacklistSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, unique: true },
  reason:    { type: String, default: 'Aucune raison fournie' },
  addedBy:   { type: String, default: null },  // tag du propriétaire du bot
  addedAt:   { type: Date,   default: Date.now },
});
module.exports.model = mongoose.models.Blacklist || mongoose.model('Blacklist', blacklistSchema);

// ── Cache mémoire (évite 1 requête Mongo par interaction/message) ─────────────
// Rechargé au démarrage, puis tenu à jour à chaque ajout/retrait.
const cache = new Set();
let ready = false;

async function initCache() {
  if (ready) return;
  const docs = await module.exports.model.find({}).lean();
  for (const doc of docs) cache.add(doc.guildId);
  ready = true;
  console.log(`✅ Blacklist chargée : ${cache.size} serveur(s)`);
}

function isBlacklisted(guildId) {
  return ready && cache.has(guildId);
}

async function add(guildId, { reason, addedBy } = {}) {
  await initCache();
  await module.exports.model.updateOne(
    { guildId },
    { $set: { reason: reason || 'Aucune raison fournie', addedBy: addedBy || null, addedAt: new Date() } },
    { upsert: true },
  );
  cache.add(guildId);
}

async function remove(guildId) {
  await initCache();
  await module.exports.model.deleteOne({ guildId });
  cache.delete(guildId);
}

async function list() {
  await initCache();
  return module.exports.model.find({}).sort({ addedAt: -1 }).lean();
}

module.exports.isBlacklisted = isBlacklisted;
module.exports.initCache = initCache;
module.exports.add = add;
module.exports.remove = remove;
module.exports.list = list;
