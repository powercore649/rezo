'use strict';
// utils/aiMemory.js — Mémoire longue de l'IA : qui est la personne, ce qu'on
// s'est dit, et ce qu'il faut en retenir.
//
// Trois principes, tirés du terrain (« sa mémoire a tendance à faire défaut ») :
//
//   1. ÉCRITURES ATOMIQUES. La version précédente lisait le document, le
//      modifiait puis le sauvegardait : deux messages rapprochés s'écrasaient
//      l'un l'autre, et la mémoire perdait silencieusement des échanges. Tout
//      passe maintenant par des mises à jour Mongo ciblées ($inc / $set).
//   2. RÉSUMÉ RÉGULIER. Avant, le résumé n'était écrit que lorsqu'un historique
//      de 40 messages était tronqué — autant dire jamais en usage normal. Il est
//      désormais rafraîchi tous les N échanges (voir MIN_EXCHANGES).
//   3. ÉCHECS VISIBLES. Une base indisponible ne casse jamais une réponse, mais
//      elle n'est plus totalement muette : chaque panne d'écriture laisse une
//      trace dans la console (au plus une par 5 minutes).

const providers = require('./aiProviders');
const persona = require('./aiPersona');

const MIN_EXCHANGES = 6;               // un résumé tous les 6 messages de la personne
const MIN_INTERVAL_MS = 5 * 60_000;    // …et au maximum un toutes les 5 minutes
const MAX_SUMMARY = 1200;
const MATERIAL_MAX = 30;               // messages envoyés au résumeur
const FAILURE_LOG_INTERVAL_MS = 5 * 60_000;

const lastFailureLog = new Map(); // type -> timestamp

function isEnabled(env = process.env) {
  return String(env.AI_MEMORY || '').trim().toLowerCase() !== 'off';
}

/** Trace une panne sans inonder les logs ni casser l'appelant. */
function noteFailure(kind, err) {
  const now = Date.now();
  const last = lastFailureLog.get(kind) || 0;
  if (now - last < FAILURE_LOG_INTERVAL_MS) return;
  lastFailureLog.set(kind, now);
  console.warn(`⚠️  [ai-memory] ${kind} impossible : ${err?.message || err}`);
}

/** « il y a 3 jours » — lisible par un humain, dans le prompt comme dans l'embed. */
function humanizeSince(date, now = new Date()) {
  if (!date) return 'inconnu';
  const ms = now.getTime() - new Date(date).getTime();
  if (!Number.isFinite(ms)) return 'inconnu';
  if (ms < 0) return 'à l’instant';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} jours`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `il y a ${weeks} semaine${weeks > 1 ? 's' : ''}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `il y a ${months} mois`;
  return `il y a ${Math.floor(days / 365)} an${days >= 730 ? 's' : ''}`;
}

/**
 * Récupère (ou crée) la mémoire d'un membre, en objet simple.
 * Ne lève jamais : sans base, on renvoie null et l'IA répond sans mémoire.
 */
async function getMemory(guildId, userId, displayName = null, { env = process.env, now = new Date() } = {}) {
  if (!isEnabled(env) || !guildId || !userId) return null;

  const update = { $setOnInsert: { guildId, userId, firstSeenAt: now } };
  if (displayName) update.$set = { displayName }; // un $set vide est refusé par Mongo

  try {
    const AiMemory = require('../models/AiMemory');
    const doc = await AiMemory.findOneAndUpdate({ guildId, userId }, update, {
      upsert: true, new: true, lean: true, setDefaultsOnInsert: true,
    });
    return doc || { guildId, userId, displayName, userMessages: 0, answers: 0, imageRequests: 0, summary: '', summaryAt: null, summaryUserCount: 0 };
  } catch (err) {
    noteFailure('lecture', err);
    return null;
  }
}

/**
 * Enregistre un échange (ou une image) en une seule mise à jour atomique.
 * Aucune perte possible entre deux messages simultanés.
 */
