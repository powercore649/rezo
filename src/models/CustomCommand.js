const mongoose = require('mongoose');

// models/CustomCommand.js — Commandes personnalisées créées par les membres.
//
// Pourquoi ce modèle existe : Discord n'autorise PAS un bot à publier une
// commande slash par membre. Les commandes globales sont plafonnées à 100 pour
// toute l'application, et une commande appartient au bot, jamais à un
// utilisateur. Chaque commande personnelle est donc stockée ici (une par
// serveur) et exécutée par `/custom utiliser` — ou par le préfixe du serveur,
// qui déclenche `b!ma-commande`.
//
// Le nom est unique par serveur : `/custom utiliser` doit pouvoir désigner la
// commande sans ambiguïté.
const customCommandSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  ownerId: { type: String, required: true, index: true },

  // Nom déclencheur normalisé : minuscules, chiffres, '-' et '_' uniquement.
  name: { type: String, required: true },

  // Courte description affichée dans la liste et l'autocomplétion.
  description: { type: String, default: '', maxlength: 120 },

  // Texte renvoyé, avec variables {user}, {mention}, {username}, {displayname},
  // {server}, {channel}, {count}, {args}.
  response: { type: String, required: true, maxlength: 4000 },

  // Partage : par défaut la commande n'est utilisable que par son créateur.
  isPublic: { type: Boolean, default: false },

  // Réponse visible uniquement par l'auteur de l'appel.
  ephemeral: { type: Boolean, default: false },

  // Restriction d'accès optionnelle (si la commande est partagée).
  allowedRoleIds: { type: [String], default: [] },

  enabled: { type: Boolean, default: true },

  usageCount: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: null },
}, { timestamps: true, minimize: false });

// Un seul nom par serveur — évite que `/custom utiliser` devienne ambigu.
customCommandSchema.index({ guildId: 1, name: 1 }, { unique: true });

module.exports = mongoose.models.CustomCommand || mongoose.model('CustomCommand', customCommandSchema);
