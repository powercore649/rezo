'use strict';
// core/logger.js — Journalisation structurée du noyau v2.
//
// Remplace les console.log / console.error dispersés par un logger unique :
// niveaux filtrables, horodatage, tag de module, couleurs (si TTY) et spans de
// durée. Aucune dépendance Discord ni base de données : entièrement testable
// hors-ligne (voir tests/v2-core.js).
//
// Niveau par défaut : LOG_LEVEL si défini, sinon déduit de NODE_ENV
// (test → error, development → debug, sinon info).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const ICONS  = { debug: '🔎', info: 'ℹ️', warn: '⚠️', error: '❌' };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };

function envLevel(env = process.env) {
  if (env.LOG_LEVEL && LEVELS[env.LOG_LEVEL] !== undefined) return env.LOG_LEVEL;
  if (env.NODE_ENV === 'test') return 'error';
  if (env.NODE_ENV === 'development') return 'debug';
  return 'info';
}

let currentLevel = envLevel();
let colorize = !process.env.NO_COLOR && process.stdout && process.stdout.isTTY !== false;

function setLevel(level) {
  if (LEVELS[level] === undefined) throw new Error(`Niveau de log inconnu : ${level}`);
  currentLevel = level;
}

function getLevel() { return currentLevel; }

function configure({ level, colors } = {}) {
  if (level) setLevel(level);
  if (typeof colors === 'boolean') colorize = colors;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function inspectSafe(value) {
  try {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return String(value);
  } catch {
    return String(value);
  }
}

function emit(level, tag, args) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const msg = args.map(a => (typeof a === 'string' ? a : inspectSafe(a))).join(' ');
  const line = `${ICONS[level]} [${timestamp()}]${tag ? ` (${tag})` : ''} ${msg}`;
  const out = colorize ? `${COLORS[level]}${line}${COLORS.reset}` : line;
  if (level === 'error' || level === 'warn') process.stderr.write(`${out}\n`);
  else process.stdout.write(`${out}\n`);
}

// Crée un logger rattaché à un tag (ex. « kernel », « ticket »).
function createLogger(tag = '') {
  return {
    tag,
    debug: (...a) => emit('debug', tag, a),
    info:  (...a) => emit('info',  tag, a),
    warn:  (...a) => emit('warn',  tag, a),
    error: (...a) => emit('error', tag, a),
    child: (sub) => createLogger(tag ? `${tag}:${sub}` : sub),
    // measure() renvoie une fonction qui log le temps écoulé (ms).
    measure: (label) => {
      const t0 = Date.now();
      return () => {
        const ms = Date.now() - t0;
        emit('debug', tag, [`⏱ ${label} ${ms} ms`]);
        return ms;
      };
    },
  };
}

const logger = createLogger('rezo');

module.exports = { LEVELS, createLogger, logger, configure, setLevel, getLevel, envLevel };
