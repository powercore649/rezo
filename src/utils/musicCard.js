'use strict';
// utils/musicCard.js — Carte « en cours de lecture » du module musique.
//
// Rendu canvas 1280 × 440, sans emoji (les polices emoji ne sont pas garanties
// sur toutes les machines, cf. les autres cartes du bot) :
//   • pochette + fond dérivé de la pochette ;
//   • titre, artiste, source, demandeur ;
//   • barre de progression avec temps écoulé / total ;
//   • pastilles boucle / mélange / volume / file.
//
// `renderMusicCard` ne dépend ni de Discord ni du moteur : on lui passe un
// instantané, elle rend un PNG. Les images (pochette, avatar) sont mises en
// cache quelques minutes : la carte est réaffichée toutes les 20 s et il serait
// absurde de retélécharger la même pochette à chaque fois.

const { createCanvas } = require('@napi-rs/canvas');
const { helpers } = require('./rankCard');
const { safeLoadImage } = require('./safeLoadImage');
const { formatTime } = require('./musicQueue');
const { sourceLabel } = require('./mediaTools');

const { roundRect, hexToRgb, rgb, rgba, lighten, darken, ellipsize } = helpers;

const W = 1280;
const H = 440;

const WINE = { r: 139, g: 26, b: 26 };
const GOLD = { r: 212, g: 175, b: 55 };

const SOURCE_COLOR = {
  youtube: { r: 226, g: 62, b: 62 },
  soundcloud: { r: 240, g: 110, b: 40 },
  spotify: { r: 30, g: 200, b: 110 },
  bandcamp: { r: 40, g: 170, b: 190 },
  other: { r: 150, g: 150, b: 170 },
};

// ─── Cache d'images (5 min, 40 entrées) ──────────────────────────────────────
const imageCache = new Map();
const IMAGE_TTL = 5 * 60 * 1000;
const IMAGE_MAX = 40;

async function cachedImage(url) {
  if (!url) return null;
  const now = Date.now();
  const hit = imageCache.get(url);
  if (hit && hit.expires > now) return hit.image;

  const image = await safeLoadImage(url);
  if (image) {
    if (imageCache.size >= IMAGE_MAX) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(url, { image, expires: now + IMAGE_TTL });
  }
  return image;
}

function clearImageCache() { imageCache.clear(); }

