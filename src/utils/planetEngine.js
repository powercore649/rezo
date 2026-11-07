'use strict';
// utils/planetEngine.js — Logique métier pure du jeu /planet (aucune dépendance Discord/DB)

// ─── Paliers de croissance (représentation visuelle en emojis unicode) ───────
const GROWTH_STAGES = [
  { minLevel: 1,  emoji: '🪨',        label: 'Astéroïde' },
  { minLevel: 3,  emoji: '🌑',        label: 'Petite planète' },
  { minLevel: 6,  emoji: '🌍',        label: 'Planète habitée' },
  { minLevel: 10, emoji: '🪐',        label: 'Planète à anneaux' },
  { minLevel: 15, emoji: '☄️🌌',      label: 'Système en formation' },
  { minLevel: 20, emoji: '🌌✨',      label: 'Système stellaire' },
];

function getGrowthStage(level) {
  let stage = GROWTH_STAGES[0];
  for (const s of GROWTH_STAGES) {
    if (level >= s.minLevel) stage = s;
  }
  return stage;
}

// ─── Biomes (thème visuel + léger bonus de production) ───────────────────────
const BIOMES = {
  foret:    { label: '🌳 Forestière', emoji: '🌳', bonus: 'food' },
  desert:   { label: '🏜️ Désertique', emoji: '🏜️', bonus: 'minerals' },
  ocean:    { label: '🌊 Océanique',  emoji: '🌊', bonus: 'energy' },
  glace:    { label: '❄️ Glaciale',   emoji: '❄️', bonus: 'xp' },
  volcan:   { label: '🌋 Volcanique', emoji: '🌋', bonus: 'minerals' },
  tropical: { label: '🌴 Tropicale',  emoji: '🌴', bonus: 'food' },
};

// ─── Bâtiments ────────────────────────────────────────────────────────────────
const BUILDINGS = {
  house:  { label: '🏠 Maison',       produces: null,      unlockLevel: 1, baseCost: { minerals: 20 } },
  farm:   { label: '🌾 Ferme',        produces: 'food',     unlockLevel: 1, baseCost: { minerals: 15, energy: 5 } },
  power:  { label: '⚡ Centrale',      produces: 'energy',   unlockLevel: 1, baseCost: { minerals: 25 } },
  mine:   { label: '⛏️ Mine',         produces: 'minerals', unlockLevel: 2, baseCost: { energy: 20 } },
  lab:    { label: '🔬 Laboratoire',  produces: 'xp',       unlockLevel: 3, baseCost: { minerals: 40, food: 15 } },
};

const HOUSE_CAPACITY = 10; // habitants supplémentaires par maison
const BASE_POP_CAPACITY = 5;

/**
 * Coût d'un bâtiment selon le nombre déjà construit (croissance exponentielle douce).
 */
function getBuildingCost(buildingType, currentCount) {
  const def = BUILDINGS[buildingType];
  if (!def) return null;
  const multiplier = Math.pow(1.4, currentCount);
  const cost = {};
  for (const [res, amount] of Object.entries(def.baseCost)) {
    cost[res] = Math.ceil(amount * multiplier);
  }
  return cost;
}

function canAfford(resources, cost) {
  return Object.entries(cost).every(([res, amount]) => (resources[res] || 0) >= amount);
}

function deductCost(resources, cost) {
  for (const [res, amount] of Object.entries(cost)) {
    resources[res] = (resources[res] || 0) - amount;
  }
}

/**
 * XP nécessaire pour passer du niveau `level` au niveau `level + 1`.
 */
function xpForNextLevel(level) {
  return Math.round(80 * Math.pow(1.35, level - 1));
}

/**
 * Fait progresser le niveau de la planète si assez d'XP est accumulée.
 * Gère plusieurs montées de niveau d'affilée si nécessaire.
 * @returns {{ leveledUp: boolean, levelsGained: number, newLevel: number }}
 */
function checkLevelUp(planet) {
  let levelsGained = 0;
  while (planet.xp >= xpForNextLevel(planet.level)) {
    planet.xp -= xpForNextLevel(planet.level);
    planet.level += 1;
    levelsGained += 1;
  }
  return { leveledUp: levelsGained > 0, levelsGained, newLevel: planet.level };
}

/**
 * @param {Date|null} lastHarvest
 * @param {number} cooldownMinutes
 */
function checkHarvestCooldown(lastHarvest, cooldownMinutes, now = new Date()) {
  if (!lastHarvest) return { ok: true };
  const elapsedMin = (now.getTime() - new Date(lastHarvest).getTime()) / 60_000;
  if (elapsedMin >= cooldownMinutes) return { ok: true };
  return { ok: false, remainingMinutes: Math.ceil(cooldownMinutes - elapsedMin) };
}

