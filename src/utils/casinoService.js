'use strict';
// utils/casinoService.js — La seule porte qui touche à l'argent du casino.
//
// Répartition des responsabilités :
//   • casinoEngine décide du résultat d'une partie (pur, testable) ;
//   • ce module débite, crédite, met à jour le profil et la cagnotte ;
//   • casinoView dessine, la commande route.
//
// Garanties :
//   • le débit est atomique (`coins >= mise` évalué par la base) : jamais de
//     solde négatif, même avec deux clics simultanés ;
//   • si la partie échoue après le débit, la mise est rendue ;
//   • si le crédit du gain échoue, la mise est rendue aussi ;
//   • une table de blackjack est persistée (CasinoRound) : un redémarrage ne
//     perd pas la mise, la table est réglée à la prochaine action ou balayée.
//
// Testable hors ligne : `models` accepte des modèles factices (même convention
// que utils/economy.js et utils/dbMaintenance.js).

const engine = require('./casinoEngine');

const DEFAULTS = {
  Balance: require('../models/Balance'),
  CasinoConfig: require('../models/CasinoConfig'),
  CasinoProfile: require('../models/CasinoProfile'),
  CasinoRound: require('../models/CasinoRound'),
};

const DAY_MS = 24 * 60 * 60 * 1000;
const BLACKJACK_TTL_MS = 10 * 60 * 1000;
const ROUND_RETENTION_MS = 7 * DAY_MS;

async function readOne(query) {
  if (!query) return null;
  if (typeof query.lean === 'function') return query.lean().catch(() => null);
  return query;
}

async function getConfig(guildId, { models = DEFAULTS } = {}) {
  let raw = null;
  try {
    raw = await readOne(models.CasinoConfig.findOne({ guildId }));
  } catch { raw = null; }
  return engine.normalizeConfig(raw || { guildId });
}

