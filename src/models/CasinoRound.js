const mongoose = require('mongoose');

// Une table de blackjack en cours (ou réglée).
// L'état (sabot, mains, mise doublée) est persisté : un redémarrage du bot ne
// fait pas perdre la mise du joueur, la table est réglée à la prochaine action
// ou par le balayage des tables expirées.
const casinoRoundSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  userId:    { type: String, required: true },
  channelId: { type: String, default: null },

  game: { type: String, default: 'blackjack' },
  bet:  { type: Number, required: true },

  // { deck: [{r,s}], player: [...], dealer: [...], doubled, finished }
  state: { type: mongoose.Schema.Types.Mixed, default: {} },

  status: { type: String, enum: ['active', 'finished'], default: 'active' },
  outcome: { type: String, default: null },
  payout:  { type: Number, default: 0 },

  expiresAt: { type: Date, required: true },
  settledAt: { type: Date, default: null },
}, { timestamps: true });

casinoRoundSchema.index({ guildId: 1, status: 1, expiresAt: 1 });
casinoRoundSchema.index({ userId: 1, guildId: 1, createdAt: -1 });

module.exports = mongoose.model('CasinoRound', casinoRoundSchema);
