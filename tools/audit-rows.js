'use strict';
// tools/audit-rows.js — Audit statique des lignes de composants construites dans src/.
//
// Règles Discord (erreurs 50035) vérifiées :
//   • une ligne ne peut contenir QU'UN SEUL composant pleine largeur
//     (String/Role/Channel/User/MentionableSelectMenu, TextInput) → sinon
//     COMPONENT_LAYOUT_WIDTH_EXCEEDED ;
//   • une ligne ne peut pas mélanger boutons et menus ;
//   • une ligne ne peut pas porter plus de 5 boutons.
//
// Chaque ligne est analysée individuellement : un modal peut légitimement
// contenir plusieurs lignes (une par champ), chacune avec un seul input.
//
// Usage : node tools/audit-rows.js
const fs = require('fs');
const path = require('path');

const FULL_WIDTH = /new\s+(String|Role|Channel|User|Mentionable)SelectMenuBuilder/;
const BUTTON = /new\s+ButtonBuilder/;
const INPUT = /new\s+TextInputBuilder/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Noms des fonctions/variables du fichier qui fabriquent un menu déroulant :
 * un sélecteur passé via `accentSelect(...)` compte comme pleine largeur, même
 * si le `new StringSelectMenuBuilder()` est à l'autre bout du fichier.
 */
function selectFactories(src) {
  const names = new Set();
  const decl = /(?:^|\n)\s*(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g;
  let m;
  while ((m = decl.exec(src))) {
    const name = m[1] || m[2];
    if (!name) continue;
    const from = m.index + m[0].length;
    const end = src.indexOf('\n}', from);
    const body = src.slice(from, end === -1 ? from + 1500 : end);
    if (/new\s+(String|Role|Channel|User|Mentionable)SelectMenuBuilder/.test(body)) names.add(name);
  }
  return names;
}

/** Contenu de la parenthèse ouvrante à `openParenIndex` (équilibrage + chaînes). */
function extractArg(src, openParenIndex) {
  let depth = 0; let inStr = null;
  for (let i = openParenIndex; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openParenIndex + 1, i); }
  }
  return src.slice(openParenIndex + 1);
}

/** Découpe une liste d'arguments au niveau 0 (virgules hors parenthèses/chaînes). */
function splitTopLevel(arg) {
  const parts = [];
  let depth = 0; let inStr = null; let cur = '';
  for (let i = 0; i < arg.length; i++) {
    const c = arg[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += arg[++i] || ''; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Retire l'enveloppe `[ ... ]` d'un argument tableau. */
function unwrapArray(chunk) {
  const t = chunk.trim();
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1);
  return chunk;
}

/** Une ligne est "nue" (tableau de composants) ou construite via ActionRowBuilder. */
function inspectRow(rowSrc) {
  const body = unwrapArray(rowSrc);
  if (/new\s+ActionRowBuilder/.test(body)) {
    // contenu réel de l'ActionRow
    const idx = body.indexOf('.addComponents(');
    if (idx >= 0) return extractArg(body, body.indexOf('(', idx));
    return body;
  }
  if (/^\s*\[/.test(body)) return unwrapArray(body);
  // heuristique : un composant seul
  return body;
}

/** Analyse tout `src/` et renvoie la liste des lignes invalides. */
function auditRows(root = path.join(__dirname, '..', 'src')) {
const problems = [];
for (const file of walk(root)) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  const factories = selectFactories(src);
  const factoryHits = body => [...factories].reduce((n, name) =>
    n + (body.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) || []).length, 0);
  const re = /\.addComponents\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split(/\r?\n/).length;
    const arg = extractArg(src, src.indexOf('(', m.index));
    const chunks = splitTopLevel(arg);

    // On ne garde que les chunks qui sont des lignes (ActionRow ou tableau) :
    // ce sont eux qu'il faut valider un par un.
    let rowsChecked = 0;
    chunks.forEach((chunk, i) => {
      const trimmed = chunk.trim();
      const isRow = /new\s+ActionRowBuilder/.test(trimmed) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
      if (!isRow) {
        // composant nu passé à addComponents (ActionRow directe) → la ligne,
        // c'est l'argument entier ; on ne le traite qu'une fois.
        return;
      }
      rowsChecked++;
      const body = inspectRow(trimmed);
      const selects = (body.match(new RegExp(FULL_WIDTH, 'g')) || []).length + factoryHits(body);
      const inputs = (body.match(new RegExp(INPUT, 'g')) || []).length;
      const buttons = (body.match(new RegExp(BUTTON, 'g')) || []).length;
      const wide = selects + inputs;
      const at = `${rel}:${line} (ligne #${rowsChecked})`;
      if (wide > 1) problems.push(`${at} → ${wide} composants pleine largeur dans la MÊME ligne`);
      if (buttons > 5) problems.push(`${at} → ${buttons} boutons dans la même ligne (max 5)`);
      if (buttons > 0 && selects > 0) problems.push(`${at} → boutons ET menus dans la même ligne (interdit)`);
    });

    // Cas d'une ActionRow montée directement : addComponents(comp, comp, ...)
    if (rowsChecked === 0 && chunks.length > 1) {
      const selects = (arg.match(new RegExp(FULL_WIDTH, 'g')) || []).length + factoryHits(arg);
      const inputs = (arg.match(new RegExp(INPUT, 'g')) || []).length;
      const buttons = (arg.match(new RegExp(BUTTON, 'g')) || []).length;
      const wide = selects + inputs;
      const at = `${rel}:${line}`;
      if (wide > 1) problems.push(`${at} → ${wide} composants pleine largeur dans la MÊME ligne`);
      if (buttons > 5) problems.push(`${at} → ${buttons} boutons dans la même ligne (max 5)`);
      if (buttons > 0 && selects > 0) problems.push(`${at} → boutons ET menus dans la même ligne (interdit)`);
    }
  }
}

  return problems;
}

module.exports = { auditRows };

if (require.main === module) {
  const problems = auditRows();
  if (!problems.length) {
    console.log('✅ Aucune ligne de composants invalide détectée.');
    process.exit(0);
  }
  console.log(`❌ ${problems.length} problème(s) détecté(s) :\n`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
