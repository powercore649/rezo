'use strict';
// tests/run-all.js — point d'entrée unique des vérifications hors ligne.
//
// `npm test` n'a besoin ni de token Discord, ni de MongoDB, ni de réseau : tout
// est vérifié sur les modules du dépôt (chargement, contrats, garde-fous,
// budget de commandes, variables d'environnement documentées).
//
// Chaque fichier `tests/*.test.js` exporte `checks` : un tableau de
// { name, run } où `run` lève en cas d'échec.
//
// Sortie : code 1 dès qu'une vérification échoue, pour que la CI et un
// `npm test` manuel ne puissent pas passer à côté.

const fs = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;
const ROOT = path.join(TESTS_DIR, '..');

function listSuites() {
  return fs.readdirSync(TESTS_DIR)
    .filter(file => file.endsWith('.test.js'))
    .sort();
}

// Les scripts `npm` doivent pointer vers un fichier réel : c'est exactement le
// genre de dérive (script vers un dossier supprimé) qui casse une commande en
// production sans que personne ne s'en aperçoive.
function checkPackageScripts() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = [];
  const missingTests = [];
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    for (const match of String(command).matchAll(/node\s+([^\s&|]+\.js)/g)) {
      if (fs.existsSync(path.join(ROOT, match[1]))) continue;
      if (name.startsWith('test')) missingTests.push(`${name} → ${match[1]}`);
      else missing.push(`${name} → ${match[1]}`);
    }
  }
  return { missing, missingTests };
}

async function main() {
  let passed = 0;
  const failures = [];

  for (const file of listSuites()) {
    let suite;
    try {
      suite = require(path.join(TESTS_DIR, file));
    } catch (err) {
      failures.push({ file, name: 'chargement de la suite', err });
      console.log(`\n▶ ${file}\n  ✖ chargement de la suite — ${err.message}`);
      continue;
    }
    const checks = Array.isArray(suite?.checks) ? suite.checks : [];
    console.log(`\n▶ ${file} (${checks.length} vérification(s))`);
    for (const check of checks) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await check.run();
        passed++;
        console.log(`  ✔ ${check.name}`);
      } catch (err) {
        failures.push({ file, name: check.name, err });
        console.log(`  ✖ ${check.name} — ${err.message}`);
      }
    }
  }

  const { missing, missingTests } = checkPackageScripts();
  console.log('\n▶ package.json');
  if (missing.length) {
    for (const entry of missing) {
      failures.push({ file: 'package.json', name: `script → ${entry}`, err: new Error('fichier introuvable') });
      console.log(`  ✖ script vers un fichier absent : ${entry}`);
    }
  } else {
    passed++;
    console.log('  ✔ tous les scripts d’exécution pointent vers un fichier existant');
  }
  if (missingTests.length) {
    console.log(`  ⚠️ ${missingTests.length} suite(s) de test annoncée(s) mais absente(s) :`);
    for (const entry of missingTests) console.log(`     · ${entry}`);
  }

  const failedCount = failures.length;
  console.log(`\n${passed} vérification(s) réussie(s), ${failedCount} échec(s)`);
  if (failedCount) {
    console.log('\nDétail des échecs :');
    for (const { file, name, err } of failures) {
      console.log(`  · ${file} — ${name}\n    ${String(err.message).split('\n').slice(0, 4).join('\n    ')}`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ exécution des tests interrompue :', err);
  process.exit(1);
});
