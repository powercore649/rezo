const mongoose = require('mongoose');

// models/GuildStatus.js — Le « statut du bot » vu par UN serveur.
//
// Pourquoi pas le modèle BotStatus ? Parce que Discord n'autorise qu'une seule
// présence par bot : `botstatus` pilote la ligne « Joue à … » du profil, et elle
// est forcément globale. Ce document-ci est l'autre moitié, celle qui peut
// vraiment varier d'un serveur à l'autre :
//
//   • le surnom du bot dans ce serveur (donnée Discord réellement par serveur) ;
//   • l'état que le serveur affiche (opérationnel, maintenance, incident…) ;
//   • l'apparence de la carte de statut et le salon où elle est publiée.
//
// Un document par serveur, créé au premier enregistrement (jamais au chargement
// du module : un serveur qui ne touche à rien ne laisse aucune trace en base).

const guildStatusSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },

  enabled: { type: Boolean, default: true },

  // ── L'état affiché ──────────────────────────────────────────────────────
  // `auto` laisse le bot décider d'après sa santé réelle (ping, passerelle).
  level: {
    type: String,
    enum: ['auto', 'operationnel', 'info', 'degrade', 'maintenance', 'incident'],
    default: 'auto',
  },
  label: { type: String, default: null },      // « Bump ouvert », « Maintenance »…
  statusText: { type: String, default: null }, // phrase libre sous l'état

  // ── Apparence de la carte ───────────────────────────────────────────────
  title: { type: String, default: null },      // sinon « 🛰️ Statut — <serveur> »
  description: { type: String, default: null },// remplace le texte automatique
  color: { type: String, default: null },      // #RRGGBB, sinon couleur du niveau
  image: { type: String, default: null },      // URL d'illustration
  footerText: { type: String, default: null }, // sinon signature REZO

  // ── Identité du bot DANS ce serveur ─────────────────────────────────────
  nickname: { type: String, default: null },   // surnom du bot, propre au serveur

  // ── Publication de la carte ────────────────────────────────────────────
  channelId: { type: String, default: null },  // salon d'annonce (facultatif)
  messageId: { type: String, default: null },  // carte existante à éditer

  // ── Blocs affichés sur la carte ────────────────────────────────────────
  showUptime: { type: Boolean, default: true },
  showPing: { type: Boolean, default: true },
  showMembers: { type: Boolean, default: true },
  showCommands: { type: Boolean, default: true },
  showLicense: { type: Boolean, default: true },

  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('GuildStatus', guildStatusSchema);
