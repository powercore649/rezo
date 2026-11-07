const mongoose = require('mongoose');
const badgeSchema = new mongoose.Schema({
  guildId:     { type: String, required: true },
  badgeId:     { type: String, required: true },
  name:        { type: String, required: true },
  emoji:       { type: String, default: '🏅' },
  description: { type: String, default: '' },
  color:       { type: String, default: '#8B1A1A' },
});
badgeSchema.index({ guildId: 1, badgeId: 1 }, { unique: true });

const userBadgeSchema = new mongoose.Schema({
  userId:   { type: String, required: true },
  guildId:  { type: String, required: true },
  badgeId:  { type: String, required: true },
  earnedAt: { type: Date, default: Date.now },
});
userBadgeSchema.index({ userId: 1, guildId: 1 });

module.exports = {
  Badge:     mongoose.model('Badge', badgeSchema),
  UserBadge: mongoose.model('UserBadge', userBadgeSchema),
};
