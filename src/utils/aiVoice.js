'use strict';
// utils/aiVoice.js — Synthèse vocale des réponses de l'IA.
//
// Trois moteurs, dans cet ordre :
//   1. un endpoint compatible OpenAI /audio/speech (si AI_TTS_BASE_URL est défini) ;
//   2. Pollinations « openai-audio » (sans clé) ;
//   3. Google Translate TTS (sans clé, secours ultime, fichiers courts).
//
// Le texte est nettoyé (markdown, URLs, emojis, balises) avant d'être lu : un
// vocal qui épelle « astérisque astérisque » n'a aucune utilité. Aucun échec de
// TTS ne doit empêcher la réponse texte : `speak()` renvoie null, point.

const MAX_CHARS = 1800;
const GOOGLE_CHUNK = 190;

function config(env = process.env) {
  return {
    base: String(env.AI_TTS_BASE_URL || '').replace(/\/$/, ''),
    key: env.AI_TTS_API_KEY || env.OPENAI_API_KEY || null,
    model: env.AI_TTS_MODEL || 'gpt-4o-mini-tts',
    voice: env.AI_TTS_VOICE || 'nova',
  };
}

function isConfigured(env = process.env) {
  return Boolean(config(env).base);
}

/** « en vocal », « dis-le à voix haute », « envoie un audio »… */
function wantsVoiceReply(text) {
  const q = String(text || '').toLowerCase();
  return /(?:en|un|une|le|la)?\s*vocal(?:e)?\b|\baudio\b|voix haute|à l'oral|oralement|parle[- ]moi|dis[- ]le (?:en|à) voix|réponds? en (?:vocal|audio)/.test(q);
}

/** Retire ce qui ne se lit pas à l'oral. */
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/\[\[[\s\S]*?\]\]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, ' ')
    .replace(/[*_~#>|]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Découpe en phrases lisibles, sans couper au milieu d'un mot. */
function chunkText(text, max = GOOGLE_CHUNK) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.split(/(?<=[.!?…])\s+/);
  const chunks = [];
  let current = '';
  for (const part of parts) {
    if (!current) { current = part; continue; }
    if ((current + ' ' + part).length <= max) current += ' ' + part;
    else { chunks.push(current); current = part; }
  }
  if (current) chunks.push(current);
  return chunks.flatMap((c) => (c.length <= max ? [c] : c.match(new RegExp(`.{1,${max}}`, 'g')) || []));
}

async function fetchBuffer(url, { fetchImpl = fetch, headers = {}, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(timer); }
}

async function openaiSpeech(text, { fetchImpl = fetch, env = process.env } = {}) {
  const cfg = config(env);
  if (!cfg.base) throw new Error('non configuré');

  const res = await fetchImpl(`${cfg.base}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
    },
    body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, response_format: 'mp3' }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function pollinationsSpeech(text, { fetchImpl = fetch } = {}) {
  const url = `https://text.pollinations.ai/${encodeURIComponent(text)}?model=openai-audio&voice=nova`;
  const buffer = await fetchBuffer(url, { fetchImpl, timeoutMs: 25_000 });
  if (!buffer?.length) throw new Error('audio vide');
  return buffer;
}

async function googleSpeech(text, { fetchImpl = fetch } = {}) {
  const buffers = [];
  for (const chunk of chunkText(text)) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=fr&q=${encodeURIComponent(chunk)}`;
    const part = await fetchBuffer(url, {
      fetchImpl,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; REZO/1.0)' },
      timeoutMs: 15_000,
    });
    if (part?.length) buffers.push(part);
  }
  if (!buffers.length) throw new Error('audio vide');
  return Buffer.concat(buffers);
}

/**
 * Renvoie { buffer, mime, ext, backend } ou null. Jamais d'exception.
 */
async function speak(text, { fetchImpl = fetch, env = process.env } = {}) {
  const clean = cleanForSpeech(text).slice(0, MAX_CHARS);
  if (!clean) return null;

  const backends = [];
  if (isConfigured(env)) backends.push(['openai', () => openaiSpeech(clean, { fetchImpl, env })]);
  backends.push(['pollinations', () => pollinationsSpeech(clean, { fetchImpl })]);
  backends.push(['google', () => googleSpeech(clean, { fetchImpl })]);

  for (const [backend, run] of backends) {
    try {
      const buffer = await run();
      if (buffer?.length) return { buffer, mime: 'audio/mpeg', ext: 'mp3', backend };
    } catch { /* moteur suivant */ }
  }
  return null;
}

module.exports = {
  MAX_CHARS,
  GOOGLE_CHUNK,
  config,
  isConfigured,
  wantsVoiceReply,
  cleanForSpeech,
  chunkText,
  speak,
  openaiSpeech,
  pollinationsSpeech,
  googleSpeech,
};
