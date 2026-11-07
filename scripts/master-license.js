'use strict';
// scripts/master-license.js — Fabrique la licence maître du système de licence.
//
//   npm run master:init                → paire Ed25519 + premier jeton (365 j)
//   npm run master:sign -- --days 365  → nouveau jeton signé
//   npm run master:check               → vérifie le jeton du `.env`
//
// Ce que le script écrit :
//   • `src/data/masterLicensePublicKey.pem` — clé PUBLIQUE, versionnée : elle
//     permet à toutes les instances de vérifier, à personne de signer ;
//   • `MASTER_SIGNING_KEY` — clé PRIVÉE, dans `.env` uniquement (ignoré par git) ;
//   • `MASTER_LICENSE` — le jeton signé, dans `.env`.
//
// La clé privée n'est jamais affichée ni renvoyée dans la sortie : elle est déjà
// dans `.env`, c'est le seul endroit où elle doit exister. Sauvegarde-la à part :
// sans elle, impossible de signer un nouveau jeton (il faudra réinitialiser avec
// `--force`, ce qui invalide les jetons déjà distribués).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const master = require('../src/utils/masterLicense');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

// ── Arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) { args._.push(item); continue; }
    const name = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[name] = next; i++; }
    else args[name] = true;
  }
  return args;
}

// ── `.env` (lecture/écriture sans jamais afficher une valeur) ────────────────
function readEnv() {
  try { return fs.readFileSync(ENV_PATH, 'utf8'); } catch { return ''; }
}

function readEnvValue(key) {
  const line = readEnv().split(/\r?\n/).find(row => row.startsWith(`${key}=`));
  if (!line) return null;
  return line.slice(key.length + 1).trim() || null;
}

/** Remplace la clé dans `.env` (ou l'ajoute) sans toucher au reste du fichier. */
function writeEnvValue(key, value) {
  const lines = readEnv().split(/\r?\n/).filter(row => !row.startsWith(`${key}=`));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, { mode: 0o600 });
}

// ── Clés ─────────────────────────────────────────────────────────────────────
function readSigningKey() {
  // `MASTER_SIGNING_KEY` contient le PEM encodé en base64 (une seule ligne,
  // compatible avec un `.env` et avec les panneaux d'hébergement).
  const raw = process.env.MASTER_SIGNING_KEY || readEnvValue('MASTER_SIGNING_KEY');
  if (!raw) return null;
  try {
    const pem = raw.includes('BEGIN')
      ? raw.replace(/\\n/g, '\n')
      : Buffer.from(raw, 'base64').toString('utf8');
    return crypto.createPrivateKey(pem);
  } catch {
    return null;
  }
}

function publicKeyOf(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
}

function readRepoPublicKey() {
  try { return fs.readFileSync(master.PUBLIC_KEY_PATH, 'utf8'); } catch { return null; }
}

function sameKey(a, b) {
  if (!a || !b) return false;
  const normalize = pem => String(pem).replace(/\s+/g, '');
  return normalize(a) === normalize(b);
}

// ── Commandes ────────────────────────────────────────────────────────────────
function signWith(privateKey, { days, sub, note }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + Math.round(days * 86_400);
  const token = master.signToken({
    sub,
    iat: nowSec,
    exp: expSec,
    note: note || '',
  }, privateKey);
  writeEnvValue('MASTER_LICENSE', token);
  master.resetCache();
  const state = master.status({ token });
  if (!state.ok) {
    console.error(`✖ jeton signé mais refusé à la vérification : ${state.message}`);
    process.exitCode = 1;
    return null;
  }
  return { token, expSec };
}

