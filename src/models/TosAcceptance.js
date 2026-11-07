const mongoose = require('mongoose');

// models/TosAcceptance.js — Acceptation des conditions d'utilisation de REZO.
//
// Un document par membre (l'acceptation est globale, pas par serveur) :
//   • `version`  → dernière version acceptée ; une version différente de celle
//                  du document (utils/tosDocument.js) redemande l'acceptation ;
//   • `history`  → les 10 dernières acceptations, pour garder une trace datée
//                  même après plusieurs changements de version.
//
// Aucune donnée de message n'est stockée ici : uniquement l'identifiant
// Discord, la version et la date — c'est ce que les conditions annoncent.
const tosAcceptanceSchema = new mongoose.Schema({
  userId:     { type: String, required: true, unique: true },

  version:    { type: String, required: true },
  acceptedAt: { type: Date, default: Date.now },

  // Provenance de l'acceptation : 'slash', 'prefix' (bouton d'un message texte)
  // ou 'command' (bouton du prompt en slash).
  source:     { type: String, default: 'button' },

  // Serveur où l'acceptation a eu lieu (null en MP).
  guildId:    { type: String, default: null },

  history: [{
    version:    { type: String },
    acceptedAt: { type: Date },
    source:     { type: String },
  }],
}, { minimize: false });

module.exports = mongoose.models.TosAcceptance
  || mongoose.model('TosAcceptance', tosAcceptanceSchema);
