// utils/treasureEngine.js — Moteur des Trésors cachés.
//
// Cycle de vie d'un coffre :
//   spawnHunt() → le coffre apparaît avec son premier indice, une durée de vie
//   et une récompense ; révéléClues() calcule les indices tombés AU FIL DU TEMPS
//   (aucune horloge en mémoire : un redémarrage du bot ne casse rien) ;
//   handleTreasureMessage() écoute les propositions dans le bon salon ;
//   winHunt() récompense le premier membre qui trouve le mot ; sinon le coffre
//   se referme à expiration.
//
// Les fonctions de décision (rollRarity, buildHuntSpec, scheduleNext,
// revealedClues…) sont pures : le tirage et le temps sont injectables, donc
// testables sans Discord ni base de données.
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { guildScope } = require('../core/sharding');
const { TreasureConfig, TreasureHunt, TreasureProfile } = require('../models/Treasure');
const Balance = require('../models/Balance');
const { COLORS } = require('./embeds');
const {
  RARITY_LABEL, RARITY_EMOJI, RARITY_COLOR, RARITY_REWARD, RARITY_ORDER,
  wordsFor, cluesForWord, isCorrectGuess, normalizeGuess,
} = require('./treasureWords');
const { renderTreasureCard } = require('./treasureCard');

// Salons avec un coffre ouvert : évite une requête à CHAQUE message du bot.
const activeChannels = new Set();
// Anti-spam des réponses « pas encore » (une par membre et par coffre, 20 s).
const { createBoundedCache } = require('./boundedCache');
// BORNÉ : une entrée par membre et par serveur.
const hintCooldown = createBoundedCache({ max: 20_000, ttl: 0, name: 'treasure-hint' });

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

function num(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

// ─── Décisions pures ─────────────────────────────────────────────────────────

/** Entier aléatoire inclusif (rng injectable pour les tests). */
function randomInt(min, max, rng = Math.random) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return 0;
  return lo + Math.floor(clamp(rng(), 0, 0.999999) * (hi - lo + 1));
}

/** Rareté tirée au sort selon les probabilités configurées (normalisées). */
function rollRarity(odds = null, rng = Math.random) {
  const source = odds && typeof odds.toObject === 'function' ? odds.toObject() : (odds || {});
  const entries = RARITY_ORDER.map(key => [key, Math.max(0, Number(source[key]) || 0)]);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return 'common';

  const roll = clamp(rng(), 0, 0.999999) * total;
  let acc = 0;
  for (const [key, weight] of entries) {
    acc += weight;
    if (roll < acc) return key;
  }
  return entries[entries.length - 1][0];
}

/** Récompense : base tirée dans l'intervalle, multipliée par la rareté. */
function rarityReward(min, max, rarity = 'common', multiplier = 1, rng = Math.random) {
  const base = randomInt(min, max, rng);
  const factor = (RARITY_REWARD[rarity] || 1) * (Number(multiplier) > 0 ? Number(multiplier) : 1);
  return Math.max(0, Math.round(base * factor));
}

/** Contenu d'un coffre : mot, indices et récompense. Fonction pure. */
function buildHuntSpec(cfg = {}, { rng = Math.random } = {}) {
  const words = wordsFor(cfg);
  const rarity = rollRarity(cfg.odds, rng);
  const sameRarity = words.filter(w => w.rarity === rarity);
  // Si la banque n'a aucun mot de cette rareté, on pioche ailleurs plutôt que
  // d'échouer : le coffre annoncé garde son nom de rareté.
  const pool = sameRarity.length ? sameRarity : words;
  const entry = pool[Math.floor(clamp(rng(), 0, 0.999999) * pool.length)] || pool[0] || { word: 'tresor', rarity: 'common', clues: [] };

  return {
    word: String(entry.word),
    rarity,
    clues: cluesForWord(entry, rarity),
    rewardXp: rarityReward(cfg.rewardXpMin ?? 150, cfg.rewardXpMax ?? 400, rarity, cfg.xpMultiplier ?? 1, rng),
    rewardCoins: rarityReward(cfg.rewardCoinsMin ?? 100, cfg.rewardCoinsMax ?? 300, rarity, cfg.coinsMultiplier ?? 1, rng),
  };
}

