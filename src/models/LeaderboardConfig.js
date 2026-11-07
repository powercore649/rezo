const mongoose = require('mongoose');

const leaderboardConfigSchema = new mongoose.Schema({
  guildId:     { type: String,  required: true, unique: true },
  channelId:   { type: String,  default: null },
  type:        { type: String,  enum: ['coins', 'bumps', 'weekly', 'xp'], default: 'bumps' },
  cronEnabled: { type: Boolean, default: false },
  schedule:    { type: String,  default: '0 12 * * *' }, // tous les jours à 12h par défaut
});

module.exports = mongoose.model('LeaderboardConfig', leaderboardConfigSchema);
