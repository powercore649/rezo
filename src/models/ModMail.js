const mongoose = require('mongoose');

// ── Configuration ModMail par serveur ────────────────────────────────────────
const modMailConfigSchema = new mongoose.Schema({
  guildId:          { type: String, required: true, unique: true },
  enabled:          { type: Boolean, default: false },
  // Salon où arrivent les threads modmail (catégorie ou salon)
  categoryId:       { type: String, default: null },
  // Salon de logs des modmails (ouverture/fermeture/messages)
  logChannelId:     { type: String, default: null },
  // Rôle notifié à chaque nouveau modmail
  staffRoleId:      { type: String, default: null },
  // Message d'accueil envoyé en DM à l'ouverture
  welcomeMessage:   { type: String, default: 'Bonjour ! Votre message a bien été reçu par notre équipe. Nous vous répondrons dès que possible.' },
  // Message de fermeture envoyé en DM
  closeMessage:     { type: String, default: 'Votre ticket ModMail a été fermé. Merci de nous avoir contactés !' },
  // Prefix des salons créés (ex: "modmail-")
  channelPrefix:    { type: String, default: 'modmail-' },
  // Cooldown anti-spam entre deux ouvertures (en secondes)
  cooldownSeconds:  { type: Number, default: 300 },
  // Mentionner le staff à chaque message entrant
  mentionStaff:     { type: Boolean, default: true },
  // Envoyer une confirmation DM à chaque message du staff
  confirmDM:        { type: Boolean, default: true },
  // Snippet/réponses rapides
  snippets: [{
    name:    { type: String },
    content: { type: String },
  }],
});

// ── Thread ModMail (une conversation) ────────────────────────────────────────
const modMailThreadSchema = new mongoose.Schema({
  guildId:    { type: String, required: true },
  userId:     { type: String, required: true },  // L'utilisateur qui a ouvert
  channelId:  { type: String, required: true },  // Salon créé dans la guild
  status:     { type: String, enum: ['open', 'closed', 'pending'], default: 'open' },
  subject:    { type: String, default: 'Nouveau message' },
  openedAt:   { type: Date, default: Date.now },
  closedAt:   { type: Date, default: null },
  closedBy:   { type: String, default: null },  // userId du staff
  closeReason:{ type: String, default: null },
  number:     { type: Number, required: true },  // Numéro auto-incrémenté
  // Historique des messages (pour le transcript)
  messages: [{
    authorId:    { type: String },
    authorTag:   { type: String },
    content:     { type: String },
    attachments: [{ type: String }],
    fromStaff:   { type: Boolean, default: false },
    anonymous:   { type: Boolean, default: false },
    sentAt:      { type: Date, default: Date.now },
  }],
});

modMailThreadSchema.index({ guildId: 1, userId: 1, status: 1 });
modMailThreadSchema.index({ channelId: 1 }, { unique: true });
modMailThreadSchema.index({ guildId: 1, number: 1 });

// ── Compteur auto-incrémenté par guild ───────────────────────────────────────
const modMailCounterSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  count:   { type: Number, default: 0 },
});

// ── Cooldown anti-spam ────────────────────────────────────────────────────────
const modMailCooldownSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  guildId:   { type: String, required: true },
  lastOpen:  { type: Date, default: Date.now },
});
modMailCooldownSchema.index({ userId: 1, guildId: 1 }, { unique: true });

module.exports = {
  ModMailConfig:   mongoose.model('ModMailConfig',   modMailConfigSchema),
  ModMailThread:   mongoose.model('ModMailThread',   modMailThreadSchema),
  ModMailCounter:  mongoose.model('ModMailCounter',  modMailCounterSchema),
  ModMailCooldown: mongoose.model('ModMailCooldown', modMailCooldownSchema),
};