function commandInit(args) {
  const existingPublic = readRepoPublicKey();
  const existingPrivate = readSigningKey();

  if (existingPublic && existingPrivate && !args.force) {
    console.log('› Licence maître déjà initialisée.');
    console.log('  Clé publique : src/data/masterLicensePublicKey.pem');
    console.log('  Clé privée   : .env (MASTER_SIGNING_KEY)');
    console.log('  Pour renouveler le jeton : npm run master:sign -- --days 365');
    console.log('  Pour tout régénérer (invalide les jetons existants) : --force');
    return commandCheck(args);
  }

  const { publicKeyPem, privateKeyPem } = master.generateKeyPair();
  fs.mkdirSync(path.dirname(master.PUBLIC_KEY_PATH), { recursive: true });
  fs.writeFileSync(master.PUBLIC_KEY_PATH, publicKeyPem, 'utf8');
  writeEnvValue('MASTER_SIGNING_KEY', Buffer.from(privateKeyPem, 'utf8').toString('base64'));

  const days = Number(args.days) || 365;
  const signed = signWith(privateKeyPem, {
    days,
    sub: args.sub || 'rezo',
    note: args.note || 'licence maître',
  });

  console.log('✔ Licence maître créée.');
  console.log('  Clé publique : src/data/masterLicensePublicKey.pem (à versionner)');
  console.log('  Clé privée   : .env → MASTER_SIGNING_KEY (ne jamais versionner)');
  console.log(`  Jeton        : .env → MASTER_LICENSE (valide jusqu’au ${signed ? new Date(signed.expSec * 1000).toLocaleString('fr-FR') : '—'})`);
  console.log('  Sauvegarde la clé privée ailleurs : sans elle, plus de signature possible.');
}

function commandSign(args) {
  const privateKey = readSigningKey();
  if (!privateKey) {
    console.error('✖ Aucune clé privée : lance d’abord `npm run master:init`.');
    process.exitCode = 1;
    return;
  }

  // Une clé privée qui ne correspond pas à la clé publique du dépôt produirait
  // un jeton que le bot refuserait : autant le dire avant d'écrire dans `.env`.
  const derived = publicKeyOf(privateKey);
  const repoKey = readRepoPublicKey();
  if (repoKey && !sameKey(derived, repoKey)) {
    console.error('✖ La clé privée du .env ne correspond pas à src/data/masterLicensePublicKey.pem.');
    console.error('  Signe avec la clé d’origine, ou régénère tout avec `npm run master:init -- --force`.');
    process.exitCode = 1;
    return;
  }

  const days = Number(args.days) || 365;
  const signed = signWith(privateKey, {
    days,
    sub: args.sub || 'rezo',
    note: args.note || 'licence maître',
  });
  if (!signed) return;

  console.log(`✔ Nouveau jeton signé pour « ${args.sub || 'rezo'} ».`);
  console.log(`  Valide jusqu’au ${new Date(signed.expSec * 1000).toLocaleString('fr-FR')}.`);
  console.log('  Écrit dans .env → MASTER_LICENSE. Redémarre le bot pour le prendre en compte.');
}

function commandCheck() {
  const token = process.env.MASTER_LICENSE || readEnvValue('MASTER_LICENSE');
  const state = master.status({ token });

  if (state.ok) {
    const until = state.expiresAt ? state.expiresAt.toLocaleString('fr-FR') : '—';
    console.log('✔ Licence maître valide.');
    console.log(`  Titulaire   : ${state.payload.sub || '—'}`);
    console.log(`  Portée      : ${state.payload.scope}`);
    console.log(`  Expire le   : ${until}`);
    return;
  }

  console.error(`✖ ${state.message}`);
  console.error(`  Motif : ${state.reason}`);
  console.error('  Corrige avec `npm run master:sign -- --days 365` (ou `master:init` si rien n’existe).');
  process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'check';

  if (command === 'init') return commandInit(args);
  if (command === 'sign') return commandSign(args);
  if (command === 'check') return commandCheck();

  console.error('Usage : node scripts/master-license.js <init|sign|check> [--days N] [--sub nom] [--note texte] [--force]');
  process.exitCode = 1;
}

main();
