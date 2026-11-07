'use strict';
// models/BridgeMessage.js — Correspondance d'un message relayé et de ses copies.
//
// Pourquoi ce document existe : sans lui, impossible de propager une
// suppression. Quand un membre (ou le staff) supprime un message du pont, la
// copie doit disparaître sur TOUS les serveurs, et elle doit disparaître ici si
// elle est supprimée ailleurs. On garde donc la trace de chaque copie envoyée.
//
// Le document expire au bout de 7 jours (index TTL) : le rôle du pont est de
// relier l'instant présent, pas d'archiver la conversation — et une purge
// automatique évite que la collection grossisse sans fin.

const mongoose = require('mongoose');

const relaySchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  messageId: { type: String, required: true },
}, { _id: false });

const bridgeMessageSchema = new mongoose.Schema({
  hub: { type: String, required: true, index: true },

  // Message d'origine (le vrai message du membre, sur son serveur).
  sourceGuildId: { type: String, required: true },
  sourceGuildName: { type: String, default: '' },
  sourceChannelId: { type: String, required: true },
  sourceMessageId: { type: String, required: true, unique: true },

  authorId: { type: String, default: null },
  authorName: { type: String, default: '' },
  content: { type: String, default: '' },

  // Copies envoyées sur les autres serveurs.
  relays: { type: [relaySchema], default: [] },

  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
});

// Retrouver le document depuis une copie (suppression d'une copie par le staff).
bridgeMessageSchema.index({ 'relays.messageId': 1 });

module.exports = mongoose.models.BridgeMessage
  || mongoose.model('BridgeMessage', bridgeMessageSchema);
