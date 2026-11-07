'use strict';
// models/TicketPanel.js — Panel de tickets avancé v4
// Structure racine d'un panel : nom, salon, catégories, préférences d'affichage.

const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  // La clé n'a besoin d'être unique qu'à l'intérieur d'un panel (plusieurs
  // panels peuvent avoir une catégorie « general »).
  key:         { type: String, required: true },
  name:        { type: String, required: true },
  emoji:       { type: String, default: '🎫' },
  description: { type: String, default: '' },
  channelPrefix: { type: String, default: 'ticket' },
  defaultPriority: { type: String, default: 'normal', enum: ['low','normal','high','urgent'] },
  targetCategoryId: { type: String, default: null },
  targetChannelId:  { type: String, default: null },
  supportRoleId:    { type: String, default: null },
  autoClaim:        { type: Boolean, default: false },
  limitPerUser:     { type: Number, default: 3 },
  questions: [{
    label:     { type: String },
    style:     { type: String, default: 'short' },
    required:  { type: Boolean, default: true },
    maxLength: { type: Number, default: 1000 },
  }],
  enabled:      { type: Boolean, default: true },
}, { _id: false });

const panelSchema = new mongoose.Schema({
  // Un serveur peut gérer PLUSIEURS panels (t1, t2, …) : l'unicité porte sur
  // le couple (serveur, clé), pas sur chacun pris séparément.
  guildId:      { type: String, required: true },
  panelKey:     { type: String, required: true },
  name:         { type: String, required: true },
  channelId:    { type: String, required: true },
  messageId:    { type: String, default: null },
  embedTitle:   { type: String, default: '' },
  embedDesc:    { type: String, default: '' },
  embedColor:   { type: String, default: '0x3498DB' },
  embedImage:   { type: String, default: '' },
  embedThumbnail: { type: String, default: '' },
  embedAuthor:  { type: String, default: '' },
  embedAuthorIcon: { type: String, default: '' },
  embedFooter:  { type: String, default: '' },
  embedFooterIcon: { type: String, default: '' },
  embedTimestamp: { type: Boolean, default: true },
  panelContent: { type: String, default: '' },
  buttonLabel:  { type: String, default: '🎫 Ouvrir un ticket' },
  buttonEmoji:  { type: String, default: '🎫' },
  welcomeMessage: { type: String, default: '' },
  cooldown:     { type: Number, default: 0 },
  dmUser:       { type: Boolean, default: false },
  dmOnClose:    { type: Boolean, default: false },
  mentionOnOpen:{ type: Boolean, default: false },
  closeCategoryId: { type: String, default: null },
  transcriptChannelId: { type: String, default: null },
  createdAt:    { type: Date, default: Date.now },
  categories:   [categorySchema],
}, { minimize: false });

// ── Index ────────────────────────────────────────────────────────────────────
// (guildId, panelKey) unique : clé de panel unique par serveur. Remplace les
// anciens index globaux `guildId_1` / `panelKey_1` qui empêchaient d'avoir plus
// d'un panel par serveur.
panelSchema.index({ guildId: 1, panelKey: 1 }, { unique: true });
panelSchema.index({ guildId: 1 });

module.exports = mongoose.model('TicketPanel', panelSchema);
