// scripts/preview-rank-card.js — Aperçus de la carte de rang.
//
// Usage : node scripts/preview-rank-card.js
// Génère dans preview/ un PNG par variante + une galerie HTML autonome
// (images en base64) pour vérifier le rendu sans passer par Discord.
//
// L'image de fond et l'avatar sont servis par un petit serveur HTTP local :
// le chemin « téléchargement d'image » du renderer est donc réellement exercé.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { renderRankCard } = require('../src/utils/rankCard');
const { resolveCardTheme } = require('../src/utils/rankCardTheme');

const OUT_DIR = path.join(__dirname, '..', 'preview');

const STATS = { level: 42, rank: 7, xpIntoLevel: 34_500, xpForNext: 60_000, totalXp: 812_340, messages: 12_345 };

function backgroundImage() {
  const c = createCanvas(800, 450);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 800, 450);
  g.addColorStop(0, '#1B3B6F');
  g.addColorStop(0.5, '#6F1B5B');
  g.addColorStop(1, '#F0A05A');
  x.fillStyle = g;
  x.fillRect(0, 0, 800, 450);
  for (let i = 0; i < 60; i++) {
    x.beginPath();
    x.arc(Math.random() * 800, Math.random() * 450, 10 + Math.random() * 70, 0, Math.PI * 2);
    x.fillStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.10})`;
    x.fill();
  }
  return c.toBuffer('image/png');
}

function avatarImage(letter) {
  const c = createCanvas(300, 300);
  const x = c.getContext('2d');
  x.fillStyle = '#3A2A5C';
  x.fillRect(0, 0, 300, 300);
  x.fillStyle = '#FFFFFF';
  x.font = 'bold 150px Sans';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(letter, 150, 160);
  return c.toBuffer('image/png');
}

const VARIANTS = [
  {
    name: '1-defaut',
    label: 'Thème du serveur par défaut (dégradé, avatar rond, barre dégradée)',
    member: 'Raphaël',
    stats: STATS,
    theme: resolveCardTheme({ cardColor: '#8B1A1A', rankCard: {} }),
  },
  {
    name: '2-uni-segments',
    label: 'Fond uni + barre en segments + avatar arrondi (accent bleu)',
    member: 'Kaya',
    stats: STATS,
    theme: {
      accentColor: '#5865F2', bgStyle: 'solid', bgColor: '#0E1526',
      barStyle: 'segments', avatarShape: 'rounded',
    },
  },
  {
    name: '3-image-fond',
    label: 'Image de fond (assombrie 55 %) + avatar carré + texte blanc cassé',
    member: 'Nyx',
    stats: STATS,
    theme: { accentColor: '#E67E22', bgStyle: 'image', bgImage: 'BG_URL', bgDim: 0.55, textColor: '#EDEFF7', avatarShape: 'square' },
  },
  {
    name: '4-epuree',
    label: 'Carte épurée : rang, messages, XP total et signature masqués (accent vert)',
    member: 'Sacha',
    stats: STATS,
    theme: {
      accentColor: '#57F287', bgStyle: 'solid', bgColor: '#050509', barStyle: 'solid',
      showRank: false, showMessages: false, showTotalXp: false, showFooter: false,
    },
  },
  {
    name: '5-limites',
    label: 'Cas limites : nom de 60 caractères, niveau 999, rang 12 345, 0 % de progression',
    member: 'Le membre avec un nom vraiment beaucoup trop long pour la carte',
    stats: { level: 999, rank: 12_345, xpIntoLevel: 0, xpForNext: 26_000, totalXp: 0, messages: 0 },
    theme: { accentColor: '#EB459E' },
  },
  {
    name: '6-max',
    label: 'Progression à 100 % + avatar indisponible (repli sur l\'initiale)',
    member: 'Ines',
    avatarBroken: true,
    stats: { level: 12, rank: 1, xpIntoLevel: 26_000, xpForNext: 26_000, totalXp: 158_900, messages: 999 },
    theme: { accentColor: '#1ABC9C' },
  },
];

async function main() {
  const bg = backgroundImage();
  const avatars = new Map();
  for (const v of VARIANTS) {
    if (!avatars.has(v.name)) avatars.set(v.name, avatarImage((v.member[0] || '?').toUpperCase()));
  }

  let base = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/bg.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(bg); }
    const match = /^\/avatar\/([\w-]+)\.png$/.exec(req.url || '');
    if (match) {
      const buf = avatars.get(match[1]);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(buf);
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];

  for (const v of VARIANTS) {
    const theme = { ...v.theme };
    if (theme.bgImage === 'BG_URL') theme.bgImage = `${base}/bg.png`;

    const member = {
      displayName: v.member,
      user: { username: v.member },
      displayAvatarURL: () => (v.avatarBroken ? `${base}/avatar-inexistant.png` : `${base}/avatar/${v.name}.png`),
    };

    const started = Date.now();
    const buffer = await renderRankCard(member, v.stats, theme);
    const ms = Date.now() - started;

    const file = path.join(OUT_DIR, `rank-${v.name}.png`);
    fs.writeFileSync(file, buffer);
    results.push({ ...v, buffer, ms, bytes: buffer.length, theme });
    console.log(`✅ ${path.relative(process.cwd(), file)} — ${buffer.length} octets, ${ms} ms`);
  }

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Aperçus — cartes de rang REZO</title>
<style>
  body { background:#111318; color:#e9ebf5; font-family: system-ui, sans-serif; margin:24px; }
  h1 { font-size:20px; }
  figure { margin:0 0 28px; }
  img { width:100%; max-width:1000px; border-radius:14px; display:block; }
  figcaption { margin-top:8px; color:#9aa0b4; font-size:14px; }
</style></head><body>
<h1>Aperçus de la carte de rang (${results.length} variantes)</h1>
${results.map(r => `<figure><img alt="${r.name}" src="data:image/png;base64,${r.buffer.toString('base64')}">
<figcaption><b>${r.name}</b> — ${r.label} · ${r.bytes} octets · ${r.ms} ms</figcaption></figure>`).join('\n')}
</body></html>`;

  const htmlFile = path.join(OUT_DIR, 'rank-cards.html');
  fs.writeFileSync(htmlFile, html);
  console.log(`✅ ${path.relative(process.cwd(), htmlFile)}`);

  server.close();
}

main().catch(err => { console.error('❌', err); process.exit(1); });
