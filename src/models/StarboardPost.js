const mongoose = require('mongoose');

// Fait le lien entre un message original et sa copie sur le starboard,
// pour pouvoir l'éditer/supprimer quand le nombre d'étoiles évolue.
const starboardPostSchema = new mongoose.Schema({
  guildId:            { type: String, required: true },
  sourceMessageId:    { type: String, required: true },
  sourceChannelId:    { type: String, required: true },
  starboardMessageId: { type: String, required: true },
  authorId:           { type: String, required: true },
  starCount:          { type: Number, default: 0 },
  createdAt:          { type: Date, default: Date.now },
  updatedAt:          { type: Date, default: Date.now },
});

starboardPostSchema.index({ guildId: 1, sourceMessageId: 1 }, { unique: true });

module.exports = mongoose.models.StarboardPost || mongoose.model('StarboardPost', starboardPostSchema);
