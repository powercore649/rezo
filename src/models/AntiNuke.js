'use strict';
// models/AntiNuke.js — Sentinel : protection anti-nuke.
//
// Cible : un compte compromis, un bot malveillant ou un admin indélicat qui
// détruit le serveur en masse (salons, rôles, bans…) ou qui installe une porte
// dérobée (webhook, bot). La détection s'appuie sur le journal d'audit Discord
// (voir src/events/security/antiNuke.js) et les décisions pures vivent dans
// src/utils/antinukeEngine.js.
//
// Un document par serveur. Les incidents sont plafonnés (MAX_INCIDENTS) pour que
// le document ne grossisse jamais sans fin.

const mongoose = require('mongoose');

const MAX_INCIDENTS = 25;

const antiNukeSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },

  // ── Moteur ────────────────────────────────────────────────────────────────
  enabled:     { type: Boolean, default: false },
  level:       { type: String, enum: ['surveillance', 'normal', 'strict'], default: 'normal' },
  logChannelId:{ type: String, default: null },

  // ── Seuils personnalisés (nb d'actions / fenêtre avant sanction) ──────────
  // Remplis depuis le niveau de sensibilité mais surchargeables par serveur.
  thresholds: {
    channelDelete: { type: Number, default: 3 },
    roleDelete:    { type: Number, default: 3 },
    ban:           { type: Number, default: 5 },
    kick:          { type: Number, default: 8 },
    webhookCreate: { type: Number, default: 3 },
  },
  windowSec: { type: Number, default: 45 },

  // ── Sanction automatique contre l'auteur ─────────────────────────────────
  punishment: { type: String, enum: ['none', 'removeRoles', 'quarantine', 'ban'], default: 'quarantine' },
  quarantineRoleId: { type: String, default: null },

  // ── Confinement : verrouiller le serveur dès qu'une nuke est bloquée ─────
  lockdownOnNuke: { type: Boolean, default: false },
  panicAutoMin:   { type: Number, default: 30 }, // 0 = levée manuelle uniquement

  // ── Réparation automatique de ce qui vient d'être détruit ────────────────
  restore: {
    channels: { type: Boolean, default: true },
    roles:    { type: Boolean, default: true },
  },

  // ── Confiance : jamais surveillés ni sanctionnés ─────────────────────────
  whitelistUsers: { type: [String], default: [] },
  whitelistRoles: { type: [String], default: [] },

  // ── Journalisation des actions sensibles même sous le seuil ──────────────
  journalSensitive: { type: Boolean, default: true }, // webhooks + ajout de bot

  // ── État / statistiques ──────────────────────────────────────────────────
  panicActive: { type: Boolean, default: false },
  panicSince:  { type: Date, default: null },
  stats: {
    prevented:     { type: Number, default: 0 }, // nb de nukes bloquées
    lastIncidentAt:{ type: Date, default: null },
  },
  incidents: [{
    at:         { type: Date, default: Date.now },
    userId:     { type: String, default: null },
    userTag:    { type: String, default: null },
    action:     { type: String, default: null },
    count:      { type: Number, default: 0 },
    threshold:  { type: Number, default: 0 },
    punishment: { type: String, default: 'none' },
    restored:   { type: String, default: null },
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

antiNukeSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.models.AntiNuke || mongoose.model('AntiNuke', antiNukeSchema);
