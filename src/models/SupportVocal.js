'use strict';
// models/SupportVocal.js — Support vocal (ticket vocal) pour serveurs communautaires.
//
// Deux collections :
//   • SupportVocalConfig — la configuration du serveur (salons, rôle staff,
//     modèle de nom, limites) ;
//   • SupportVocal       — une demande (= un « ticket vocal ») : le salon vocal
//     privé créé pour le membre, son état, qui l'a pris en charge.
//
// Contrairement à /ticket (salon texte), une demande de support vocal crée un
// salon VOCAL privé : le membre y attend, le staff le rejoint, la demande se
// ferme toute seule quand le salon se vide.

const mongoose = require('mongoose');

const supportVocalConfigSchema = new mongoose.Schema({
  guildId:          { type: String,  required: true, unique: true },

  enabled:          { type: Boolean, default: true },

  // ── Salons ────────────────────────────────────────────────────────────────
  panelChannelId:   { type: String,  default: null }, // salon texte du panneau public
  panelMessageId:   { type: String,  default: null }, // message du panneau (mis à jour sur place)
  requestChannelId: { type: String,  default: null }, // salon texte où arrivent les demandes
  categoryId:       { type: String,  default: null }, // catégorie des salons vocaux privés
  logChannelId:     { type: String,  default: null }, // salon de logs (optionnel)

  // ── Staff ─────────────────────────────────────────────────────────────────
  supportRoleId:    { type: String,  default: null }, // rôle autorisé à prendre en charge

  // ── Apparence ─────────────────────────────────────────────────────────────
  nameTemplate:     { type: String,  default: '🎧・support-{user}' }, // {user} {tag} {server}
  welcomeMessage:   { type: String,  default: '' },

  // ── Limites ───────────────────────────────────────────────────────────────
  maxOpenPerUser:   { type: Number,  default: 1 },   // demandes simultanées par membre
  cooldownSeconds:  { type: Number,  default: 120 }, // délai entre deux demandes
  autoCloseEmpty:   { type: Boolean, default: true }, // fermer quand le salon vocal se vide
  mentionStaff:     { type: Boolean, default: true },

  // ── État ──────────────────────────────────────────────────────────────────
  ticketCounter:    { type: Number,  default: 0 },
  totalRequests:    { type: Number,  default: 0 },
  updatedAt:        { type: Date,    default: Date.now },
}, { minimize: false });

const supportVocalSchema = new mongoose.Schema({
  guildId:           { type: String,  required: true },
  userId:            { type: String,  required: true },
  number:            { type: Number,  required: true },

  voiceChannelId:    { type: String,  default: null },
  requestChannelId:  { type: String,  default: null },
  requestMessageId:  { type: String,  default: null },

  status:            { type: String,  enum: ['open', 'closed'], default: 'open' },
  claimedBy:         { type: String,  default: null },
  claimedAt:         { type: Date,    default: null },

  createdAt:         { type: Date,    default: Date.now },
  closedAt:          { type: Date,    default: null },
  closedBy:          { type: String,  default: null },
  closeReason:       { type: String,  default: null },
});

// Un membre ne peut pas avoir deux demandes ouvertes sur le même salon vocal ;
// l'index sert aussi au nettoyage et à la fermeture automatique (voiceStateUpdate).
supportVocalSchema.index({ guildId: 1, userId: 1, status: 1 });
supportVocalSchema.index({ voiceChannelId: 1 });
supportVocalSchema.index({ guildId: 1, status: 1, createdAt: -1 });

module.exports = {
  SupportVocalConfig: mongoose.model('SupportVocalConfig', supportVocalConfigSchema),
  SupportVocal:       mongoose.model('SupportVocal', supportVocalSchema),
};
