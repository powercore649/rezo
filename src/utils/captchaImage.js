'use strict';
// utils/captchaImage.js — Générateur d'image captcha réellement résistant à l'OCR/aux bots.
// Utilise @napi-rs/canvas (déjà une dépendance du projet). Aucune dépendance réseau.
//
// Techniques anti-bot appliquées (chacune casse un type d'OCR différent) :
//  - fond en dégradé bruité + grain aléatoire (empêche la binarisation simple)
//  - lignes de Bézier superposées AU-DESSUS et EN-DESSOUS du texte (casse la segmentation)
//  - chaque caractère : police/taille/couleur/rotation/position aléatoires (casse le template matching)
//  - léger cisaillement (shear) par caractère (casse la reconnaissance de forme rigide)
//  - halo/ombre par caractère (réduit le contraste net dont l'OCR a besoin)
//  - nuage de points de bruit par-dessus tout (casse le débruitage naïf)
//  - découpage en bandes horizontales décalées (casse la reconnaissance globale de ligne)
//  - le mode "math" est aussi rendu en image (aucun texte brut n'est jamais exposé au client)
//
// Niveaux anti-OCR (option `level`) :
//  - normal  : distorsion standard (lisible par tous)
//  - hard    : grain et courbes doublés + découpage en 4 bandes
//  - extreme : grain maximal, triple bruit + double découpage (résistance maximale)

const { createCanvas } = require('@napi-rs/canvas');

const WIDTH = 320;
const HEIGHT = 130;

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[randInt(0, arr.length - 1)]; }

const INK_COLORS = ['#1f2a44', '#3a1f44', '#442a1f', '#1f4432', '#2a1f44', '#441f2a'];
const NOISE_COLORS = ['#8892b0aa', '#a0708066', '#70a08c66', '#9080a066'];

const LEVELS = {
  normal:  { grain: 900,  curvesUnder: 5, curvesOver: 3, dots: 120, slices: null },
  hard:    { grain: 1600, curvesUnder: 7, curvesOver: 5, dots: 190, slices: [{ bands: 4, amplitude: 6 }] },
  extreme: { grain: 2400, curvesUnder: 9, curvesOver: 7, dots: 280, slices: [{ bands: 5, amplitude: 9 }, { bands: 3, amplitude: 5 }] },
};

function paintBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  grad.addColorStop(0, '#eef1fa');
  grad.addColorStop(1, '#e4e9f7');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawGrain(ctx, count) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = pick(NOISE_COLORS);
    const x = rand(0, WIDTH), y = rand(0, HEIGHT);
    ctx.fillRect(x, y, 1, 1);
  }
}

function drawNoiseCurves(ctx, count) {
  for (let i = 0; i < count; i++) {
    ctx.strokeStyle = pick(INK_COLORS) + '55';
    ctx.lineWidth = rand(1, 2.5);
    ctx.beginPath();
    ctx.moveTo(rand(0, WIDTH), rand(0, HEIGHT));
    ctx.bezierCurveTo(
      rand(0, WIDTH), rand(0, HEIGHT),
      rand(0, WIDTH), rand(0, HEIGHT),
      rand(0, WIDTH), rand(0, HEIGHT),
    );
    ctx.stroke();
  }
}

function drawNoiseDots(ctx, count) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = pick(INK_COLORS) + '33';
    ctx.beginPath();
    ctx.arc(rand(0, WIDTH), rand(0, HEIGHT), rand(0.5, 1.8), 0, Math.PI * 2);
    ctx.fill();
  }
}

// ─── Découpage en bandes horizontales décalées (anti-OCR global) ─────────────
// Chaque bande est copiée, le fond repeint dessous, puis la bande redessinée
// avec un décalage horizontal aléatoire. Le texte reste lisible à l'œil mais
// la ligne de texte est fragmentée pour toute reconnaissance globale.
function slicePass(ctx, { bands, amplitude }) {
  const bandH = Math.floor(HEIGHT / bands);
  const grad = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  grad.addColorStop(0, '#eef1fa');
  grad.addColorStop(1, '#e4e9f7');

  for (let i = 0; i < bands; i++) {
    const y = i * bandH;
    const h = (i === bands - 1) ? HEIGHT - y : bandH;
    if (h <= 0) break;

    const img = ctx.getImageData(0, y, WIDTH, h);
    const offset = Math.round(rand(-amplitude, amplitude));
    if (offset === 0) continue;

    ctx.fillStyle = grad;
    ctx.fillRect(0, y, WIDTH, h);
    ctx.putImageData(img, offset, y);
  }
}

/**
 * Dessine une chaîne de caractères avec distorsion individuelle par lettre.
 */
function drawDistortedText(ctx, text, { fontSizeBase = 42 } = {}) {
  const chars = String(text).split('');
  const totalWidth = WIDTH * 0.82;
  const startX = (WIDTH - totalWidth) / 2;
  const step = totalWidth / chars.length;

  chars.forEach((char, i) => {
    const cx = startX + step * i + step / 2 + rand(-4, 4);
    const cy = HEIGHT / 2 + rand(-10, 10);
    const angle = rand(-0.35, 0.35); // ± ~20°
    const shear = rand(-0.25, 0.25);
    const fontSize = fontSizeBase + rand(-6, 6);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.transform(1, 0, shear, 1, 0, 0); // cisaillement

    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Halo léger (réduit le contraste net exploité par l'OCR basique)
    ctx.fillStyle = pick(INK_COLORS) + '40';
    ctx.fillText(char, rand(-2, 2), rand(-2, 2));

    // Caractère principal
    ctx.fillStyle = pick(INK_COLORS);
    ctx.fillText(char, 0, 0);

    ctx.restore();
  });
}

/**
 * Génère une image captcha PNG pour le texte donné.
 * @param {string} text - le code (ou l'expression mathématique) à afficher
 * @param {Object} [opts]
 * @param {boolean} [opts.isMath] - si true, affiche `text` (ex: "12 + 7 =") tel quel, en légèrement plus petit
 * @param {'normal'|'hard'|'extreme'} [opts.level] - niveau anti-OCR
 * @returns {Buffer} PNG
 */
function renderCaptchaImage(text, { isMath = false, level = 'normal' } = {}) {
  const cfg = LEVELS[level] || LEVELS.normal;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  paintBackground(ctx);
  drawGrain(ctx, cfg.grain);
  drawNoiseCurves(ctx, cfg.curvesUnder);
  drawDistortedText(ctx, text, { fontSizeBase: isMath ? 34 : 42 });
  drawNoiseCurves(ctx, cfg.curvesOver); // quelques courbes par-dessus le texte aussi
  drawNoiseDots(ctx, cfg.dots);

  if (cfg.slices) for (const s of cfg.slices) slicePass(ctx, s);

  // Cadre discret
  ctx.strokeStyle = '#c7cde3';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, WIDTH - 2, HEIGHT - 2);

  return canvas.toBuffer('image/png');
}

module.exports = { renderCaptchaImage, WIDTH, HEIGHT, LEVELS };
