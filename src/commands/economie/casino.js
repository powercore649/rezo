'use strict';
// commands/economie/casino.js — 🎰 La commande unique du casino.
//
// Une seule commande globale (le budget Discord est plein), plusieurs
// sous-commandes et un panel interactif :
//   /casino menu         → accueil et boutons de jeu
//   /casino machine      → machine à sous
//   /casino roulette     → rouge/noir, pair/impair, 1-18/19-36, numéro exact
//   /casino blackjack    → table persistée (tirer / rester / doubler)
//   /casino des          → somme de deux dés
//   /casino piece        → pile ou face
//   /casino profil       → statistiques, niveau, historique
//   /casino classement   → top 10 (bénéfice, misé, victoires)
//   /casino jackpot      → cagnotte du serveur
//   /casino historique   → 10 dernières parties
//   /casino limites      → limite de perte et auto-exclusion
//   /casino config       → réglages admin (Gérer le serveur)
//
// Le calcul des gains vit dans utils/casinoEngine.js, l'argent dans
// utils/casinoService.js, le dessin dans utils/casinoView.js. Ce fichier ne
// fait que router et répondre.
//
// Les interactions `cas_*` sont routées par events/core/interactionCreate.js.

const {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} = require('discord.js');

const engine = require('../../utils/casinoEngine');
const service = require('../../utils/casinoService');
const view = require('../../utils/casinoView');
const { errorEmbed, successEmbed } = require('../../utils/embeds');

const EPHEMERAL = MessageFlags.Ephemeral;

// ── Petits garde-fous ───────────────────────────────────────────────────────
const GAME_SUBS = ['machine', 'roulette', 'blackjack', 'des', 'piece'];

function isAdmin(interaction) {
  const perms = interaction.memberPermissions || interaction.member?.permissions;
  return Boolean(perms?.has?.(PermissionFlagsBits.ManageGuild));
}

async function deny(interaction) {
  const payload = {
    embeds: [errorEmbed('Permission refusée', 'Il faut la permission **Gérer le serveur** pour configurer le casino.')],
    flags: EPHEMERAL,
  };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}

async function guildOnly(interaction) {
  if (interaction.guild) return false;
  await interaction.reply({
    embeds: [errorEmbed('Serveur uniquement', 'Le casino n’existe que dans un serveur.')],
    flags: EPHEMERAL,
  }).catch(() => {});
  return true;
}

async function announce(interaction, result, config) {
  if (!interaction.channel?.send) return;

  if (result.jackpotAmount > 0) {
    await interaction.channel.send({
      content: `💎 **JACKPOT** — <@${interaction.user.id}> décroche **${engine.fmt(result.jackpotAmount)}** 🪙 à la machine à sous !`,
      allowedMentions: { users: [interaction.user.id] },
    }).catch(() => {});
    return;
  }

  const cfg = engine.normalizeConfig(config);
  if (!cfg.announceWins || cfg.announceThreshold <= 0) return;
  if (result.net < cfg.announceThreshold) return;

  await interaction.channel.send({
    content: `🎉 <@${interaction.user.id}> empoche **${engine.fmt(result.net)}** 🪙 au ${engine.GAMES[result.game].label} !`,
    allowedMentions: { users: [interaction.user.id] },
  }).catch(() => {});
}

// ── Accueil ─────────────────────────────────────────────────────────────────
async function hubPayloadFor(interaction) {
  const guildId = interaction.guildId;
  const [config, profile, balance] = await Promise.all([
    service.getConfig(guildId),
    service.getProfile(guildId, interaction.user.id),
    service.getBalance(guildId, interaction.user.id),
  ]);
  return view.hubPayload({ config, profile, balance, user: interaction.user, admin: isAdmin(interaction) });
}

async function openBetModal(interaction, game) {
  const modal = new ModalBuilder()
    .setCustomId(`${view.MODALS.bet}${game}`)
    .setTitle(`Miser — ${engine.GAMES[game].label}`)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('mise')
        .setLabel('Montant de la mise (pièces)')
        .setPlaceholder('Ex : 100')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(9),
    ));

  return interaction.showModal(modal);
}

