'use strict';
// utils/canvasFallback.js — moteur d'images neutre quand le binaire natif manque.
//
// `@napi-rs/canvas` est une dépendance native optionnelle : sur un hôte où le
// paquet correspondant à la plateforme n'a pas été installé (bug npm des
// dépendances optionnelles, conteneur ARM/Windows mélangé, `icudtl.dat` absent),
// son `require` lève « Cannot find native binding » — ou pire, avorte le
// processus.
//
// Or une dizaine de commandes, l'événement d'arrivée et un cron importent
// canvas **en haut de fichier**. Sans filet, un simple paquet natif manquant ne
// dégrade pas les visuels : il fait disparaître la commande entière du bot
// (/welcome, /leveling, /captcha, /tresor, /xp, le message de bienvenue…), sans
// que les membres comprennent pourquoi.
//
// Ce module fournit un moteur de secours : mêmes exports (`createCanvas`,
// `loadImage`, `GlobalFonts`), dessins sans effet, image PNG valide et vide en
// sortie. Les modules se chargent, les panneaux restent pilotables, seuls les
// visuels sont omis.
//
// Trois déclencheurs :
//   • `MEDIA_CARDS=0` (ou l'ancien `MUSIC_CARD=0`) — choix explicite d'un hôte
//     sans images, qui évite même de charger le natif (donc tout crash natif) ;
//   • un `require` de module qui échoue à cause de canvas (core/registry.js) ;
//   • `installCanvasStub()` appelé explicitement.

const Module = require('module');

const CANVAS_MODULE = '@napi-rs/canvas';

// PNG 1×1 transparent : une image valide, jamais un fichier corrompu que
// Discord refuserait (50035 Invalid Form Body).
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

let stubbed = false;
let stubReason = '';
let stubExports = null;
let originalLoad = null;

function emptyImageData(width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, colorSpace: 'srgb' };
}

// Contexte 2D neutre : toute méthode de dessin existe et ne fait rien, les
// valeurs lues (mesures, dégradés) sont des objets inoffensifs et cohérents.
function createStubContext(canvas) {
  const gradient = { addColorStop() {} };
  const target = { canvas };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop !== 'string') return undefined;
      return (...args) => {
        switch (prop) {
          case 'measureText':
            return { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 };
          case 'createLinearGradient':
          case 'createRadialGradient':
          case 'createConicGradient':
          case 'createPattern':
            return gradient;
          case 'getImageData':
            return emptyImageData(args[2], args[3]);
          case 'createImageData':
            return emptyImageData(args[0], args[1]);
          case 'isPointInPath':
          case 'isPointInStroke':
            return false;
          default:
            return undefined;
        }
      };
    },
    set(obj, prop, value) {
      obj[prop] = value;
      return true;
    },
  });
}

class StubCanvas {
  constructor(width, height) {
    this.width = Number(width) || 0;
    this.height = Number(height) || 0;
    this._context = null;
  }

  getContext() {
    if (!this._context) this._context = createStubContext(this);
    return this._context;
  }

  toBuffer() { return BLANK_PNG; }
  toDataURL() { return `data:image/png;base64,${BLANK_PNG.toString('base64')}`; }
  encodeSync() { return BLANK_PNG; }
  encode() { return Promise.resolve(BLANK_PNG); }
  data() { return Promise.resolve(BLANK_PNG); }
}

function createStubModule() {
  if (stubExports) return stubExports;
  stubExports = {
    __stub: true,
    createCanvas: (width, height) => new StubCanvas(width, height),
    Canvas: StubCanvas,
    Image: class StubImage {},
    loadImage: () => Promise.reject(new Error('rendu des images indisponible (canvas absent)')),
    GlobalFonts: {
      families: [],
      has: () => false,
      register: () => false,
      registerFromPath: () => false,
      registerFromBuffer: () => false,
    },
    Path2D: class StubPath2D {
      moveTo() {} lineTo() {} arc() {} rect() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {}
    },
  };
  return stubExports;
}

/** Le moteur de secours est-il actif dans ce processus ? */
function isStubbed() { return stubbed; }

/** Raison pour laquelle le moteur de secours a été activé ('' sinon). */
function stubReasonText() { return stubReason; }

/**
 * Active le moteur d'images neutre. Idempotent : un second appel ne fait rien.
 * @param {{ reason?: string, quiet?: boolean }} options
 * @returns {boolean} true si le repli est actif
 */
function installCanvasStub({ reason = '', quiet = false } = {}) {
  if (stubbed) return true;
  const stub = createStubModule();

  // Le remplacement se fait à la résolution : il couvre aussi le cas où le
  // paquet n'est pas installé du tout (require → MODULE_NOT_FOUND).
  originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === CANVAS_MODULE) return stub;
    return originalLoad.call(this, request, parent, isMain);
  };

  stubbed = true;
  stubReason = reason;
  if (!quiet) {
    console.warn(
      `⚠️ Moteur d'images neutre activé${reason ? ` (${reason})` : ''} : `
      + 'les visuels seront omis, toutes les commandes restent disponibles.',
    );
  }
  return true;
}

/**
 * Active le repli si l'environnement demande un hôte sans images.
 * À appeler AVANT le chargement des commandes (core/kernel.js).
 * @returns {boolean} true si le repli est actif
 */
function prepareCanvas(env = process.env) {
  const disabled = env?.MEDIA_CARDS === '0' || env?.MUSIC_CARD === '0';
  if (!disabled) return stubbed;
  return installCanvasStub({ reason: 'MEDIA_CARDS=0' });
}

/**
 * L'erreur vient-elle de canvas ? (binaire natif absent, module introuvable…)
 * @param {Error} err
 */
function isCanvasLoadError(err) {
  if (!err) return false;
  const text = [err.message, err.stack, Array.isArray(err.requireStack) ? err.requireStack.join(' ') : '']
    .filter(Boolean).join(' ');
  return /@napi-rs[\\/]canvas|napi-rs|native binding|icudtl/i.test(text);
}

/** Test uniquement : rend le vrai module canvas aux require suivants. */
function resetCanvasStub() {
  if (originalLoad) Module._load = originalLoad;
  stubbed = false;
  stubReason = '';
  stubExports = null;
  originalLoad = null;
  try { delete require.cache[require.resolve(CANVAS_MODULE)]; } catch { /* pas installé */ }
}

module.exports = {
  CANVAS_MODULE,
  BLANK_PNG,
  installCanvasStub,
  prepareCanvas,
  isCanvasLoadError,
  isStubbed,
  stubReasonText,
  resetCanvasStub,
};
