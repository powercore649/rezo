'use strict';
// utils/aiService.js — Appelle Gemini via @google/genai, avec bascule automatique de
// modèle en cas de quota dépassé, et suivi persistant de l'état de chaque modèle
// (partagé par tout le bot, car une seule clé API = un seul quota).

const AiModelStatus = require('../models/AiModelStatus');
const { isQuotaError, computeCooldownUntil, pickAvailableModel } = require('./aiQuotaEngine');
const providers = require('./aiProviders');
const persona = require('./aiPersona');

/** Contenu au format attendu par le SDK Gemini : historique + message courant. */
function toContents(history = [], userMessage) {
  const contents = history.map(h => ({
    role: h.role === 'model' || h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(h.text ?? h.content ?? '') }],
  }));
  contents.push({ role: 'user', parts: [{ text: String(userMessage) }] });
  return contents;
}

/**
 * Dernier recours quand TOUS les modèles Gemini sont à leur quota : la chaîne de
 * fournisseurs gratuits (Groq, Mistral, OpenRouter, Cloudflare, et même OVH qui
 * fonctionne sans aucune clé). Sans ça, le salon IA se verrouillait pour rien
 * alors que d'autres services gratuits étaient disponibles.
 */
// `systemPrompt` transporte l'identité REZO et la mémoire du membre : le repli
// gratuit doit répondre avec la même personnalité que le chemin principal.
async function tryFreeProviders(prompt, { systemPrompt = null, history = [] } = {}) {
  const chain = providers.resolveChain(process.env, {});
  if (!chain.length) return null;
  const outcome = await providers.askWithFallback(
    { systemPrompt, history, userMessage: prompt, temperature: 0.9 },
    { chain },
  );
  if (!outcome.ok) return null;
  return { ok: true, text: persona.scrubIdentity(outcome.text), modelUsed: `${outcome.providerId}:${outcome.model}` };
}

let genAIClient = null;
function getClient() {
  if (genAIClient) return genAIClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY manquant dans .env');
  const { GoogleGenAI } = require('@google/genai');
  genAIClient = new GoogleGenAI({ apiKey });
  return genAIClient;
}

async function getStatusMap(modelChain) {
  // Une base momentanément indisponible ne doit pas empêcher de répondre : sans
  // état des modèles, on repart simplement du premier de la chaîne.
  try {
    const rows = await AiModelStatus.find({ modelName: { $in: modelChain } }).lean();
    const map = {};
    for (const r of rows) map[r.modelName] = r;
    return map;
  } catch {
    return {};
  }
}

// Suivi d'état best-effort : ces écritures ne doivent jamais casser une réponse
// déjà obtenue ni empêcher le passage au modèle suivant.
async function markModelCooldown(modelName, errMessage) {
  const until = computeCooldownUntil();
  try {
    await AiModelStatus.findOneAndUpdate(
      { modelName },
      { unavailableUntil: until, lastError: String(errMessage).slice(0, 300), lastCheckedAt: new Date() },
      { upsert: true },
    );
  } catch { /* suivi indisponible : on continue */ }
  return until;
}

async function markModelHealthy(modelName) {
  try {
    await AiModelStatus.findOneAndUpdate(
      { modelName },
      { unavailableUntil: null, lastCheckedAt: new Date() },
      { upsert: true },
    );
  } catch { /* suivi indisponible : on continue */ }
}

/**
 * Envoie un prompt à l'IA en essayant chaque modèle de la chaîne dans l'ordre,
 * en sautant automatiquement ceux actuellement en cooldown de quota.
 *
 * @param {string} prompt
 * @param {string[]} modelChain
 * @returns {Promise<{ ok: true, text: string, modelUsed: string } | { ok: false, allExhausted: true, soonestAvailable?: string, soonestAt?: Date } | { ok: false, allExhausted: false, error: string }>}
 */
async function askAI(prompt, modelChain, { systemPrompt = null, history = [] } = {}) {
  const statusMap = await getStatusMap(modelChain);
  const now = new Date();

  // Ordre d'essai : on part du modèle "préféré" disponible, puis on tente les suivants
  // de la chaîne en cas d'échec en cours de route (ex: quota atteint pile à cet instant).
  const { model: startModel, allExhausted, soonestAvailable, soonestAt } = pickAvailableModel(modelChain, statusMap, now);
  if (allExhausted) {
    const rescued = await tryFreeProviders(prompt, { systemPrompt, history });
    if (rescued) return rescued;
    return { ok: false, allExhausted: true, soonestAvailable, soonestAt };
  }

  const startIndex = modelChain.indexOf(startModel);
  const tryOrder = [...modelChain.slice(startIndex), ...modelChain.slice(0, startIndex)];

  let lastError = null;
  for (const model of tryOrder) {
    // Un modèle déjà marqué en cooldown (autre que le premier choisi) est sauté sans appel réseau
    const status = statusMap[model];
    if (status?.unavailableUntil && new Date(status.unavailableUntil) > now && model !== startModel) continue;

    try {
      const client = getClient();
      const response = await client.models.generateContent({
        model,
        contents: history.length ? toContents(history, prompt) : prompt,
        config: systemPrompt ? { systemInstruction: systemPrompt } : undefined,
      });
      const text = response?.text ?? response?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
      if (!text) throw new Error('Réponse vide reçue du modèle.');

      await markModelHealthy(model);
      // Toujours renvoyer du REZO au membre, jamais un nom de modèle.
      return { ok: true, text: persona.scrubIdentity(text), modelUsed: model };
    } catch (err) {
      lastError = err;
      if (isQuotaError(err)) {
        await markModelCooldown(model, err.message);
        continue; // essaie le modèle suivant de la chaîne
      }
      // Erreur non liée au quota (clé absente/invalide, réseau, contenu
      // bloqué...) : avant d'échouer, on tente les autres fournisseurs gratuits.
      // Sans ça, une installation sans clé Gemini ne répondait jamais dans le
      // salon Playground alors qu'OVHcloud était disponible sans clé.
      const rescued = await tryFreeProviders(prompt, { systemPrompt, history });
      if (rescued) return rescued;
      return { ok: false, allExhausted: false, error: err.message || 'Erreur inconnue.' };
    }
  }

  // Tous les modèles de tryOrder ont fini en quota dépassé pendant cette tentative
  const rescued = await tryFreeProviders(prompt, { systemPrompt, history });
  if (rescued) return rescued;

  const finalMap = await getStatusMap(modelChain);
  const finalPick = pickAvailableModel(modelChain, finalMap, new Date());
  return { ok: false, allExhausted: true, soonestAvailable: finalPick.soonestAvailable, soonestAt: finalPick.soonestAt, error: lastError?.message };
}

module.exports = { askAI, markModelCooldown, markModelHealthy, getStatusMap };
