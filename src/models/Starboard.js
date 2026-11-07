const mongoose = require('mongoose');

// Palier de récompense visuelle en fonction du nombre d'étoiles atteint.
const tierSchema = new mongoose.Schema({
  threshold: { type: Number, required: true },
  label:     { type: String, required: true },
  color:     { type: String, required: true }, // hex, ex: "#FFD700"
}, { _id: false });

const starboardSchema = new mongoose.Schema({
  guildId:              { type: String, required: true, unique: true },
  enabled:              { type: Boolean, default: false },
  channelId:            { type: String, default: null },

  // Émoji déclencheur : caractère Unicode uniquement ("⭐")
  emoji:                { type: String, default: '⭐' },
  threshold:            { type: Number, default: 3, min: 1, max: 500 },

  // Filtres anti-abus
  selfStarEnabled:      { type: Boolean, default: false }, // l'auteur peut-il star son propre message ?
  botMessagesEnabled:   { type: Boolean, default: false }, // les messages de bots sont-ils éligibles ?
  nsfwChannelsEnabled:  { type: Boolean, default: false }, // les salons NSFW sont-ils éligibles ?
  minAccountAgeDays:    { type: Number, default: 0, min: 0, max: 365 }, // âge min du compte qui star
  deleteOnSourceDelete: { type: Boolean, default: true }, // retirer du starboard si le message original est supprimé

  ignoredChannelIds:    { type: [String], default: [] }, // salons totalement exclus
  ignoredRoleIds:        { type: [String], default: [] }, // rôles dont les réactions ne comptent pas

  // Paliers (triés du plus haut au plus bas au moment de l'utilisation)
  tiers: {
    type: [tierSchema],
    default: [
      { threshold: 3,  label: '⭐ Étoilé',      color: '#FFD700' },
      { threshold: 10, label: '🥈 Argent',      color: '#C0C0C0' },
      { threshold: 25, label: '🥇 Or',          color: '#FFA500' },
      { threshold: 50, label: '💎 Légendaire',  color: '#B9F2FF' },
    ],
  },

  totalStarred: { type: Number, default: 0 }, // compteur cumulatif de messages ayant atteint le starboard
});

module.exports = mongoose.models.Starboard || mongoose.model('Starboard', starboardSchema);
