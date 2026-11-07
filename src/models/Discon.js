'use strict';
// models/Discon.js — Niveau de danger du serveur (DISCON).
//
// Un seul document par serveur : le niveau courant (0 → 5) et l'instantané de
// ce qui a été modifié pour l'appliquer. Sans cet instantané, redescendre d'un
// cran laisserait le serveur dans un état bâtard (captcha forcé, salons fermés)
// impossible à remettre exactement comme avant.

const mongoose = require('mongoose');

const HISTORY_MAX = 25;

const disconSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },
  level:   { type: Number, default: 0, min: 0, max: 5 },
  byId:    { type: String, default: null },       // dernier auteur du changement
  changedAt: { type: Date, default: null },

  // État d'avant DISCON, pour restaurer à l'identique en revenant au niveau 0.
  snapshot: {
    captchaEnabled: { type: Boolean, default: null }, // null = pas encore capturé
    lockdown:       { type: Boolean, default: false }, // salons fermés par DISCON ?
    slowmode:       { type: Boolean, default: false }, // mode lent posé par DISCON ?
    invites:        { type: Boolean, default: false }, // invitations suspendues par DISCON ?
    shield:         { type: Boolean, default: false }, // salons masqués par DISCON ?
  },

  history: [{
    _id: false,
    level: { type: Number },
    byId:  { type: String, default: null },
    at:    { type: Date, default: Date.now },
  }],
}, { timestamps: true });

// Journal borné : on ne garde que les derniers changements.
disconSchema.pre('save', function trimHistory(next) {
  if (Array.isArray(this.history) && this.history.length > HISTORY_MAX) {
    this.history = this.history.slice(-HISTORY_MAX);
  }
  next();
});

module.exports = mongoose.models.Discon || mongoose.model('Discon', disconSchema);
module.exports.HISTORY_MAX = HISTORY_MAX;
