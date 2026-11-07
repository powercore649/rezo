const mongoose = require('mongoose');

// ─── Trésors cachés ───────────────────────────────────────────────────────────
// Nouveau module : un coffre apparaît dans un salon de chasse, des indices
// tombent au fil du temps, et le premier membre qui tape le mot du coffre
// l'ouvre (XP, pièces, et un rôle bonus sur un coffre légendaire).
//
// Trois collections :
//   • TreasureConfig  — réglages par serveur (panneau /tresor)
//   • TreasureHunt    — le coffre EN COURS (au plus un par serveur)
//   • TreasureProfile — carrière de chasseur d'un membre (victoires, séries)

// ── Mots personnalisés (ajoutés par l'admin en plus de la banque par défaut) ──
const customWordSchema = new mongoose.Schema({
  word:   { type: String, required: true, maxlength: 40 },
  clues:  { type: [String], default: [] },
  rarity: { type: String, enum: ['common', 'rare', 'legendary'], default: 'common' },
}, { _id: false });

const treasureConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: false },

  // Salons où un coffre peut apparaître. Vide = module inopérant (rien ne se
  // lance tant que l'admin n'a pas désigné au moins un salon).
  channels:          { type: [String], default: [] },
  announceChannelId: { type: String, default: null }, // null = salon du coffre

  // Rythme
  minDelayMinutes:    { type: Number, default: 60 },  // délai minimum entre deux coffres
  maxDelayMinutes:    { type: Number, default: 180 }, // délai maximum
  lifetimeSeconds:    { type: Number, default: 600 }, // durée de vie d'un coffre
  clueIntervalSeconds:{ type: Number, default: 90 },  // 0 = tous les indices d'un coup

  // Affichage / aide
  useCard:           { type: Boolean, default: true },  // carte canvas
  hintOnWrongGuess:  { type: Boolean, default: false }, // indice privé en cas d'erreur

  // Récompenses
  rewardXpMin:      { type: Number, default: 150 },
  rewardXpMax:      { type: Number, default: 400 },
  rewardCoinsMin:   { type: Number, default: 100 },
  rewardCoinsMax:   { type: Number, default: 300 },
  xpMultiplier:     { type: Number, default: 1 },   // appliqué selon la rareté
  coinsMultiplier:  { type: Number, default: 1 },
  legendaryRoleId:  { type: String, default: null }, // rôle offert sur un légendaire

  // Probabilités de rareté (en %, normalisées au tirage)
  odds: {
    common:    { type: Number, default: 60 },
    rare:      { type: Number, default: 30 },
    legendary: { type: Number, default: 10 },
  },

  customWords: { type: [customWordSchema], default: [] },

  // Planification : prochain coffre
  nextSpawnAt: { type: Date, default: null },

  stats: {
    hunts:      { type: Number, default: 0 },  // coffres apparus
    opened:     { type: Number, default: 0 },  // coffres ouverts par un membre
    expired:    { type: Number, default: 0 },  // coffres refermés sans gagnant
    lastHuntAt: { type: Date, default: null },
  },
}, { minimize: false });

// ── Le coffre en cours (un seul par serveur) ──────────────────────────────────
const treasureHuntSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  channelId: { type: String, required: true },
  messageId: { type: String, default: null },

  word:     { type: String, required: true },
  clues:    { type: [String], default: [] },
  rarity:   { type: String, enum: ['common', 'rare', 'legendary'], default: 'common' },

  rewardXp:    { type: Number, default: 0 },
  rewardCoins: { type: Number, default: 0 },

  startedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },

  attempts:      { type: Number, default: 0 },
  openedBy:      { type: String, default: null },
  openedAt:      { type: Date, default: null },
  clueNotifiedAt:{ type: Number, default: 1 }, // nombre d'indices déjà annoncés
}, { timestamps: true });

treasureHuntSchema.index({ guildId: 1 }, { unique: true });
treasureHuntSchema.index({ expiresAt: 1 });

// ── Carrière d'un chasseur ────────────────────────────────────────────────────
const treasureProfileSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },

  wins:      { type: Number, default: 0 },
  commonWins:{ type: Number, default: 0 },
  rareWins:  { type: Number, default: 0 },
  legendaryWins: { type: Number, default: 0 },
  attempts:  { type: Number, default: 0 },
  streak:    { type: Number, default: 0 },
  bestStreak:{ type: Number, default: 0 },
  xpEarned:  { type: Number, default: 0 },
  coinsEarned:{ type: Number, default: 0 },
  lastWinAt: { type: Date, default: null },
}, { timestamps: true });

treasureProfileSchema.index({ guildId: 1, userId: 1 }, { unique: true });
treasureProfileSchema.index({ guildId: 1, wins: -1 });

module.exports = {
  TreasureConfig:  mongoose.models.TreasureConfig  || mongoose.model('TreasureConfig', treasureConfigSchema),
  TreasureHunt:    mongoose.models.TreasureHunt    || mongoose.model('TreasureHunt', treasureHuntSchema),
  TreasureProfile: mongoose.models.TreasureProfile || mongoose.model('TreasureProfile', treasureProfileSchema),
};
