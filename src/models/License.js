// models/License.js — Clé de licence REZO.
// Une clé est générée par l'owner du bot (/license → panel owner) puis activée
// par un serveur (/license → Activer une clé). Un serveur = une seule licence :
// l'activation remplace toute licence précédemment liée. La licence débloque
// les systèmes phares du bot (bump, territoires, etc. — voir utils/licenseGate).
const mongoose = require('mongoose');
const { kindIds } = require('../utils/licenseCore');

const licenseSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    // Format : REZO-XXXX-XXXX-XXXX-XXXX
    match: /^REZO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  },
  guildId:      { type: String, default: null }, // premier serveur lié (compatibilité)
  guildName:    { type: String, default: null }, // mémorisé à l'activation
  // Tous les serveurs couverts par la clé. `guildId` reste le premier siège
  // pour les affichages et les anciennes licences mono-serveur.
  guildIds:     { type: [String], default: [] },
  seatsUsed:    { type: Number, default: 0, min: 0 },
  activatedBy:  { type: String, default: null }, // ID du membre qui a activé
  activatedAt:  { type: Date,   default: null },

  // Type de licence : nombre de serveurs couverts et usage (vente/interne).
  // Liste dérivée de utils/licenseCore : ajouter un palier là-bas suffit,
  // le schéma ne peut plus refuser une clé que le code sait émettre.
  kind:         { type: String, enum: kindIds(), default: 'standard' },
  maxGuilds:    { type: Number, default: 1, min: 1, max: 25 },
  planId:       { type: String, default: 'custom', maxLength: 40 },
  // Modules ouverts EN PLUS du palier, apportés par un pack (ex. l'IA sur un
  // palier Standard). Vide pour une licence individuelle : c'est la seule
  // différence de droits entre les deux.
  // Jours d'accès maintenus après l'expiration, le temps de renouveler.
  extras:       { type: [String], default: [] },
  graceDays:    { type: Number, default: 3, min: 0, max: 60 },
  lastValidatedAt: { type: Date, default: null },
  createdBy:    { type: String, required: true }, // ID de l'owner générateur
  createdAt:    { type: Date,   default: Date.now },
  expiresAt:    { type: Date,   default: null }, // null = illimitée
  note:         { type: String, default: '', maxLength: 200 }, // note libre (ex: "client #42")
  revoked:      { type: Boolean, default: false },
  revokedAt:    { type: Date,   default: null },
  revokedBy:    { type: String, default: null },
  revokedReason:{ type: String, default: '' },
});

// Un serveur ne peut avoir qu'une seule licence active à la fois.
licenseSchema.index(
  { guildId: 1 },
  { unique: true, partialFilterExpression: { guildId: { $type: 'string' } } },
);
// Une licence réseau peut couvrir plusieurs serveurs : recherche par siège.
licenseSchema.index({ guildIds: 1 });

// Une licence ne se « récupère » jamais par un doublon : l'index partiel sur
// `guildId` sert à refuser une seconde activation (« serveur déjà licencié »).
// Le garde-fou générique de utils/guildSingleton.js ne doit pas s'appliquer.
licenseSchema.set('guildSingletonGuard', false);

module.exports = mongoose.model('License', licenseSchema);
