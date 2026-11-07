'use strict';
// models/YoutubeSubAlert.js — Surveillance des paliers d'abonnés YouTube

const mongoose = require('mongoose');

const youtubeSubAlertSchema = new mongoose.Schema({
  // ── Identité ──────────────────────────────────────────────────────────────
  guildId:     { type: String, required: true },
  channelId:   { type: String, required: true }, // salon Discord de destination
  addedBy:     { type: String, default: null },
  enabled:     { type: Boolean, default: true },

  // ── Chaîne YouTube surveillée ─────────────────────────────────────────────
  ytChannelId:   { type: String, required: true }, // UC...
  ytChannelName: { type: String, default: null },
  ytThumbnail:   { type: String, default: null },

  // ── Compteur actuel ───────────────────────────────────────────────────────
  lastSubCount:      { type: Number, default: 0 },
  lastCheckedAt:     { type: Date, default: null },
  lastNotifiedCount: { type: Number, default: 0 }, // dernier palier notifié

  // ── Paliers personnalisés ([100, 500, 1000, ...]) ─────────────────────────
  // Si vide → paliers automatiques par défaut
  customMilestones: { type: [Number], default: [] },

  // ── Message personnalisé ──────────────────────────────────────────────────
  // Variables : {chaine} {abonnes} {palier} {prochainpalier} {progression}
  customMessage: { type: String, default: null },
  embedColor:    { type: String, default: '0xFF0000' }, // rouge YouTube par défaut
  mentionRoleId: { type: String, default: null },
  showEmbed:     { type: Boolean, default: true },

  // ── Métadonnées ───────────────────────────────────────────────────────────
  lastError: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

youtubeSubAlertSchema.index({ guildId: 1, ytChannelId: 1 }, { unique: true });
youtubeSubAlertSchema.index({ enabled: 1 });

module.exports = mongoose.models.YoutubeSubAlert
  || mongoose.model('YoutubeSubAlert', youtubeSubAlertSchema);
