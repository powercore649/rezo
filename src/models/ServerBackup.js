const mongoose = require('mongoose');

// models/ServerBackup.js — Sauvegarde complète d'un serveur (structure).
//
// Tout ce qui est nécessaire pour reconstruire un serveur à l'identique :
// rôles (permissions bit à bit, hiérarchie), salons (type, ordre, catégorie,
// permissions, slowmode, bitrate…), emojis, bannissements et réglages.
// Les gros entiers Discord (permissions, allow/deny) sont stockés en CHAÎNE :
// un Number JavaScript perdrait des bits au-delà de 2^53.

const permissionOverwriteSchema = new mongoose.Schema({
  id:    { type: String, required: true },
  type:  { type: Number, required: true }, // 0 = rôle, 1 = membre
  allow: { type: String, required: true }, // BigInt sérialisé
  deny:  { type: String, required: true }, // BigInt sérialisé
}, { _id: false });

const forumTagSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  moderated: { type: Boolean, default: false },
  emojiName: { type: String, default: null },
  emojiId:   { type: String, default: null },
}, { _id: false });

const reactionEmojiSchema = new mongoose.Schema({
  emojiId:   { type: String, default: null },
  emojiName: { type: String, default: null },
}, { _id: false });

const channelSchema = new mongoose.Schema({
  id:       { type: String, required: true },
  name:     { type: String, required: true },
  type:     { type: Number, required: true },
  position: { type: Number, default: 0 },
  parentId: { type: String, default: null },

  // Texte / annonces / forum
  topic:             { type: String, default: null },
  nsfw:              { type: Boolean, default: false },
  rateLimitPerUser:  { type: Number, default: 0 },
  defaultAutoArchiveDuration:   { type: Number, default: null },
  defaultThreadRateLimitPerUser: { type: Number, default: 0 },

  // Vocal / conférence
  bitrate:          { type: Number, default: null },
  userLimit:        { type: Number, default: null },
  rtcRegion:        { type: String, default: null },
  videoQualityMode: { type: Number, default: null },

  // Forum / média
  availableTags:        { type: [forumTagSchema], default: undefined },
  defaultReactionEmoji: { type: reactionEmojiSchema, default: null },
  defaultSortOrder:     { type: Number, default: null },
  defaultForumLayout:   { type: Number, default: null },

  permissionOverwrites: { type: [permissionOverwriteSchema], default: [] },

  // Verrou d'écriture (ou de connexion vocale) porté par @everyone. Stocké à
  // part de l'overwrite pour que la restauration puisse le reposer même si cet
  // overwrite a été écarté (rôle introuvable, permission au-dessus du bot…).
  locked: { type: Boolean, default: false },
}, { _id: false });

const roleColorsSchema = new mongoose.Schema({
  primary:   { type: mongoose.Schema.Types.Mixed, default: 0 },
  secondary: { type: mongoose.Schema.Types.Mixed, default: null },
  tertiary:  { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

const roleSchema = new mongoose.Schema({
  id:          { type: String, required: true },
  name:        { type: String, required: true },
  color:       { type: Number, default: 0 },
  colors:      { type: roleColorsSchema, default: null },
  hoist:       { type: Boolean, default: false },
  position:    { type: Number, default: 0 },
  permissions: { type: String, required: true }, // BigInt sérialisé
  mentionable: { type: Boolean, default: false },
  managed:     { type: Boolean, default: false },
  unicodeEmoji:{ type: String, default: null },
}, { _id: false });

const emojiSchema = new mongoose.Schema({
  id:       { type: String, required: true },
  name:     { type: String, required: true },
  animated: { type: Boolean, default: false },
  url:      { type: String, default: null },
}, { _id: false });

const banSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  reason: { type: String, default: null },
}, { _id: false });

const guildSettingsSchema = new mongoose.Schema({
  name:                        { type: String, default: null },
  icon:                        { type: String, default: null },
  banner:                      { type: String, default: null },
  description:                 { type: String, default: null },
  verificationLevel:           { type: Number, default: 0 },
  explicitContentFilter:       { type: Number, default: 0 },
  defaultMessageNotifications: { type: Number, default: 0 },
  afkTimeout:                  { type: Number, default: 300 },
  afkChannelId:                { type: String, default: null },
  systemChannelId:             { type: String, default: null },
  rulesChannelId:              { type: String, default: null },
  publicUpdatesChannelId:      { type: String, default: null },
  preferredLocale:             { type: String, default: 'en-US' },
}, { _id: false });

const countsSchema = new mongoose.Schema({
  roles:      { type: Number, default: 0 },
  categories: { type: Number, default: 0 },
  channels:   { type: Number, default: 0 },
  locked:     { type: Number, default: 0 },
  emojis:     { type: Number, default: 0 },
  bans:       { type: Number, default: 0 },
}, { _id: false });

const serverBackupSchema = new mongoose.Schema({
  guildId:    { type: String, required: true, index: true },
  backupId:   { type: String, required: true, unique: true },
  name:       { type: String, required: true },
  createdBy:  { type: String, required: true },
  version:    { type: Number, default: 2 },

  // Partage : autorise le chargement de cette sauvegarde sur un AUTRE serveur.
  // Sans ce drapeau, seuls son créateur et les owners du bot peuvent l'importer.
  shared:     { type: Boolean, default: false },

  guildName:  { type: String, default: null },
  guild:      { type: guildSettingsSchema, default: null },

  // Droits de @everyone : ce rôle ne peut pas être recréé, seulement reconfiguré.
  everyonePermissions: { type: String, default: '0' },

  roles:    { type: [roleSchema],    default: [] },
  channels: { type: [channelSchema], default: [] },
  emojis:   { type: [emojiSchema],   default: [] },
  bans:     { type: [banSchema],     default: [] },

  counts: { type: countsSchema, default: null },
  createdAt: { type: Date, default: Date.now },
});

serverBackupSchema.index({ guildId: 1, createdAt: -1 });

module.exports = mongoose.model('ServerBackup', serverBackupSchema);
