// models/PartnerStats.js — Compteur de partenariats effectués, par membre et
// par serveur (un même membre peut être staff sur plusieurs serveurs avec
// des compteurs distincts).
const mongoose = require('mongoose');

const partnerStatsSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },
  count:   { type: Number, default: 0 },
}, { timestamps: true });

partnerStatsSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('PartnerStats', partnerStatsSchema);
