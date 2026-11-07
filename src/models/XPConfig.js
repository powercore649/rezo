const mongoose = require('mongoose');

const levelRoleSchema = new mongoose.Schema({
  level:  { type: Number, required: true },
  roleId: { type: String, required: true },
}, { _id: false });

// Thème de la carte de rang du serveur (défini par un admin via /leveling).
// accentColor reste à null tant que l'admin n'a pas touché au thème : l'ancien
// champ `cardColor` fait alors office de source d'accent (compatibilité).
const rankCardSchema = new mongoose.Schema({
  accentColor:  { type: String, default: null },
  bgStyle:      { type: String, enum: ['gradient', 'solid', 'image'], default: 'gradient' },
  bgColor:      { type: String, default: '#0C0D16' },
  bgImage:      { type: String, default: null },
  bgDim:        { type: Number, default: 0.55 },
  textColor:    { type: String, default: '#FFFFFF' },
  barStyle:     { type: String, enum: ['gradient', 'solid', 'segments'], default: 'gradient' },
  avatarShape:  { type: String, enum: ['circle', 'rounded', 'square'], default: 'circle' },
  showRank:     { type: Boolean, default: true },
  showMessages: { type: Boolean, default: true },
  showTotalXp:  { type: Boolean, default: true },
  showFooter:   { type: Boolean, default: true },
}, { _id: false });

// Carte de l'annonce de niveau (définie par un admin via /leveling).
// Tout champ laissé à null HÉRITE du thème de la carte de rang : par défaut,
// une seule personnalisation suffit donc pour que les deux cartes concordent.
// title/subtitle acceptent {user}, {level}, {rank}, {server}, {messages}, {xp}.
const levelUpCardSchema = new mongoose.Schema({
  title:        { type: String, default: null },
  subtitle:     { type: String, default: null },
  accentColor:  { type: String, default: null },
  bgStyle:      { type: String, enum: ['gradient', 'solid', 'image'], default: null },
  bgColor:      { type: String, default: null },
  bgImage:      { type: String, default: null },
  bgDim:        { type: Number, default: null },
  textColor:    { type: String, default: null },
  barStyle:     { type: String, enum: ['gradient', 'solid', 'segments'], default: null },
  avatarShape:  { type: String, enum: ['circle', 'rounded', 'square'], default: null },
  showRank:     { type: Boolean, default: null },
  showMessages: { type: Boolean, default: null },
  showTotalXp:  { type: Boolean, default: null },
  showFooter:   { type: Boolean, default: null },
}, { _id: false });

const xpConfigSchema = new mongoose.Schema({
  guildId:             { type: String, required: true, unique: true },
  enabled:             { type: Boolean, default: true },
  cooldownSeconds:     { type: Number, default: 60 },
  minXp:               { type: Number, default: 15 },
  maxXp:               { type: Number, default: 25 },
  channelMultipliers:  { type: Map, of: Number, default: () => ({}) },
  roleMultipliers:     { type: Map, of: Number, default: () => ({}) },
  excludedChannels:    { type: [String], default: [] },
  levelRoles:          { type: [levelRoleSchema], default: [] },
  levelUpMessageTemplate: { type: String, default: null }, // {user} {level} — null = comportement par défaut existant
  announceLevelUp:     { type: Boolean, default: true },
  levelUpChannelId:    { type: String, default: null }, // null = salon où le message a été envoyé
  useCardOnLevelUp:    { type: Boolean, default: true },
  cardColor:           { type: String, default: '#8B1A1A' },
  rankCard:            { type: rankCardSchema, default: () => ({}) }, // thème de la carte de rang
  levelUpCard:         { type: levelUpCardSchema, default: () => ({}) }, // carte de l'annonce de niveau (null = hérite de rankCard)
  silentChannels:      { type: [String], default: [] }, // XP gagné normalement, mais aucune annonce de level-up si déclenché ici
});

module.exports = mongoose.models.XPConfig || mongoose.model('XPConfig', xpConfigSchema);
