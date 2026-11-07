'use strict';
// utils/mapEngine.js — Géométrie d'une carte « slippy » (Web Mercator) + état du panneau.
//
// Pourquoi ce module existe : une carte interactive dans Discord n'est pas une
// iframe Google Maps. On assemble des tuiles d'une carte réelle, on les colle en
// une image PNG (mapRender.js), et on rejoue le rendu à chaque clic de bouton.
// Il faut donc deux choses, très testables hors-ligne :
//   • la projection latitude/longitude → pixels du monde, et son inverse ;
//   • l'état de la vue (centre, zoom, style) encodé DANS le customId du bouton —
//     aucun cache ne peut donc se désynchroniser ou se perdre au redémarrage.
//
// Tout est pur : aucune I/O, aucune dépendance à Discord.

const TILE_SIZE = 256;      // taille CSS d'une tuile (le @2x pèse 512 px)
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
const MAX_LAT = 85.05112877980659; // limite du Mercator : au-delà, y diverge
// Fonds de carte disponibles (bouton 🌓). `theme` garde ce nom d'état : c'est la
// « couleur » de la carte, pas seulement clair/sombre.
const THEMES = ['dark', 'light', 'plan', 'sat'];
const ACTIONS = ['in', 'out', 'up', 'down', 'left', 'right', 'reset', 'style'];
const DEFAULT_WIDTH = 820;
const DEFAULT_HEIGHT = 430;

function clampLat(lat) {
  const n = Number(lat);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, n));
}

function clampZoom(zoom) {
  const n = Number(zoom);
  if (!Number.isFinite(n)) return 12;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(n)));
}

// Longitude ramenée dans [-180, 180) : on peut traverser l'antiméridien sans
// que la carte « saute » à l'autre bout du monde.
// Le modulo flottant laisse des traînes (-70.64826999999998) : on arrondit au
// millionième, largement plus précis qu'un pixel et stable d'un rendu à l'autre.
function normLon(lon) {
  const n = Number(lon);
  if (!Number.isFinite(n)) return 0;
  let value = ((n + 180) % 360 + 360) % 360 - 180;
  if (Object.is(value, -180)) value = 180;
  return Math.round(value * 1e6) / 1e6;
}

/** Arrondi à 5 décimales (~1 m) — la précision envoyée dans les customId. */
function round5(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e5) / 1e5;
}

/** Taille du monde en pixels à ce zoom (tileSize CSS par défaut). */
function worldSize(zoom, tileSize = TILE_SIZE) {
  return tileSize * 2 ** zoom;
}

/** Latitude/longitude → pixels du monde (coin nord-ouest = 0,0). */
function project(lat, lon, zoom, tileSize = TILE_SIZE) {
  const z = clampZoom(zoom);
  const world = worldSize(z, tileSize);
  const rad = (clampLat(lat) * Math.PI) / 180;
  const x = ((normLon(lon) + 180) / 360) * world;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * world;
  return { x, y };
}

/** Inverse exact de `project` — sert à déplacer le centre d'un cran de « x pixels ». */
function unproject(x, y, zoom, tileSize = TILE_SIZE) {
  const z = clampZoom(zoom);
  const world = worldSize(z, tileSize);
  const lon = normLon((x / world) * 360 - 180);
  const n = Math.PI - (2 * Math.PI * y) / world;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat: clampLat(lat), lon };
}

/**
 * Tuiles nécessaires pour couvrir la vue, avec leur position DANS l'image.
 * `x` revient au début du monde quand on dépasse l'antiméridien (la carte est
 * continue) ; `y` hors pôles est simplement ignoré (fond visible).
 */
function tileGrid({ lat, lon, zoom, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, tileSize = TILE_SIZE }) {
  const z = clampZoom(zoom);
  const center = project(lat, lon, z, tileSize);
  const left = center.x - width / 2;
  const top = center.y - height / 2;
  const count = 2 ** z;

  const firstX = Math.floor(left / tileSize);
  const lastX = Math.floor((left + width - 1e-6) / tileSize);
  const firstY = Math.floor(top / tileSize);
  const lastY = Math.floor((top + height - 1e-6) / tileSize);

  const tiles = [];
  for (let ty = firstY; ty <= lastY; ty++) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = firstX; tx <= lastX; tx++) {
      tiles.push({
        z,
        x: ((tx % count) + count) % count,
        y: ty,
        left: tx * tileSize - left,
        top: ty * tileSize - top,
        size: tileSize,
      });
    }
  }
  return { zoom: z, width, height, tileSize, tiles };
}

/** Déplace la vue d'environ un tiers d'écran dans une direction. */
function pan(state, direction, { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, step = 0.34, tileSize = TILE_SIZE } = {}) {
  const current = normalizeState(state);
  const point = project(current.lat, current.lon, current.zoom, tileSize);
  const dx = Math.round(width * step);
  const dy = Math.round(height * step);

  if (direction === 'left') point.x -= dx;
  else if (direction === 'right') point.x += dx;
  else if (direction === 'up') point.y -= dy;
  else if (direction === 'down') point.y += dy;
  else return current;

  const next = unproject(point.x, point.y, current.zoom, tileSize);
  return normalizeState({ ...current, lat: next.lat, lon: next.lon });
}

