const mongoose = require('mongoose');
const profileCustomSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  guildId:    { type: String, required: true },
  bio:        { type: String, default: '' },
  quote:      { type: String, default: '' },
  themeColor: { type: String, default: '#8B1A1A' },
  bannerUrl:  { type: String, default: null },
  // ── Cartes de profil personnalisables (additif) ──────────────────────────
  bgColor:      { type: String,  default: null }, // couleur de fond personnalisée (hex), null = dégradé par défaut
  accentColor:  { type: String,  default: null }, // couleur d'accent (barre/anneau avatar), null = défaut (#5865F2/#57F287)
  showBadges:   { type: Boolean, default: true },  // afficher les badges sur la carte de profil
});
profileCustomSchema.index({ userId: 1, guildId: 1 }, { unique: true });
module.exports = mongoose.model('ProfileCustom', profileCustomSchema);
