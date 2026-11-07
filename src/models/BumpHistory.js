'use strict';
// models/BumpHistory.js — Journal complet de chaque bump effectué (pour /bump-historique)
const mongoose = require('mongoose');

const bumpHistorySchema = new mongoose.Schema({
  guildId:      { type: String, required: true },
  userId:       { type: String, required: true },
  guildName:    { type: String, default: null }, // snapshot au moment du bump
  coinsEarned:  { type: Number, default: 0 },
  streakAtTime: { type: Number, default: 0 },
  createdAt:    { type: Date, default: Date.now },
});

bumpHistorySchema.index({ userId: 1, createdAt: -1 });
bumpHistorySchema.index({ guildId: 1, createdAt: -1 });

module.exports = mongoose.model('BumpHistory', bumpHistorySchema);