/** Prochaine apparition : entre minDelayMinutes et maxDelayMinutes. */
function scheduleNext(cfg = {}, { rng = Math.random, now = Date.now() } = {}) {
  const min = Math.max(1, Math.round(Number(cfg.minDelayMinutes) || 60));
  const max = Math.max(min, Math.round(Number(cfg.maxDelayMinutes) || min));
  return new Date(Number(now) + randomInt(min, max, rng) * 60000);
}

/** Nombre d'indices visibles à l'instant `now`. */
function revealedClues(hunt = {}, cfg = {}, now = Date.now()) {
  const total = Math.max(1, (hunt.clues || []).length);
  const interval = Math.max(0, Number(cfg.clueIntervalSeconds) || 0);
  if (!interval) return total;
  const started = new Date(hunt.startedAt || now).getTime();
  const elapsed = Math.max(0, (Number(now) - started) / 1000);
  return clamp(1 + Math.floor(elapsed / interval), 1, total);
}

/** Secondes restantes avant fermeture du coffre. */
function secondsLeft(hunt = {}, now = Date.now()) {
  return Math.max(0, Math.round((new Date(hunt.expiresAt || now).getTime() - Number(now)) / 1000));
}

function humanDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

// ─── Accès base ──────────────────────────────────────────────────────────────
async function getOrCreateConfig(guildId) {
  let cfg = await TreasureConfig.findOne({ guildId });
  if (!cfg) cfg = await TreasureConfig.create({ guildId, nextSpawnAt: scheduleNext({}) });
  return cfg;
}

const hasActiveHuntIn = channelId => activeChannels.has(channelId);

// ─── Affichage ───────────────────────────────────────────────────────────────
/**
 * Message du coffre : embed + (option) carte canvas.
 * @param {'closed'|'opened'|'expired'} state
 */
async function buildHuntPayload(hunt, cfg, guild, { state = 'closed', winner = null, now = Date.now(), extraClues = [] } = {}) {
  const clues = state === 'closed' ? (hunt.clues || []).slice(0, revealedClues(hunt, cfg, now)) : (hunt.clues || []);
  const rarity = hunt.rarity || 'common';

  const lines = [];
  if (state === 'closed') {
    lines.push(`Un coffre **${RARITY_LABEL[rarity].toLowerCase()}** est apparu dans ce salon !`);
    lines.push('');
    for (const [i, clue] of clues.entries()) lines.push(`> **Indice ${i + 1}** — ${clue}`);
    for (const clue of extraClues) lines.push(`> **Indice ${clues.length + extraClues.indexOf(clue) + 1}** — ${clue}`);
    lines.push('');
    lines.push(`Le premier qui **tape le mot exact** ouvre le coffre. Il se refermera dans **${humanDuration(secondsLeft(hunt, now))}**.`);
    lines.push(`Contenu : **${num(hunt.rewardCoins)} pièces** et **${num(hunt.rewardXp)} XP**.`);
  } else if (state === 'opened') {
    lines.push(`🏆 <@${hunt.openedBy}> a ouvert le coffre **${RARITY_LABEL[rarity].toLowerCase()}** !`);
    lines.push('');
    lines.push(`Le mot était **${hunt.word}**.`);
    lines.push(`Gains : **${num(hunt.rewardCoins)} pièces** et **${num(hunt.rewardXp)} XP**.`);
  } else {
    lines.push(`⌛ Le coffre **${RARITY_LABEL[rarity].toLowerCase()}** s'est refermé : personne ne l'a ouvert à temps.`);
    lines.push('');
    lines.push(`Le mot était **${hunt.word}**.`);
  }

  const embed = new EmbedBuilder()
    .setColor(RARITY_COLOR[rarity] || COLORS.primary)
    .setTitle(`${RARITY_EMOJI[rarity]} Coffre ${RARITY_LABEL[rarity].toLowerCase()}${state === 'opened' ? ' — ouvert' : state === 'expired' ? ' — refermé' : ''}`)
    .setDescription(lines.join('\n').slice(0, 3800))
    .setFooter({ text: `REZO • Trésors cachés · ${guild?.name || 'serveur'}`.slice(0, 200) });

  const payload = { embeds: [embed], files: [] };

  if (cfg?.useCard !== false) {
    try {
      const buffer = await renderTreasureCard({
        rarity,
        word: hunt.word,
        clues: state === 'closed' ? [...clues, ...extraClues] : (hunt.clues || []),
        state,
        winner: winner ? (winner.displayName || winner.user?.username) : null,
        rewardXp: hunt.rewardXp,
        rewardCoins: hunt.rewardCoins,
        secondsLeft: secondsLeft(hunt, now),
        lifetimeSeconds: Number(cfg?.lifetimeSeconds) || 600,
        guildName: guild?.name || null,
      });
      embed.setImage('attachment://coffre.png');
      payload.files = [new AttachmentBuilder(buffer, { name: 'coffre.png' })];
    } catch (err) {
      console.error('❌ Carte du coffre:', err.message);
    }
  }

  if (!payload.files.length) delete payload.files;
  return payload;
}

