// utils/voiceCard.js — Carte de statistiques vocales (canvas), design pro sans emoji
const { createCanvas } = require('@napi-rs/canvas');
const { safeLoadImage } = require('./safeLoadImage');

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '8B1A1A');
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 139, g: 26, b: 26 };
}

// ─── Icônes vectorielles (aucune dépendance à une police emoji) ──────────────
function drawClockIcon(ctx, cx, cy, size, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, size, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - size * 0.55);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + size * 0.4, cy + size * 0.15);
  ctx.stroke();
}

function drawLayersIcon(ctx, cx, cy, size, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  const w = size * 1.5, h = size * 0.8;
  [-0.45, 0, 0.45].forEach((off) => {
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy + off * h - h / 2 + h / 2);
    ctx.lineTo(cx, cy + off * h - h / 4);
    ctx.lineTo(cx + w / 2, cy + off * h - h / 2 + h / 2);
    ctx.lineTo(cx, cy + off * h + h / 4);
    ctx.closePath();
    ctx.stroke();
  });
}

function drawBarsIcon(ctx, cx, cy, size, color) {
  ctx.fillStyle = color;
  const heights = [0.5, 1, 0.7];
  const barW = size * 0.36, gap = size * 0.18;
  const totalW = barW * 3 + gap * 2;
  let x = cx - totalW / 2;
  for (const hRatio of heights) {
    const h = size * 1.6 * hRatio;
    roundRect(ctx, x, cy + size * 0.8 - h, barW, h, barW * 0.3);
    ctx.fill();
    x += barW + gap;
  }
}

function drawMicIcon(ctx, cx, cy, size, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  roundRect(ctx, cx - size * 0.3, cy - size, size * 0.6, size * 1.15, size * 0.3);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.1, size * 0.65, 0.15 * Math.PI, 0.85 * Math.PI, false);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy + size * 0.5);
  ctx.lineTo(cx, cy + size * 0.85);
  ctx.moveTo(cx - size * 0.35, cy + size * 0.85);
  ctx.lineTo(cx + size * 0.35, cy + size * 0.85);
  ctx.stroke();
}

function drawStatChip(ctx, x, y, w, h, { icon, value, label, accent }) {
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 16);
  ctx.stroke();

  const iconCx = x + 34, iconCy = y + h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(iconCx, iconCy, 20, 0, Math.PI * 2);
  ctx.fillStyle = `${accent}26`; // ~15% opacity accent circle backdrop
  ctx.fill();
  ctx.restore();
  icon(ctx, iconCx, iconCy, 9, accent);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(value, x + 62, y + h / 2 - 2);

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '13px Sans';
  ctx.fillText(label, x + 62, y + h / 2 + 18);
}

/**
 * Génère la carte de statistiques vocales.
 * @param {GuildMember} member
 * @param {{ liveSeconds:number, sessions:number, rank:number, totalTracked:number, topSeconds:number, active:boolean }} data
 * @param {string} accentColor hex
 */
async function generateVoiceCard(member, data, accentColor = '#8B1A1A') {
  const W = 1000, H = 360;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const { r, g, b } = hexToRgb(accentColor);
  const accent = `rgb(${r},${g},${b})`;

  // Fond
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0c0d16');
  bg.addColorStop(0.55, '#12131f');
  bg.addColorStop(1, '#161326');
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, W, H, 26);
  ctx.fill();

  // Lueur radiale discrète derrière l'avatar (centrée exactement sur l'avatar)
  const aSize = 128, aX = 56, aY = 66;
  const glowCx = aX + aSize / 2, glowCy = aY + aSize / 2;
  const glow = ctx.createRadialGradient(glowCx, glowCy, 10, glowCx, glowCy, 220);
  glow.addColorStop(0, `rgba(${r},${g},${b},0.18)`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Bande d'accent en haut
  const top = ctx.createLinearGradient(0, 0, W, 0);
  top.addColorStop(0, accent);
  top.addColorStop(1, `rgba(${r},${g},${b},0.25)`);
  ctx.fillStyle = top;
  roundRect(ctx, 0, 0, W, 5, 2.5);
  ctx.fill();

  // Avatar
  ctx.save();
  ctx.shadowColor = `rgba(${r},${g},${b},0.5)`;
  ctx.shadowBlur = 28;
  ctx.beginPath();
  ctx.arc(aX + aSize / 2, aY + aSize / 2, aSize / 2 + 4, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(aX + aSize / 2, aY + aSize / 2, aSize / 2, 0, Math.PI * 2);
  ctx.clip();
  const avatar = await safeLoadImage(member.displayAvatarURL({ extension: 'png', size: 256 }));
  if (avatar) ctx.drawImage(avatar, aX, aY, aSize, aSize);
  else { ctx.fillStyle = accent; ctx.fillRect(aX, aY, aSize, aSize); }
  ctx.restore();

  // Pastille de statut (en/hors vocal) — dessinée, pas d'emoji
  const dotR = 13;
  const dotX = aX + aSize - 8, dotY = aY + aSize - 8;
  ctx.beginPath();
  ctx.arc(dotX, dotY, dotR + 4, 0, Math.PI * 2);
  ctx.fillStyle = '#12131f';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
  ctx.fillStyle = data.active ? '#3BA55D' : '#4f4f5a';
  ctx.fill();

  // Nom + sous-titre
  const tX = aX + aSize + 40;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 34px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(member.displayName.slice(0, 22), tX, 108);

  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '16px Sans';
  ctx.fillText(data.active ? 'Actuellement en vocal' : 'Statistiques vocales', tX, 134);

  // Pastille de rang (haut droite)
  const rankLabel = `#${data.rank}`;
  ctx.font = 'bold 22px Sans';
  const rankW = ctx.measureText(rankLabel).width;
  const pillW = rankW + 78, pillH = 46, pillX = W - 56 - pillW, pillY = 56;
  const pillGrad = ctx.createLinearGradient(pillX, 0, pillX + pillW, 0);
  pillGrad.addColorStop(0, accent);
  pillGrad.addColorStop(1, `rgba(${r},${g},${b},0.7)`);
  ctx.fillStyle = pillGrad;
  roundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(rankLabel, pillX + 22, pillY + 30);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '14px Sans';
  ctx.fillText(`/ ${data.totalTracked}`, pillX + 22 + rankW + 8, pillY + 30);

  // Chips de statistiques
  const chipY = 216, chipH = 92, gap = 20;
  const chipW = (W - 56 * 2 - gap * 2) / 3;
  const avgSeconds = data.sessions > 0 ? Math.round(data.liveSeconds / data.sessions) : 0;

  drawStatChip(ctx, 56, chipY, chipW, chipH, {
    icon: drawClockIcon, accent, value: formatDurationShort(data.liveSeconds), label: 'Temps total',
  });
  drawStatChip(ctx, 56 + chipW + gap, chipY, chipW, chipH, {
    icon: drawLayersIcon, accent, value: `${data.sessions}`, label: 'Sessions',
  });
  drawStatChip(ctx, 56 + (chipW + gap) * 2, chipY, chipW, chipH, {
    icon: drawBarsIcon, accent, value: formatDurationShort(avgSeconds), label: 'Moyenne / session',
  });

  return canvas.toBuffer('image/png');
}

function formatDurationShort(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

module.exports = { generateVoiceCard };
