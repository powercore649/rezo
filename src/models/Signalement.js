const mongoose = require('mongoose');

// ─── Configuration du système de signalement (1 par serveur) ──────────────────
const signalementConfigSchema = new mongoose.Schema({
  guildId:      { type: String, required: true, unique: true },
  enabled:      { type: Boolean, default: false },
  logChannelId: { type: String, default: null },  // salon staff où arrivent les signalements
  // Types de signalement activés (tous par défaut)
  types: {
    member:  { type: Boolean, default: true },  // signalement d'un membre (@mention/ID)
    message: { type: Boolean, default: true },  // signalement d'un message (lien)
  },
  rolesAllowed: { type: [String], default: [] }, // vide = tout le monde peut signaler
  cooldownSec:  { type: Number, default: 60 },   // anti-spam par utilisateur
  anonymous:    { type: Boolean, default: false }, // masque l'auteur dans le salon staff
  autoAlertUser:{ type: Boolean, default: true }, // accuse réception en DM au signaleur
  stats: {
    total:    { type: Number, default: 0 },
    pending:  { type: Number, default: 0 },
    resolved: { type: Number, default: 0 },
    rejected: { type: Number, default: 0 },
  },
  updatedAt: { type: Date, default: Date.now },
});

// ─── Un signalement ───────────────────────────────────────────────────────────
const signalementSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  reporterId:{ type: String, required: true },  // auteur du signalement
  targetId:  { type: String, default: null },   // membre visé (si membre)
  targetType:{ type: String, enum: ['member', 'message', 'free'], default: 'member' },
  reason:    { type: String, required: true },  // motif (choix fixe)
  details:   { type: String, default: '' },     // description libre
  proofUrl:  { type: String, default: '' },     // lien de preuve (image, message…)
  messageId: { type: String, default: null },   // message visé (si message)
  channelId: { type: String, default: null },   // salon du message visé
  contextUrl:{ type: String, default: '' },     // lien saut vers le message
  staffMsgId:{ type: String, default: null },   // message dans le salon staff
  status:    { type: String, enum: ['pending', 'resolved', 'rejected'], default: 'pending' },
  handledBy: { type: String, default: null },
  handledAt: { type: Date, default: null },
  action:    { type: String, default: '' },     // ex: "warn", "ban", "aucune"
  note:      { type: String, default: '' },     // note staff
  createdAt: { type: Date, default: Date.now },
});
signalementSchema.index({ guildId: 1, createdAt: -1 });

module.exports = {
  Config: mongoose.models.SignalementConfig || mongoose.model('SignalementConfig', signalementConfigSchema),
  Report: mongoose.models.SignalementReport || mongoose.model('SignalementReport', signalementSchema),
};
