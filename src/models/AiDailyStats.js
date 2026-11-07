'use strict';
// models/AiDailyStats.js — Statistiques journalières du chat IA (pour le panel stats en temps réel)

const mongoose = require('mongoose');

const aiDailyStatsSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  date:    { type: String, required: true }, // format YYYY-MM-DD (UTC)

  messageCount: { type: Number, default: 0 },
  uniqueUsers:  { type: [String], default: [] },
  tokensIn:     { type: Number, default: 0 },
  tokensOut:    { type: Number, default: 0 },
  errorCount:   { type: Number, default: 0 },
});

aiDailyStatsSchema.index({ guildId: 1, date: 1 }, { unique: true });

module.exports = mongoose.models.AiDailyStats || mongoose.model('AiDailyStats', aiDailyStatsSchema);
