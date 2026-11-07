const mongoose = require('mongoose');

// Un document par (serveur, subreddit) suivi — plusieurs subreddits possibles
// par serveur, chacun avec ses propres filtres et salon de destination.
const redditWatchSchema = new mongoose.Schema({
  guildId:         { type: String, required: true },
  subreddit:       { type: String, required: true }, // sans "r/", en minuscules
  channelId:       { type: String, default: null },
  roleId:          { type: String, default: null },  // rôle ping optionnel
  enabled:         { type: Boolean, default: false },
  sort:            { type: String, enum: ['new', 'hot', 'top'], default: 'new' },

  minUpvotes:      { type: Number, default: 0, min: 0 },
  nsfwAllowed:     { type: Boolean, default: false },
  mediaOnly:       { type: Boolean, default: false }, // uniquement les posts avec image/vidéo
  includeKeywords: { type: [String], default: [] },   // le titre doit contenir au moins un mot-clé
  excludeKeywords: { type: [String], default: [] },   // le titre ne doit contenir aucun de ces mots
  excludeFlairs:   { type: [String], default: [] },

  // Suivi anti-doublon : on ne poste que ce qui est apparu APRÈS ce timestamp,
  // pour ne jamais déverser tout l'historique du subreddit à l'ajout.
  lastCheckedUTC:  { type: Number, default: () => Math.floor(Date.now() / 1000) },
  postedIds:       { type: [String], default: [] }, // garde-fou anti-doublon supplémentaire

  totalPosted:     { type: Number, default: 0 },
});

redditWatchSchema.index({ guildId: 1, subreddit: 1 }, { unique: true });

module.exports = mongoose.models.RedditWatch || mongoose.model('RedditWatch', redditWatchSchema);
