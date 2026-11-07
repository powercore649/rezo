'use strict';
// utils/aiImages.js — Génération d'images, SANS clé API.
//
// Le service utilisé est celui que le bot emploie déjà pour le texte sans clé :
// Pollinations. Vérifié en direct (oct. 2026) :
//   • GET https://image.pollinations.ai/prompt/<prompt> → image/jpeg, aucune clé ;
//   • modèle « flux » = le meilleur rendu de l'offre gratuite ;
//   • l'offre anonyme autorise UNE image toutes les 45 secondes par IP.
//
// Ce dernier point n'est pas un détail : sans garde-fou local, deux demandes
// rapprochées se soldaient par un HTTP 402 « FREE_LIMIT » et un message
// incompréhensible. On attend donc localement, et quand la limite tombe quand
// même, on renvoie le délai exact fourni par le service.
//
// Module pur : le réseau et l'horloge sont injectables, donc testable hors ligne.

const DEFAULT_ENDPOINT = 'https://image.pollinations.ai/prompt';
const DEFAULT_MODEL = process.env.AI_IMAGE_MODEL || 'flux';

// Tailles demandées. Le service peut réduire pour tenir dans son budget gratuit
// (observé : ~1000 px de côté), il conserve toujours les proportions.
const SIZES = {
  carre:    { width: 1024, height: 1024, label: 'carré',   emoji: '⬛' },
  paysage:  { width: 1280, height: 768,  label: 'paysage', emoji: '🖼️' },
  portrait: { width: 768,  height: 1280, label: 'portrait', emoji: '📱' },
};

const DEFAULT_SIZE = 'carre';

// Styles prêts à l'emploi : ce sont eux qui font la différence entre une image
// « correcte » et une image soignée, bien plus que la taille.
const STYLES = {
  aucun:  { label: 'aucun',  hint: 'sans style imposé' },
  photo:  { label: 'photo',  hint: 'photoréaliste', suffix: 'photographie réaliste, objectif 50 mm, lumière naturelle douce, mise au point nette, très haute résolution' },
  art:    { label: 'art',    hint: 'illustration soignée', suffix: 'illustration numérique, palette riche, composition équilibrée, détails fins, éclairage dramatique' },
  anime:  { label: 'anime',  hint: 'style anime', suffix: 'illustration anime, traits nets, cel shading, décor détaillé, couleurs vives' },
  '3d':   { label: '3d',     hint: 'rendu 3D', suffix: 'rendu 3D, matériaux réalistes, occlusion ambiante, éclairage de studio, haute fidélité' },
  dessin: { label: 'dessin', hint: 'dessin au trait', suffix: 'dessin au trait, encrage propre, style bande dessinée, ombres simples' },
  logo:   { label: 'logo',   hint: 'logo / emblème', suffix: 'logo minimaliste vectoriel, fond uni, formes simples, fort contraste, lisible en petit' },
  peinture: { label: 'peinture', hint: 'peinture classique', suffix: 'peinture à l’huile, coups de pinceau visibles, texture de toile, lumière chaude' },
};

const DEFAULT_STYLE = 'aucun';

// Intervalle imposé par l'offre anonyme (surchargeable pour un accès avec clé).
const FREE_INTERVAL_MS = Math.max(0, Number.parseInt(process.env.AI_IMAGE_INTERVAL_MS || '45000', 10) || 45_000);
const TIMEOUT_MS = Math.max(5_000, Number.parseInt(process.env.AI_IMAGE_TIMEOUT_MS || '60000', 10) || 60_000);
const MAX_PROMPT = 900;

// ─── Garde-fou de débit (global au processus) ────────────────────────────────
// Partage entre la commande /ia image et le salon de discussion : la limite
// s'applique par IP, donc par bot — pas par salon.
class ImageGate {
  constructor(intervalMs = FREE_INTERVAL_MS, now = () => Date.now()) {
    this.intervalMs = intervalMs;
    this.now = now;
    this.lastAt = 0;
  }

  retryInMs() {
    if (!this.lastAt) return 0;
    return Math.max(0, this.lastAt + this.intervalMs - this.now());
  }

  canGenerate() {
    return this.retryInMs() === 0;
  }

  /** À appeler juste avant la requête : même un échec consomme le créneau IP. */
  record() {
    this.lastAt = this.now();
  }

  reset() {
    this.lastAt = 0;
  }
}

const imageGate = new ImageGate();

// ─── Aides ───────────────────────────────────────────────────────────────────
function formatDelay(ms) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

function normalizeSize(size) {
  const key = String(size || DEFAULT_SIZE).toLowerCase();
  return SIZES[key] ? key : DEFAULT_SIZE;
}

function normalizeStyle(style) {
  const key = String(style || DEFAULT_STYLE).toLowerCase();
  return STYLES[key] ? key : DEFAULT_STYLE;
}

