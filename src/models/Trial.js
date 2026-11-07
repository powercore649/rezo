// models/Trial.js — Essai gratuit des fonctionnalités premium REZO.
//
// Un seul essai par serveur ET un seul essai par personne (tous serveurs
// confondus), jamais renouvelable par défaut (configurable par l'owner via
// /license → Panel owner). L'owner peut forcer un reset pour permettre un
// second essai exceptionnel.
//
// L'essai donne exactement les mêmes accès qu'une licence complète pendant
// la durée configurée (par défaut 7 jours). À l'expiration, le serveur doit
// activer une vraie licence pour continuer.
const mongoose = require('mongoose');

const trialSchema = new mongoose.Schema({
  guildId:     { type: String, required: true, unique: true },
  guildName:   { type: String, default: null },
  startedBy:   { type: String, required: true },   // ID Discord de l'admin qui a démarré l'essai
  startedAt:   { type: Date,   default: Date.now },
  expiresAt:   { type: Date,   required: true },
  expired:     { type: Boolean, default: false },   // true dès que l'essai est terminé (évite le re-check)
  resetCount:  { type: Number, default: 0 },        // nb de fois que l'owner a réinitialisé l'essai
  resetBy:     { type: String, default: null },     // dernier owner ayant fait le reset
  note:        { type: String, default: '' },       // note interne owner
});

// L'unicité par serveur est déjà portée par le champ (guildId: unique: true) :
// déclarer un second index unique sur le même chemin faisait doublon et
// déclenchait un avertissement Mongoose « Duplicate schema index ».
trialSchema.index({ expired: 1, expiresAt: 1 });
// Un essai par personne : la vérification est faite par licenseGate.startTrial.
// Index non unique volontairement — un reset owner crée un document dont
// `startedBy` est l'owner du bot, et plusieurs resets ne doivent pas se bloquer.
trialSchema.index({ startedBy: 1 });

// Ici un doublon sur `guildId` n'est PAS une course : c'est la réponse
// « ce serveur a déjà utilisé son essai ». Le garde-fou générique de
// utils/guildSingleton.js répondrait par le document existant et laisserait
// croire à un nouvel essai : on le désactive explicitement.
trialSchema.set('guildSingletonGuard', false);

module.exports = mongoose.models.Trial || mongoose.model('Trial', trialSchema);
