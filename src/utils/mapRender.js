'use strict';
// utils/mapRender.js — Colle les tuiles d'une carte réelle dans une image PNG.
//
// C'est la partie « pixels » : chaque clic de bouton recalcule la vue, récupère
// les tuiles (mapTiles.js), les assemble couche par couche, puis ajoute les
// repères qui rendent l'image lisible dans Discord — épingle de position, barre
// d'échelle, badge de zoom et attribution obligatoire des fonds de carte.
//
// L'image est rendue en 1:1 (une tuile = 256 px) : les serveurs publics ne
// fournissent pas de tuiles @2x, et agrandir du 256 px donnerait un rendu flou.
//
// Le rendu est volontairement tolérant : une tuile manquante laisse un fond uni,
// et si le moteur canvas est indisponible sur la machine, l'appelant reçoit une
// erreur claire et affiche le panneau sans image (jamais un crash du bot).

const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { canvasAvailable } = require('./canvasProbe');
const {
  normalizeState, tileGrid, metersPerPixel, scaleBar,
  DEFAULT_WIDTH, DEFAULT_HEIGHT,
} = require('./mapEngine');
const tileSource = require('./mapTiles');

const PIN_COLOR = '#8B1A1A';
const PIN_HIGHLIGHT = '#D4AF37';

