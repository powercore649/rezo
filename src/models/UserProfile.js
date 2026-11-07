const mongoose = require('mongoose');

// Modèle du profil public d'un membre sur un serveur.
//
// Un document par couple (userId, guildId). Il ne stocke QUE ce que le membre
// choisit : le reste (niveau, bumps, badges gagnés, ancienneté…) est calculé à
// la volée depuis les autres collections, donc jamais désynchronisé.
const userProfileSchema = new mongoose.Schema({
  userId:  { type: String, required: true },
  guildId: { type: String, required: true },

  title: { type: String, default: '', maxlength: 48 },  // phrase d'accroche
  bio:   { type: String, default: '', maxlength: 240 },  // présentation libre

  color:     { type: String, default: null }, // accent de la carte (#RRGGBB), null = couleur REZO
  bannerUrl: { type: String, default: null }, // bannière personnalisée (http(s))

  // Badges mis en avant, dans l'ordre choisi. Vide = tous les badges gagnés.
  pinnedBadges: { type: [String], default: [] },
  showBadges:   { type: Boolean, default: true },

  // public  : tout le serveur peut voir le profil complet
  // serveur : idem (compatibilité de lecture)
  // prive   : seul le propriétaire voit son profil
  visibility: {
    type: String,
    enum: ['public', 'serveur', 'prive'],
    default: 'serveur',
  },

  views: { type: Number, default: 0 },
}, { timestamps: true });

userProfileSchema.index({ userId: 1, guildId: 1 }, { unique: true });
userProfileSchema.index({ guildId: 1, updatedAt: -1 });

module.exports = mongoose.model('UserProfile', userProfileSchema);
