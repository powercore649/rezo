'use strict';
const mongoose = require('mongoose');

const planetSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },

  name: { type: String, required: true, maxlength: 32 },
  type: { type: String, enum: ['foret', 'desert', 'ocean', 'glace', 'volcan', 'tropical'], required: true },

  level: { type: Number, default: 1 },
  xp:    { type: Number, default: 0 },

  population: { type: Number, default: 5 },
  happiness:  { type: Number, default: 50, min: 0, max: 100 },

  resources: {
    food:     { type: Number, default: 20 },
    energy:   { type: Number, default: 20 },
    minerals: { type: Number, default: 20 },
  },

  buildings: {
    house: { type: Number, default: 0 },
    farm:  { type: Number, default: 0 },
    power: { type: Number, default: 0 },
    mine:  { type: Number, default: 0 },
    lab:   { type: Number, default: 0 },
  },

  lastHarvest: { type: Date, default: null },
  createdAt:   { type: Date, default: Date.now },
});

planetSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Planet', planetSchema);
