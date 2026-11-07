'use strict';
// utils/profileBadges.js — Moteur de badges du profil utilisateur.
//
// Deux familles de badges :
//   1. les badges AUTOMATIQUES, définis ici : ils ne sont jamais stockés, ils
//      sont recalculés depuis les vraies statistiques du membre (niveau, bumps,
//      vocal, invitations, casino…). Impossible d'en « tricher » l'affichage,
//      et un membre qui perd son rôle staff perd le badge immédiatement.
//   2. les badges de COLLECTION créés par les admins du serveur (modèles
//      Badge / UserBadge, attribués à la main via les jalons de bump).
//
// Chaque définition porte sa rareté et sa cible, ce qui permet d'afficher une
// progression (« 34/50 ») dans la galerie /profile badges.
//
// Ce module est volontairement pur : `evaluate()` ne fait aucune requête, ce qui
// rend les seuils testables sans base de données.

const RARITIES = {
  commun:     { id: 'commun',     label: 'Commun',     emoji: '⚪', color: '#95A5A6', weight: 1 },
  rare:       { id: 'rare',       label: 'Rare',       emoji: '🔵', color: '#3498DB', weight: 2 },
  epique:     { id: 'epique',     label: 'Épique',     emoji: '🟣', color: '#9B59B6', weight: 3 },
  legendaire: { id: 'legendaire', label: 'Légendaire', emoji: '🟠', color: '#E67E22', weight: 4 },
  mythique:   { id: 'mythique',   label: 'Mythique',   emoji: '🔴', color: '#E74C3C', weight: 5 },
};

// Catégories d'affichage de la galerie.
const CATEGORIES = {
  progression: { id: 'progression', label: 'Progression', emoji: '📈' },
  social:      { id: 'social',      label: 'Social',      emoji: '🤝' },
  economie:    { id: 'economie',    label: 'Économie',    emoji: '💰' },
  fidelite:    { id: 'fidelite',    label: 'Fidélité',    emoji: '🗓️' },
  statut:      { id: 'statut',      label: 'Statut',      emoji: '🎖️' },
  collection:  { id: 'collection',  label: 'Collection',  emoji: '🎁' },
};

/**
 * Définitions des badges automatiques.
 * `value(stats)` retourne la valeur courante ; `target` est le seuil.
 * Un badge est acquis dès que value >= target.
 */
