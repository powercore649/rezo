'use strict';
// utils/licensePlans.js — SOURCE UNIQUE des offres vendues par le site.
//
// Les prix ne sont pas écrits dans les pages : ils viennent d'ici, donc du
// serveur. Changer un tarif = changer une variable d'environnement, pas du HTML.
//
// Une clé couvre un ou plusieurs serveurs selon son TYPE (`kind`) :
//   • standard / network : vendues sur le site ;
//   • partner / owner    : émises uniquement par l'owner du bot, jamais vendues.
// `days: null` = licence illimitée.

const { kindInfo, featuresForKind } = require('./licenseCore');

const CURRENCY = 'EUR';

// Prix en centimes : aucun flottant, aucun arrondi douteux.
const DEFAULT_PRICES = {
  pro: 990,
  business: 2490,
  network: 3990,
  lifetime: 4990,
  event: 290,
  'pack-decouvreur': 690,
  'pack-lancement': 1490,
  'pack-premier-rezo': 1990,
  'pack-communaute': 3990,
  'pack-reseau': 5990,
  'pack-integral': 17990,
};

const DEFINITIONS = [
  {
    id: 'event',
    label: 'Événement',
    kind: 'essentiel',
    days: 7,
    priceKey: 'SITE_PRICE_EVENT_CENTS',
    tagline: 'Une semaine, le temps d’un tournoi.',
    perks: [
      '1 clé = 1 serveur',
      'Tous les systèmes sous licence',
      '7 jours, sans reconduction',
      'Support communautaire',
    ],
  },
  {
    id: 'pro',
    label: 'Pro',
    kind: 'standard',
    days: 30,
    graceDays: 3,
    priceKey: 'SITE_PRICE_PRO_CENTS',
    tagline: 'Pour un serveur qui démarre.',
    perks: [
      '1 clé = 1 serveur',
      'Tous les systèmes sous licence',
      'Mises à jour incluses',
      'Support communautaire',
    ],
  },
  {
    id: 'business',
    label: 'Business',
    kind: 'standard',
    days: 90,
    graceDays: 7,
    priceKey: 'SITE_PRICE_BUSINESS_CENTS',
    tagline: 'Pour une communauté installée.',
    highlighted: true,
    perks: [
      '1 clé = 1 serveur',
      'Tous les systèmes sous licence',
      'Trois mois, sans renouvellement automatique',
      'Support prioritaire',
    ],
  },
  {
    id: 'network',
    label: 'Réseau',
    kind: 'network',
    days: 90,
    graceDays: 7,
    priceKey: 'SITE_PRICE_NETWORK_CENTS',
    tagline: 'Une clé, trois serveurs.',
    perks: [
      '1 clé = 3 serveurs',
      'Tous les systèmes sous licence',
      'Idéal pour un réseau de serveurs',
      'Support prioritaire',
    ],
  },
  {
    id: 'lifetime',
    label: 'Lifetime',
    kind: 'standard',
    days: null,
    priceKey: 'SITE_PRICE_LIFETIME_CENTS',
    tagline: 'Payé une fois, pour toujours.',
    perks: [
      '1 clé = 1 serveur',
      'Tous les systèmes sous licence',
      'Aucune expiration',
      'Support prioritaire',
    ],
  },
  {
    id: 'partner',
    label: 'Partenaire',
    kind: 'partner',
    days: null,
    priceKey: null,
    sold: false,
    tagline: 'Offerte aux partenaires du réseau.',
    perks: [
      '1 clé = 1 serveur',
      'Émise par l’owner du bot',
      'Sans expiration',
      'Non revendable',
    ],
  },
];

