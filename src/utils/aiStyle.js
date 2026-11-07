'use strict';
// utils/aiStyle.js — Apprentissage du style d'écriture d'un serveur.
//
// Objectif : que REZO parle comme la communauté, pas comme un modèle générique.
// On échantillonne des messages réels (hors bots, hors commandes), on en tire un
// profil court et stable, stocké sur la config du serveur puis injecté dans le
// prompt système. Le profil est du TEXTE : aucune donnée brute n'est conservée.

const providers = require('./aiProviders');
const persona = require('./aiPersona');

const MAX_SAMPLES = 60;
const MIN_SAMPLE_LENGTH = 12;
const MAX_PROFILE = 700;

const ANALYST_PROMPT = [
  'Tu analyses le style d’écriture d’une communauté Discord francophone.',
  'À partir des messages fournis, décris en 5 puces maximum (700 caractères au total) :',
  '- le ton (familier, soutenu, taquin…),',
  '- la longueur habituelle des messages et la ponctuation,',
  '- le vocabulaire et les expressions récurrentes,',
  '- les emojis ou abréviations typiques,',
  '- ce qu’il faut éviter pour ne pas paraître à côté.',
  'Écris des consignes directement utilisables par un assistant. Pas d’exemples inventés, pas de jugement.',
].join('\n');

/** Messages exploitables d'un salon (jamais de bots ni de commandes). */
async function collectSamples(channel, { limit = 60 } = {}) {
  if (!channel?.messages?.fetch) return [];
  const batch = await channel.messages.fetch({ limit: Math.min(100, limit) }).catch(() => null);
  if (!batch) return [];

  return [...batch.values()]
    .filter(m => !m.author?.bot)
    .map(m => String(m.content || '').trim())
    .filter(t => t.length >= MIN_SAMPLE_LENGTH && !/^[/!?.#]/.test(t))
    .slice(0, MAX_SAMPLES);
}

/** Demande un profil de style au fournisseur disponible. Renvoie '' si échec. */
async function learnStyle(samples, { fetchImpl = fetch } = {}) {
  const list = (samples || []).filter(Boolean).slice(0, MAX_SAMPLES);
  if (list.length < 3) return '';

  try {
    const chain = providers.resolveChain(process.env, {});
    if (!chain.length) return '';
    const outcome = await providers.askWithFallback(
      {
        systemPrompt: ANALYST_PROMPT,
        userMessage: list.map((m, i) => `${i + 1}. ${m.slice(0, 240)}`).join('\n'),
        temperature: 0.4,
      },
      { chain, fetchImpl, timeoutMs: 30_000 },
    );
    if (!outcome.ok) return '';
    return persona.scrubIdentity(outcome.text).slice(0, MAX_PROFILE).trim();
  } catch { return ''; }
}

function buildStyleBlock(profile) {
  const clean = String(profile || '').trim().slice(0, MAX_PROFILE);
  if (!clean) return null;
  return `Style d’écriture observé sur ce serveur (imite-le sans le caricaturer, sans le citer) :\n${clean}`;
}

module.exports = { MAX_SAMPLES, MAX_PROFILE, collectSamples, learnStyle, buildStyleBlock };
