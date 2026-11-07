'use strict';
// utils/quoteRequest.js — Validation d'une demande de devis (Pack REZO.net).
//
// Module pur : aucune dépendance à Discord, MongoDB ou au réseau. Le serveur
// l'utilise avant d'envoyer l'e-mail, les tests l'exercent hors-ligne.
//
// Une demande n'est PAS une commande : rien n'est enregistré en base et aucune
// clé n'est créée. Le formulaire produit un message lisible, envoyé au
// propriétaire du bot.

const DURATIONS = ['3 mois', '6 mois', '1 an', 'sur mesure'];

const LIMITS = {
  name: 80,
  email: 190,
  discord: 80,
  discordId: 25,
  guildId: 32,
  guildName: 100,
  servers: 6,
  members: 12,
  duration: 20,
  startDate: 10,
  budget: 40,
  modules: 600,
  message: 1500,
};

/** Nettoie une valeur de formulaire : espaces, retours Windows, longueur. */
function clean(value, max) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

function positiveInt(raw) {
  const text = String(raw ?? '').replace(/\s/g, '');
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Valide et normalise une demande.
 * @returns {{ok:boolean, values:object, errors:object}}
 */
function validateQuote(input = {}) {
  const values = {
    name: clean(input.name, LIMITS.name),
    email: clean(input.email, LIMITS.email),
    discord: clean(input.discord, LIMITS.discord),
    // ID Discord obligatoire : c'est le seul moyen d'envoyer la clé à
    // l'acheteur en message privé. Un pseudo ne suffit pas à le retrouver.
    discordId: clean(input.discordId, LIMITS.discordId).replace(/[^\d]/g, ''),
    guildId: clean(input.guildId, LIMITS.guildId).replace(/[^\d]/g, ''),
    guildName: clean(input.guildName, LIMITS.guildName),
    servers: clean(input.servers, LIMITS.servers),
    members: clean(input.members, LIMITS.members),
    duration: clean(input.duration, LIMITS.duration),
    startDate: clean(input.startDate, LIMITS.startDate),
    budget: clean(input.budget, LIMITS.budget),
    modules: clean(input.modules, LIMITS.modules),
    message: clean(input.message, LIMITS.message),
    // Une case non cochée n'est pas envoyée par le navigateur.
    consent: Boolean(input.consent),
  };

  const errors = {};

  if (values.name.length < 2) {
    errors.name = 'Indique ton nom ou ton pseudo (2 caractères minimum).';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) {
    errors.email = 'Adresse e-mail invalide : c’est là que la réponse au devis sera envoyée.';
  }
  if (!/^\d{17,20}$/.test(values.discordId)) {
    errors.discordId = 'ID Discord invalide (17 à 20 chiffres). Paramètres → Avancé → Mode développeur, puis clic droit sur ton profil → « Copier l’identifiant ».';
  }
  if (!/^\d{17,20}$/.test(values.guildId)) {
    errors.guildId = 'ID de serveur invalide. Clic droit sur le serveur → « Copier l’identifiant » (17 à 20 chiffres).';
  }
  if (values.guildName.length < 2) {
    errors.guildName = 'Indique le nom du serveur principal.';
  }

  const servers = positiveInt(values.servers);
  if (servers === null || servers < 1 || servers > 100) {
    errors.servers = 'Nombre de serveurs attendu, entre 1 et 100.';
  }

  const members = positiveInt(values.members);
  if (members === null || members > 50_000_000) {
    errors.members = 'Indique le nombre de membres cumulés (chiffres uniquement).';
  }

  if (!DURATIONS.includes(values.duration)) {
    errors.duration = 'Choisis une durée de licence.';
  }
  if (values.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(values.startDate)) {
    errors.startDate = 'Date invalide.';
  }
  if (!values.consent) {
    errors.consent = 'Coche l’accord pour être recontacté au sujet de ce devis.';
  }

  return {
    ok: Object.keys(errors).length === 0,
    values: { ...values, servers, members, duration: values.duration },
    errors,
  };
}

/** Champs dans l'ordre d'affichage (utilisé par le rendu et les tests). */
const FIELDS = [
  'name', 'email', 'discord', 'discordId', 'guildId', 'guildName',
  'servers', 'members', 'duration', 'startDate', 'budget',
  'modules', 'message', 'consent',
];

// Durée demandée → durée accordée quand l'owner approuve en un clic.
// « sur mesure » part sur un an : la durée exacte se discute, mais la clé doit
// avoir une échéance dès l'approbation (modifiable ensuite via /license).
const DURATION_DAYS = { '3 mois': 90, '6 mois': 180, '1 an': 365, 'sur mesure': 365 };

function daysFor(duration) {
  return DURATION_DAYS[String(duration || '').trim()] || 365;
}

/** Sièges accordés : serveurs demandés, bornés à ce que la clé accepte. */
function seatsFor(servers) {
  const n = Number(servers);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(25, Math.round(n)));
}

module.exports = {
  DURATIONS, DURATION_DAYS, LIMITS, FIELDS,
  clean, positiveInt, validateQuote, daysFor, seatsFor,
};
