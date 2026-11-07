const mongoose = require('mongoose');

const warnSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  guildId:    { type: String, required: true },
  warnedBy:   { type: String, required: true },
  reason:     { type: String, default: 'Pas de raison spécifiée' },
  createdAt:  { type: Date, default: Date.now },
});

warnSchema.index({ userId: 1, guildId: 1 });

module.exports = mongoose.model('Warn', warnSchema);
