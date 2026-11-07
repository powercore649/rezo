const mongoose = require('mongoose');

// ── Abonnement aux notifications d'un utilisateur ────────────────────────────
const notificationSubSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  guildId:   { type: String, required: true },
  // Types de notifications activées
  freeGames: { type: Boolean, default: true },  // Jeux gratuits
  bumps:     { type: Boolean, default: false }, // Bumps du serveur
  giveaways: { type: Boolean, default: true },  // Giveaways
  events:    { type: Boolean, default: true },  // Événements serveur
  streams:   { type: Boolean, default: false }, // Streams Twitch / vidéos YouTube
  raids:     { type: Boolean, default: true },  // Alertes anti-raid / sécurité
  members:   { type: Boolean, default: false }, // Arrivées de membres
  news:      { type: Boolean, default: false }, // Actualités postées par le bot
  modmail:   { type: Boolean, default: false }, // ModMail (staff only)
  // DM ou mention dans un salon
  via:       { type: String, enum: ['dm', 'mention'], default: 'dm' },
  createdAt: { type: Date, default: Date.now },
});
notificationSubSchema.index({ userId: 1, guildId: 1 }, { unique: true });

// ── Log des notifications envoyées ────────────────────────────────────────────
const notificationLogSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  type:      { type: String, required: true }, // 'freegames', 'bump', 'giveaway', etc.
  title:     { type: String, required: true },
  sentAt:    { type: Date, default: Date.now },
  sentTo:    { type: Number, default: 0 },     // Nombre d'utilisateurs notifiés
  messageId: { type: String, default: null },  // Message Discord posté
  channelId: { type: String, default: null },
});
notificationLogSchema.index({ guildId: 1, sentAt: -1 });

// ── Historique personnel par utilisateur (pour le fil "/notifications mes-notifications") ──
const notificationUserLogSchema = new mongoose.Schema({
  userId:      { type: String, required: true },
  guildId:     { type: String, required: true },
  type:        { type: String, required: true },
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  read:        { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now },
});
notificationUserLogSchema.index({ userId: 1, createdAt: -1 });
notificationUserLogSchema.index({ userId: 1, read: 1 });

// ── Message DM live du fil personnel (édité à chaque nouvelle notification) ──
const notificationFeedSchema = new mongoose.Schema({
  userId:       { type: String, required: true, unique: true },
  dmChannelId:  { type: String, default: null },
  dmMessageId:  { type: String, default: null },
  updatedAt:    { type: Date, default: Date.now },
});

// ── Config du panel de notifications par serveur ──────────────────────────────
const notificationConfigSchema = new mongoose.Schema({
  guildId:          { type: String, required: true, unique: true },
  // Salon où s'affiche le panel en temps réel
  panelChannelId:   { type: String, default: null },
  panelMessageId:   { type: String, default: null }, // Message du panel (mis à jour)
  // Salon de log des notifications
  logChannelId:     { type: String, default: null },
  // Rôle staff pour les notifs modmail
  staffRoleId:      { type: String, default: null },
  // Activer/désactiver par type
  freeGamesEnabled: { type: Boolean, default: true },
  bumpsEnabled:     { type: Boolean, default: true },
  giveawaysEnabled: { type: Boolean, default: true },
  eventsEnabled:    { type: Boolean, default: true },
  streamsEnabled:   { type: Boolean, default: true },
  raidsEnabled:     { type: Boolean, default: true },  // Alertes anti-raid
  membersEnabled:   { type: Boolean, default: false }, // Arrivées de membres
  newsEnabled:      { type: Boolean, default: true },  // Actualités
  modmailEnabled:   { type: Boolean, default: true },  // Nouveaux tickets ModMail
  updatedAt:        { type: Date, default: Date.now },
});

// mongoose.models.X réutilise le modèle déjà compilé s'il existe — évite
// "Cannot overwrite model once compiled" si ce fichier est require() plus
// d'une fois (hot-reload, /reload, double import, etc.)
function modelOrExisting(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

module.exports = {
  NotificationSub:     modelOrExisting('NotificationSub',     notificationSubSchema),
  NotificationLog:     modelOrExisting('NotificationLog',     notificationLogSchema),
  NotificationConfig:  modelOrExisting('NotificationConfig',  notificationConfigSchema),
  NotificationUserLog: modelOrExisting('NotificationUserLog', notificationUserLogSchema),
  NotificationFeed:    modelOrExisting('NotificationFeed',    notificationFeedSchema),
};
