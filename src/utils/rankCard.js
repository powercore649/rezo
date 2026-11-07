// utils/rankCard.js — Carte de rang REZO, entièrement personnalisable.
//
// Tout est dessiné en canvas (@napi-rs/canvas) : fond (dégradé, uni ou image),
// anneau d'avatar (cercle, arrondi ou carré), pastille de niveau, rang, nom,
// barre de progression (dégradé, unie ou en segments) et stats optionnelles.
//
// renderRankCard(member, stats, theme) — `theme` accepte :
//   • un objet thème (voir utils/rankCardTheme.js) ;
//   • une simple couleur hex (compatibilité avec l'ancien appel `cardColor`).
// Le thème est normalisé ici, donc aucune valeur invalide ne peut casser le rendu.
const { createCanvas } = require('@napi-rs/canvas');
const { safeLoadImage } = require('./safeLoadImage');
const { normalizeTheme, normalizeHex } = require('./rankCardTheme');
const serverIdentity = require('./serverIdentity');

const W = 1000;          // largeur de la carte
const H = 300;           // hauteur de la carte
const MARGIN = 56;       // marge intérieure
const AVATAR = 148;      // taille de l'avatar
const RADIUS = 26;       // arrondi de la carte

// ─── Utilitaires de dessin ───────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function hexToRgb(hex, fallback = { r: 139, g: 26, b: 26 }) {
  const norm = normalizeHex(hex);
  if (!norm) return fallback;
  return {
    r: parseInt(norm.slice(1, 3), 16),
    g: parseInt(norm.slice(3, 5), 16),
    b: parseInt(norm.slice(5, 7), 16),
  };
}

const rgb = ({ r, g, b }) => `rgb(${r},${g},${b})`;
const rgba = ({ r, g, b }, a) => `rgba(${r},${g},${b},${a})`;
const lighten = ({ r, g, b }, f) => ({
  r: Math.min(255, Math.round(r + (255 - r) * f)),
  g: Math.min(255, Math.round(g + (255 - g) * f)),
  b: Math.min(255, Math.round(b + (255 - b) * f)),
});
const darken = ({ r, g, b }, f) => ({
  r: Math.max(0, Math.round(r * (1 - f))),
  g: Math.max(0, Math.round(g * (1 - f))),
  b: Math.max(0, Math.round(b * (1 - f))),
});

