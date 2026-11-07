const mongoose = require('mongoose');
const xpSchema = new mongoose.Schema({
  userId:      { type: String, required: true },
  guildId:     { type: String, required: true },
  xp:          { type: Number, default: 0 },
  level:       { type: Number, default: 0 },
  totalXp:     { type: Number, default: 0 },
  lastMessage: { type: Date,   default: null },
  messages:    { type: Number, default: 0 },
});
xpSchema.index({ userId: 1, guildId: 1 }, { unique: true });
xpSchema.index({ guildId: 1, level: -1, xp: -1 });
module.exports = mongoose.model('XP', xpSchema);