// ─── Packs ────────────────────────────────────────────────────────────────
// Un pack n'est pas un palier de plus : c'est un BUNDLE. Il délivre une clé
// (palier + durée + sièges) accompagnée de prestations que le bot ne peut pas
// fournir seul (installation accompagnée, visuels, migration, support
// prioritaire). Vendu uniquement sur le site.
// `compareAtCents` = ce que coûteraient séparément la licence et les extras ;
// il sert à afficher l'économie, jamais à facturer.
const PACKS = [
  {
    id: 'pack-decouvreur',
    label: 'Pack Découvreur',
    kind: 'essentiel',
    days: 14,
    graceDays: 3,
    maxGuilds: 1,
    bundle: true,
    extras: ['leveling', 'xp', 'rank'],
    priceKey: 'SITE_PRICE_PACK_DECOUVREUR_CENTS',
    compareAtCents: 1290,
    tagline: 'Deux semaines pour tester le socle, niveaux compris.',
    perks: [
      'Licence Essentiel — 14 jours',
      '1 serveur',
      'Niveaux, XP et classement inclus (palier Standard)',
      'Installation guidée : bump, giveaways, anniversaires',
      '1 visuel personnalisé',
      'Support communautaire',
    ],
  },
  {
    id: 'pack-lancement',
    label: 'Pack Lancement',
    kind: 'essentiel',
    days: 30,
    graceDays: 3,
    maxGuilds: 1,
    bundle: true,
    // Vrais modules EN PLUS du palier : Essentiel + niveaux (normalement
    // réservés au Standard). C'est ce qui distingue le pack d'une licence.
    extras: ['leveling', 'xp', 'rank'],
    priceKey: 'SITE_PRICE_PACK_LANCEMENT_CENTS',
    compareAtCents: 2490,
    tagline: 'Le serveur qui démarre, niveaux compris.',
    perks: [
      'Licence Essentiel — 30 jours',
      '1 serveur',
      'Niveaux, XP et classement inclus (palier Standard)',
      'Installation guidée : bump, giveaways, anniversaires',
      '2 visuels personnalisés (bienvenue, level-up)',
      'Audit de sécurité initial',
    ],
  },
  {
    id: 'pack-premier-rezo',
    label: 'Pack Premier REZO',
    kind: 'standard',
    days: 30,
    graceDays: 7,
    maxGuilds: 1,
    bundle: true,
    extras: ['ia', 'imagine', 'backup'],
    priceKey: 'SITE_PRICE_PACK_PREMIER_REZO_CENTS',
    compareAtCents: 2990,
    tagline: 'La première vraie licence, IA et sauvegardes incluses.',
    perks: [
      'Licence Standard — 30 jours',
      '1 serveur',
      'IA et sauvegardes incluses (palier Réseau)',
      'Tickets et ModMail configurés',
      'Niveaux, XP et invitations réglés',
      '2 visuels personnalisés + support prioritaire',
    ],
  },
  {
    id: 'pack-communaute',
    label: 'Pack Communauté',
    kind: 'standard',
    days: 90,
    graceDays: 7,
    maxGuilds: 1,
    bundle: true,
    highlighted: true,
    // L'IA et les sauvegardes exigent normalement le palier Réseau : le pack
    // les ouvre sans changer de palier.
    extras: ['ia', 'imagine', 'backup'],
    priceKey: 'SITE_PRICE_PACK_COMMUNAUTE_CENTS',
    compareAtCents: 5990,
    tagline: 'Tout le Standard, plus l’IA et les sauvegardes.',
    perks: [
      'Licence Standard — 90 jours',
      '1 serveur',
      'IA et sauvegardes incluses (palier Réseau)',
      'Tickets et ModMail configurés',
      'Niveaux, XP et invitations réglés',
      '3 visuels personnalisés + support prioritaire',
    ],
  },
  {
    id: 'pack-reseau',
    label: 'Pack Réseau',
    kind: 'network',
    days: 90,
    graceDays: 7,
    // Cinq sièges là où l'offre Réseau s'arrête à trois : le pack apporte deux
    // serveurs de plus, pas seulement des prestations.
    maxGuilds: 5,
    bundle: true,
    extras: [],
    priceKey: 'SITE_PRICE_PACK_RESEAU_CENTS',
    compareAtCents: 8990,
    tagline: 'Cinq serveurs reliés, bumps et branding compris.',
    perks: [
      'Licence Réseau — 90 jours',
      '5 serveurs sur une seule clé (au lieu de 3)',
      'Réseau de bumps configuré',
      'Branding sur les cinq serveurs',
      'Starter Pack installé + support prioritaire',
    ],
  },
  {
    id: 'pack-integral',
    label: 'Pack Intégral',
    kind: 'network',
    days: 365,
    graceDays: 14,
    maxGuilds: 10,
    bundle: true,
    extras: [],
    priceKey: 'SITE_PRICE_PACK_INTEGRAL_CENTS',
    compareAtCents: 22990,
    tagline: 'Un an, dix serveurs, migration et accompagnement.',
    perks: [
      'Licence Réseau — 365 jours',
      '10 serveurs sur une seule clé',
      'Migration depuis un autre bot',
      'Branding, sauvegardes et IA activés',
      'Accompagnement dédié',
      'Support prioritaire',
    ],
  },
  {
    // Sur devis : aucun prix, aucun paiement en ligne. Le tarif se construit
    // avec le client (volume de serveurs, durée, migration).
    id: 'pack-rezo-net',
    label: 'Pack REZO.net',
    kind: 'network',
    days: null,
    graceDays: 0,
    maxGuilds: 25,
    bundle: true,
    quote: true,
    extras: [],
    priceKey: null,
    compareAtCents: null,
    tagline: 'Un réseau entier, chiffré avec toi.',
    perks: [
      'Licence Réseau — jusqu’à 25 serveurs',
      'Durée et sièges ajustés à ton réseau',
      'Migration complète et branding',
      'Réseau de bumps et pont inter-serveurs',
      'Accompagnement dédié',
      'Tarif sur devis, facturé au volume',
    ],
  },
];

