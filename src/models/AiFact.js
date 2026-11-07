'use strict';
// models/AiFact.js — Mémoire vectorielle : un message passé + son embedding.
//
// Volontairement séparé d'AiMemory : le résumé tient en un champ, tandis qu'ici
// chaque message est une ligne, bornée par utilisateur (utils/aiEmbeddings).
// L'index composé sert la lecture des N derniers messages d'une personne.

const mongoose = require('mongoose');

const aiFactSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },
  text:    { type: String, required: true, maxLength: 1000 },
  vec:     { type: [Number], default: [] },
  createdAt: { type: Date, default: Date.now },
});

aiFactSchema.index({ guildId: 1, userId: 1, createdAt: -1 });

module.exports = mongoose.models.AiFact || mongoose.model('AiFact', aiFactSchema);
