'use strict';
// models/StreamAlert.js — Alertes Twitch (live) & YouTube (nouvelles vidéos)
const mongoose = require('mongoose');

const streamAlertSchema = new mongoose.Schema({
  guildId:       { type: String, required: true },
  platform:      { type: String, enum: ['twitch', 'youtube', 'rss', 'bluesky'], required: true },

  // Identifiant technique : login Twitch (minuscule), Channel ID YouTube (UC...),
  // URL du flux RSS/Atom, ou handle Bluesky (nom.bsky.social).
  identifier:    { type: String, required: true },
  displayName:   { type: String, default: null },
  avatarUrl:     { type: String, default: null },

  // Où et comment annoncer
  channelId:     { type: String, required: true },
  roleId:        { type: String, default: null },
  customMessage: { type: String, default: null }, // Placeholders: {streamer} {titre} {jeu} {lien} {chaine}
  enabled:       { type: Boolean, default: true },

  // ── Apparence de la notification (panneau « Appearance ») ────────────────
  embedColor:         { type: String, default: null }, // '#ff4a4a' — null = couleur de la plateforme
  embedStyle:         { type: String, enum: ['classic', 'compact', 'text'], default: 'classic' },
  headerText:         { type: String, default: null }, // en-tête de l'embed (template)
  titleTemplate:      { type: String, default: null }, // titre de l'embed (template)
  descriptionTemplate:{ type: String, default: null }, // description de l'embed (template)
  buttonLabel:        { type: String, default: null }, // libellé du bouton lien
  showImage:          { type: Boolean, default: true }, // image large (aperçu stream / vidéo)
  showThumbnail:      { type: Boolean, default: true }, // miniature (avatar / vignette de chaîne)
  notifyShorts:       { type: Boolean, default: true }, // YouTube : notifier aussi les Shorts

  // ── État live Twitch ─────────────────────────────────────────────────────
  isLive:        { type: Boolean, default: false },
  lastStreamId:  { type: String, default: null },
  liveMessageId: { type: String, default: null },
  liveChannelId: { type: String, default: null }, // salon où le message live a été posté (pour édition à l'offline)

  // ── État YouTube ─────────────────────────────────────────────────────────
  lastVideoId:        { type: String, default: null },
  uploadsPlaylistId:  { type: String, default: null }, // Cache — évite un appel API supplémentaire à chaque check

  // ── État des sources sans clé API (RSS/Atom, Bluesky) ────────────────────
  lastPostId: { type: String, default: null },
  lastPostAt: { type: Date,   default: null },
  lastCheckedAt:  { type: Date, default: null },
  lastNotifiedAt: { type: Date, default: null },
  lastError:      { type: String, default: null },
  addedBy:       { type: String, default: null },
  createdAt:     { type: Date, default: Date.now },
});

streamAlertSchema.index({ guildId: 1, platform: 1, identifier: 1 }, { unique: true });
streamAlertSchema.index({ platform: 1, enabled: 1 });

module.exports = mongoose.models.StreamAlert || mongoose.model('StreamAlert', streamAlertSchema);
