'use strict';
// models/BumpNotifConfig.js — Réglages avancés du système de notification de bump
// Complète (sans dupliquer) les champs déjà présents sur Server (bumpRoleId,
// reminderEnabled) : ce modèle gère tout ce qui est propre à l'APPARENCE et au
// COMPORTEMENT fin de la notification.

const mongoose = require('mongoose');

const bumpNotifConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // Salon dédié à la notification — si absent, on retombe sur Server.bumpChannelId
  notifChannelId: { type: String, default: null },

  // Message personnalisé — placeholders : {serveur} {streak} {coins} {total}
  customMessage: { type: String, default: null },

  // Couleur de l'embed (hex, sans #)
  embedColor: { type: String, default: 'FEE75C' },

  // Bascules d'affichage
  showStreakBonus: { type: Boolean, default: true },
  showTotalBumps:  { type: Boolean, default: true },
  silentPing:      { type: Boolean, default: false }, // true = pas de mention @rôle, juste affiché
  showDmButton:    { type: Boolean, default: true },   // afficher "🔔 Me rappeler en DM" au cooldown

  // Auto-suppression du message de rappel après X minutes (0 = jamais)
  autoDeleteMinutes: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('BumpNotifConfig', bumpNotifConfigSchema);
