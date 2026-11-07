'use strict';
// utils/youtubeFetcher.js — Nouvelles vidéos YouTube via l'API officielle YouTube Data v3
// Nécessite YOUTUBE_API_KEY dans le .env.
// Astuce quota : on utilise playlistItems.list (1 unité) sur la playlist "uploads" de la
// chaîne plutôt que search.list (100 unités) — permet de suivre beaucoup de chaînes sans
// dépasser le quota gratuit journalier (10 000 unités).

const https = require('https');

const API_KEY = process.env.YOUTUBE_API_KEY || null;
const BASE    = 'https://www.googleapis.com/youtube/v3';

function isConfigured() {
  return !!API_KEY;
}

// ─── Requête HTTPS JSON générique ─────────────────────────────────────────────
function get(endpoint, params = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) return reject(new Error('YouTube non configuré — YOUTUBE_API_KEY manquant dans le .env'));

    const qs = new URLSearchParams({ ...params, key: API_KEY }).toString();
    const url = `${BASE}${endpoint}?${qs}`;

    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch (e) { return reject(new Error('Réponse YouTube invalide')); }
        if (res.statusCode >= 400) {
          const msg = json?.error?.message || `HTTP ${res.statusCode}`;
          return reject(new Error(msg));
        }
        resolve(json);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Résoudre une entrée utilisateur (ID, URL, @handle, nom) → infos chaîne ──
// Retourne { channelId, title, thumbnail, uploadsPlaylistId } ou null
async function resolveChannel(input) {
  if (!input) return null;
  input = input.trim();

  // 1) Channel ID direct (UC... 24 caractères)
  let channelId = /^UC[\w-]{22}$/.test(input) ? input : null;

  // 2) Extraire depuis une URL /channel/UC...
  if (!channelId) {
    const m = input.match(/\/channel\/(UC[\w-]{22})/);
    if (m) channelId = m[1];
  }

  // 3) Si on a déjà l'ID → récupérer directement les infos
  if (channelId) {
    return fetchChannelInfo({ id: channelId });
  }

  // 4) Handle (@nom) — extrait d'une URL ou saisi tel quel
  let handle = null;
  const handleUrlMatch = input.match(/youtube\.com\/@([\w.-]+)/i);
  if (handleUrlMatch) handle = handleUrlMatch[1];
  else if (input.startsWith('@')) handle = input.slice(1);
  else if (/^[\w.-]+$/.test(input) && !input.includes('/')) handle = input; // nom simple, on tente le handle

  if (handle) {
    const byHandle = await fetchChannelInfo({ forHandle: `@${handle}` }).catch(() => null);
    if (byHandle) return byHandle;
  }

  // 5) Ancien /user/xxx (nom d'utilisateur legacy)
  const userUrlMatch = input.match(/youtube\.com\/user\/([\w-]+)/i);
  if (userUrlMatch) {
    const byUser = await fetchChannelInfo({ forUsername: userUrlMatch[1] }).catch(() => null);
    if (byUser) return byUser;
  }

  // 6) Dernier recours — recherche par nom (coûte plus de quota, utilisé rarement)
  try {
    const data = await get('/search', { part: 'snippet', type: 'channel', q: input, maxResults: 1 });
    const found = data.items?.[0];
    if (found?.snippet?.channelId) {
      return fetchChannelInfo({ id: found.snippet.channelId });
    }
  } catch (err) {
    console.error('[YouTube] resolveChannel (search):', err.message);
  }

  return null;
}

// ─── Récupérer les infos + playlist "uploads" d'une chaîne ───────────────────
async function fetchChannelInfo(idParams) {
  const data = await get('/channels', { part: 'snippet,contentDetails', ...idParams });
  const ch = data.items?.[0];
  if (!ch) return null;

  return {
    channelId:         ch.id,
    title:             ch.snippet?.title || null,
    thumbnail:         ch.snippet?.thumbnails?.high?.url || ch.snippet?.thumbnails?.default?.url || null,
    uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads || null,
  };
}

// ─── Récupérer les dernières vidéos via la playlist "uploads" (1 unité) ──────
async function fetchLatestVideos(uploadsPlaylistId, limit = 5) {
  const data = await get('/playlistItems', {
    part: 'snippet,contentDetails',
    playlistId: uploadsPlaylistId,
    maxResults: String(limit),
  });

  const videos = (data.items || []).map((item) => {
    const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    return {
      videoId,
      title:       item.snippet?.title || 'Nouvelle vidéo',
      url:         `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail:   item.snippet?.thumbnails?.maxres?.url || item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || null,
      description: (item.snippet?.description || '').slice(0, 200),
      publishedAt: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : new Date(),
      channelTitle: item.snippet?.channelTitle || null,
    };
  }).filter((v) => v.videoId);

  // La playlist "uploads" est déjà triée du plus récent au plus ancien
  return videos;
}

// ─── Durée ISO 8601 ("PT1M30S") → secondes ──────────────────────────────────
function parseISODuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(iso || ''));
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(s || 0);
}

const SHORTS_MAX_SECONDS = 60;

// Un Short dure 60 s ou moins. `false` si la durée est inconnue : on préfère
// notifier une vidéo dont on ignore la durée plutôt que la perdre.
function isShortDuration(seconds) {
  return Number.isFinite(seconds) && seconds > 0 && seconds <= SHORTS_MAX_SECONDS;
}

// ─── Durées de plusieurs vidéos (1 unité de quota par lot de 50) ─────────────
// Sert à distinguer un Short (≤ 60 s) d'une vidéo classique quand l'alerte a
// désactivé « Shorts ». En cas d'erreur API, l'appelant reçoit une promesse
// rejetée et peut décider de tout notifier plutôt que de perdre la vidéo.
async function fetchVideoDurations(videoIds = []) {
  const ids = [...new Set(videoIds.filter(Boolean))].slice(0, 50);
  if (!ids.length) return {};
  const data = await get('/videos', { part: 'contentDetails', id: ids.join(',') });
  const out = {};
  for (const item of data.items || []) {
    const seconds = parseISODuration(item.contentDetails?.duration);
    if (seconds !== null) out[item.id] = seconds;
  }
  return out;
}

module.exports = {
  isConfigured,
  resolveChannel,
  fetchChannelInfo,
  fetchLatestVideos,
  fetchVideoDurations,
  parseISODuration,
  isShortDuration,
  SHORTS_MAX_SECONDS,
};
