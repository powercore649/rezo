'use strict';
// models/AiModelStatus.js — État global (partagé entre tous les serveurs) de chaque
// modèle IA : un même token/quota Gemini est utilisé par tout le bot, donc l'état
// "en quota limité" doit être global et non par serveur.
const mongoose = require('mongoose');

const aiModelStatusSchema = new mongoose.Schema({
  modelName:       { type: String, required: true, unique: true },
  unavailableUntil: { type: Date, default: null }, // null = disponible
  lastError:       { type: String, default: null },
  lastCheckedAt:   { type: Date, default: null },
});

module.exports = mongoose.model('AiModelStatus', aiModelStatusSchema);