const AUTO_BADGES = [
  // ── Progression ────────────────────────────────────────────────────────────
  { id: 'lvl_5',   name: 'Premiers pas',   emoji: '🌱', category: 'progression', rarity: 'commun',     target: 5,   value: s => s.level,        description: 'Atteindre le niveau 5' },
  { id: 'lvl_15',  name: 'Habitué',        emoji: '🌿', category: 'progression', rarity: 'rare',       target: 15,  value: s => s.level,        description: 'Atteindre le niveau 15' },
  { id: 'lvl_30',  name: 'Vétéran',        emoji: '🌳', category: 'progression', rarity: 'epique',     target: 30,  value: s => s.level,        description: 'Atteindre le niveau 30' },
  { id: 'lvl_50',  name: 'Légende vivante', emoji: '🏔️', category: 'progression', rarity: 'legendaire', target: 50,  value: s => s.level,        description: 'Atteindre le niveau 50' },
  { id: 'lvl_100', name: 'Inarrêtable',    emoji: '🌌', category: 'progression', rarity: 'mythique',    target: 100, value: s => s.level,        description: 'Atteindre le niveau 100' },
  { id: 'msg_100',  name: 'Bavard',        emoji: '💬', category: 'progression', rarity: 'commun',     target: 100,  value: s => s.messages,    description: 'Envoyer 100 messages' },
  { id: 'msg_1000', name: 'Moulin à paroles', emoji: '🗣️', category: 'progression', rarity: 'rare',    target: 1000, value: s => s.messages,    description: 'Envoyer 1 000 messages' },
  { id: 'msg_10000', name: 'Pilier du salon', emoji: '📢', category: 'progression', rarity: 'legendaire', target: 10000, value: s => s.messages, description: 'Envoyer 10 000 messages' },

  // ── Social ─────────────────────────────────────────────────────────────────
  { id: 'voice_1h',  name: 'Première voix', emoji: '🎙️', category: 'social', rarity: 'commun',     target: 3600,   value: s => s.voiceSeconds, description: 'Passer 1 heure en vocal' },
  { id: 'voice_10h', name: 'Voix posée',    emoji: '🎧', category: 'social', rarity: 'rare',       target: 36000,  value: s => s.voiceSeconds, description: 'Passer 10 heures en vocal' },
  { id: 'voice_100h', name: 'Noyau du vocal', emoji: '📻', category: 'social', rarity: 'epique',   target: 360000, value: s => s.voiceSeconds, description: 'Passer 100 heures en vocal' },
  { id: 'invite_1',  name: 'Recruteur',     emoji: '🫱', category: 'social', rarity: 'commun',     target: 1,  value: s => s.invites, description: 'Inviter 1 membre' },
  { id: 'invite_5',  name: 'Ambassadeur',   emoji: '🌉', category: 'social', rarity: 'rare',       target: 5,  value: s => s.invites, description: 'Inviter 5 membres' },
  { id: 'invite_25', name: 'Bâtisseur',     emoji: '🏗️', category: 'social', rarity: 'epique',     target: 25, value: s => s.invites, description: 'Inviter 25 membres' },
  { id: 'invite_100', name: 'Aimant humain', emoji: '🧲', category: 'social', rarity: 'legendaire', target: 100, value: s => s.invites, description: 'Inviter 100 membres' },

  // ── Économie ───────────────────────────────────────────────────────────────
  { id: 'coins_1000',  name: 'Petite bourse',  emoji: '🪙', category: 'economie', rarity: 'commun',  target: 1000,   value: s => s.coins, description: 'Posséder 1 000 pièces' },
  { id: 'coins_10000', name: 'Fortuné',        emoji: '💰', category: 'economie', rarity: 'rare',    target: 10000,  value: s => s.coins, description: 'Posséder 10 000 pièces' },
  { id: 'coins_100000', name: 'Magnat',        emoji: '🏦', category: 'economie', rarity: 'epique',  target: 100000, value: s => s.coins, description: 'Posséder 100 000 pièces' },
  { id: 'casino_50',   name: 'Joueur',         emoji: '🎲', category: 'economie', rarity: 'rare',    target: 50,     value: s => s.casinoGames, description: 'Jouer 50 parties au casino' },
  { id: 'casino_500',  name: 'Tête brûlée',    emoji: '🃏', category: 'economie', rarity: 'legendaire', target: 500, value: s => s.casinoGames, description: 'Jouer 500 parties au casino' },
  { id: 'jackpot_1',   name: 'Jackpot !',      emoji: '🎰', category: 'economie', rarity: 'mythique', target: 1,      value: s => s.jackpots, description: 'Décrocher un jackpot au casino' },

  // ── Fidélité ───────────────────────────────────────────────────────────────
  { id: 'bump_1',    name: 'Premier bump',  emoji: '🚀', category: 'fidelite', rarity: 'commun',     target: 1,    value: s => s.bumps,  description: 'Effectuer 1 bump' },
  { id: 'bump_10',   name: 'Bumpeur',       emoji: '🛰️', category: 'fidelite', rarity: 'rare',       target: 10,   value: s => s.bumps,  description: 'Effectuer 10 bumps' },
  { id: 'bump_50',   name: 'Machine à bump', emoji: '⚙️', category: 'fidelite', rarity: 'epique',    target: 50,   value: s => s.bumps,  description: 'Effectuer 50 bumps' },
  { id: 'bump_100',  name: 'Centurion',     emoji: '💯', category: 'fidelite', rarity: 'legendaire', target: 100,  value: s => s.bumps,  description: 'Effectuer 100 bumps' },
  { id: 'bump_500',  name: 'Force de frappe', emoji: '🌟', category: 'fidelite', rarity: 'mythique', target: 500,  value: s => s.bumps,  description: 'Effectuer 500 bumps' },
  { id: 'streak_7',   name: 'Série de 7',   emoji: '🔥', category: 'fidelite', rarity: 'rare',       target: 7,    value: s => s.streak, description: 'Bumper 7 jours d’affilée' },
  { id: 'streak_30',  name: 'Série de 30',  emoji: '♨️', category: 'fidelite', rarity: 'epique',     target: 30,   value: s => s.streak, description: 'Bumper 30 jours d’affilée' },
  { id: 'streak_100', name: 'Série de 100', emoji: '🌋', category: 'fidelite', rarity: 'mythique',   target: 100,  value: s => s.streak, description: 'Bumper 100 jours d’affilée' },
  { id: 'senior_30',  name: 'Un mois ici',  emoji: '📅', category: 'fidelite', rarity: 'commun',     target: 30,   value: s => s.memberDays, description: 'Être membre depuis 1 mois' },
  { id: 'senior_365', name: 'Un an ici',    emoji: '🎂', category: 'fidelite', rarity: 'legendaire', target: 365,  value: s => s.memberDays, description: 'Être membre depuis 1 an' },

  // ── Statut ─────────────────────────────────────────────────────────────────
  { id: 'booster', name: 'Booster',        emoji: '💎', category: 'statut', rarity: 'epique',     target: 1, value: s => (s.isBooster ? 1 : 0), description: 'Booster le serveur' },
  { id: 'staff',   name: 'Staff',          emoji: '🛡️', category: 'statut', rarity: 'epique',     target: 1, value: s => (s.isStaff ? 1 : 0),   description: 'Faire partie de l’équipe' },
  { id: 'owner',   name: 'Fondateur',      emoji: '👑', category: 'statut', rarity: 'mythique',   target: 1, value: s => (s.isOwner ? 1 : 0),   description: 'Être propriétaire du serveur' },
];

