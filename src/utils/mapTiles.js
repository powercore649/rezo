'use strict';
// utils/mapTiles.js — Accès réseau de la carte : géocodage + téléchargement des tuiles.
//
// Deux services publics, aucun compte ni clé API :
//   • Photon (komoot) pour transformer « Tour Eiffel » en coordonnées, avec
//     Nominatim en secours ;
//   • les fonds de carte Esri (ArcGIS Online) et OpenStreetMap pour les tuiles.
//
// Pourquoi pas Google Maps ni CARTO : leur API de tuiles exige désormais une clé
// (CARTO renvoie même une image « API KEY REQUIRED » à la place de la carte).
// Les fonds retenus sont libres d'accès, sans compte, et autorisent l'affichage
// avec attribution — ce que l'embed fait systématiquement.
//
// Les règles qui évitent de se faire couper par ces serveurs gratuits :
//   1. un User-Agent identifiable (les politiques d'usage l'exigent) ;
//   2. un cache mémoire (tuiles 6 h, géocodage 1 h) ;
//   3. au plus 6 requêtes de tuiles en parallèle ;
//   4. repli automatique vers OpenStreetMap si le fond demandé ne répond pas.
//
// Un fond peut avoir PLUSIEURS couches (Esri sépare le dessin des routes et les
// étiquettes) : la couche 0 est le fond, les suivantes sont des calques
// transparents empilés dessus.
//
// Tout est injectable (`http`) pour être testé sans réseau.

const axios = require('axios');
const { parseLocationValue } = require('./mapEngine');

const USER_AGENT = 'REZO-DiscordBot/2.1 (+https://github.com/; contact: bot@rezo.local)';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// ── Fournisseurs de tuiles ───────────────────────────────────────────────────
// Esri utilise l'ordre {z}/{ligne}/{colonne} (y avant x) : piège classique qui
// décale toute la carte d'un quadrant si on l'oublie.
const ESRI_BASE = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const esriTile = (service, layer) =>
  (z, x, y) => `${ESRI_BASE}/${service}/MapServer/tile/${z}/${y}/${x}${layer ? `?layers=${layer}` : ''}`;

function esriProvider({ id, service, reference, attribution }) {
  return {
    id,
    attribution,
    layers: reference
      ? [esriTile(service), esriTile(reference)]
      : [esriTile(service)],
  };
}

