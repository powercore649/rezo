'use strict';
// models/CountingGame.js — Configuration & état du Counting Game par serveur

const mongoose = require('mongoose');

const countingGameSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, unique: true },
  channelId: { type: String, default: null },
  enabled:   { type: Boolean, default: false },

  // ── État de la partie en cours ──────────────────────────────────────────
  currentCount: { type: Number, default: 0 },
  highestCount: { type: Number, default: 0 },
  lastUserId:   { type: String, default: null },
  lastMessageId:{ type: String, default: null },

  // ── Règles ───────────────────────────────────────────────────────────────
  allowSameUserTwice:  { type: Boolean, default: false }, // compter 2x d'affilée
  resetOnFail:         { type: Boolean, default: true },
  deleteWrongMessages: { type: Boolean, default: true },

  // ── Cadeaux / récompenses ───────────────────────────────────────────────
  // rewardMode: 'secret' (nombre mystère caché) | 'milestone' (paliers fixes) | 'both' | 'none'
  rewardMode:     { type: String, default: 'secret' },
  milestoneEvery: { type: Number, default: 100 },
  secretMin:      { type: Number, default: 10 },
  secretMax:      { type: Number, default: 100 },
  secretTarget:   { type: Number, default: null }, // jamais révélé aux membres
  rewardRoleId:   { type: String, default: null },
  rewardMessage:  { type: String, default: null }, // Placeholders: {user} {number}
  totalWins:      { type: Number, default: 0 },

  // ── Stats globales ───────────────────────────────────────────────────────
  totalFails: { type: Number, default: 0 },
  bestStreak: { type: Number, default: 0 }, // = highestCount atteint avant un fail

  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.CountingGame || mongoose.model('CountingGame', countingGameSchema);
