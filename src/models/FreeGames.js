const mongoose = require('mongoose');

// ── Configuration par serveur ─────────────────────────────────────────────────
const freeGamesConfigSchema = new mongoose.Schema({
  guildId:        { type: String, required: true, unique: true },
  enabled:        { type: Boolean, default: false },
  channelId:      { type: String, default: null },   // Salon où poster
  roleId:         { type: String, default: null },   // Rôle à mentionner
  // Quelles sources activer
  epicEnabled:    { type: Boolean, default: true },
  steamEnabled:   { type: Boolean, default: true },
  gamerPowerEnabled: { type: Boolean, default: true },
  // Filtres
  minRating:      { type: Number, default: 0 },      // Note minimale (0-100)
  platforms:      { type: [String], default: ['pc'] }, // pc, browser, android, ios
  // Auto-post schedule
  autoPost:       { type: Boolean, default: true },  // Poster automatiquement
  postTime:       { type: String, default: '10:00' }, // Heure UTC du post quotidien
  lastAutoPost:   { type: String, default: null },    // 'YYYY-MM-DD' — dernier post auto (survie redémarrage)
});

// ── Jeux déjà postés (pour éviter les doublons) ───────────────────────────────
const postedGameSchema = new mongoose.Schema({
  guildId:    { type: String, required: true },
  gameId:     { type: String, required: true }, // ID unique du jeu
  source:     { type: String, required: true }, // 'epic', 'steam', 'gamerpower'
  postedAt:   { type: Date, default: Date.now },
  expiresAt:  { type: Date, default: null },    // Fin de la promo
});
postedGameSchema.index({ guildId: 1, gameId: 1, source: 1 }, { unique: true });
postedGameSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto

module.exports = {
  FreeGamesConfig: mongoose.model('FreeGamesConfig', freeGamesConfigSchema),
  PostedGame:      mongoose.model('PostedGame',      postedGameSchema),
};
