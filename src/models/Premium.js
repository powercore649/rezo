const mongoose = require('mongoose');
const premiumSchema = new mongoose.Schema({
  guildId:    { type: String, required: true, unique: true },
  active:     { type: Boolean, default: false },
  grantedBy:  { type: String, default: null },   // ID du propriétaire qui a activé
  grantedAt:  { type: Date,   default: null },
  expiresAt:  { type: Date,   default: null },   // null = illimité
  reason:     { type: String, default: '' },      // note libre (ex: "partenaire", "beta testeur")
  tier:       { type: String, enum: ['standard','plus'], default: 'standard' },
});
module.exports = mongoose.model('Premium', premiumSchema);
