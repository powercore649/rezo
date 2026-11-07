'use strict';
// models/MpRequestConfig.js — Salon "Demande de MP" : tout message posté y est
// remplacé par un embed + un fil de discussion, configurable via /demande-mp panel.
const mongoose = require('mongoose');

const mpRequestConfigSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, unique: true },
  enabled:   { type: Boolean, default: false },
  channelId: { type: String, default: null },

  embedColor:      { type: String, default: '8B1A1A' }, // hex sans #
  threadNameTemplate: { type: String, default: '💬 Demande de {username}' },
  autoArchiveMinutes: { type: Number, default: 1440 }, // 1 jour

  totalRequests: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('MpRequestConfig', mpRequestConfigSchema);
