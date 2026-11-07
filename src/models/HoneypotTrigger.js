const mongoose = require('mongoose');

// Historique détaillé de chaque déclenchement du honeypot (v2).
// Complète le compteur `totalTriggered` de Honeypot.js avec une vraie trace
// exploitable : qui, quand, où, quelle action, aperçu du message.
const honeypotTriggerSchema = new mongoose.Schema({
  guildId:        { type: String, required: true },
  userId:         { type: String, required: true },
  userTag:        { type: String, required: true },
  channelId:      { type: String, required: true },
  action:         { type: String, enum: ['mute', 'kick', 'ban'], required: true },
  contentPreview: { type: String, default: '' },
  triggeredAt:    { type: Date, default: Date.now },
});

honeypotTriggerSchema.index({ guildId: 1, triggeredAt: -1 });

module.exports = mongoose.models.HoneypotTrigger || mongoose.model('HoneypotTrigger', honeypotTriggerSchema);
