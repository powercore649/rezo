const mongoose = require('mongoose');
// Sanctions graduées : suit le nombre de strikes par membre pour escalade auto
const sanctionSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  userId:    { type: String, required: true },
  strikes:   { type: Number, default: 0 },
  lastStrike:{ type: Date, default: null },
  history:   [{
    reason:    String,
    action:    String, // 'warn','mute','kick','ban'
    by:        String,
    createdAt: { type: Date, default: Date.now },
  }],
});
sanctionSchema.index({ guildId: 1, userId: 1 }, { unique: true });
module.exports = mongoose.model('Sanction', sanctionSchema);
