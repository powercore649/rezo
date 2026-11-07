const mongoose = require('mongoose');
const tempBanSchema = new mongoose.Schema({
  guildId:  { type: String, required: true },
  userId:   { type: String, required: true },
  reason:   { type: String, default: 'Aucune raison' },
  unbanAt:  { type: Date,   required: true },
  done:     { type: Boolean, default: false },
});
tempBanSchema.index({ done: 1, unbanAt: 1 });
tempBanSchema.index({ guildId: 1, userId: 1 });
module.exports = mongoose.model('TempBan', tempBanSchema);