async function touchMemory(mem, { displayName = null, kind = 'message', topic = null, now = new Date() } = {}) {
  if (!mem?.guildId || !mem?.userId) return mem;

  const inc = kind === 'image' ? { imageRequests: 1 } : { userMessages: 1, answers: 1 };
  const set = { lastSeenAt: now };
  if (displayName) set.displayName = displayName;
  if (topic) set.lastTopic = String(topic).slice(0, 160);

  // Copie locale mise à jour d'abord : la mémoire doit servir même si l'écriture échoue.
  Object.assign(mem, set);
  for (const [key, value] of Object.entries(inc)) mem[key] = (mem[key] || 0) + value;

  try {
    const AiMemory = require('../models/AiMemory');
    await AiMemory.updateOne({ guildId: mem.guildId, userId: mem.userId }, { $inc: inc, $set: set }, { upsert: true });
  } catch (err) {
    noteFailure('écriture', err);
  }
  return mem;
}

/**
 * Bloc de mémoire injecté dans le prompt système. Renvoie null s'il n'y a rien
 * d'utile — on préfère pas de mémoire à une mémoire creuse.
 */
function buildMemoryBlock(mem, { now = new Date() } = {}) {
  if (!mem || mem.forgotten) return null;

  const lines = [];
  if (mem.displayName) lines.push(`Nom affiché : ${mem.displayName}`);
  if (mem.summary) lines.push(`Ce que tu sais déjà : ${mem.summary}`);
  else if (mem.lastTopic) lines.push(`Dernier sujet abordé : ${mem.lastTopic}`);
  const total = (mem.userMessages || 0) + (mem.answers || 0);
  if (total) lines.push(`Échanges déjà eus ensemble : ${total}`);
  if (mem.firstSeenAt) lines.push(`Premier contact : ${humanizeSince(mem.firstSeenAt, now)}`);
  if (mem.lastSeenAt) lines.push(`Dernière discussion : ${humanizeSince(mem.lastSeenAt, now)}`);
  if (!lines.length) return null;

  lines.push('Sers-toi de ces souvenirs pour personnaliser ta réponse (prénom, continuité, goûts) — sans les réciter ni les commenter. Si on te demande ce que tu sais de la personne, tu peux le dire simplement.');
  return lines.join('\n').slice(0, 1500);
}

/** Nombre d'échanges depuis le dernier résumé. */
function exchangesSinceSummary(mem) {
  if (!mem) return 0;
  return Math.max(0, (mem.userMessages || 0) - (mem.summaryUserCount || 0));
}

/**
 * Réécrit le résumé quand assez de nouveaux échanges se sont accumulés.
 * Best-effort absolu : n'importe quel échec laisse la mémoire précédente intacte.
 */
