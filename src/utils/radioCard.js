'use strict';
// utils/radioCard.js — Carte « à l’antenne » du module radio.
//
// Même famille que utils/musicCard.js (canvas 1280 × 420, sans emoji : les
// polices emoji ne sont pas garanties partout), avec une contrainte propre au
// direct : la carte est réaffichée en continu, un rendu doit donc coûter
// quelques millisecondes, pas quelques dizaines.
//
// Trois décisions en découlent :
//   1. Découpage statique / dynamique. Tout ce qui ne bouge pas (fond, halo,
//      disque de la station, nom, accroche, pastilles de genre) est dessiné UNE
//      fois dans un canvas hors-écran, mis en cache par station. Une image ne
//      fait plus que recopier cette couche puis dessiner ce qui vit.
//   2. Rien ne « glisse » d’une image à l’autre. Le titre est découpé sur deux
//      lignes au lieu de défiler, et l’égaliseur affiche les niveaux réels du
//      flux (utils/audioLevels.js) déjà lissés : une image toutes les ~1 s ne
//      doit pas donner l’impression d’un saut. Si aucun niveau n’est encore
//      disponible, une onde lente d’attente prend le relais.
//   3. Aucun état de lecture ici. La carte reçoit un instantané ; elle ignore
//      ce qu’est une session et ne parle jamais à Discord. C’est ce qui la
//      rend testable sans vocal, sans base et sans réseau.
//
// `cardSignature` sert au moteur à ne pas renvoyer deux fois la même image
// quand rien ne bouge (radio en pause) : le silence réseau fait partie de la
// fluidité.

const { createCanvas } = require('@napi-rs/canvas');
const { helpers } = require('./rankCard');
const stations = require('./radioStations');
const serverIdentity = require('./serverIdentity');

const { roundRect, rgb, rgba, lighten, darken, ellipsize } = helpers;

const W = 1280;
const H = 420;

// Nom du fichier joint : l’embed y fait référence par `attachment://radio.jpg`.
// JPEG plutôt que PNG : sur une image de fond dégradé, il divise le poids par
// deux et l’encodage par cinq — c’est ce qui rend la cadence d’une image par
// seconde tenable sur un hébergeur modeste.
const CARD_NAME = 'radio.jpg';
const CARD_URL = `attachment://${CARD_NAME}`;
const JPEG_QUALITY = 92;

const PAD_X = 350;                 // colonne de droite
const MAX_TEXT = W - PAD_X - 56;   // largeur utile du texte

const WINE = { r: 139, g: 26, b: 26 };
const GOLD = { r: 212, g: 175, b: 55 };
const AMBER = { r: 240, g: 176, b: 60 };
const RED = { r: 226, g: 62, b: 62 };

const LIVE_H = 44;                 // hauteur de l’égaliseur
const LIVE_Y = 320;

// ─── Helpers purs d’affichage ──────────────────────────────────────────────

function colorOf(value) {
  const hex = Number(value) || 0;
  return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
}

