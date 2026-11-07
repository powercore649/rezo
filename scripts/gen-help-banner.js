// scripts/gen-help-banner.js — Régénère la bannière du centre d'aide.
// Usage : node scripts/gen-help-banner.js
// Produit assets/banners/help-banner.jpg (identité REZO : rouge vin + or).
//
// ⚠️ Volontairement SANS texte : le rendu de police de @napi-rs/canvas dépend
// de données ICU absentes de certaines plateformes (crash « ParagraphBuilderImpl »).
// La bannière n'utilise donc que des formes vectorielles — elle se génère
// partout, et le titre est de toute façon porté par l'embed Discord.
'use strict';

const fs   = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const W = 1200, H = 320;
const WINE = '#8B1A1A';
const GOLD = '#D4AF37';

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// ── Fond : dégradé sombre + halo rouge vin + halo or ───────────────────────
const bg = ctx.createLinearGradient(0, 0, W, H);
bg.addColorStop(0, '#1B0707');
bg.addColorStop(0.55, '#0B0507');
bg.addColorStop(1, '#05060A');
ctx.fillStyle = bg;
ctx.fillRect(0, 0, W, H);

const glow = ctx.createRadialGradient(W * 0.12, H * 0.55, 0, W * 0.12, H * 0.55, W * 0.6);
glow.addColorStop(0, 'rgba(139,26,26,0.55)');
glow.addColorStop(1, 'rgba(139,26,26,0)');
ctx.fillStyle = glow;
ctx.fillRect(0, 0, W, H);

const gold = ctx.createRadialGradient(W * 0.9, H * 0.2, 0, W * 0.9, H * 0.2, W * 0.45);
gold.addColorStop(0, 'rgba(212,175,55,0.22)');
gold.addColorStop(1, 'rgba(212,175,55,0)');
ctx.fillStyle = gold;
ctx.fillRect(0, 0, W, H);

// ── Grille discrète ─────────────────────────────────────────────────────────
ctx.strokeStyle = 'rgba(212,175,55,0.05)';
ctx.lineWidth = 1;
for (let x = 0; x < W; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
for (let y = 0; y < H; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

// ── Bordure fine ────────────────────────────────────────────────────────────
const border = ctx.createLinearGradient(0, 0, W, 0);
border.addColorStop(0, 'rgba(212,175,55,0.85)');
border.addColorStop(0.5, 'rgba(139,26,26,0.85)');
border.addColorStop(1, 'rgba(212,175,55,0.35)');
ctx.strokeStyle = border;
ctx.lineWidth = 3;
ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

// ── Monogramme : deux anneaux imbriqués (l'identité, sans dépendance de police)
function ring(cx, cy, r, stroke, width) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.stroke();
}
// Halo doux derrière le monogramme
const halo = ctx.createRadialGradient(150, H / 2, 0, 150, H / 2, 130);
halo.addColorStop(0, 'rgba(212,175,55,0.18)');
halo.addColorStop(1, 'rgba(212,175,55,0)');
ctx.fillStyle = halo;
ctx.fillRect(20, H / 2 - 130, 260, 260);

ring(150, H / 2, 78, 'rgba(212,175,55,0.9)', 6);
ring(150, H / 2, 52, 'rgba(255,255,255,0.30)', 3);
// Petit carré pivot au centre (le « point » de la marque)
ctx.fillStyle = GOLD;
ctx.save();
ctx.translate(150, H / 2);
ctx.rotate(Math.PI / 4);
ctx.fillRect(-13, -13, 26, 26);
ctx.restore();

// ── Séparateur vertical dégradé ─────────────────────────────────────────────
const sep = ctx.createLinearGradient(0, H / 2 - 70, 0, H / 2 + 70);
sep.addColorStop(0, 'rgba(212,175,55,0.05)');
sep.addColorStop(0.5, 'rgba(212,175,55,0.85)');
sep.addColorStop(1, 'rgba(212,175,55,0.05)');
ctx.fillStyle = sep;
ctx.fillRect(320, H / 2 - 78, 3, 156);

// ── Blocs signature (motif ▰▱) : 10 blocs, 9 pleins + 1 vide ────────────────
const blocks = 10, bw = 46, gap = 12;
const barW = blocks * bw + (blocks - 1) * gap;
let bx = W - 90 - barW;
const by = H / 2 - 46;
for (let i = 0; i < blocks; i++) {
  const filled = i < 9;
  const g = ctx.createLinearGradient(bx, by, bx + bw, by + 92);
  if (filled) {
    g.addColorStop(0, 'rgba(212,175,55,0.95)');
    g.addColorStop(1, 'rgba(139,26,26,0.85)');
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
  }
  ctx.fillRect(bx, by, bw, 92);
  ctx.strokeStyle = filled ? 'rgba(255,255,255,0.10)' : 'rgba(212,175,55,0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx + 1, by + 1, bw - 2, 90);
  bx += bw + gap;
}

// ── Liseré bas ──────────────────────────────────────────────────────────────
const under = ctx.createLinearGradient(380, 0, W - 60, 0);
under.addColorStop(0, 'rgba(212,175,55,0.55)');
under.addColorStop(1, 'rgba(212,175,55,0)');
ctx.fillStyle = under;
ctx.fillRect(380, H - 58, W - 440, 3);

const out = path.join(__dirname, '..', 'assets', 'banners', 'help-banner.jpg');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, canvas.toBuffer('image/jpeg', 90));
console.log(`✅ Bannière générée : ${path.relative(path.join(__dirname, '..'), out)} (${fs.statSync(out).size} octets)`);
