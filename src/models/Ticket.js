const mongoose = require('mongoose');

// ── Configuration par serveur ────────────────────────────────────────────────
// Contient aussi l'état de la console support (utils/ticketPanelView.js) :
// blacklist, cooldown d'ouverture et compteur de numérotation des tickets.
// Sans ces champs, la blacklist levait une exception et le compteur restait
// bloqué à 1 (les écritures sur un chemin absent du schéma sont ignorées).
const ticketConfigSchema = new mongoose.Schema({
  guildId:      { type: String, required: true, unique: true },
  categoryId:   { type: String, default: null },
  logChannelId: { type: String, default: null },
  supportRoleId:{ type: String, default: null },
  enabled:      { type: Boolean, default: false },
  panelMessageId: { type: String, default: null },
  panelChannelId: { type: String, default: null },

  // ── Console support ────────────────────────────────────────────────────────
  blacklist:      { type: [{ userId: String, reason: String, byId: String, at: Number }], default: [] },
  // userId → horodatage de la dernière ouverture (anti-abus). Mixed : le code
  // écrit la clé puis `markModified('lastTicketOpen')` avant d'enregistrer.
  lastTicketOpen: { type: Object, default: {} },
  ticketCounter:  { type: Number, default: 0 },
});

// ── Ticket ──────────────────────────────────────────────────────────────────
const ticketSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  channelId: { type: String, required: true },
  authorId:  { type: String, required: true },
  number:    { type: Number, required: true },
  subject:   { type: String, default: 'Support' },
  status:    { type: String, enum: ['open','closed'], default: 'open' },
  createdAt: { type: Date, default: Date.now },
  closedAt:  { type: Date, default: null },
  closedBy:  { type: String, default: null },

  // ── Suivi du ticket (panel, prise en charge, priorité, satisfaction) ───────
  panelKey:   { type: String, default: null },
  catKey:     { type: String, default: null },
  priority:   { type: String, enum: ['low','normal','high','urgent'], default: 'normal' },
  claimedBy:  { type: String, default: null },
  rating:     { type: Number, default: null },
  closeReason:{ type: String, default: null },
  // Salon réel quand le ticket tourne dans un thread / un salon fixe.
  meta:       { realChannelId: { type: String, default: null } },
});
ticketSchema.index({ guildId: 1, number: 1 });
ticketSchema.index({ channelId: 1 }, { unique: true });

module.exports = {
  TicketConfig: mongoose.model('TicketConfig', ticketConfigSchema),
  Ticket:       mongoose.model('Ticket', ticketSchema),
};
