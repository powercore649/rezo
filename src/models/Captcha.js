const mongoose = require('mongoose');

const captchaConfigSchema = new mongoose.Schema({
  guildId:         { type: String, required: true, unique: true },
  enabled:         { type: Boolean, default: false },
  channelId:       { type: String, default: null },
  logChannelId:    { type: String, default: null },   // salon de logs configurable
  roleBefore:      { type: String, default: null }, // rôle avant captcha (non-vérifié)
  roleAfter:       { type: String, default: null }, // rôle après captcha (vérifié)
  bypassRoleId:    { type: String, default: null },   // rôle qui saute le captcha entièrement
  security:        { type: String, enum: ['letters', 'numbers', 'mixed', 'math'], default: 'mixed' },
  codeLength:      { type: Number, default: 6 },
  attempts:        { type: Number, default: 3 },    // tentatives avant kick
  kickOnFail:      { type: Boolean, default: true },
  timeout:         { type: Number, default: 10 },   // minutes avant timeout
  imageMode:       { type: Boolean, default: true },  // true = image distordue (recommandé), false = texte brut (repli si canvas indispo)
  caseSensitive:   { type: Boolean, default: false },  // exiger la casse exacte
  maxRegenerations:{ type: Number, default: 2 },       // nombre de fois où un membre peut demander une nouvelle image
  minAccountAgeDays:{ type: Number, default: 0 },      // 0 = désactivé — âge minimum du compte Discord pour accéder au captcha
  dmOnKick:        { type: Boolean, default: false },  // notifier le membre en DM avant expulsion (best-effort)

  // ── Anti-OCR & intégration anti-raid (v2) ──
  imageDistortionLevel: { type: String, enum: ['normal', 'hard', 'extreme'], default: 'normal' }, // force du brouillage de l'image
  activeOnRaid:    { type: Boolean, default: true },   // s'active automatiquement quand l'anti-raid détecte une attaque
  raidAutoActive:  { type: Boolean, default: false },  // marqué quand le captcha a été activé automatiquement par l'anti-raid

  // ── Rapport des vérifications douteuses ──
  // Résolue trop vite, après plusieurs échecs ou plusieurs régénérations :
  // le staff peut expulser le membre d'un clic (voir utils/captchaReview.js).
  reportDoubtful:  { type: Boolean, default: true },
  reviewChannelId: { type: String, default: null },   // repli : logChannelId
});

const captchaPendingSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  guildId:    { type: String, required: true },
  code:       { type: String, required: true },
  attempts:   { type: Number, default: 0 },
  regenerations: { type: Number, default: 0 },
  expiresAt:  { type: Date,   required: true },
  messageId:  { type: String, default: null },
  channelId:  { type: String, default: null },
  // Essai lancé par le staff depuis le panneau : la correction est réelle,
  // mais RIEN n'est appliqué (aucun rôle, aucune expulsion).
  test:       { type: Boolean, default: false },
}, { timestamps: true });

captchaPendingSchema.index({ userId: 1, guildId: 1 }, { unique: true });
// Pas d'index TTL sur `expiresAt` : la suppression est pilotée par l'application
// (cron crons/captchaExpiry.js) afin de pouvoir journaliser le timeout et expulser
// le membre de façon fiable — un TTL supprimerait le document avant que le balayage
// ne puisse le traiter.

const captchaLogSchema = new mongoose.Schema({
  guildId:  { type: String, required: true },
  userId:   { type: String, required: true },
  action:   { type: String, required: true }, // sent, success, fail, regenerated, timeout, kicked, bypassed, blocked_age
  detail:   { type: String, default: '' },
  date:     { type: Date, default: Date.now },
});
captchaLogSchema.index({ guildId: 1, date: -1 });

module.exports = {
  CaptchaConfig:  mongoose.model('CaptchaConfig',  captchaConfigSchema),
  CaptchaPending: mongoose.model('CaptchaPending', captchaPendingSchema),
  CaptchaLog:     mongoose.model('CaptchaLog', captchaLogSchema),
};
