const mongoose = require('mongoose');

// ── Configuration du système de news par serveur ──────────────────────────────
const newsConfigSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, unique: true },
  enabled:   { type: Boolean, default: false },
  // Salons configurés par catégorie
  channels: {
    general:  { type: String, default: null }, // Actualités générales
    gaming:   { type: String, default: null }, // Jeux vidéo
    tech:     { type: String, default: null }, // Tech / numérique
    esport:   { type: String, default: null }, // Esport
    default:  { type: String, default: null }, // Salon par défaut si pas de catégorie
  },
  // Rôles à mentionner par catégorie
  roles: {
    general:  { type: String, default: null },
    gaming:   { type: String, default: null },
    tech:     { type: String, default: null },
    esport:   { type: String, default: null },
    default:  { type: String, default: null },
  },
  // Sources activées
  sources: {
    lemonde:      { type: Boolean, default: false },
    jeuxvideo:    { type: Boolean, default: true  },
    numerama:     { type: Boolean, default: true  },
    bfmtech:      { type: Boolean, default: false },
    gamekult:     { type: Boolean, default: true  },
    millenium:    { type: Boolean, default: false },
  },
  // Sources Reddit — fusionnées aux actualités : mêmes salons, même
  // anti-doublon (NewsPosted) et mêmes notifications que les flux RSS.
  reddit: {
    enabled:     { type: Boolean, default: false },
    subreddits:  { type: [String], default: [] }, // sans "r/", en minuscules (5 max)
    category:    { type: String, default: 'general' },
    minUpvotes:  { type: Number, default: 0 },
    mediaOnly:   { type: Boolean, default: false },
    nsfwAllowed: { type: Boolean, default: false },
  },
  // Options
  footerText:   { type: String, default: 'BUMPY-NEWS v4 • Actualités' },
  showThumbnail:{ type: Boolean, default: true },
  interval:     { type: Number, default: 30 },     // Minutes entre chaque vérification
  logChannelId: { type: String, default: null },
  lastCheck:    { type: Date, default: null },
});

// ── Articles déjà postés (anti-doublon) ──────────────────────────────────────
const newsPostedSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  articleId: { type: String, required: true }, // hash du lien
  source:    { type: String, required: true },
  postedAt:  { type: Date, default: Date.now, expires: 7 * 24 * 3600 }, // TTL 7 jours
});
newsPostedSchema.index({ guildId: 1, articleId: 1 }, { unique: true });

module.exports = {
  NewsConfig: mongoose.model('NewsConfig', newsConfigSchema),
  NewsPosted: mongoose.model('NewsPosted', newsPostedSchema),
};