// ── Jeux instantanés ────────────────────────────────────────────────────────
async function runInstant(interaction, { game, bet, choice = null, number = null }) {
  await interaction.deferReply();
  const result = await service.playInstant({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    game,
    bet,
    choice,
    number,
  });

  if (!result.ok) {
    return interaction.editReply({ embeds: [errorEmbed('Mise refusée', result.message)] });
  }

  await interaction.editReply(view.resultPayload(result, interaction.user));
  await announce(interaction, result, result.config);
  return result;
}

async function playFromModal(modal, game) {
  const bet = engine.parseBet(modal.fields.getTextInputValue('mise'));
  if (!bet) {
    return modal.reply({
      embeds: [errorEmbed('Mise invalide', 'Indique un nombre entier de pièces (ex. `100`).')],
      flags: EPHEMERAL,
    });
  }

  await modal.deferReply();
  const result = await service.playInstant({
    guildId: modal.guildId,
    userId: modal.user.id,
    channelId: modal.channelId,
    game,
    bet,
    choice: engine.GAMES[game]?.defaultChoice || null,
  });

  if (!result.ok) {
    return modal.editReply({ embeds: [errorEmbed('Mise refusée', result.message)] });
  }

  await modal.editReply(view.resultPayload(result, modal.user));
  await announce(modal, result, result.config);
  return result;
}

// ── Blackjack ───────────────────────────────────────────────────────────────
async function startBlackjack(interaction, bet) {
  await interaction.deferReply();
  const result = await service.startBlackjack({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    bet,
  });

  if (!result.ok) {
    return interaction.editReply({ embeds: [errorEmbed('Table impossible', result.message)] });
  }

  if (result.settled && result.settlement?.round) {
    return interaction.editReply(view.blackjackSettledPayload(result.settlement));
  }

  return interaction.editReply(view.blackjackPayload(result.round, interaction.user));
}

async function blackjackAction(interaction, roundId, action) {
  const call = action === 'hit'
    ? service.hitBlackjack
    : action === 'stand'
      ? service.standBlackjack
      : service.doubleBlackjack;

  const result = await call({ roundId, userId: interaction.user.id });

  if (!result.ok) {
    return interaction.reply({
      embeds: [errorEmbed('Action impossible', result.message)],
      flags: EPHEMERAL,
    }).catch(() => {});
  }

  if (result.settled) {
    if (!result.settlement?.round) {
      return interaction.reply({
        embeds: [errorEmbed('Table réglée', 'Le gain n’a pas pu être affiché. Vérifie ton solde avec /balance.')],
        flags: EPHEMERAL,
      }).catch(() => {});
    }
    return interaction.update(view.blackjackSettledPayload(result.settlement)).catch(() => {});
  }

  return interaction.update(view.blackjackPayload(result.round, interaction.user)).catch(() => {});
}

// ── Panels personnels ───────────────────────────────────────────────────────
async function sendProfile(interaction, target = interaction.user) {
  if (target.bot) {
    return interaction.reply({
      embeds: [errorEmbed('Profil indisponible', 'Les bots ne jouent pas au casino.')],
      flags: EPHEMERAL,
    }).catch(() => {});
  }
  const profile = await service.getProfile(interaction.guildId, target.id);
  const payload = view.profilePayload(profile, target);
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}

async function sendLeaderboard(interaction, sort = 'profit', update = false) {
  const rows = await service.getLeaderboard({ guildId: interaction.guildId, sort });
  const payload = view.leaderboardPayload(rows, sort);
  if (update) return interaction.editReply(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}

async function sendLimits(interaction) {
  const profile = await service.getProfile(interaction.guildId, interaction.user.id);
  const payload = { ...view.limitsPayload(profile, interaction.user), flags: EPHEMERAL };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}

async function sendHistory(interaction, target = interaction.user) {
  const profile = await service.getProfile(interaction.guildId, target.id);
  const payload = { ...view.historyPayload(profile, target), flags: EPHEMERAL };
  return interaction.reply(payload).catch(() => {});
}

async function sendJackpot(interaction) {
  const config = await service.getConfig(interaction.guildId);
  return interaction.reply({ ...view.jackpotPayload(config), flags: EPHEMERAL }).catch(() => {});
}

// ── Configuration ───────────────────────────────────────────────────────────
async function sendConfig(interaction) {
  const config = await service.getConfig(interaction.guildId);
  return interaction.reply({
    ...view.configPayload(config, interaction.guild),
    flags: EPHEMERAL,
  }).catch(() => {});
}

async function refreshConfig(interaction) {
  const config = await service.getConfig(interaction.guildId);
  return interaction.editReply(view.configPayload(config, interaction.guild)).catch(() => {});
}

function modalField(id, label, placeholder, value, maxLength = 12) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setPlaceholder(placeholder)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(maxLength)
      .setValue(String(value)),
  );
}

