const mongoose = require('mongoose');

// Configuration du système anti-arnaque par image (OCR + règles de détection).
// Aucune donnée d'image n'est jamais stockée : seul le texte extrait est analysé
// en mémoire le temps du scan, puis jeté.
const antiScamSchema = new mongoose.Schema({
  guildId:        { type: String,  required: true, unique: true },
  enabled:        { type: Boolean, default: false },

  // Salon où l'embed d'alerte est envoyé (comme dans les captures MyProtect)
  logChannelId:   { type: String,  default: null },

  // Seuil de suspicion (0-100) à partir duquel l'action est déclenchée
  threshold:      { type: Number,  default: 60 },

  // Action appliquée à l'auteur quand le seuil est atteint
  action:         { type: String,  enum: ['none', 'warn', 'mute', 'kick', 'ban'], default: 'ban' },
  muteDuration:   { type: Number,  default: 60 }, // minutes, si action = mute
  deleteMessage:  { type: Boolean, default: true },

  // Catégories de détection activables indépendamment
  detectCrypto:      { type: Boolean, default: true },  // crypto / giveaways
  detectUrgency:      { type: Boolean, default: true },  // incitation à l'action immédiate
  detectImpersonation:{ type: Boolean, default: true },  // usurpation de marque connue (Discord, Steam, Nitro, banques...)
  detectFinancial:    { type: Boolean, default: true },  // retrait/transfert financier suspect

  // Mots-clés personnalisés ajoutés par le staff, en plus de la liste intégrée
  customKeywords: { type: [String], default: [] },

  // Exemptions
  exemptRoles:    { type: [String], default: [] },
  exemptChannels: { type: [String], default: [] },

  // Statistiques (alimentées automatiquement par le scanner)
  totalScanned:   { type: Number, default: 0 },
  totalDetected:  { type: Number, default: 0 },
});

module.exports = mongoose.model('AntiScamConfig', antiScamSchema);