/** Change le zoom en gardant exactement le même centre. */
function zoomBy(state, delta) {
  const current = normalizeState(state);
  const zoom = clampZoom(current.zoom + Number(delta || 0));
  return { ...current, zoom };
}

function normalizeState(state = {}) {
  const theme = THEMES.includes(state.theme) ? state.theme : 'dark';
  return {
    // On arrondit AVANT de clamper : arrondir après ferait repasser le pôle
    // juste au-dessus de la limite du Mercator (85.05113 > 85.051128…).
    lat: clampLat(round5(clampLat(state.lat))),
    lon: normLon(round5(state.lon)),
    zoom: clampZoom(state.zoom),
    theme,
  };
}

// ── Encodage de l'état dans le customId d'un bouton ──────────────────────────
// Format : map_<action>_<theme>_<lat>_<lon>_<zoom>
// Exemple : map_left_dark_48.85660_2.35220_12   (≈ 37 caractères, limite 100)
function encodeState({ action, lat, lon, zoom, theme }) {
  const s = normalizeState({ lat, lon, zoom, theme });
  return `map_${action}_${s.theme}_${s.lat.toFixed(5)}_${s.lon.toFixed(5)}_${s.zoom}`;
}

const STATE_RE = /^map_(in|out|up|down|left|right|reset|style)_(dark|light|plan|sat)_(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)_(\d{1,2})$/;

function decodeState(customId) {
  const match = STATE_RE.exec(String(customId || ''));
  if (!match) return null;
  const [, action, theme, lat, lon, zoom] = match;
  const state = normalizeState({ lat, lon, zoom, theme });
  return { ...state, action };
}

// ── Présentation ─────────────────────────────────────────────────────────────
function formatCoords(lat, lon, digits = 5) {
  const s = normalizeState({ lat, lon, zoom: 12 });
  return `${s.lat.toFixed(digits)}, ${s.lon.toFixed(digits)}`;
}

/** Lien vers la vraie carte Google Maps, centrée sur la même vue. */
function googleMapsLink({ lat, lon, zoom }) {
  const s = normalizeState({ lat, lon, zoom });
  const gzoom = Math.max(3, Math.min(21, s.zoom));
  return `https://www.google.com/maps/@${s.lat.toFixed(5)},${s.lon.toFixed(5)},${gzoom}z`;
}

/** Mètres couverts par un pixel CSS à cette latitude (tuiles de 256 px). */
function metersPerPixel(lat, zoom, tileSize = TILE_SIZE) {
  const circumference = 40075016.686; // équateur, en mètres
  return (circumference * Math.cos((clampLat(lat) * Math.PI) / 180)) / worldSize(clampZoom(zoom), tileSize);
}

function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '—';
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? Math.round(km * 10) / 10 : Math.round(km)} km`;
}

/**
 * Barre d'échelle lisible : on vise ~110 px et on arrondit à 1/2/5 × 10ⁿ.
 * @returns {{ meters:number, px:number, label:string }}
 */
function scaleBar(mpp, targetPx = 110) {
  const raw = Math.max(0.5, mpp * targetPx);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 5, 10].map(k => k * magnitude).find(v => v >= raw) || 10 * magnitude;
  return { meters: nice, px: nice / mpp, label: formatDistance(nice) };
}

const THEME_LABELS = {
  dark: '🌙 sombre',
  light: '☀️ clair',
  plan: '🗺️ plan',
  sat: '🛰️ satellite',
};

function themeLabel(theme) {
  return THEME_LABELS[theme] || THEME_LABELS.dark;
}

/** Fait tourner les fonds de carte : sombre → clair → plan → satellite → sombre. */
function nextTheme(theme) {
  const index = THEMES.indexOf(theme);
  return THEMES[(index + 1) % THEMES.length];
}

/** « 48.8566, 2.3522 » saisi à la main, ou « 48.8566,2.3522|Paris » via l'autocomplétion. */
function parseLocationValue(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const [coordsPart, ...labelParts] = raw.split('|');
  const label = labelParts.join('|').trim() || null;
  const match = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(coordsPart);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, label };
}

module.exports = {
  TILE_SIZE,
  MIN_ZOOM,
  MAX_ZOOM,
  MAX_LAT,
  THEMES,
  ACTIONS,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  clampLat,
  clampZoom,
  normLon,
  round5,
  worldSize,
  project,
  unproject,
  tileGrid,
  pan,
  zoomBy,
  normalizeState,
  encodeState,
  decodeState,
  formatCoords,
  googleMapsLink,
  metersPerPixel,
  formatDistance,
  scaleBar,
  themeLabel,
  nextTheme,
  parseLocationValue,
};