function parsePlainInt(raw, { min = 0, max = engine.MAX_BET } = {}) {
  const cleaned = String(raw || '').trim().replace(/[\s\u00a0\u202f_'’]/g, '');
  if (!/^\d{1,9}$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

// ── Routage des boutons ────────────────────────────────────────────────────
async function handleButton(interaction) {
  if (!interaction.isButton?.()) return;
  const id = interaction.customId;

  // Bouton « Rejouer » : il porte l'identifiant du modal qu'il ouvre.
  if (id.startsWith(view.MODALS.bet)) {
    const game = id.slice(view.MODALS.bet.length);
    if (engine.GAMES[game]) return openBetModal(interaction, game);
    return;
  }

  // Accueil
  if (id === view.IDS.hubRefresh) {
    await interaction.deferUpdate().catch(() => {});
    const payload = await hubPayloadFor(interaction);
    return interaction.editReply(payload).catch(() => {});
  }
  if (id === view.IDS.hubProfile) return sendProfile(interaction);
  if (id === view.IDS.hubRank) return sendLeaderboard(interaction);
  if (id === view.IDS.hubJackpot) return sendJackpot(interaction);
  if (id === view.IDS.hubHistory) return sendHistory(interaction);
  if (id === view.IDS.hubLimits) return sendLimits(interaction);
  if (id === view.IDS.hubConfig) {
    if (!isAdmin(interaction)) return deny(interaction);
    return sendConfig(interaction);
  }

  const gameFromButton = {
    [view.IDS.hubMachine]: 'machine',
    [view.IDS.hubRoulette]: 'roulette',
    [view.IDS.hubBlackjack]: 'blackjack',
    [view.IDS.hubDes]: 'des',
    [view.IDS.hubPiece]: 'piece',
  }[id];
  if (gameFromButton) return openBetModal(interaction, gameFromButton);

  // Blackjack
  if (id.startsWith(view.BJ.hit)) return blackjackAction(interaction, id.slice(view.BJ.hit.length), 'hit');
  if (id.startsWith(view.BJ.stand)) return blackjackAction(interaction, id.slice(view.BJ.stand.length), 'stand');
  if (id.startsWith(view.BJ.double)) return blackjackAction(interaction, id.slice(view.BJ.double.length), 'double');

  // Profil
  if (id.startsWith(view.IDS.profileRefresh)) {
    const userId = id.slice(view.IDS.profileRefresh.length);
    const target = userId === interaction.user.id
      ? interaction.user
      : await interaction.client.users.fetch(userId).catch(() => null);
    if (!target) return interaction.deferUpdate().catch(() => {});
    await interaction.deferUpdate().catch(() => {});
    const profile = await service.getProfile(interaction.guildId, target.id);
    return interaction.editReply(view.profilePayload(profile, target)).catch(() => {});
  }
  if (id === view.IDS.profileRank) {
    await interaction.deferUpdate().catch(() => {});
    return sendLeaderboard(interaction, 'profit', true);
  }
  if (id === view.IDS.profileLimits) return sendLimits(interaction);
  if (id === view.IDS.profileClose) {
    await interaction.deferUpdate().catch(() => {});
    return interaction.editReply({ components: [] }).catch(() => {});
  }

  // Classement
  if (id === view.IDS.rankProfit) {
    await interaction.deferUpdate().catch(() => {});
    return sendLeaderboard(interaction, 'profit', true);
  }
  if (id === view.IDS.rankWagered) {
    await interaction.deferUpdate().catch(() => {});
    return sendLeaderboard(interaction, 'wagered', true);
  }
  if (id === view.IDS.rankWins) {
    await interaction.deferUpdate().catch(() => {});
    return sendLeaderboard(interaction, 'wins', true);
  }
  if (id === view.IDS.rankClose) {
    await interaction.deferUpdate().catch(() => {});
    return interaction.editReply({ components: [] }).catch(() => {});
  }

  // Limites personnelles
  const pauseHours = {
    [view.IDS.limits1h]: 1,
    [view.IDS.limits24h]: 24,
    [view.IDS.limits7d]: 24 * 7,
    [view.IDS.limits30d]: 24 * 30,
  }[id];
  if (pauseHours || id === view.IDS.limitsOff) {
    await interaction.deferUpdate().catch(() => {});
    const until = pauseHours ? Date.now() + pauseHours * 3_600_000 : null;
    const profile = await service.setSelfExclusion({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      until,
    });
    return interaction.editReply(view.limitsPayload(profile, interaction.user)).catch(() => {});
  }
  if (id === view.IDS.limitsCustom) {
    const profile = await service.getProfile(interaction.guildId, interaction.user.id);
    const modal = new ModalBuilder()
      .setCustomId(view.MODALS.limits)
      .setTitle('Limite de perte journalière')
      .addComponents(modalField('perte', 'Plafond en pièces (0 = désactivé)', 'Ex : 2000', profile.lossLimit || 0));
    return interaction.showModal(modal);
  }

  // Configuration
  if (id === view.IDS.configToggle) {
    if (!isAdmin(interaction)) return deny(interaction);
    await interaction.deferUpdate().catch(() => {});
    const config = await service.getConfig(interaction.guildId);
    await service.saveConfig(interaction.guildId, { enabled: !config.enabled });
    return refreshConfig(interaction);
  }
  if (id === view.IDS.configBets) {
    if (!isAdmin(interaction)) return deny(interaction);
    const config = await service.getConfig(interaction.guildId);
    const modal = new ModalBuilder()
      .setCustomId(view.MODALS.bets)
      .setTitle('Mises minimum et maximum')
      .addComponents(
        modalField('min', 'Mise minimum (pièces)', 'Ex : 10', config.minBet),
        modalField('max', 'Mise maximum (pièces)', 'Ex : 5000', config.maxBet),
      );
    return interaction.showModal(modal);
  }
  if (id === view.IDS.configCooldown) {
    if (!isAdmin(interaction)) return deny(interaction);
    const config = await service.getConfig(interaction.guildId);
    const modal = new ModalBuilder()
      .setCustomId(view.MODALS.cooldown)
      .setTitle('Cooldown entre deux mises')
      .addComponents(modalField('secondes', 'Secondes (0 = aucune limite)', 'Ex : 5', config.cooldownSec, 4));
    return interaction.showModal(modal);
  }
  if (id === view.IDS.configJackpot) {
    if (!isAdmin(interaction)) return deny(interaction);
    const config = await service.getConfig(interaction.guildId);
    const modal = new ModalBuilder()
      .setCustomId(view.MODALS.jackpot)
      .setTitle('Cagnotte')
      .addComponents(
        modalField('pourcentage', 'Part de chaque mise (0-25 %)', 'Ex : 5', config.jackpotPercent, 2),
        modalField('depart', 'Montant de départ (pièces)', 'Ex : 1000', config.jackpotSeed),
      );
    return interaction.showModal(modal);
  }
  if (id === view.IDS.configAnnounce) {
    if (!isAdmin(interaction)) return deny(interaction);
    const config = await service.getConfig(interaction.guildId);
    const modal = new ModalBuilder()
      .setCustomId(view.MODALS.announce)
      .setTitle('Annonces de gros gains')
      .addComponents(modalField('seuil', 'Seuil en pièces (0 = couper)', 'Ex : 5000', config.announceThreshold));
    return interaction.showModal(modal);
  }
  if (id === view.IDS.configRefresh) {
    if (!isAdmin(interaction)) return deny(interaction);
    await interaction.deferUpdate().catch(() => {});
    return refreshConfig(interaction);
  }
  if (id === view.IDS.configClose) {
    await interaction.deferUpdate().catch(() => {});
    return interaction.editReply({ components: [] }).catch(() => {});
  }
}

// ── Routage des menus ──────────────────────────────────────────────────────
async function handleSelect(interaction) {
  if (!interaction.isAnySelectMenu?.()) return;
  if (!isAdmin(interaction)) return deny(interaction);

  const id = interaction.customId;
  if (id !== view.IDS.configChannels && id !== view.IDS.configGames) return;

  await interaction.deferUpdate().catch(() => {});

  if (id === view.IDS.configChannels) {
    await service.saveConfig(interaction.guildId, { channelIds: interaction.values.slice(0, 10) });
  } else {
    const games = {};
    for (const game of engine.GAME_IDS) games[game] = interaction.values.includes(game);
    await service.saveConfig(interaction.guildId, { games });
  }

  return refreshConfig(interaction);
}

// ── Routage des modaux ─────────────────────────────────────────────────────
async function handleModal(interaction) {
  if (!interaction.isModalSubmit?.()) return;
  const id = interaction.customId;

  if (id.startsWith(view.MODALS.bet)) {
    const game = id.slice(view.MODALS.bet.length);
    if (!engine.GAMES[game]) {
      return interaction.reply({ embeds: [errorEmbed('Jeu inconnu', 'Ce jeu n’existe pas.')], flags: EPHEMERAL }).catch(() => {});
    }
    return playFromModal(interaction, game);
  }

  if (id === view.MODALS.limits) {
    const raw = interaction.fields.getTextInputValue('perte').trim();
    const limit = raw === '0' ? 0 : parsePlainInt(raw, { min: 1, max: engine.MAX_BET });
    if (limit === null) {
      return interaction.reply({
        embeds: [errorEmbed('Limite invalide', 'Indique un entier entre `1` et `1 000 000`, ou `0` pour désactiver.')],
        flags: EPHEMERAL,
      }).catch(() => {});
    }
    const profile = await service.setLossLimit({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      limit,
    });
    return interaction.reply({
      embeds: [successEmbed(
        limit > 0 ? 'Limite enregistrée' : 'Limite retirée',
        limit > 0
          ? `Tu ne pourras plus miser au-delà de **${engine.fmt(limit)}** 🪙 de pertes sur une journée.`
          : 'Aucune limite de perte journalière n’est active.',
      )],
      flags: EPHEMERAL,
    }).catch(() => {});
  }

  // Toutes les autres modaux sont des réglages admin.
  if (!isAdmin(interaction)) return deny(interaction);

  if (id === view.MODALS.bets) {
    const min = parsePlainInt(interaction.fields.getTextInputValue('min'), { min: 1 });
    const max = parsePlainInt(interaction.fields.getTextInputValue('max'), { min: 1 });
    if (!min || !max || min > max) {
      return interaction.reply({
        embeds: [errorEmbed('Mises invalides', 'Indique deux entiers positifs, le minimum devant rester inférieur ou égal au maximum.')],
        flags: EPHEMERAL,
      }).catch(() => {});
    }
    await service.saveConfig(interaction.guildId, { minBet: min, maxBet: max });
    return interaction.reply({
      embeds: [successEmbed('Mises mises à jour', `Le casino accepte désormais de **${engine.fmt(min)}** à **${engine.fmt(max)}** 🪙.`)],
      flags: EPHEMERAL,
    }).catch(() => {});
  }

  if (id === view.MODALS.cooldown) {
    const seconds = parsePlainInt(interaction.fields.getTextInputValue('secondes'), { min: 0, max: 3600 });
    if (seconds === null) {
      return interaction.reply({
        embeds: [errorEmbed('Cooldown invalide', 'Indique un nombre de secondes entre `0` et `3600`.')],
        flags: EPHEMERAL,
      }).catch(() => {});
    }
    await service.saveConfig(interaction.guildId, { cooldownSec: seconds });
    return interaction.reply({
      embeds: [successEmbed('Cooldown mis à jour', seconds ? `Chaque membre devra attendre **${seconds}s** entre deux mises.` : 'Aucun cooldown entre deux mises.')],
      flags: EPHEMERAL,
    }).catch(() => {});
  }

  if (id === view.MODALS.jackpot) {
    const percent = parsePlainInt(interaction.fields.getTextInputValue('pourcentage'), { min: 0, max: 25 });
    const seed = parsePlainInt(interaction.fields.getTextInputValue('depart'), { min: 100 });
    if (percent === null || !seed) {
      return interaction.reply({
        embeds: [errorEmbed('Cagnotte invalide', 'Part entre `0` et `25` %, montant de départ au moins `100` 🪙.')],
        flags: EPHEMERAL,
      }).catch(() => {});
    }
    await service.saveConfig(interaction.guildId, { jackpotPercent: percent, jackpotSeed: seed });
    return interaction.reply({
      embeds: [successEmbed('Cagnotte mise à jour', `**${percent}%** de chaque mise alimente la cagnotte, qui repart à **${engine.fmt(seed)}** 🪙 après un jackpot.`)],
      flags: EPHEMERAL,
    }).catch(() => {});
  }

  if (id === view.MODALS.announce) {
    const threshold = parsePlainInt(interaction.fields.getTextInputValue('seuil'), { min: 0 });
    if (threshold === null) {
      return interaction.reply({
        embeds: [errorEmbed('Seuil invalide', 'Indique un entier positif, ou `0` pour couper les annonces.')],
        flags: EPHEMERAL,
      }).catch(() => {});
    }
    await service.saveConfig(interaction.guildId, { announceThreshold: threshold, announceWins: threshold > 0 });
    return interaction.reply({
      embeds: [successEmbed('Annonces mises à jour', threshold > 0 ? `Les gains d’au moins **${engine.fmt(threshold)}** 🪙 seront annoncés.` : 'Les annonces de gains sont coupées.')],
      flags: EPHEMERAL,
    }).catch(() => {});
  }
}

// ── Commande ────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('casino')
    .setDescription('🎰 Casino REZO — jeux, profil, classement, jackpot et configuration')
    .addSubcommand(sub => sub.setName('menu').setDescription('🎰 Ouvrir l’accueil du casino'))
    .addSubcommand(sub => sub
      .setName('machine')
      .setDescription('🎰 Machine à sous — aligne 3 symboles (jusqu’à ×100, plus le jackpot)')
      .addIntegerOption(option => option.setName('mise').setDescription('Montant misé en pièces').setRequired(true).setMinValue(1).setMaxValue(engine.MAX_BET)))
    .addSubcommand(sub => sub
      .setName('roulette')
      .setDescription('🎡 Roulette européenne — couleur, parité, dizaine ou numéro exact')
      .addIntegerOption(option => option.setName('mise').setDescription('Montant misé en pièces').setRequired(true).setMinValue(1).setMaxValue(engine.MAX_BET))
      .addStringOption(option => option
        .setName('type')
        .setDescription('Sur quoi tu mises')
        .setRequired(true)
        .addChoices(
          { name: '🔴 Rouge (×2)', value: 'rouge' },
          { name: '⚫ Noir (×2)', value: 'noir' },
          { name: 'Pair (×2)', value: 'pair' },
          { name: 'Impair (×2)', value: 'impair' },
          { name: '1 à 18 (×2)', value: 'bas' },
          { name: '19 à 36 (×2)', value: 'haut' },
          { name: 'Numéro exact (×36)', value: 'numero' },
        ))
      .addIntegerOption(option => option.setName('numero').setDescription('Numéro 0-36 (si type = numéro exact)').setMinValue(0).setMaxValue(36)))
    .addSubcommand(sub => sub
      .setName('blackjack')
      .setDescription('🃏 Blackjack — tire, reste ou double contre le croupier')
      .addIntegerOption(option => option.setName('mise').setDescription('Montant misé en pièces').setRequired(true).setMinValue(1).setMaxValue(engine.MAX_BET)))
    .addSubcommand(sub => sub
      .setName('des')
      .setDescription('🎲 Deux dés — parie sur bas (2-6), sept (7) ou haut (8-12)')
      .addIntegerOption(option => option.setName('mise').setDescription('Montant misé en pièces').setRequired(true).setMinValue(1).setMaxValue(engine.MAX_BET))
      .addStringOption(option => option
        .setName('choix')
        .setDescription('Somme attendue')
        .setRequired(false)
        .addChoices(
          { name: 'Bas (2-6) — ×2,3', value: 'bas' },
          { name: 'Sept pile (7) — ×5,8', value: 'sept' },
          { name: 'Haut (8-12) — ×2,3', value: 'haut' },
        )))
    .addSubcommand(sub => sub
      .setName('piece')
      .setDescription('🪙 Pile ou face — ×1,95 si tu devines le bon côté')
      .addIntegerOption(option => option.setName('mise').setDescription('Montant misé en pièces').setRequired(true).setMinValue(1).setMaxValue(engine.MAX_BET))
      .addStringOption(option => option
        .setName('choix')
        .setDescription('Côté attendu')
        .setRequired(false)
        .addChoices(
          { name: 'Pile', value: 'pile' },
          { name: 'Face', value: 'face' },
        )))
    .addSubcommand(sub => sub
      .setName('profil')
      .setDescription('👤 Profil casino — niveau, bénéfice net, séries et dernières parties')
      .addUserOption(option => option.setName('membre').setDescription('Voir le profil d’un autre membre').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('classement')
      .setDescription('🏆 Classement du casino — top 10 du serveur')
      .addStringOption(option => option
        .setName('tri')
        .setDescription('Classer par')
        .setRequired(false)
        .addChoices(
          { name: 'Bénéfice net', value: 'profit' },
          { name: 'Total misé', value: 'wagered' },
          { name: 'Victoires', value: 'wins' },
        )))
    .addSubcommand(sub => sub.setName('jackpot').setDescription('💰 Voir la cagnotte du serveur et son dernier gagnant'))
    .addSubcommand(sub => sub
      .setName('historique')
      .setDescription('🧾 Tes 10 dernières parties (ou celles d’un membre)')
      .addUserOption(option => option.setName('membre').setDescription('Voir l’historique d’un autre membre').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('limites')
      .setDescription('🛡️ Limite de perte journalière et auto-exclusion'))
    .addSubcommand(sub => sub
      .setName('config')
      .setDescription('⚙️ Configuration du casino (Gérer le serveur)')),

  execute,
  handleButton,
  handleSelect,
  handleModal,
  __testables: { isAdmin, parsePlainInt, runInstant, startBlackjack, blackjackAction },
};

async function execute(interaction) {
  if (await guildOnly(interaction)) return;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  // Une table de blackjack laissée en plan est réglée avant toute nouvelle
  // action : un redémarrage ne retient jamais la mise d'un membre.
  if (sub !== 'menu' && sub !== 'config') {
    await service.settleStaleRounds({ guildId }).catch(() => {});
  }

  if (sub === 'menu') {
    const payload = await hubPayloadFor(interaction);
    return interaction.reply(payload);
  }

  if (sub === 'machine' || sub === 'des' || sub === 'piece') {
    const bet = interaction.options.getInteger('mise');
    const choice = sub === 'des' ? interaction.options.getString('choix') || 'bas'
      : sub === 'piece' ? interaction.options.getString('choix') || 'pile'
        : null;
    return runInstant(interaction, { game: sub, bet, choice });
  }

  if (sub === 'roulette') {
    const bet = interaction.options.getInteger('mise');
    const type = interaction.options.getString('type');
    const number = interaction.options.getInteger('numero');
    if (type === 'numero' && number === null) {
      return interaction.reply({
        embeds: [errorEmbed('Numéro manquant', 'Avec le pari **numéro exact**, précise aussi `numero` (0 à 36).')],
        flags: EPHEMERAL,
      });
    }
    return runInstant(interaction, { game: 'roulette', bet, choice: type, number });
  }

  if (sub === 'blackjack') {
    return startBlackjack(interaction, interaction.options.getInteger('mise'));
  }

  if (sub === 'profil') {
    const target = interaction.options.getUser('membre') || interaction.user;
    return sendProfile(interaction, target);
  }

  if (sub === 'classement') {
    return sendLeaderboard(interaction, interaction.options.getString('tri') || 'profit');
  }

  if (sub === 'jackpot') {
    return sendJackpot(interaction);
  }

  if (sub === 'historique') {
    const target = interaction.options.getUser('membre') || interaction.user;
    return sendHistory(interaction, target);
  }

  if (sub === 'limites') {
    return sendLimits(interaction);
  }

  if (sub === 'config') {
    if (!isAdmin(interaction)) return deny(interaction);
    return sendConfig(interaction);
  }
}
