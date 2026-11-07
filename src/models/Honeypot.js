const mongoose = require('mongoose');

// Configuration du système Honeypot (salon + bouton piège anti-bot / anti-token-grabber).
// Tout message envoyé dans un salon piège (ou clic sur le bouton piège) entraîne
// une sanction automatique. Indépendant des honeypots de l'anti-raid
// (models/AntiRaid.js — modèle 'AntiRaidHoneypot').
const honeypotSchema = new mongoose.Schema({
  guildId:       { type: String,  required: true, unique: true },
  enabled:       { type: Boolean, default: false },

  // Salons surveillés (un membre qui écrit dans l'un d'eux est sanctionné)
  channelIds:    { type: [String], default: [] },

  // Salon où les sanctions sont loguées (optionnel)
  logChannelId:  { type: String,  default: null },

  // Sanction appliquée
  action:        { type: String,  enum: ['mute', 'kick', 'ban'], default: 'mute' },
  muteDuration:  { type: Number,  default: 7 * 24 * 60 },  // en minutes, défaut = 7 jours

  deleteMessage: { type: Boolean, default: true },
  dmUser:        { type: Boolean, default: true },

  // Message d'avertissement affiché en haut du salon piège (embed épinglé)
  warningMessage: {
    type: String,
    default: "⚠️ **Avertissement**\nN'envoyez pas de messages dans ce salon. Ce salon est conçu afin de piéger les bots de spam et les token grabbers. Tout message envoyé ici entraînera automatiquement un mute d'une semaine."
  },

  // Libellé du bouton piège publié dans les salons (personnalisable)
  triggerLabel: { type: String, default: '✅ Confirmer avoir lu' },

  // Statistiques
  totalTriggered: { type: Number, default: 0 },
});

module.exports = mongoose.models.Honeypot || mongoose.model('Honeypot', honeypotSchema);
