'use strict';
// models/BridgeConfig.js — Réglages du pont inter-serveurs, un document par serveur.
//
// Un serveur relie AU PLUS un salon à un canal commun (hub). Tout le reste est
// du filtrage : ce que l'on accepte de laisser sortir, ce que l'on accepte de
// laisser entrer, et à quelle vitesse.
//
// `webhookId` / `webhookToken` sont internes : ils ne sont jamais affichés ni
// modifiables depuis le panel (voir l'entrée `pont` de utils/panelConfig.js).

const mongoose = require('mongoose');
const { HUB_IDS, DEFAULT_HUB } = require('../utils/bridgeHubs');

const bridgeConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true, index: true },

  enabled: { type: Boolean, default: false },

  // Salon relié et canal commun choisi.
  channelId: { type: String, default: null },
  hub: { type: String, enum: HUB_IDS, default: DEFAULT_HUB },

  // Webhook du salon relié : c'est lui qui porte le pseudo et l'avatar de
  // l'auteur d'origine, ce qui rend la discussion lisible.
  webhookId: { type: String, default: null },
  webhookToken: { type: String, default: null },

  // ── Présentation ──────────────────────────────────────────────────────────
  showServerName: { type: Boolean, default: true },
  relayReplies: { type: Boolean, default: true },

  // ── Filtres de sortie ─────────────────────────────────────────────────────
  blockBots: { type: Boolean, default: true },
  blockLinks: { type: Boolean, default: false },
  blockInvites: { type: Boolean, default: true },
  blockAttachments: { type: Boolean, default: false },
  minLength: { type: Number, default: 2, min: 1, max: 200 },
  maxLength: { type: Number, default: 1200, min: 50, max: 1800 },

  // ── Anti-spam (glissant, par membre et par serveur) ───────────────────────
  rateLimit: { type: Number, default: 4, min: 1, max: 20 },
  rateWindowSeconds: { type: Number, default: 15, min: 3, max: 300 },

  // ── Modération ────────────────────────────────────────────────────────────
  // Serveurs dont on ignore les messages, et qui ne reçoivent pas les nôtres.
  // (Les serveurs participants peuvent aussi nous ignorer de leur côté.)
  blockedGuilds: { type: [String], default: [] },

  // ── Statistiques (jamais éditables) ───────────────────────────────────────
  totalRelayed: { type: Number, default: 0 },
  totalReceived: { type: Number, default: 0 },
  lastRelayAt: { type: Date, default: null },

  updatedBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { minimize: false });

// Requête chaude du relais : tous les salons d'un même canal commun.
bridgeConfigSchema.index({ enabled: 1, hub: 1, channelId: 1 });

module.exports = mongoose.models.BridgeConfig
  || mongoose.model('BridgeConfig', bridgeConfigSchema);
