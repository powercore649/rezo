'use strict';
// utils/licenseCore.js — Règles pures du système de licence REZO.
//
// Aucune dépendance à Discord, à MongoDB ni au réseau : tout est calculable et
// testable. `licenseGate` s'appuie dessus pour les décisions d'accès, ce qui
// garantit qu'une même licence est interprétée de la même façon partout
// (commande /license, portail d'accès, boutique, site).
//
// Trois notions :
//   • TYPE (kind)  : combien de serveurs la clé couvre (standard, réseau…).
//   • SIÈGES       : les serveurs réellement liés (`guildIds`, `guildId`).
//   • GRÂCE        : jours après l'expiration pendant lesquels l'accès reste
//                    ouvert, le temps de renouveler — sans quoi une carte
//                    bancaire en retard coupe le serveur à la seconde près.

const DAY_MS = 86_400_000;

// ─── Types de licence ────────────────────────────────────────────────────────
// `sellable: false` = émise uniquement par l'owner (partenaire, interne).
const KINDS = {
  essentiel: {
    id: 'essentiel', label: 'Essentiel', emoji: '🌱',
    maxGuilds: 1, sellable: true,
    description: 'Le socle communautaire : bumps, animations et alertes.',
  },
  standard: {
    id: 'standard', label: 'Standard', emoji: '🔑',
    maxGuilds: 1, sellable: true,
    description: 'Tout l’essentiel + modération, tickets, niveaux et invitations.',
  },
  network: {
    id: 'network', label: 'Réseau', emoji: '🌐',
    maxGuilds: 3, sellable: true,
    description: 'Jusqu’à trois serveurs avec une seule clé.',
  },
  partner: {
    id: 'partner', label: 'Partenaire', emoji: '🤝',
    maxGuilds: 1, sellable: false,
    description: 'Licence offerte aux partenaires, sans expiration.',
  },
  owner: {
    id: 'owner', label: 'Interne', emoji: '👑',
    maxGuilds: 10, sellable: false,
    description: 'Licence interne : jusqu’à dix serveurs.',
  },
  trial: {
    id: 'trial', label: 'Essai', emoji: '🧪',
    maxGuilds: 1, sellable: false,
    description: 'Essai gratuit, non revendable.',
  },
};

// ─── Fonctionnalités par palier ──────────────────────────────────────────────
// Chaque type de licence ouvre un ensemble précis de modules. `standard` est le
// socle premium ; `network` ajoute les modules lourds (sauvegardes, IA, carte,
// identité, protection réseau). Partenaire et interne ouvrent tout ; l'essai
// n'ouvre que le socle.
const FEATURES = {
  // Palier 1 — le socle : un serveur qui vit, sans les modules lourds.
  essentiel: [
    'bump', 'territoires', 'topserveurs', 'config',
    'anniversaire', 'anniversaire-config',
    'giveaway', 'notifications',
    'streamalerts', 'youtube-sub', 'starboard',
    'confession', 'avis', 'event', 'freegames', 'tresor',
  ],
  // Palier 2 — la communauté outillée : modération, support, progression.
  standard: [
    'ticket', 'modmail', 'onboarding',
    'antiraid', 'honeypot',
    'leveling', 'xp', 'rank',
    'invites-avance', 'invites-config',
    'recap', 'autopilote', 'authentificator',
  ],
  // Palier 3 — le réseau : identité, sauvegardes, IA, protection avancée.
  network: [
    'branding', 'starterpack', 'backup', 'imagine', 'ia',
    'partenariat', 'partenariat-config', 'carte', 'antivpn', 'pont',
  ],
};

const PREMIUM_COMMANDS = [
  ...FEATURES.essentiel,
  ...FEATURES.standard,
  ...FEATURES.network,
];

// Rang des paliers : une licence ouvre tout ce qui est à son niveau ou en dessous.
const TIER_RANK = { essentiel: 1, standard: 2, network: 3, partner: 4, owner: 4, trial: 2 };

const KEY_PATTERN = /^REZO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function kindInfo(kind) {
  return KINDS[String(kind || '').toLowerCase()] || KINDS.standard;
}

function kindIds() {
  return Object.keys(KINDS);
}

/** Types qu'un owner peut émettre depuis Discord. */
function assignableKinds() {
  return kindIds().filter(id => id !== 'trial');
}

// ─── Clés ────────────────────────────────────────────────────────────────────
/**
 * Tolère une clé recopiée à la main : sans tirets, avec des espaces ou des
 * minuscules. `REZO abcd efgh ijkl mnop` → `REZO-ABCD-EFGH-IJKL-MNOP`.
 */
