'use strict';
// utils/aiProviders.js — Chaîne de fournisseurs IA GRATUITS.
//
// Aucune API n'est réellement « illimitée » : chaque offre gratuite a son quota
// (RPM/jour). L'astuce honnête consiste donc à EMPILER les offres gratuites et à
// basculer automatiquement sur la suivante quand l'une est épuisée. Le bot
// devient « illimité » en pratique, sans jamais payer.
//
// Deux fournisseurs ne demandent AUCUNE clé (vérifiés en direct) :
//   • OVHcloud AI Endpoints — anonyme, documenté, 2 requêtes/min par IP ;
//   • Pollinations (endpoint historique) — sans clé, non officiel, donc en
//     dernier recours et désactivable (`AI_DISABLE=pollinations`).
//
// Ce module ne touche ni à Discord ni à Mongo : tout est testable seul.

const DEFAULT_ORDER = ['gemini', 'groq', 'cerebras', 'mistral', 'openrouter', 'cloudflare', 'ollama', 'custom', 'ovh', 'pollinations'];

const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    env: ['GEMINI_API_KEY'],
    limits: { rpm: 10, rpd: 500 },
    docs: 'https://ai.google.dev/gemini-api/docs/rate-limits',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    env: ['GROQ_API_KEY'],
    limits: { rpm: 30, rpd: 1000 },
    docs: 'https://console.groq.com/docs/rate-limits',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest'],
    env: ['MISTRAL_API_KEY'],
    limits: { rpm: 50, rpd: 0 },
    docs: 'https://docs.mistral.ai/admin/billing-usage/usage-limits',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (:free)',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free'],
    env: ['OPENROUTER_API_KEY'],
    limits: { rpm: 20, rpd: 50 },
    extraHeaders: { 'X-Title': 'REZO' },
    docs: 'https://openrouter.ai/docs/faq',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    kind: 'openai',
    baseUrl: env => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID || '{id}'}/ai/v1`,
    models: ['@cf/meta/llama-3.1-8b-instruct'],
    env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    limits: { rpm: 20, rpd: 0 },
    docs: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b'],
    env: ['CEREBRAS_API_KEY'],
    limits: { rpm: 30, rpd: 0 },
    docs: 'https://inference-docs.cerebras.ai/support/rate-limits',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    // Pas de clé : le serveur tourne sur la machine. `env` sert de détection —
    // sans OLLAMA_BASE_URL, le fournisseur n'est pas dans la chaîne et ne coûte
    // donc aucun appel réseau inutile vers un port fermé.
    baseUrl: env => `${String(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/v1`,
    models: ['llama3.2'],
    modelFromEnv: 'OLLAMA_MODEL',
    env: ['OLLAMA_BASE_URL'],
    tokenEnv: 'OLLAMA_API_KEY',
    keyless: true,
    limits: {},
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
  },
  {
    id: 'custom',
    label: 'API compatible OpenAI (perso)',
    kind: 'openai',
    // N'importe quel service exposant /chat/completions : OpenAI, DeepSeek,
    // Together, vLLM, LM Studio, un proxy d'entreprise…
    baseUrl: env => String(env.AI_BASE_URL || '').replace(/\/$/, ''),
    models: ['gpt-4o-mini'],
    modelFromEnv: 'AI_MODEL',
    env: ['AI_BASE_URL'],
    tokenEnv: 'AI_API_KEY',
    limits: {},
    docs: 'https://platform.openai.com/docs/api-reference/chat',
  },
  {
    id: 'ovh',
    label: 'OVHcloud AI Endpoints (sans clé)',
    kind: 'openai',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    models: ['gpt-oss-20b'],
    env: [],
    optionalEnv: 'OVH_AI_TOKEN', // facultatif : l'accès anonyme est documenté
    keyless: true,
    limits: { rpm: 2, rpd: 0 },
    docs: 'https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started',
  },
  {
    id: 'pollinations',
    label: 'Pollinations (sans clé, non officiel)',
    kind: 'pollinations',
    baseUrl: 'https://text.pollinations.ai',
    models: ['openai'],
    env: [],
    keyless: true,
    limits: { rpm: 10, rpd: 0 },
    docs: 'https://github.com/pollinations/pollinations',
  },
];

const BY_ID = new Map(PROVIDERS.map(p => [p.id, p]));
const MESSAGE_MAX = 800;

// ─── Disponibilité ──────────────────────────────────────────────────────────
function missingEnv(provider, env = process.env) {
  return (provider.env || []).filter(key => !env[key]);
}

/** Un fournisseur est utilisable si ses variables d'environnement sont présentes. */
function isConfigured(provider, env = process.env) {
  return missingEnv(provider, env).length === 0;
}

function availability(env = process.env) {
  return PROVIDERS.map(provider => ({
    provider,
    configured: isConfigured(provider, env),
    missing: missingEnv(provider, env),
  }));
}

/** Au moins un fournisseur utilisable (clés présentes ET non désactivé). */
function hasAnyProvider(env = process.env) {
  const off = parseDisabled(env.AI_DISABLE);
  return PROVIDERS.some(provider => !off.has(provider.id) && isConfigured(provider, env));
}

function parseOrder(value) {
  if (!value) return null;
  const ids = String(value).split(',').map(s => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

function parseDisabled(value) {
  return new Set(String(value || '').split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Construit la chaîne d'essai : fournisseurs configurés, dans l'ordre choisi,
 * sans ceux désactivés ni ceux dont le quota local est déjà épuisé.
 * @returns {Array<{ provider: object, model: string }>}
 */
function resolveChain(env = process.env, { order = null, disabled = null, gate = null, at = Date.now() } = {}) {
  const wanted = order || parseOrder(env.AI_PROVIDER_ORDER) || DEFAULT_ORDER;
  // `disabled` accepte un Set ou un tableau ; par défaut on lit AI_DISABLE.
  const off = disabled instanceof Set
    ? disabled
    : (disabled ? new Set(disabled) : parseDisabled(env.AI_DISABLE));
  const chain = [];
  const seen = new Set();

  for (const id of wanted) {
    if (seen.has(id)) continue;
    const provider = BY_ID.get(id);
    if (!provider || off.has(id) || !isConfigured(provider, env)) continue;
    seen.add(id);
    chain.push({ provider, model: modelOf(provider, env) });
  }

  // Les fournisseurs ajoutés après coup (nouvelle clé, ordre personnalisé
  // incomplet) ne doivent pas être oubliés : on complète dans l'ordre par défaut.
  for (const id of DEFAULT_ORDER) {
    if (seen.has(id)) continue;
    const provider = BY_ID.get(id);
    if (!provider || off.has(id) || !isConfigured(provider, env)) continue;
    seen.add(id);
    chain.push({ provider, model: modelOf(provider, env) });
  }

  if (!gate) return chain;
  return chain.filter(entry => gate.canSend(entry.provider, at));
}

// ─── Garde-fou de débit local ───────────────────────────────────────────────
// Empêche de gaspiller un appel réseau quand on sait déjà que le quota de la
// minute est atteint (utile surtout pour OVH : 2 requêtes/minute).
class RateGate {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.windows = new Map(); // id -> { hits: number[], day: string, count: number }
  }

  #entry(id, at) {
    const day = new Date(at).toISOString().slice(0, 10);
    let entry = this.windows.get(id);
    if (!entry || entry.day !== day) {
      entry = { hits: [], day, count: 0 };
      this.windows.set(id, entry);
    }
    entry.hits = entry.hits.filter(ts => at - ts < 60_000);
    return entry;
  }

  /** Peut-on envoyer une requête maintenant ? (sans consommer de crédit) */
  canSend(provider, at = this.now()) {
    const limits = provider?.limits || {};
    const entry = this.#entry(provider.id, at);
    if (limits.rpm && entry.hits.length >= limits.rpm) return false;
    if (limits.rpd && entry.count >= limits.rpd) return false;
    return true;
  }

  /** Consomme un crédit (à appeler juste avant l'envoi). */
  record(provider, at = this.now()) {
    const entry = this.#entry(provider.id, at);
    entry.hits.push(at);
    entry.count += 1;
    return entry;
  }

  remaining(provider, at = this.now()) {
    const limits = provider?.limits || {};
    const entry = this.#entry(provider.id, at);
    return {
      rpm: limits.rpm ? Math.max(0, limits.rpm - entry.hits.length) : null,
      rpd: limits.rpd ? Math.max(0, limits.rpd - entry.count) : null,
    };
  }

  reset(id) {
    this.windows.delete(id);
  }
}

// ─── Requêtes ───────────────────────────────────────────────────────────────
function messagesFor({ systemPrompt, history = [], userMessage }) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
  for (const h of history) {
    messages.push({ role: h.role === 'model' || h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text ?? h.content ?? '') });
  }
  messages.push({ role: 'user', content: String(userMessage) });
  return messages;
}

function baseUrlOf(provider, env = process.env) {
  return typeof provider.baseUrl === 'function' ? provider.baseUrl(env) : provider.baseUrl;
}

/** Modèle à utiliser : celui imposé par l'env, sinon le premier de la liste. */
function modelOf(provider, env = process.env) {
  const fromEnv = provider.modelFromEnv ? env[provider.modelFromEnv] : null;
  return String(fromEnv || provider.models[0]);
}

/**
 * Un appel fournisseur, avec UNE seconde chance sur les pannes transitoires
 * (réseau, 5xx). Le contexte de l'échec est réinjecté pour que le modèle ne
 * répète pas la même erreur sans le savoir. Les quotas (429) ne sont jamais
 * réessayés : on passe directement au fournisseur suivant.
 */
async function callWithRetry(provider, params = {}, { fetchImpl = fetch, env = process.env, timeoutMs = 25000 } = {}) {
  let lastErr = null;
  let current = params;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callProvider(provider, current, { fetchImpl, env, timeoutMs });
    } catch (err) {
      lastErr = err;
      if (!(err.network || err.serverError) || attempt === 1) break;
      current = {
        ...current,
        systemPrompt: `${current.systemPrompt || ''}\n\n[Note système : la tentative précédente a échoué (${String(err.message).slice(0, 140)}). Fournis une réponse complète et normale, sans mentionner cette note.]`,
      };
    }
  }
  throw lastErr;
}

/** Construit la requête HTTP d'un fournisseur (pure : aucun appel réseau). */
function buildRequest(provider, { model, systemPrompt, history, userMessage, temperature = 0.9, env = process.env } = {}) {
  const chosen = model || modelOf(provider, env);
  const key = provider.optionalEnv ? env[provider.optionalEnv] : null;

  if (provider.kind === 'pollinations') {
    const params = new URLSearchParams({ model: chosen });
    if (systemPrompt) params.set('system', String(systemPrompt).slice(0, 1000));
    return {
      url: `${baseUrlOf(provider, env)}/${encodeURIComponent(String(userMessage).slice(0, 1500))}?${params.toString()}`,
      method: 'GET',
      headers: { Accept: 'text/plain' },
      body: null,
    };
  }

  const headers = { 'Content-Type': 'application/json', ...(provider.extraHeaders || {}) };
  // Un fournisseur dont la clé n'est pas la première variable d'env (API perso :
  // base URL + clé séparée) doit déclarer `tokenEnv`, sinon l'URL partirait
  // comme Bearer par erreur.
  const token = provider.tokenEnv
    ? env[provider.tokenEnv]
    : ((provider.env || []).map(k => env[k]).find(Boolean) || key);
  if (token) headers.Authorization = `Bearer ${token}`;

  return {
    url: `${baseUrlOf(provider, env).replace(/\/$/, '')}/chat/completions`,
    method: 'POST',
    headers,
    body: {
      model: chosen,
      messages: messagesFor({ systemPrompt, history, userMessage }),
      temperature,
      max_tokens: MESSAGE_MAX,
    },
  };
}

/** Extrait le texte et l'usage d'une réponse (pure). */
function parseResponse(provider, raw) {
  if (provider.kind === 'pollinations') {
    const text = String(raw || '').trim();
    if (!text) throw new Error(`${provider.label} n'a renvoyé aucun texte.`);
    return { text, tokensIn: 0, tokensOut: 0 };
  }

  let json = null;
  try { json = JSON.parse(raw); } catch { throw new Error(`${provider.label} a renvoyé une réponse illisible.`); }
  const text = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? null;
  if (!text) {
    const detail = json?.error?.message || json?.message || 'réponse vide';
    const err = new Error(`${provider.label} : ${String(detail).slice(0, 200)}`);
    err.providerMessage = String(detail);
    throw err;
  }
  return {
    text: String(text).trim(),
    tokensIn: Number(json?.usage?.prompt_tokens) || 0,
    tokensOut: Number(json?.usage?.completion_tokens) || 0,
  };
}

