const mongoose = require('mongoose');
// Un duel n'a aucune valeur au bout de quelques jours : sans expiration, la
// collection grandit pour toujours (une collection scannée à chaque défi sur un
// bot à plusieurs milliers de serveurs).
const DUEL_TTL_DAYS = 30;

const duelSchema = new mongoose.Schema({
  guildId:    { type: String, required: true },
  player1Id:  { type: String, required: true },
  player2Id:  { type: String, required: true },
  hp1:        { type: Number, default: 100 },
  hp2:        { type: Number, default: 100 },
  turn:       { type: String, default: null }, // userId du joueur dont c'est le tour
  status:     { type: String, enum: ['pending','active','finished'], default: 'pending' },
  winnerId:   { type: String, default: null },
  wager:      { type: Number, default: 0 }, // mise en coins
  createdAt:  { type: Date, default: Date.now },
});

// Chemins réellement demandés par /duel : sans ces index, chaque défi balayait
// toute la collection.
duelSchema.index({ guildId: 1, player1Id: 1, player2Id: 1, status: 1 });
duelSchema.index({ guildId: 1, status: 1 });
duelSchema.index({ createdAt: 1 }, { expireAfterSeconds: DUEL_TTL_DAYS * 24 * 3600 });

module.exports = mongoose.model('Duel', duelSchema);
