'use strict';
// utils/aiConfig.js — SOURCE UNIQUE de la configuration IA d'un serveur.
//
// Avant ce fichier, deux commandes et deux modèles se partageaient le système :
//   • /ia + AiConfig        → chat, limites, mémoire, compteurs
//   • /ia + AiPlaygroundConfig → salon, chaîne de modèles, verrou
// Résultat : on configurait d'un côté ce qui se comportait de l'autre, le salon
// répondait mais ignorait la limite quotidienne, et la mémoire n'était alimentée
// que sur un des deux chemins.
//
// Désormais : UNE config (AiConfig), UN salon ou une liste de salons, UN chemin
// de réponse. Les serveurs déjà configurés sont migrés automatiquement.
//
// Le cache mémoire (30 s) évite une requête Mongo par message dans les salons
// de discussion : sans lui, chaque message du serveur coûtait une lecture.

const AiConfig = require('../models/AiConfig');

const DEFAULT_MODEL_CHAIN = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const CACHE_TTL_MS = 30_000;

const { createBoundedCache } = require('./boundedCache');
// BORNÉ et EXPIRANT : config IA par serveur, lue à chaque message.
const cache = createBoundedCache({ max: 20_000, ttl: 0, name: 'ai-config' });

/**
 * Lecture seule : ne crée rien. Utilisé sur le chemin d'un message, où créer une
 * ligne de configuration dans chaque serveur du bot serait absurde.
 */
async function findAiConfig(guildId, { force = false, now = Date.now() } = {}) {
  if (!guildId) return null;

  const hit = cache.get(guildId);
  if (!force && hit && now - hit.at < CACHE_TTL_MS) return hit.cfg;

  let cfg = await AiConfig.findOne({ guildId });
  if (cfg) cfg = await absorbLegacyPlayground(cfg);

  cache.set(guildId, { cfg: cfg || null, at: now });
  return cfg || null;
}

/**
 * Config du serveur, créée si besoin (commandes et panneaux uniquement),
 * migrée depuis l'ancien modèle la première fois, puis mise en cache 30 s.
 */
async function getAiConfig(guildId, { force = false, now = Date.now() } = {}) {
  if (!guildId) return null;

  const existing = await findAiConfig(guildId, { force, now });
  if (existing) return existing;

  let cfg = await AiConfig.create({ guildId });
  cfg = await absorbLegacyPlayground(cfg);
  cache.set(guildId, { cfg, at: now });
  return cfg;
}

/**
 * Migration : absorbe l'ancienne config « AI Playground » dans la config unique.
 * Un serveur qui avait déjà un salon continue de fonctionner sans rien refaire.
 */
async function absorbLegacyPlayground(cfg) {
  if (cfg.migratedPlayground) return cfg;

  try {
    const AiPlaygroundConfig = require('../models/AiPlaygroundConfig');
    const legacy = await AiPlaygroundConfig.findOne({ guildId: cfg.guildId });

    if (legacy) {
      if (legacy.channelId) {
        cfg.playgroundChannelId = cfg.playgroundChannelId || legacy.channelId;
        if (!cfg.channelIds.includes(legacy.channelId)) cfg.channelIds.push(legacy.channelId);
        // Le salon répondait déjà : on garde exactement ce comportement.
        cfg.enabled = true;
      }
      if (Array.isArray(legacy.modelChain) && legacy.modelChain.length) cfg.modelChain = legacy.modelChain;
      if (Number.isFinite(legacy.slowmodeSeconds)) cfg.slowmodeSeconds = legacy.slowmodeSeconds;
      if (legacy.locked) {
        cfg.locked = true;
        cfg.lockedReason = legacy.lockedReason || 'Verrouillage repris de l’ancienne configuration';
        cfg.lockedAt = legacy.lockedAt || new Date();
      }
    }
  } catch (err) {
    console.error('⚠️  [ai-config] migration de l’ancien AI Playground ignorée :', err.message);
  }

  cfg.migratedPlayground = true;
  try { await cfg.save(); } catch { /* la config reste utilisable en mémoire */ }
  return cfg;
}

/** Enregistre un changement et rafraîchit le cache immédiatement. */
async function saveAiConfig(cfg, patch = null) {
  if (patch) Object.assign(cfg, patch);
  await cfg.save();
  cache.set(cfg.guildId, { cfg, at: Date.now() });
  return cfg;
}

function invalidate(guildId) {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

/** Chaîne de modèles utilisée si le serveur n'en a pas défini. */
function defaultModelChain() {
  return [...DEFAULT_MODEL_CHAIN];
}

module.exports = {
  DEFAULT_MODEL_CHAIN,
  CACHE_TTL_MS,
  findAiConfig,
  getAiConfig,
  saveAiConfig,
  invalidate,
  defaultModelChain,
};
