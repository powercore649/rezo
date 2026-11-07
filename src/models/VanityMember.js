'use strict';
// models/VanityMember.js — Suivi d'un membre vis-à-vis du vanity.
//
// Un document par couple (serveur, membre). Il porte l'état réel (rôle actif ou
// non), le dernier statut vu, la date de dernière observation et les
// informations de l'annonce : c'est ce qui permet de n'annoncer qu'une fois,
// de ne pas spammer la base à chaque changement de statut et de retirer le rôle
// après le délai de grâce quand le statut disparaît.

const mongoose = require('mongoose');

const vanityMemberSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  userId:    { type: String, required: true },

  active:     { type: Boolean, default: false },  // le rôle vanity est-il porté ?
  statusText: { type: String, default: null },    // dernier statut ayant validé
  matched:    { type: String, default: null },    // variante configurée qui a matché

  firstGrantedAt: { type: Date, default: null },
  grantedAt:      { type: Date, default: null },
  lastSeenAt:     { type: Date, default: null },
  revokedAt:      { type: Date, default: null },
  grantCount:     { type: Number, default: 0 },

  announcedAt:         { type: Date, default: null },
  announceChannelId:   { type: String, default: null },
  announceMessageId:   { type: String, default: null },
}, { timestamps: true });

vanityMemberSchema.index({ guildId: 1, userId: 1 }, { unique: true });
vanityMemberSchema.index({ guildId: 1, active: 1 });
vanityMemberSchema.index({ guildId: 1, announcedAt: -1 });

module.exports = mongoose.models.VanityMember
  || mongoose.model('VanityMember', vanityMemberSchema);
