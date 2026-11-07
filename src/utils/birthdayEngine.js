'use strict';
// utils/birthdayEngine.js — Logique pure du système d'anniversaire.
//
// Ce module ne touche ni Discord ni MongoDB : il ne manipule que des dates, des
// chaînes et des listes. C'est ce qui permet de tester les cas qui cassent en
// production — 29 février, changement d'année, fuseau horaire, heure d'annonce,
// tri des prochains anniversaires — sans réseau ni base.
//
// Décisions prises ici et assumées :
//   • Un 29 février est souhaité le 28 février les années non bissextiles.
//   • « Aujourd'hui » est calculé dans le fuseau configuré du serveur, jamais
//     dans celui de la machine d'hébergement.
//   • Une date d'anniversaire ne peut pas être le 30 février : la validation est
//     faite sur les jours réels du mois (février accepte 29).
//   • {age} n'est rempli que si l'appelant le fournit : l'année de naissance
//     reste privée par défaut.

const MONTH_NAMES = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

// Jours réels par mois ; février accepte 29 pour les années bissextiles.
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const DEFAULT_TIMEZONE = 'Europe/Paris';
const DEFAULT_HOUR = 9;
const DEFAULT_MESSAGE =
  "🎉 Joyeux anniversaire {user} ! Toute l'équipe de {server} te souhaite une excellente journée !";

const TIMEZONE_CHOICES = [
  { label: 'Paris (France)', value: 'Europe/Paris' },
  { label: 'Bruxelles (Belgique)', value: 'Europe/Brussels' },
  { label: 'Genève (Suisse)', value: 'Europe/Zurich' },
  { label: 'Montréal (Canada)', value: 'America/Montreal' },
  { label: 'UTC', value: 'UTC' },
  { label: 'Dakar (Sénégal)', value: 'Africa/Dakar' },
  { label: 'Abidjan (Côte d’Ivoire)', value: 'Africa/Abidjan' },
  { label: 'Casablanca (Maroc)', value: 'Africa/Casablanca' },
  { label: 'Pointe-à-Pitre (Guadeloupe)', value: 'America/Guadeloupe' },
  { label: 'Saint-Denis (La Réunion)', value: 'Indian/Reunion' },
  { label: 'Papeete (Polynésie)', value: 'Pacific/Tahiti' },
];