/**
 * Capacité maximale de population selon le nombre de maisons.
 */
function getPopulationCapacity(planet) {
  const houses = planet.buildings.house || 0;
  return BASE_POP_CAPACITY + houses * HOUSE_CAPACITY;
}

/**
 * Applique une récolte complète : production des bâtiments, bonus de biome,
 * consommation de nourriture par la population, évolution bonheur/population/XP.
 * Mute directement l'objet `planet` (resources, population, happiness, xp).
 * @returns {{ gains: Object, upkeep: number, populationChange: number, happinessChange: number, xpGained: number }}
 */
function applyHarvest(planet) {
  const gains = { food: 0, energy: 0, minerals: 0 };
  let xpGained = 5; // XP de base pour toute récolte

  for (const [type, def] of Object.entries(BUILDINGS)) {
    const count = planet.buildings[type] || 0;
    if (count <= 0 || !def.produces) continue;
    const perBuilding = 8;
    const amount = count * perBuilding;
    if (def.produces === 'xp') xpGained += amount;
    else gains[def.produces] = (gains[def.produces] || 0) + amount;
  }

  // Bonus de biome : +20% sur la ressource favorite
  const biome = BIOMES[planet.type];
  if (biome?.bonus && biome.bonus !== 'xp' && gains[biome.bonus] !== undefined) {
    gains[biome.bonus] = Math.round(gains[biome.bonus] * 1.2);
  } else if (biome?.bonus === 'xp') {
    xpGained = Math.round(xpGained * 1.2);
  }

  for (const [res, amount] of Object.entries(gains)) {
    planet.resources[res] = (planet.resources[res] || 0) + amount;
  }

  // Consommation de nourriture par la population (upkeep)
  const upkeep = Math.ceil(planet.population * 0.5);
  planet.resources.food = (planet.resources.food || 0) - upkeep;

  let populationChange = 0;
  let happinessChange = 0;

  if (planet.resources.food < 0) {
    // Famine : la population et le bonheur chutent, la nourriture ne va pas sous 0
    planet.resources.food = 0;
    populationChange = -Math.max(1, Math.floor(planet.population * 0.1));
    happinessChange = -15;
  } else {
    const capacity = getPopulationCapacity(planet);
    if (planet.population < capacity && planet.resources.food >= 20) {
      populationChange = Math.min(3, capacity - planet.population);
    }
    happinessChange = planet.resources.food >= 20 ? 5 : -2;
  }

  planet.population = Math.max(0, planet.population + populationChange);
  planet.happiness = Math.max(0, Math.min(100, planet.happiness + happinessChange));
  planet.xp += xpGained;
  planet.lastHarvest = new Date();

  const levelResult = checkLevelUp(planet);

  return { gains, upkeep, populationChange, happinessChange, xpGained, levelResult };
}

/**
 * Tente de construire un bâtiment. Vérifie le niveau requis et les ressources.
 * Mute `planet` en cas de succès.
 * @returns {{ ok: boolean, error?: string, cost?: Object }}
 */
function applyBuild(planet, buildingType) {
  const def = BUILDINGS[buildingType];
  if (!def) return { ok: false, error: 'unknown_building' };
  if (planet.level < def.unlockLevel) return { ok: false, error: 'level_locked' };

  const currentCount = planet.buildings[buildingType] || 0;
  const cost = getBuildingCost(buildingType, currentCount);
  if (!canAfford(planet.resources, cost)) return { ok: false, error: 'insufficient_resources', cost };

  deductCost(planet.resources, cost);
  planet.buildings[buildingType] = currentCount + 1;
  planet.xp += 10;

  const levelResult = checkLevelUp(planet);
  return { ok: true, cost, levelResult };
}

/**
 * Barre de progression en emojis unicode (10 segments) vers le niveau suivant.
 */
function renderProgressBar(planet, segments = 10) {
  const needed = xpForNextLevel(planet.level);
  const ratio = needed > 0 ? Math.min(1, planet.xp / needed) : 1;
  const filled = Math.round(ratio * segments);
  return '🟩'.repeat(filled) + '⬛'.repeat(segments - filled);
}

module.exports = {
  GROWTH_STAGES, BIOMES, BUILDINGS, HOUSE_CAPACITY, BASE_POP_CAPACITY,
  getGrowthStage, getBuildingCost, canAfford, deductCost,
  xpForNextLevel, checkLevelUp, checkHarvestCooldown, getPopulationCapacity,
  applyHarvest, applyBuild, renderProgressBar,
};
