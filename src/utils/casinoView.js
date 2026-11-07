'use strict';
// utils/casinoView.js — Tout le rendu du casino : embeds et composants.
//
// Aucune décision de jeu ici : les vues reçoivent un résultat déjà calculé et
// le dessinent. Cela garde les gains testables (casinoEngine) et évite qu'une
// retouche visuelle ne change une probabilité.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
} = require('discord.js');
const engine = require('./casinoEngine');
const { COLORS } = require('./embeds');
const serverIdentity = require('./serverIdentity');

const fmt = engine.fmt;

const IDS = {
  hubMachine: 'cas_hub_machine',
  hubRoulette: 'cas_hub_roulette',
  hubBlackjack: 'cas_hub_blackjack',
  hubDes: 'cas_hub_des',
  hubPiece: 'cas_hub_piece',
  hubProfile: 'cas_hub_profile',
  hubRank: 'cas_hub_rank',
  hubJackpot: 'cas_hub_jackpot',
  hubHistory: 'cas_hub_history',
  hubLimits: 'cas_hub_limits',
  hubConfig: 'cas_hub_config',
  hubRefresh: 'cas_hub_refresh',

  profileRefresh: 'cas_prof_refresh_',
  profileRank: 'cas_prof_rank',
  profileLimits: 'cas_prof_limits',
  profileClose: 'cas_prof_close',

  rankProfit: 'cas_rank_profit',
  rankWagered: 'cas_rank_wagered',
  rankWins: 'cas_rank_wins',
  rankClose: 'cas_rank_close',

  limits1h: 'cas_limit_1h',
  limits24h: 'cas_limit_24h',
  limits7d: 'cas_limit_7d',
  limits30d: 'cas_limit_30d',
  limitsOff: 'cas_limit_off',
  limitsCustom: 'cas_limits_custom',

  configToggle: 'cas_cfg_toggle',
  configBets: 'cas_cfg_bets',
  configCooldown: 'cas_cfg_cooldown',
  configJackpot: 'cas_cfg_jackpot',
  configAnnounce: 'cas_cfg_announce',
  configRefresh: 'cas_cfg_refresh',
  configClose: 'cas_cfg_close',
  configChannels: 'cas_sel_channels',
  configGames: 'cas_sel_games',
};

const MODALS = {
  bet: 'cas_modal_bet_',
  bets: 'cas_modal_bets',
  cooldown: 'cas_modal_cooldown',
  jackpot: 'cas_modal_jackpot',
  announce: 'cas_modal_announce',
  limits: 'cas_modal_limits',
};

const BJ = {
  hit: 'cas_bj_hit_',
  stand: 'cas_bj_stand_',
  double: 'cas_bj_double_',
};

const OUTCOME_LABEL = {
  blackjack: '🃏 Blackjack — payé ×2,5',
  win: '✅ Main gagnante',
  lose: '❌ Main perdante',
  bust: '💥 Bust — tu dépasses 21',
  push: '🤝 Égalité — mise rendue',
  dealer_blackjack: '❌ Blackjack du croupier',
};

function signed(value) {
  const n = Math.trunc(Number(value) || 0);
  if (n > 0) return `+${fmt(n)}`;
  if (n < 0) return `-${fmt(Math.abs(n))}`;
  return '0';
}

function colorForProfit(value) {
  const n = Number(value) || 0;
  if (n > 0) return COLORS.success;
  if (n < 0) return COLORS.error;
  return COLORS.primary;
}

function gameButton(id, game, { disabled = false } = {}) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(engine.GAMES[game].label)
    .setEmoji(engine.GAMES[game].emoji)
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);
}

function closeButton(id, label = 'Fermer') {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji('✖').setStyle(ButtonStyle.Secondary);
}

