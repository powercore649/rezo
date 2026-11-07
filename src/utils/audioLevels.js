'use strict';
// utils/audioLevels.js — l’égaliseur écoute vraiment la radio.
//
// Le flux radio est déjà décodé par ffmpeg en PCM 16 bits avant d’être envoyé à
// Discord. On se branche sur ce tuyau (`createTap`) et on mesure le spectre au
// vol : les barres de la carte suivent donc le morceau réellement diffusé, pas
// une animation décorative.
//
// Contraintes tenues ici :
//   • **Ne jamais toucher au son.** Le tap est un `Transform` qui analyse puis
//     relaie l’octet qu’il reçoit ; toute erreur d’analyse est avalée.
//   • **Coût borné.** FFT radix-2 de 1024 points, une seule par 21 ms de son
//     (≈ 47/s), soit un peu moins de 0,5 M d’opérations par seconde et par
//     serveur.
//   • **Fluidité.** La carte n’est réaffichée qu’une fois par seconde environ :
//     des niveaux instantanés donneraient des barres qui sautent. On applique
//     donc une enveloppe (attaque rapide, relâchement lent) et un gain
//     automatique, si bien que l’image montre l’énergie du morceau plutôt que
//     des pics isolés.
//
// Aucune dépendance : pas de FFT native, pas de module audio.

const { Transform } = require('stream');

const DEFAULT_BANDS = 40;
const DEFAULT_FFT = 1024;
const DEFAULT_RATE = 48000;
const DEFAULT_CHANNELS = 2;

// ── FFT radix-2 en place (pure) ────────────────────────────────────────────
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    const half = len / 2;
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const a = start + k;
        const b = a + half;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nextCr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nextCr;
      }
    }
  }
}

// ── Découpage en bandes (pure) ─────────────────────────────────────────────
/**
 * Bandes logarithmiques : autant de place pour les graves que pour les aigus,
 * comme une oreille, plutôt que 40 bandes linéaires dont 30 inaudibles.
 * @returns {Array<{from:number,to:number}>} bornes de bins FFT
 */
function bandEdges(bands = DEFAULT_BANDS, fftSize = DEFAULT_FFT, sampleRate = DEFAULT_RATE, minFreq = 45, maxFreq = 16000) {
  const binWidth = sampleRate / fftSize;
  const half = fftSize / 2;
  const ratio = Math.pow(maxFreq / minFreq, 1 / bands);
  const edges = [];
  for (let index = 0; index < bands; index += 1) {
    const low = minFreq * Math.pow(ratio, index);
    const high = low * ratio;
    const from = Math.max(1, Math.min(half - 1, Math.round(low / binWidth)));
    const to = Math.max(from, Math.min(half - 1, Math.round(high / binWidth) - 1));
    edges.push({ from, to });
  }
  return edges;
}

function clamp01(value) {
  return value <= 0 ? 0 : (value >= 1 ? 1 : value);
}

// ── Compteur de niveaux ────────────────────────────────────────────────────
/**
 * @param {object} options
 * @param {number} [options.bands]       nombre de barres (40 par défaut)
 * @param {number} [options.sampleRate]  fréquence du PCM (48000 pour ffmpeg ici)
 * @param {number} [options.channels]    canaux du PCM (2)
 * @param {number} [options.attackMs]    montée d’une barre (220 ms)
 * @param {number} [options.releaseMs]   descente d’une barre (1,1 s)
 */
