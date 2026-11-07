const mongoose = require('mongoose');

// Stats de guerre par serveur dans le système Territoires
const territoryGuildSchema = new mongoose.Schema({
  guildId:       { type: String, required: true, unique: true },
  guildName:     { type: String, default: '' },
  totalCaptures: { type: Number, default: 0 },
  totalLost:     { type: Number, default: 0 },
  warCoins:      { type: Number, default: 0 }, // monnaie spécifique territoires
  rank:          { type: String, default: 'Recrue' }, // titre selon captures
});

module.exports = mongoose.model('TerritoryGuild', territoryGuildSchema);