// ── Accueil ─────────────────────────────────────────────────────────────────
function hubPayload({ config, profile, balance, user, admin = false } = {}) {
  const cfg = engine.normalizeConfig(config);
  const prof = engine.normalizeProfile(profile, { userId: user?.id });

  const gameLines = engine.GAME_IDS.map(id => {
    const game = engine.GAMES[id];
    const state = cfg.games[id] ? '✅' : '⛔';
    return `${state} ${game.emoji} **/${game.label}** — ${game.hint}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle(`🎰 Casino ${serverIdentity.currentIdentity().name}`)
    .setDescription([
      `Bienvenue <@${user?.id}> — installe-toi, la maison ne mord pas (beaucoup).`,
      '',
      `💳 **Solde** : ${fmt(balance)} 🪙`,
      `🎖️ **Niveau ${prof.level}** · ${prof.title} · ${prof.profit >= 0 ? '📈' : '📉'} **${signed(prof.profit)}** 🪙 net`,
      `💰 **Cagnotte du serveur** : **${fmt(cfg.jackpot)}** 🪙`,
    ].join('\n'))
    .addFields(
      {
        name: '📏 Règles de la maison',
        value: `Mise **${fmt(cfg.minBet)} – ${fmt(cfg.maxBet)}** 🪙 · Cooldown **${cfg.cooldownSec}s**`,
        inline: true,
      },
      {
        name: '🎲 Jeux',
        value: `${engine.GAME_IDS.filter(id => cfg.games[id]).length}/${engine.GAME_IDS.length} actifs`,
        inline: true,
      },
      {
        name: '📣 Gros gains',
        value: cfg.announceWins && cfg.announceThreshold > 0 ? `annoncés dès **${fmt(cfg.announceThreshold)}** 🪙` : 'annonces coupées',
        inline: true,
      },
      { name: '🎰 Catalogue', value: gameLines.join('\n').slice(0, 1024), inline: false },
    )
    .setFooter({ text: serverIdentity.signatureFor('Casino — joue responsable (18+) · /casino limites') })
    .setTimestamp();

  if (user?.displayAvatarURL) {
    const avatar = user.displayAvatarURL({ dynamic: true, size: 128 });
    if (avatar) embed.setThumbnail(avatar);
  }

  const rows = [
    new ActionRowBuilder().addComponents(
      gameButton(IDS.hubMachine, 'machine', { disabled: !cfg.games.machine }),
      gameButton(IDS.hubRoulette, 'roulette', { disabled: !cfg.games.roulette }),
      gameButton(IDS.hubBlackjack, 'blackjack', { disabled: !cfg.games.blackjack }),
      gameButton(IDS.hubDes, 'des', { disabled: !cfg.games.des }),
      gameButton(IDS.hubPiece, 'piece', { disabled: !cfg.games.piece }),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.hubProfile).setLabel('Profil').setEmoji('👤').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.hubRank).setLabel('Classement').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.hubJackpot).setLabel('Jackpot').setEmoji('💰').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.hubHistory).setLabel('Historique').setEmoji('🧾').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.hubLimits).setLabel('Limites').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
    ),
  ];

  if (admin) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.hubConfig).setLabel('Configuration').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(IDS.hubRefresh).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.hubRefresh).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ));
  }

  return { embeds: [embed], components: rows };
}

// ── Résultats des jeux instantanés ──────────────────────────────────────────
function resultPayload(result, user) {
  const game = engine.GAMES[result.game] || { label: 'Casino', emoji: '🎰' };
  const won = result.net > 0;
  const push = result.net === 0;

  const embed = new EmbedBuilder()
    .setColor(result.jackpotAmount > 0 ? COLORS.accent : won ? COLORS.success : push ? COLORS.info : COLORS.error)
    .setAuthor({ name: `${user?.username || 'Joueur'} · ${game.label}`, iconURL: user?.displayAvatarURL?.({ dynamic: true, size: 64 }) || undefined })
    .setTitle(result.jackpotAmount > 0 ? '💎 JACKPOT !' : `${game.emoji} ${game.label}`)
    .addFields(
      { name: '💸 Mise', value: `**${fmt(result.bet)}** 🪙`, inline: true },
      { name: won ? '📈 Gain' : push ? '↩️ Rendu' : '📉 Perte', value: `**${fmt(result.payout)}** 🪙`, inline: true },
      { name: '💳 Solde', value: `**${fmt(result.balance)}** 🪙`, inline: true },
    )
    .setFooter({ text: `Niveau ${result.profile?.level || 1} · ${result.profile?.title || 'Curieux'} · ${serverIdentity.currentIdentity().name} Casino` })
    .setTimestamp();

  const lines = [];

  if (result.game === 'machine') {
    lines.push(`# ${result.outcome.reels.join('  ')}`);
    if (result.jackpotAmount > 0) lines.push(`\n💎 **Cagnotte décrochée : +${fmt(result.jackpotAmount)}** 🪙`);
    else if (result.outcome.multiplier >= 4) lines.push('\n🔥 Trois symboles identiques !');
    else if (result.outcome.multiplier > 0) lines.push('\n✨ Deux symboles identiques.');
    else lines.push('\n😐 Rien qui s’aligne…');
  }

  if (result.game === 'roulette') {
    const colorEmoji = result.outcome.color === 'rouge' ? '🔴' : result.outcome.color === 'noir' ? '⚫' : '🟢';
    lines.push(`# ${colorEmoji} ${result.outcome.spin} — ${result.outcome.color}`);
    const label = engine.ROULETTE_TYPES.find(entry => entry.value === result.outcome.type)?.label || result.outcome.type;
    lines.push(`\nTon pari : **${label}**${result.outcome.type === 'numero' ? ` → **${result.outcome.number}**` : ''}`);
  }

  if (result.game === 'des') {
    const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    lines.push(`# ${faces[result.outcome.dice[0] - 1]}  +  ${faces[result.outcome.dice[1] - 1]}  =  **${result.outcome.total}**`);
    const labels = { bas: 'Bas (2-6)', sept: 'Sept pile (7)', haut: 'Haut (8-12)' };
    lines.push(`\nTon pari : **${labels[result.outcome.choice] || result.outcome.choice}**`);
  }

  if (result.game === 'piece') {
    lines.push(`# 🪙 ${result.outcome.side.toUpperCase()}`);
    lines.push(`\nTon pari : **${result.outcome.choice}**`);
  }

  lines.push('', `${won ? '🎉' : push ? '🤝' : '💤'} **${signed(result.net)}** 🪙 sur cette partie`);
  if (result.jackpot != null) lines.push(`💰 Cagnotte maintenant : **${fmt(result.jackpot)}** 🪙`);

  embed.setDescription(lines.join('\n').slice(0, 4096));

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${MODALS.bet}${result.game}`)
        .setLabel('Rejouer')
        .setEmoji('🔁')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(IDS.hubProfile).setLabel('Profil').setEmoji('👤').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.hubRank).setLabel('Classement').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
    ),
  ];

  return { embeds: [embed], components: rows };
}

// ── Blackjack ───────────────────────────────────────────────────────────────
function blackjackPayload(round, user) {
  const state = round.state || { player: [], dealer: [] };
  const player = engine.handValue(state.player);
  const dealerVisible = round.status === 'active' ? [state.dealer?.[0]].filter(Boolean) : (state.dealer || []);
  const dealer = engine.handValue(dealerVisible);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: `${user?.username || 'Joueur'} · Blackjack`, iconURL: user?.displayAvatarURL?.({ dynamic: true, size: 64 }) || undefined })
    .setTitle('🃏 Blackjack')
    .setDescription([
      `💸 Mise engagée : **${fmt(round.bet)}** 🪙${state.doubled ? ' · **doublée**' : ''}`,
      '',
      `**Croupier** — ${dealer.total}${round.status === 'active' ? ' + une carte cachée' : ''}`,
      `\`${engine.handLabel(dealerVisible)}${round.status === 'active' ? '  🂠' : ''}\``,
      '',
      `**Toi** — ${player.total}${player.soft ? ' (souple)' : ''}`,
      `\`${engine.handLabel(state.player)}\``,
      '',
      round.status === 'active' ? 'Tire une carte, reste, ou double si tu as deux cartes.' : OUTCOME_LABEL[round.outcome] || 'Partie terminée.',
    ].join('\n'))
    .setFooter({ text: serverIdentity.signatureFor('Casino — le croupier tire jusqu’à 17') })
    .setTimestamp();

  const active = round.status === 'active';
  const id = String(round._id || round.id || '');
  const doubleDisabled = !active || (state.player || []).length !== 2;

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${BJ.hit}${id}`).setLabel('Tirer').setEmoji('🃏').setStyle(ButtonStyle.Primary).setDisabled(!active),
        new ButtonBuilder().setCustomId(`${BJ.stand}${id}`).setLabel('Rester').setEmoji('✋').setStyle(ButtonStyle.Success).setDisabled(!active),
        new ButtonBuilder().setCustomId(`${BJ.double}${id}`).setLabel('Doubler').setEmoji('💥').setStyle(ButtonStyle.Danger).setDisabled(doubleDisabled),
      ),
    ],
  };
}

function blackjackSettledPayload(settlement) {
  const { round, outcome, profile, payout, net, balance } = settlement;
  const state = round.state || {};
  const positive = net > 0;
  const push = net === 0;

  const embed = new EmbedBuilder()
    .setColor(positive ? COLORS.success : push ? COLORS.info : COLORS.error)
    .setTitle(`🃏 ${OUTCOME_LABEL[outcome.result] || outcome.result}`)
    .setDescription([
      `**Croupier** — ${outcome.dealer.total}`,
      `\`${engine.handLabel(state.dealer)}\``,
      '',
      `**Toi** — ${outcome.player.total}`,
      `\`${engine.handLabel(state.player)}\``,
      '',
      `${positive ? '🎉' : push ? '🤝' : '💤'} **${signed(net)}** 🪙 · mise **${fmt(round.bet)}** · rendu **${fmt(payout)}**`,
    ].join('\n'))
    .addFields(
      { name: '💳 Solde', value: `**${fmt(balance)}** 🪙`, inline: true },
      { name: '🎖️ Niveau', value: `**${profile?.level || 1}** · ${profile?.title || 'Curieux'}`, inline: true },
    )
    .setFooter({ text: serverIdentity.signatureFor('Casino') })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.hubBlackjack).setLabel('Nouvelle table').setEmoji('🃏').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(IDS.hubProfile).setLabel('Profil').setEmoji('👤').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ── Profil ──────────────────────────────────────────────────────────────────
