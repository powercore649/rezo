const mongoose = require('mongoose');

// Configuration du casino, une ligne par serveur.
// Tous les réglages sont administrables depuis `/casino config`.
// Les valeurs par défaut permettent un casino immédiatement jouable, mais
// désactivable d'un clic si le serveur ne veut pas de jeu d'argent virtuel.
const gamesSchema = new mongoose.Schema({
  machine:   { type: Boolean, default: true },
  roulette:  { type: Boolean, default: true },
  blackjack: { type: Boolean, default: true },
  des:       { type: Boolean, default: true },
  piece:     { type: Boolean, default: true },
}, { _id: false });

const lastJackpotSchema = new mongoose.Schema({
  userId: { type: String, default: null },
  amount: { type: Number, default: 0 },
  at:     { type: Date, default: null },
}, { _id: false });

const casinoConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // Interrupteur général : rien ne se joue quand il est coupé.
  enabled: { type: Boolean, default: true },

  // Salons autorisés (vide = tout le serveur).
  channelIds: { type: [String], default: [] },

  minBet: { type: Number, default: 10, min: 1 },
  maxBet: { type: Number, default: 5000, min: 1 },

  // Délai entre deux mises d'un même membre (0 = aucune limite).
  cooldownSec: { type: Number, default: 5, min: 0, max: 3600 },

  // Cagnotte commune du serveur, alimentée par un pourcentage de chaque mise.
  jackpot:        { type: Number, default: 1000, min: 0 },
  jackpotSeed:    { type: Number, default: 1000, min: 100 },
  jackpotPercent: { type: Number, default: 5, min: 0, max: 25 },

  games: { type: gamesSchema, default: () => ({}) },

  // Annonce publique des gros gains (0 = jamais).
  announceWins:      { type: Boolean, default: true },
  announceThreshold: { type: Number, default: 5000, min: 0 },

  lastJackpot: { type: lastJackpotSchema, default: null },
}, { timestamps: true });

module.exports = mongoose.model('CasinoConfig', casinoConfigSchema);
