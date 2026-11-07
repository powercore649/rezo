const mongoose = require('mongoose');

// Une "zone" de la carte, capturable par un serveur via bump
const territorySchema = new mongoose.Schema({
  zoneId:      { type: String, required: true, unique: true }, // ex: 'A1', 'B3'
  name:        { type: String, required: true },               // ex: 'Forêt Boréale'
  ownerGuildId:{ type: String, default: null },
  ownerName:   { type: String, default: null },
  power:       { type: Number, default: 0 },   // points de défense accumulés (décroît avec le temps)
  capturedAt:  { type: Date,   default: null },
  tier:        { type: Number, default: 1 },   // 1=commun, 2=rare, 3=légendaire (bonus coins)
});

module.exports = mongoose.model('Territory', territorySchema);
