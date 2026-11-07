'use strict';
// models/AiPlaygroundConfig.js — Salon "AI Playground" par serveur
const mongoose = require('mongoose');

const DEFAULT_MODEL_CHAIN = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];

const aiPlaygroundConfigSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, unique: true },
  channelId: { type: String, default: null },

  slowmodeSeconds: { type: Number, default: 5 },
  modelChain:      { type: [String], default: DEFAULT_MODEL_CHAIN },

  locked:       { type: Boolean, default: false },
  lockedReason: { type: String, default: null },
  lockedAt:     { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('AiPlaygroundConfig', aiPlaygroundConfigSchema);
module.exports.DEFAULT_MODEL_CHAIN = DEFAULT_MODEL_CHAIN;
