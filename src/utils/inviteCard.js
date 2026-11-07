'use strict';
// utils/inviteCard.js — Carte du système d'invitations.
//
// Deux usages, une seule mise en page :
//   • /invites voir → carte personnelle (total d'invitations, rang, détail) ;
//   • palier atteint → carte de félicitations envoyée en MP à l'inviteur.
//
// Le dessin ne doit jamais faire échouer une commande ou une annonce :
// renderInviteCardSafe() renvoie null si le binaire canvas est indisponible.
const { createCanvas } = require('@napi-rs/canvas');
const { normalizeTheme } = require('./rankCardTheme');
const { helpers } = require('./rankCard');

const W = 1000;
const H = 380;
const AVATAR = 136;
const CHIP_H = 38;

const INVITE_CARD_FILENAME = 'invite-card.png';

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

function drawChip(ctx, text, x, y, accent) {
  ctx.font = 'bold 17px Sans';
  const width = ctx.measureText(text).width + 34;
  ctx.save();
  roundRect(ctx, x, y, width, CHIP_H, CHIP_H / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fill();
  ctx.strokeStyle = rgba(accent, 0.5);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = rgba(lighten(accent, 0.45), 0.95);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + width / 2, y + CHIP_H / 2 + 1);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return width;
}

/**
 * Dessine une carte d'invitations.
 *
 * @param {object} options
 * @param {object} [options.member]  membre affiché (avatar + nom)
 * @param {object} [options.guild]   serveur
 * @param {object} [options.stats]   { joins, active, leaves, fakes }
 * @param {number|null} [options.rank] rang de l'inviteur (1 = premier)
 * @param {string} [options.headline] petit titre au-dessus du compteur
 * @param {string|null} [options.caption] ligne de contexte (ex: « Nina a rejoint grâce à toi »)
 * @returns {Promise<Buffer>} PNG
 */
async function renderInviteCard({
  member = null,
  guild = null,
  stats = {},
  rank = null,
  headline = 'INVITATIONS',
  caption = null,
} = {}) {
  const theme = normalizeTheme({ accentColor: '#D4AF37' });
  const accent = hexToRgb(theme.accentColor);
  const accentLight = lighten(accent, 0.35);
  const textRgb = hexToRgb(theme.textColor, { r: 255, g: 255, b: 255 });

  const name = String(member?.displayName || member?.user?.username || member?.username || 'Membre').trim() || 'Membre';
  const guildName = String(guild?.name || 'ce serveur').trim() || 'ce serveur';
  const active = Number(stats.active || 0);
  const joins = Number(stats.joins ?? active);
  const leaves = Number(stats.leaves || 0);
  const fakes = Number(stats.fakes || 0);

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

  // ── Pastille de rang ──────────────────────────────────────────────────────
  let reserveRight = 0;
  if (rank) {
    const rankText = `RANG #${num(rank)}`;
    ctx.font = 'bold 18px Sans';
    const chipW = ctx.measureText(rankText).width + 34;
    const chipX = right - chipW;
    const chipY = 42;

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

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    reserveRight = chipW + 24;
  }

  // ── Titre + compteur ──────────────────────────────────────────────────────
  ctx.font = 'bold 16px Sans';
  ctx.fillStyle = rgba(accentLight, 0.85);
  ctx.fillText(String(headline).toUpperCase(), tx, ay + 6);

  const totalText = num(active);
  fitText(ctx, totalText, maxTextW - reserveRight, 56);
  ctx.fillStyle = theme.textColor;
  ctx.shadowColor = rgba(accent, 0.5);
  ctx.shadowBlur = 24;
  ctx.fillText(ellipsize(ctx, totalText, maxTextW - reserveRight), tx, ay + 62);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';

  // ── Nom de l'inviteur ─────────────────────────────────────────────────────
  ctx.font = '22px Sans';
  ctx.fillStyle = rgba(textRgb, 0.86);
  ctx.fillText(ellipsize(ctx, name, maxTextW), tx, ay + 94);

  // ── Contexte (join, palier…) ──────────────────────────────────────────────
  if (caption) {
    ctx.font = '16px Sans';
    ctx.fillStyle = rgba(textRgb, 0.55);
    ctx.fillText(ellipsize(ctx, caption, maxTextW), tx, ay + 122);
  }

  // ── Détail des invitations ────────────────────────────────────────────────
  const chips = [
    `${plural(active, 'active', 'actives')}`,
    `${plural(leaves, 'reparti', 'repartis')}`,
    `${plural(fakes, 'fake', 'fakes')}`,
  ];
  if (joins !== active) chips.push(`${plural(joins, 'invité', 'invités')} au total`);

  let chipX = tx;
  const chipY = H - 86;
  for (const label of chips) {
    const width = drawChip(ctx, label, chipX, chipY, accent);
    chipX += width + 12;
    if (chipX > right) break;
  }

  // ── Signature ─────────────────────────────────────────────────────────────
  if (theme.showFooter) {
    ctx.fillStyle = rgba(textRgb, 0.35);
    ctx.font = 'bold 14px Sans';
    ctx.fillText(`REZO • ${guildName}`, MARGIN, H - 22);
  }

  return canvas.toBuffer('image/png');
}

/** Variante sûre : aucune exception, null si le dessin échoue. */
async function renderInviteCardSafe(options) {
  try {
    return await renderInviteCard(options);
  } catch (err) {
    console.error('❌ Carte d’invitations indisponible :', err.message);
    return null;
  }
}

module.exports = {
  renderInviteCard,
  renderInviteCardSafe,
  INVITE_CARD_FILENAME,
  CARD_SIZE: { W, H },
};