// Les fonds clairs (gris clair Esri, plan OpenStreetMap) demandent une encre
// sombre ; le satellite et le fond sombre, une encre blanche.
function lightChrome(theme) {
  return theme === 'light' || theme === 'plan';
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** Épingle de position : goutte pleine + liseré clair, lisible sur fond clair comme sombre. */
function drawPin(ctx, cx, cy) {
  ctx.save();

  // Ombre portée au sol : donne la sensation que l'épingle est « plantée ».
  ctx.beginPath();
  ctx.ellipse(cx, cy, 8, 3.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.bezierCurveTo(cx - 12, cy - 13, cx - 11, cy - 30, cx, cy - 30);
  ctx.bezierCurveTo(cx + 11, cy - 30, cx + 12, cy - 13, cx, cy);
  ctx.closePath();
  ctx.fillStyle = PIN_COLOR;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.stroke();

  // Cœur doré : rappelle la signature REZO au milieu de la carte.
  ctx.beginPath();
  ctx.arc(cx, cy - 20, 4.2, 0, Math.PI * 2);
  ctx.fillStyle = PIN_HIGHLIGHT;
  ctx.fill();

  ctx.restore();
}

function drawScaleBar(ctx, state, width, height, dark) {
  // `dark` = encre claire sur fond sombre.
  const bar = scaleBar(metersPerPixel(state.lat, state.zoom), 110);
  const x = 16;
  const y = height - 20;
  const ink = dark ? 'rgba(255, 255, 255, 0.92)' : 'rgba(22, 26, 33, 0.85)';
  const halo = dark ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.9)';

  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + bar.px, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  ctx.moveTo(x + bar.px, y - 4);
  ctx.lineTo(x + bar.px, y + 4);
  ctx.stroke();

  ctx.font = 'bold 11px Sans';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = halo;
  ctx.shadowBlur = 4;
  ctx.fillStyle = ink;
  ctx.fillText(bar.label, x, y - 7);
  ctx.restore();

  return bar;
}

function drawAttribution(ctx, attribution, width, height, dark) {
  ctx.save();
  ctx.font = '11px Sans';
  const text = attribution;
  const textWidth = ctx.measureText(text).width;
  const boxWidth = textWidth + 16;
  const boxHeight = 21;
  const x = width - boxWidth - 10;
  const y = height - boxHeight - 10;

  roundRect(ctx, x, y, boxWidth, boxHeight, 6);
  ctx.fillStyle = dark ? 'rgba(13, 15, 20, 0.72)' : 'rgba(255, 255, 255, 0.82)';
  ctx.fill();

  ctx.fillStyle = dark ? 'rgba(255, 255, 255, 0.86)' : 'rgba(24, 28, 36, 0.78)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 8, y + boxHeight / 2 + 0.5);
  ctx.restore();
}

function drawZoomBadge(ctx, zoom, dark) {
  ctx.save();
  ctx.font = 'bold 11px Sans';
  const label = `ZOOM ${zoom}`;
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + 16;
  const boxHeight = 21;
  const x = 10;
  const y = 10;

  roundRect(ctx, x, y, boxWidth, boxHeight, 6);
  ctx.fillStyle = dark ? 'rgba(13, 15, 20, 0.72)' : 'rgba(255, 255, 255, 0.82)';
  ctx.fill();

  ctx.fillStyle = dark ? 'rgba(255, 255, 255, 0.86)' : 'rgba(24, 28, 36, 0.78)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 8, y + boxHeight / 2 + 0.5);
  ctx.restore();
}

/**
 * Rend la vue en PNG.
 * @param {{lat:number, lon:number, zoom:number, theme?:string}} state
 * @param {object} [options]
 * @param {number} [options.width]  largeur CSS
 * @param {number} [options.height] hauteur CSS
 * @param {number} [options.scale]  facteur de résolution (2 = Retina, tuiles @2x)
 * @param {Function} [options.fetchTile] injectable pour les tests
 * @returns {Promise<{ buffer:Buffer, attribution:string, providerId:string, tiles:number, missing:number }>}
 */
async function renderMap(state, {
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  scale = 1,
  fetchTile = (tile, options) => tileSource.loadTile(tile, options),
} = {}) {
  const ready = await canvasAvailable();
  if (!ready) throw new Error('moteur canvas indisponible sur cette machine');

  const view = normalizeState(state);
  const dark = !lightChrome(view.theme);
  const grid = tileGrid({ ...view, width, height });

  const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = dark ? '#161a20' : '#e8ecf1';
  ctx.fillRect(0, 0, width, height);

  const loaded = await Promise.all(grid.tiles.map(async tile => {
    const result = await fetchTile({ z: tile.z, x: tile.x, y: tile.y }, { theme: view.theme })
      .catch(() => null);
    if (!result) return null;
    const buffers = result.buffers || (result.buffer ? [result.buffer] : []);
    const images = await Promise.all(buffers.map(buf => (buf ? loadImage(buf).catch(() => null) : null)));
    if (!images[0]) return null;
    return { images, tile, providerId: result.providerId || 'osm' };
  }));

  const providers = {};
  for (const entry of loaded) if (entry) providers[entry.providerId] = (providers[entry.providerId] || 0) + 1;

  // Couche par couche : le fond de toutes les tuiles d'abord, puis les
  // étiquettes — sinon une étiquette serait masquée par la tuile voisine.
  const layerCount = Math.max(0, ...loaded.map(entry => (entry ? entry.images.length : 0)));
  for (let layer = 0; layer < layerCount; layer++) {
    for (const entry of loaded) {
      const image = entry?.images[layer];
      if (!image) continue;
      ctx.drawImage(image, entry.tile.left, entry.tile.top, entry.tile.size, entry.tile.size);
    }
  }

  const providerId = Object.keys(providers).sort((a, b) => providers[b] - providers[a])[0] || 'osm';
  const credit = tileSource.attribution(providerId);

  drawPin(ctx, width / 2, height / 2);
  drawScaleBar(ctx, view, width, height, dark);
  drawZoomBadge(ctx, view.zoom, dark);
  drawAttribution(ctx, credit, width, height, dark);

  const missing = grid.tiles.length - loaded.filter(Boolean).length;

  // Le satellite est une photo : en PNG, une seule vue pèse ~800 Ko. En JPEG, la
  // même vue tombe sous 250 Ko sans perte visible — et un clic de bouton
  // re-téléverse l'image à chaque déplacement.
  const satellite = view.theme === 'sat';
  const mime = satellite ? 'image/jpeg' : 'image/png';
  const buffer = satellite
    ? canvas.toBuffer('image/jpeg', 86)
    : canvas.toBuffer('image/png');

  return {
    buffer,
    mime,
    filename: satellite ? 'carte.jpg' : 'carte.png',
    attribution: credit,
    providerId,
    tiles: grid.tiles.length,
    missing,
  };
}

/** Le rendu est-il possible ici ? (sonde mise en cache par canvasProbe) */
async function mapCanvasReady() {
  try {
    return await canvasAvailable();
  } catch {
    return false;
  }
}

module.exports = {
  renderMap,
  mapCanvasReady,
  lightChrome,
  drawPin,
  drawScaleBar,
  drawAttribution,
  roundRect,
  PIN_COLOR,
};
