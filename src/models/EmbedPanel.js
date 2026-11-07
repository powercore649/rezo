'use strict';
// models/EmbedPanel.js — Studio d'embeds : plusieurs panels persistants par serveur.
// Chaque document est un « embed panel » réutilisable : contenu, apparence,
// champs, boutons-liens et message publié (salon + messageId).

const mongoose = require('mongoose');

const fieldSchema = new mongoose.Schema({
  name:   { type: String, required: true },
  value:  { type: String, required: true },
  inline: { type: Boolean, default: false },
}, { _id: false });

const buttonSchema = new mongoose.Schema({
  label: { type: String, required: true },
  emoji: { type: String, default: '' },
  // link  : bouton-liens classique
  // role  : donne / retire / bascule un rôle au clic
  // reply : réponse éphémère personnalisée
  // ticket: ouvre le menu d'un panel de tickets
  type:  { type: String, enum: ['link', 'role', 'reply', 'ticket'], default: 'link' },
  url:   { type: String, default: '' },
  roleId:   { type: String, default: '' },
  roleMode: { type: String, enum: ['add', 'remove', 'toggle'], default: 'toggle' },
  response: { type: String, default: '' },
  ticketPanel: { type: String, default: '' },
}, { _id: false });

const panelSchema = new mongoose.Schema({
  guildId:  { type: String, required: true },
  panelKey: { type: String, required: true },
  name:     { type: String, default: 'Embed' },

  // Message publié
  channelId: { type: String, default: '' },
  messageId: { type: String, default: '' },
  content:   { type: String, default: '' }, // texte au-dessus de l'embed

  // Apparence
  authorName: { type: String, default: '' },
  authorIcon: { type: String, default: '' },
  title:      { type: String, default: '' },
  description:{ type: String, default: '' },
  color:      { type: String, default: '0x8B1A1A' },
  footer:     { type: String, default: '' },
  footerIcon: { type: String, default: '' },
  image:      { type: String, default: '' },
  thumbnail:  { type: String, default: '' },
  timestamp:  { type: Boolean, default: true },

  fields:  { type: [fieldSchema], default: [] },
  buttons: { type: [buttonSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
}, { minimize: false });

panelSchema.index({ guildId: 1, panelKey: 1 }, { unique: true });
panelSchema.index({ guildId: 1 });

module.exports = mongoose.model('EmbedPanel', panelSchema);
