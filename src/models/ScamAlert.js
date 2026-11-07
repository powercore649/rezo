'use strict';
// models/ScamAlert.js — Dossier d'arnaque du réseau d'alertes scams.
//
// Cycle de vie :
//   1. Un membre soumet via /scam (formulaire)                 → status 'pending'
//   2. Le staff du serveur source valide/rejette la carte      → 'approved' / 'rejected'
//   3. Une validée est diffusée à tous les serveurs abonnés    → carte de vote
//   4. Chaque serveur vote 🇻🇪 (scam confirmé / non confirmé)   → votes[] + voteScore
//
// Aucune donnée sensible n'est stockée : pseudo public, preuve (URL), détails.

const mongoose = require('mongoose');

const SCAM_TYPES = ['phishing', 'impersonation', 'nitro', 'crypto', 'fakegiveaway', 'shop', 'steam', 'other'];

const scamAlertSchema = new mongoose.Schema({
  // ── Signalement ──────────────────────────────────────────────────────────
  type:         { type: String, enum: SCAM_TYPES, required: true },
  name:         { type: String, required: true },  // pseudo (et discriminator/id si fourni)
  guildName:    { type: String, default: null },   // serveur où opère le scammeur (si connu)
  evidenceUrl:  { type: String, default: null },   // capture / lien de preuve
  details:      { type: String, default: '' },

  // ── Auteur du signalement ────────────────────────────────────────────────
  reporterId:   { type: String, required: true },
  reporterTag:  { type: String, default: 'inconnu' },

  // ── Serveur source ───────────────────────────────────────────────────────
  sourceGuildId:   { type: String, required: true },
  sourceGuildName: { type: String, default: 'inconnu' },

  // ── Validation par le staff local ────────────────────────────────────────
  status:       { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  approverId:   { type: String, default: null },
  approverTag:  { type: String, default: null },
  decidedAt:    { type: Date, default: null },

  // ── Diffusion réseau (cartes de vote) ────────────────────────────────────
  broadcastAt:  { type: Date, default: null },
  votes:        { type: [{ userId: String, value: Number }], default: [] }, // value: 1 (scam) / 0 (non scam)
  voteScore:    { type: Number, default: 0 },

  // ── Statistiques de diffusion ────────────────────────────────────────────
  reachedGuilds: { type: Number, default: 0 },
}, { timestamps: true });

scamAlertSchema.index({ status: 1, createdAt: -1 });
scamAlertSchema.index({ reporterId: 1 });
scamAlertSchema.index({ name: 1 });

module.exports = {
  SCAM_TYPES,
  ScamAlert: mongoose.models.ScamAlert || mongoose.model('ScamAlert', scamAlertSchema),
};
