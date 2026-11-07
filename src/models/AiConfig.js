'use strict';
// models/AiConfig.js — Configuration UNIQUE du système IA par serveur.
//
// Cette config pilote tout : les salons où le bot répond tout seul, la
// personnalité, les limites, la mémoire, la chaîne de modèles de secours, le
// salon « playground » créé à la demande et l'état du verrou de quota.
// L'ancien modèle AiPlaygroundConfig n'est plus lu qu'une fois, pour migrer.

const mongoose = require('mongoose');

const aiConfigSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  enabled: { type: Boolean, default: false },

  // Salons où chaque message est automatiquement traité comme une conversation
  channelIds: { type: [String], default: [] },

  // Modèle & comportement
  model:          { type: String, default: 'gemini-2.5-flash' }, // gemini-2.5-flash | gemini-2.5-pro | gemini-2.0-flash
  temperature:    { type: Number, default: 0.9, min: 0, max: 2 },
  systemPrompt:   { type: String, default: 'Tu es un assistant Discord amical, utile et concis. Réponds dans la langue du message reçu.' },
  maxHistoryPairs:{ type: Number, default: 10 }, // nb d'échanges (user+model) conservés en mémoire

  // ── Comportement en cas de quota Gemini dépassé ─────────────────────────
  // 'switch_model' : bascule automatiquement sur un modèle de secours
  // 'lock_channel'  : verrouille temporairement le chat le temps que le quota revienne
  quotaFallbackMode:  { type: String, enum: ['switch_model', 'lock_channel'], default: 'switch_model' },
  lockDurationMinutes:{ type: Number, default: 5 },
  locked:              { type: Boolean, default: false },
  lockedUntil:         { type: Date, default: null },
  quotaHits:           { type: Number, default: 0 },

  // Salon "AI Playground" créé à la demande depuis le panel (jamais automatiquement)
  playgroundChannelId: { type: String, default: null },

  // Slowmode appliqué au salon créé par le bot
  slowmodeSeconds: { type: Number, default: 5 },

  // Chaîne de modèles essayés dans l'ordre (bascule automatique en cas de quota)
  modelChain: { type: [String], default: () => ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'] },

  // Raison et date du verrou (quota atteint ou verrouillage manuel d'un admin)
  lockedReason: { type: String, default: null },
  lockedAt:     { type: Date,   default: null },

  // Marque la migration depuis l'ancien AiPlaygroundConfig (faite une seule fois)
  migratedPlayground: { type: Boolean, default: false },

  // Restrictions d'accès
  allowedRoleIds:   { type: [String], default: [] }, // vide = tout le monde peut parler à l'IA
  blockedUserIds:   { type: [String], default: [] },
  dailyLimitPerUser:{ type: Number, default: 30 },     // 0 = illimité

  // Mémoire longue : l'IA retient qui lui parle et ce qu'elle a appris
  // (nom, goûts, projets). Désactivable serveur par serveur ; chaque membre
  // peut effacer la sienne avec /ia memoire action:Oublier.
  memoryEnabled: { type: Boolean, default: true },

  // ── Fonctions avancées (Discord uniquement) ──────────────────────────────
  // Chaque option est active par défaut sauf la modération, qui doit être
  // autorisée explicitement par un admin.
  replyChain:        { type: Boolean, default: true }, // cite le message auquel on répond
  socialContext:     { type: Boolean, default: true }, // lit les derniers messages du salon
  webSearch:         { type: Boolean, default: true }, // recherche web à la demande
  voiceTranscription:{ type: Boolean, default: true }, // vocaux → texte
  voiceReplies:      { type: Boolean, default: true }, // texte → vocal (TTS)
  reactions:         { type: Boolean, default: true }, // réactions emoji demandées par l'IA
  stickers:          { type: Boolean, default: true }, // stickers du serveur
  multiMessage:      { type: Boolean, default: true }, // plusieurs messages successifs
  humanDelay:        { type: Boolean, default: true }, // délais de frappe aléatoires
  spontaneousChance: { type: Number, default: 0, min: 0, max: 100 }, // 0 = jamais d'initiative
  vectorMemory:      { type: Boolean, default: true }, // souvenirs par embeddings
  styleProfile:      { type: String, default: '' }, // style appris du serveur
  moderationTools:   { type: Boolean, default: false }, // actions de modération par l'IA

  // Compteurs globaux (persistants, jamais remis à zéro)
  totalMessages: { type: Number, default: 0 },
  totalTokensIn:  { type: Number, default: 0 },
  totalTokensOut: { type: Number, default: 0 },
  totalErrors:    { type: Number, default: 0 },
  avgResponseMs:  { type: Number, default: 0 },

  // ── Fournisseurs gratuits (repli automatique) ───────────────────────────
  // Dernier fournisseur qui a réellement répondu + répartition des réponses.
  lastProviderId: { type: String, default: null },
  providerUsage:  { type: Object, default: () => ({}) },

  lastUsedAt: { type: Date, default: null },
  createdAt:  { type: Date, default: Date.now },
});

module.exports = mongoose.models.AiConfig || mongoose.model('AiConfig', aiConfigSchema);
