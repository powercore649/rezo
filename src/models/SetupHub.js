'use strict';
// models/SetupHub.js — Salon d'administration et portail d'installation.
//
// Un document par serveur : il retient le salon créé à l'arrivée du bot et le
// message « Start here », pour ne jamais créer de doublon si le bot est
// réinvité, redémarre, ou si l'événement est rejoué.

const mongoose = require('mongoose');

const setupHubSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, unique: true, index: true },
  channelId: { type: String, default: null },
  messageId: { type: String, default: null },

  // Traces d'utilisation : combien de fois le programme d'installation a été
  // ouvert et combien de modules ont été installés depuis ce panneau.
  opens:     { type: Number, default: 0 },
  installs:  { type: Number, default: 0 },
  lastOpenAt:    { type: Date, default: null },
  lastInstallAt: { type: Date, default: null },

  history:   { type: [String], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

setupHubSchema.methods.addHistory = function addHistory(line) {
  this.history.push(String(line).slice(0, 300));
  if (this.history.length > 30) this.history = this.history.slice(-30);
};

module.exports = mongoose.models.SetupHub || mongoose.model('SetupHub', setupHubSchema);
