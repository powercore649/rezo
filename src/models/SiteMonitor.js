'use strict';
// models/SiteMonitor.js — Surveillance de sites web par serveur.
//
// Un document par serveur : la configuration (salon, intervalle, seuil,
// mots de maintenance) et les sites surveillés y sont regroupés pour que
// TOUT se règle depuis la seule commande /statut-site.
//
// L'état de chaque site est conservé pour détecter les transitions :
// en ligne → hors ligne → maintenance → rétabli. Un seul document par serveur
// évite les requêtes dispersées et permet de sauvegarder l'état atomiquement.

const mongoose = require('mongoose');
const { DEFAULT_MAINTENANCE_KEYWORDS, MAX_SITES, DEFAULT_INTERVAL_MINUTES, DEFAULT_FAILURE_THRESHOLD } = require('../utils/siteStatus');

const siteSchema = new mongoose.Schema({
  url:   { type: String, required: true, maxlength: 300 },

  // Nom lisible affiché dans les alertes (par défaut : l'hôte).
  label: { type: String, default: null, maxlength: 80 },

  enabled: { type: Boolean, default: true },

  // ── État courant ──────────────────────────────────────────────────────────
  status:       { type: String, enum: ['unknown', 'online', 'maintenance', 'down'], default: 'unknown' },
  statusCode:   { type: Number, default: null },
  responseMs:   { type: Number, default: null },
  error:        { type: String, default: null, maxlength: 300 },

  lastCheckedAt: { type: Date, default: null },
  lastChangeAt:  { type: Date, default: null }, // dernier changement d'état
  since:         { type: Date, default: null }, // début de l'état courant

  failures: { type: Number, default: 0 }, // échecs consécutifs
  checks:   { type: Number, default: 0 },
  upChecks: { type: Number, default: 0 },

  // Dernier état pour lequel une alerte a été envoyée : empêche les doublons.
  alertedStatus: { type: String, enum: ['online', 'maintenance', 'down', null], default: null },

  // Mots déclenchant la maintenance pour CE site. Vide = liste du serveur.
  maintenanceKeywords: { type: [String], default: [] },
}, { _id: true });

const siteMonitorSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  enabled:  { type: Boolean, default: false },
  channelId: { type: String, default: null },

  intervalMinutes:  { type: Number, default: DEFAULT_INTERVAL_MINUTES, min: 5,  max: 120 },
  failureThreshold: { type: Number, default: DEFAULT_FAILURE_THRESHOLD, min: 1, max: 5 },

  // Mots recherchés dans la page pour conclure à une maintenance (insensible à la casse et aux accents).
  maintenanceKeywords: { type: [String], default: () => [...DEFAULT_MAINTENANCE_KEYWORDS] },

  // Message libre envoyé avec l'alerte. Placeholders : {site} {url} {statut} {code} {temps} {durée}
  alertMessage: { type: String, default: null, maxlength: 500 },

  sites: { type: [siteSchema], default: [] },

  updatedAt: { type: Date, default: Date.now },
}, { minimize: false });

siteMonitorSchema.pre('save', function touch(next) {
  this.updatedAt = new Date();
  if (this.sites.length > MAX_SITES) {
    return next(new Error(`Un serveur ne peut surveiller que ${MAX_SITES} sites.`));
  }
  return next();
});

module.exports = mongoose.models.SiteMonitor || mongoose.model('SiteMonitor', siteMonitorSchema);