/** « 12 min », « 1 h 04 », « 3 j 2 h » — durée d’écoute lisible sur la carte. */
function formatSpan(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} j ${hours % 24} h`;
}

/** Initiales du disque : « France Inter » → FI, « Skyrock » → SK. */
function initialsOf(name) {
  const words = String(name || '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'RZ';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 3).map(word => word[0]).join('').toUpperCase();
}

/**
 * Hauteurs de l’égaliseur, entre 0 et 1, à un instant donné.
 * Déterministe : deux appels avec le même `timeMs` donnent la même image, ce
 * qui rend l’animation testable et évite toute accumulation d’état.
 */
function equalizerBars({ count = 28, timeMs = 0, paused = false, volume = 70, seed = 0 } = {}) {
  const bars = Math.max(1, Math.min(64, Math.round(count)));
  const t = Number(timeMs) / 1000 || 0;
  // À volume nul, l’égaliseur respire à peine : l’image ne doit pas laisser
  // croire qu’un son fort sort alors que le bot est muet.
  const level = paused ? 0 : 0.25 + 0.75 * Math.min(1, Math.max(0, Number(volume) || 0) / 100);

  return Array.from({ length: bars }, (_, index) => {
    if (paused) return 0.1;
    // Onde lente et spatialement continue : chaque barre est décalée par
    // rapport à sa voisine, donc l’ensemble ondule au lieu de sauter. À une
    // image toutes les ~1 s, une animation rapide ne se lit pas comme un
    // mouvement mais comme du bruit — on préfère une houle.
    const phase = index + seed * 7;
    const wave = Math.sin(phase * 0.42 - t * 0.45) * 0.55
      + Math.sin(phase * 0.11 - t * 0.65) * 0.3
      + Math.sin(phase * 0.9 + t * 0.2) * 0.15;
    return Math.min(1, Math.max(0.06, 0.5 + wave * 0.5 * level * 0.85));
  });
}

/** Coupe un texte à la largeur donnée, avec des points de suspension. */
function ellipsizeText(text, maxWidth, measure) {
  const value = String(text || '');
  if (measure(value) <= maxWidth) return value;
  let out = value;
  while (out.length > 1 && measure(`${out}…`) > maxWidth) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/**
 * Découpe le titre en lignes qui tiennent dans `maxWidth`, au plus `maxLines`.
 *
 * Remplace le défilement horizontal : à une image toutes les ~1 s, un texte qui
 * glisse avance de plusieurs dizaines de pixels entre deux images — l’œil voit
 * un saut, pas un mouvement. Deux lignes fixes, elles, ne bougent pas.
 */
function wrapText(text, maxWidth, measure, maxLines = 2) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    let line = words[index];
    index += 1;
    while (index < words.length && measure(`${line} ${words[index]}`) <= maxWidth) {
      line = `${line} ${words[index]}`;
      index += 1;
    }
    lines.push(line);
  }

  const truncated = index < words.length;
  return lines.map((line, position) => {
    const isLast = position === lines.length - 1;
    return ellipsizeText(isLast && truncated ? `${line}…` : line, maxWidth, measure);
  });
}

/**
 * Signature des éléments variables : identique ⇒ rien à renvoyer.
 *
 * Les niveaux y entrent quantifiés (1/12) : une station silencieuse ou un
 * morceau tenu ne réexpédient pas la même image, alors qu’un morceau qui joue
 * change à chaque fois. Le chrono est réduit à la minute pour la même raison.
 */
function cardSignature(snapshot = {}) {
  const station = snapshot.station || {};
  const levels = snapshot.levels && snapshot.levels.length
    ? Array.from(snapshot.levels).map(value => Math.round((Number(value) || 0) * 12)).join(',')
    : '-';
  return [
    station.id || 'idle',
    snapshot.paused ? 'pause' : 'live',
    Math.round(Number(snapshot.volume) || 0),
    snapshot.showNowPlaying === false ? 'title-off' : String(snapshot.title || 'title-none'),
    Math.floor((Number(snapshot.elapsed) || 0) / 60),
    levels,
  ].join('|');
}

// ─── Couche statique (mise en cache par station) ───────────────────────────
const STATIC_MAX = 6;
const staticLayers = new Map();

function staticKeyFor(snapshot = {}) {
  const station = snapshot.station;
  // Le nom du serveur fait partie de la couche statique (signature en bas de
  // carte) : le changer doit invalider le cache, même station en cours.
  const brand = serverIdentity.currentIdentity().name;
  if (!station) return `idle|${brand}`;
  return `${station.id}|${station.bitrate}|${station.codec}|${station.country}|${brand}`;
}

function drawRing(ctx, cx, cy, radius, color, width = 2) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawStaticLayer(snapshot = {}) {
  const station = snapshot.station || null;
  const genre = station ? stations.genreOf(station) : null;
  // Aucune station : la carte prend la couleur de l'identité du serveur.
  const accent = station ? colorOf(genre.color) : serverIdentity.accentRgb(null, WINE);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Fond ────────────────────────────────────────────────────────────────
  ctx.fillStyle = '#0b0c14';
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  ctx.save();
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.clip();

  const wash = ctx.createLinearGradient(0, 0, W, H);
  wash.addColorStop(0, rgba(accent, 0.1));
  wash.addColorStop(0.55, 'rgba(11,12,20,0)');
  wash.addColorStop(1, 'rgba(11,12,20,0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  const halo = ctx.createRadialGradient(190, 210, 0, 190, 210, 360);
  halo.addColorStop(0, rgba(accent, 0.2));
  halo.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // Liseré supérieur, seule trace de marque permanente.
  const top = ctx.createLinearGradient(0, 0, W * 0.6, 0);
  top.addColorStop(0, rgb(accent));
  top.addColorStop(0.6, rgba(accent, 0.4));
  top.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = top;
  roundRect(ctx, 0, 0, W, 6, 3);
  ctx.fill();

  // ── Disque de la station ────────────────────────────────────────────────
  const cx = 190;
  const cy = 210;
  const radius = 118;

  ctx.save();
  ctx.shadowColor = rgba(accent, 0.55);
  ctx.shadowBlur = 46;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const disc = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  disc.addColorStop(0, rgb(darken(accent, 0.25)));
  disc.addColorStop(0.55, rgb(accent));
  disc.addColorStop(1, '#101018');
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = disc;
  ctx.fill();

  drawRing(ctx, cx, cy, radius - 16, rgba({ r: 255, g: 255, b: 255 }, 0.12), 1.5);
  drawRing(ctx, cx, cy, radius - 34, rgba({ r: 255, g: 255, b: 255 }, 0.08), 1);
  drawRing(ctx, cx, cy, radius, rgba({ r: 255, g: 255, b: 255 }, 0.18), 2);

  // Petits crans autour du disque, comme un cadran.
  for (let i = 0; i < 48; i += 1) {
    const angle = (i / 48) * Math.PI * 2;
    const inner = radius + 7;
    const outer = radius + (i % 4 === 0 ? 15 : 11);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.strokeStyle = rgba({ r: 255, g: 255, b: 255 }, i % 4 === 0 ? 0.28 : 0.12);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.font = 'bold 62px Sans';
  ctx.textAlign = 'center';
  ctx.fillText(initialsOf(station?.name || 'REZO'), cx, cy + 22);
  ctx.restore();

  if (station) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = 'bold 13px Sans';
    ctx.textAlign = 'center';
    ctx.fillText(station.country || '—', cx, cy + 52);
    ctx.restore();
  }

  // ── Pastilles d’en-tête (genre, pays, débit) ────────────────────────────
  // La pastille LIVE est dynamique (elle pulse) : on réserve sa place.
  const liveWidth = 136;
  let chipX = PAD_X + liveWidth + 10;

  if (station) {
    const chips = [
      { label: stations.genreOf(station).label.toUpperCase(), dot: accent },
      { label: `${station.bitrate} kbps`, dot: { r: 150, g: 160, b: 190 } },
    ];
    for (const chip of chips) {
      ctx.font = 'bold 13px Sans';
      const width = ctx.measureText(chip.label).width + 34;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      roundRect(ctx, chipX, 62, width, 32, 16);
      ctx.fill();

      // Pastille de couleur à gauche, texte presque blanc : lisible même sur
      // un fond teinté par le genre.
      ctx.beginPath();
      ctx.arc(chipX + 16, 78, 4, 0, Math.PI * 2);
      ctx.fillStyle = rgb(lighten(chip.dot, 0.25));
      ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.font = 'bold 13px Sans';
      ctx.textAlign = 'left';
      ctx.fillText(chip.label, chipX + 27, 83);
      chipX += width + 8;
    }
  }

  // ── Nom, accroche ───────────────────────────────────────────────────────
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px Sans';
  ctx.textAlign = 'left';
  const name = station ? station.name : 'Prête à diffuser';
  ctx.fillText(ellipsize(ctx, name, MAX_TEXT), PAD_X, 152);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '20px Sans';
  ctx.textAlign = 'left';
  const tagline = station
    ? station.tagline
    : 'Je rejoins ton salon vocal et je diffuse le direct — aucune file, aucune coupure.';
  ctx.fillText(ellipsize(ctx, tagline, MAX_TEXT), PAD_X, 190);
  ctx.restore();

  // Séparateur + intitulé de la ligne « à l’antenne ».
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(PAD_X, 214, MAX_TEXT, 1);

  ctx.save();
  ctx.fillStyle = rgba(GOLD, 0.75);
  ctx.font = 'bold 13px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(station ? 'À L’ANTENNE' : 'EN ATTENTE D’UNE STATION', PAD_X, 244);
  ctx.restore();

  // Signature discrète, en bas à droite.
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.font = 'bold 12px Sans';
  ctx.textAlign = 'right';
  ctx.fillText(`${serverIdentity.nameFor(serverIdentity.currentIdentity(), 18).toUpperCase()} · RADIO EN DIRECT`, W - 56, 394);
  ctx.restore();

  return canvas;
}

function staticLayerFor(snapshot) {
  const key = staticKeyFor(snapshot);
  const hit = staticLayers.get(key);
  if (hit) {
    // LRU simple : une station réécoutée revient en tête.
    staticLayers.delete(key);
    staticLayers.set(key, hit);
    return hit;
  }
  const layer = drawStaticLayer(snapshot);
  if (staticLayers.size >= STATIC_MAX) staticLayers.delete(staticLayers.keys().next().value);
  staticLayers.set(key, layer);
  return layer;
}

function clearCardCache() {
  staticLayers.clear();
}

// ─── Éléments dynamiques ───────────────────────────────────────────────────

function drawLivePill(ctx, { x, y, paused, onAir, timeMs }) {
  const label = !onAir ? 'EN ATTENTE' : (paused ? 'EN PAUSE' : 'EN DIRECT');
  const tone = !onAir ? { r: 150, g: 160, b: 190 } : (paused ? AMBER : RED);
  const pulse = 0.5 + 0.5 * Math.sin((Number(timeMs) / 1000 || 0) * 1.3);

  ctx.save();
  ctx.fillStyle = rgba(tone, 0.16);
  roundRect(ctx, x, y, 136, 32, 16);
  ctx.fill();
  ctx.strokeStyle = rgba(tone, 0.4);
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, 136, 32, 16);
  ctx.stroke();

  const dotX = x + 20;
  const dotY = y + 16;
  if (onAir && !paused) {
    ctx.beginPath();
    ctx.arc(dotX, dotY, 8 + pulse * 4, 0, Math.PI * 2);
    ctx.fillStyle = rgba(tone, 0.16 + pulse * 0.12);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(dotX, dotY, 4 + (onAir && !paused ? pulse * 1.4 : 0), 0, Math.PI * 2);
  ctx.fillStyle = rgb(tone);
  ctx.fill();

  ctx.fillStyle = rgb(lighten(tone, 0.35));
  ctx.font = 'bold 12px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 34, y + 21);
  ctx.restore();
}

function drawTitleLine(ctx, { x, y, title, accent, showNowPlaying }) {
  const text = showNowPlaying === false
    ? 'Titre en direct masqué (réglages)'
    : (title || 'Titre non fourni par cette station');
  const isTitle = Boolean(title) && showNowPlaying !== false;

  ctx.save();
  ctx.font = 'bold 26px Sans';
  const lines = wrapText(text, MAX_TEXT, value => ctx.measureText(value).width, 2);
  ctx.fillStyle = isTitle ? '#ffffff' : 'rgba(255,255,255,0.42)';
  ctx.textAlign = 'left';
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * 30));
  ctx.restore();

  // Petit trait d’accent sous le titre, comme une onde.
  ctx.save();
  const underline = ctx.createLinearGradient(x, 0, x + MAX_TEXT * 0.45, 0);
  underline.addColorStop(0, rgba(accent, 0.6));
  underline.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = underline;
  ctx.fillRect(x, y + 44, MAX_TEXT * 0.45, 1.5);
  ctx.restore();
}

/**
 * Barres à dessiner : les niveaux réels du flux quand on les a, sinon l’onde
 * d’attente. Une seule source de vérité pour la carte et ses tests.
 */
function resolveBars(snapshot = {}, count = 40) {
  const raw = snapshot.levels && snapshot.levels.length ? Array.from(snapshot.levels) : null;
  if (raw) {
    return Array.from({ length: count }, (_, index) => {
      const value = Number(raw[Math.floor((index * raw.length) / count)]) || 0;
      return value <= 0 ? 0 : (value >= 1 ? 1 : value);
    });
  }
  return equalizerBars({
    count,
    timeMs: snapshot.timeMs,
    paused: snapshot.paused,
    volume: snapshot.volume,
    seed: snapshot.station?.id ? snapshot.station.id.length : 0,
  });
}

function drawEqualizer(ctx, { x, y, width, height, bars, accent, paused }) {
  const count = bars.length;
  const gap = 5;
  const barW = Math.max(3, (width - gap * (count - 1)) / count);

  const fill = ctx.createLinearGradient(0, y + height, 0, y);
  fill.addColorStop(0, rgba(accent, paused ? 0.22 : 0.45));
  fill.addColorStop(1, rgb(lighten(accent, paused ? 0.1 : 0.45)));

  ctx.save();
  for (let index = 0; index < count; index += 1) {
    const value = bars[index];
    const height2 = Math.max(4, value * height);
    roundRect(ctx, x + index * (barW + gap), y + (height - height2), barW, height2, Math.min(3, barW / 2));
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.restore();
}

function drawClockIcon(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - size * 0.42);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx + size * 0.38, cy + size * 0.22);
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawSignalIcon(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  for (let index = 0; index < 4; index += 1) {
    const height = size * (0.3 + index * 0.22);
    roundRect(ctx, cx - size * 0.8 + index * size * 0.42, cy + size * 0.7 - height, size * 0.24, height, 1.5);
    ctx.fill();
  }
  ctx.restore();
}

function drawVolumeIcon(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.8, cy - size * 0.3);
  ctx.lineTo(cx - size * 0.4, cy - size * 0.3);
  ctx.lineTo(cx + size * 0.05, cy - size * 0.72);
  ctx.lineTo(cx + size * 0.05, cy + size * 0.72);
  ctx.lineTo(cx - size * 0.4, cy + size * 0.3);
  ctx.lineTo(cx - size * 0.8, cy + size * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx + size * 0.1, cy, size * 0.45, -0.5 * Math.PI, 0.5 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

function drawChip(ctx, x, y, { icon, label }) {
  ctx.save();
  ctx.font = 'bold 15px Sans';
  const width = 46 + ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  roundRect(ctx, x, y, width, 34, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, width, 34, 12);
  ctx.stroke();

  icon(ctx, x + 21, y + 17, 9, 'rgba(255,255,255,0.55)');
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = 'bold 15px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 38, y + 22);
  ctx.restore();
  return width;
}

// ─── Rendu ─────────────────────────────────────────────────────────────────
/**
 * @param {object} snapshot
 * @param {object|null} snapshot.station   station en cours (null = aucune)
 * @param {string|null} snapshot.title     titre ICY du direct
 * @param {boolean} snapshot.paused
 * @param {number} snapshot.volume         0-200
 * @param {number} snapshot.elapsed        secondes réellement écoutées
 * @param {boolean} snapshot.showNowPlaying
 * @param {number} [snapshot.timeMs]       horloge de l’animation (tests)
 * @returns {Promise<Buffer>}
 */
async function renderRadioCard(snapshot = {}) {
  const timeMs = Number(snapshot.timeMs) || Date.now();
  const station = snapshot.station || null;
  const genre = station ? stations.genreOf(station) : null;
  // Aucune station : la carte prend la couleur de l'identité du serveur.
  const accent = station ? colorOf(genre.color) : serverIdentity.accentRgb(null, WINE);
  const paused = Boolean(snapshot.paused);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 1. Le décor, déjà dessiné une fois pour cette station.
  ctx.drawImage(staticLayerFor(snapshot), 0, 0);

  // 2. Ce qui vit.
  drawLivePill(ctx, { x: PAD_X, y: 62, paused, onAir: Boolean(station), timeMs });

  // Sans station, la ligne du titre n’aurait rien à dire : l’espace reste
  // vide, l’égaliseur au repos suffit à montrer que la carte est vivante.
  if (station) {
    drawTitleLine(ctx, {
      x: PAD_X,
      y: 274,
      title: snapshot.title || null,
      accent,
      showNowPlaying: snapshot.showNowPlaying,
    });
  }

  const bars = resolveBars({ ...snapshot, timeMs }, 40);
  drawEqualizer(ctx, { x: PAD_X, y: LIVE_Y, width: MAX_TEXT, height: LIVE_H, bars, accent, paused });

  // 3. Pastilles d’état.
  const chipsY = 372;
  let chipX = PAD_X;
  chipX += drawChip(ctx, chipX, chipsY, {
    icon: drawClockIcon,
    label: station ? formatSpan(snapshot.elapsed) : 'prête',
  }) + 10;
  chipX += drawChip(ctx, chipX, chipsY, {
    icon: drawVolumeIcon,
    label: `${Math.round(Number(snapshot.volume) || 0)} %`,
  }) + 10;
  if (station) {
    drawChip(ctx, chipX, chipsY, {
      icon: drawSignalIcon,
      label: station.codec || 'MP3',
    });
  }

  return canvas.toBuffer('image/jpeg', JPEG_QUALITY);
}

module.exports = {
  renderRadioCard,
  equalizerBars,
  resolveBars,
  wrapText,
  ellipsizeText,
  cardSignature,
  initialsOf,
  formatSpan,
  clearCardCache,
  CARD_NAME,
  CARD_URL,
  CARD_SIZE: { W, H },
};
