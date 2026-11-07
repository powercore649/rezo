const mongoose = require('mongoose');

const thresholdSchema = new mongoose.Schema({
  count:    { type: Number, required: true },
  action:   { type: String, enum: ['mute', 'kick', 'ban'], required: true },
  duration: { type: Number, default: 0 }, // minutes, pour mute (0 = permanent / non applicable)
}, { _id: false });

const warnThresholdsSchema = new mongoose.Schema({
  guildId:    { type: String, required: true, unique: true },
  thresholds: { type: [thresholdSchema], default: [] },
});

module.exports = mongoose.model('WarnThresholds', warnThresholdsSchema);
