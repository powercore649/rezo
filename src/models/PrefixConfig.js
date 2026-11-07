const mongoose = require('mongoose');

// models/PrefixConfig.js — Préfixe de commandes personnalisé par serveur.
// Système hybride REZO : les commandes slash restent la voie principale,
// mais chaque serveur peut aussi activer un préfixe texte (ex : "b!ping").
const prefixConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  enabled:     { type: Boolean, default: false },
  prefix:      { type: String, default: 'b!', maxlength: 5 },

  // Afficher un petit indice sous chaque réponse préfixée ("Préfixe : b! …")
  showHint:    { type: Boolean, default: true },

  // Salons où le préfixe est ignoré (ex : salons de confessions, compteur…)
  ignoredChannelIds: { type: [String], default: [] },

  // Salon où poster les erreurs de commande préfixée (optionnel)
  logChannelId: { type: String, default: null },

  stats: {
    used: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
  },
}, { minimize: false });

module.exports = mongoose.models.PrefixConfig || mongoose.model('PrefixConfig', prefixConfigSchema);
