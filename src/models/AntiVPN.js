'use strict';
// models/AntiVPN.js — Filtrage des connexions VPN / proxy / Tor à l'arrivée.
//
// Un bot Discord ne reçoit JAMAIS l'adresse IP d'un membre via l'API : la seule
// façon d'en obtenir une est de faire passer le membre par une page web que
// nous contrôlons (voir src/web/verifyServer.js). À l'arrivée, le membre reçoit
// donc un lien de vérification ; l'IP est lue au moment où il ouvre la page,
// puis comparée au fournisseur d'intelligence IP choisi.
//
// Ce document stocke toute la politique du serveur : détection, sanctions,
// exemptions, salons et listes. Il est piloté par la commande /antivpn.

const mongoose = require('mongoose');

const ACTIONS = ['kick', 'ban', 'quarantine', 'timeout', 'none'];

const antiVpnSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },

  enabled: { type: Boolean, default: false },

  // ── Parcours de vérification ─────────────────────────────────────────────
  verification: {
    channelId: { type: String, default: null },   // salon où poster le lien
    roleBefore: { type: String, default: null },  // rôle « non vérifié » (accès bloqué)
    roleAfter: { type: String, default: null },   // rôle donné après validation
    timeoutMin: { type: Number, default: 15 },    // temps pour se vérifier
    dm: { type: Boolean, default: true },         // prévenir aussi en message privé

    // Verrouillage TOTAL : aucun salon visible tant que la vérification n'est
    // pas terminée. Le bot crée un rôle dédié et ajoute uniquement, sur chaque
    // salon, une entrée « Voir les salons » = refusé pour ce rôle ; les
    // permissions existantes ne sont jamais modifiées. Les rôles du membre
    // sont retirés puis restaurés (voir utils/antiVpnLock.js).
    lockAll: { type: Boolean, default: true },
    lockRoleId: { type: String, default: null }, // rôle « mur » géré par le bot
  },

  // ── Détection ────────────────────────────────────────────────────────────
  detection: {
    blockVPN: { type: Boolean, default: true },
    blockProxy: { type: Boolean, default: true },
    blockTor: { type: Boolean, default: true },
    blockHosting: { type: Boolean, default: false }, // datacenters : faux positifs fréquents
    riskThreshold: { type: Number, default: 70 },    // 0-100, 0 = ignorer le score
    allowIPs: { type: [String], default: [] },       // IP ou CIDR (IPv4) toujours acceptés
    blockCountries: { type: [String], default: [] }, // codes ISO2
    allowCountries: { type: [String], default: [] }, // si non vide : liste blanche
    blockASNs: { type: [String], default: [] },      // ex. AS16276
  },

  // ── Sanction immédiate si la connexion est refusée ───────────────────────
  sanction: {
    action: { type: String, enum: ACTIONS, default: 'kick' },
    quarantineRoleId: { type: String, default: null },
    timeoutMinutes: { type: Number, default: 1440 }, // si action = timeout
    dmUser: { type: Boolean, default: true },        // expliquer la sanction en MP
  },

  // Sanction quand le délai de vérification expire (le membre n'a jamais cliqué).
  timeoutAction: { type: String, enum: ACTIONS, default: 'kick' },

  // Comportement si le fournisseur d'intelligence IP est injoignable.
  //   allow → laisser entrer (disponibilité) ; block → refuser (sécurité).
  apiFailure: { type: String, enum: ['allow', 'block'], default: 'allow' },

  // ── Exemptions ───────────────────────────────────────────────────────────
  exemptRoles: { type: [String], default: [] },
  exemptUsers: { type: [String], default: [] },

  // ── Textes personnalisables ──────────────────────────────────────────────
  // Une chaîne vide = texte par défaut du bot. Placeholders acceptés :
  //   {serveur} → nom du serveur, {raison} → motif du refus, {delai} → minutes.
  messages: {
    verify: { type: String, default: '' },   // consigne du lien de vérification
    refusal: { type: String, default: '' },  // MP quand la connexion est refusée
    expired: { type: String, default: '' },  // MP quand le délai est dépassé
  },

  // ── Journalisation ───────────────────────────────────────────────────────
  logChannelId: { type: String, default: null },
  storeIp: { type: Boolean, default: false }, // ne pas conserver l'IP en base par défaut

  // ── Statistiques ─────────────────────────────────────────────────────────
  stats: {
    started: { type: Number, default: 0 },
    passed: { type: Number, default: 0 },
    blocked: { type: Number, default: 0 },
    expired: { type: Number, default: 0 },
    apiErrors: { type: Number, default: 0 },
    lastCheckAt: { type: Date, default: null },
  },

  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
}, { minimize: false });

antiVpnSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = {
  ACTIONS,
  AntiVPN: mongoose.models.AntiVPN || mongoose.model('AntiVPN', antiVpnSchema),
};
