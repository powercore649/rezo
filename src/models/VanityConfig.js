'use strict';
// models/VanityConfig.js — Configuration du vanity par statut Discord.
//
// Un document par serveur. Tout est réglable depuis le panneau `/vanity` :
// textes de statut acceptés, rôle attribué, salon d'annonce, embed et conditions
// d'éligibilité. Le moteur (utils/vanityEngine.js) ne lit que ce document.

const mongoose = require('mongoose');

const embedSchema = new mongoose.Schema({
  title:       { type: String, default: '💎 Statut validé — {user} rejoint les vanity !' },
  description: {
    type: String,
    default: 'Merci {mention} ! Ton statut affiche **{status}** : tu reçois {role}.\n\n'
      + '**{count}** membre(s) affichent déjà le statut du serveur.',
  },
  color:       { type: String, default: '#8B1A1A' },   // hex
  // 'user' = avatar du membre, 'guild' = icône du serveur, 'none' = aucune,
  // sinon une URL d'image directe.
  thumbnail:   { type: String, default: 'user' },
  image:       { type: String, default: null },
  author:      { type: String, default: null },
}, { _id: false });

const conditionsSchema = new mongoose.Schema({
  minAccountAgeDays: { type: Number, default: 0, min: 0, max: 3650 },
  minMemberDays:     { type: Number, default: 0, min: 0, max: 3650 },
  requiredRoleId:    { type: String, default: null },  // rôle obligatoire AVANT l'attribution
  forbiddenRoleIds:  { type: [String], default: [] },  // rôles qui excluent du vanity
  ignoreBots:        { type: Boolean, default: true },
}, { _id: false });

const behaviorSchema = new mongoose.Schema({
  removeOnLost:           { type: Boolean, default: true },  // retirer le rôle si le statut disparaît
  graceMinutes:           { type: Number, default: 60, min: 0, max: 10_080 },
  announceOnce:           { type: Boolean, default: true },  // une seule annonce par membre
  reannounceAfterDays:    { type: Number, default: 0, min: 0, max: 365 },
  dmMember:               { type: Boolean, default: false },
  deletePreviousAnnounce: { type: Boolean, default: false },
}, { _id: false });

const statsSchema = new mongoose.Schema({
  totalGrants:    { type: Number, default: 0 },
  totalRevokes:   { type: Number, default: 0 },
  totalAnnounces: { type: Number, default: 0 },
  lastSweepAt:    { type: Date, default: null },
}, { _id: false });

const vanityConfigSchema = new mongoose.Schema({
  guildId:              { type: String, required: true, unique: true },
  enabled:              { type: Boolean, default: false },

  // Variantes acceptées (jusqu'à 10). Comparaison insensible à la casse et aux
  // accents par défaut ; `contains` accepte « … discord.gg/rezo … ».
  requiredStatuses:     { type: [String], default: [] },
  matchMode:            { type: String, enum: ['contains', 'exact'], default: 'contains' },
  caseSensitive:        { type: Boolean, default: false },

  roleId:               { type: String, default: null },
  announceChannelId:    { type: String, default: null },
  logChannelId:         { type: String, default: null },

  embed:      { type: embedSchema, default: () => ({}) },
  conditions: { type: conditionsSchema, default: () => ({}) },
  behavior:   { type: behaviorSchema, default: () => ({}) },
  stats:      { type: statsSchema, default: () => ({}) },
}, { timestamps: true });

module.exports = mongoose.models.VanityConfig
  || mongoose.model('VanityConfig', vanityConfigSchema);
