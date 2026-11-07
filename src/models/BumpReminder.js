// models/BumpReminder.js — Rappels DM personnels de fin de cooldown, en
// complément du rappel serveur déjà existant (sendBumpReminders dans le
// salon de bump). Persistant en base : survit à un redémarrage du bot,
// contrairement à un simple setTimeout en mémoire.
const mongoose = require('mongoose');

const bumpReminderSchema = new mongoose.Schema({
  userId:  { type: String, required: true },
  guildId: { type: String, required: true },
  dueAt:   { type: Date, required: true },
}, { timestamps: true });

bumpReminderSchema.index({ userId: 1, guildId: 1 }, { unique: true });
bumpReminderSchema.index({ dueAt: 1 });

module.exports = mongoose.model('BumpReminder', bumpReminderSchema);