function httpError(provider, status, bodyText) {
  const err = new Error(`${provider.label} — HTTP ${status}${bodyText ? ` : ${String(bodyText).slice(0, 160)}` : ''}`);
  if (status === 429) {
    err.isQuotaError = true;
    err.message = `${provider.label} : quota gratuit atteint (429).`;
  } else if (status === 401 || status === 403) {
    err.badKey = true;
  } else if (status >= 500) {
    err.serverError = true;
  }
  err.status = status;
  return err;
}

/**
 * Envoie un prompt à UN fournisseur.
 * @returns {Promise<{ text:string, tokensIn:number, tokensOut:number, responseMs:number, model:string, providerId:string, providerLabel:string }>}
 */
async function callProvider(provider, params = {}, { fetchImpl = fetch, env = process.env, timeoutMs = 25000 } = {}) {
  const model = params.model || modelOf(provider, env);
  const startedAt = Date.now();

  // Gemini garde son SDK officiel : c'est le chemin déjà éprouvé sur ce bot.
  if (provider.kind === 'gemini') {
    const gemini = require('./geminiClient');
    const out = await gemini.generateReply({ ...params, model });
    return { ...out, model, providerId: provider.id, providerLabel: provider.label };
  }

  const req = buildRequest(provider, { ...params, model, env });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    const wrapped = new Error(aborted
      ? `${provider.label} n'a pas répondu en ${Math.round(timeoutMs / 1000)} s.`
      : `${provider.label} injoignable : ${err.message}`);
    wrapped.network = true;
    wrapped.providerId = provider.id;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) throw httpError(provider, res.status, raw);

  const parsed = parseResponse(provider, raw);
  return {
    ...parsed,
    responseMs: Date.now() - startedAt,
    model,
    providerId: provider.id,
    providerLabel: provider.label,
  };
}

