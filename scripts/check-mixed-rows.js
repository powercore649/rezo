'use strict';
// scripts/check-mixed-rows.js — Détecte les ActionRow qui mélangent select menus
// et boutons : Discord rejette ces rangées (50035 COMPONENT_LAYOUT_WIDTH_EXCEEDED,
// un select occupe toute la largeur d'une rangée).
// Usage : node scripts/check-mixed-rows.js
const fs = require('fs');
const path = require('path');

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const f = path.join(d, e.name);
    return e.isDirectory() ? walk(f) : (f.endsWith('.js') ? [f] : []);
  });
}

let issues = 0;
for (const file of walk(path.join(__dirname, '..', 'src'))) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /new ActionRowBuilder\(\)\s*\.\s*addComponents\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    const block = src.slice(start, i + 1);
    const hasSelect = /SelectMenuBuilder/.test(block);
    const hasButton = /ButtonBuilder/.test(block);
    const selectCount = (block.match(/SelectMenuBuilder/g) || []).length;
    if (hasSelect && (hasButton || selectCount > 1)) {
      const line = src.slice(0, m.index).split('\n').length;
      console.log(`MIXTE: ${path.relative(process.cwd(), file).replace(/\\/g, '/')}:${line} (selects: ${selectCount})`);
      issues++;
    }
  }
}
console.log(`Total rangées mixtes : ${issues}`);
process.exit(issues > 0 ? 1 : 0);
