// utils/territoryEngine.js — Logique du jeu de guerre de territoires
const Territory      = require('../models/Territory');
const TerritoryGuild  = require('../models/TerritoryGuild');
const { getAllZoneIds, ZONE_NAMES } = require('./territoryMap');

const RANKS = [
  { min: 0,  name: 'Recrue' },
  { min: 5,  name: 'Éclaireur' },
  { min: 15, name: 'Conquérant' },
  { min: 30, name: 'Seigneur de Guerre' },
  { min: 60, name: 'Empereur des Territoires' },
];

function rankForCaptures(n) {
  let best = RANKS[0].name;
  for (const r of RANKS) if (n >= r.min) best = r.name;
  return best;
}

// Initialise les zones si la collection est vide (au premier démarrage)
async function ensureMapInitialized() {
  const count = await Territory.countDocuments();
  if (count > 0) return;

  const ids = getAllZoneIds();
  const docs = ids.map((zoneId, i) => {
    // 1 zone sur 6 est "rare" (tier 2), 1 sur 15 est "légendaire" (tier 3)
    let tier = 1;
    if (i % 15 === 7) tier = 3;
    else if (i % 6 === 3) tier = 2;
    return {
      zoneId,
      name: ZONE_NAMES[i % ZONE_NAMES.length],
      tier,
      power: 0,
      ownerGuildId: null,
    };
  });
  await Territory.insertMany(docs);
  console.log(`✅ Carte des territoires initialisée (${docs.length} zones)`);
}

// Décroissance naturelle du power dans le temps (appelée périodiquement)
async function decayPower() {
  await Territory.updateMany(
    { power: { $gt: 0 } },
    { $inc: { power: -5 } }
  );
  await Territory.updateMany({ power: { $lt: 0 } }, { $set: { power: 0 } });
}

/**
 * Une "attaque" déclenchée par un bump.
 * Choisit une zone aléatoire pondérée et applique la logique de capture/renforcement.
 * Retourne un résultat décrivant ce qui s'est passé pour l'affichage dans /bump.
 */
async function attemptTerritoryAttack(guildId, guildName) {
  await ensureMapInitialized();

  const allZones = await Territory.find();
  if (!allZones.length) return null;

  // Cibler en priorité une zone : soit possédée par nous (renfort), soit libre/ennemie (attaque) — aléatoire pondéré
  const myZones    = allZones.filter(z => z.ownerGuildId === guildId);
  const otherZones = allZones.filter(z => z.ownerGuildId !== guildId);

  // 35% de chance de renforcer une zone déjà possédée (si on en a), sinon attaque
  const reinforce = myZones.length > 0 && Math.random() < 0.35;
  const pool = reinforce ? myZones : otherZones;
  const target = pool[Math.floor(Math.random() * pool.length)];
  if (!target) return null;

  const attackPower = 60 + Math.floor(Math.random() * 50); // 60-110 power par bump

  let result = { zone: target, type: null, attackPower };

  if (!target.ownerGuildId) {
    // Zone libre → capture immédiate
    target.ownerGuildId = guildId;
    target.ownerName    = guildName;
    target.power        = attackPower;
    target.capturedAt   = new Date();
    await target.save();
    result.type = 'capture_free';

  } else if (target.ownerGuildId === guildId) {
    // Renfort de notre propre zone
    target.power = Math.min(500, target.power + attackPower);
    await target.save();
    result.type = 'reinforce';

  } else {
    // Attaque d'une zone ennemie
    if (attackPower >= target.power) {
      const previousOwner = target.ownerGuildId;
      const previousName  = target.ownerName;
      target.ownerGuildId = guildId;
      target.ownerName    = guildName;
      target.power        = attackPower - target.power;
      target.capturedAt   = new Date();
      await target.save();
      result.type = 'capture_enemy';
      result.previousOwner = previousOwner;
      result.previousName  = previousName;

      // Stats du perdant
      await TerritoryGuild.findOneAndUpdate(
        { guildId: previousOwner },
        { $inc: { totalLost: 1 } },
        { upsert: true }
      );
    } else {
      target.power -= attackPower;
      await target.save();
      result.type = 'attack_failed';
      result.remainingPower = target.power;
    }
  }

  // Mise à jour stats du serveur attaquant
  const isCapture = result.type === 'capture_free' || result.type === 'capture_enemy';
  const tgUpdate = await TerritoryGuild.findOneAndUpdate(
    { guildId },
    {
      $set: { guildName },
      $inc: { totalCaptures: isCapture ? 1 : 0, warCoins: isCapture ? 30 : 5 },
    },
    { upsert: true, new: true }
  );
  tgUpdate.rank = rankForCaptures(tgUpdate.totalCaptures);
  await tgUpdate.save();

  result.warCoinsEarned = isCapture ? 30 : 5;
  result.newRank = tgUpdate.rank;
  result.totalCaptures = tgUpdate.totalCaptures;

  return result;
}

module.exports = { ensureMapInitialized, decayPower, attemptTerritoryAttack, rankForCaptures, RANKS };
