const mongoose = require('mongoose');

// Document unique (key: 'main') — la présence Discord est globale au bot,
// pas par serveur, donc un seul document suffit.
const botStatusSchema = new mongoose.Schema({
  key:             { type: String, default: 'main', unique: true },
  presenceStatus:  { type: String, enum: ['online', 'idle', 'dnd', 'invisible'], default: 'online' },
  activityType:    { type: String, enum: ['Playing', 'Watching', 'Listening', 'Competing', 'Streaming', 'Custom'], default: 'Custom' },
  activityText:    { type: String, default: 'REZO — Bump & communauté' },
  streamUrl:       { type: String, default: null }, // requis uniquement si activityType = Streaming
  updatedBy:       { type: String, default: null },
  updatedAt:       { type: Date, default: Date.now },
});

module.exports = mongoose.model('BotStatus', botStatusSchema);
