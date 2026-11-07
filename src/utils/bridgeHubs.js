'use strict';
// utils/bridgeHubs.js — Les canaux communs du pont inter-serveurs.
//
// Un « hub » est un canal de discussion partagé par tous les serveurs qui y
// branchent un de leurs salons. Les identifiants sont stables : ils servent de
// clé en base et ne doivent jamais changer sans migration.
//
// La liste est éditoriale (elle décide de ce que l'on peut rejoindre), pas
// technique : aucun hub n'est privilégié, aucun n'est réservé à une licence.

const HUBS = [
  {
    id: 'general',
    emoji: '🌍',
    label: 'Général',
    topic: 'Discussion libre : présentations, bonne humeur, tout et rien.',
    color: 0xb03a5b,
  },
  {
    id: 'gaming',
    emoji: '🎮',
    label: 'Gaming',
    topic: 'Jeux, teams, sessions multijoueur et bons plans.',
    color: 0x5865f2,
  },
  {
    id: 'musique',
    emoji: '🎧',
    label: 'Musique',
    topic: 'Découvertes, playlists, radios et sorties de la semaine.',
    color: 0xf47fff,
  },
  {
    id: 'tech',
    emoji: '💻',
    label: 'Tech & dev',
    topic: 'Code, bots, serveurs, hardware et entraide technique.',
    color: 0x2ecc71,
  },
  {
    id: 'creation',
    emoji: '🎨',
    label: 'Création',
    topic: 'Art, dessin, montage, écriture et retours bienveillants.',
    color: 0xf1c40f,
  },
  {
    id: 'entraide',
    emoji: '🤝',
    label: 'Entraide',
    topic: 'Questions, coups de main et réponses utiles.',
    color: 0x1abc9c,
  },
  {
    id: 'etudes',
    emoji: '📚',
    label: 'Études',
    topic: 'Révisions, méthodes de travail et orientation.',
    color: 0x9b59b6,
  },
  {
    id: 'fun',
    emoji: '🎲',
    label: 'Fun',
    topic: 'Blagues, quiz, défis et tout ce qui fait sourire.',
    color: 0xe67e22,
  },
];

const DEFAULT_HUB = 'general';
const HUB_IDS = HUBS.map(hub => hub.id);
const BY_ID = new Map(HUBS.map(hub => [hub.id, hub]));

function hubById(id) {
  return BY_ID.get(String(id || '').toLowerCase()) || null;
}

function isValidHub(id) {
  return BY_ID.has(String(id || '').toLowerCase());
}

function hubLabel(id) {
  const hub = hubById(id);
  return hub ? `${hub.emoji} ${hub.label}` : '🌍 Général';
}

function hubColor(id) {
  return hubById(id)?.color ?? HUBS[0].color;
}

/** Entrées prêtes pour un menu Discord (limite : 25). */
function hubChoices() {
  return HUBS.slice(0, 25).map(hub => ({
    name: `${hub.emoji} ${hub.label}`.slice(0, 100),
    value: hub.id,
    description: hub.topic.slice(0, 100),
  }));
}

/** Libellé explicite du canal, utilisé dans les textes et les embeds. */
function hubTitle(id) {
  const hub = hubById(id);
  return hub ? `${hub.emoji} ${hub.label} — ${hub.topic}` : '';
}

module.exports = {
  HUBS,
  HUB_IDS,
  DEFAULT_HUB,
  hubById,
  isValidHub,
  hubLabel,
  hubColor,
  hubChoices,
  hubTitle,
};
