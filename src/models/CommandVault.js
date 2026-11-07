'use strict';
// models/CommandVault.js — Coffre d'accès aux commandes sensibles.
//
// Protection indépendante du système de licences : elle ne dépend d'aucun
// abonnement, d'aucune clé et d'aucun serveur distant. Un serveur définit un
// code une fois, et seuls le propriétaire, les membres/rôles autorisés ou les
// personnes qui connaissent le code peuvent ouvrir les panneaux protégés.
//
// Le code n'est jamais stocké en clair : sel aléatoire + scrypt (voir
// utils/commandVaultEngine.js). Il n'est jamais affiché ni récupérable — en cas
// d'oubli, le propriétaire en définit simplement un nouveau.

const mongoose = require('mongoose');

const failureSchema = new mongoose.Schema({
  userId:      { type: String, required: true },
  count:       { type: Number, default: 0 },
  lastAt:      { type: Number, default: 0 },  // horodatage ms
  lockedUntil: { type: Number, default: 0 },  // horodatage ms (0 = pas verrouillé)
}, { _id: false });

const commandVaultSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },

  // Protection active par défaut : sans code défini, seul le propriétaire du
  // serveur peut ouvrir les panneaux protégés. C'est volontaire — une commande
  // capable de bannir ne doit jamais être ouverte à tout détenteur de permission
  // tant que le serveur n'a rien décidé.
  enabled: { type: Boolean, default: true },

  codeHash: { type: String, default: null },
  codeSalt: { type: String, default: null },

  // Délégation explicite, sans code à partager.
  authorizedUsers: { type: [String], default: [] },
  authorizedRoles: { type: [String], default: [] },

  failures: { type: [failureSchema], default: [] },

  stats: {
    opens:  { type: Number, default: 0 },
    denied: { type: Number, default: 0 },
    lastAt: { type: Date,   default: null },
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

commandVaultSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.models.CommandVault || mongoose.model('CommandVault', commandVaultSchema);
