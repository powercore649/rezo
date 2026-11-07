'use strict';
// utils/aiEmbeddings.js — Mémoire vectorielle de l'IA.
//
// La mémoire « résumé » (aiMemory) retient l'essentiel d'une personne ; celle-ci
// retrouve les messages PRÉCIS qui ressemblent à la question du moment. Sans
// embeddings configurés, tout est désactivé silencieusement : le chat continue
// de fonctionner avec la mémoire classique.
//
// Variables d'environnement (toutes optionnelles) :
//   AI_EMBED_BASE_URL  endpoint compatible OpenAI (ex. http://127.0.0.1:11434/v1)
//   AI_EMBED_API_KEY   clé éventuelle
//   AI_EMBED_MODEL     défaut : text-embedding-3-small
//
// Aucune écriture ne doit casser une réponse : chaque appel est best-effort.

const MAX_FACTS = 200;
const MIN_SCORE = 0.25;

function config(env = process.env) {
  return {
    base: String(env.AI_EMBED_BASE_URL || '').replace(/\/$/, ''),
    key: env.AI_EMBED_API_KEY || env.OPENAI_API_KEY || null,
    model: env.AI_EMBED_MODEL || 'text-embedding-3-small',
  };
}

function isEnabled(env = process.env) {
  return Boolean(config(env).base);
}

async function embed(text, { fetchImpl = fetch, env = process.env, timeoutMs = 12_000 } = {}) {
  const cfg = config(env);
  if (!cfg.base) return null;
  const input = String(text || '').slice(0, 2000);
  if (!input.trim()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${cfg.base}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const vec = json?.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length ? vec : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Enregistre un message en tâche de fond et borne l'historique du membre. */
async function remember({ guildId, userId, text, env = process.env, fetchImpl = fetch } = {}) {
  if (!guildId || !userId || !isEnabled(env)) return false;
  try {
    const vec = await embed(text, { env, fetchImpl });
    if (!vec) return false;
    const AiFact = require('../models/AiFact');
    await AiFact.create({ guildId, userId, text: String(text).slice(0, 1000), vec });

    const total = await AiFact.countDocuments({ guildId, userId });
    if (total > MAX_FACTS) {
      const old = await AiFact.find({ guildId, userId }).sort({ createdAt: 1 }).limit(total - MAX_FACTS).select('_id').lean();
      if (old.length) await AiFact.deleteMany({ _id: { $in: old.map(o => o._id) } });
    }
    return true;
  } catch { return false; }
}

/** Les N messages passés les plus proches de la question (vide si désactivé). */
async function recall({ guildId, userId, query, limit = 4, env = process.env, fetchImpl = fetch } = {}) {
  if (!guildId || !userId || !isEnabled(env)) return [];
  try {
    const AiFact = require('../models/AiFact');
    const rows = await AiFact.find({ guildId, userId }).sort({ createdAt: -1 }).limit(MAX_FACTS).lean();
    if (!rows.length) return [];

    const vec = await embed(query, { env, fetchImpl });
    if (!vec) return [];

    return rows
      .map(row => ({ text: row.text, score: cosine(vec, row.vec) }))
      .filter(r => r.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.text);
  } catch { return []; }
}

async function forget({ guildId, userId } = {}) {
  try {
    const AiFact = require('../models/AiFact');
    await AiFact.deleteMany({ guildId, userId });
  } catch { /* jamais bloquant */ }
}

module.exports = { MAX_FACTS, MIN_SCORE, config, isEnabled, embed, cosine, remember, recall, forget };