// ─── Cycle de vie ────────────────────────────────────────────────────────────
/** Salon tiré au sort parmi ceux configurés et encore valides. */
function pickChannel(cfg, guild, rng = Math.random) {
  const candidates = (cfg.channels || []).filter(id => {
    const ch = guild?.channels?.cache?.get(id);
    return !!ch && (typeof ch.isTextBased !== 'function' || ch.isTextBased());
  });
  if (!candidates.length) return null;
  return candidates[Math.floor(clamp(rng(), 0, 0.999999) * candidates.length)];
}

/** Fait apparaître un coffre maintenant. */
async function spawnHunt({ guild, cfg, rng = Math.random, now = Date.now() } = {}) {
  if (!guild || !cfg) return null;

  const channelId = pickChannel(cfg, guild, rng);
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);

  const spec = buildHuntSpec(cfg, { rng });
  const hunt = await TreasureHunt.create({
    guildId: guild.id,
    channelId,
    word: spec.word,
    clues: spec.clues,
    rarity: spec.rarity,
    rewardXp: spec.rewardXp,
    rewardCoins: spec.rewardCoins,
    startedAt: new Date(now),
    expiresAt: new Date(Number(now) + Math.max(30, Number(cfg.lifetimeSeconds) || 600) * 1000),
    clueNotifiedAt: 1,
  }).catch(() => null);
  if (!hunt) return null;

  activeChannels.add(channelId);

  const payload = await buildHuntPayload(hunt, cfg, guild, { now });
  const message = await channel.send(payload).catch(() => null);

  if (!message) {
    // Sans message, il n'y a pas de chasse possible : on efface le coffre pour
    // ne pas bloquer les prochaines apparitions sur un salon inaccessible.
    activeChannels.delete(channelId);
    await TreasureHunt.deleteOne({ _id: hunt._id }).catch(() => {});
    return null;
  }

  hunt.messageId = message.id;
  await hunt.save().catch(() => {});

  cfg.stats.hunts = (cfg.stats.hunts || 0) + 1;
  cfg.stats.lastHuntAt = new Date(now);
  cfg.nextSpawnAt = scheduleNext(cfg, { rng, now });
  await cfg.save().catch(() => {});

  return { hunt, message, spec };
}

/**
 * Ferme le coffre (ouverture par un membre, expiration ou module désactivé).
 * @param {'opened'|'expired'|'cancelled'} reason
 */