function profilePayload(profile, user) {
  const prof = engine.normalizeProfile(profile, { userId: user?.id });
  const played = prof.gamesPlayed;
  const winRate = played ? Math.round((prof.wins / played) * 100) : 0;
  const netColor = colorForProfit(prof.profit);

  const embed = new EmbedBuilder()
    .setColor(netColor)
    .setAuthor({ name: `${user?.username || 'Joueur'} · Profil casino`, iconURL: user?.displayAvatarURL?.({ dynamic: true, size: 256 }) || undefined })
    .setTitle(`👤 ${user?.username || 'Joueur'} — Niveau ${prof.level}`)
    .setDescription([
      `🎖️ **${prof.title}**`,
      `📊 Bénéfice net : **${signed(prof.profit)}** 🪙`,
      `⭐ XP : **${fmt(prof.xp)}** · ${prof.streak > 0 ? `🔥 série de **${prof.streak}** victoire(s)` : 'série en cours : —'}`,
    ].join('\n'))
    .addFields(
      { name: '🎲 Parties', value: `**${fmt(played)}**`, inline: true },
      { name: '✅ Gagnées', value: `**${fmt(prof.wins)}** (${winRate}%)`, inline: true },
      { name: '❌ Perdues', value: `**${fmt(prof.losses)}**`, inline: true },
      { name: '💸 Total misé', value: `**${fmt(prof.wagered)}** 🪙`, inline: true },
      { name: '🏦 Total rendu', value: `**${fmt(prof.payout)}** 🪙`, inline: true },
      { name: '🏅 Record', value: `**${signed(prof.biggestWin)}** 🪙`, inline: true },
      { name: '🔥 Meilleure série', value: `**${fmt(prof.bestStreak)}**`, inline: true },
      { name: '💎 Jackpots', value: `**${fmt(prof.jackpotsWon)}**`, inline: true },
      { name: '🎮 Jeu favori', value: prof.lastGame ? `${engine.GAMES[prof.lastGame]?.emoji || '🎲'} ${engine.GAMES[prof.lastGame]?.label || prof.lastGame}` : '—', inline: true },
    )
    .setFooter({ text: serverIdentity.signatureFor('Casino — profil du serveur') })
    .setTimestamp();

  if (prof.history.length) {
    const lines = [...prof.history].reverse().slice(0, 5).map(entry => {
      const game = engine.GAMES[entry.game] || { emoji: '🎲', label: entry.game || 'Partie' };
      const when = entry.at ? `<t:${Math.floor(entry.at / 1000)}:R>` : '';
      return `${game.emoji} **${signed(entry.net)}** 🪙 · mise ${fmt(entry.bet)} ${when}`;
    });
    embed.addFields({ name: '🧾 Dernières parties', value: lines.join('\n'), inline: false });
  }

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${IDS.profileRefresh}${prof.userId || user?.id}`).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.profileRank).setLabel('Classement').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.profileLimits).setLabel('Mes limites').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
        closeButton(IDS.profileClose),
      ),
    ],
  };
}

// ── Classement ──────────────────────────────────────────────────────────────
function leaderboardPayload(rows = [], sort = 'profit') {
  const medals = ['🥇', '🥈', '🥉'];
  const labels = { profit: 'bénéfice net', wagered: 'total misé', wins: 'victoires' };
  const valueFor = row => sort === 'wagered' ? row.wagered : sort === 'wins' ? row.wins : row.profit;

  const lines = rows.length
    ? rows.map((row, index) => {
      const prefix = medals[index] || `**${index + 1}.**`;
      const value = sort === 'wins' ? `**${fmt(valueFor(row))}** victoire(s)` : `**${signed(valueFor(row))}** 🪙`;
      return `${prefix} <@${row.userId}> — ${value}`;
    })
    : ['*Aucune partie enregistrée pour l’instant. Sois le premier à tenter ta chance !*'];

  const embed = new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle('🏆 Classement du casino')
    .setDescription(`Classement par **${labels[sort] || labels.profit}**.\n\n${lines.join('\n')}`)
    .setFooter({ text: serverIdentity.signatureFor('Casino — top 10 du serveur') })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.rankProfit).setLabel('Bénéfice').setEmoji('📈').setStyle(sort === 'profit' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.rankWagered).setLabel('Misé').setEmoji('💸').setStyle(sort === 'wagered' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.rankWins).setLabel('Victoires').setEmoji('✅').setStyle(sort === 'wins' ? ButtonStyle.Primary : ButtonStyle.Secondary),
        closeButton(IDS.rankClose),
      ),
    ],
  };
}

// ── Jackpot ─────────────────────────────────────────────────────────────────
function jackpotPayload(config) {
  const cfg = engine.normalizeConfig(config);
  const last = cfg.lastJackpot;

  const embed = new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle('💰 Cagnotte du serveur')
    .setDescription([
      `# ${fmt(cfg.jackpot)} 🪙`,
      '',
      `Chaque mise à la **machine à sous** alimente la cagnotte (**${cfg.jackpotPercent}%** de la mise).`,
      'Trois 🎰 alignés et elle est à toi — puis elle repart de son montant de départ.',
    ].join('\n'))
    .addFields(
      { name: '🌱 Montant de départ', value: `**${fmt(cfg.jackpotSeed)}** 🪙`, inline: true },
      { name: '💎 Dernier jackpot', value: last ? `**${fmt(last.amount)}** 🪙 par <@${last.userId}> <t:${Math.floor(last.at / 1000)}:R>` : '*jamais décroché*', inline: false },
    )
    .setFooter({ text: serverIdentity.signatureFor('Casino') })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.hubMachine).setLabel('Tenter la machine').setEmoji('🎰').setStyle(ButtonStyle.Primary),
        closeButton(IDS.profileClose),
      ),
    ],
  };
}