/**
 * Interroge la chaîne dans l'ordre, en sautant tout ce qui échoue.
 * Une panne (réseau, clé, quota) ne doit JAMAIS arrêter les autres fournisseurs.
 * @returns {Promise<{ ok:true, ...result } | { ok:false, attempts:Array, error:string, allExhausted:boolean }>}
 */
async function askWithFallback(params, { chain, fetchImpl = fetch, env = process.env, timeoutMs = 25000, gate = null, onError = null, onQuota = null } = {}) {
  const attempts = [];
  let allExhausted = true;

  for (const entry of chain || []) {
    const { provider, model } = entry;
    if (gate) {
      if (!gate.canSend(provider)) {
        attempts.push({ providerId: provider.id, skipped: 'quota local' });
        continue;
      }
      gate.record(provider);
    }

    try {
      const result = await callWithRetry(provider, { ...params, model }, { fetchImpl, env, timeoutMs });
      // `allExhausted` est toujours présent : un appelant peut le lire sans
      // vérifier `ok` d'abord.
      return { ok: true, allExhausted: false, ...result, attempts };
    } catch (err) {
      attempts.push({ providerId: provider.id, error: err.message, quota: Boolean(err.isQuotaError) });
      if (!err.isQuotaError) allExhausted = false;
      // Les callbacks peuvent être synchrones : jamais de `.catch` aveugle.
      if (err.isQuotaError && onQuota) { try { await onQuota(provider, model, err); } catch { /* jamais bloquant */ } }
      if (onError) { try { await onError(provider, model, err); } catch { /* jamais bloquant */ } }
    }
  }

  const last = attempts.filter(a => a.error).pop();
  return { ok: false, attempts, allExhausted, error: last?.error || 'Aucun fournisseur IA n’est configuré.' };
}

module.exports = {
  PROVIDERS,
  BY_ID,
  DEFAULT_ORDER,
  MESSAGE_MAX,
  RateGate,
  availability,
  isConfigured,
  missingEnv,
  hasAnyProvider,
  parseOrder,
  parseDisabled,
  resolveChain,
  modelOf,
  callWithRetry,
  messagesFor,
  buildRequest,
  parseResponse,
  httpError,
  callProvider,
  askWithFallback,
};