const PROVIDERS = {
  // Fonds vectoriels grisés Esri : base + calque d'étiquettes transparent.
  'esri-dark': esriProvider({
    id: 'esri-dark',
    service: 'Canvas/World_Dark_Gray_Base',
    reference: 'Canvas/World_Dark_Gray_Reference',
    attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
  }),
  'esri-light': esriProvider({
    id: 'esri-light',
    service: 'Canvas/World_Light_Gray_Base',
    reference: 'Canvas/World_Light_Gray_Reference',
    attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
  }),
  'esri-sat': esriProvider({
    id: 'esri-sat',
    service: 'World_Imagery',
    attribution: 'Esri, Maxar, Earthstar Geographics, © OpenStreetMap contributors',
  }),
  osm: {
    id: 'osm',
    attribution: '© OpenStreetMap contributors',
    layers: [(z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`],
  },
};

// Style choisi par l'utilisateur (bouton 🌓) → fond correspondant.
const THEME_PROVIDERS = {
  dark: 'esri-dark',
  light: 'esri-light',
  plan: 'osm',
  sat: 'esri-sat',
};

const FALLBACK_PROVIDER = 'osm';

function providerFor(theme) {
  return PROVIDERS[THEME_PROVIDERS[theme] || THEME_PROVIDERS.dark];
}

function attribution(providerId) {
  return (PROVIDERS[providerId] || PROVIDERS[FALLBACK_PROVIDER]).attribution;
}

// ── Caches ───────────────────────────────────────────────────────────────────
const TILE_TTL_MS = 6 * 60 * 60 * 1000;
const TILE_MAX = 600;
const GEO_TTL_MS = 60 * 60 * 1000;
const GEO_MAX = 300;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_MAX = 200;

const tileCache = new Map();    // `${providerId}/${couche}/${z}/${x}/${y}` → { buffer, at }
const geocodeCache = new Map(); // requête normalisée → { place, at }
const searchCache = new Map();  // `${limit}|${requête}` → { places, at }
const inFlight = new Map();     // requêtes identiques simultanées → même promesse

function cacheGet(cache, key, ttl) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(cache, key, value, max) {
  if (cache.size >= max) {
    // Les entrées sont insérées dans l'ordre chronologique : la plus vieille part.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ...value, at: Date.now() });
}

function clearCaches() {
  tileCache.clear();
  geocodeCache.clear();
  searchCache.clear();
  inFlight.clear();
}

// ── Requêtes HTTP tolérantes ────────────────────────────────────────────────
// Les services publics répondent 429 quand on les sollicite trop (l'autocomplé-
// tion part à chaque frappe). Un seul réessai, uniquement sur ces codes : une
// panne réseau réelle ne mérite pas de doubler l'attente de l'utilisateur.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

async function httpGet(http, url, config, { retryDelay = 900 } = {}) {
  try {
    return await http.get(url, config);
  } catch (err) {
    if (!RETRY_STATUS.has(err?.response?.status)) throw err;
    const after = Number(err.response?.headers?.['retry-after']);
    const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 2500) : retryDelay;
    await new Promise(resolve => setTimeout(resolve, wait));
    return http.get(url, config);
  }
}

// ── Limite de concurrence ────────────────────────────────────────────────────
// Une image demande ~12 tuiles ; les lancer d'un coup déclenche des 429. On
// garde donc 6 requêtes en vol au maximum, quel que soit le nombre de panneaux
// ouverts en même temps.
const MAX_PARALLEL = 6;
let active = 0;
const queue = [];

function acquire() {
  if (active < MAX_PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise(resolve => queue.push(resolve));
}

function release() {
  active--;
  const next = queue.shift();
  if (next) {
    active++;
    next();
  }
}

async function withSlot(task) {
  await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

async function fetchLayer(providerId, layerIndex, { z, x, y }, { http, timeout }) {
  const key = `${providerId}/${layerIndex}/${z}/${x}/${y}`;
  const cached = cacheGet(tileCache, key, TILE_TTL_MS);
  if (cached) return cached.buffer;

  const url = PROVIDERS[providerId].layers[layerIndex](z, x, y);
  const { data } = await http.get(url, {
    responseType: 'arraybuffer',
    timeout,
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/png,image/*' },
  });
  const buffer = Buffer.from(data);
  if (!buffer.length) throw new Error('tuile vide');
  cacheSet(tileCache, key, { buffer }, TILE_MAX);
  return buffer;
}

/**
 * Une tuile complète (toutes ses couches), depuis le cache ou le réseau.
 * @returns {Promise<{ buffers:Array<Buffer|null>, providerId:string }|null>}
 */
async function loadTile({ z, x, y }, { theme = 'dark', http = axios, timeout = 7000 } = {}) {
  const preferredId = providerFor(theme).id;
  const attemptOrder = [preferredId, FALLBACK_PROVIDER].filter((id, i, all) => all.indexOf(id) === i);

  for (const providerId of attemptOrder) {
    const provider = PROVIDERS[providerId];
    const results = await Promise.all(provider.layers.map((_, index) =>
      withSlot(() => fetchLayer(providerId, index, { z, x, y }, { http, timeout })).catch(() => null)));

    // Une couche d'étiquettes peut manquer sans ruiner la carte ; le fond, non.
    if (results[0]) return { buffers: results, providerId };
  }
  return null;
}

// ── Géocodage ────────────────────────────────────────────────────────────────
function cleanLabel(value, max = 90) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function photonLabel(props = {}) {
  const parts = [];
  for (const part of [props.name, props.city, props.state, props.country]) {
    const value = typeof part === 'string' ? part.trim() : '';
    if (!value) continue;
    if (parts.some(existing => existing.toLowerCase() === value.toLowerCase())) continue;
    parts.push(value);
  }
  return cleanLabel(parts.join(', '));
}

function nominatimLabel(item = {}) {
  const parts = String(item.display_name || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 3);
  return cleanLabel(parts.join(', '));
}

async function fetchPlaces(text, { http, limit, timeout }) {
  try {
    const { data } = await httpGet(http, PHOTON_URL, {
      params: { q: text, limit, lang: 'fr' },
      timeout,
      headers: { 'User-Agent': USER_AGENT },
    });
    const places = (data?.features || [])
      .map(feature => ({
        lon: Number(feature?.geometry?.coordinates?.[0]),
        lat: Number(feature?.geometry?.coordinates?.[1]),
        label: photonLabel(feature?.properties) || cleanLabel(text),
      }))
      .filter(place => Number.isFinite(place.lat) && Number.isFinite(place.lon));
    if (places.length) return places;
  } catch {
    // Photon indisponible : on essaie Nominatim juste après.
  }

  try {
    const { data } = await httpGet(http, NOMINATIM_URL, {
      params: { q: text, format: 'jsonv2', limit, 'accept-language': 'fr' },
      timeout,
      headers: { 'User-Agent': USER_AGENT },
    });
    return (Array.isArray(data) ? data : [])
      .map(item => ({
        lat: Number(item.lat),
        lon: Number(item.lon),
        label: nominatimLabel(item) || cleanLabel(text),
      }))
      .filter(place => Number.isFinite(place.lat) && Number.isFinite(place.lon));
  } catch {
    return [];
  }
}

/**
 * Recherche libre (autocomplétion incluse).
 * Cache 10 min + déduplication des requêtes simultanées : taper « Tour Eiffel »
 * dans Discord envoie une requête par frappe, et les services publics coupent
 * au-delà d'un appel par seconde.
 * @returns {Promise<Array<{ lat:number, lon:number, label:string }>>}
 */
async function searchPlaces(query, { http = axios, limit = 1, timeout = 6000 } = {}) {
  const text = String(query || '').trim();
  if (text.length < 2) return [];

  const key = `${limit}|${text.toLowerCase()}`;
  const cached = cacheGet(searchCache, key, SEARCH_TTL_MS);
  if (cached) return cached.places;

  if (inFlight.has(key)) return inFlight.get(key);

  const pending = fetchPlaces(text, { http, limit, timeout })
    .then(places => {
      if (places.length) cacheSet(searchCache, key, { places }, SEARCH_MAX);
      return places;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, pending);
  return pending;
}

/**
 * « Paris », « Tour Eiffel », « 48.8566, 2.3522 » ou « 48.8566,2.3522|Paris »
 * → { lat, lon, label } ou null si rien n'est trouvé.
 */
async function geocode(query, { http = axios, timeout = 6000 } = {}) {
  const raw = String(query || '').trim();
  if (!raw) return null;

  const direct = parseLocationValue(raw);
  if (direct) {
    return {
      lat: direct.lat,
      lon: direct.lon,
      label: direct.label ? cleanLabel(direct.label) : `${direct.lat.toFixed(5)}, ${direct.lon.toFixed(5)}`,
    };
  }

  const key = raw.toLowerCase();
  const cached = cacheGet(geocodeCache, key, GEO_TTL_MS);
  if (cached) return cached.place;

  const [best] = await searchPlaces(raw, { http, limit: 1, timeout });
  if (!best) return null;

  const place = { lat: best.lat, lon: best.lon, label: best.label || cleanLabel(raw) };
  cacheSet(geocodeCache, key, { place }, GEO_MAX);
  return place;
}

module.exports = {
  USER_AGENT,
  PROVIDERS,
  THEME_PROVIDERS,
  MAX_PARALLEL,
  httpGet,
  providerFor,
  attribution,
  loadTile,
  searchPlaces,
  geocode,
  cleanLabel,
  photonLabel,
  nominatimLabel,
  clearCaches,
  __caches: { tileCache, geocodeCache },
};
