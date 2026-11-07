'use strict';
// models/PermissionVault.js — Coffre-fort de permissions.
//
// Un document par serveur. Il mémorise l'état d'accès attendu de salons
// sensibles (overwrites) et de rôles sensibles (permissions), pour pouvoir
// refermer tout élargissement silencieux. Le moteur de comparaison est pur
// (utils/permissionVaultEngine.js) et l'orchestration Discord vit dans
// utils/permissionVault.js.

const mongoose = require('mongoose');

const MAX_INCIDENTS = 25;
const MAX_CHANNELS = 25;
const MAX_ROLES = 15;

const overwriteSchema = new mongoose.Schema({
  id:    { type: String, required: true },
  type:  { type: Number, default: 0 }, // 0 = rôle, 1 = membre
  allow: { type: String, default: '0' }, // masque BigInt sérialisé
  deny:  { type: String, default: '0' },
}, { _id: false, id: false }); // `id` explicite : on désactive le virtual Mongoose homonyme

const protectedChannelSchema = new mongoose.Schema({
  channelId:  { type: String, required: true },
  name:       { type: String, default: null },
  overwrites: { type: [overwriteSchema], default: [] },
  capturedAt: { type: Date, default: Date.now },
}, { _id: false });

const protectedRoleSchema = new mongoose.Schema({
  roleId:      { type: String, required: true },
  name:        { type: String, default: null },
  permissions: { type: String, default: '0' },
  capturedAt:  { type: Date, default: Date.now },
}, { _id: false });

const incidentSchema = new mongoose.Schema({
  at:          { type: Date, default: Date.now },
  kind:        { type: String, enum: ['channel', 'role'], default: 'channel' },
  targetId:    { type: String, default: null },
  targetName:  { type: String, default: null },
  executorId:  { type: String, default: null },
  permissions: { type: [String], default: [] },
  mode:        { type: String, default: 'alert' },
  action:      { type: String, enum: ['reverted', 'alerted', 'trusted', 'failed'], default: 'alerted' },
  source:      { type: String, default: 'audit' },
  detail:      { type: String, default: null },
}, { _id: false });

const permissionVaultSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },

  enabled: { type: Boolean, default: false },
  // alert  : détecte et alerte, laisse l'accès ouvert
  // revert : referme l'accès en réappliquant la référence
  mode:    { type: String, enum: ['alert', 'revert'], default: 'revert' },

  logChannelId: { type: String, default: null },

  protectedChannels: { type: [protectedChannelSchema], default: [] }, // ≤ MAX_CHANNELS
  protectedRoles:    { type: [protectedRoleSchema], default: [] },    // ≤ MAX_ROLES
  trustedRoles:      { type: [String], default: [] },

  stats: {
    reverted:      { type: Number, default: 0 },
    alerts:        { type: Number, default: 0 },
    trusted:       { type: Number, default: 0 },
    lastIncidentAt:{ type: Date, default: null },
  },

  incidents: { type: [incidentSchema], default: [] },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

permissionVaultSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.models.PermissionVault || mongoose.model('PermissionVault', permissionVaultSchema);
module.exports.MAX_INCIDENTS = MAX_INCIDENTS;
module.exports.MAX_CHANNELS = MAX_CHANNELS;
module.exports.MAX_ROLES = MAX_ROLES;
