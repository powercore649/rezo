'use strict';
// utils/playbackGuard.js — Décide ce qu'on fait quand un morceau s'arrête.
//
// Pourquoi ce module : @discordjs/voice arrête le lecteur quand le flux PCM
// « manque » (underrun). Avec maxMissedFrames bas, un simple hoquet réseau de
// YouTube fait passer au morceau suivant — le fameux « il skip pour rien ».
// Ici on décide explicitement :
//   • fin normale            → morceau suivant
//   • fin prématurée         → on réessaie UNE fois le même morceau
//   • direct (live)          → jamais de reprise, on enchaîne
// Tout est pur : aucune dépendance Discord, testable seul.

const GRACE_SECONDS = 10;      // marge : la durée annoncée est rarement exacte
const MIN_STARTED_SECONDS = 3; // en dessous, la lecture n'a pas vraiment commencé

/** Clé stable d'un morceau (sert à ne réessayer qu'une fois par morceau). */
function trackKey(track) {
  if (!track) return null;
  return track.id || track.url || track.title || null;
}

/**
 * Le morceau s'est-il arrêté avant la fin annoncée ?
 * @param {number} position secondes réellement jouées
 * @param {object} track
 */
function isPrematureEnd(position, track) {
  if (!track) return false;
  if (track.live) return false;
  const duration = Number(track.duration) || 0;
  if (duration <= 0) return false; // durée inconnue : on ne devine pas
  const played = Math.max(0, Number(position) || 0);
  return played < duration - GRACE_SECONDS;
}

/**
 * Que faire de la fin d'un morceau ?
 * @param {object} track
 * @param {{ position?:number, reason?:'ended'|'error'|'stalled'|'stopped', retried?:boolean }} ctx
 * @returns {'next'|'retry'}
 */
function decideTrackEnd(track, { position = 0, reason = 'ended', retried = false } = {}) {
  if (!track) return 'next';
  if (reason === 'stopped') return 'next';    // arrêt volontaire (stop/skip)
  if (track.live) return 'next';              // un direct ne se reprend pas
  if (!isPrematureEnd(position, track)) return 'next';
  if (retried) return 'next';
  const played = Math.max(0, Number(position) || 0);
  // Un échec instantané (0 s) est souvent un blocage : une seconde chance vaut
  // le coup, mais pas trois. Au-delà d'un démarrage réel, c'est un vrai incident.
  if (played < MIN_STARTED_SECONDS) return 'retry';
  return 'retry';
}

/** Message affiché dans le panneau quand un morceau est abandonné. */
function skipNotice(track, { reason = 'error', retried = false } = {}) {
  const title = track?.title ? `**${track.title}**` : 'Le morceau';
  if (reason === 'stalled') return `⏭️ ${title} ne répond plus : je passe au suivant.`;
  if (retried) return `⏭️ ${title} a échoué deux fois : je passe au suivant.`;
  return `⏭️ ${title} n’a pas pu être lu : je passe au suivant.`;
}

module.exports = {
  GRACE_SECONDS,
  MIN_STARTED_SECONDS,
  trackKey,
  isPrematureEnd,
  decideTrackEnd,
  skipNotice,
};
