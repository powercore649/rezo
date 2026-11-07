'use strict';
// utils/bumpCard.js — Carte de félicitations envoyée après un bump.
//
// Même langage visuel que les cartes de rang / niveau (fond partagé, avatar,
// or REZO) mais une mise en page de récompense : « BUMP #12 », « Félicitations
// Alice ! », le serveur, puis les gains du bump (coins, streak, score).
//
// renderBumpCard({ member, guild, server, reward, source })
// Le dessin ne doit JAMAIS faire échouer un bump : bumpService l'appelle via
// renderBumpCardSafe() qui renvoie null en cas de problème (police, binaire
// canvas absent…).
const { createCanvas } = require('@napi-rs/canvas');
const { normalizeTheme } = require('./rankCardTheme');
const { helpers } = require('./rankCard');
const serverIdentity = require('./serverIdentity');

const W = 1000;
const H = 360;
const AVATAR = 132;
const CHIP_H = 38;

const BUMP_CARD_FILENAME = 'bump-card.png';

const {
  MARGIN, roundRect, hexToRgb, rgb, rgba, lighten, fitText, ellipsize,
  drawAvatar, paintBackground,
} = helpers;

function num(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

function plural(n, singular, pluralForm) {
  return `${num(n)} ${Number(n) === 1 ? singular : pluralForm}`;
}

// Pastille arrondie (fond translucide + bord d'accent) contenant un texte.
function drawChip(ctx, text, x, y, accent) {
  ctx.font = 'bold 17px Sans';
  const w = ctx.measureText(text).width + 34;
  ctx.save();
  roundRect(ctx, x, y, w, CHIP_H, CHIP_H / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.55);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = rgba(lighten(accent, 0.45), 0.95);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + CHIP_H / 2 + 1);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return w;
}

/**
 * Dessine la carte de bump.
 *
 * @param {object} options
 * @param {object} [options.member] membre qui a bumpé (avatar + nom affiché)
 * @param {object} [options.guild]  serveur bumpé
 * @param {object} [options.server] document Server (bumpCount, bumpStreak…)
 * @param {number} [options.reward] coins gagnés
 * @param {number} [options.score]  score réseau
 * @param {string} [options.source] origine du bump (« REZO », « DISBOARD »…)
 * @returns {Promise<Buffer>} PNG
 */
async function renderBumpCard({
  member = null,
  guild = null,
  server = {},
  reward = 0,
  score = 0,
  source = 'REZO',
} = {}) {
  const theme = normalizeTheme({ accentColor: '#D4AF37' }); // or REZO
  const accent = hexToRgb(theme.accentColor);
  const accentLight = lighten(accent, 0.35);
  const textRgb = hexToRgb(theme.textColor, { r: 255, g: 255, b: 255 });

  const name = String(member?.displayName || member?.user?.username || 'Membre').trim() || 'Membre';
  const guildName = String(guild?.name || server.guildName || 'ce serveur').trim() || 'ce serveur';
  const bumpCount = Number(server.bumpCount || 0);
  const streak = Number(server.bumpStreak || 0);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  await paintBackground(ctx, W, H, theme);

  const ax = MARGIN;
  const ay = Math.round((H - AVATAR) / 2);
  const tx = ax + AVATAR + 40;
  const right = W - MARGIN;
  const maxTextW = right - tx;

  await drawAvatar(
    ctx,
    member?.displayAvatarURL?.({ extension: 'png', size: 512 }) || member?.user?.displayAvatarURL?.({ extension: 'png', size: 512 }),
    ax, ay, AVATAR, theme.avatarShape,
    [accent, accentLight],
    (name.charAt(0) || '?').toUpperCase(),
  );

  // ── Titre : numéro du bump ────────────────────────────────────────────────
  const title = `BUMP #${num(bumpCount)}`;
  fitText(ctx, title, maxTextW, 50);
  ctx.fillStyle = theme.textColor;
  ctx.shadowColor = rgba(accent, 0.5);
  ctx.shadowBlur = 24;
  ctx.fillText(ellipsize(ctx, title, maxTextW), tx, ay + 24);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  // ── Félicitations ─────────────────────────────────────────────────────────
  ctx.font = '24px Sans';
  ctx.fillStyle = rgba(textRgb, 0.86);
  ctx.fillText(ellipsize(ctx, `Félicitations ${name} !`, maxTextW), tx, ay + 64);

  // ── Serveur ───────────────────────────────────────────────────────────────
  ctx.font = '18px Sans';
  ctx.fillStyle = rgba(accentLight, 0.9);
  ctx.fillText(ellipsize(ctx, guildName, maxTextW), tx, ay + 96);

  // ── Gains du bump ─────────────────────────────────────────────────────────
  const chips = [
    `+${num(reward)} coins`,
    streak > 0 ? `${plural(streak, 'jour', 'jours')} de streak` : 'Premier bump',
    `Score ${num(score)}`,
  ];

  let chipX = tx;
  const chipY = H - 92;
  for (const label of chips) {
    const width = drawChip(ctx, label, chipX, chipY, accent);
    chipX += width + 12;
    if (chipX > right) break;
  }

  // ── Signature ─────────────────────────────────────────────────────────────
  if (theme.showFooter) {
    ctx.fillStyle = rgba(textRgb, 0.35);
    ctx.font = 'bold 14px Sans';
    ctx.fillText(serverIdentity.signatureFor(`bump ${source} • prochain bump dans 2 h`), MARGIN, H - 22);
  }

  return canvas.toBuffer('image/png');
}

/** Variante sûre : ne lève jamais, renvoie null si le dessin échoue. */
async function renderBumpCardSafe(options) {
  try {
    return await renderBumpCard(options);
  } catch (err) {
    console.error('❌ Carte de bump indisponible :', err.message);
    return null;
  }
}

module.exports = {
  renderBumpCard,
  renderBumpCardSafe,
  BUMP_CARD_FILENAME,
  CARD_SIZE: { W, H },
};
