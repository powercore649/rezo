'use strict';
// scripts/import-emojis.js — Importe les emojis animés de REZO sur l'application
// Discord (Developer Portal → Emojis), puis écrit leurs identifiants dans
// src/data/appEmojis.json pour que le bot puisse les utiliser.
//
//   node scripts/import-emojis.js            importe ce qui manque
//   node scripts/import-emojis.js --dry-run  affiche le plan, n'écrit rien
//   node scripts/import-emojis.js --force    recrée les emojis déjà présents
//
// Le token est lu dans .env et n'est jamais affiché. L'import est idempotent :
// un emoji déjà présent sur l'application est réutilisé, pas dupliqué.

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const API = 'https://discord.com/api/v10';
const SOURCE_DIR = process.env.EMOJI_SOURCE_DIR || 'C:/Users/raphw/Downloads/Samp_animated';
const OUTPUT = path.join(__dirname, '..', 'src', 'data', 'appEmojis.json');

// Correspondance fichier → nom Discord. Les noms sont en minuscules, préfixés
// par « rezo_ » pour éviter toute collision avec les emojis d'autres bots, et
// tiennent dans la limite de 32 caractères imposée par Discord.
const MANIFEST = [
  { file: 'flecha.gif', name: 'rezo_fleche', use: 'navigation, « Commencer »' },
  { file: 'verif.gif', name: 'rezo_valide', use: 'succès, module installé' },
  { file: 'OJO.gif', name: 'rezo_alerte', use: 'alerte, refus, erreur' },
  { file: 'carga.gif', name: 'rezo_chargement', use: 'actualisation, attente' },
  { file: 'emoji_22.gif', name: 'rezo_bouclier', use: 'sécurité, protection' },
  { file: 'emoji_23.gif', name: 'rezo_sirene', use: 'anti-raid, urgence' },
  { file: 'emoji_27.gif', name: 'rezo_punaise', use: 'réglages, épinglage' },
  { file: 'emoji_17.gif', name: 'rezo_poubelle', use: 'suppression, nettoyage' },
  { file: 'emoji_24.gif', name: 'rezo_corbeille', use: 'suppression douce' },
  { file: 'emoji_29.gif', name: 'rezo_muet', use: 'anti-ping, silence' },
  { file: 'emoji_30.gif', name: 'rezo_attention', use: 'avertissement' },
  { file: 'emoji_33.gif', name: 'rezo_gemme', use: 'premium, rareté' },
  { file: 'emoji_43.gif', name: 'rezo_argent', use: 'économie, boutique' },
  { file: 'emoji_34.gif', name: 'rezo_calcul', use: 'statistiques, calculs' },
  { file: 'emoji_37.gif', name: 'rezo_cone', use: 'installation, chantier' },
  { file: 'emoji_15.gif', name: 'rezo_suivant', use: 'section suivante' },
  { file: 'emoji_21.gif', name: 'rezo_points', use: 'chargement discret' },
  { file: 'emoji_14.gif', name: 'rezo_check_bleu', use: 'validation secondaire' },
  { file: 'emoji_20.gif', name: 'rezo_check_noir', use: 'validation neutre' },
  { file: 'emoji_26.gif', name: 'rezo_triangle', use: 'élément décoratif' },
  { file: 'bailar.gif', name: 'rezo_fete', use: 'communauté, événements' },
  { file: 'klk.gif', name: 'rezo_steve', use: 'clin d’œil, easter egg' },
  { file: 'emoji_58.gif', name: 'rezo_dank', use: 'réaction communautaire' },
];

const MIME = { gif: 'image/gif', png: 'image/png', webp: 'image/webp' };
const MAX_BYTES = 256 * 1024;

function validateName(name) {
  return /^[a-z0-9_]{2,32}$/.test(name);
}

async function api(token, method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* corps non JSON */ }
  if (!res.ok) {
    throw new Error(`${method} ${route} → HTTP ${res.status} · ${data?.message || raw.slice(0, 160)}`);
  }
  return data;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const token = process.env.TOKEN;
  if (!token) {
    console.error('❌ TOKEN absent de .env — import impossible.');
    process.exit(1);
  }

  for (const entry of MANIFEST) {
    if (!validateName(entry.name)) throw new Error(`nom Discord invalide : ${entry.name}`);
    if (!fs.existsSync(path.join(SOURCE_DIR, entry.file))) throw new Error(`fichier absent : ${entry.file}`);
  }

  const me = await api(token, 'GET', '/users/@me');
  const appId = me.id;
  console.log(`Application : ${me.username} (${appId}) — ${MANIFEST.length} emoji(s) à vérifier`);

  const existing = await api(token, 'GET', `/applications/${appId}/emojis`);
  const known = new Map((existing.items || []).map(emoji => [emoji.name, emoji]));
  const result = {};

  for (const entry of MANIFEST) {
    const file = path.join(SOURCE_DIR, entry.file);
    const buffer = fs.readFileSync(file);
    const ext = path.extname(entry.file).slice(1).toLowerCase();
    if (!MIME[ext]) throw new Error(`format non supporté : ${entry.file}`);
    if (buffer.length > MAX_BYTES) throw new Error(`${entry.file} dépasse 256 Ko`);

    const current = known.get(entry.name);
    if (current && !force) {
      result[entry.name] = { id: current.id, animated: Boolean(current.animated) };
      console.log(`＝ ${entry.name} déjà présent (${entry.use})`);
      continue;
    }

    if (dryRun) {
      console.log(`… ${entry.name} serait créé depuis ${entry.file} (${entry.use})`);
      continue;
    }

    const created = await api(token, 'POST', `/applications/${appId}/emojis`, {
      name: entry.name,
      image: `data:${MIME[ext]};base64,${buffer.toString('base64')}`,
    });
    result[entry.name] = { id: created.id, animated: Boolean(created.animated) };
    console.log(`✔ ${entry.name} créé depuis ${entry.file} (${entry.use})`);
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  if (dryRun) {
    console.log('Mode --dry-run : aucun emoji créé, aucun fichier écrit.');
    return;
  }

  // On conserve les identifiants déjà connus (emojis hors manifeste, import
  // partiel précédent) : le fichier est une table, pas un instantané.
  let previous = {};
  if (fs.existsSync(OUTPUT)) {
    try { previous = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch { previous = {}; }
  }
  const merged = { ...previous, ...result };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`\n${Object.keys(result).length} emoji(s) disponibles → ${path.relative(process.cwd(), OUTPUT)}`);
}

main().catch(error => {
  console.error(`❌ import interrompu : ${error.message}`);
  process.exit(1);
});
