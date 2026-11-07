'use strict';
// models/PingGuard.js — Garde anti-ping et garde des noms de salons.
//
// Deux protections distinctes, un seul document par serveur :
//   • anti-ping : @everyone, @here, mentions de rôles et de membres en masse
//     (voir utils/pingGuardEngine.js pour la décision, utils/pingGuard.js pour
//     l'application Discord) ;
//   • garde des salons : un salon dont le NOM est un vecteur d'attaque
//     (invitation, « nuke », « free nitro »…) est supprimé, son auteur banni,
//     et les salons qu'il venait de supprimer sont reconstruits.
//
// Les compteurs et les 15 derniers événements sont conservés pour que
// /antiping statut puisse montrer ce qui s'est réellement passé, sans relire
// des journaux Discord limités dans le temps.

const mongoose = require('mongoose');

const recentSchema = new mongoose.Schema({
  at:     { type: Date, default: Date.now },
  kind:   { type: String, default: 'ping' }, // ping | channel | restore
  userId: { type: String, default: null },
  detail: { type: String, default: '' },
}, { _id: false });

const pingGuardSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },

  // ── Interrupteur maître ──────────────────────────────────────────────────
  enabled: { type: Boolean, default: true },

  // ── Anti-ping ────────────────────────────────────────────────────────────
  // Les membres autorisés à mentionner @everyone (permission Discord
  // « Mentionner @everyone ») ne sont jamais filtrés : le staff doit pouvoir
  // annoncer. Les autres ne doivent pas pouvoir pinguer tout le serveur.
  blockEveryone:    { type: Boolean, default: true },
  blockHere:        { type: Boolean, default: true },
  maxRoleMentions:  { type: Number,  default: 3 },   // 0 = désactivé
  maxUserMentions:  { type: Number,  default: 6 },   // 0 = désactivé
  punishment:       { type: String,  enum: ['delete', 'timeout', 'kick', 'ban'], default: 'timeout' },
  timeoutMin:       { type: Number,  default: 10 },
  strikesBeforeBan: { type: Number,  default: 3 },   // récidives avant ban automatique
  strikeWindowMin:  { type: Number,  default: 60 },

  // ── Exemptions ───────────────────────────────────────────────────────────
  exemptRoles:    { type: [String], default: [] },
  exemptChannels: { type: [String], default: [] },

  // ── Confiance (garde des salons) ─────────────────────────────────────────
  // Le propriétaire et le bot sont toujours de confiance. Ces listes évitent
  // qu'un salon « nuke-annonce » créé par un modérateur légitime ne déclenche
  // un ban : sans elles, un faux positif coûterait un membre du staff.
  trustedUsers: { type: [String], default: [] },
  trustedRoles: { type: [String], default: [] },

  // ── Garde des noms de salons ─────────────────────────────────────────────
  channelGuard: {
    enabled:         { type: Boolean, default: true },
    deleteChannel:   { type: Boolean, default: true },
    banAuthor:        { type: Boolean, default: true },
    restoreDeleted:  { type: Boolean, default: true },
    restoreWindowMin:{ type: Number,  default: 15 },
    keywords:        { type: [String], default: [] }, // vide = liste par défaut du moteur
  },

  // ── Statistiques / historique ────────────────────────────────────────────
  stats: {
    pingsBlocked:   { type: Number, default: 0 },
    channelsBlocked:{ type: Number, default: 0 },
    restores:       { type: Number, default: 0 },
    lastAt:         { type: Date,   default: null },
  },
  recent: { type: [recentSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

pingGuardSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.models.PingGuard || mongoose.model('PingGuard', pingGuardSchema);
