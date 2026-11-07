const mongoose = require('mongoose');

const voiceStatsSchema = new mongoose.Schema({
  guildId:      { type: String, required: true },
  userId:       { type: String, required: true },
  totalSeconds: { type: Number, default: 0 },
  sessions:     { type: Number, default: 0 },
  lastSeen:     { type: Date, default: null },
});

voiceStatsSchema.index({ guildId: 1, userId: 1 }, { unique: true });
voiceStatsSchema.index({ guildId: 1, totalSeconds: -1 });

module.exports = mongoose.model('VoiceStats', voiceStatsSchema);