// ─── Icônes dessinées ───────────────────────────────────────────────────────
function drawLoopIcon(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.62, -0.35 * Math.PI, 1.25 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + size * 0.42, cy - size * 0.7);
  ctx.lineTo(cx + size * 0.78, cy - size * 0.42);
  ctx.lineTo(cx + size * 0.36, cy - size * 0.22);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawShuffleIcon(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.8, cy - size * 0.45);
  ctx.lineTo(cx + size * 0.35, cy + size * 0.45);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.8, cy + size * 0.45);
  ctx.lineTo(cx + size * 0.35, cy - size * 0.45);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + size * 0.3, cy + size * 0.45);
  ctx.lineTo(cx + size * 0.72, cy + size * 0.45);
  ctx.lineTo(cx + size * 0.56, cy + size * 0.18);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawVolumeIcon(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.75, cy - size * 0.3);
  ctx.lineTo(cx - size * 0.35, cy - size * 0.3);
  ctx.lineTo(cx + size * 0.05, cy - size * 0.68);
  ctx.lineTo(cx + size * 0.05, cy + size * 0.68);
  ctx.lineTo(cx - size * 0.35, cy + size * 0.3);
  ctx.lineTo(cx - size * 0.75, cy + size * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + size * 0.12, cy, size * 0.45, -0.5 * Math.PI, 0.5 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + size * 0.12, cy, size * 0.78, -0.42 * Math.PI, 0.42 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

function drawQueueIcon(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i += 1) {
    const y = cy - size * 0.6 + i * size * 0.6;
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.8, y);
    ctx.lineTo(cx + size * 0.55, y);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(cx + size * 0.72, cy, size * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawNote(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.1;
  ctx.beginPath();
  ctx.arc(cx - size * 0.18, cy + size * 0.5, size * 0.26, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + size * 0.62, cy + size * 0.36, size * 0.26, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + size * 0.08, cy + size * 0.48);
  ctx.lineTo(cx + size * 0.08, cy - size * 0.55);
  ctx.lineTo(cx + size * 0.88, cy - size * 0.72);
  ctx.lineTo(cx + size * 0.88, cy + size * 0.32);
  ctx.stroke();
  ctx.restore();
}

function drawChip(ctx, x, y, { icon, label, active = false, accent = GOLD }) {
  ctx.font = 'bold 16px Sans';
  const textWidth = ctx.measureText(label).width;
  const width = 52 + textWidth;
  const height = 40;

  ctx.save();
  ctx.fillStyle = active ? rgba(accent, 0.16) : 'rgba(255,255,255,0.05)';
  roundRect(ctx, x, y, width, height, 12);
  ctx.fill();
  ctx.strokeStyle = active ? rgba(accent, 0.5) : 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, width, height, 12);
  ctx.stroke();

  icon(ctx, x + 24, y + height / 2, 9, active ? rgb(accent) : 'rgba(255,255,255,0.55)');
  ctx.fillStyle = active ? '#fff' : 'rgba(255,255,255,0.66)';
  ctx.font = 'bold 16px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 42, y + height / 2 + 6);
  ctx.restore();

  return width;
}

/**
 * @param {object} snapshot
 * @param {object|null} snapshot.track           morceau en cours
 * @param {number} snapshot.position             secondes écoulées
 * @param {number} snapshot.volume               0-200
 * @param {boolean} snapshot.paused
 * @param {'off'|'track'|'queue'} snapshot.loop
 * @param {number} snapshot.queueLength
 * @param {boolean} snapshot.autoplay
 * @param {object|null} snapshot.requester      { displayName, avatarUrl }
 * @returns {Promise<Buffer>}
 */
async function renderMusicCard(snapshot = {}) {
  const track = snapshot.track || {};
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const source = track.source || 'other';
  const accent = SOURCE_COLOR[source] || SOURCE_COLOR.other;
  const accentMain = source === 'youtube' ? WINE : accent;

  // ── Fond ────────────────────────────────────────────────────────────────
  ctx.fillStyle = '#0b0c14';
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  const cover = await cachedImage(track.thumbnail);
  if (cover) {
    ctx.save();
    roundRect(ctx, 0, 0, W, H, 28);
    ctx.clip();
    ctx.globalAlpha = 0.32;
    // Remplissage « cover » sur toute la carte, volontairement débordant.
    const scale = Math.max(W / cover.width, H / cover.height) * 1.5;
    const dw = cover.width * scale;
    const dh = cover.height * scale;
    ctx.drawImage(cover, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();
  }

  const shade = ctx.createLinearGradient(0, 0, W, 0);
  shade.addColorStop(0, 'rgba(11,12,20,0.86)');
  shade.addColorStop(0.55, 'rgba(11,12,20,0.94)');
  shade.addColorStop(1, 'rgba(11,12,20,0.99)');
  ctx.save();
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.clip();
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);

  // Halo coloré dérivé de la source
  const halo = ctx.createRadialGradient(150, 120, 0, 150, 120, 420);
  halo.addColorStop(0, rgba(accentMain, 0.28));
  halo.addColorStop(1, rgba(accentMain, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // Bande d'accent supérieure
  const top = ctx.createLinearGradient(0, 0, W * 0.7, 0);
  top.addColorStop(0, rgb(accentMain));
  top.addColorStop(0.55, rgba(accentMain, 0.45));
  top.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = top;
  roundRect(ctx, 0, 0, W, 6, 3);
  ctx.fill();

  // ── Pochette ────────────────────────────────────────────────────────────
  const size = 248;
  const coverX = 60;
  const coverY = 96;

  ctx.save();
  ctx.shadowColor = rgba(accentMain, 0.55);
  ctx.shadowBlur = 40;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  roundRect(ctx, coverX - 3, coverY - 3, size + 6, size + 6, 26);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, coverX, coverY, size, size, 24);
  ctx.clip();
  if (cover) {
    const scale = Math.max(size / cover.width, size / cover.height);
    const dw = cover.width * scale;
    const dh = cover.height * scale;
    ctx.drawImage(cover, coverX + (size - dw) / 2, coverY + (size - dh) / 2, dw, dh);
  } else {
    const fallback = ctx.createLinearGradient(coverX, coverY, coverX + size, coverY + size);
    fallback.addColorStop(0, rgb(darken(accentMain, 0.15)));
    fallback.addColorStop(1, '#14101c');
    ctx.fillStyle = fallback;
    ctx.fillRect(coverX, coverY, size, size);
    drawNote(ctx, coverX + size / 2, coverY + size / 2, 60, 'rgba(255,255,255,0.35)');
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 2;
  roundRect(ctx, coverX, coverY, size, size, 24);
  ctx.stroke();
  ctx.restore();

  // Badge LIVE sur la pochette
  if (track.live) {
    ctx.save();
    ctx.fillStyle = 'rgba(226,62,62,0.92)';
    roundRect(ctx, coverX + 16, coverY + size - 52, 76, 34, 10);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Sans';
    ctx.textAlign = 'center';
    ctx.fillText('LIVE', coverX + 54, coverY + size - 29);
    ctx.restore();
  }

  // ── Colonne de droite ───────────────────────────────────────────────────
  const x = 350;
  const maxText = W - x - 56;

  // Pastille source
  const sourceText = sourceLabel(source).toUpperCase();
  ctx.font = 'bold 13px Sans';
  const sourceWidth = ctx.measureText(sourceText).width + 30;
  ctx.save();
  ctx.fillStyle = rgba(accent, 0.18);
  roundRect(ctx, x, 78, sourceWidth, 28, 14);
  ctx.fill();
  ctx.fillStyle = rgb(lighten(accent, 0.35));
  ctx.font = 'bold 13px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(sourceText, x + 15, 97);
  ctx.restore();

  // Titre
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 40px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(ellipsize(ctx, String(track.title || 'Rien en lecture'), maxText), x, 156);
  ctx.restore();

  // Artiste
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.58)';
  ctx.font = '22px Sans';
  ctx.fillText(ellipsize(ctx, String(track.artist || '—'), maxText - 60), x, 194);
  ctx.restore();

  // Demandeur
  const requester = snapshot.requester;
  if (requester?.displayName) {
    let avatarX = x;
    if (requester.avatarUrl) {
      const avatar = await cachedImage(requester.avatarUrl);
      if (avatar) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + 17, 234, 17, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(avatar, avatarX, 217, 34, 34);
        ctx.restore();
        avatarX += 44;
      }
    }
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.44)';
    ctx.font = '16px Sans';
    ctx.textAlign = 'left';
    ctx.fillText(`Demandé par ${ellipsize(ctx, requester.displayName, 260)}`, avatarX, 240);
    ctx.restore();
  }

  // ── Progression ─────────────────────────────────────────────────────────
  const duration = Math.max(0, Number(track.duration) || 0);
  const position = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(snapshot.position) || 0));
  const ratio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  const barX = x;
  const barY = 300;
  const barW = maxText;
  const barH = 10;

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  roundRect(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fill();

  if (ratio > 0) {
    const fill = ctx.createLinearGradient(barX, 0, barX + barW, 0);
    fill.addColorStop(0, rgb(accentMain));
    fill.addColorStop(1, rgb(lighten(accentMain, 0.35)));
    roundRect(ctx, barX, barY, Math.max(barH, barW * ratio), barH, barH / 2);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(barX + barW * ratio, barY + barH / 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = rgba(accentMain, 0.85);
    ctx.shadowBlur = 16;
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.font = 'bold 16px Sans';
  ctx.textAlign = 'left';
  ctx.fillText(track.live ? 'EN DIRECT' : formatTime(position), barX, barY + 36);
  ctx.textAlign = 'right';
  ctx.fillText(duration > 0 ? formatTime(duration) : (track.live ? '∞' : '--:--'), barX + barW, barY + 36);
  ctx.restore();

  // ── Pastilles du bas ────────────────────────────────────────────────────
  let chipX = x;
  const chipY = 362;

  chipX += drawChip(ctx, chipX, chipY, {
    icon: drawLoopIcon,
    label: snapshot.loop === 'off' ? 'Boucle off' : `Boucle ${snapshot.loop === 'track' ? 'morceau' : 'file'}`,
    active: snapshot.loop !== 'off',
    accent: GOLD,
  }) + 12;

  chipX += drawChip(ctx, chipX, chipY, {
    icon: drawShuffleIcon,
    label: snapshot.autoplay ? 'Autoplay' : 'Mélange',
    active: Boolean(snapshot.autoplay),
    accent: GOLD,
  }) + 12;

  chipX += drawChip(ctx, chipX, chipY, {
    icon: drawVolumeIcon,
    label: `${Math.round(Number(snapshot.volume) || 0)} %`,
    active: Number(snapshot.volume) !== 100,
    accent: { r: 120, g: 180, b: 255 },
  }) + 12;

  drawChip(ctx, chipX, chipY, {
    icon: drawQueueIcon,
    label: `${Math.max(0, Number(snapshot.queueLength) || 0)} en file`,
    active: Number(snapshot.queueLength) > 0,
    accent: { r: 120, g: 220, b: 170 },
  });

  // Badge PAUSE
  if (snapshot.paused) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, coverX + size / 2 - 34, coverY + size / 2 - 34, 68, 68, 34);
    ctx.fill();
    ctx.fillStyle = '#fff';
    roundRect(ctx, coverX + size / 2 - 17, coverY + size / 2 - 21, 12, 42, 4);
    ctx.fill();
    roundRect(ctx, coverX + size / 2 + 5, coverY + size / 2 - 21, 12, 42, 4);
    ctx.fill();
    ctx.restore();
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  renderMusicCard,
  clearImageCache,
  CARD_SIZE: { W, H },
  SOURCE_COLOR,
};
