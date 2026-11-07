'use strict';
// models/AntiRaid.js — Protection anti-raid complète (détection, quarantaine,
// wave raids, verrouillage, honeypots). Un document par serveur.

const mongoose = require('mongoose');

const MODES = ['monitor', 'normal', 'strict'];

const antiRaidSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // ── Moteur global ────────────────────────────────────────────────────────
  enabled:      { type: Boolean, default: false },
  mode:         { type: String, enum: MODES, default: 'normal' }, // modifie les effets par défaut
  logChannelId: { type: String, default: null },

  // ── Détection de raid (arrivées massives) ───────────────────────────────
  detectionEnabled:    { type: Boolean, default: true },
  joinsThreshold:      { type: Number, default: 10 }, // nb d'arrivées…
  joinsWindowSec:      { type: Number, default: 30 }, // …dans cette fenêtre
  minAccountAgeDays:   { type: Number, default: 7 },  // 0 = désactivé — comptes plus jeunes = suspects
  suspicionThreshold:  { type: Number, default: 6 },  // nb de suspects (comptes jeunes/avatars par défaut) avant alerte
  autoResolveMin:      { type: Number, default: 0 },  // désactivation auto du verrouillage après N min (0 = manuel)

  // ── Quarantaine ──────────────────────────────────────────────────────────
  quarantineOnJoin:    { type: Boolean, default: true }, // on enlève tout rôle sauf ceux whitelistés
  quarantineRoleId:    { type: String, default: null },  // rôle ajouté aux membres en quarantaine
  quarantineDurationMin:{ type: Number, default: 30 },   // durée avant ré-attribution automatique (0 = manuel)

  // ── Wave raids (arrivées progressives) ──────────────────────────────────
  waveEnabled:    { type: Boolean, default: false },
  wavePeriodMin:  { type: Number, default: 10 },  // période d'analyse
  waveThreshold:  { type: Number, default: 25 },  // nb d'arrivées sur la période

  // ── Réponse automatique quand un raid est confirmé ──────────────────────
  response: {
    verification: { type: Boolean, default: true },   // active le captcha (si configuré) en mode raid
    kickNewAccounts: { type: Boolean, default: false },
    lockdown: { type: Boolean, default: false },
    blockInvites: { type: Boolean, default: false }, // suspend les invitations pendant le raid
  },

  // ── Escalade DISCON pendant un raid ──────────────────────────────────────
  // Cran appliqué automatiquement dès qu'un raid est confirmé, et cran d'avant
  // le raid pour restaurer exactement l'état initial à la fin.
  raidResponseLevel:  { type: Number, default: 5, min: 0, max: 5 },
  disconRaised:       { type: Boolean, default: false },
  disconBeforeRaid:   { type: Number, default: null },

  // ── État courant (raids en cours / historique récent) ───────────────────
  lockdownActive:     { type: Boolean, default: false },
  invitesBlocked:     { type: Boolean, default: false }, // invitations suspendues par la réponse raid
  raidActive:         { type: Boolean, default: false },
  raidDetectedAt:     { type: Date, default: null },
  raidCount:          { type: Number, default: 0 },   // nb de raids détectés au total
  lastRaidInfo:       { type: String, default: '' },  // résumé du dernier raid
  waveState:          { type: mongoose.Schema.Types.Mixed, default: null }, // { windowStart, joins }
  joins:              { type: [mongoose.Schema.Types.Mixed], default: [] }, // { userId, accountAge, joinedAt }

  // ── Whitelist (ne sont JAMAIS suspects) ─────────────────────────────────
  whitelistedRoleIds: { type: [String], default: [] },
  whitelistedUserIds: { type: [String], default: [] },

  // ── Anti-liste (toujours traités comme raiders potentiels) ──────────────
  bannedUserIds:      { type: [String], default: [] },
  bannedKick:         { type: Boolean, default: true },  // kick à l'arrivée…
  bannedBan:          { type: Boolean, default: false }, // …ou ban définitif
  noAvatarSuspect:    { type: Boolean, default: true },  // compte sans avatar = suspect

  // ── Membres actuellement en quarantaine (pour restauration) ─────────────
  quarantined:        { type: [{ userId: String, roles: [String], at: Date }], default: [] },
}, { timestamps: true });

// Honeypots : salons pièges — tout message envoyé dedans = bot confirmé.
// Modèle séparé pour permettre plusieurs pièges par serveur.
const honeypotSchema = new mongoose.Schema({
  guildId:    { type: String, required: true },
  channelId:  { type: String, required: true },
  messageId:  { type: String, default: null }, // message leurre posté dans le salon
  strikes:    { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now },
});
honeypotSchema.index({ guildId: 1, channelId: 1 }, { unique: true });

module.exports = {
  MODES,
  AntiRaid:        mongoose.models.AntiRaid        || mongoose.model('AntiRaid', antiRaidSchema),
  // ⚠️ Nom distinct de models/Honeypot.js (salon + bouton piège autonome) :
  // mongoose n'autorise qu'un modèle par nom — les deux systèmes coexistent.
  AntiRaidHoneypot: mongoose.models.AntiRaidHoneypot || mongoose.model('AntiRaidHoneypot', honeypotSchema),
};
