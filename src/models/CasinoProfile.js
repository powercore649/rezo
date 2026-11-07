const mongoose = require('mongoose');

// Profil casino d'un membre : statistiques cumulées, progression et garde-fous
// personnels (limite de perte journalière, auto-exclusion).
// L'historique des 10 dernières parties est embarqué pour rester lisible en un
// seul document, sans requête supplémentaire.
const historySchema = new mongoose.Schema({
  game:   { type: String, default: null },
  bet:    { type: Number, default: 0 },
  payout: { type: Number, default: 0 },
  net:    { type: Number, default: 0 },
  at:     { type: Date, default: Date.now },
}, { _id: false });

const casinoProfileSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },

  // Compteurs cumulés depuis toujours : misé, rendu, bénéfice net.
  wagered: { type: Number, default: 0 },
  payout:  { type: Number, default: 0 },
  profit:  { type: Number, default: 0 },

  gamesPlayed: { type: Number, default: 0 },
  wins:        { type: Number, default: 0 },
  losses:      { type: Number, default: 0 },
  pushes:      { type: Number, default: 0 },
  jackpotsWon: { type: Number, default: 0 },

  biggestWin: { type: Number, default: 0 },
  streak:     { type: Number, default: 0 },
  bestStreak: { type: Number, default: 0 },

  xp:    { type: Number, default: 0 },
  level: { type: Number, default: 1 },

  lastBetAt: { type: Date, default: null },
  lastGame:  { type: String, default: null },

  // Limite de perte personnelle : 0 = désactivée. Remise à zéro chaque jour.
  lossLimit: { type: Number, default: 0 },
  dailyKey:  { type: String, default: null },
  dailyLoss: { type: Number, default: 0 },

  // Auto-exclusion volontaire : aucune mise avant cette date.
  selfExcludeUntil: { type: Date, default: null },

  history: { type: [historySchema], default: [] },
}, { timestamps: true });

casinoProfileSchema.index({ guildId: 1, userId: 1 }, { unique: true });
casinoProfileSchema.index({ guildId: 1, profit: -1 });
casinoProfileSchema.index({ guildId: 1, wagered: -1 });

module.exports = mongoose.model('CasinoProfile', casinoProfileSchema);