// ── Historique ──────────────────────────────────────────────────────────────
function historyPayload(profile, user) {
  const prof = engine.normalizeProfile(profile, { userId: user?.id });
  const entries = [...prof.history].reverse();

  const lines = entries.length
    ? entries.map(entry => {
      const game = engine.GAMES[entry.game] || { emoji: '🎲', label: entry.game || 'Partie' };
      const when = entry.at ? `<t:${Math.floor(entry.at / 1000)}:R>` : '';
      return `${game.emoji} **${signed(entry.net)}** 🪙 · mise **${fmt(entry.bet)}** → rendu **${fmt(entry.payout)}** ${when}`;
    })
    : ['*Aucune partie pour l’instant.*'];

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`🧾 Historique — ${user?.username || 'Joueur'}`)
    .setDescription(lines.join('\n').slice(0, 4096))
    .setFooter({ text: serverIdentity.signatureFor(`Casino — ${fmt(prof.gamesPlayed)} partie(s) au total`) })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(closeButton(IDS.profileClose))],
  };
}

// ── Limites personnelles ────────────────────────────────────────────────────
function limitsPayload(profile, user) {
  const prof = engine.normalizeProfile(profile, { userId: user?.id });
  const excluded = prof.selfExcludeUntil > Date.now();

  const embed = new EmbedBuilder()
    .setColor(excluded ? COLORS.warning : COLORS.info)
    .setTitle('🛡️ Mes limites de jeu')
    .setDescription([
      `**Limite de perte journalière** : ${prof.lossLimit > 0 ? `**${fmt(prof.lossLimit)}** 🪙` : '*désactivée*'}`,
      prof.lossLimit > 0 && prof.dailyKey === engine.dayKey()
        ? `Perdu aujourd’hui : **${fmt(prof.dailyLoss)}** 🪙 — ${prof.dailyLoss >= prof.lossLimit ? '⛔ limite atteinte' : 'reste ' + fmt(Math.max(0, prof.lossLimit - prof.dailyLoss)) + ' 🪙'}`
        : '',
      '',
      `**Auto-exclusion** : ${excluded ? `active jusqu’à <t:${Math.ceil(prof.selfExcludeUntil / 1000)}:F>` : '*inactive*'}`,
      '',
      'Une limite ne change pas tes gains, elle t’aide seulement à t’arrêter. Tu peux la retirer à tout moment.',
    ].filter(Boolean).join('\n'))
    .setFooter({ text: serverIdentity.signatureFor('Casino — joue responsable') })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.limits1h).setLabel('Pause 1 h').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.limits24h).setLabel('1 jour').setEmoji('🌙').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.limits7d).setLabel('7 jours').setEmoji('📅').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.limits30d).setLabel('30 jours').setEmoji('🛑').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(IDS.limitsOff).setLabel('Retirer').setEmoji('▶️').setStyle(ButtonStyle.Success),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.limitsCustom).setLabel('Limite de perte').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        closeButton(IDS.profileClose),
      ),
    ],
  };
}

