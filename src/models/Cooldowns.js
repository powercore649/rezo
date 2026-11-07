const mongoose = require('mongoose');
// Cooldowns génériques réutilisables (travail, vol, pêche regroupés si besoin futur)
const cooldownSchema = new mongoose.Schema({
  userId:   { type: String, required: true },
  guildId:  { type: String, required: true },
  type:     { type: String, required: true }, // 'work', 'rob', 'crime'
  lastUse:  { type: Date, default: null },
});
cooldownSchema.index({ userId: 1, guildId: 1, type: 1 }, { unique: true });
module.exports = mongoose.model('Cooldown', cooldownSchema);
