const mongoose = require('mongoose');
const autoModSchema = new mongoose.Schema({
  guildId:          { type: String,  required: true, unique: true },
  spamEnabled:      { type: Boolean, default: false },
  spamThreshold:    { type: Number,  default: 5 },
  spamWindow:       { type: Number,  default: 5000 },
  spamAction:       { type: String,  enum: ['delete','mute','kick','ban'], default: 'delete' },
  spamMuteDuration: { type: Number,  default: 10 },
  raidEnabled:      { type: Boolean, default: false },
  raidThreshold:    { type: Number,  default: 10 },
  raidWindow:       { type: Number,  default: 10000 },
  raidAction:       { type: String,  enum: ['kick','ban','lockdown'], default: 'kick' },
  linksEnabled:     { type: Boolean, default: false },
  linksWhitelist:   { type: [String], default: [] },
  linksAction:      { type: String,  enum: ['delete','warn','mute'], default: 'delete' },
  capsEnabled:      { type: Boolean, default: false },
  capsThreshold:    { type: Number,  default: 70 },
  capsMinLength:    { type: Number,  default: 10 },

  // ── Anti-spam v2 : doublons et mentions de masse (membres) ────────────────
  // Un flood « 5 messages identiques » n'était pas distingué d'une simple
  // conversation rapide ; ces deux détecteurs comblent le trou.
  duplicateEnabled:   { type: Boolean, default: true },
  duplicateThreshold: { type: Number,  default: 3 },      // même contenu répété N fois…
  duplicateWindow:    { type: Number,  default: 15000 },  // …dans cette fenêtre (ms)
  mentionEnabled:     { type: Boolean, default: true },
  mentionLimit:       { type: Number,  default: 6 },      // mentions @user/@role/@everyone par message
  spamEscalate:       { type: Boolean, default: true },   // mute de plus en plus long à chaque récidive

  // ── Anti-spam Webhooks ────────────────────────────────────────────────────
  // Un webhook est un « bot » : il contournait entièrement l'auto-modération.
  // Le garde-fou est actif par défaut, avec des seuils volontairement larges
  // (un flux légitime — annonces, GitHub, bump — ne poste pas 12 messages en
  // 5 secondes ni 4 fois le même contenu).
  webhookGuardEnabled:     { type: Boolean, default: true },
  webhookThreshold:        { type: Number,  default: 12 },      // messages…
  webhookWindow:           { type: Number,  default: 5000 },    // …dans cette fenêtre (ms)
  webhookDuplicateLimit:   { type: Number,  default: 4 },       // même contenu répété N fois
  webhookMentionLimit:     { type: Number,  default: 8 },       // mentions par message
  webhookAction:           { type: String,  enum: ['delete', 'disable', 'quarantine'], default: 'delete' },
  webhookScope:            { type: String,  enum: ['channel', 'guild'], default: 'channel' },
  webhookAllowlist:        { type: [String], default: [] },     // IDs de webhooks de confiance

  // ── Anti-spam de COMMANDES (v3) ───────────────────────────────────────────
  // Deux vecteurs que l'anti-spam de messages ne voyait pas :
  //   • les commandes slash lancées en rafale (aucun message à compter) ;
  //   • les commandes d'AUTRES bots (`!play`, `?rank`…), postées par un membre
  //     mais exécutées ailleurs : notre bot ne voit qu'un message de texte.
  // Les deux garde-fous dépendent de `spamEnabled` : l'interrupteur maître de
  // l'anti-spam reste unique, ces deux-là ne font que le préciser.
  commandSpamEnabled:   { type: Boolean, default: true },
  commandSpamThreshold: { type: Number,  default: 6 },       // commandes…
  commandSpamWindow:    { type: Number,  default: 10000 },   // …dans cette fenêtre (ms)
  externalCmdEnabled:   { type: Boolean, default: true },
  externalCmdThreshold: { type: Number,  default: 5 },
  externalCmdWindow:    { type: Number,  default: 15000 },
  logChannelId:     { type: String,  default: null },
  exemptRoles:      { type: [String], default: [] },
  exemptChannels:   { type: [String], default: [] },

  // ── Raid mode automatique configurable (additif) ──────────────────────────
  raidAutoTrigger:    { type: Boolean, default: false }, // déclenche /raidmode automatiquement si seuil atteint
  raidMinAccountAge:  { type: Number,  default: 0 },      // âge minimum du compte en jours (0 = désactivé) — comptes plus jeunes = action
  raidAutoAction:     { type: String,  enum: ['lock', 'kick_new', 'verify'], default: 'lock' }, // lock = verrouille invites, kick_new = kick comptes trop jeunes, verify = exige vérification
  raidAutoDisableMin: { type: Number,  default: 0 },      // auto-désactivation après N minutes (0 = désactivé)
  raidModeActive:     { type: Boolean, default: false },  // état courant du raid mode auto (séparé du toggle manuel /raidmode)
  raidModeActivatedAt:{ type: Date,    default: null },
});
module.exports = mongoose.model('AutoMod', autoModSchema);