// ── Configuration ───────────────────────────────────────────────────────────
function configPayload(config, guild) {
  const cfg = engine.normalizeConfig(config);
  const channels = cfg.channelIds.length ? cfg.channelIds.map(id => `<#${id}>`).join(', ') : '*tout le serveur*';
  const games = engine.GAME_IDS.map(id => `${cfg.games[id] ? '✅' : '⛔'} ${engine.GAMES[id].emoji} ${engine.GAMES[id].label}`).join('\n');

  const embed = new EmbedBuilder()
    .setColor(cfg.enabled ? COLORS.success : COLORS.error)
    .setTitle(`⚙️ Configuration du casino${guild?.name ? ` — ${guild.name}` : ''}`)
    .setDescription(cfg.enabled ? 'Le casino est **ouvert**. Clique sur un réglage pour le modifier.' : '⛔ Le casino est **fermé** : plus aucune mise n’est acceptée.')
    .addFields(
      { name: '📍 Salons autorisés', value: channels, inline: false },
      { name: '💸 Mises', value: `**${fmt(cfg.minBet)} – ${fmt(cfg.maxBet)}** 🪙`, inline: true },
      { name: '⏱️ Cooldown', value: `**${cfg.cooldownSec}s**`, inline: true },
      { name: '📣 Annonces', value: cfg.announceWins && cfg.announceThreshold > 0 ? `dès **${fmt(cfg.announceThreshold)}** 🪙` : 'coupées', inline: true },
      { name: '💰 Cagnotte', value: `**${fmt(cfg.jackpot)}** 🪙 · **${cfg.jackpotPercent}%** des mises · départ **${fmt(cfg.jackpotSeed)}** 🪙`, inline: false },
      { name: '🎲 Jeux autorisés', value: games, inline: false },
    )
    .setFooter({ text: 'REZO • Casino — configuration (Gérer le serveur)' })
    .setTimestamp();

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(IDS.configChannels)
    .setPlaceholder('📍 Restreindre à certains salons (vide = partout)')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(0)
    .setMaxValues(10);

  if (cfg.channelIds.length) channelSelect.setDefaultChannels(cfg.channelIds.slice(0, 10));

  const gameSelect = new StringSelectMenuBuilder()
    .setCustomId(IDS.configGames)
    .setPlaceholder('🎲 Activer / désactiver des jeux')
    .setMinValues(1)
    .setMaxValues(engine.GAME_IDS.length)
    .addOptions(engine.GAME_IDS.map(id => ({
      label: engine.GAMES[id].label,
      value: id,
      emoji: engine.GAMES[id].emoji,
      description: cfg.games[id] ? 'Activé — clique pour le retirer' : 'Désactivé — clique pour l’activer',
      default: cfg.games[id],
    })));

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(IDS.configToggle)
          .setLabel(cfg.enabled ? 'Fermer le casino' : 'Ouvrir le casino')
          .setEmoji(cfg.enabled ? '⛔' : '✅')
          .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(IDS.configBets).setLabel('Mises').setEmoji('💸').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(IDS.configCooldown).setLabel('Cooldown').setEmoji('⏱️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.configJackpot).setLabel('Jackpot').setEmoji('💰').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDS.configAnnounce).setLabel('Annonces').setEmoji('📣').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(gameSelect),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.configRefresh).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
        closeButton(IDS.configClose),
      ),
    ],
  };
}

module.exports = {
  IDS,
  MODALS,
  BJ,
  OUTCOME_LABEL,
  signed,
  hubPayload,
  resultPayload,
  blackjackPayload,
  blackjackSettledPayload,
  profilePayload,
  leaderboardPayload,
  jackpotPayload,
  historyPayload,
  limitsPayload,
  configPayload,
};
