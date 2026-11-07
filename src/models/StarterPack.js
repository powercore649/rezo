// models/StarterPack.js — État du Starter Pack par serveur.
//
// On mémorise EXACTEMENT ce que le pack a créé (ids Discord) afin que la
// désinstallation ne supprime jamais autre chose que ses propres éléments.
const mongoose = require('mongoose');

const createdItemSchema = new mongoose.Schema({
  key:  { type: String, required: true },
  id:   { type: String, required: true },
  name: { type: String, default: null },
}, { _id: false });

const createdPanelSchema = new mongoose.Schema({
  key:       { type: String, required: true },
  channelId: { type: String, default: null },
  messageId: { type: String, default: null },
  url:       { type: String, default: null },
}, { _id: false });

const starterPackSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // pending = jamais installé, installed = en place, removed = désinstallé
  status:  { type: String, enum: ['pending', 'installed', 'removed'], default: 'pending' },
  version: { type: Number, default: 1 },

  installedAt: { type: Date, default: null },
  installedBy: { type: String, default: null },
  removedAt:   { type: Date, default: null },
  removedBy:   { type: String, default: null },

  created: {
    roles:      { type: [createdItemSchema], default: [] },
    categories: { type: [createdItemSchema], default: [] },
    channels:   { type: [createdItemSchema], default: [] },
    panels:     { type: [createdPanelSchema], default: [] },
  },

  // Résumé borné des dernières opérations (affiché dans /starterpack statut)
  history: { type: [String], default: [] },
}, { timestamps: true });

starterPackSchema.methods.addHistory = function (line) {
  this.history.push(String(line).slice(0, 200));
  if (this.history.length > 25) this.history = this.history.slice(-25);
};

module.exports = mongoose.models.StarterPack || mongoose.model('StarterPack', starterPackSchema);
