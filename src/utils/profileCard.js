'use strict';
// utils/profileCard.js — Carte PNG du profil utilisateur.
//
// Rend une carte autonome (aucune dépendance à Discord) : bannière ou dégradé,
// avatar, accroche, bio, statistiques réelles, badges et barre de niveau.
// Le rendu est défensif : bannière et avatar sont chargés avec un timeout, et
// une image indisponible laisse simplement un aplat de couleur.

const { createCanvas } = require('@napi-rs/canvas');
const { safeLoadImage } = require('./safeLoadImage');
const serverIdentity = require('./serverIdentity');

const CARD_WIDTH = 900;
const CARD_HEIGHT = 420;
const DEFAULT_ACCENT = '#8B1A1A';
const FONT = 'Sans';

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('fr-FR');
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (!hours) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, '0')}`;
}

/** Tronque un texte avec une ellipse si la mesure dépasse `maxWidth`. */
function truncateToWidth(ctx, text, maxWidth) {
  const value = String(text || '');
  if (!value) return '';
  if (ctx.measureText(value).width <= maxWidth) return value;
  let out = value;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out.trimEnd()}…`;
}

/** Découpe un texte en lignes tenant dans `maxWidth`, sur `maxLines` maximum. */
function wrapLines(ctx, text, maxWidth, maxLines = 3) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length === maxLines) {
    const consumed = lines.join(' ').length;
    if (consumed < String(text).replace(/\s+/g, ' ').trim().length) {
      lines[maxLines - 1] = truncateToWidth(ctx, `${lines[maxLines - 1]} …`, maxWidth);
    }
  }
  return lines;
}

