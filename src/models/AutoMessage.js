const mongoose = require('mongoose');
// Message auto-épinglé / republié périodiquement (règles, annonces récurrentes)
const autoMessageSchema = new mongoose.Schema({
  guildId:    { type: String, required: true },
  channelId:  { type: String, required: true },
  content:    { type: String, required: true },
  intervalH:  { type: Number, default: 24 }, // toutes les X heures
  nextPost:   { type: Date, required: true },
  lastMessageId: { type: String, default: null },
  active:     { type: Boolean, default: true },
});
autoMessageSchema.index({ active: 1, nextPost: 1 });
module.exports = mongoose.model('AutoMessage', autoMessageSchema);
