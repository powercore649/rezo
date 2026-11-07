const mongoose = require('mongoose');

// Journal des mouvements de monnaie virtuelle entre membres.
// Une ligne par paiement : qui a payé, qui a reçu, combien, pourquoi.
// Sert à l'historique de /balance et aux litiges (« je n'ai jamais reçu »).
const transactionSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  fromId:    { type: String, required: true },
  toId:      { type: String, required: true },
  amount:    { type: Number, required: true, min: 1 },
  reason:    { type: String, default: '', maxlength: 140 },
  // transfer = paiement entre membres ; purchase = achat (licence) ;
  // refund = remboursement d'un achat qui n'a pas abouti.
  kind:      { type: String, enum: ['transfer', 'purchase', 'refund'], default: 'transfer' },
  createdAt: { type: Date, default: Date.now },
});

// Les deux écrans qui comptent : le flux récent du serveur, et l'historique
// d'un membre (en tant qu'émetteur ou destinataire).
transactionSchema.index({ guildId: 1, createdAt: -1 });
transactionSchema.index({ guildId: 1, fromId: 1, createdAt: -1 });
transactionSchema.index({ guildId: 1, toId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