function centsFromEnv(name, fallback) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function seatsLabel(maxGuilds) {
  return maxGuilds === 1 ? '1 serveur' : `${maxGuilds} serveurs`;
}

/**
 * Résout une offre OU un pack : mêmes champs, donc le tunnel d'achat, le suivi
 * de commande et l'émetteur de clés n'ont rien à savoir du type vendu.
 */
function resolveDefinition(def) {
  if (!def) return null;
  const kind = kindInfo(def.kind);
  const maxGuilds = Math.max(1, Math.min(25, Number(def.maxGuilds) || kind.maxGuilds));
  const quote = Boolean(def.quote);
  const amountCents = !quote && def.priceKey ? centsFromEnv(def.priceKey, DEFAULT_PRICES[def.id] || 0) : 0;
  const compareAtCents = Number.isFinite(def.compareAtCents) ? def.compareAtCents : null;

  return {
    ...def,
    kind: kind.id,
    kindLabel: kind.label,
    maxGuilds,
    seatsLabel: seatsLabel(maxGuilds),
    graceDays: Number.isFinite(def.graceDays) ? def.graceDays : 3,
    amountCents,
    quote,
    currency: CURRENCY,
    durationLabel: quote ? 'sur devis' : def.days === null ? 'illimitée' : `${def.days} jours`,
    compareAtCents,
    savingsCents: compareAtCents && compareAtCents > amountCents ? compareAtCents - amountCents : 0,
    bundle: Boolean(def.bundle),
  };
}

/** Offres publiques (prix résolus, aucun secret). */
function publicPlans() {
  return DEFINITIONS
    .filter(def => def.sold !== false)
    .map(resolveDefinition);
}

/** Les quatre packs, prêts à afficher (aucun si `sold: false`). */
function publicPacks() {
  return PACKS
    .filter(def => def.sold !== false)
    .map(resolveDefinition);
}

// Paliers vendus, dans l'ordre croissant de droits. Le site les affiche tels
// quels : ajouter un palier dans licenseCore suffit, aucune page à réécrire.
const SOLD_TIERS = ['essentiel', 'standard', 'network'];

/** Paliers publics : ce que chaque type de licence ouvre réellement. */
function publicTiers() {
  return SOLD_TIERS.map(id => {
    const kind = kindInfo(id);
    return {
      id: kind.id,
      label: kind.label,
      emoji: kind.emoji,
      description: kind.description,
      maxGuilds: kind.maxGuilds,
      seatsLabel: kind.maxGuilds === 1 ? '1 serveur' : `${kind.maxGuilds} serveurs`,
      features: featuresForKind(kind.id),
    };
  });
}

function resolvePlan(id) {
  const key = String(id || '');
  return resolveDefinition(DEFINITIONS.find(p => p.id === key) || PACKS.find(p => p.id === key) || null);
}

/** Identifiants achetables : offres et packs, hors packs sur devis. */
function planIds() {
  return [...DEFINITIONS, ...PACKS].filter(p => !p.quote).map(p => p.id);
}

/** Packs négociés avec le support, jamais payables en ligne. */
function quotePacks() {
  return PACKS.filter(p => p.quote).map(resolveDefinition);
}

/** 9,90 € — sans dépendre d'Intl pour un rendu stable. */
function formatPrice(amountCents, currency = CURRENCY) {
  const value = (Number(amountCents) || 0) / 100;
  const text = value.toFixed(2).replace('.', ',');
  return currency === 'EUR' ? `${text} €` : `${text} ${currency}`;
}

module.exports = {
  CURRENCY,
  DEFAULT_PRICES,
  DEFINITIONS,
  PACKS,
  publicPlans,
  publicPacks,
  quotePacks,
  publicTiers,
  resolvePlan,
  planIds,
  formatPrice,
};
