const mongoose = require('mongoose');

const autoThreadSchema = new mongoose.Schema({
  guildId:              { type: String, required: true, unique: true },
  enabled:              { type: Boolean, default: false },
  includeChannels:      { type: [String], default: [] }, // vide = tous les salons (sauf exclus)
  excludeChannels:      { type: [String], default: [] },
  threadNameTemplate:   { type: String, default: 'Discussion de {username}' },
  autoArchiveDuration:  { type: Number, default: 1440 }, // 60/1440/4320/10080
  slowmodeSeconds:      { type: Number, default: 0 },
  onlyFirstMessagePerUser: { type: Boolean, default: false },
  restrictRoleId:       { type: String, default: null },
});

module.exports = mongoose.model('AutoThread', autoThreadSchema);
