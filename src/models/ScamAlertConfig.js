'use strict';
// models/ScamAlertConfig.js — Abonnement d'un serveur au réseau d'alertes scams.
//
// Chaque serveur définit où les alertes validées arrivent (scamChannelId) et où
// les signalements de ses propres membres doivent être validés (reviewChannelId).
// La whitelist de types permet de ne recevoir que les scams pertinents.

const mongoose = require('mongoose');

const scamAlertConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // ── Abonnement réseau ────────────────────────────────────────────────────
  subscribed:     { type: Boolean, default: false }, // recevoir les alertes validées
  scamChannelId:  { type: String, default: null },   // salon de réception des alertes
  minVotes:       { type: Number, default: 3 },      // votes "scam confirmé" min. pour diffuser chez soi
  typeFilter:     { type: [String], default: [] },   // vide = tous les types

  // ── Signalements locaux (formulaire /scam) ───────────────────────────────
  reportsEnabled:    { type: Boolean, default: true },  // accepter les /scam sur ce serveur
  reviewChannelId:   { type: String, default: null },   // salon de validation staff (carte pending)
  autoApprove:       { type: Boolean, default: false }, // publier sans validation staff
  cooldownMinutes:   { type: Number, default: 10 },     // anti-spam par utilisateur
  requiredProof:     { type: Boolean, default: true },  // exiger une preuve (lien/capture)
  blacklistReporters:{ type: [String], default: [] },   // utilisateurs interdits de signalement

  // ── Statistiques ─────────────────────────────────────────────────────────
  alertsReceived: { type: Number, default: 0 },
  reportsSent:    { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.models.ScamAlertConfig || mongoose.model('ScamAlertConfig', scamAlertConfigSchema);
