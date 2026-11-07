'use strict';
// utils/canvasProbe.js — le binaire canvas peut-il dessiner sur cette machine ?
//
// Sur certains postes Windows, `@napi-rs/canvas` n'a pas son fichier `icudtl.dat`
// et **avorte le processus** (pas une exception : un crash natif) dès le premier
// `createCanvas`. Autrement dit, une image qui échoue ne dégrade pas l'affichage :
// elle tue le bot.
//
// On teste donc le rendu UNE fois, dans un processus enfant. Si l'enfant crashe,
// le module qui voulait dessiner publie son panneau sans image et reste
// pilotable. Le coût est un seul démarrage de Node (~300 ms), la réponse étant
// mémorisée pour tout le processus.
//
// `MEDIA_CARDS=0` (ou l'ancien `MUSIC_CARD=0`) court-circuite la sonde : hôte
// volontairement sans images.

const { execFile } = require('child_process');
const { isStubbed } = require('./canvasFallback');

let cached = null;

function canvasAvailable({ force = false } = {}) {
  // Moteur de secours actif : inutile de lancer un processus enfant pour
  // constater ce que l'on sait déjà, aucun visuel ne sera produit.
  if (isStubbed()) {
    cached = Promise.resolve(false);
    return cached;
  }
  if (cached && !force) return cached;

  cached = new Promise(resolve => {
    if (process.env.MEDIA_CARDS === '0' || process.env.MUSIC_CARD === '0') return resolve(false);

    let modulePath;
    try {
      modulePath = require.resolve('@napi-rs/canvas');
    } catch {        console.warn('⚠️ @napi-rs/canvas introuvable — les visuels (musique, cartes) seront omis.');
      return resolve(false);
    }

    const code = [
      `const { createCanvas } = require(${JSON.stringify(modulePath)});`,
      'const canvas = createCanvas(16, 16);',
      "const ctx = canvas.getContext('2d');",
      "ctx.fillRect(0, 0, 8, 8);",
      "ctx.font = '12px Sans';",
      "ctx.fillText('ok', 1, 12);", // le crash ICU survient au rendu de texte
      "const buffer = canvas.toBuffer('image/png');",
      'process.exit(buffer.length > 50 ? 0 : 1);',
    ].join('');

    const child = execFile(process.execPath, ['-e', code], { timeout: 10000, windowsHide: true }, err => {
      if (err) {
        console.warn('⚠️ Rendu canvas indisponible sur cette machine — les visuels seront omis (les panneaux restent complets).');
      }
      resolve(!err);
    });
    child.on('error', () => resolve(false));
  });

  return cached;
}

function resetCanvasProbe() { cached = null; }

module.exports = { canvasAvailable, resetCanvasProbe };
