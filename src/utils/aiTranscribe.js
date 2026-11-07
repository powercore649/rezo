'use strict';
// utils/aiTranscribe.js — Transcription des messages vocaux Discord.
//
// Discord n'envoie pas de texte pour un vocal : on télécharge la pièce jointe
// et on la transcrit via un endpoint compatible OpenAI /audio/transcriptions
// (Groq par défaut, qui héberge Whisper gratuitement). Aucune dépendance
// Python : faster-whisper local n'est pas embarquable dans ce bot Node.
//
// Variables d'environnement (optionnelles) :
//   AI_TRANSCRIBE_BASE_URL  défaut : https://api.groq.com/openai/v1
//   AI_TRANSCRIBE_API_KEY   défaut : GROQ_API_KEY
//   AI_TRANSCRIBE_MODEL     défaut : whisper-large-v3-turbo
//
// Sans clé, isEnabled() renvoie false et le vocal est simplement ignoré — le
// bot ne prétend jamais avoir compris un audio qu'il n'a pas transcrit.

const MAX_BYTES = 24 * 1024 * 1024;
const AUDIO_EXT = /\.(ogg|oga|mp3|wav|m4a|opus|webm|flac)$/i;

function config(env = process.env) {
  return {
    base: String(env.AI_TRANSCRIBE_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    key: env.AI_TRANSCRIBE_API_KEY || env.GROQ_API_KEY || null,
    model: env.AI_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo',
  };
}

function isEnabled(env = process.env) {
  return Boolean(config(env).key);
}

function looksLikeAudio(attachment) {
  if (!attachment) return false;
  const type = String(attachment.contentType || '').toLowerCase();
  if (type.startsWith('audio/')) return true;
  return AUDIO_EXT.test(String(attachment.name || ''));
}

async function transcribeUrl(url, { fetchImpl = fetch, env = process.env, timeoutMs = 60_000 } = {}) {
  const cfg = config(env);
  if (!cfg.key) throw new Error('Transcription vocale non configurée (clé de transcription absente).');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const audio = await fetchImpl(url, { signal: controller.signal });
    if (!audio.ok) throw new Error(`Téléchargement de l’audio impossible (HTTP ${audio.status}).`);

    const buffer = Buffer.from(await audio.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new Error('Message vocal trop long (24 Mo maximum).');

    const form = new FormData();
    form.append('file', new Blob([buffer]), 'vocal.ogg');
    form.append('model', cfg.model);
    form.append('language', 'fr');
    form.append('response_format', 'json');

    const res = await fetchImpl(`${cfg.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form,
      signal: controller.signal,
    });

    const raw = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Transcription refusée (HTTP ${res.status}) : ${raw.slice(0, 160)}`);

    let json = null;
    try { json = JSON.parse(raw); } catch { /* texte brut */ }
    const text = String(json?.text || raw || '').trim();
    if (!text) throw new Error('Transcription vide.');
    return text;
  } finally { clearTimeout(timer); }
}

module.exports = { MAX_BYTES, config, isEnabled, looksLikeAudio, transcribeUrl };