function createLevelMeter({
  bands = DEFAULT_BANDS,
  fftSize = DEFAULT_FFT,
  sampleRate = DEFAULT_RATE,
  channels = DEFAULT_CHANNELS,
  minFreq = 45,
  maxFreq = 16000,
  silenceDb = -62,
  rangeDb = 24,
  curve = 0.65,
  referenceDecayDbPerSecond = 1.2,
  attackMs = 220,
  releaseMs = 1100,
  tiltDbPerOctave = 4,
} = {}) {
  const edges = bandEdges(bands, fftSize, sampleRate, minFreq, maxFreq);
  // Correction de pente : la musique concentre son énergie dans les graves, et
  // sans ce tilt les dernières bandes resteraient éteintes en permanence.
  const tilt = new Float32Array(bands);
  for (let band = 0; band < bands; band += 1) {
    const centerBin = (edges[band].from + edges[band].to) / 2;
    const centerFreq = Math.max(40, centerBin * (sampleRate / fftSize));
    tilt[band] = Math.max(-18, Math.min(24, tiltDbPerOctave * Math.log2(centerFreq / 500)));
  }
  const samples = new Float32Array(fftSize);
  const window = new Float32Array(fftSize);
  for (let index = 0; index < fftSize; index += 1) {
    // Hann : évite que la coupure du bloc crée des aiguilles spectrales.
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1));
  }

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const dbs = new Float32Array(bands);
  const levels = new Float32Array(bands);
  const frameBytes = channels * 2;

  const hopSeconds = fftSize / sampleRate;
  const attack = 1 - Math.exp(-hopSeconds / (Math.max(1, attackMs) / 1000));
  const release = 1 - Math.exp(-hopSeconds / (Math.max(1, releaseMs) / 1000));
  // Référence de niveau : elle monte immédiatement sur un pic et redescend
  // lentement. Elle vaut mieux qu’un maximum par image (qui rendait la carte
  // uniformément pleine sur une radio compressée comme FIP).
  const referenceStep = Math.max(0, referenceDecayDbPerSecond) * hopSeconds;

  let leftover = Buffer.alloc(0);
  let filled = 0;
  let frames = 0;
  let referenceDb = -Infinity;

  function analyse() {
    for (let index = 0; index < fftSize; index += 1) {
      re[index] = samples[index] * window[index];
      im[index] = 0;
    }
    fftInPlace(re, im);

    let maxDb = -Infinity;
    for (let band = 0; band < bands; band += 1) {
      const { from, to } = edges[band];
      let energy = 0;
      for (let bin = from; bin <= to; bin += 1) energy += re[bin] * re[bin] + im[bin] * im[bin];
      const count = Math.max(1, to - from + 1);
      // Amplitude approximative du contenu de la bande (une sinusoïde pleine
      // échelle donne 1 avec cette normalisation).
      const amplitude = Math.sqrt(energy / count) / (fftSize / 4);
      const db = 20 * Math.log10(amplitude + 1e-9) + tilt[band];
      dbs[band] = db;
      if (db > maxDb) maxDb = db;
    }

    // Échelle relative à une référence lente : les barres gardent leur pente
    // naturelle (graves plus forts) et bougent avec les variations du morceau.
    // Sous le seuil de silence, tout retombe à zéro — la radio se tait, l’image
    // aussi.
    referenceDb = maxDb > referenceDb ? maxDb : referenceDb - referenceStep;
    const audible = maxDb > silenceDb;
    for (let band = 0; band < bands; band += 1) {
      const raw = audible ? clamp01(1 - (referenceDb - dbs[band]) / rangeDb) : 0;
      // Courbe douce : sans elle, une radio compressée donne des barres
      // timides (toutes autour de 0,3) au lieu d’un égaliseur lisible.
      const target = curve === 1 ? raw : Math.pow(raw, curve);
      const previous = levels[band];
      levels[band] = previous + (target - previous) * (target > previous ? attack : release);
    }
    frames += 1;
  }

  /** Analyse un bloc PCM s16le. Ne lève jamais pour un bloc inattendu. */
  function push(chunk) {
    if (!chunk || !chunk.length) return;
    const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = data.length - (data.length % frameBytes);
    for (let offset = 0; offset < usable; offset += frameBytes) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        sum += data.readInt16LE(offset + channel * 2);
      }
      samples[filled] = sum / (32768 * channels);
      filled += 1;
      if (filled >= fftSize) {
        filled = 0;
        analyse();
      }
    }
    leftover = data.subarray(usable);
    // Un flux qui n’aligne jamais ses trames ne doit pas faire grossir ce reste.
    if (leftover.length > frameBytes * 8192) leftover = Buffer.alloc(0);
  }

  /**
   * Transform qui relaie l’audio tel quel après l’avoir mesuré : le lecteur
   * reçoit exactement les mêmes octets.
   */
  function createTap() {
    return new Transform({
      transform(chunk, _encoding, done) {
        try { push(chunk); } catch { /* l’affichage ne casse jamais le son */ }
        done(null, chunk);
      },
    });
  }

  function reset() {
    leftover = Buffer.alloc(0);
    filled = 0;
    frames = 0;
    referenceDb = -Infinity;
    samples.fill(0);
    levels.fill(0);
    dbs.fill(0);
  }

  return {
    push,
    createTap,
    reset,
    levels: () => levels,
    frames: () => frames,
    bands,
  };
}

module.exports = {
  createLevelMeter,
  bandEdges,
  fftInPlace,
  DEFAULT_BANDS,
  DEFAULT_FFT,
  DEFAULT_RATE,
  DEFAULT_CHANNELS,
};
