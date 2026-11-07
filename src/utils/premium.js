// utils/premium.js — Vérification centralisée du statut Premium
// Système 100% gratuit, activable uniquement par le(s) propriétaire(s) du bot
// via /premium-admin. Aucun paiement, aucune interférence avec les features de base.
const Premium = require('../models/Premium');

// Cache léger en mémoire pour éviter une requête DB à chaque vérification (60s TTL)
const { createBoundedCache } = require('./boundedCache');
// BORNÉ : une entrée par serveur.
const cache = createBoundedCache({ max: 20_000, ttl: 0, name: 'premium' });
const CACHE_TTL = 60_000;

async function isPremium(guildId) {
  const cached = cache.get(guildId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL) {
    return cached.active;
  }

  const doc = await Premium.findOne({ guildId }).lean();
  let active = false;

  if (doc?.active) {
    // Expiration éventuelle
    if (doc.expiresAt && new Date(doc.expiresAt) < new Date()) {
      active = false;
      // Désactivation auto en base (best-effort, ne bloque pas la réponse)
      Premium.updateOne({ guildId }, { active: false }).catch(() => {});
    } else {
      active = true;
    }
  }

  cache.set(guildId, { active, tier: doc?.tier || 'standard', expiresAt: doc?.expiresAt || null, checkedAt: Date.now() });
  return active;
}

async function getPremiumInfo(guildId) {
  const doc = await Premium.findOne({ guildId }).lean();
  return doc || null;
}

function invalidateCache(guildId) {
  cache.delete(guildId);
}

// Limites différenciées free/premium pour les features existantes (utilisées en option, jamais bloquantes)
const LIMITS = {
  free:    { autoroles: 5,  shopItems: 8,  badges: 5,  events: 5,  todos: 25, ticketCategories: 1, books: 5,  chaptersPerBook: 30 },
  premium: { autoroles: 25, shopItems: 50, badges: 30, events: 30, todos: 200, ticketCategories: 5, books: 30, chaptersPerBook: 150 },
};

async function getLimit(guildId, key) {
  const premium = await isPremium(guildId);
  return LIMITS[premium ? 'premium' : 'free'][key] ?? Infinity;
}

module.exports = { isPremium, getPremiumInfo, invalidateCache, getLimit, LIMITS };