/** Nettoie la demande de l'utilisateur avant de la proposer au service. */
function sanitizePrompt(prompt) {
  return String(prompt || '')
    .replace(/https?:\/\/\S+/g, ' ') // pas d'URL dans le prompt : inutile et risque d'injection
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_PROMPT);
}

/**
 * Enrichit la demande : style choisi + rappel de qualité. C'est ce qui distingue
 * une image de qualité d'un rendu bâclé, sans jamais écraser l'intention.
 */
function enhancePrompt(prompt, style = DEFAULT_STYLE) {
  const clean = sanitizePrompt(prompt);
  const chosen = normalizeStyle(style);
  const suffix = STYLES[chosen]?.suffix;
  if (!suffix) return clean;
  return `${clean}, ${suffix}`.slice(0, MAX_PROMPT + 240);
}

/** Construit l'URL finale (pure : c'est elle qu'on teste). */
function buildImageUrl({ prompt, size = DEFAULT_SIZE, style = DEFAULT_STYLE, seed = null, endpoint = null, model = DEFAULT_MODEL } = {}) {
  const base = String(endpoint || process.env.AI_IMAGE_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const dims = SIZES[normalizeSize(size)];
  const params = new URLSearchParams({
    model,
    width: String(dims.width),
    height: String(dims.height),
    nologo: 'true',
    enhance: 'true',
  });
  if (seed !== null && seed !== undefined && seed !== '') params.set('seed', String(seed));
  const token = process.env.POLLINATIONS_TOKEN || process.env.POLLINATIONS_API_KEY;
  if (token) params.set('token', token);
  const finalPrompt = enhancePrompt(prompt, style);
  return { url: `${base}/${encodeURIComponent(finalPrompt)}?${params.toString()}`, finalPrompt, dims };
}

/** Le service annonce le délai exact : « Retry after 39s ». */
function parseRetryAfterMs(bodyText) {
  const m = /retry\s+after\s+(\d+)\s*s/i.exec(String(bodyText || ''));
  return m ? Number.parseInt(m[1], 10) * 1000 : null;
}

function imageError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

/**
 * Génère une image.
 * @returns {Promise<{ buffer: Buffer, mime: string, url: string, seed: string|null,
 *   size: string, sizeLabel: string, finalPrompt: string, responseMs: number }>}
 * @throws  Error avec `isQuotaError` (limite atteinte) ou `retryAfterMs` si connue.
 */
async function generateImage({
  prompt, size = DEFAULT_SIZE, style = DEFAULT_STYLE, seed = null,
  fetchImpl = fetch, gate = imageGate, timeoutMs = TIMEOUT_MS, endpoint = null, model = DEFAULT_MODEL,
} = {}) {
  const cleaned = sanitizePrompt(prompt);
  if (cleaned.length < 3) {
    throw imageError('Décris l’image que tu veux (au moins quelques mots).');
  }

  const waiting = gate.retryInMs();
  if (waiting > 0) {
    throw imageError(
      `🖼️ Une image est déjà en cours de génération. Réessaie dans ${formatDelay(waiting)} : le service gratuit limite à une image toutes les 45 secondes.`,
      { isQuotaError: true, retryAfterMs: waiting },
    );
  }

  const { url, finalPrompt, dims } = buildImageUrl({ prompt: cleaned, size, style, seed, endpoint, model });
  const startedAt = Date.now();
  gate.record();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'image/*', 'User-Agent': `${process.env.AI_CREATOR || 'nova_lead_'}-bot/REZO` },
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    throw imageError(aborted
      ? `🖼️ Le service d’images n’a pas répondu en ${Math.round(timeoutMs / 1000)} s. Réessaie.`
      : `🖼️ Service d’images injoignable : ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const contentType = String(res.headers?.get?.('content-type') || res.headers?.['content-type'] || '');

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const retryAfterMs = parseRetryAfterMs(body);
    if (res.status === 402 || /FREE_LIMIT|free limit|quota|rate/i.test(body)) {
      throw imageError(
        `🖼️ La limite gratuite d’images est atteinte${retryAfterMs ? ` — réessaie dans ${formatDelay(retryAfterMs)}` : ' — réessaie dans une minute'} (une image toutes les 45 s).`,
        { isQuotaError: true, retryAfterMs, status: 402 },
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw imageError('🖼️ Le service d’images a refusé la requête (accès). Vérifie la configuration des images.', { status: res.status });
    }
    throw imageError(`🖼️ Le service d’images a échoué (HTTP ${res.status}). Réessaie dans quelques instants.`, { status: res.status });
  }

  if (contentType && !/^image\//i.test(contentType)) {
    throw imageError('🖼️ Le service a renvoyé autre chose qu’une image. Reformule la demande.');
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length < 1024) {
    throw imageError('🖼️ Image vide reçue. Reformule la demande.');
  }

  return {
    buffer,
    mime: /png/i.test(contentType) ? 'image/png' : 'image/jpeg',
    url,
    seed: seed === null || seed === undefined || seed === '' ? null : String(seed),
    size: normalizeSize(size),
    sizeLabel: dims.label,
    style: normalizeStyle(style),
    finalPrompt,
    responseMs: Date.now() - startedAt,
  };
}

// ─── Détection d'une demande d'image en langage naturel ──────────────────────
// « génère-moi une image de soleil », « dessine un chat qui dort », « une image
// d'un dragon en 3D »… Personne ne va taper « /image » : on reconnaît l'intention
// dans une phrase normale, on en extrait le sujet, et on en déduit le style et
// le format demandés.

// Verbe d'action (+ éventuellement « moi ») suivi du mot image/illustration/…
const TRIGGERS = [
  /(?:g[ée]n[èe]re|cr[ée]e|cr[ée][ée]?|fais|fabrique|produis|dessine|peins|imagine|montre)[\s-]*(?:moi|nous)?[\s-]*(?:une?\s+)?(?:image|illustration|dessin|photo(?:graphie)?|peinture|logo|banni[èe]re|avatar|affiche|sticker|wallpaper|fond d[’']?[ée]cran|portrait|paysage)\b/i,
  /^\s*(?:dessine|peins|imagine)[\s:,-]+/i,
  /^\s*(?:une?\s+)?(?:image|illustration|dessin|photo|logo)\s+(?:de|d[’']|du|des)\s+/i,
];

// Messages qui parlent d'images sans en demander une.
const META_GUARD = [
  /^\s*(?:comment|pourquoi|quand|o[ùu]|est-ce que|peux-tu m[’']expliquer|explique|quelle|quel|c[’']est quoi)/i,
  /(?:quelle commande|comment (?:on |faire|g[ée]n[èe]rer)|la commande pour|tu peux g[ée]n[èe]rer des images)/i,
];

const STYLE_HINTS = [
  [/\banime\b|\bmanga\b|\bwaifu\b/i, 'anime'],
  [/\b3d\b|rendu 3d|style 3d/i, '3d'],
  [/\blogo\b|embl[èe]me|\bic[oô]ne\b/i, 'logo'],
  [/peinture|aquarelle|\bhuile\b|toile/i, 'peinture'],
  [/dessin|croquis|esquisse|au trait|\bsketch\b/i, 'dessin'],
  [/photor[ée]aliste|\bphoto\b|photographie|r[ée]aliste/i, 'photo'],
  [/illustration|artistique|\bart\b/i, 'art'],
];

const SIZE_HINTS = [
  [/banni[èe]re|panoram|horizontal|wallpaper|fond d[’']?[ée]cran|large/i, 'paysage'],
  [/portrait|vertical|affiche|poster|sticker/i, 'portrait'],
  [/avatar|ic[oô]ne|\blogo\b|emoji|profil/i, 'carre'],
];

/** Retire les connecteurs qui restent devant le sujet : « de soleil » → « soleil ». */
function cleanSubject(text) {
  return String(text || '')
    .replace(/^[\s:,\-–—]+/, '')
    .replace(/^(?:moi\s+|nous\s+|stp\s+|s[’']il te pla[îi]t\s+|please\s+)/i, '')
    .replace(/^(?:de|d[’']|du|des)\s+/i, '')
    .replace(/[.!?]+\s*$/, '')
    .trim();
}

/**
 * Reconnaît une demande d'image écrite normalement.
 * @returns {{ prompt: string, style: string, size: string } | null}
 */
function detectImageRequest(content) {
  const text = String(content || '').trim();
  if (text.length < 6 || text.length > 800) return null;
  if (META_GUARD.some(pattern => pattern.test(text))) return null;

  for (const pattern of TRIGGERS) {
    const match = pattern.exec(text);
    if (!match) continue;

    const subject = cleanSubject(text.slice(match.index + match[0].length));
    // Sujet vide (« /image » tout court) : on n'invente rien.
    const prompt = subject.length >= 2 ? subject : cleanSubject(text);
    if (prompt.length < 3) return null;

    const style = STYLE_HINTS.find(([re]) => re.test(text))?.[1] || DEFAULT_STYLE;
    const size = SIZE_HINTS.find(([re]) => re.test(text))?.[1] || DEFAULT_SIZE;
    return { prompt, style, size };
  }

  return null;
}

module.exports = {
  SIZES,
  STYLES,
  detectImageRequest,
  DEFAULT_SIZE,
  DEFAULT_STYLE,
  DEFAULT_MODEL,
  FREE_INTERVAL_MS,
  ImageGate,
  imageGate,
  sanitizePrompt,
  enhancePrompt,
  buildImageUrl,
  parseRetryAfterMs,
  normalizeSize,
  normalizeStyle,
  formatDelay,
  generateImage,
};
