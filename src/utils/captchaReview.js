'use strict';
// utils/captchaReview.js — Détection d'une vérification « douteuse ».
//
// Un captcha réussi n'est pas toujours une preuve d'humanité : un script peut
// lire l'image, un membre peut deviner, ou réussir après avoir régénéré l'image
// en boucle. Ce module décide, à partir de faits mesurables, si le staff doit
// recevoir un rapport et trancher lui-même.
//
// Pur et testable hors-ligne : aucun accès Discord, aucune base.

// Un humain met rarement moins de 5 secondes à lire un captcha distordu et à
// ouvrir le modal pour répondre.
const MIN_HUMAN_MS = 5_000;

/**
 * @param {{ elapsedMs?:number, attempts?:number, regenerations?:number, minHumanMs?:number }} facts
 * @returns {{ doubtful:boolean, reasons:string[], elapsedMs:number|null }}
 */
function isDoubtful({ elapsedMs, attempts = 0, regenerations = 0, minHumanMs = MIN_HUMAN_MS } = {}) {
  const reasons = [];
  const elapsed = Number(elapsedMs);
  const hasElapsed = Number.isFinite(elapsed) && elapsed >= 0;

  if (hasElapsed && elapsed < minHumanMs) {
    reasons.push(`résolu en **${(elapsed / 1000).toFixed(1)} s** (seuil humain : ${(minHumanMs / 1000).toFixed(0)} s)`);
  }
  if (Number(attempts) >= 1) {
    reasons.push(`**${attempts}** mauvaise(s) réponse(s) avant la bonne`);
  }
  if (Number(regenerations) >= 2) {
    reasons.push(`**${regenerations}** régénération(s) d’image`);
  }

  return { doubtful: reasons.length > 0, reasons, elapsedMs: hasElapsed ? elapsed : null };
}

module.exports = { MIN_HUMAN_MS, isDoubtful };
