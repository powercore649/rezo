const mongoose = require('mongoose');

const thresholdSchema = new mongoose.Schema({
  count:  { type: Number, required: true },
  action: { type: String, enum: ['warn', 'mute', 'kick', 'ban'], default: 'warn' },
}, { _id: false });

const autoModAdvancedSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  antiSpam: {
    enabled:            { type: Boolean, default: false },
    maxMessages:        { type: Number, default: 5 },
    perSeconds:         { type: Number, default: 5 },
    muteDurationSeconds:{ type: Number, default: 600 },
  },

  antiMassMention: {
    enabled:     { type: Boolean, default: false },
    maxMentions: { type: Number, default: 5 },
    action:      { type: String, enum: ['warn', 'mute', 'kick', 'ban'], default: 'mute' },
  },

  wordFilter: {
    low:    { type: [String], default: [] },
    medium: { type: [String], default: [] },
    high:   { type: [String], default: [] },
    lowAction:    { type: String, enum: ['warn', 'mute', 'kick', 'ban'], default: 'warn' },
    mediumAction: { type: String, enum: ['warn', 'mute', 'kick', 'ban'], default: 'mute' },
    highAction:   { type: String, enum: ['warn', 'mute', 'kick', 'ban'], default: 'kick' },
  },

  graduated: {
    enabled:      { type: Boolean, default: false },
    windowSeconds:{ type: Number, default: 3600 },
    thresholds:   { type: [thresholdSchema], default: [] },
  },
});

module.exports = mongoose.model('AutoModAdvanced', autoModAdvancedSchema);
