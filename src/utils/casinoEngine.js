'use strict';
// utils/casinoEngine.js — Toute la mécanique du casino, sans Discord ni base.
//
// Pourquoi ce module est séparé : les jeux sont la partie où une erreur coûte
// des pièces réelles (virtuelles, mais gagnées). Ici tout est calculé à partir
// d'un générateur aléatoire injectable et d'un état passé en argument :
//   • les probabilités et les gains sont testables hors ligne, à seed fixe ;
//   • le service (casinoService) ne fait que débiter, créditer et journaliser ;
//   • les vues (casinoView) ne décident jamais d'un gain.
//
// Aucune fonction de ce fichier n'écrit en base ni ne jette sur une entrée
// utilisateur : une mise invalide renvoie { ok: false, code, message }.

const GAMES = {
  machine: {
    id: 'machine', emoji: '🎰', label: 'Machine à sous',
    hint: '3 symboles alignés — jusqu’à ×100, plus le jackpot sur 🎰🎰🎰',
    defaultChoice: null,
  },
  roulette: {
    id: 'roulette', emoji: '🎡', label: 'Roulette',
    hint: 'Rouge/noir, pair/impair, 1-18/19-36 (×2) ou numéro exact (×36)',
    defaultChoice: 'rouge',
  },
  blackjack: {
    id: 'blackjack', emoji: '🃏', label: 'Blackjack',
    hint: 'Battez le croupier sans dépasser 21 — blackjack payé ×2,5',
    defaultChoice: null,
  },
  des: {
    id: 'des', emoji: '🎲', label: 'Dés',
    hint: 'Somme de 2 dés : bas (2-6), sept (7) ou haut (8-12)',
    defaultChoice: 'bas',
  },
  piece: {
    id: 'piece', emoji: '🪙', label: 'Pile ou face',
    hint: 'Un lancer, ×1,95 si tu devines le bon côté',
    defaultChoice: 'pile',
  },
};

const GAME_IDS = Object.keys(GAMES);

const DEFAULT_CONFIG = {
  enabled: true,
  channelIds: [],
  minBet: 10,
  maxBet: 5000,
  cooldownSec: 5,
  jackpot: 1000,
  jackpotSeed: 1000,
  jackpotPercent: 5,
  games: { machine: true, roulette: true, blackjack: true, des: true, piece: true },
  announceWins: true,
  announceThreshold: 5000,
  lastJackpot: null,
};

const MAX_BET = 1_000_000;
const HISTORY_LENGTH = 10;

const TITLES = [
  { min: 1,  label: 'Curieux' },
  { min: 5,  label: 'Habitué' },
  { min: 10, label: 'Joueur' },
  { min: 20, label: 'Requin' },
  { min: 35, label: 'High Roller' },
  { min: 50, label: 'Légende du casino' },
];

// ── Petits utilitaires ───────────────────────────────────────────────────────
function fmt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString('fr-FR') : '0';
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = toInt(value, fallback);
  return Math.max(min, Math.min(max, n));
}

