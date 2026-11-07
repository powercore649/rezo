'use strict';
// models/Confession.js — Confessions anonymes (v2)
//
// Deux documents par serveur :
//   • Confession       → une confession (en attente, publiée ou refusée)
//   • ConfessionConfig → réglages du module (salon, modération, apparence…)
//
// ⚠️ Anonymat : aucun identifiant Discord n'est stocké. `authorHash` est un
// HMAC(guildId:userId) — il permet le cooldown par auteur et un blocage
// éventuel, sans jamais révéler qui a écrit. La v1 stockait `authorId` en
// clair tout en affichant « hashé pour anonymat » : c'était faux.

const mongoose = require('mongoose');

const confessionSchema = new mongoose.Schema({
  guildId:     { type: String, required: true },
  channelId:   { type: String, required: true },     // salon de publication
  authorHash:  { type: String, default: null },      // HMAC — jamais l'ID Discord
  number:      { type: Number, required: true },     // #1, #2, #3...
  content:     { type: String, required: true },
  imageUrl:    { type: String, default: null },

  // 'pending' → en attente d'approbation · 'published' · 'rejected'
  status:      { type: String, enum: ['pending', 'published', 'rejected'], default: 'pending' },
  approved:    { type: Boolean, default: true },     // compat v1

  messageId:   { type: String, default: null },      // message publié
  threadId:    { type: String, default: null },      // fil de réponses anonymes
  logMessageId:{ type: String, default: null },      // message du salon de logs

  replies:     { type: Number, default: 0 },         // nombre de réponses anonymes
  decidedBy:   { type: String, default: null },      // modérateur ayant tranché
  decidedAt:   { type: Date,   default: null },
  createdAt:   { type: Date,   default: Date.now },
  publishedAt: { type: Date,   default: null },
});

// Numéro unique par serveur : deux envois simultanés ne peuvent plus se
// disputer le même numéro (la v1 faisait `count + 1`).
confessionSchema.index({ guildId: 1, number: 1 }, { unique: true });
// Cooldown durable : recherche du dernier envoi d'un auteur (par hash).
confessionSchema.index({ guildId: 1, authorHash: 1, createdAt: -1 });
confessionSchema.index({ guildId: 1, status: 1, createdAt: -1 });

const confessionConfigSchema = new mongoose.Schema({
  guildId:        { type: String, required: true, unique: true },
  channelId:      { type: String, default: null },   // salon de publication
  logChannelId:   { type: String, default: null },   // salon de modération
  alertRoleId:    { type: String, default: null },   // rôle mentionné à chaque confession à valider

  moderation:     { type: Boolean, default: false }, // approbation manuelle
  allowImages:    { type: Boolean, default: false }, // image jointe (URL)
  anonymousReplies:{ type: Boolean, default: true }, // bouton « Répondre » anonyme
  threads:        { type: Boolean, default: true },  // un fil par confession publiée

  cooldownMin:    { type: Number, default: 5 },      // minutes entre deux confessions
  embedColor:     { type: String, default: '#9B59B6' },

  nextNumber:     { type: Number, default: 0 },      // dernier numéro distribué
  stats: {
    published: { type: Number, default: 0 },
    pending:   { type: Number, default: 0 },
    rejected:  { type: Number, default: 0 },
  },

  enabled:        { type: Boolean, default: false },
  updatedAt:      { type: Date, default: Date.now },
});

module.exports = {
  Confession:       mongoose.models.Confession       || mongoose.model('Confession', confessionSchema),
  ConfessionConfig: mongoose.models.ConfessionConfig || mongoose.model('ConfessionConfig', confessionConfigSchema),
};
