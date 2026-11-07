// models/BoostConfig.js — Configuration du message envoyé quand un membre boost le serveur
const mongoose = require('mongoose');

const boostConfigSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, unique: true },
  enabled:   { type: Boolean, default: false },
  channelId: { type: String, default: null }, // null = salon système du serveur (fallback)

  // Placeholders disponibles : {user} {mention} {server} {boostcount} {level} {membercount}
  title:       { type: String, default: '💎 Nouveau boost !' },
  description: { type: String, default: '{mention} vient de booster **{server}** ! Merci pour ton soutien 🎉' },
  footerText:  { type: String, default: 'Merci pour ton soutien !' },
  color:       { type: String, default: '#F47FFF' }, // rose boost Discord par défaut

  imageUrl:     { type: String, default: null }, // grande bannière (URL directe)
  useAvatar:    { type: Boolean, default: true }, // affiche l'avatar du booster en thumbnail
  useServerIcon: { type: Boolean, default: false }, // sinon, icône du serveur en thumbnail

  boosterRoleId: { type: String, default: null }, // rôle auto-attribué aux boosters (bonus)
  pingRoleId:    { type: String, default: null }, // rôle mentionné en plus du booster (optionnel)
}, { timestamps: true });

module.exports = mongoose.models.BoostConfig || mongoose.model('BoostConfig', boostConfigSchema);
