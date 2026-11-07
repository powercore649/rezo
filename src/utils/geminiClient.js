'use strict';
// utils/geminiClient.js — Wrapper du SDK officiel Gemini (@google/genai)
// Doc: https://googleapis.github.io/js-genai/

const { GoogleGenAI } = require('@google/genai');

const API_KEY = process.env.GEMINI_API_KEY || null;
let ai = null;

function isConfigured() {
  return !!API_KEY;
}

function getClient() {
  if (!ai && API_KEY) ai = new GoogleGenAI({ apiKey: API_KEY });
  return ai;
}

const AVAILABLE_MODELS = [
  { value: 'gemini-2.5-flash', label: '⚡ Gemini 2.5 Flash — rapide & économique (recommandé)' },
  { value: 'gemini-2.5-pro',   label: '🧠 Gemini 2.5 Pro — plus intelligent, plus lent' },
  { value: 'gemini-2.0-flash', label: '🕰️ Gemini 2.0 Flash — ancienne génération' },
];

// Modèle de secours utilisé automatiquement quand le modèle principal est en
// quota (mode 'switch_model') — chaque modèle a un repli différent pour
// maximiser les chances qu'au moins un des deux réponde.
const FALLBACK_MAP = {
  'gemini-2.5-pro':   'gemini-2.5-flash',
  'gemini-2.5-flash': 'gemini-2.0-flash',
  'gemini-2.0-flash': 'gemini-2.5-flash',
};

function getFallbackModel(model) {
  return FALLBACK_MAP[model] || 'gemini-2.0-flash';
}

// ─── Convertit l'historique stocké en Mongo vers le format attendu par l'API ──
function toContents(history, userMessage) {
  const contents = history.map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
  contents.push({ role: 'user', parts: [{ text: userMessage }] });
  return contents;
}

// ─── Génère une réponse, avec mesure du temps de réponse et des tokens ────────
async function generateReply({ systemPrompt, history = [], userMessage, model = 'gemini-2.5-flash', temperature = 0.9 }) {
  const client = getClient();
  if (!client) throw new Error('GEMINI_API_KEY manquant — le système IA n\'est pas configuré.');

  const startedAt = Date.now();
  let response;
  try {
    response = await client.models.generateContent({
      model,
      contents: toContents(history, userMessage),
      config: {
        systemInstruction: systemPrompt,
        temperature,
        maxOutputTokens: 800,
      },
    });
  } catch (err) {
    // Messages d'erreur lisibles pour les cas les plus courants
    const msg = err?.message || String(err);
    if (msg.includes('API key not valid') || msg.includes('API_KEY_INVALID')) {
      throw new Error('Clé Gemini invalide — vérifie GEMINI_API_KEY dans le .env.');
    }
    if (msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('resource_exhausted')) {
      const quotaErr = new Error(`Quota Gemini atteint pour le modèle ${model}.`);
      quotaErr.isQuotaError = true; // permet à aiChat.js de distinguer ce cas sans reparser le texte
      throw quotaErr;
    }
    if (msg.toLowerCase().includes('safety') || msg.toLowerCase().includes('block')) {
      throw new Error('Réponse bloquée par les filtres de sécurité Gemini.');
    }
    throw new Error(`Erreur Gemini : ${msg}`);
  }
  const responseMs = Date.now() - startedAt;

  const text = response?.text?.trim();
  if (!text) throw new Error('Gemini n\'a renvoyé aucun texte (réponse vide ou filtrée).');

  const usage = response?.usageMetadata || {};
  return {
    text,
    tokensIn:  usage.promptTokenCount ?? 0,
    tokensOut: usage.candidatesTokenCount ?? 0,
    responseMs,
  };
}

module.exports = {
  isConfigured,
  generateReply,
  AVAILABLE_MODELS,
  getFallbackModel,
};
