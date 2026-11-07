const mongoose = require('mongoose');

const voiceConfigSchema = new mongoose.Schema({
  guildId:          { type: String, required: true, unique: true },
  enabled:          { type: Boolean, default: true },
  excludedChannels: { type: [String], default: [] }, // en plus du salon AFK, toujours exclu automatiquement
});

module.exports = mongoose.model('VoiceConfig', voiceConfigSchema);
