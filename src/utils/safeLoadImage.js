// utils/safeLoadImage.js — Wrapper de loadImage avec timeout strict
// Évite que le bot se bloque si le CDN Discord est lent ou indisponible
const { loadImage } = require('@napi-rs/canvas');

/**
 * Charge une image avec un timeout. Retourne null en cas d'échec/timeout
 * (le code appelant doit gérer le cas null avec un fallback visuel).
 */
async function safeLoadImage(url, timeoutMs = 4000) {
  if (!url) return null;
  try {
    return await Promise.race([
      loadImage(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('image-load-timeout')), timeoutMs)),
    ]);
  } catch (err) {
    console.warn(`[safeLoadImage] échec pour ${url.slice(0, 60)}... : ${err.message}`);
    return null;
  }
}

module.exports = { safeLoadImage };
