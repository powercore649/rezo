'use strict';
// utils/joinJail.js — « Salle d'attente » de Vigie : un membre dont le compte est
// trop récent n'est plus forcément expulsé. Il reste en attente (rôle d'attente)
// jusqu'à ce que son compte atteigne l'âge minimum, puis il est libéré
// automatiquement — sans intervention du staff.
//
// Toute la planification est PURE (aucun accès Discord, aucune base) : elle est
// testable hors-ligne. L'application (rôle, cron) vit dans joinGuardActions.js
// et crons/joinJail.js.

const DAY_MS = 86_400_000;

// Plafond du tableau des membres en attente : un serveur attaqué ne doit pas
// faire grossir le document indéfiniment (les entrées les plus récentes gagnent).
const MAX_ENTRIES = 500;

/**
 * Quand libérer un membre dont le compte est trop récent ?
 *
 * @param {{ accountCreatedTimestamp?:number, minAccountAgeDays?:number, now?:number }} input
 * @returns {{ releaseAt:Date, waitMs:number, fallback:boolean }}
 */
function planJailRelease({ accountCreatedTimestamp, minAccountAgeDays, now = Date.now() } = {}) {
  const days = Math.max(0, Number(minAccountAgeDays) || 0);
  const created = Number(accountCreatedTimestamp);

  // Sans date de création exploitable, on ne garde jamais quelqu'un à vie :
  // la libération est replanifiée pour être relue au prochain passage.
  if (!Number.isFinite(created)) {
    return { releaseAt: new Date(now + DAY_MS), waitMs: DAY_MS, fallback: true };
  }

  const releaseAtMs = created + days * DAY_MS;
  if (releaseAtMs <= now) return { releaseAt: new Date(now), waitMs: 0, fallback: false };
  return { releaseAt: new Date(releaseAtMs), waitMs: releaseAtMs - now, fallback: false };
}

/** Garde les `limit` entrées les plus récentes (les plus anciennes sont oubliées). */
function capJail(entries = [], limit = MAX_ENTRIES) {
  const list = [...(entries || [])].filter(Boolean);
  if (list.length <= limit) return list;
  const sorted = list.sort((a, b) => new Date(b.releaseAt || 0) - new Date(a.releaseAt || 0));
  return sorted.slice(0, Math.max(0, limit));
}

/** Entrées dont la libération est échue (à traiter maintenant). */
function dueEntries(entries = [], now = Date.now()) {
  return (entries || []).filter((e) => {
    if (!e?.userId) return false;
    const at = new Date(e.releaseAt).getTime();
    return Number.isFinite(at) && at <= now;
  });
}

/** Délai lisible : « 5 j 3 h », « 42 min », « moins d'une minute ». */
function formatWait(ms) {
  const total = Math.max(0, Number(ms) || 0);
  if (total < 60_000) return 'moins d’une minute';
  const days = Math.floor(total / DAY_MS);
  const hours = Math.floor((total % DAY_MS) / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  if (days > 0) return hours > 0 ? `${days} j ${hours} h` : `${days} j`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

module.exports = { DAY_MS, MAX_ENTRIES, planJailRelease, capJail, dueEntries, formatWait };
