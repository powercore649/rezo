// utils/territoryMap.js — Génération de la carte de guerre des territoires (canvas)
const { createCanvas } = require('@napi-rs/canvas');

const GRID_COLS = 6;
const GRID_ROWS = 5;

const ZONE_NAMES = [
  'Forêt Boréale','Crête Glacée','Vallée Ardente','Plaine Dorée','Marais Sombre','Pic Tempête',
  'Désert Cramoisi','Côte Brisée','Ravin Profond','Toundra Grise','Oasis Mirage','Sommet Céleste',
  'Bois Murmurant','Lac Spectral','Canyon Écho','Prairie Sauvage','Falaise Noire','Delta Brumeux',
  'Steppe Ardente','Grotte Cristal','Île Perdue','Volcan Dormant','Jungle Émeraude','Banquise Royale',
  'Cratère Lunaire','Vallon Doré','Mont Sacré','Récif Corail','Dune Écarlate','Terre Brûlée',
];

// Couleurs par "tier" de zone
const TIER_COLORS = {
  1: '#3b4252', // commun — gris bleu
  2: '#5865F2', // rare — violet bleu
  3: '#FFD700', // légendaire — or
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

// Génère un nom unique de zone ID (A1, A2, ..., F5)
function getAllZoneIds() {
  const ids = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      ids.push(String.fromCharCode(65 + c) + (r + 1));
    }
  }
  return ids;
}

// Couleur déterministe par guildId (pour distinguer visuellement les propriétaires)
function colorForGuild(guildId) {
  let hash = 0;
  for (let i = 0; i < guildId.length; i++) hash = guildId.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 50%)`;
}

async function generateMapImage(territories) {
  const cellW = 130, cellH = 100, pad = 24, headerH = 50;
  const W = GRID_COLS * cellW + pad * 2;
  const H = GRID_ROWS * cellH + pad * 2 + headerH;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Fond
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0d1117'); bg.addColorStop(1, '#1a1b2e');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // Titre
  ctx.fillStyle = '#fff'; ctx.font = 'bold 24px Sans'; ctx.textAlign = 'center';
  ctx.fillText('Carte des Territoires REZO', W / 2, 34);
  ctx.textAlign = 'left';

  const byId = {};
  territories.forEach(t => byId[t.zoneId] = t);

  let i = 0;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const zoneId = String.fromCharCode(65 + c) + (r + 1);
      const t = byId[zoneId];
      const x = pad + c * cellW;
      const y = pad + headerH + r * cellH;
      const w = cellW - 6, h = cellH - 6;

      const owned = !!t?.ownerGuildId;
      const fillColor = owned ? colorForGuild(t.ownerGuildId) : 'rgba(255,255,255,0.04)';

      ctx.fillStyle = fillColor;
      roundRect(ctx, x, y, w, h, 8); ctx.fill();

      // Bordure selon tier
      ctx.strokeStyle = TIER_COLORS[t?.tier || 1];
      ctx.lineWidth = t?.tier === 3 ? 3 : 1.5;
      roundRect(ctx, x, y, w, h, 8); ctx.stroke();

      // Tier indicator (étoile pour légendaire)
      if (t?.tier === 3) {
        ctx.fillStyle = '#FFD700'; ctx.font = '14px Sans';
        ctx.fillText('⭐', x + w - 22, y + 18);
      } else if (t?.tier === 2) {
        ctx.fillStyle = '#5865F2'; ctx.font = '14px Sans';
        ctx.fillText('◆', x + w - 18, y + 18);
      }

      // ID de la zone
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px Sans';
      ctx.fillText(zoneId, x + 6, y + 14);

      // Nom de la zone (tronqué)
      ctx.fillStyle = owned ? '#fff' : '#888';
      ctx.font = 'bold 11px Sans';
      const name = t?.name || '???';
      ctx.fillText(name.length > 14 ? name.slice(0, 13) + '…' : name, x + 6, y + h - 28);

      // Owner ou "Libre"
      ctx.font = '10px Sans';
      ctx.fillStyle = owned ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)';
      const ownerText = owned ? (t.ownerName || 'Inconnu').slice(0, 16) : 'Territoire libre';
      ctx.fillText(ownerText, x + 6, y + h - 14);

      // Power bar
      if (owned && t.power > 0) {
        const maxPower = 500;
        const pct = Math.min(t.power / maxPower, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        roundRect(ctx, x + 6, y + h - 8, w - 12, 4, 2); ctx.fill();
        ctx.fillStyle = '#57F287';
        roundRect(ctx, x + 6, y + h - 8, (w - 12) * pct, 4, 2); ctx.fill();
      }

      i++;
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = { generateMapImage, getAllZoneIds, ZONE_NAMES, colorForGuild, GRID_COLS, GRID_ROWS };