async function closeHunt(client, cfg, hunt, reason = 'expired', { winner = null, guild = null, now = Date.now() } = {}) {
  if (!hunt) return null;

  activeChannels.delete(hunt.channelId);

  const resolvedGuild = guild || client?.guilds?.cache?.get(hunt.guildId) || null;
  const channel = resolvedGuild?.channels?.cache?.get(hunt.channelId)
    || (await client?.channels?.fetch?.(hunt.channelId).catch(() => null));

  if (channel && hunt.messageId && reason !== 'cancelled') {
    const state = reason === 'opened' ? 'opened' : 'expired';
    const payload = await buildHuntPayload(hunt, cfg, resolvedGuild, { state, winner, now }).catch(() => null);
    if (payload) {
      const message = await channel.messages?.fetch?.(hunt.messageId).catch(() => null);
      await message?.edit(payload).catch(() => {});
    }
  }

  // Annonce dans le salon dédié s'il diffère du salon du coffre
  if (reason === 'opened' && resolvedGuild && cfg?.announceChannelId && cfg.announceChannelId !== hunt.channelId) {
    const announce = resolvedGuild.channels.cache.get(cfg.announceChannelId);
    await announce?.send({
      content: `🎉 <@${hunt.openedBy}> a ouvert un coffre **${RARITY_LABEL[hunt.rarity] || ''}** (mot : **${hunt.word}**) et remporte ${num(hunt.rewardCoins)} pièces + ${num(hunt.rewardXp)} XP !`,
    }).catch(() => {});
  }

  if (cfg) {
    if (reason === 'opened') cfg.stats.opened = (cfg.stats.opened || 0) + 1;
    else if (reason === 'expired') cfg.stats.expired = (cfg.stats.expired || 0) + 1;
    cfg.nextSpawnAt = scheduleNext(cfg, { now });
    await cfg.save().catch(() => {});
  }

  await TreasureHunt.deleteOne({ _id: hunt._id }).catch(() => {});
  return hunt;
}

