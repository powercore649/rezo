const mongoose = require('mongoose');

const voteSchema = new mongoose.Schema({
  voterId:   { type: String, required: true },
  targetId:  { type: String, required: true }, // guildId du serveur voté
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // TTL 24h auto
});

// Un utilisateur ne peut voter qu'une fois par serveur par 24h
voteSchema.index({ voterId: 1, targetId: 1 }, { unique: true });

module.exports = mongoose.model('Vote', voteSchema);
