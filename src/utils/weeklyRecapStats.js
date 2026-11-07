'use strict';
// utils/weeklyRecapStats.js — Calculs purs du récap hebdomadaire d'activité.
//
// Ce module ne dépend d'AUCUNE librairie externe (pas de discord.js, pas de
// mongoose) afin de rester testable hors-ligne et réutilisable. Toute la
// logique « métier » (deltas, top membres, correspondance cron) vit ici ; le
// moteur weeklyRecap.js ne s'occupe que de la base de données et de l'embed.

// ── Correspondance d'expression cron (5 champs, minute près) ─────────────────
// Utilisée pour déclencher le récap par-guilde sans recréer une tâche node-cron
// à chaque modification. Champs : min heure jourDuMois mois jourDeSemaine.

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cronFieldMatches(field, value) {
  return field.split(',').some(part => {
    part = part.trim();

    if (part === '*') return true;

    if (part.includes('/')) {
      const [range, stepRaw] = part.split('/');
      const step = parseInt(stepRaw, 10);
      if (!step || step <= 0) return false;
      if (range === '*') return value % step === 0;
      const [from, to] = range.split('-').map(n => parseInt(n, 10));
      if (!Number.isFinite(from)) return false;
      const end = Number.isFinite(to) ? to : from;
      return value >= from && value <= end && (value - from) % step === 0;
    }

    if (part.includes('-')) {
      const [from, to] = part.split('-').map(n => parseInt(n, 10));
      return Number.isFinite(from) && Number.isFinite(to) && value >= from && value <= to;
    }

    return parseInt(part, 10) === value;
  });
}

function cronMatchesNow(expr, date = new Date()) {
  if (typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;
  return cronFieldMatches(min, date.getMinutes())
    && cronFieldMatches(hour, date.getHours())
    && cronFieldMatches(dom, date.getDate())
    && cronFieldMatches(month, date.getMonth() + 1)
    && cronFieldMatches(dow, date.getDay());
}

// ── Instantané à partir des documents XP ─────────────────────────────────────
// docs : [{ userId, messages, totalXp }]
// Retourne l'instantané stocké dans WeeklyRecap.snapshot.
function buildSnapshot(docs = [], memberCount = 0, takenAt = new Date()) {
  const perUserMessages = {};
  let totalMessages = 0;
  let totalXp = 0;

  for (const doc of docs) {
    if (!doc || !doc.userId) continue;
    const messages = num(doc.messages);
    totalMessages += messages;
    totalXp += num(doc.totalXp);
    if (messages > 0) perUserMessages[doc.userId] = messages;
  }

  return { takenAt, totalMessages, totalXp, memberCount: num(memberCount), perUserMessages };
}

// ── Deltas entre deux instantanés ────────────────────────────────────────────
// current / previous : { totalMessages, totalXp, memberCount, perUserMessages }
// Tous les deltas sont bornés à >= 0 (sauf l'évolution des membres, qui peut
// être négative) : un instantané corrompu ou une purge de données ne doit pas
// produire de statistiques absurdes.
function computeRecapStats(current = {}, previous = {}) {
  const cur = {
    totalMessages: num(current.totalMessages),
    totalXp: num(current.totalXp),
    memberCount: num(current.memberCount),
    perUserMessages: current.perUserMessages && typeof current.perUserMessages === 'object'
      ? current.perUserMessages
      : {},
  };
  const prev = {
    totalMessages: num(previous.totalMessages),
    totalXp: num(previous.totalXp),
    memberCount: num(previous.memberCount),
    perUserMessages: previous.perUserMessages && typeof previous.perUserMessages === 'object'
      ? previous.perUserMessages
      : {},
  };

  const ids = new Set([
    ...Object.keys(cur.perUserMessages),
    ...Object.keys(prev.perUserMessages),
  ]);

  const perUser = [];
  for (const userId of ids) {
    const gained = num(cur.perUserMessages[userId]) - num(prev.perUserMessages[userId]);
    if (gained > 0) perUser.push({ userId, messages: gained });
  }
  perUser.sort((a, b) => b.messages - a.messages);

  return {
    messages:    Math.max(0, cur.totalMessages - prev.totalMessages),
    xp:          Math.max(0, cur.totalXp - prev.totalXp),
    memberDelta: cur.memberCount - prev.memberCount,
    memberCount: cur.memberCount,
    perUser,
    topMembers:  perUser.slice(0, 5),
    activeMembers: perUser.length,
  };
}

module.exports = {
  cronMatchesNow,
  cronFieldMatches,
  buildSnapshot,
  computeRecapStats,
};
