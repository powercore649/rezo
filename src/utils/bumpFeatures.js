// utils/bumpFeatures.js — Logique des nouvelles fonctionnalités interactives
// du système de bump : badges de jalon (réutilise le système Badge/UserBadge
// déjà existant, /badge) et loot box à ouverture manuelle.
const { Badge, UserBadge } = require('../models/Badge');

// Badges "système" — créés automatiquement au premier jalon atteint sur
// chaque serveur (badgeId préfixé sys_ pour ne jamais entrer en collision
// avec un badge créé manuellement par un admin via /badge créer).
const STREAK_MILESTONES = [
  { days: 7,   badgeId: 'sys_streak_7',   name: 'Streak 7 jours',   emoji: '🔥' },
  { days: 30,  badgeId: 'sys_streak_30',  name: 'Streak 30 jours',  emoji: '🔥' },
  { days: 100, badgeId: 'sys_streak_100', name: 'Streak 100 jours', emoji: '🏆' },
  { days: 365, badgeId: 'sys_streak_365', name: 'Streak 1 an',      emoji: '👑' },
];

const BUMP_COUNT_MILESTONES = [
  { count: 10,   badgeId: 'sys_bumps_10',   name: '10 bumps',    emoji: '🚀' },
  { count: 50,   badgeId: 'sys_bumps_50',   name: '50 bumps',    emoji: '🚀' },
  { count: 100,  badgeId: 'sys_bumps_100',  name: '100 bumps',   emoji: '💯' },
  { count: 500,  badgeId: 'sys_bumps_500',  name: '500 bumps',   emoji: '⭐' },
  { count: 1000, badgeId: 'sys_bumps_1000', name: '1000 bumps',  emoji: '🌟' },
];

// S'assure que le badge système existe pour ce serveur (le crée s'il
// n'existe pas encore) puis l'attribue au membre s'il ne l'a pas déjà.
// Renvoie le badge si NOUVELLEMENT attribué, sinon null.
async function grantMilestoneBadge(guildId, userId, milestone) {
  await Badge.findOneAndUpdate(
    { guildId, badgeId: milestone.badgeId },
    { $setOnInsert: { guildId, badgeId: milestone.badgeId, name: milestone.name, emoji: milestone.emoji, description: 'Badge automatique de jalon REZO', color: '#7c6cf0' } },
    { upsert: true }
  );

  const already = await UserBadge.findOne({ userId, guildId, badgeId: milestone.badgeId });
  if (already) return null;

  await UserBadge.create({ userId, guildId, badgeId: milestone.badgeId });
  return milestone;
}

// Vérifie les jalons de streak ET de nombre total de bumps, attribue les
// badges nouvellement débloqués, renvoie la liste de ceux gagnés à l'instant
// (pour affichage immédiat dans l'embed de succès du bump).
async function checkAndAwardMilestones(guildId, userId, { bumpStreak, totalUserBumps }) {
  const newlyEarned = [];

  const streakMilestone = STREAK_MILESTONES.find((m) => m.days === bumpStreak);
  if (streakMilestone) {
    const granted = await grantMilestoneBadge(guildId, userId, streakMilestone).catch(() => null);
    if (granted) newlyEarned.push(granted);
  }

  const bumpMilestone = BUMP_COUNT_MILESTONES.find((m) => m.count === totalUserBumps);
  if (bumpMilestone) {
    const granted = await grantMilestoneBadge(guildId, userId, bumpMilestone).catch(() => null);
    if (granted) newlyEarned.push(granted);
  }

  return newlyEarned;
}

// ─── Loot box ─────────────────────────────────────────────────────────────
// 20% de chance par bump. Table de gains pondérée — la somme des poids doit
// faire 100 pour une lecture simple des probabilités.
const LOOT_TABLE = [
  { weight: 45, coins: 15,  label: 'Petit bonus'   },
  { weight: 30, coins: 40,  label: 'Bonus sympa'   },
  { weight: 18, coins: 100, label: 'Gros bonus'    },
  { weight: 6,  coins: 250, label: 'Bonus rare !'  },
  { weight: 1,  coins: 1000, label: '🌈 JACKPOT !' },
];
const LOOT_BOX_CHANCE = 0.2;

function rollLootBox() {
  if (Math.random() >= LOOT_BOX_CHANCE) return null;

  const totalWeight = LOOT_TABLE.reduce((a, e) => a + e.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const entry of LOOT_TABLE) {
    if (roll < entry.weight) return entry;
    roll -= entry.weight;
  }
  return LOOT_TABLE[0]; // filet de sécurité, ne devrait jamais être atteint
}

module.exports = {
  STREAK_MILESTONES,
  BUMP_COUNT_MILESTONES,
  checkAndAwardMilestones,
  rollLootBox,
  LOOT_BOX_CHANCE,
};
