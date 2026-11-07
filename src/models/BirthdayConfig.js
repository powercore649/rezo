const mongoose = require('mongoose');

const birthdayConfigSchema = new mongoose.Schema({
  guildId:      { type: String,  required: true, unique: true },
  enabled:      { type: Boolean, default: false },
  channelId:    { type: String,  default: null },
  roleId:       { type: String,  default: null }, // rôle « 🎂 Anniversaire » donné pour la journée
  pingRoleId:   { type: String,  default: null }, // rôle mentionné dans l'annonce
  message:      { type: String,  default: "🎉 Joyeux anniversaire {user} ! Toute l'équipe de {server} te souhaite une excellente journée !" },

  // Heure locale d'annonce (0-23) et fuseau du serveur : sans ça, l'annonce
  // partirait à l'heure de la machine d'hébergement, pas à celle des membres.
  announceHour: { type: Number,  default: 9, min: 0, max: 23 },
  timezone:     { type: String,  default: 'Europe/Paris' },
});

module.exports = mongoose.model('BirthdayConfig', birthdayConfigSchema);
