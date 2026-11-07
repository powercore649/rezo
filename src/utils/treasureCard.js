// utils/treasureCard.js — Carte du coffre des Trésors cachés (canvas).
//
// Un seul rendu, trois états :
//   • closed  — le coffre est là, on montre les indices déjà tombés ;
//   • opened  — un membre a trouvé : on révèle le mot et son nom ;
//   • expired — personne n'a trouvé : on révèle le mot.
//
// renderTreasureCard({ rarity, word, clues, state, winner, rewardXp, rewardCoins,
//                      secondsLeft, lifetimeSeconds, guildName })
const { createCanvas } = require('@napi-rs/canvas');
const { helpers } = require('./rankCard');
const { RARITY_LABEL, RARITY_COLOR, maskedWord } = require('./treasureWords');
const serverIdentity = require('./serverIdentity');

const {
  MARGIN, roundRect, hexToRgb, rgb, rgba, lighten, darken, fitText, ellipsize,
} = helpers;

const W = 1000;
const H = 400;
const RADIUS = 26;

const FALLBACK_ACCENT = { r: 139, g: 26, b: 26 };

function num(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

function hexToRgbSafe(hex) {
  return hexToRgb(hex, FALLBACK_ACCENT);
}

/** Coffre dessiné en formes simples (corps, couvercle, serrure, halo). */
function drawChest(ctx, accent, accentLight, state) {
  const cx = 190;      // centre horizontal du coffre
  const bodyW = 210;
  const bodyH = 130;
  const bodyX = cx - bodyW / 2;
  const bodyY = 216;
  const lidH = 74;
  const lidX = bodyX - 8;
  const lidW = bodyW + 16;
  const lidY = bodyY - lidH + 6;

  // Halo derrière le coffre
  ctx.save();
  const halo = ctx.createRadialGradient(cx, bodyY, 0, cx, bodyY, 220);
  halo.addColorStop(0, rgba(accent, state === 'closed' ? 0.42 : 0.6));
  halo.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(bodyX - 150, bodyY - 190, bodyW + 300, 420);
  ctx.restore();

  // Couvercle
  ctx.save();
  const lidFill = ctx.createLinearGradient(lidX, lidY, lidX + lidW, lidY + lidH);
  lidFill.addColorStop(0, '#4A3520');
  lidFill.addColorStop(1, '#2A1C10');
  roundRect(ctx, lidX, lidY, lidW, lidH, 18);
  ctx.fillStyle = lidFill;
  ctx.fill();
  ctx.strokeStyle = rgb(accent);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // Corps
  ctx.save();
  const bodyFill = ctx.createLinearGradient(bodyX, bodyY, bodyX + bodyW, bodyY + bodyH);
  bodyFill.addColorStop(0, '#3B2A18');
  bodyFill.addColorStop(1, '#20150C');
  roundRect(ctx, bodyX, bodyY, bodyW, bodyH, 16);
  ctx.fillStyle = bodyFill;
  ctx.fill();
  ctx.strokeStyle = rgb(accent);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // Bandes du coffre
  ctx.save();
  ctx.fillStyle = rgba(accentLight, 0.5);
  ctx.fillRect(bodyX + 34, bodyY, 12, bodyH);
  ctx.fillRect(bodyX + bodyW - 46, bodyY, 12, bodyH);
  ctx.restore();

  // Serrure (au centre, à cheval sur le couvercle)
  ctx.save();
  const lockW = 54;
  const lockH = 64;
  const lockX = cx - lockW / 2;
  const lockY = bodyY - 26;
  roundRect(ctx, lockX, lockY, lockW, lockH, 10);
  ctx.fillStyle = state === 'opened' ? rgb(lighten(accent, 0.35)) : rgb(accent);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.arc(cx, lockY + 26, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - 3, lockY + 30, 6, 18);
  ctx.restore();

  // Éclats lumineux si le coffre est encore fermé
  if (state === 'closed') {
    ctx.save();
    ctx.fillStyle = rgba(accentLight, 0.85);
    for (const [sx, sy, sr] of [[cx - 120, lidY - 18, 5], [cx + 118, lidY - 6, 4], [cx - 60, lidY - 34, 3]]) {
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * @returns {Buffer} PNG de la carte du coffre
 */
async function renderTreasureCard({
  rarity = 'common', word = '', clues = [], state = 'closed', winner = null,
  rewardXp = 0, rewardCoins = 0, secondsLeft = 0, lifetimeSeconds = 0, guildName = null,
} = {}) {
  const accent = hexToRgbSafe(RARITY_COLOR[rarity] || RARITY_COLOR.common);
  const accentLight = lighten(accent, 0.3);
  const base = { r: 11, g: 12, b: 20 };

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Fond ──────────────────────────────────────────────────────────────────
  ctx.save();
  roundRect(ctx, 0, 0, W, H, RADIUS);
  ctx.clip();

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, rgb(darken(base, 0.4)));
  bg.addColorStop(0.55, rgb(lighten(base, 0.12)));
  bg.addColorStop(1, rgb(lighten(base, 0.04)));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(150, 40, 0, 150, 40, 620);
  glow.addColorStop(0, rgba(accent, 0.32));
  glow.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const top = ctx.createLinearGradient(0, 0, W, 0);
  top.addColorStop(0, rgb(accent));
  top.addColorStop(0.6, rgb(accentLight));
  top.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 6);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, W - 2, H - 2, RADIUS - 1);
  ctx.stroke();

  // ── Coffre ────────────────────────────────────────────────────────────────
  drawChest(ctx, accent, accentLight, state);

  // ── Bloc texte ────────────────────────────────────────────────────────────
  const tx = 360;
  const right = W - MARGIN;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = 'bold 20px Sans';
  ctx.fillStyle = rgb(accentLight);
  ctx.fillText(`COFFRE ${String(RARITY_LABEL[rarity] || '').toUpperCase()}`, tx, 92);

  const headline = state === 'opened' ? 'COFFRE OUVERT !'
    : state === 'expired' ? 'COFFRE REFERMÉ' : 'TRÉSOR CACHÉ';
  const size = fitText(ctx, headline, right - tx, 52);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold ${size}px Sans`;
  ctx.fillText(ellipsize(ctx, headline, right - tx), tx, 148);

  // Mot (masqué tant que le coffre est fermé)
  const shownWord = state === 'closed' ? maskedWord(word, 0) : String(word).toUpperCase();
  ctx.font = 'bold 40px Sans';
  ctx.fillStyle = state === 'closed' ? rgba(accentLight, 0.9) : rgb(accentLight);
  ctx.fillText(ellipsize(ctx, shownWord, right - tx), tx, 206);

  // Indices déjà tombés
  ctx.font = '19px Sans';
  let y = 248;
  for (const [i, clue] of clues.slice(0, 4).entries()) {
    ctx.fillStyle = rgba({ r: 255, g: 255, b: 255 }, 0.74);
    ctx.fillText(ellipsize(ctx, `> Indice ${i + 1} - ${clue}`, right - tx), tx, y);
    y += 30;
  }

  // ── Barre de temps + récompenses ──────────────────────────────────────────
  const barY = H - 74;
  const barW = right - tx;
  const ratio = lifetimeSeconds > 0 ? Math.max(0, Math.min(1, secondsLeft / lifetimeSeconds)) : 0;

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, tx, barY, barW, 14, 7);
  ctx.fill();
  if (state === 'closed' && ratio > 0) {
    ctx.fillStyle = rgb(accent);
    roundRect(ctx, tx, barY, Math.max(14, barW * ratio), 14, 7);
    ctx.fill();
  }

  // Pas d'emoji dans le dessin : les polices du canvas n'en ont pas toujours.
  ctx.font = 'bold 17px Sans';
  if (state === 'closed') {
    ctx.fillStyle = rgba({ r: 255, g: 255, b: 255 }, 0.6);
    ctx.fillText(`${Math.max(0, Math.ceil(secondsLeft / 60))} min restantes  ·  ${num(rewardCoins)} pièces  ·  ${num(rewardXp)} XP`, tx, barY - 16);
  } else if (state === 'opened') {
    ctx.fillStyle = rgb(accentLight);
    ctx.fillText(`${winner || 'Un membre'} a ouvert le coffre  ·  ${num(rewardCoins)} pièces  ·  ${num(rewardXp)} XP`, tx, barY - 16);
  } else {
    ctx.fillStyle = rgba({ r: 255, g: 255, b: 255 }, 0.5);
    ctx.fillText(`Personne n'a trouvé à temps  ·  en jeu : ${num(rewardCoins)} pièces`, tx, barY - 16);
  }

  // ── Signature ─────────────────────────────────────────────────────────────
  ctx.font = 'bold 14px Sans';
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fillText(serverIdentity.signatureFor(guildName || 'Trésors cachés').slice(0, 42), MARGIN, H - 22);

  return canvas.toBuffer('image/png');
}

module.exports = { renderTreasureCard, CARD_SIZE: { W, H } };
