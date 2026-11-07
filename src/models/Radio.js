const mongoose = require('mongoose');

// ─── Module radio ────────────────────────────────────────────────────────────
// RadioConfig : une ligne par serveur, éditée par `/radio` → ⚙️ Réglages.
// Aucun état de lecture n'est persisté : une radio qui « reprend toute seule »
// dans un salon vide au démarrage du bot est plus gênante qu'utile. Seuls les
// réglages et les compteurs survivent à un redémarrage.
const radioConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // Interrupteur général : coupe `/radio` sans effacer les réglages.
  enabled: { type: Boolean, default: true },

  // Salons texte où le panneau (et le lancement) sont autorisés. Vide = partout.
  channelIds: { type: [String], default: [] },

  // Contrôle d'accès : avec un rôle DJ défini et djOnly actif, seuls ses membres
  // (ou les modérateurs) peuvent changer de station, couper ou régler le volume.
  djRoleId: { type: String, default: null },
  djOnly:   { type: Boolean, default: false },

  defaultVolume: { type: Number, default: 70, min: 0, max: 200 },

  // Affiche le titre du morceau en cours (métadonnées ICY) dans le panneau.
  showNowPlaying: { type: Boolean, default: true },

  stats: {
    stationPlays:  { type: Number, default: 0 },
    secondsPlayed: { type: Number, default: 0 },
    lastPlayedAt:  { type: Date, default: null },
    lastStationId: { type: String, default: null },
  },
}, { minimize: false, timestamps: true });

// RadioProfile : favoris et statistiques d'écoute d'un membre, par serveur.
// Les favoris sont personnels (le panneau est public) : chacun gère sa liste.
const radioProfileSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },

  favorites: { type: [String], default: [] },

  listens:        { type: Number, default: 0 },
  secondsPlayed:  { type: Number, default: 0 },
  lastStationId:  { type: String, default: null },
  lastListenedAt: { type: Date, default: null },
}, { minimize: false, timestamps: true });

radioProfileSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = {
  RadioConfig:  mongoose.model('RadioConfig', radioConfigSchema),
  RadioProfile: mongoose.model('RadioProfile', radioProfileSchema),
};
