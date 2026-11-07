'use strict';
// utils/twitchFetcher.js — Wrapper léger de l'API Twitch Helix (sans dépendance externe)
// Nécessite TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET dans le .env (App Access Token).
// Doc: https://dev.twitch.tv/docs/api/

const https = require('https');

const CLIENT_ID     = process.env.TWITCH_CLIENT_ID     || null;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || null;

let cachedToken     = null;
let tokenExpiresAt  = 0;

// ─── Le système Twitch est-il configuré ? ─────────────────────────────────────
function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// ─── Requête HTTPS générique (JSON) ───────────────────────────────────────────
function request(url, { method = 'GET', headers = {}, body = null } = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = {};
        try { json = raw ? JSON.parse(raw) : {}; } catch (_) { /* réponse non-JSON */ }
        if (res.statusCode >= 400) {
          const err  = new Error(json.message || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(json);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── Récupérer (ou réutiliser) un App Access Token ────────────────────────────
async function getAppToken(forceRefresh = false) {
  if (!isConfigured()) {
    throw new Error('Twitch non configuré — TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants dans le .env');
  }
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const body = `client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}&grant_type=client_credentials`;
  const data = await request('https://id.twitch.tv/oauth2/token', {
    method:  'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  cachedToken    = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// ─── Appel Helix authentifié (avec retry si le token a expiré) ───────────────
async function helixGet(endpoint, retried = false) {
  const token = await getAppToken();
  try {
    return await request(`https://api.twitch.tv/helix${endpoint}`, {
      headers: {
        'Client-Id':     CLIENT_ID,
        'Authorization': `Bearer ${token}`,
      },
    });
  } catch (err) {
    if (err.status === 401 && !retried) {
      await getAppToken(true);
      return helixGet(endpoint, true);
    }
    throw err;
  }
}

// ─── Résoudre des logins Twitch en objets utilisateur ─────────────────────────
async function getUsersByLogin(logins) {
  const clean = [...new Set(logins.map((l) => String(l).trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return [];

  const chunks = [];
  for (let i = 0; i < clean.length; i += 100) chunks.push(clean.slice(i, i + 100));

  const results = [];
  for (const chunk of chunks) {
    const qs   = chunk.map((l) => `login=${encodeURIComponent(l)}`).join('&');
    const data = await helixGet(`/users?${qs}`);
    results.push(...(data.data || []));
  }
  return results;
}

// ─── Vérifier le statut live d'un lot de streamers (par login) ───────────────
async function getStreamsByLogin(logins) {
  const clean = [...new Set(logins.map((l) => String(l).trim().toLowerCase()).filter(Boolean))];
  if (!clean.length) return [];

  const chunks = [];
  for (let i = 0; i < clean.length; i += 100) chunks.push(clean.slice(i, i + 100));

  const results = [];
  for (const chunk of chunks) {
    const qs   = chunk.map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
    const data = await helixGet(`/streams?${qs}`);
    results.push(...(data.data || []));
  }
  return results;
}

// ─── Streams les plus populaires du moment (toutes catégories) ───────────────
// cursor = curseur Helix ("after") pour paginer, undefined pour la première page.
async function getTopStreams({ cursor, first = 10 } = {}) {
  const qs = new URLSearchParams({ first: String(first) });
  if (cursor) qs.set('after', cursor);
  const data = await helixGet(`/streams?${qs.toString()}`);
  return { items: data.data || [], cursor: data.pagination?.cursor || null };
}

// ─── Résoudre un jeu/catégorie par son nom ────────────────────────────────────
async function getGameByName(name) {
  const data = await helixGet(`/games?name=${encodeURIComponent(name)}`);
  return (data.data || [])[0] || null;
}

// ─── Streams live pour un jeu/catégorie donné ─────────────────────────────────
async function getStreamsByGameId({ gameId, cursor, first = 10 } = {}) {
  const qs = new URLSearchParams({ game_id: gameId, first: String(first) });
  if (cursor) qs.set('after', cursor);
  const data = await helixGet(`/streams?${qs.toString()}`);
  return { items: data.data || [], cursor: data.pagination?.cursor || null };
}

// ─── Recherche de chaînes par nom ──────────────────────────────────────────────
async function searchChannels({ query, cursor, first = 10, liveOnly = false } = {}) {
  const qs = new URLSearchParams({ query, first: String(first) });
  if (liveOnly) qs.set('live_only', 'true');
  if (cursor) qs.set('after', cursor);
  const data = await helixGet(`/search/channels?${qs.toString()}`);
  return { items: data.data || [], cursor: data.pagination?.cursor || null };
}

// ─── Infos "channel" (titre actuel, catégorie) pour un ou plusieurs user_id ───
async function getChannelInfo(userIds) {
  const clean = [...new Set(userIds.map(String))];
  if (!clean.length) return [];
  const qs = clean.map((id) => `broadcaster_id=${encodeURIComponent(id)}`).join('&');
  const data = await helixGet(`/channels?${qs}`);
  return data.data || [];
}

module.exports = {
  isConfigured,
  getAppToken,
  getUsersByLogin,
  getStreamsByLogin,
  getTopStreams,
  getGameByName,
  getStreamsByGameId,
  searchChannels,
  getChannelInfo,
};
