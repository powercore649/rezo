'use strict';
// models/LicenseOrder.js — Une commande passée sur le site.
//
// Une commande porte son propre jeton public (`token`), qui est le seul moyen
// de consulter la page de suivi et d'y lire la clé. Aucun compte, aucun mot de
// passe : le jeton est tiré à 256 bits et n'apparaît que dans l'URL du client.
//
// La clé n'est créée qu'au moment où la commande passe `paid` — jamais avant —
// et une seule fois, même si le webhook est rejoué.

const crypto = require('crypto');
const mongoose = require('mongoose');

const STATUSES = ['pending', 'paid', 'cancelled', 'refunded'];

const orderSchema = new mongoose.Schema({
  token:   { type: String, required: true, unique: true, index: true },
  plan:    { type: String, required: true },          // identifiant d'offre
  amountCents: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'EUR' },

  status:  { type: String, enum: STATUSES, default: 'pending', index: true },
  provider: { type: String, enum: ['manual', 'stripe'], default: 'manual' },
  providerRef: { type: String, default: null },        // session Stripe
  providerEventId: { type: String, default: null },    // pour l'idempotence

  key:     { type: String, default: null },            // remplie à l'encaissement
  email:   { type: String, default: null },            // facultatif, non vérifié

  emailSentAt: { type: Date, default: null },          // dernier envoi réussi de la clé

  createdAt: { type: Date, default: Date.now },
  paidAt:    { type: Date, default: null },
});

orderSchema.index({ providerRef: 1 }, { sparse: true });

/** Jeton public non devinable (64 caractères hexadécimaux). */
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

orderSchema.statics.newToken = newToken;
orderSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.LicenseOrder || mongoose.model('LicenseOrder', orderSchema);
module.exports.STATUSES = STATUSES;
module.exports.newToken = newToken;
