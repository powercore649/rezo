const mongoose = require('mongoose');

const balanceSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  guildId:   { type: String, required: true },
  coins:     { type: Number, default: 0 },
  lastDaily: { type: Date, default: null },
});

balanceSchema.index({ userId: 1, guildId: 1 }, { unique: true });

module.exports = mongoose.model('Balance', balanceSchema);
