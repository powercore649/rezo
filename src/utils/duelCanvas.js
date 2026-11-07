// utils/duelCanvas.js — Rendu visuel de l'arène de duel (canvas)
const { createCanvas } = require('@napi-rs/canvas');
const { safeLoadImage } = require('./safeLoadImage');

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

function healthColor(pct) {
  if (pct > 0.6) return '#57F287';
  if (pct > 0.3) return '#FEE75C';
  return '#ED4245';
}

async function generateDuelImage(p1, p2, hp1, hp2, lastAction = null, shake = null) {
  const W = 800, H = 320;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Fond arène
  const bg = ctx.createRadialGradient(W/2, H/2, 50, W/2, H/2, 500);
  bg.addColorStop(0, '#1a1b2e'); bg.addColorStop(1, '#0a0a14');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // Sol arène (ellipse)
  ctx.save();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#8B1A1A';
  ctx.beginPath();
  ctx.ellipse(W/2, H - 30, 340, 35, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // VS texte central
  ctx.font = 'bold 38px Sans'; ctx.textAlign = 'center';
  const vsGrad = ctx.createLinearGradient(W/2-30, 0, W/2+30, 0);
  vsGrad.addColorStop(0, '#ED4245'); vsGrad.addColorStop(1, '#8B1A1A');
  ctx.fillStyle = vsGrad;
  ctx.fillText('VS', W/2, 50);
  ctx.textAlign = 'left';

  // ── Joueur 1 (gauche) ──────────────────────────────────────────────────
  await drawFighter(ctx, p1, hp1, 40, 70, false, lastAction === 'p1');
  // ── Joueur 2 (droite) ──────────────────────────────────────────────────
  await drawFighter(ctx, p2, hp2, W - 280, 70, true, lastAction === 'p2');

  // Action text en bas
  if (lastAction) {
    ctx.textAlign = 'center'; ctx.font = 'italic 16px Sans';
    ctx.fillStyle = '#B9BBBE';
    ctx.fillText(lastAction === 'finished' ? '🏆 Combat terminé !' : '⚔️ Échange de coups...', W/2, H - 12);
    ctx.textAlign = 'left';
  }

  return canvas.toBuffer('image/png');
}

async function drawFighter(ctx, user, hp, x, y, flip, hit) {
  const aSize = 100;
  const aX = flip ? x + 140 : x;
  const aY = y;

  // Effet "hit" flash
  if (hit) {
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#ED4245';
    ctx.beginPath(); ctx.arc(aX + aSize/2, aY + aSize/2, aSize/2 + 20, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Cercle avatar
  ctx.save();
  ctx.beginPath();
  ctx.arc(aX + aSize/2, aY + aSize/2, aSize/2 + 4, 0, Math.PI * 2);
  const ring = ctx.createLinearGradient(aX, aY, aX + aSize, aY + aSize);
  ring.addColorStop(0, hit ? '#ED4245' : '#5865F2');
  ring.addColorStop(1, '#57F287');
  ctx.fillStyle = ring; ctx.fill(); ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(aX + aSize/2, aY + aSize/2, aSize/2, 0, Math.PI * 2);
  ctx.clip();
  const img = await safeLoadImage(user.displayAvatarURL({ extension: 'png', size: 128 }));
  if (img) {
    ctx.drawImage(img, aX, aY, aSize, aSize);
  } else {
    ctx.fillStyle = '#8B1A1A'; ctx.fillRect(aX, aY, aSize, aSize);
  }
  ctx.restore();

  // Nom
  const textX = flip ? x : x;
  const textY = y + aSize + 28;
  ctx.fillStyle = '#fff'; ctx.font = 'bold 18px Sans'; ctx.textAlign = flip ? 'right' : 'left';
  ctx.fillText(user.username.slice(0, 16), flip ? x + 240 : x, textY);

  // Barre de vie
  const barW = 240, barH = 20;
  const barX = x;
  const barY = textY + 10;
  const pct = Math.max(0, hp / 100);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#2C2F33';
  roundRect(ctx, barX, barY, barW, barH, 10); ctx.fill();

  if (pct > 0) {
    ctx.fillStyle = healthColor(pct);
    roundRect(ctx, barX, barY, barW * pct, barH, 10); ctx.fill();
  }

  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px Sans'; ctx.textAlign = 'center';
  ctx.fillText(`${Math.max(0, Math.round(hp))} / 100 PV`, barX + barW/2, barY + 14);
  ctx.textAlign = 'left';
}

module.exports = { generateDuelImage };