/** Dessine une image en « cover » (remplit la zone sans déformation). */
function drawCover(ctx, image, x, y, w, h) {
  const iw = image.width || w;
  const ih = image.height || h;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  try {
    ctx.drawImage(image, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } catch {
    ctx.drawImage(image, x, y, w, h);
  }
}

function hexToRgb(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function withAlpha(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(20,20,30,${alpha})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

/** Éclaircit une couleur vers le blanc : lisible sur fond sombre, reste « dans » l'accent. */
function lighten(hex, amount = 0.55) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#F2F3F5';
  const mix = channel => Math.round(channel + (255 - channel) * Math.max(0, Math.min(1, amount)));
  return `rgb(${mix(rgb.r)},${mix(rgb.g)},${mix(rgb.b)})`;
}

function displayNameOf(user, member) {
  return member?.displayName || user?.globalName || user?.username || 'Membre';
}

/**
 * Rend la carte de profil.
 * @param {object} options
 * @param {object} options.user      utilisateur Discord (username, avatar)
 * @param {object} [options.member]  membre du serveur (displayName, avatar)
 * @param {object} options.profile   profil enregistré (titre, bio, couleur, bannière)
 * @param {object} options.stats     statistiques réelles
 * @param {Array}  [options.badges]  badges à afficher (déjà sélectionnés)
 * @param {number} [options.levelProgress] progression 0..1 dans le niveau
 * @param {string} [options.levelLabel]    texte de la barre de niveau
 * @returns {Promise<Buffer>} PNG
 */
async function renderProfileCard({
  user, member, profile = {}, stats = {}, badges = [], levelProgress = 0, levelLabel = '',
} = {}) {
  const W = CARD_WIDTH;
  const H = CARD_HEIGHT;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const accent = /^#[0-9a-fA-F]{6}$/.test(String(profile.color || ''))
    ? profile.color
    : serverIdentity.accentHex(null, DEFAULT_ACCENT);

  // ── Fond ────────────────────────────────────────────────────────────────────
  ctx.save();
  roundRect(ctx, 0, 0, W, H, 22);
  ctx.clip();

  let backgroundDrawn = false;
  if (profile.bannerUrl) {
    const banner = await safeLoadImage(profile.bannerUrl);
    if (banner) {
      drawCover(ctx, banner, 0, 0, W, H);
      ctx.fillStyle = 'rgba(9,10,18,0.68)';
      ctx.fillRect(0, 0, W, H);
      backgroundDrawn = true;
    }
  }
  if (!backgroundDrawn) {
    const gradient = ctx.createLinearGradient(0, 0, W, H);
    gradient.addColorStop(0, '#1a1b2e');
    gradient.addColorStop(0.55, withAlpha(accent, 0.42));
    gradient.addColorStop(1, '#0f1524');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
    // Halo d'accent en haut à droite : donne du relief sans image.
    const halo = ctx.createRadialGradient(W - 130, 10, 20, W - 130, 10, 340);
    halo.addColorStop(0, withAlpha(accent, 0.5));
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, W, H);
    // Voile sombre : garantit le contraste du texte quel que soit l'accent.
    ctx.fillStyle = 'rgba(7,9,16,0.46)';
    ctx.fillRect(0, 0, W, H);
  }

  // Bande d'accent + filet bas.
  const accentBar = ctx.createLinearGradient(0, 0, 0, H);
  accentBar.addColorStop(0, accent);
  accentBar.addColorStop(1, '#57F287');
  ctx.fillStyle = accentBar;
  roundRect(ctx, 0, 0, 7, H, 3);
  ctx.fill();

  // ── Avatar ──────────────────────────────────────────────────────────────────
  const avatarSize = 112;
  const avatarX = 44;
  const avatarY = 58;

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 5, 0, Math.PI * 2);
  const ring = ctx.createLinearGradient(avatarX, avatarY, avatarX + avatarSize, avatarY + avatarSize);
  ring.addColorStop(0, accent);
  ring.addColorStop(1, '#57F287');
  ctx.fillStyle = ring;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.clip();
  const avatarUrl = member?.displayAvatarURL
    ? member.displayAvatarURL({ extension: 'png', size: 256 })
    : user?.displayAvatarURL?.({ extension: 'png', size: 256 });
  const avatar = await safeLoadImage(avatarUrl);
  if (avatar) {
    ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
  } else {
    ctx.fillStyle = accent;
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
  }
  ctx.restore();

  // ── Identité ────────────────────────────────────────────────────────────────
  const textX = avatarX + avatarSize + 30;
  const maxTextWidth = 470;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 30px ${FONT}`;
  ctx.fillText(truncateToWidth(ctx, displayNameOf(user, member), maxTextWidth), textX, avatarY + 36);

  ctx.fillStyle = '#B9BBBE';
  ctx.font = `15px ${FONT}`;
  ctx.fillText(`@${user?.username || 'membre'}`, textX, avatarY + 60);

  const title = String(profile.title || '').trim();
  if (title) {
    ctx.fillStyle = lighten(accent, 0.45);
    ctx.font = `bold 17px ${FONT}`;
    ctx.fillText(truncateToWidth(ctx, title, maxTextWidth), textX, avatarY + 90);
  }

  // ── Bio ─────────────────────────────────────────────────────────────────────
  const bio = String(profile.bio || '').trim();
  ctx.font = `16px ${FONT}`;
  ctx.fillStyle = '#D9DBE0';
  const bioLines = bio
    ? wrapLines(ctx, bio, maxTextWidth, 3)
    : ['Aucune présentation pour l’instant — /profile panel pour la compléter.'];
  if (!bio) ctx.fillStyle = 'rgba(217,219,224,0.55)';
  bioLines.forEach((line, index) => {
    ctx.fillText(line, textX, avatarY + 120 + index * 23);
  });

  // ── Statistiques (4 boîtes) ─────────────────────────────────────────────────
  const boxes = [
    { label: 'Niveau', value: formatNumber(stats.level) },
    { label: 'Bumps', value: formatNumber(stats.bumps) },
    { label: 'Pièces', value: formatNumber(stats.coins) },
    { label: 'Vocal', value: formatDuration(stats.voiceSeconds) },
  ];
  const boxY = 250;
  const boxH = 62;
  const boxGap = 12;
  const boxW = (W - textX - 44 - boxGap * (boxes.length - 1)) / boxes.length;

  boxes.forEach((box, index) => {
    const bx = textX + index * (boxW + boxGap);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRect(ctx, bx, boxY, boxW, boxH, 10);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold 21px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(truncateToWidth(ctx, box.value, boxW - 16), bx + boxW / 2, boxY + 27);

    ctx.fillStyle = '#A8ACB4';
    ctx.font = `12px ${FONT}`;
    ctx.fillText(box.label, bx + boxW / 2, boxY + 47);
    ctx.textAlign = 'left';
  });

  // ── Barre de progression du niveau ──────────────────────────────────────────
  const barX = textX;
  const barW = W - textX - 44;
  const barY = 336;
  const barH = 8;

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, barX, barY, barW, barH, 4);
  ctx.fill();

  const ratio = Math.max(0, Math.min(1, Number(levelProgress) || 0));
  if (ratio > 0) {
    const barGradient = ctx.createLinearGradient(barX, barY, barX + barW * ratio, barY);
    barGradient.addColorStop(0, accent);
    barGradient.addColorStop(1, '#57F287');
    ctx.fillStyle = barGradient;
    roundRect(ctx, barX, barY, Math.max(barH, barW * ratio), barH, 4);
    ctx.fill();
  }

  if (levelLabel) {
    ctx.fillStyle = '#C7CAD1';
    ctx.font = `12px ${FONT}`;
    ctx.fillText(levelLabel, barX, barY - 8);
  }

  // ── Badges : pastilles texte (aucune police emoji requise sur l'hôte) ──────
  const pillY = 356;
  const pillH = 26;
  const pills = (badges || []).slice(0, 6);
  if (pills.length) {
    let pillX = barX;
    const maxPillX = W - 44;
    let hidden = 0;
    for (let index = 0; index < pills.length; index += 1) {
      const badge = pills[index];
      ctx.font = `13px ${FONT}`;
      const label = truncateToWidth(ctx, String(badge.name || 'Badge'), 120);
      const width = ctx.measureText(label).width + 22;
      if (pillX + width > maxPillX) {
        hidden = pills.length - index;
        break;
      }
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      roundRect(ctx, pillX, pillY, width, pillH, 13);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `13px ${FONT}`;
      ctx.fillText(label, pillX + 11, pillY + 18);
      pillX += width + 8;
    }
    if (hidden) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = `12px ${FONT}`;
      ctx.fillText(`+${hidden}`, pillX + 2, pillY + 17);
    }
  } else {
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('Aucun badge débloqué pour l’instant', barX, pillY + 18);
  }

  // ── Signature ───────────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `bold 12px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillText(`${serverIdentity.nameFor(serverIdentity.currentIdentity(), 18).toUpperCase()} • PROFIL`, W - 24, H - 18);
  ctx.textAlign = 'left';

  ctx.restore();

  return canvas.toBuffer('image/png');
}

module.exports = {
  CARD_WIDTH,
  CARD_HEIGHT,
  DEFAULT_ACCENT,
  renderProfileCard,
  wrapLines,
  truncateToWidth,
  formatDuration,
  formatNumber,
};
