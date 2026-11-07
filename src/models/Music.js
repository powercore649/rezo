const mongoose = require('mongoose');

// ─── Module musique ──────────────────────────────────────────────────────────
// Un seul document par serveur : c'est le panneau /musique → Réglages qui
// l'édite. Aucun état de lecture n'est stocké en base (la file vit en mémoire,
// elle ne survit volontairement pas à un redémarrage : un bot qui « rejoue »
// un son dans un salon vide au boot est plus gênant qu'utile).
const musicConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // Contrôle d'accès : si un rôle DJ est défini (et djOnly actif), seuls ses
  // membres — ou les modérateurs — peuvent passer/arrêter/changer le volume.
  djRoleId: { type: String, default: null },
  djOnly:   { type: Boolean, default: false },

  defaultVolume: { type: Number, default: 70 },   // 0-200 (%)
  maxQueue:      { type: Number, default: 100 },  // morceaux en attente
  autoplay:      { type: Boolean, default: true }, // enchaîne sur des titres proches
  announce:      { type: Boolean, default: true }, // publie la carte à chaque morceau

  stats: {
    tracksPlayed: { type: Number, default: 0 },
    secondsPlayed: { type: Number, default: 0 },
    lastPlayedAt: { type: Date, default: null },
  },
}, { minimize: false });

module.exports = mongoose.model('MusicConfig', musicConfigSchema);
