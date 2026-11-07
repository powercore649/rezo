// models/RankCardPref.js — Personnalisation de la carte de rang par un membre.
//
// Prioritaire sur le thème du serveur (XPConfig.rankCard) uniquement quand
// `enabled` est vrai. Les champs laissés à null sont hérités du serveur :
// un membre peut donc ne changer que sa couleur d'accent, par exemple.
const mongoose = require('mongoose');

const rankCardPrefSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },
  enabled: { type: Boolean, default: false },

  // null = on garde la valeur du serveur
  accentColor:  { type: String, default: null },
  bgStyle:      { type: String, default: null },
  bgColor:      { type: String, default: null },
  bgImage:      { type: String, default: null },
  bgDim:        { type: Number, default: null },
  textColor:    { type: String, default: null },
  barStyle:     { type: String, default: null },
  avatarShape:  { type: String, default: null },
  showRank:     { type: Boolean, default: null },
  showMessages: { type: Boolean, default: null },
  showTotalXp:  { type: Boolean, default: null },
  showFooter:   { type: Boolean, default: null },
}, { timestamps: true });

rankCardPrefSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.models.RankCardPref || mongoose.model('RankCardPref', rankCardPrefSchema);