function normalizeKey(raw) {
  const text = String(raw || '').trim().toUpperCase();
  const compact = text.replace(/[^A-Z0-9]/g, '');
  if (!compact.startsWith('REZO')) return text.replace(/\s+/g, '');
  const body = compact.slice(4);
  if (body.length !== 16) return compact;
  return `REZO-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

function isValidKeyFormat(raw) {
  return KEY_PATTERN.test(normalizeKey(raw));
}

// ─── Sièges ──────────────────────────────────────────────────────────────────
/** Serveurs liés à une licence (compatibilité `guildId` historique incluse). */
function seatsOf(doc) {
  if (!doc) return [];
  const seats = new Set();
  for (const id of Array.isArray(doc.guildIds) ? doc.guildIds : []) {
    if (id) seats.add(String(id));
  }
  if (doc.guildId) seats.add(String(doc.guildId));
  return [...seats];
}

function maxSeatsOf(doc) {
  const declared = Number(doc?.maxGuilds);
  const fallback = kindInfo(doc?.kind).maxGuilds;
  const value = Number.isFinite(declared) && declared > 0 ? declared : fallback;
  return Math.max(1, Math.min(25, Math.floor(value)));
}

function hasSeat(doc, guildId) {
  if (!guildId) return false;
  return seatsOf(doc).includes(String(guildId));
}

function freeSeats(doc) {
  return Math.max(0, maxSeatsOf(doc) - seatsOf(doc).length);
}

function canAddSeat(doc) {
  return freeSeats(doc) > 0;
}

// ─── État ────────────────────────────────────────────────────────────────────
/** 'none' | 'active' | 'grace' | 'expired' | 'revoked' */
function computeStatus(doc, now = Date.now()) {
  if (!doc) return 'none';
  if (doc.revoked) return 'revoked';
  if (!doc.expiresAt) return 'active';

  const expires = new Date(doc.expiresAt).getTime();
  if (!Number.isFinite(expires)) return 'active';
  if (now <= expires) return 'active';

  const graceMs = Math.max(0, Number(doc.graceDays) || 0) * DAY_MS;
  return now <= expires + graceMs ? 'grace' : 'expired';
}

/** Un accès est ouvert en licence active COMME pendant la période de grâce. */
function hasAccess(doc, now = Date.now()) {
  const status = computeStatus(doc, now);
  return status === 'active' || status === 'grace';
}

/** Jours restants (0 pendant la grâce), `null` si illimitée. */
function daysLeft(doc, now = Date.now()) {
  if (!doc || !doc.expiresAt) return null;
  const expires = new Date(doc.expiresAt).getTime();
  if (!Number.isFinite(expires)) return null;
  return Math.max(0, Math.ceil((expires - now) / DAY_MS));
}

/** Fin réelle de l'accès (expiration + grâce), `null` si illimitée. */
function accessEndsAt(doc) {
  if (!doc || !doc.expiresAt) return null;
  const expires = new Date(doc.expiresAt).getTime();
  if (!Number.isFinite(expires)) return null;
  return new Date(expires + Math.max(0, Number(doc.graceDays) || 0) * DAY_MS);
}

/** Décision d'accès pour un serveur précis — pure, donc testable. */
function accessFor(doc, guildId, now = Date.now()) {
  if (!doc) return { ok: false, reason: 'no_license', status: 'none' };

  const status = computeStatus(doc, now);
  if (status === 'revoked') return { ok: false, reason: 'revoked', status };
  if (status === 'expired') return { ok: false, reason: 'expired', status };
  if (!hasSeat(doc, guildId)) return { ok: false, reason: 'no_seat', status };
  return { ok: true, reason: status === 'grace' ? 'grace' : 'licensed', status };
}

// ─── Droits par palier ───────────────────────────────────────────────────────
/** Palier minimal qui ouvre une fonctionnalité ('standard' | 'network' | null). */
function requiredKindFor(feature) {
  const name = String(feature || '').toLowerCase();
  if (FEATURES.network.includes(name)) return 'network';
  if (FEATURES.standard.includes(name)) return 'standard';
  if (FEATURES.essentiel.includes(name)) return 'essentiel';
  return null;
}

/**
 * Ce type de licence ouvre-t-il cette fonctionnalité ?
 *
 * Le palier couvre tout ce qui est à son niveau ou en dessous ; l'essai
 * gratuit a le rang Standard (socle + communauté), jamais le réseau.
 *
 * `extras` = modules apportés par un PACK acheté en plus : ils ouvrent leur
 * fonctionnalité même si le palier, seul, ne la donnerait pas. C'est ce qui
 * distingue un pack d'une licence individuelle.
 */
function featureAllowed(kind, feature, extras = []) {
  const name = String(feature || '').toLowerCase();
  const granted = (Array.isArray(extras) ? extras : []).map(extra => String(extra).toLowerCase());
  if (granted.includes(name)) return true;

  const required = requiredKindFor(name);
  if (!required) return true;
  return (TIER_RANK[kindInfo(kind).id] || 1) >= (TIER_RANK[required] || 1);
}

function featuresForKind(kind) {
  return PREMIUM_COMMANDS.filter(feature => featureAllowed(kind, feature));
}

/** Modules ouverts par un palier ET ses extras, sans doublon. */
function featuresFor(kind, extras = []) {
  return PREMIUM_COMMANDS.filter(feature => featureAllowed(kind, feature, extras));
}

/** Pourcentage de la période écoulée (affichage), 100 si expirée. */
function progressPercent(doc, now = Date.now()) {
  if (!doc || !doc.expiresAt) return 100;
  const expires = new Date(doc.expiresAt).getTime();
  if (!Number.isFinite(expires)) return 100;
  const total = Number(doc.durationDays) > 0
    ? Number(doc.durationDays) * DAY_MS
    : Math.max(DAY_MS, expires - new Date(doc.activatedAt || doc.createdAt || expires).getTime());
  const remaining = expires - now;
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
}

module.exports = {
  DAY_MS,
  KINDS,
  FEATURES,
  TIER_RANK,
  PREMIUM_COMMANDS,
  requiredKindFor,
  featureAllowed,
  featuresForKind,
  featuresFor,
  KEY_PATTERN,
  kindInfo,
  kindIds,
  assignableKinds,
  normalizeKey,
  isValidKeyFormat,
  seatsOf,
  maxSeatsOf,
  hasSeat,
  freeSeats,
  canAddSeat,
  computeStatus,
  hasAccess,
  daysLeft,
  accessEndsAt,
  accessFor,
  progressPercent,
};
