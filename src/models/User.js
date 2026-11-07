const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  guildId:   { type: String, required: true },
  bumps:     { type: Number, default: 0 },
  lastBump:     { type: Date,   default: null },
  weeklyBumps:  { type: Number, default: 0 },
  monthlyBumps: { type: Number, default: 0 },
  streak:       { type: Number, default: 0 },
  coinsEarned:  { type: Number, default: 0 }, // coins gagnés via bumps
});

userSchema.index({ userId: 1, guildId: 1 }, { unique: true });

module.exports = mongoose.model('User', userSchema);
