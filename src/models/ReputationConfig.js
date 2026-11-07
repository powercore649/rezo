const mongoose = require('mongoose');

const reputationConfigSchema = new mongoose.Schema({
  guildId:        { type: String,  required: true, unique: true },
  enabled:        { type: Boolean, default: true },
  cooldownHours:  { type: Number,  default: 24 },
  channelId:      { type: String,  default: null }, // null = autorisé partout
});

module.exports = mongoose.model('ReputationConfig', reputationConfigSchema);
