'use strict';
// models/AiMemory.js — Mémoire persistante de l'IA sur chaque membre.
//
// L'historique brut (AiConversation) est volontairement borné : il ne garde que
// les derniers échanges, sinon le document grossit sans fin. Ce modèle-ci est la
// mémoire LONGUE : qui est la personne, depuis quand on se parle, combien de
// fois, et un résumé glissant de ce qu'elle a raconté (goûts, projets, ton).
//
// Une ligne par membre et par serveur, mise à jour à chaque message.

const mongoose = require('mongoose');

const aiMemorySchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },

  // Dernier nom affiché connu : permet de saluer la personne par son prénom
  // même des semaines après le dernier échange.
  displayName: { type: String, default: null },

  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt:  { type: Date, default: Date.now },

  // Compteurs d'usage
  userMessages:  { type: Number, default: 0 },
  answers:       { type: Number, default: 0 },
  imageRequests: { type: Number, default: 0 },

  // Résumé glissant, réécrit par l'IA quand les anciens messages sortent de la
  // fenêtre de contexte. Jamais récité tel quel à l'utilisateur.
  summary:       { type: String, default: '' },
  summaryAt:     { type: Date, default: null },
  summarizedMessages: { type: Number, default: 0 },
  // Nombre de messages de la personne au moment du dernier résumé : sert à
  // savoir quand le rafraîchir (tous les MIN_EXCHANGES échanges), sans jamais
  // dépendre de la troncature de l'historique.
  summaryUserCount: { type: Number, default: 0 },

  // Dernier sujet abordé (pour reprendre la conversation naturellement).
  lastTopic: { type: String, default: null },

  // Mise en pause par l'utilisateur (respect de la vie privée).
  forgotten: { type: Boolean, default: false },
});

aiMemorySchema.index({ guildId: 1, userId: 1 }, { unique: true });
aiMemorySchema.index({ guildId: 1, lastSeenAt: -1 });

module.exports = mongoose.models.AiMemory || mongoose.model('AiMemory', aiMemorySchema);
