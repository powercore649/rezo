const mongoose = require('mongoose');

const birthdaySchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },
  day:     { type: Number, required: true, min: 1, max: 31 },
  month:   { type: Number, required: true, min: 1, max: 12 }, // 1 = janvier
  year:    { type: Number, default: null }, // optionnel, jamais affiché sans consentement

  // Idempotence : une seule annonce par jour, quelle que soit la fréquence du
  // planificateur (il tourne toutes les heures). Clé locale au fuseau du serveur.
  lastAnnouncedOn: { type: String, default: null }, // 'YYYY-MM-DD'

  // Conservé pour la compatibilité des données existantes : une annonce déjà
  // faite cette année ne sera pas répétée après la mise à jour du bot.
  lastAnnouncedYear: { type: Number, default: null },

  // Rôle temporaire : date (locale) à laquelle il a été donné. Permet de le
  // retirer le lendemain même si le bot était hors ligne, sans dépendre du cache.
  roleGrantedOn: { type: String, default: null },
});

birthdaySchema.index({ guildId: 1, userId: 1 }, { unique: true });
birthdaySchema.index({ guildId: 1, month: 1, day: 1 }); // recherche des anniversaires du jour
birthdaySchema.index({ guildId: 1, roleGrantedOn: 1 }); // retrait du rôle temporaire

module.exports = mongoose.model('Birthday', birthdaySchema);