function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** Lit une mise humaine : « 250 », « 1 000 », « 250 pièces », « 250 coins ». */
function parseBet(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[\s\u00a0\u202f_'’]/g, '')
    .replace(/🪙/g, '')
    .replace(/pi[eè]ces?$/, '')
    .replace(/coins?$/, '');

  if (!/^\d{1,9}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function levelFromXp(xp) {
  const value = Math.max(0, toInt(xp, 0));
  return 1 + Math.floor(Math.sqrt(value / 40));
}

function titleForLevel(level) {
  const value = Math.max(1, toInt(level, 1));
  let label = TITLES[0].label;
  for (const entry of TITLES) if (value >= entry.min) label = entry.label;
  return label;
}

function xpForRound({ bet = 0, net = 0 } = {}) {
  return Math.max(1, Math.floor(Math.max(0, toInt(bet, 0)) / 100)) + (net > 0 ? 10 : 2);
}

// ── Configuration ────────────────────────────────────────────────────────────
function normalizeConfig(raw) {
  const src = raw || {};
  const minBet = clampInt(src.minBet, 1, MAX_BET, DEFAULT_CONFIG.minBet);
  const maxBet = clampInt(src.maxBet, minBet, MAX_BET, Math.max(minBet, DEFAULT_CONFIG.maxBet));

  const rawGames = src.games || {};
  const games = {};
  for (const id of GAME_IDS) {
    games[id] = typeof rawGames[id] === 'boolean' ? rawGames[id] : true;
  }

  return {
    guildId: src.guildId || null,
    enabled: src.enabled !== false,
    channelIds: Array.isArray(src.channelIds) ? src.channelIds.map(String).slice(0, 20) : [],
    minBet,
    maxBet,
    cooldownSec: clampInt(src.cooldownSec, 0, 3600, DEFAULT_CONFIG.cooldownSec),
    jackpot: Number.isFinite(Number(src.jackpot)) ? Math.max(0, toInt(src.jackpot, 0)) : DEFAULT_CONFIG.jackpot,
    jackpotSeed: clampInt(src.jackpotSeed, 100, MAX_BET, DEFAULT_CONFIG.jackpotSeed),
    jackpotPercent: clampInt(src.jackpotPercent, 0, 25, DEFAULT_CONFIG.jackpotPercent),
    games,
    announceWins: src.announceWins !== false,
    announceThreshold: clampInt(src.announceThreshold, 0, MAX_BET, DEFAULT_CONFIG.announceThreshold),
    lastJackpot: src.lastJackpot?.at ? {
      userId: src.lastJackpot.userId || null,
      amount: Math.max(0, toInt(src.lastJackpot.amount, 0)),
      at: new Date(src.lastJackpot.at).getTime(),
    } : null,
  };
}

// ── Profils ─────────────────────────────────────────────────────────────────
function normalizeProfile(raw, { guildId = null, userId = null } = {}) {
  const src = raw || {};
  const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Math.max(0, toInt(value, fallback)) : fallback);

  const wagered = num(src.wagered);
  const payout = num(src.payout);
  const xp = num(src.xp);
  const level = levelFromXp(xp);
  const streak = num(src.streak);

  return {
    guildId: src.guildId || guildId,
    userId: src.userId || userId,
    wagered,
    payout,
    profit: Number.isFinite(Number(src.profit)) ? toInt(src.profit, 0) : payout - wagered,
    gamesPlayed: num(src.gamesPlayed),
    wins: num(src.wins),
    losses: num(src.losses),
    pushes: num(src.pushes),
    jackpotsWon: num(src.jackpotsWon),
    biggestWin: num(src.biggestWin),
    streak,
    bestStreak: Math.max(num(src.bestStreak), streak),
    xp,
    level,
    title: titleForLevel(level),
    lastBetAt: src.lastBetAt ? new Date(src.lastBetAt).getTime() : 0,
    lastGame: src.lastGame || null,
    lossLimit: num(src.lossLimit),
    dailyKey: src.dailyKey || null,
    dailyLoss: num(src.dailyLoss),
    selfExcludeUntil: src.selfExcludeUntil ? new Date(src.selfExcludeUntil).getTime() : 0,
    history: Array.isArray(src.history)
      ? src.history.slice(-HISTORY_LENGTH).map(entry => ({
        game: entry?.game || null,
        bet: Math.max(0, toInt(entry?.bet, 0)),
        payout: Math.max(0, toInt(entry?.payout, 0)),
        net: toInt(entry?.net, 0),
        at: entry?.at ? new Date(entry.at).getTime() : 0,
      }))
      : [],
  };
}

const fail = (code, message) => ({ ok: false, code, message });

/** Applique une partie au profil (pure). Renvoie le profil suivant + le net. */
function applyRound(profile, { game, bet, payout, now = Date.now(), jackpotWon = false } = {}) {
  const base = normalizeProfile(profile);
  const stake = Math.max(0, toInt(bet, 0));
  const returned = Math.max(0, toInt(payout, 0));
  const net = returned - stake;

  const next = { ...base, history: [...base.history] };
  next.wagered += stake;
  next.payout += returned;
  next.profit = next.payout - next.wagered;
  next.gamesPlayed += 1;

  if (net > 0) {
    next.wins += 1;
    next.streak += 1;
    next.bestStreak = Math.max(next.bestStreak, next.streak);
  } else if (net < 0) {
    next.losses += 1;
    next.streak = 0;
  } else {
    next.pushes += 1;
  }

  if (jackpotWon) next.jackpotsWon += 1;
  next.biggestWin = Math.max(next.biggestWin, net);
  next.xp += xpForRound({ bet: stake, net });
  next.level = levelFromXp(next.xp);
  next.title = titleForLevel(next.level);
  next.lastBetAt = now;
  next.lastGame = game || null;

  const key = dayKey(now);
  if (next.dailyKey !== key) {
    next.dailyKey = key;
    next.dailyLoss = 0;
  }
  if (net < 0) next.dailyLoss += -net;

  next.history.push({ game: game || null, bet: stake, payout: returned, net, at: now });
  if (next.history.length > HISTORY_LENGTH) next.history = next.history.slice(-HISTORY_LENGTH);

  return { profile: next, net };
}

/** Toutes les règles d'une mise, sans I/O. */
function validateBet({ config, profile, game, bet, balance, channelId, now = Date.now() } = {}) {
  const cfg = normalizeConfig(config);
  const prof = normalizeProfile(profile);

  if (!cfg.enabled) return fail('disabled', 'Le casino est désactivé sur ce serveur.');
  if (!GAMES[game]) return fail('game', 'Ce jeu n’existe pas.');
  if (!cfg.games[game]) return fail('game_off', `Le jeu **${GAMES[game].label}** est désactivé sur ce serveur.`);

  if (cfg.channelIds.length && !cfg.channelIds.includes(String(channelId || ''))) {
    return fail('channel', 'Le casino n’est pas autorisé dans ce salon.');
  }

  const stake = parseBet(bet);
  if (!stake) return fail('bet', 'Indique une mise en pièces entières (ex. `100`).');
  if (stake < cfg.minBet) return fail('bet_min', `La mise minimum est de **${fmt(cfg.minBet)}** 🪙.`);
  if (stake > cfg.maxBet) return fail('bet_max', `La mise maximum est de **${fmt(cfg.maxBet)}** 🪙.`);

  const have = Math.max(0, toInt(balance, 0));
  if (stake > have) return fail('insufficient', `Solde insuffisant : tu as **${fmt(have)}** 🪙.`);

  if (prof.selfExcludeUntil && prof.selfExcludeUntil > now) {
    return fail('self_exclude', `Auto-exclusion active jusqu’à <t:${Math.ceil(prof.selfExcludeUntil / 1000)}:R>.`);
  }

  if (prof.lossLimit > 0 && prof.dailyKey === dayKey(now) && prof.dailyLoss >= prof.lossLimit) {
    return fail('loss_limit', `Limite de perte journalière atteinte (**${fmt(prof.lossLimit)}** 🪙). Elle se réinitialise demain.`);
  }

  const readyAt = (prof.lastBetAt || 0) + cfg.cooldownSec * 1000;
  if (cfg.cooldownSec > 0 && prof.lastBetAt && now < readyAt) {
    return fail('cooldown', `Doucement ! Réessaie <t:${Math.ceil(readyAt / 1000)}:R>.`);
  }

  return { ok: true, bet: stake, config: cfg, profile: prof };
}

// ── Machine à sous ──────────────────────────────────────────────────────────
// Symboles pondérés (sur 97) : le total des gains « 3 identiques » et des paires
// donne un retour joueur d'environ 93 %, la cagnotte ajoutant le reste.
const SLOT_SYMBOLS = [
  { key: 'cherry',  emoji: '🍒', weight: 30, triple: 4 },
  { key: 'lemon',   emoji: '🍋', weight: 24, triple: 6 },
  { key: 'bell',    emoji: '🔔', weight: 18, triple: 10 },
  { key: 'star',    emoji: '⭐', weight: 12, triple: 20 },
  { key: 'diamond', emoji: '💎', weight: 8,  triple: 50 },
  { key: 'seven',   emoji: '7️⃣', weight: 5,  triple: 100 },
];
const SLOT_WEIGHT = SLOT_SYMBOLS.reduce((sum, symbol) => sum + symbol.weight, 0);
const SLOT_PAIR_MULTIPLIER = 1.2;
const SLOT_JACKPOT_ODDS = 2500;

function pickSlotSymbol(rng) {
  let roll = rng() * SLOT_WEIGHT;
  for (const symbol of SLOT_SYMBOLS) {
    if (roll < symbol.weight) return symbol;
    roll -= symbol.weight;
  }
  return SLOT_SYMBOLS[0];
}

function spinSlots(rng = Math.random) {
  if (rng() < 1 / SLOT_JACKPOT_ODDS) {
    return { reels: ['🎰', '🎰', '🎰'], multiplier: 0, jackpot: true };
  }

  const picks = [pickSlotSymbol(rng), pickSlotSymbol(rng), pickSlotSymbol(rng)];
  let multiplier = 0;

  if (picks.every(symbol => symbol.key === picks[0].key)) {
    multiplier = picks[0].triple;
  } else if (
    picks[0].key === picks[1].key ||
    picks[0].key === picks[2].key ||
    picks[1].key === picks[2].key
  ) {
    multiplier = SLOT_PAIR_MULTIPLIER;
  }

  return { reels: picks.map(symbol => symbol.emoji), multiplier, jackpot: false };
}

// ── Roulette européenne (un seul 0) ─────────────────────────────────────────
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const ROULETTE_TYPES = [
  { value: 'rouge',  label: 'Rouge (×2)' },
  { value: 'noir',   label: 'Noir (×2)' },
  { value: 'pair',   label: 'Pair (×2)' },
  { value: 'impair', label: 'Impair (×2)' },
  { value: 'bas',    label: '1 à 18 (×2)' },
  { value: 'haut',   label: '19 à 36 (×2)' },
  { value: 'numero', label: 'Numéro exact (×36)' },
];

function spinRoulette(rng = Math.random) {
  return Math.floor(rng() * 37);
}

function rouletteColor(spin) {
  if (spin === 0) return 'vert';
  return RED_NUMBERS.has(spin) ? 'rouge' : 'noir';
}

function rouletteMultiplier(type, number, spin) {
  if (type === 'numero') return Number(number) === spin ? 36 : 0;
  if (spin === 0) return 0;

  switch (type) {
    case 'rouge': return RED_NUMBERS.has(spin) ? 2 : 0;
    case 'noir': return RED_NUMBERS.has(spin) ? 0 : 2;
    case 'pair': return spin % 2 === 0 ? 2 : 0;
    case 'impair': return spin % 2 === 1 ? 2 : 0;
    case 'bas': return spin <= 18 ? 2 : 0;
    case 'haut': return spin >= 19 ? 2 : 0;
    default: return 0;
  }
}

// ── Dés ─────────────────────────────────────────────────────────────────────
const DICE_CHOICES = [
  { value: 'bas',  label: 'Bas (2-6) — ×2,3' },
  { value: 'sept', label: 'Sept pile (7) — ×5,8' },
  { value: 'haut', label: 'Haut (8-12) — ×2,3' },
];
const DICE_MULTIPLIERS = { bas: 2.3, sept: 5.8, haut: 2.3 };

function rollDice(rng = Math.random) {
  return [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)];
}

function diceMultiplier(choice, total) {
  if (choice === 'bas' && total <= 6) return DICE_MULTIPLIERS.bas;
  if (choice === 'sept' && total === 7) return DICE_MULTIPLIERS.sept;
  if (choice === 'haut' && total >= 8) return DICE_MULTIPLIERS.haut;
  return 0;
}

// ── Pile ou face ────────────────────────────────────────────────────────────
const COIN_CHOICES = [
  { value: 'pile', label: 'Pile' },
  { value: 'face', label: 'Face' },
];
const COIN_MULTIPLIER = 1.95;

function flipCoin(rng = Math.random) {
  return rng() < 0.5 ? 'pile' : 'face';
}

// ── Blackjack ───────────────────────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const BLACKJACK_DECKS = 6;

function buildDeck(rng = Math.random, decks = BLACKJACK_DECKS) {
  const cards = [];
  for (let deck = 0; deck < decks; deck += 1) {
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ r: rank, s: suit });
  }
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function cardValue(card) {
  if (!card) return 0;
  if (card.r === 'A') return 11;
  if (['K', 'Q', 'J', '10'].includes(card.r)) return 10;
  return Number(card.r) || 0;
}

