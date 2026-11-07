// models/AuthProfile.js — Profil d'authentification personnel (PIN, 2FA, Passkeys)
'use strict';

const mongoose = require('mongoose');

const logSchema = new mongoose.Schema({
  action: { type: String, required: true },   // ex: "pin_set", "2fa_enabled", "passkey_added"...
  detail: { type: String, default: '' },
  date:   { type: Date, default: Date.now },
}, { _id: false });

const passkeySchema = new mongoose.Schema({
  id:         { type: String, required: true }, // identifiant court affiché à l'utilisateur
  label:      { type: String, default: 'Passkey' },
  codeHash:   { type: String, required: true }, // hash scrypt du code de secours (jamais stocké en clair)
  salt:       { type: String, required: true },
  createdAt:  { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null },
  used:       { type: Boolean, default: false }, // usage unique, comme un code de secours
}, { _id: false });

const authProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },

  pin: {
    hash:         { type: String, default: null },
    salt:         { type: String, default: null },
    isSet:        { type: Boolean, default: false },
    weak:         { type: Boolean, default: false },
    updatedAt:    { type: Date, default: null },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil:  { type: Date, default: null },
  },

  twoFA: {
    enabled:    { type: Boolean, default: false },
    secretEnc:  { type: String, default: null }, // secret TOTP chiffré (AES-256-GCM)
    enabledAt:  { type: Date, default: null },
    pendingSecretEnc: { type: String, default: null }, // en attente de confirmation
    pendingCreatedAt: { type: Date, default: null },
    // Dernier pas de temps TOTP consommé : empêche de rejouer le même code
    // pendant ses ~30 secondes de validité.
    lastCounter: { type: Number, default: -1 },
  },

  passkeys: { type: [passkeySchema], default: [] },

  logs: { type: [logSchema], default: [] },

  forgot: {
    pending:      { type: Boolean, default: false },
    requestedAt:  { type: Date, default: null },
    unlockAt:     { type: Date, default: null }, // délai de sûreté avant réinitialisation effective
  },
}, { timestamps: true });

module.exports = mongoose.model('AuthProfile', authProfileSchema);