async function saveConfig(guildId, patch = {}, { models = DEFAULTS } = {}) {
  const doc = await models.CasinoConfig.findOneAndUpdate(
    { guildId },
    { $set: { ...patch } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return engine.normalizeConfig(doc || { guildId, ...patch });
}

async function getProfile(guildId, userId, { models = DEFAULTS } = {}) {
  let raw = null;
  try {
    raw = await readOne(models.CasinoProfile.findOne({ guildId, userId }));
  } catch { raw = null; }
  return engine.normalizeProfile(raw || {}, { guildId, userId });
}

async function getBalance(guildId, userId, { models = DEFAULTS } = {}) {
  let raw = null;
  try {
    raw = await readOne(models.Balance.findOne({ guildId, userId }));
  } catch { raw = null; }
  return Math.max(0, Math.trunc(Number(raw?.coins) || 0));
}

/**
 * Débit atomique d'une mise. Ne crédite personne : la cagnotte est mise à jour
 * séparément, après le résultat.
 */
async function debitStake({ guildId, userId, amount, models = DEFAULTS } = {}) {
  const stake = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!stake) return { ok: false, code: 'amount', message: 'Mise invalide.' };

  try {
    const doc = await models.Balance.findOneAndUpdate(
      { guildId, userId, coins: { $gte: stake } },
      { $inc: { coins: -stake } },
      { new: true },
    );
    if (!doc) {
      const have = await getBalance(guildId, userId, { models });
      return {
        ok: false,
        code: 'insufficient',
        message: `Solde insuffisant : tu as **${engine.fmt(have)}** 🪙, il faut **${engine.fmt(stake)}**.`,
      };
    }
    return { ok: true, coins: Math.max(0, Math.trunc(Number(doc.coins) || 0)) };
  } catch (err) {
    return { ok: false, code: 'db', message: `Base indisponible, aucune mise débitée : ${err.message}` };
  }
}

async function creditCoins({ guildId, userId, amount, models = DEFAULTS } = {}) {
  const gain = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!gain) return { ok: true, coins: null };

  try {
    const doc = await models.Balance.findOneAndUpdate(
      { guildId, userId },
      { $inc: { coins: gain } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return { ok: true, coins: Math.max(0, Math.trunc(Number(doc?.coins) || 0)) };
  } catch (err) {
    return { ok: false, code: 'db', message: `Le gain n’a pas pu être crédité : ${err.message}` };
  }
}

/**
 * Écrit les statistiques calculées par engine.applyRound.
 * Un échec d'écriture ne doit jamais annuler une partie déjà réglée : les
 * erreurs sont avalées, seul le retour du service compte.
 */
async function persistProfile({ guildId, userId, profile, bet, payout, net, now, jackpotWon = false, models = DEFAULTS } = {}) {
  const increments = {
    wagered: bet,
    payout,
    gamesPlayed: 1,
    xp: engine.xpForRound({ bet, net }),
  };

  if (net > 0) increments.wins = 1;
  else if (net < 0) increments.losses = 1;
  else increments.pushes = 1;
  if (jackpotWon) increments.jackpotsWon = 1;

  const update = {
    $inc: increments,
    $max: {
      biggestWin: Math.max(0, net),
      bestStreak: Math.max(0, profile.bestStreak),
    },
    $set: {
      guildId,
      userId,
      streak: Math.max(0, profile.streak),
      level: profile.level,
      lastBetAt: new Date(now),
      lastGame: profile.lastGame || null,
      dailyKey: profile.dailyKey || null,
      dailyLoss: Math.max(0, profile.dailyLoss),
    },
    $push: {
      history: {
        $each: [{ game: profile.lastGame || null, bet, payout, net, at: new Date(now) }],
        $slice: -engine.HISTORY_LENGTH,
      },
    },
  };

  try {
    await models.CasinoProfile.findOneAndUpdate(
      { guildId, userId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    console.warn('[Casino] statistiques non enregistrées :', err.message);
  }
}

/** Ajoute la part de cagnotte, ou remet la cagnotte à son montant de départ. */
async function updateJackpot({ guildId, contribution = 0, won = 0, config, models = DEFAULTS, now = Date.now(), userId = null } = {}) {
  const cfg = config || await getConfig(guildId, { models });

  try {
    if (won > 0) {
      await models.CasinoConfig.findOneAndUpdate(
        { guildId },
        {
          $set: {
            jackpot: cfg.jackpotSeed,
            lastJackpot: { userId, amount: Math.trunc(won), at: new Date(now) },
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return cfg.jackpotSeed;
    }

    if (contribution > 0) {
      const doc = await models.CasinoConfig.findOneAndUpdate(
        { guildId },
        { $inc: { jackpot: contribution } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return Math.max(0, Math.trunc(Number(doc?.jackpot) || cfg.jackpot + contribution));
    }
  } catch (err) {
    console.warn('[Casino] cagnotte non mise à jour :', err.message);
  }

  return cfg.jackpot;
}

/** Vérifie tout avant de toucher au moindre solde. */
async function prepareBet({ guildId, userId, channelId, game, bet, now = Date.now(), models = DEFAULTS } = {}) {
  const config = await getConfig(guildId, { models });
  const profile = await getProfile(guildId, userId, { models });
  const balance = await getBalance(guildId, userId, { models });
  const check = engine.validateBet({ config, profile, game, bet, balance, channelId, now });
  if (!check.ok) return check;
  return { ok: true, config, profile, balance, bet: check.bet };
}

/**
 * Joue une partie instantanée (machine, roulette, dés, pièce).
 * @returns {Promise<object>} { ok:true, outcome, payout, net, profile, balance, jackpot, ... }
 */
async function playInstant({
  guildId,
  userId,
  channelId,
  game,
  bet,
  choice = null,
  number = null,
  now = Date.now(),
  models = DEFAULTS,
  rng = Math.random,
} = {}) {
  const prep = await prepareBet({ guildId, userId, channelId, game, bet, now, models });
  if (!prep.ok) return prep;

  const debit = await debitStake({ guildId, userId, amount: prep.bet, models });
  if (!debit.ok) return debit;

  let outcome;
  try {
    outcome = engine.playGame({ game, bet: prep.bet, choice, number, rng });
  } catch (err) {
    await creditCoins({ guildId, userId, amount: prep.bet, models });
    return { ok: false, code: 'engine', message: 'La partie n’a pas pu se terminer : ta mise a été rendue.' };
  }

  let jackpotAmount = 0;
  if (game === 'machine' && outcome.jackpot) {
    jackpotAmount = Math.max(prep.config.jackpotSeed, prep.config.jackpot);
    outcome.payout += jackpotAmount;
  }

  const payout = Math.max(0, Math.trunc(outcome.payout || 0));
  const credit = payout > 0
    ? await creditCoins({ guildId, userId, amount: payout, models })
    : { ok: true, coins: debit.coins };

  if (!credit.ok) {
    await creditCoins({ guildId, userId, amount: prep.bet, models });
    return { ok: false, code: 'credit', message: 'Le gain n’a pas pu être versé : ta mise a été rendue.' };
  }

  const applied = engine.applyRound(prep.profile, {
    game, bet: prep.bet, payout, now, jackpotWon: jackpotAmount > 0,
  });

  await persistProfile({
    guildId, userId, profile: applied.profile, bet: prep.bet, payout, net: applied.net, now,
    jackpotWon: jackpotAmount > 0, models,
  });

  const jackpot = await updateJackpot({
    guildId,
    contribution: engine.contributionFor(prep.bet, prep.config),
    won: jackpotAmount,
    config: prep.config,
    models,
    now,
    userId,
  });

  return {
    ok: true,
    game,
    bet: prep.bet,
    payout,
    net: payout - prep.bet,
    outcome,
    profile: applied.profile,
    balance: credit.coins ?? debit.coins,
    jackpot,
    jackpotAmount,
    config: prep.config,
  };
}

// ── Blackjack persistant ────────────────────────────────────────────────────
async function loadRound(roundId, { models = DEFAULTS } = {}) {
  try {
    return await models.CasinoRound.findById(roundId);
  } catch {
    return null;
  }
}

function isExpired(round, now = Date.now()) {
  return Boolean(round?.expiresAt && new Date(round.expiresAt).getTime() <= now);
}

async function startBlackjack({
  guildId, userId, channelId, bet, now = Date.now(), models = DEFAULTS, rng = Math.random,
} = {}) {
  const prep = await prepareBet({ guildId, userId, channelId, game: 'blackjack', bet, now, models });
  if (!prep.ok) return prep;

  const debit = await debitStake({ guildId, userId, amount: prep.bet, models });
  if (!debit.ok) return debit;

  const state = engine.newBlackjack({ rng });
  let round;
  try {
    round = await models.CasinoRound.create({
      guildId,
      userId,
      channelId,
      game: 'blackjack',
      bet: prep.bet,
      state,
      status: 'active',
      expiresAt: new Date(now + BLACKJACK_TTL_MS),
    });
  } catch (err) {
    await creditCoins({ guildId, userId, amount: prep.bet, models });
    return { ok: false, code: 'db', message: 'Impossible d’ouvrir la table : ta mise a été rendue.' };
  }

  const natural = engine.isBlackjack(state.player) || engine.isBlackjack(state.dealer);
  if (natural) {
    const settlement = await settleBlackjack(round, { models, now, rng });
    return { ok: true, round: settlement.round || round, settled: true, settlement, config: prep.config };
  }

  return { ok: true, round, settled: false, config: prep.config, balance: debit.coins };
}

async function hitBlackjack({ roundId, userId, now = Date.now(), models = DEFAULTS, rng = Math.random } = {}) {
  const round = await loadRound(roundId, { models });
  if (!round) return { ok: false, code: 'missing', message: 'Cette table n’existe plus : la mise a déjà été réglée.' };
  if (String(round.userId) !== String(userId)) return { ok: false, code: 'owner', message: 'Cette table ne t’appartient pas.' };
  if (round.status !== 'active') return { ok: false, code: 'finished', message: 'Cette partie est déjà terminée.' };

  if (isExpired(round, now)) {
    const settlement = await settleBlackjack(round, { models, now, rng });
    return { ok: true, settled: true, settlement, round: settlement.round || round };
  }

  const state = round.state || {};
  state.player = state.player || [];
  state.player.push(engine.drawCard(state, rng));
  round.markModified?.('state');

  if (engine.handValue(state.player).total >= 21) {
    const settlement = await settleBlackjack(round, { models, now, rng });
    return { ok: true, settled: true, settlement, round: settlement.round || round };
  }

  await round.save?.()?.catch?.(() => {});
  return { ok: true, settled: false, round };
}

async function standBlackjack({ roundId, userId, now = Date.now(), models = DEFAULTS, rng = Math.random } = {}) {
  const round = await loadRound(roundId, { models });
  if (!round) return { ok: false, code: 'missing', message: 'Cette table n’existe plus : la mise a déjà été réglée.' };
  if (String(round.userId) !== String(userId)) return { ok: false, code: 'owner', message: 'Cette table ne t’appartient pas.' };
  if (round.status !== 'active') return { ok: false, code: 'finished', message: 'Cette partie est déjà terminée.' };

  const settlement = await settleBlackjack(round, { models, now, rng });
  return { ok: true, settled: true, settlement, round: settlement.round || round };
}

async function doubleBlackjack({ roundId, userId, now = Date.now(), models = DEFAULTS, rng = Math.random } = {}) {
  const round = await loadRound(roundId, { models });
  if (!round) return { ok: false, code: 'missing', message: 'Cette table n’existe plus : la mise a déjà été réglée.' };
  if (String(round.userId) !== String(userId)) return { ok: false, code: 'owner', message: 'Cette table ne t’appartient pas.' };
  if (round.status !== 'active') return { ok: false, code: 'finished', message: 'Cette partie est déjà terminée.' };
  if (isExpired(round, now)) {
    const settlement = await settleBlackjack(round, { models, now, rng });
    return { ok: true, settled: true, settlement, round: settlement.round || round };
  }
  if ((round.state?.player || []).length !== 2) {
    return { ok: false, code: 'double', message: 'On ne peut doubler qu’avec deux cartes.' };
  }

  const extra = await debitStake({ guildId: round.guildId, userId, amount: round.bet, models });
  if (!extra.ok) return { ok: false, code: 'insufficient', message: 'Solde insuffisant pour doubler la mise.' };

  round.bet = Math.max(0, Math.trunc(Number(round.bet) || 0)) * 2;
  round.state = round.state || {};
  round.state.doubled = true;
  round.state.player = round.state.player || [];
  round.state.player.push(engine.drawCard(round.state, rng));
  round.markModified?.('state');

  const settlement = await settleBlackjack(round, { models, now, rng });
  return { ok: true, settled: true, settlement, round: settlement.round || round };
}

/**
 * Règle une table : croupier, résultat, crédit, statistiques, cagnotte.
 * Idempotent : une table déjà réglée n'est jamais recréditée.
 */
async function settleBlackjack(round, { models = DEFAULTS, now = Date.now(), rng = Math.random } = {}) {
  if (!round) return { ok: false, code: 'missing', message: 'Table introuvable.' };
  if (round.status !== 'active') {
    return { ok: true, already: true, round, profile: await getProfile(round.guildId, round.userId, { models }) };
  }

  const config = await getConfig(round.guildId, { models });
  const state = round.state || {};
  engine.dealerPlay(state, rng);
  const outcome = engine.blackjackOutcome(state, round.bet);

  const credit = outcome.payout > 0
    ? await creditCoins({ guildId: round.guildId, userId: round.userId, amount: outcome.payout, models })
    : { ok: true, coins: null };

  if (!credit.ok) {
    return { ok: false, code: 'credit', message: 'Le gain n’a pas pu être versé. Contacte un administrateur.' };
  }

  const profile = await getProfile(round.guildId, round.userId, { models });
  const applied = engine.applyRound(profile, {
    game: 'blackjack',
    bet: round.bet,
    payout: outcome.payout,
    now,
    jackpotWon: false,
  });

  await persistProfile({
    guildId: round.guildId,
    userId: round.userId,
    profile: applied.profile,
    bet: round.bet,
    payout: outcome.payout,
    net: applied.net,
    now,
    models,
  });

  await updateJackpot({
    guildId: round.guildId,
    contribution: engine.contributionFor(round.bet, config),
    won: 0,
    config,
    models,
    now,
    userId: round.userId,
  });

  round.status = 'finished';
  round.outcome = outcome.result;
  round.payout = outcome.payout;
  round.state = state;
  round.settledAt = new Date(now);
  round.markModified?.('state');
  await round.save?.()?.catch?.(() => {});

  return {
    ok: true,
    round,
    outcome,
    profile: applied.profile,
    payout: outcome.payout,
    net: outcome.payout - round.bet,
    balance: credit.coins,
    config,
  };
}

/** Règle les tables expirées (redémarrage, membre parti) et purge les vieilles. */
async function settleStaleRounds({ guildId, now = Date.now(), models = DEFAULTS } = {}) {
  let rounds = [];
  try {
    const query = models.CasinoRound.find({
      guildId,
      status: 'active',
      expiresAt: { $lte: new Date(now) },
    });
    if (query && typeof query.limit === 'function') query.limit(25);
    rounds = await query;
  } catch {
    rounds = [];
  }

  let settled = 0;
  for (const round of rounds) {
    const result = await settleBlackjack(round, { models, now });
    if (result.ok) settled += 1;
  }

  if (models.CasinoRound.deleteMany) {
    try {
      await models.CasinoRound.deleteMany({
        guildId,
        status: 'finished',
        settledAt: { $lt: new Date(now - ROUND_RETENTION_MS) },
      });
    } catch { /* purge facultative */ }
  }

  return { settled };
}

// ── Lecture pour les panels ─────────────────────────────────────────────────
async function getLeaderboard({ guildId, sort = 'profit', limit = 10, models = DEFAULTS } = {}) {
  const order = sort === 'wagered' ? { wagered: -1 } : sort === 'wins' ? { wins: -1 } : { profit: -1 };
  try {
    const query = models.CasinoProfile.find({ guildId, gamesPlayed: { $gt: 0 } });
    if (query && typeof query.sort === 'function') query.sort(order);
    if (query && typeof query.limit === 'function') query.limit(Math.min(Math.max(1, limit), 25));
    const rows = await query;
    return (rows || []).map(row => engine.normalizeProfile(row, { guildId }));
  } catch {
    return [];
  }
}

async function getHistory({ guildId, userId, models = DEFAULTS } = {}) {
  const profile = await getProfile(guildId, userId, { models });
  return [...profile.history].reverse();
}

async function setSelfExclusion({ guildId, userId, until = null, models = DEFAULTS } = {}) {
  await models.CasinoProfile.findOneAndUpdate(
    { guildId, userId },
    { $set: { selfExcludeUntil: until ? new Date(until) : null } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).catch(() => null);
  return getProfile(guildId, userId, { models });
}

async function setLossLimit({ guildId, userId, limit = 0, models = DEFAULTS } = {}) {
  const value = Math.max(0, Math.trunc(Number(limit) || 0));
  await models.CasinoProfile.findOneAndUpdate(
    { guildId, userId },
    { $set: { lossLimit: value } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).catch(() => null);
  return getProfile(guildId, userId, { models });
}

module.exports = {
  DEFAULTS,
  BLACKJACK_TTL_MS,
  getConfig,
  saveConfig,
  getProfile,
  getBalance,
  prepareBet,
  debitStake,
  creditCoins,
  playInstant,
  startBlackjack,
  hitBlackjack,
  standBlackjack,
  doubleBlackjack,
  settleBlackjack,
  settleStaleRounds,
  getLeaderboard,
  getHistory,
  setSelfExclusion,
  setLossLimit,
  updateJackpot,
  __testables: { isExpired, readOne },
};