function isLeapYear(year) {
  const y = Number(year);
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function isValidTimeZone(timezone) {
  const tz = String(timezone || '').trim();
  if (!tz || tz.length > 64 || !/^[A-Za-z]/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Valide une date d'anniversaire réelle.
 * @returns {{ok: boolean, error?: string}}
 */
function validateDate(day, month, year = null) {
  const d = Number(day);
  const m = Number(month);
  if (!Number.isInteger(d) || !Number.isInteger(m) || m < 1 || m > 12) {
    return { ok: false, error: 'Le mois doit être compris entre 1 et 12.' };
  }
  if (!Number.isInteger(d) || d < 1 || d > MONTH_DAYS[m - 1]) {
    return { ok: false, error: `${MONTH_NAMES[m - 1]} ne compte pas ${d} jour(s).` };
  }
  if (year !== null && year !== undefined) {
    const y = Number(year);
    const current = new Date().getFullYear();
    if (!Number.isInteger(y) || y < 1900 || y > current) {
      return { ok: false, error: 'L’année doit être comprise entre 1900 et cette année.' };
    }
    // 29 février d'une année non bissextile : la date est acceptée (on la
    // souhaitera le 28), mais l'année fournie ne doit pas être incohérente.
    if (m === 2 && d === 29 && !isLeapYear(y)) {
      return { ok: true, warning: `${y} n’était pas bissextile : l’anniversaire sera souhaité le 28 février.` };
    }
  }
  return { ok: true };
}

/**
 * Date/heure locales d'un fuseau donné, sous une forme stable et comparable.
 */
function partsInTimeZone(date, timezone = DEFAULT_TIMEZONE) {
  const tz = isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const part of fmt.formatToParts(date instanceof Date ? date : new Date(date))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  return { year, month, day, hour, key: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, timezone: tz };
}

/** Numéro de jour absolu (UTC) — sert à comparer des dates sans heure. */
function dayNumber({ year, month, day }) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Occurrence d'un anniversaire dans une année donnée (29/02 → 28/02). */
function occurrenceInYear(day, month, year) {
  if (Number(month) === 2 && Number(day) === 29 && !isLeapYear(year)) {
    return { year, month: 2, day: 28, adjusted: true };
  }
  return { year, month: Number(month), day: Number(day), adjusted: false };
}

/** L'anniversaire tombe-t-il aujourd'hui (29/02 compris, années non bissextiles) ? */
function isBirthdayOn(birthday, today) {
  const month = Number(birthday?.month);
  const day = Number(birthday?.day);
  if (!month || !day) return false;
  if (month === today.month && day === today.day) return true;
  return month === 2 && day === 29 && today.month === 2 && today.day === 28 && !isLeapYear(today.year);
}

/**
 * Prochaine occurrence d'un anniversaire, avec le nombre de jours restants.
 * @param {number} day
 * @param {number} month
 * @param {{year:number, month:number, day:number}} today
 */
function nextOccurrence(day, month, today) {
  const d = Number(day);
  const m = Number(month);
  let occurrence = occurrenceInYear(d, m, today.year);
  if (dayNumber(occurrence) < dayNumber(today)) {
    occurrence = occurrenceInYear(d, m, today.year + 1);
  }
  return {
    ...occurrence,
    daysUntil: dayNumber(occurrence) - dayNumber(today),
    label: formatDate(occurrence.day, occurrence.month),
  };
}

function formatDate(day, month) {
  const m = Number(month);
  if (!MONTH_NAMES[m - 1]) return `${day}`;
  return `${Number(day)} ${MONTH_NAMES[m - 1]}`;
}

/** Trie des anniversaires par proximité (aujourd'hui d'abord). */
function sortUpcoming(birthdays, today) {
  return (birthdays || [])
    .map(item => ({ ...item, next: nextOccurrence(item.day, item.month, today) }))
    .sort((a, b) => a.next.daysUntil - b.next.daysUntil
      || a.next.month - b.next.month
      || a.next.day - b.next.day)
    .map(item => ({ ...item, daysUntil: item.next.daysUntil, label: item.next.label }));
}

/** Remplace les variables connues ; laisse les autres intactes. */
function renderMessage(template, { user = '', server = '', age = null } = {}) {
  let text = String(template || DEFAULT_MESSAGE);
  text = text.replace(/\{user\}/g, user).replace(/\{server\}/g, server);
  if (age !== null && age !== undefined) text = text.replace(/\{age\}/g, String(age));
  return text;
}

function sanitizeHour(value, fallback = DEFAULT_HOUR) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.trunc(n);
  if (rounded < 0 || rounded > 23) return fallback;
  return rounded;
}

function sanitizeTimezone(value, fallback = DEFAULT_TIMEZONE) {
  return isValidTimeZone(value) ? String(value).trim() : fallback;
}

/** L'heure d'annonce est-elle atteinte dans le fuseau du serveur ? */
function isAnnounceTime(today, announceHour) {
  return Number(today.hour) >= sanitizeHour(announceHour);
}

module.exports = {
  MONTH_NAMES,
  MONTH_DAYS,
  DEFAULT_TIMEZONE,
  DEFAULT_HOUR,
  DEFAULT_MESSAGE,
  TIMEZONE_CHOICES,
  isLeapYear,
  isValidTimeZone,
  validateDate,
  partsInTimeZone,
  dayNumber,
  occurrenceInYear,
  isBirthdayOn,
  nextOccurrence,
  formatDate,
  sortUpcoming,
  renderMessage,
  sanitizeHour,
  sanitizeTimezone,
  isAnnounceTime,
};
