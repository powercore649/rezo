#!/usr/bin/env node
'use strict';
// scripts/install-media-tools.js — installe les binaires du module musique.
//
//   npm run music:setup     télécharge ce qui manque dans bin/
//   npm run music:check     vérifie seulement (code de sortie 1 si incomplet)
//
// Aucun Java, aucun Python, aucun Lavalink : uniquement yt-dlp et ffmpeg.
const path = require('path');
const { ensureMediaTools, BIN_DIR } = require('../src/utils/mediaTools');

async function main() {
  const checkOnly = process.argv.includes('--check');
  console.log(`🎵 Outils audio — dossier ${path.relative(process.cwd(), BIN_DIR) || BIN_DIR}`);

  const tools = await ensureMediaTools({ download: !checkOnly });

  const line = (label, tool) => {
    if (tool.path) console.log(`✅ ${label.padEnd(7)} ${String(tool.version).slice(0, 60)}  (${tool.path})`);
    else console.log(`❌ ${label.padEnd(7)} absent${tool.error ? ` — ${tool.error}` : ''}`);
  };
  line('yt-dlp', tools.ytdlp);
  line('ffmpeg', tools.ffmpeg);

  if (tools.ready) {
    console.log('\n✅ Moteur musique prêt (Lavalink inutile).');
    return 0;
  }
  console.log('\n❌ Outils incomplets. Relance `npm run music:setup` avec un accès réseau, ou renseigne YTDLP_PATH / FFMPEG_PATH.');
  return 1;
}

main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error('❌ Échec :', err.message);
    process.exit(1);
  });