/** Distribue la récompense : XP, pièces, rôle légendaire et fiche du chasseur. */
async function rewardWinner(guild, member, cfg, hunt) {
  const result = { xp: 0, coins: 0, roleId: null, profile: null };
  const userId = member?.id || member?.user?.id;

  // XP — même formule que le système de niveaux, pour rester cohérent.
  try {
    const xp = require('../commands/xp/xp');
    const doc = await xp.getOrCreateXp(guild.id, userId);
    doc.totalXp += hunt.rewardXp;
    doc.xp = doc.totalXp;
    doc.level = xp.computeLevel(doc.totalXp).level;
    await doc.save();
    result.xp = hunt.rewardXp;
  } catch (err) {
    console.error('❌ Trésor (XP):', err.message);
  }

  // Pièces
  try {
    await Balance.findOneAndUpdate(
      { userId, guildId: guild.id },
      { $inc: { coins: hunt.rewardCoins } },
      { upsert: true },
    );
    result.coins = hunt.rewardCoins;
  } catch (err) {
    console.error('❌ Trésor (pièces):', err.message);
  }

  // Rôle bonus des coffres légendaires
  if (hunt.rarity === 'legendary' && cfg?.legendaryRoleId && member?.roles?.add) {
    const ok = await member.roles.add(cfg.legendaryRoleId).then(() => true).catch(() => false);
    if (ok) result.roleId = cfg.legendaryRoleId;
  }

  // Fiche du chasseur (victoires, série, gains cumulés).
  // La série dépend de la valeur précédente : on la lit puis on écrit en une
  // seule mise à jour (avec upsert), ce qui crée la fiche à la première victoire.
  try {
    const previous = await TreasureProfile.findOne({ guildId: guild.id, userId }).catch(() => null);
    const streak = (previous?.streak || 0) + 1;
    const bestStreak = Math.max(previous?.bestStreak || 0, streak);
    const winKey = hunt.rarity === 'rare' ? 'rareWins'
      : hunt.rarity === 'legendary' ? 'legendaryWins' : 'commonWins';

    result.profile = await TreasureProfile.findOneAndUpdate(
      { guildId: guild.id, userId },
      {
        $inc: { wins: 1, [winKey]: 1, xpEarned: result.xp, coinsEarned: result.coins },
        $set: { streak, bestStreak, lastWinAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    console.error('❌ Trésor (profil):', err.message);
  }

  return result;
}

/** Ouvre le coffre au profit d'un membre. */
async function winHunt(client, cfg, hunt, member, channel) {
  hunt.openedBy = member?.id || member?.user?.id || null;
  hunt.openedAt = new Date();
  // Les autres chasseurs repartent de zéro : la série se mesure sur les coffres
  // consécutifs, pas sur le temps.
  hunt.clueNotifiedAt = (hunt.clues || []).length;

  const guild = channel?.guild || client?.guilds?.cache?.get(hunt.guildId);
  const rewards = await rewardWinner(guild, member, cfg, hunt);

  await closeHunt(client, cfg, hunt, 'opened', { winner: member, guild });

  return rewards;
}

/**
 * Traite un message : est-ce une tentative sur le coffre du salon ?
 * @returns {Promise<null|{won:boolean}>}
 */
async function handleTreasureMessage(message, client) {
  if (!message?.guild || message.author?.bot) return null;
  if (!activeChannels.has(message.channel?.id)) return null;
  if (!String(message.content || '').trim()) return null;

  try {
    let cfg = null;
    try { cfg = await TreasureConfig.findOne({ guildId: message.guild.id }); } catch { cfg = null; }
    if (!cfg || !cfg.enabled) return null;

    let hunt = null;
    try { hunt = await TreasureHunt.findOne({ guildId: message.guild.id }); } catch { hunt = null; }
    if (!hunt || hunt.channelId !== message.channel.id) return null;

    if (secondsLeft(hunt) <= 0) {
      await closeHunt(client, cfg, hunt, 'expired', { guild: message.guild });
      return null;
    }

    hunt.attempts = (hunt.attempts || 0) + 1;

    if (!isCorrectGuess(hunt.word, message.content)) {
      if (cfg.hintOnWrongGuess) await sendWrongGuessHint(message, hunt, cfg).catch(() => {});
      await hunt.save().catch(() => {});
      return { won: false };
    }

    // Deux bonnes réponses au même instant : la revendication est ATOMIQUE, un
    // seul membre peut ouvrir le coffre.
    const claimed = await TreasureHunt.findOneAndUpdate(
      { guildId: message.guild.id, openedBy: null },
      { $set: { openedBy: message.author.id, openedAt: new Date() } },
      { new: true },
    ).catch(() => null);
    if (!claimed) return null;

    const member = message.member || await message.guild.members?.fetch?.(message.author.id).catch(() => null);
    const rewards = await winHunt(client, cfg, claimed, member || message.author, message.channel);
    return { won: true, rewards };
  } catch (err) {
    console.error('❌ Trésor (devinette):', err.message);
    return null;
  }
}

/** Réponse discrète à une mauvaise proposition (une par membre toutes les 20 s). */
async function sendWrongGuessHint(message, hunt, cfg) {
  const key = `${hunt._id}:${message.author.id}`;
  const last = hintCooldown.get(key) || 0;
  if (Date.now() - last < 20000) return;
  hintCooldown.set(key, Date.now());

  const nextAt = Number(cfg.clueIntervalSeconds) > 0
    ? revealedClues(hunt, cfg) * Number(cfg.clueIntervalSeconds) - (Date.now() - new Date(hunt.startedAt).getTime()) / 1000
    : 0;
  const letters = normalizeGuess(hunt.word).replace(/ /g, '').length;
  const pending = `Prochain indice dans ${humanDuration(Math.max(0, nextAt))}.`;

  const reply = await message.reply({
    content: `❌ Pas encore… le mot compte **${letters} lettres**. ${pending}`,
  }).catch(() => null);
  if (reply) setTimeout(() => reply.delete().catch(() => {}), 15000).unref?.();
}

/**
 * Battement de cœur (cron toutes les minutes) : apparitions dues, indices
 * supplémentaires, coffres expirés.
 */
async function tickTreasures(client, { now = Date.now(), rng = Math.random } = {}) {
  const summary = { spawned: 0, expired: 0, clues: 0 };

  // 1. Coffres en cours : on les remet en cache, on révèle les indices dus.
  //    Chaque shard ne traite que les coffres de SES serveurs (sinon deux
  //    processus refermeraient le même coffre et s'échangeraient les messages).
  let hunts = [];
  try { hunts = await TreasureHunt.find(guildScope(client, {})); } catch { hunts = []; }

  for (const hunt of hunts) {
    let cfg = null;
    try { cfg = await TreasureConfig.findOne({ guildId: hunt.guildId }); } catch { cfg = null; }

    if (!cfg || !cfg.enabled) {
      await closeHunt(client, cfg, hunt, 'cancelled', { now });
      continue;
    }

    activeChannels.add(hunt.channelId);

    if (secondsLeft(hunt, now) <= 0) {
      await closeHunt(client, cfg, hunt, 'expired', { now });
      summary.expired += 1;
      continue;
    }

    const revealed = revealedClues(hunt, cfg, now);
    if (revealed > (hunt.clueNotifiedAt || 1)) {
      const guild = client?.guilds?.cache?.get(hunt.guildId) || null;
      const payload = await buildHuntPayload(hunt, cfg, guild, { now }).catch(() => null);
      if (payload && guild) {
        const channel = guild.channels.cache.get(hunt.channelId);
        const message = channel && hunt.messageId
          ? await channel.messages?.fetch?.(hunt.messageId).catch(() => null)
          : null;
        await message?.edit(payload).catch(() => {});
      }
      hunt.clueNotifiedAt = revealed;
      await hunt.save().catch(() => {});
      summary.clues += 1;
    }
  }

  // 2. Apparitions dues (même portée : les serveurs de ce shard).
  let cfgs = [];
  try { cfgs = await TreasureConfig.find(guildScope(client, { enabled: true })); } catch { cfgs = []; }

  for (const cfg of cfgs) {
    if (!cfg.channels?.length) continue;
    if (cfg.nextSpawnAt && new Date(cfg.nextSpawnAt).getTime() > now) continue;

    let existing = null;
    try { existing = await TreasureHunt.findOne({ guildId: cfg.guildId }); } catch { existing = null; }

    if (existing) {
      // Un coffre traîne (bot redémarré pendant une chasse) : on reprend le
      // calendrier au lieu d'en lancer un second.
      activeChannels.add(existing.channelId);
      if (!cfg.nextSpawnAt) {
        cfg.nextSpawnAt = scheduleNext(cfg, { rng, now });
        await cfg.save().catch(() => {});
      }
      continue;
    }

    const guild = client?.guilds?.cache?.get(cfg.guildId);
    if (!guild) continue;

    const spawned = await spawnHunt({ guild, cfg, rng, now }).catch(err => {
      console.error('❌ Trésor (apparition):', err.message);
      return null;
    });
    if (spawned) summary.spawned += 1;
  }

  return summary;
}

// ─── Consultation ────────────────────────────────────────────────────────────
async function topHunters(guildId, limit = 10) {
  try {
    return await TreasureProfile.find({ guildId, wins: { $gt: 0 } })
      .sort({ wins: -1, bestStreak: -1 })
      .limit(Math.max(1, Math.min(25, limit)));
  } catch {
    return [];
  }
}

function leaderboardEmbed(profiles, guildName = 'ce serveur') {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = profiles.length
    ? profiles.map((p, i) => {
      const medal = medals[i] || `**${i + 1}.**`;
      const detail = [p.wins > 0 ? `${p.wins} coffre(s)` : null,
        p.rareWins ? `${p.rareWins} rare(s)` : null,
        p.legendaryWins ? `${p.legendaryWins} légendaire(s)` : null,
        p.bestStreak > 1 ? `série ${p.bestStreak}` : null].filter(Boolean).join(' · ');
      return `${medal} <@${p.userId}> — ${detail}`;
    })
    : ['*Personne n\'a encore ouvert de coffre. Le premier trésor est peut-être pour vous.*'];

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🏆 Chasseurs de trésors')
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: `REZO • Trésors cachés · ${guildName}`.slice(0, 200) });
}

async function publishLeaderboard(channel, guildId, guildName) {
  const profiles = await topHunters(guildId, 10);
  return channel.send({ embeds: [leaderboardEmbed(profiles, guildName)] }).catch(() => null);
}

async function resetHunter(guildId, userId) {
  return TreasureProfile.deleteOne({ guildId, userId }).catch(() => null);
}

async function activeHuntOf(guildId) {
  return TreasureHunt.findOne({ guildId }).catch(() => null);
}

module.exports = {
  // pures
  randomInt, rollRarity, rarityReward, buildHuntSpec, scheduleNext,
  revealedClues, secondsLeft, humanDuration, pickChannel, leaderboardEmbed,
  // moteur
  getOrCreateConfig, spawnHunt, closeHunt, winHunt, rewardWinner, handleTreasureMessage,
  tickTreasures, buildHuntPayload, sendWrongGuessHint,
  // consultation
  topHunters, publishLeaderboard, resetHunter, activeHuntOf, hasActiveHuntIn,
  // état interne (tests)
  _activeChannels: activeChannels,
};
