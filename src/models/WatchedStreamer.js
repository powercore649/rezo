// models/WatchedStreamer.js — Streamers/chaînes suivis par serveur (Twitch + YouTube)
const mongoose = require('mongoose');

const watchedStreamerSchema = new mongoose.Schema({
  guildId:     { type: String, required: true },
  platform:    { type: String, enum: ['twitch', 'youtube'], required: true },
  identifier:  { type: String, required: true }, // login Twitch (minuscules) ou ID de chaîne YouTube (UC...)
  displayName: { type: String, default: '' },

  // État connu — sert à détecter les transitions (offline→live, nouvelle vidéo)
  isLive:        { type: Boolean, default: false },
  lastLiveId:    { type: String, default: null }, // ID du stream Twitch en cours (évite les doublons)
  lastVideoId:   { type: String, default: null }, // Dernière vidéo YouTube connue

  addedBy:  { type: String, required: true },
  addedAt:  { type: Date, default: Date.now },
}, { timestamps: true });

watchedStreamerSchema.index({ guildId: 1, platform: 1, identifier: 1 }, { unique: true });
watchedStreamerSchema.index({ platform: 1 });

module.exports = mongoose.models.WatchedStreamer || mongoose.model('WatchedStreamer', watchedStreamerSchema);
