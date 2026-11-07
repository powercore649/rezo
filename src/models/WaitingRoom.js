const mongoose = require('mongoose');

// ── Salon vocal d'attente ────────────────────────────────────────────────────
// Un membre qui rejoint le salon vocal configuré entre dans une file d'attente :
// il reçoit (optionnellement) un rôle d'attente, la file est publiée dans un
// salon texte, le staff est notifié, et le staff peut appeler le suivant.
// La file est persistée : elle survit à un redémarrage du bot (voir
// utils/waitingRoom.js → reconcile()).
const waitingRoomSchema = new mongoose.Schema({
  guildId:         { type: String, required: true, unique: true },

  enabled:         { type: Boolean, default: true },

  // ── Salons ────────────────────────────────────────────────────────────
  voiceChannelId:  { type: String, default: null }, // salon vocal d'attente surveillé
  targetChannelId: { type: String, default: null }, // salon vocal de destination (déplacement à l'appel)
  logChannelId:    { type: String, default: null }, // salon texte : file d'attente + notifications

  // ── Salon vocal temporaire (un par membre en attente) ─────────────────
  createTempChannel: { type: Boolean, default: true },   // déplacer l'entrant dans un salon temporaire
  tempCategoryId:    { type: String,  default: null },   // catégorie d'accueil (défaut : celle du salon d'attente)
  tempChannelName:   { type: String,  default: '⏳・{user}' }, // variable : {user}
  muteWaiting:       { type: Boolean, default: true },   // mute + sourdine serveur pendant l'attente
  tempChannelIds:    { type: [String], default: [] },    // registre des salons temporaires créés (nettoyage)

  // ── Rôles ─────────────────────────────────────────────────────────────
  staffRoleId:     { type: String, default: null }, // rôle notifié à chaque arrivée
  waitingRoleId:   { type: String, default: null }, // rôle porté pendant l'attente

  // ── Comportement ──────────────────────────────────────────────────────
  notifyStaff:     { type: Boolean, default: true },
  giveRole:        { type: Boolean, default: true },
  autoCallNext:    { type: Boolean, default: false }, // appel automatique du suivant quand une place se libère
  maxQueue:        { type: Number,  default: 0 },     // 0 = illimité (capacité affichée / alerte staff)

  notifyMessage:   { type: String, default: '🎧 {user} vient d\'entrer en attente (position **{position}**). Un membre du staff est disponible ?' },

  // ── État ──────────────────────────────────────────────────────────────
  queueMessageId:  { type: String, default: null },
  queue: {
    type: [new mongoose.Schema({
      userId:        { type: String, required: true },
      joinedAt:      { type: Date, default: Date.now },
      calledAt:      { type: Date, default: null },
      tempChannelId: { type: String, default: null }, // salon temporaire attribué à ce membre
    }, { _id: false })],
    default: [],
  },

  totalServed:     { type: Number, default: 0 },
  lastServedAt:    { type: Date,   default: null },

  createdAt:       { type: Date, default: Date.now },
});

module.exports = mongoose.model('WaitingRoom', waitingRoomSchema);
