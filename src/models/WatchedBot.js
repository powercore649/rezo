// models/WatchedBot.js — Bots surveillés par serveur : statut connu, salon
// d'annonce (optionnel, sinon salon par défaut du serveur), état de
// maintenance manuel.
const mongoose = require('mongoose');

const watchedBotSchema = new mongoose.Schema({
  guildId:  { type: String, required: true },
  botId:    { type: String, required: true },
  botTag:   { type: String, default: '' },
  channelId: { type: String, default: null }, // si null, utilise Server.botWatchChannelId

  lastStatus: { type: String, enum: ['online', 'idle', 'dnd', 'offline', 'unknown'], default: 'unknown' },
  lastStatusChangeAt: { type: Date, default: Date.now },

  maintenance: { type: Boolean, default: false },
  maintenanceReason: { type: String, default: '' },
  maintenanceSince: { type: Date, default: null },
  maintenanceBy: { type: String, default: null },
}, { timestamps: true });

watchedBotSchema.index({ guildId: 1, botId: 1 }, { unique: true });

module.exports = mongoose.model('WatchedBot', watchedBotSchema);
