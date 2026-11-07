'use strict';
// utils/tosDocument.js — Texte des conditions d'utilisation de REZO.
//
// Source unique de vérité : le garde (utils/tosGate.js), la commande /tos et
// les tests lisent tous ce fichier. Pour publier une nouvelle version :
//   1. modifier les sections ci-dessous ;
//   2. changer VERSION (date ISO du jour) ;
//   3. relancer les tests.
// Toute personne n'ayant accepté qu'une version antérieure sera invitée à
// accepter la nouvelle avant de pouvoir exécuter une commande.

// Changer cette valeur invalide toutes les acceptations précédentes.
const VERSION = '2026-10-20';

const TITLE = "📜 Conditions d'utilisation de REZO";

const INTRO = [
  'REZO est un bot Discord tout‑en‑un. Avant d’utiliser la moindre de ses commandes,',
  'vous devez lire et accepter ces conditions. Elles s’appliquent à chaque membre,',
  'sur chaque serveur où le bot est présent.',
].join('\n');

// Chaque section devient un champ d'embed : garder chaque corps sous 1000
// caractères (la limite Discord est 1024 par champ).
const SECTIONS = [
  {
    title: '1️⃣ Objet',
    body: [
      'Ces conditions encadrent l’utilisation des commandes, panneaux et automatisations de REZO.',
      'Utiliser le bot implique de les respecter. Si vous refusez, vous pouvez rester sur le serveur,',
      'mais **aucune commande du bot ne sera exécutée pour votre compte**.',
    ].join(' '),
  },
  {
    title: '2️⃣ Usage autorisé',
    body: [
      'Utilisez le bot conformément aux Conditions d’utilisation de Discord et aux règles de votre serveur.',
      'Sont interdits : le spam de commandes, la recherche ou l’exploitation de failles, l’automatisation abusive,',
      'l’usurpation d’identité, et toute tentative de contournement des permissions ou des protections.',
    ].join(' '),
  },
  {
    title: '3️⃣ Données traitées',
    body: [
      'REZO conserve votre identifiant Discord, la version acceptée de ces conditions et sa date,',
      'ainsi que les données nécessaires aux fonctionnalités (configuration du serveur, économie, niveaux,',
      'tickets, logs de modération). Ces données ne sont **pas revendues**. Les données d’un serveur',
      'sont accessibles à ses administrateurs.',
    ].join(' '),
  },
  {
    title: '4️⃣ Modération et automatisations',
    body: [
      'Certaines fonctions agissent sans intervention humaine : anti‑spam, anti‑raid, anti‑scam,',
      'automodération, captcha. Elles peuvent supprimer un message, expulser, mettre en timeout ou bannir un membre.',
      'Les décisions automatiques restent sous la responsabilité des administrateurs qui les ont activées.',
    ].join(' '),
  },
  {
    title: '5️⃣ Disponibilité et évolution',
    body: [
      'Le bot est fourni « en l’état », sans garantie de disponibilité ni d’absence d’erreur.',
      'Des fonctionnalités peuvent être ajoutées, modifiées ou retirées. Ces conditions peuvent évoluer :',
      'une nouvelle version vous sera présentée et devra être acceptée pour continuer à utiliser le bot.',
    ].join(' '),
  },
  {
    title: '6️⃣ Responsabilité',
    body: [
      'Vous restez responsable de l’usage que vous faites du bot et de la configuration de votre serveur.',
      'L’éditeur de REZO ne peut être tenu responsable des dommages indirects liés à une mauvaise configuration,',
      'à une panne ou à un usage détourné du bot.',
    ].join(' '),
  },
  {
    title: '7️⃣ Acceptation',
    body: [
      'Cliquer sur « J’accepte » enregistre votre identifiant Discord, la version des conditions et la date',
      'd’acceptation. Ce consentement est personnel. Le refus bloque toutes les commandes pour votre compte,',
      'sans rien supprimer sur le serveur.',
    ].join(' '),
  },
];

// Rappel court affiché dans l'invite (l'embed complet reste accessible).
const SUMMARY = [
  '• **Aucune commande sans acceptation** — le bot ne s’exécute pas pour vous tant que vous n’avez pas accepté.',
  '• **Données minimales** — identifiant Discord, version acceptée, date, et données utiles aux fonctionnalités.',
  '• **Modération automatique** — certaines protections peuvent sanctionner sans intervention humaine.',
];

/** Texte intégral, au format lisible hors embed (utile aux DMs, docs, tests). */
function fullText() {
  return [
    `${TITLE} — version ${VERSION}`,
    '',
    INTRO,
    '',
    ...SECTIONS.map(s => `${s.title}\n${s.body}\n`),
  ].join('\n').trim();
}

module.exports = { VERSION, TITLE, INTRO, SECTIONS, SUMMARY, fullText };
