'use strict';
// models/VPNVerification.js — Une session de vérification anti-VPN.
//
// Le jeton est aléatoire (32 octets) et à usage unique : il identifie la
// vérification dans le lien envoyé au membre. Le document garde le verdict et
// l'empreinte de l'IP (si le serveur a choisi de la conserver), ce qui permet
// au staff de comprendre une sanction et au cron de traiter les expirations
// même après un redémarrage du bot.

const mongoose = require('mongoose');

const vpnVerificationSchema = new mongoose.Schema({
  guildId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  userTag: { type: String, default: null },

  token: { type: String, required: true, unique: true, index: true },
  nonce: { type: String, default: null }, // protège le formulaire (CSRF simple)

  state: {
    type: String,
    enum: ['pending', 'passed', 'blocked', 'expired', 'error'],
    default: 'pending',
    index: true,
  },

  // Empreinte réseau (l'IP brute n'est conservée que si cfg.storeIp = true).
  ip: { type: String, default: null },
  country: { type: String, default: null },
  asn: { type: String, default: null },
  isp: { type: String, default: null },
  riskScore: { type: Number, default: null },
  flags: {
    vpn: { type: Boolean, default: false },
    proxy: { type: Boolean, default: false },
    tor: { type: Boolean, default: false },
    hosting: { type: Boolean, default: false },
  },
  provider: { type: String, default: null },
  reasons: { type: [String], default: [] },

  actionTaken: { type: String, default: null },
  messageId: { type: String, default: null },
  channelId: { type: String, default: null },

  // Verrouillage total : rôles retirés à l'arrivée, à rendre après validation.
  lockApplied: { type: Boolean, default: false },
  lockedRoles: { type: [String], default: [] },
  lockedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  verifiedAt: { type: Date, default: null },
});

vpnVerificationSchema.index({ state: 1, expiresAt: 1 });
// Rétention : une session (validée ou non) disparaît 30 jours après son échéance.
// Le jeton est de toute façon inutilisable dès qu'il n'est plus « pending ».
vpnVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = mongoose.models.VPNVerification
  || mongoose.model('VPNVerification', vpnVerificationSchema);
