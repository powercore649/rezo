'use strict';
// models/MpRequest.js — Suivi d'une demande de MP individuelle (en attente / acceptée / refusée)
const mongoose = require('mongoose');

const mpRequestSchema = new mongoose.Schema({
  guildId:     { type: String, required: true },
  channelId:   { type: String, required: true },
  messageId:   { type: String, default: null },
  requesterId: { type: String, required: true },
  targetId:    { type: String, required: true },
  status:      { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  threadId:    { type: String, default: null },
  createdAt:   { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
});

mpRequestSchema.index({ guildId: 1, status: 1 });

module.exports = mongoose.model('MpRequest', mpRequestSchema);