// Réduit la taille de la police jusqu'à ce que le texte tienne dans maxWidth
function fitText(ctx, text, maxWidth, startSize, weight = 'bold') {
  let size = startSize;
  ctx.font = `${weight} ${size}px Sans`;
  while (size > 12 && ctx.measureText(text).width > maxWidth) {
    size -= 1;
    ctx.font = `${weight} ${size}px Sans`;
  }
  return size;
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

// Contour d'avatar selon la forme choisie (pad > 0 = anneau autour)
function shapePath(ctx, shape, x, y, size, pad = 0) {
  const s = size + pad * 2;
  const px = x - pad;
  const py = y - pad;
  ctx.beginPath();
  if (shape === 'square') ctx.rect(px, py, s, s);
  else if (shape === 'rounded') roundRect(ctx, px, py, s, s, Math.round(size * 0.18) + pad);
  else ctx.arc(x + size / 2, y + size / 2, s / 2, 0, Math.PI * 2);
}

// Dessine l'image en « cover » (remplit la carte sans déformer)
function drawCover(ctx, img, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

async function drawAvatar(ctx, url, x, y, size, shape, colors, initial) {
  // Anneau d'accent
  ctx.save();
  const ring = ctx.createLinearGradient(x, y, x + size, y + size);
  ring.addColorStop(0, rgb(colors[0]));
  ring.addColorStop(1, rgb(colors[1]));
  shapePath(ctx, shape, x, y, size, 7);
  ctx.fillStyle = ring;
  ctx.shadowColor = rgba(colors[0], 0.5);
  ctx.shadowBlur = 26;
  ctx.fill();
  ctx.restore();

  // Disque de repli (visible si l'avatar ne se charge pas)
  ctx.save();
  shapePath(ctx, shape, x, y, size, 0);
  ctx.fillStyle = '#20223A';
  ctx.fill();
  ctx.restore();

  const img = url ? await safeLoadImage(url) : null;
  ctx.save();
  shapePath(ctx, shape, x, y, size, 0);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${Math.round(size * 0.42)}px Sans`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial, x + size / 2, y + size / 2 + 2);
  }
  ctx.restore();
}

// Barre en segments (façon MEE6)
function drawSegmentsBar(ctx, x, y, w, h, ratio, fillStyle, trackStyle) {
  const count = 30;
  const gap = 6;
  const cellW = (w - gap * (count - 1)) / count;
  const filled = Math.round(ratio * count);
  for (let i = 0; i < count; i++) {
    roundRect(ctx, x + i * (cellW + gap), y, cellW, h, 4);
    ctx.fillStyle = i < filled ? fillStyle : trackStyle;
    ctx.fill();
  }
}

// ─── Fond partagé (carte de rang + carte d'annonce de niveau) ────────────────
// Peint le fond, les halos, la bande d'accent et le cadre. Utilisé aussi par
// utils/levelUpCard.js afin que les deux cartes partagent exactement la même
// personnalisation de fond.
async function paintBackground(ctx, w, h, theme) {
  const accent = hexToRgb(theme.accentColor);
  const accentLight = lighten(accent, 0.35);
  const bg = hexToRgb(theme.bgColor, { r: 12, g: 13, b: 22 });

  ctx.save();
  roundRect(ctx, 0, 0, w, h, RADIUS);
  ctx.clip();

  if (theme.bgStyle === 'image' && theme.bgImage) {
    const img = await safeLoadImage(theme.bgImage, 6000);
    if (img) {
      ctx.fillStyle = rgb(darken(bg, 0.5));
      ctx.fillRect(0, 0, w, h);
      drawCover(ctx, img, w, h);
      if (theme.bgDim > 0) {
        ctx.fillStyle = `rgba(0,0,0,${theme.bgDim})`;
        ctx.fillRect(0, 0, w, h);
      }
      // Voile dégradé : garantit la lisibilité du texte même sur une image claire
      const veil = ctx.createLinearGradient(0, 0, w, 0);
      veil.addColorStop(0, 'rgba(0,0,0,0.55)');
      veil.addColorStop(0.65, 'rgba(0,0,0,0.18)');
      veil.addColorStop(1, 'rgba(0,0,0,0.42)');
      ctx.fillStyle = veil;
      ctx.fillRect(0, 0, w, h);
    }
  }

  if (theme.bgStyle !== 'image' || !theme.bgImage) {
    if (theme.bgStyle === 'solid') {
      ctx.fillStyle = rgb(bg);
      ctx.fillRect(0, 0, w, h);
    } else {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, rgb(darken(bg, 0.35)));
      grad.addColorStop(0.55, rgb(lighten(bg, 0.16)));
      grad.addColorStop(1, rgb(lighten(bg, 0.05)));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }

    // Halos d'accent (haut-gauche + bas-droite) : profondeur du fond
    const glow1 = ctx.createRadialGradient(120, 30, 0, 120, 30, 540);
    glow1.addColorStop(0, rgba(accent, theme.bgStyle === 'solid' ? 0.18 : 0.30));
    glow1.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, w, h);

    const glow2 = ctx.createRadialGradient(w - 70, h + 20, 0, w - 70, h + 20, 440);
    glow2.addColorStop(0, rgba(accentLight, theme.bgStyle === 'solid' ? 0.10 : 0.18));
    glow2.addColorStop(1, rgba(accentLight, 0));
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, w, h);
  }

  // Bande d'accent supérieure
  const top = ctx.createLinearGradient(0, 0, w, 0);
  top.addColorStop(0, rgb(accent));
  top.addColorStop(0.6, rgb(accentLight));
  top.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, 6);
  ctx.restore();

  // Cadre fin
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, w - 2, h - 2, RADIUS - 1);
  ctx.stroke();
}

// ─── Génération de la carte ──────────────────────────────────────────────────
async function renderRankCard(member, stats = {}, themeInput = {}) {
  const theme = normalizeTheme(typeof themeInput === 'string' ? { accentColor: themeInput } : themeInput);

  const {
    level = 0, rank = null, xpIntoLevel = 0, xpForNext = 100,
    totalXp = 0, messages = 0,
  } = stats || {};

  const accent = hexToRgb(theme.accentColor);
  const accentLight = lighten(accent, 0.35);
  const nameColor = theme.textColor;
  const nameRgb = hexToRgb(nameColor, { r: 255, g: 255, b: 255 });
  const num = n => Number(n || 0).toLocaleString('fr-FR');

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Fond (partagé avec la carte d'annonce de niveau) ─────────────────────
  await paintBackground(ctx, W, H, theme);

  // ── Avatar + pastille de niveau ─────────────────────────────────────────
  const ax = MARGIN;
  const ay = (H - AVATAR) / 2;
  const name = String(member.displayName || member.user?.username || 'Membre').trim() || 'Membre';
  const initial = (name.charAt(0) || '?').toUpperCase();

  await drawAvatar(
    ctx,
    member.displayAvatarURL?.({ extension: 'png', size: 512 }),
    ax, ay, AVATAR, theme.avatarShape,
    [accent, accentLight],
    initial,
  );

  const badgeText = `NIVEAU ${num(level)}`;
  ctx.font = 'bold 19px Sans';
  const badgeW = Math.max(104, ctx.measureText(badgeText).width + 36);
  const badgeH = 34;
  const badgeX = ax + AVATAR / 2 - badgeW / 2;
  const badgeY = ay + AVATAR - 10;

  ctx.save();
  const badgeFill = ctx.createLinearGradient(badgeX, badgeY, badgeX + badgeW, badgeY + badgeH);
  badgeFill.addColorStop(0, rgb(accent));
  badgeFill.addColorStop(1, rgb(accentLight));
  roundRect(ctx, badgeX, badgeY, badgeW, badgeH, badgeH / 2);
  ctx.fillStyle = badgeFill;
  ctx.shadowColor = rgba(accent, 0.55);
  ctx.shadowBlur = 16;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 19px Sans';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 1);
  ctx.restore();

  // ── Bloc texte ──────────────────────────────────────────────────────────
  const tx = ax + AVATAR + 40;
  const right = W - MARGIN;
  const maxTextW = right - tx;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Pastille de rang
  if (theme.showRank && rank) {
    const rankText = `RANG #${num(rank)}`;
    ctx.font = 'bold 18px Sans';
    const rw = ctx.measureText(rankText).width + 34;
    const rh = 38;
    const rx = right - rw;
    const ry = ay;

    ctx.save();
    roundRect(ctx, rx, ry, rw, rh, rh / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fill();
    ctx.strokeStyle = rgba(accent, 0.65);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = rgb(accentLight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(rankText, rx + rw / 2, ry + rh / 2 + 1);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // Nom
  const reserveRight = theme.showRank && rank ? 170 : 0;
  const nameSize = fitText(ctx, name, maxTextW - reserveRight, 40);
  ctx.fillStyle = nameColor;
  ctx.fillText(ellipsize(ctx, name, maxTextW - reserveRight), tx, ay + 34);

  // Sous-titre : messages et/ou XP total
  const subtitle = [
    theme.showMessages ? `${num(messages)} messages` : null,
    theme.showTotalXp ? `${num(totalXp)} XP au total` : null,
  ].filter(Boolean).join('  ·  ');

  if (subtitle) {
    ctx.font = '19px Sans';
    ctx.fillStyle = rgba(nameRgb, 0.55);
    ctx.fillText(subtitle, tx, ay + 66);
  }

  // ── Barre de progression ────────────────────────────────────────────────
  const ratio = xpForNext > 0 ? Math.max(0, Math.min(1, xpIntoLevel / xpForNext)) : 0;
  const barX = tx;
  const barW = maxTextW;
  const barH = 26;
  const barY = H - 84;

  ctx.font = 'bold 18px Sans';
  ctx.textAlign = 'right';
  ctx.fillStyle = rgb(accentLight);
  ctx.fillText(`${Math.floor(ratio * 100)}%`, right, barY - 12);
  ctx.textAlign = 'left';

  const trackStyle = 'rgba(255,255,255,0.08)';

  if (theme.barStyle === 'segments') {
    drawSegmentsBar(ctx, barX, barY, barW, barH, ratio, rgb(accent), trackStyle);
  } else {
    ctx.fillStyle = trackStyle;
    roundRect(ctx, barX, barY, barW, barH, barH / 2);
    ctx.fill();

    if (ratio > 0) {
      const fillW = Math.max(barH, barW * ratio);
      ctx.save();
      roundRect(ctx, barX, barY, fillW, barH, barH / 2);
      ctx.fillStyle = theme.barStyle === 'solid'
        ? rgb(accent)
        : (() => {
          const fill = ctx.createLinearGradient(barX, 0, barX + barW, 0);
          fill.addColorStop(0, rgb(accent));
          fill.addColorStop(1, rgb(accentLight));
          return fill;
        })();
      ctx.shadowColor = rgba(accent, 0.6);
      ctx.shadowBlur = 18;
      ctx.fill();
      ctx.restore();

      // Reflet lumineux sur la moitié haute
      ctx.save();
      roundRect(ctx, barX, barY, fillW, barH, barH / 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(barX, barY, fillW, barH / 2);
      ctx.restore();
    }
  }

  // ── Statistiques sous la barre ──────────────────────────────────────────
  const remaining = Math.max(0, xpForNext - xpIntoLevel);

  ctx.font = '17px Sans';
  ctx.fillStyle = rgba(nameRgb, 0.62);
  ctx.fillText(`${num(xpIntoLevel)} / ${num(xpForNext)} XP`, barX, H - 28);

  ctx.textAlign = 'right';
  ctx.fillStyle = rgba(nameRgb, 0.45);
  ctx.fillText(`${num(remaining)} XP avant le niveau ${num(level + 1)}`, right, H - 28);
  ctx.textAlign = 'left';

  if (theme.showFooter) {
    ctx.fillStyle = rgba(nameRgb, 0.18);
    ctx.font = 'bold 14px Sans';
    ctx.fillText(serverIdentity.nameFor(serverIdentity.currentIdentity(), 20), MARGIN, H - 14);
  }

  return canvas.toBuffer('image/png');
}

module.exports = {
  renderRankCard,
  CARD_SIZE: { W, H },
  // Helpers de dessin partagés avec utils/levelUpCard.js (carte d'annonce de
  // niveau) : un seul endroit à corriger si un tracé doit évoluer.
  helpers: {
    roundRect, hexToRgb, rgb, rgba, lighten, darken, fitText, ellipsize,
    shapePath, drawCover, drawAvatar, drawSegmentsBar, paintBackground,
    MARGIN, RADIUS,
  },
};