function handValue(cards = []) {
  let total = cards.reduce((sum, card) => sum + cardValue(card), 0);
  let aces = cards.filter(card => card?.r === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

function isBlackjack(cards = []) {
  return cards.length === 2 && handValue(cards).total === 21;
}

function drawCard(state, rng = Math.random) {
  if (!Array.isArray(state.deck) || state.deck.length === 0) state.deck = buildDeck(rng);
  return state.deck.pop();
}

/** Ouvre une table : sabot mélangé et quatre cartes distribuées. */
function newBlackjack({ rng = Math.random, decks = BLACKJACK_DECKS } = {}) {
  const state = { deck: buildDeck(rng, decks), player: [], dealer: [], doubled: false };
  state.player.push(drawCard(state, rng), drawCard(state, rng));
  state.dealer.push(drawCard(state, rng), drawCard(state, rng));
  return state;
}

/** Le croupier tire jusqu'à 17 (le 17 souple est conservé). */
function dealerPlay(state, rng = Math.random) {
  while (handValue(state.dealer).total < 17) {
    state.dealer.push(drawCard(state, rng));
  }
  return state;
}

function blackjackOutcome(state, bet) {
  const player = handValue(state.player);
  const dealer = handValue(state.dealer);
  const stake = Math.max(0, toInt(bet, 0));
  const playerBJ = isBlackjack(state.player);
  const dealerBJ = isBlackjack(state.dealer);

  let result;
  let multiplier;

  if (player.total > 21) {
    result = 'bust';
    multiplier = 0;
  } else if (playerBJ && dealerBJ) {
    result = 'push';
    multiplier = 1;
  } else if (playerBJ) {
    result = 'blackjack';
    multiplier = 2.5;
  } else if (dealerBJ) {
    result = 'dealer_blackjack';
    multiplier = 0;
  } else if (dealer.total > 21 || player.total > dealer.total) {
    result = 'win';
    multiplier = 2;
  } else if (player.total === dealer.total) {
    result = 'push';
    multiplier = 1;
  } else {
    result = 'lose';
    multiplier = 0;
  }

  return { result, multiplier, payout: Math.floor(stake * multiplier), player, dealer };
}

function formatCard(card) {
  return card ? `${card.r}${card.s}` : '';
}

function handLabel(cards = []) {
  return cards.map(formatCard).join(' ') || '—';
}

// ── Exécution d'un jeu instantané ───────────────────────────────────────────
function playGame({ game, bet, choice = null, number = null, rng = Math.random } = {}) {
  const stake = Math.max(1, toInt(bet, 1));

  if (game === 'machine') {
    const spin = spinSlots(rng);
    return {
      game,
      payout: Math.floor(stake * spin.multiplier),
      multiplier: spin.multiplier,
      reels: spin.reels,
      jackpot: spin.jackpot,
    };
  }

  if (game === 'roulette') {
    const type = ROULETTE_TYPES.some(entry => entry.value === choice) ? choice : 'rouge';
    const spin = spinRoulette(rng);
    const multiplier = rouletteMultiplier(type, number, spin);
    return {
      game,
      payout: Math.floor(stake * multiplier),
      multiplier,
      spin,
      color: rouletteColor(spin),
      type,
      number: type === 'numero' ? Number(number) : null,
    };
  }

  if (game === 'des') {
    const [d1, d2] = rollDice(rng);
    const total = d1 + d2;
    const picked = DICE_CHOICES.some(entry => entry.value === choice) ? choice : 'bas';
    const multiplier = diceMultiplier(picked, total);
    return { game, payout: Math.floor(stake * multiplier), multiplier, dice: [d1, d2], total, choice: picked };
  }

  if (game === 'piece') {
    const side = flipCoin(rng);
    const picked = COIN_CHOICES.some(entry => entry.value === choice) ? choice : 'pile';
    const multiplier = side === picked ? COIN_MULTIPLIER : 0;
    return { game, payout: Math.floor(stake * multiplier), multiplier, side, choice: picked };
  }

  throw new Error(`Jeu inconnu : ${game}`);
}

function contributionFor(bet, config) {
  const cfg = normalizeConfig(config);
  const stake = Math.max(0, toInt(bet, 0));
  if (!stake || cfg.jackpotPercent <= 0) return 0;
  return Math.max(1, Math.floor((stake * cfg.jackpotPercent) / 100));
}

module.exports = {
  GAMES,
  GAME_IDS,
  DEFAULT_CONFIG,
  MAX_BET,
  HISTORY_LENGTH,
  TITLES,
  fmt,
  dayKey,
  parseBet,
  levelFromXp,
  titleForLevel,
  xpForRound,
  normalizeConfig,
  normalizeProfile,
  applyRound,
  validateBet,
  SLOT_SYMBOLS,
  SLOT_JACKPOT_ODDS,
  spinSlots,
  ROULETTE_TYPES,
  RED_NUMBERS,
  spinRoulette,
  rouletteColor,
  rouletteMultiplier,
  DICE_CHOICES,
  rollDice,
  diceMultiplier,
  COIN_CHOICES,
  COIN_MULTIPLIER,
  flipCoin,
  SUITS,
  RANKS,
  buildDeck,
  cardValue,
  handValue,
  isBlackjack,
  drawCard,
  newBlackjack,
  dealerPlay,
  blackjackOutcome,
  formatCard,
  handLabel,
  playGame,
  contributionFor,
};
