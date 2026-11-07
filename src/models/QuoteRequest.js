'use strict';
// models/QuoteRequest.js — Une demande de devis du Pack REZO.net.
//
// Une demande n'est PAS une commande : elle ne porte aucun montant et aucune
// clé avant l'accord du propriétaire. Elle sert de pont entre deux processus :
//   • le site l'écrit (`status: 'pending'`) en remplissant le formulaire ;
//   • le bot la relève, l'envoie en MP à l'owner, puis enregistre sa décision.
//
// La clé n'apparaît ici qu'APRÈS approbation (`utils/quoteStore.approveRequest`),
// ce qui permet de retrouver ce qui a été accordé (sièges, durée) et à qui.

const crypto = require('crypto');
const mongoose = require('mongoose');

const STATUSES = ['pending', 'approved', 'rejected'];

const quoteSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  plan:  { type: String, default: 'pack-rezo-net' },

  // ── Demandeur ──
  name:      { type: String, default: '', maxLength: 80 },
  email:     { type: String, default: '', maxLength: 190 },
  discord:   { type: String, default: '', maxLength: 80 },   // pseudo, informatif
  discordId: { type: String, default: '', index: true },     // destinataire de la clé
  guildId:   { type: String, default: '', maxLength: 32 },
  guildName: { type: String, default: '', maxLength: 100 },

  // ── Besoin ──
  servers:   { type: Number, default: 1, min: 1 },
  members:   { type: Number, default: 0, min: 0 },
  duration:  { type: String, default: '', maxLength: 20 },
  startDate: { type: String, default: '', maxLength: 10 },
  budget:    { type: String, default: '', maxLength: 40 },
  modules:   { type: String, default: '', maxLength: 600 },
  message:   { type: String, default: '', maxLength: 1500 },
  consent:   { type: Boolean, default: true },

  // ── Traitement ──
  status:      { type: String, enum: STATUSES, default: 'pending', index: true },
  seats:       { type: Number, default: null },   // sièges accordés
  days:        { type: Number, default: null },   // durée accordée
  key:         { type: String, default: null },   // clé émise après accord
  keySentAt:   { type: Date, default: null },     // MP parti chez l'acheteur
  keyError:    { type: String, default: null },   // raison d'un MP impossible

  notifiedAt:      { type: Date, default: null }, // MP envoyé à l'owner
  notifyAttempts:  { type: Number, default: 0 },  // évite de boucler si ses MP sont fermés
  ownerMessages:   { type: [{ userId: String, messageId: String }], default: [] },

  decidedAt:  { type: Date, default: null },
  decidedBy:  { type: String, default: null },

  createdAt: { type: Date, default: Date.now, index: true },
});

quoteSchema.index({ status: 1, createdAt: -1 });

/** Jeton public non devinable (64 caractères hexadécimaux). */
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

quoteSchema.statics.newToken = newToken;
quoteSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.QuoteRequest || mongoose.model('QuoteRequest', quoteSchema);
module.exports.STATUSES = STATUSES;
module.exports.newToken = newToken;
