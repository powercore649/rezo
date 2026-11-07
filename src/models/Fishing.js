const mongoose = require('mongoose');
const fishingSchema = new mongoose.Schema({
  userId:      { type: String, required: true },
  guildId:     { type: String, required: true },
  rod:         { type: String, default: 'basic' }, // basic, pro, golden
  totalCatch:  { type: Number, default: 0 },
  totalValue:  { type: Number, default: 0 },
  lastFish:    { type: Date, default: null },
  bestCatch:   { type: String, default: null },
  bestValue:   { type: Number, default: 0 },
});
fishingSchema.index({ userId: 1, guildId: 1 }, { unique: true });
module.exports = mongoose.model('Fishing', fishingSchema);
