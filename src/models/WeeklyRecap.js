'use strict';
// models/WeeklyRecap.js — Configuration + instantané du récap hebdomadaire
// d'activité d'un serveur (messages, XP, membres, bumps réseau, top activité).
//
// Le champ `snapshot` conserve les totaux cumulés au moment du dernier récap.
// Le récap suivant renvoie donc uniquement la différence (= l'activité de la
// période écoulée), sans avoir besoin de journaliser chaque message.

const mongoose = require('mongoose');

const weeklyRecapSchema = new mongoose.Schema({
  guildId:    { type: String,  required: true, unique: true },
  enabled:    { type: Boolean, default: false },
  channelId:  { type: String,  default: null },
  pingRoleId: { type: String,  default: null },           // rôle mentionné avec le récap (optionnel)
  schedule:   { type: String,  default: '0 18 * * 0' },   // dimanche 18:00 par défaut

  // Sections affichées dans l'embed
  sections: {
    messages:   { type: Boolean, default: true },
    xp:         { type: Boolean, default: true },
    members:    { type: Boolean, default: true },
    bumps:      { type: Boolean, default: true },
    topMembers: { type: Boolean, default: true },
    moderation: { type: Boolean, default: false },
  },

  // Dernier instantané de référence (base du calcul des deltas)
  snapshot: {
    takenAt:         { type: Date,   default: null },
    totalMessages:   { type: Number, default: 0 },
    totalXp:         { type: Number, default: 0 },
    memberCount:     { type: Number, default: 0 },
    perUserMessages: { type: Object, default: {} }, // { userId: messagesCumulés }
  },

  lastSentAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('WeeklyRecap', weeklyRecapSchema);