const AUTO_BY_ID = new Map(AUTO_BADGES.map(b => [b.id, b]));

function rarityInfo(rarity) {
  return RARITIES[rarity] || RARITIES.commun;
}

function clampProgress(value, target) {
  if (!target || target <= 0) return 1;
  return Math.max(0, Math.min(1, Number(value || 0) / target));
}

function progressLabel(value, target) {
  if (value >= target) return 'Acquis';
  const current = Math.max(0, Math.floor(Number(value) || 0));
  return `${current.toLocaleString('fr-FR')}/${Number(target).toLocaleString('fr-FR')}`;
}

/**
 * Évalue le catalogue complet pour un jeu de statistiques.
 * @param {object} stats compteurs du membre (voir profileService.gatherStats)
 * @param {Array}  customBadges badges de collection déjà possédés
 * @returns {Array<object>} badges triés : acquis d'abord, puis par progression
 */
function evaluate(stats = {}, customBadges = []) {
  const auto = AUTO_BADGES.map((def) => {
    const value = Math.max(0, Number(def.value(stats) || 0));
    const earned = value >= def.target;
    return {
      id: def.id,
      name: def.name,
      emoji: def.emoji,
      description: def.description,
      category: def.category,
      rarity: def.rarity,
      rarityInfo: rarityInfo(def.rarity),
      target: def.target,
      value,
      earned,
      progress: clampProgress(value, def.target),
      progressLabel: progressLabel(value, def.target),
      source: 'auto',
    };
  });

  const collection = (customBadges || []).map((badge, index) => ({
    id: `custom_${badge.badgeId || index}`,
    name: badge.name || 'Badge du serveur',
    emoji: badge.emoji || '🏅',
    description: badge.description || 'Badge attribué sur ce serveur',
    category: 'collection',
    rarity: 'epique',
    rarityInfo: rarityInfo('epique'),
    target: 1,
    value: 1,
    earned: true,
    progress: 1,
    progressLabel: 'Acquis',
    source: 'collection',
    badgeId: badge.badgeId,
    earnedAt: badge.earnedAt || null,
  }));

  return [...auto, ...collection];
}

/** Badges acquis, dans l'ordre du catalogue. */
function earned(badges) {
  return (badges || []).filter(b => b.earned);
}

/** Prochains badges à débloquer (les plus proches d'abord). */
function nextUp(badges, limit = 3) {
  return (badges || [])
    .filter(b => !b.earned)
    .sort((a, b) => b.progress - a.progress || a.target - b.target)
    .slice(0, Math.max(0, limit));
}

/**
 * Sélection affichée sur la carte : badges épinglés s'ils existent encore,
 * sinon les badges acquis les plus rares.
 */
function showcase(badges, pinned = [], limit = 8) {
  const byId = new Map((badges || []).map(b => [b.id, b]));
  const acquired = (badges || []).filter(b => b.earned);
  const pinnedBadges = (pinned || [])
    .map(id => byId.get(id))
    .filter(b => b && b.earned);

  const rarest = [...acquired].sort(
    (a, b) => (rarityInfo(b.rarity).weight - rarityInfo(a.rarity).weight)
      || (b.progress - a.progress),
  );

  const seen = new Set();
  const result = [];
  for (const badge of [...pinnedBadges, ...rarest]) {
    if (seen.has(badge.id)) continue;
    seen.add(badge.id);
    result.push(badge);
    if (result.length >= limit) break;
  }
  return result;
}

/** Compte par rareté, pour les résumés du panel. */
function countByRarity(badges) {
  const counts = {};
  for (const key of Object.keys(RARITIES)) counts[key] = 0;
  for (const badge of earned(badges)) counts[badge.rarity] = (counts[badge.rarity] || 0) + 1;
  return counts;
}

/** Identifiants épinglables (badges acquis uniquement). */
function pinnableIds(badges, limit = 25) {
  return earned(badges)
    .filter(b => b.id && b.id.length <= 40)
    .slice(0, limit)
    .map(b => b.id);
}

module.exports = {
  RARITIES,
  CATEGORIES,
  AUTO_BADGES,
  AUTO_BY_ID,
  rarityInfo,
  clampProgress,
  progressLabel,
  evaluate,
  earned,
  nextUp,
  showcase,
  countByRarity,
  pinnableIds,
};
