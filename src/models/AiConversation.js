'use strict';
// models/AiConversation.js — Historique de conversation IA, par utilisateur et par serveur

const mongoose = require('mongoose');

const aiConversationSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },

  // Historique brut (rôle Gemini: 'user' | 'model')
  messages: [{
    role: { type: String, enum: ['user', 'model'], required: true },
    text: { type: String, required: true },
    ts:   { type: Date, default: Date.now },
  }],

  updatedAt: { type: Date, default: Date.now },
});

aiConversationSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.models.AiConversation || mongoose.model('AiConversation', aiConversationSchema);
