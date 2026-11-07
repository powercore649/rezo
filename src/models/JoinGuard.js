'use strict';
// models/JoinGuard.js — Vigie : contrôle du profil à l'arrivée.
//
// L'anti-raid surveille le *nombre* d'arrivées ; Vigie juge chaque arrivée
// *individuellement* : compte créé il y a quelques minutes, pas d'avatar,
// pseudo contenant une invitation, un mot d'arnaque, un caractère invisible ou
// une imitation du staff. Chaque décision est notée (score) et journalisée.
//
// Un document par serveur. Les décisions récentes sont plafonnées
// (voir MAX_RECENT dans utils/joinGuardEngine.js).

const mongoose = require('mongoose');

const joinGuardSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },

  // ── Moteur ────────────────────────────────────────────────────────────────
  enabled:      { type: Boolean, default: false },
  logChannelId: { type: String, default: null },

  // ── Contrôles activables un par un ────────────────────────────────────────
  checks: {
    accountAge:    { type: Boolean, default: true }, // compte trop récent
    noAvatar:      { type: Boolean, default: true }, // avatar par défaut
    inviteLink:    { type: Boolean, default: true }, // invitation Discord dans le pseudo
    scamWords:     { type: Boolean, default: true }, // mot d'arnaque (nitro, free…)
    impersonation: { type: Boolean, default: true }, // imitation du staff (admin, modo…)
    invisible:     { type: Boolean, default: true }, // caractères invisibles / trompeurs
    repeatedChars: { type: Boolean, default: true }, // aaaaaaaaa
  },

  // ── Seuils ────────────────────────────────────────────────────────────────
  minAccountAgeDays: { type: Number, default: 7 },  // 0 = contrôle désactivé
  blockScore:        { type: Number, default: 40 }, // score → blocage immédiat
  reviewScore:       { type: Number, default: 20 }, // score → mise sous surveillance

  // ── Décisions ─────────────────────────────────────────────────────────────
  // Trois réponses possibles à un compte trop récent, comme sur les grosses
  // protections : `kick` (expulser), `jail` (salle d'attente jusqu'à l'âge
  // requis, libération automatique) ou `captcha` (aucune sanction : la porte
  // de vérification décide). `ban`, `quarantine` et `log` restent disponibles.
  actionBlock:  { type: String, enum: ['kick', 'ban', 'quarantine', 'jail', 'captcha', 'log'], default: 'kick' },
  actionReview: { type: String, enum: ['quarantine', 'log'], default: 'log' },
  quarantineRoleId: { type: String, default: null },

  // Membres en salle d'attente : libérés par le cron dès que leur compte
  // atteint `minAccountAgeDays` (voir utils/joinJail.js).
  jail: [{
    userId:    { type: String, required: true },
    releaseAt: { type: Date, required: true },
    at:        { type: Date, default: Date.now },
  }],

  // Salon où le rapport de vérification douteuse est envoyé (repli : logChannelId).
  reviewChannelId: { type: String, default: null },
  dmOnBlock:    { type: Boolean, default: true }, // prévenir le membre par MP (avant d'agir)

  // ── Listes ────────────────────────────────────────────────────────────────
  blockedWords: { type: [String], default: [] }, // mots interdits (pseudo / nom)
  allowedWords: { type: [String], default: [] }, // exceptions à ces mots
  trustedRoles: { type: [String], default: [] }, // membres jamais contrôlés
  trustedUsers: { type: [String], default: [] },
  useAntiRaidBlacklist: { type: Boolean, default: true }, // partage la liste noire anti-raid

  // ── État ──────────────────────────────────────────────────────────────────
  stats: {
    allowed:       { type: Number, default: 0 },
    reviewed:      { type: Number, default: 0 },
    blocked:       { type: Number, default: 0 },
    lastDecisionAt:{ type: Date, default: null },
  },
  recent: [{
    at:      { type: Date, default: Date.now },
    userId:  { type: String, default: null },
    userTag: { type: String, default: null },
    level:   { type: String, default: 'safe' },
    score:   { type: Number, default: 0 },
    action:  { type: String, default: 'allow' },
    reasons: { type: [String], default: [] },
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

joinGuardSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.models.JoinGuard || mongoose.model('JoinGuard', joinGuardSchema);