async function maybeSummarize({
  mem, material = [], chain = null, displayName = null, fetchImpl = fetch,
  now = Date.now(), minExchanges = MIN_EXCHANGES, minIntervalMs = MIN_INTERVAL_MS, env = process.env,
} = {}) {
  if (!mem || !isEnabled(env) || mem.forgotten) return { updated: false, reason: 'disabled' };

  const history = material.filter(m => m && typeof m.text === 'string' && m.text.trim()).slice(-MATERIAL_MAX);
  if (history.length < 4) return { updated: false, reason: 'not-enough' };

  if (exchangesSinceSummary(mem) < minExchanges) return { updated: false, reason: 'not-enough-exchanges' };
  if (mem.summaryAt && now - new Date(mem.summaryAt).getTime() < minIntervalMs) return { updated: false, reason: 'too-soon' };
  if (!Array.isArray(chain) || chain.length === 0) return { updated: false, reason: 'no-provider' };

  const who = displayName || mem.displayName || 'Membre';
  const transcript = history
    .map(m => `${m.role === 'user' ? who : persona.BOT_NAME} : ${m.text}`)
    .join('\n')
    .slice(-4000);

  const userMessage = [
    mem.summary ? `Mémoire actuelle :\n${mem.summary}` : 'Mémoire actuelle : vide.',
    `Échanges récents à mémoriser :\n${transcript}`,
    'Réécris la mémoire de cette personne : uniquement les faits durables et utiles (prénom, goûts, projets, façon de parler, ce qu’elle attend de toi). Pas de résumé de discussion, pas de bavardage. 700 caractères maximum, en français, à la deuxième personne du singulier (« Tu aimes… »). Réponds uniquement par cette mémoire.',
  ].join('\n\n');

  let outcome;
  try {
    outcome = await providers.askWithFallback(
      { systemPrompt: persona.buildSystemPrompt('', {}), history: [], userMessage, temperature: 0.3 },
      { chain, fetchImpl },
    );
  } catch {
    return { updated: false, reason: 'provider-failed' };
  }
  if (!outcome?.ok) return { updated: false, reason: 'provider-failed' };

  const summary = persona.scrubIdentity(outcome.text || '').slice(0, MAX_SUMMARY).trim();
  if (summary.length < 10) return { updated: false, reason: 'empty' };

  const summaryAt = new Date(now);
  const summaryUserCount = mem.userMessages || 0;
  mem.summary = summary;
  mem.summaryAt = summaryAt;
  mem.summaryUserCount = summaryUserCount;

  try {
    const AiMemory = require('../models/AiMemory');
    const res = await AiMemory.updateOne(
      { guildId: mem.guildId, userId: mem.userId },
      { $set: { summary, summaryAt, summaryUserCount } },
    );
    if (res && res.acknowledged === false) return { updated: false, reason: 'save-failed' };
  } catch (err) {
    noteFailure('résumé', err);
    return { updated: false, reason: 'save-failed' };
  }

  return { updated: true, summary };
}

/** Rend la mémoire lisible pour son propriétaire (/ia memoire). */
function renderMemory(mem, { now = new Date() } = {}) {
  if (!mem) return null;
  const total = (mem.userMessages || 0) + (mem.answers || 0);
  return [
    `**Nom retenu** : ${mem.displayName || '*inconnu*'}`,
    `**Premier contact** : ${humanizeSince(mem.firstSeenAt, now)}`,
    `**Dernière discussion** : ${humanizeSince(mem.lastSeenAt, now)}`,
    `**Échanges** : ${total} message(s) · **réponses** : ${mem.answers || 0} · **images** : ${mem.imageRequests || 0}`,
    `**Résumé mis à jour** : ${mem.summaryAt ? humanizeSince(mem.summaryAt, now) : '*pas encore*'}`,
    '',
    '**Ce que l’IA retient de vous :**',
    mem.summary ? mem.summary : '*Rien pour l’instant — elle apprend au fil des conversations.*',
  ].join('\n');
}

/** Efface complètement la mémoire d'un membre (droit à l'oubli). */
async function clearMemory(guildId, userId) {
  try {
    const AiMemory = require('../models/AiMemory');
    const res = await AiMemory.deleteOne({ guildId, userId });
    return { deleted: (res?.deletedCount ?? 0) > 0 };
  } catch (err) {
    noteFailure('effacement', err);
    return { deleted: false };
  }
}

/**
 * Santé de la mémoire d'un serveur, affichée aux administrateurs : sans ce
 * chiffre, une mémoire qui n'écrit plus resterait invisible.
 */
async function memoryOverview(guildId) {
  try {
    const AiMemory = require('../models/AiMemory');
    const [profiles, summarized, latest] = await Promise.all([
      AiMemory.countDocuments({ guildId }),
      AiMemory.countDocuments({ guildId, summary: { $ne: '' } }),
      AiMemory.findOne({ guildId }).sort({ lastSeenAt: -1 }).lean(),
    ]);
    return { profiles, summarized, latest };
  } catch (err) {
    noteFailure('statistiques', err);
    return null;
  }
}

module.exports = {
  MIN_EXCHANGES,
  MIN_INTERVAL_MS,
  MAX_SUMMARY,
  MATERIAL_MAX,
  isEnabled,
  humanizeSince,
  getMemory,
  touchMemory,
  buildMemoryBlock,
  exchangesSinceSummary,
  maybeSummarize,
  renderMemory,
  clearMemory,
  memoryOverview,
};
