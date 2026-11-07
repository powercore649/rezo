// utils/levelUpCard.js — Carte de l'annonce de niveau (montée de niveau).
//
// Même personnalisation que la carte de rang (fond, accent, texte, barre,
// avatar, éléments affichés) mais une mise en page de FÉLICITATION : un grand
// titre (défaut « NIVEAU 12 »), un sous-titre (défaut « Félicitations Alice ! »)
// et la progression vers le niveau suivant.
//
// renderLevelUpCard(member, stats, theme, texts)
//   • theme : thème résolu (voir utils/levelUpCardTheme.js) ou simple hex ;
//   • texts : { title, subtitle, vars } — les variables {user} {level} {rank}
//     {server} {messages} {xp} sont remplacées ici, avant le dessin.
// Le thème est normalisé à l'entrée : aucune valeur invalide ne casse le rendu.
const { createCanvas } = require('@napi-rs/canvas');
const { normalizeTheme } = require('./rankCardTheme');
const { fillLevelUpText, TEXT_DEFAULTS } = require('./levelUpCardTheme');
const { helpers } = require('./rankCard');

const W = 1000;      // largeur de la carte
const H = 340;       // hauteur de la carte
const AVATAR = 148;  // avatar (comme la carte de rang)
const CHIP_H = 38;   // pastille de rang

const {
  MARGIN, roundRect, hexToRgb, rgb, rgba, lighten,
  fitText, ellipsize, drawAvatar, drawSegmentsBar, paintBackground,
} = helpers;

function num(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

async function renderLevelUpCard(member, stats = {}, themeInput = {}, texts = {}) {
  const theme = normalizeTheme(typeof themeInput === 'string' ? { accentColor: themeInput } : themeInput);

  const {
    level = 0, rank = null, xpIntoLevel = 0, xpForNext = 100,
    totalXp = 0, messages = 0,
  } = stats || {};

  const name = String(member?.displayName || member?.user?.username || 'Membre').trim() || 'Membre';

  const vars = {
    user: name,
    level,
    rank,
    messages,
    totalXp,
    ...(texts.vars || {}),
  };
  const title = fillLevelUpText(texts.title ?? TEXT_DEFAULTS.title, vars);
  const subtitle = fillLevelUpText(texts.subtitle ?? TEXT_DEFAULTS.subtitle, vars);

  const accent = hexToRgb(theme.accentColor);
  const accentLight = lighten(accent, 0.35);
  const textRgb = hexToRgb(theme.textColor, { r: 255, g: 255, b: 255 });

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Fond + cadre (identique à la carte de rang) ───────────────────────────
  await paintBackground(ctx, W, H, theme);

  const ax = MARGIN;
  const ay = Math.round((H - AVATAR) / 2);
  const tx = ax + AVATAR + 40;
  const right = W - MARGIN;

  // ── Avatar ────────────────────────────────────────────────────────────────
  await drawAvatar(
    ctx,
    member?.displayAvatarURL?.({ extension: 'png', size: 512 }),
    ax, ay, AVATAR, theme.avatarShape,
    [accent, accentLight],
    (name.charAt(0) || '?').toUpperCase(),
  );

  // ── Pastille de rang (haut droite) ────────────────────────────────────────
  let reserveRight = 0;
  if (theme.showRank && rank) {
    const rankText = `RANG #${num(rank)}`;
    ctx.font = 'bold 18px Sans';
    const chipW = ctx.measureText(rankText).width + 34;
    const chipX = right - chipW;
    const chipY = 46;

    ctx.save();
    roundRect(ctx, chipX, chipY, chipW, CHIP_H, CHIP_H / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fill();
    ctx.strokeStyle = rgba(accent, 0.65);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = rgb(accentLight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(rankText, chipX + chipW / 2, chipY + CHIP_H / 2 + 1);
    ctx.restore();

    reserveRight = chipW + 24;
  }

  // ── Grand titre ───────────────────────────────────────────────────────────
  const maxTextW = right - tx;
  let titleBottom = ay + 10;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (title) {
    const size = fitText(ctx, title, maxTextW - reserveRight, 54);
    ctx.fillStyle = theme.textColor;
    ctx.shadowColor = rgba(accent, 0.45);
    ctx.shadowBlur = 24;
    ctx.fillText(ellipsize(ctx, title, maxTextW - reserveRight), tx, ay + 26);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    titleBottom = ay + 26 + Math.round(size * 0.35);
  }

  // ── Sous-titre ────────────────────────────────────────────────────────────
  if (subtitle) {
    ctx.font = '22px Sans';
    ctx.fillStyle = rgba(textRgb, 0.72);
    ctx.fillText(ellipsize(ctx, subtitle, maxTextW), tx, titleBottom + 30);
  }

  // ── Compteurs (messages / XP) ─────────────────────────────────────────────
  const counters = [
    theme.showMessages ? `${num(messages)} messages` : null,
    theme.showTotalXp ? `${num(totalXp)} XP au total` : null,
  ].filter(Boolean).join('  ·  ');

  if (counters) {
    ctx.font = '17px Sans';
    ctx.fillStyle = rgba(accentLight, 0.85);
    ctx.fillText(counters, tx, titleBottom + 60);
  }

  // ── Barre de progression vers le niveau suivant ───────────────────────────
  const ratio = xpForNext > 0 ? Math.max(0, Math.min(1, xpIntoLevel / xpForNext)) : 0;
  const barX = tx;
  const barW = maxTextW;
  const barH = 24;
  const barY = H - 104;

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

      ctx.save();
      roundRect(ctx, barX, barY, fillW, barH, barH / 2);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(barX, barY, fillW, barH / 2);
      ctx.restore();
    }
  }

  // ── Statistiques sous la barre ────────────────────────────────────────────
  const remaining = Math.max(0, xpForNext - xpIntoLevel);

  ctx.font = '17px Sans';
  ctx.fillStyle = rgba(textRgb, 0.62);
  ctx.fillText(`${num(xpIntoLevel)} / ${num(xpForNext)} XP`, barX, H - 48);

  ctx.textAlign = 'right';
  ctx.fillStyle = rgba(textRgb, 0.45);
  ctx.fillText(`${num(remaining)} XP avant le niveau ${num(level + 1)}`, right, H - 48);
  ctx.textAlign = 'left';

  // ── Signature ─────────────────────────────────────────────────────────────
  if (theme.showFooter) {
    ctx.fillStyle = rgba(textRgb, 0.18);
    ctx.font = 'bold 14px Sans';
    ctx.fillText('REZO', MARGIN, H - 16);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { renderLevelUpCard, CARD_SIZE: { W, H } };
