'use strict';
// commands/fun/duel.js — ⚔️ Duel 1 contre 1 au tour par tour, avec mise en coins.
//
// Les boutons Accepter / Refuser sont routés par events/core/interactionCreate
// (duel_accept_* / duel_decline_*) : le défi survit donc à un redémarrage du bot.
// Une fois accepté, les coups se jouent dans un collecteur attaché au message
// d'arène. Les dégâts sont calculés par des helpers purs (testables hors-ligne).

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, AttachmentBuilder, MessageFlags,
} = require('discord.js');

const Duel = require('../../models/Duel');
const Balance = require('../../models/Balance');
const { COLORS, errorEmbed } = require('../../utils/embeds');
const { generateDuelImage } = require('../../utils/duelCanvas');
const brand = require('../../utils/brand');

const START_HP = 100;
const MAX_WAGER = 1_000_000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

// ── Helpers purs (testables hors-ligne) ─────────────────────────────────────
function rollDamage(rng = Math.random) {
  const base = 8 + Math.floor(rng() * 13); // 8 → 20
  const crit = rng() < 0.15;
  return { damage: crit ? Math.round(base * 1.75) : base, crit };
}

function clampHp(hp) {
  return Math.max(0, Math.min(START_HP, Math.round(Number(hp) || 0)));
}

function hpBar(hp) {
  return brand.bar((clampHp(hp) / START_HP) * 100, { length: 10 });
}

// ── Accès base de données ───────────────────────────────────────────────────
async function getBalance(guildId, userId) {
  return Balance.findOneAndUpdate(
    { guildId, userId },
    { $setOnInsert: { guildId, userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function fetchUser(client, id) {
  const user = await client.users.fetch(id).catch(() => null);
  return user || {
    username: `Joueur ${String(id).slice(-4)}`,
    displayAvatarURL: () => null,
  };
}

// ── Rendu ───────────────────────────────────────────────────────────────────
function buildArenaEmbed(duel, p1, p2, note = null) {
  const turnUser = duel.turn === duel.player1Id ? p1 : p2;
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('⚔️ Duel')
    .setDescription(
      `**${p1.username}** affronte **${p2.username}**` +
      (duel.wager > 0 ? ` — mise de **${duel.wager}** 🪙 chacun (cagnotte : **${duel.wager * 2}** 🪙)` : ''),
    )
    .addFields(
      { name: `${p1.username}`.slice(0, 32), value: `${hpBar(duel.hp1)}\n**${clampHp(duel.hp1)}** / ${START_HP} PV`, inline: true },
      { name: `${p2.username}`.slice(0, 32), value: `${hpBar(duel.hp2)}\n**${clampHp(duel.hp2)}** / ${START_HP} PV`, inline: true },
    )
    .setFooter({ text: `REZO • Au tour de ${turnUser?.username ?? '?'}` })
    .setTimestamp();

  if (note) embed.addFields({ name: '🗒️ Dernier échange', value: note.slice(0, 1024) });
  return embed;
}

async function renderDuel(duel, p1, p2, { note = null, hitSide = null } = {}) {
  const embed = buildArenaEmbed(duel, p1, p2, note);
  let files = [];
  try {
    const buffer = await generateDuelImage(p1, p2, clampHp(duel.hp1), clampHp(duel.hp2), hitSide);
    files = [new AttachmentBuilder(buffer, { name: 'duel.png' })];
    embed.setImage('attachment://duel.png');
  } catch {
    // Canvas indisponible (police/asset manquant) → on garde le rendu texte.
  }
  return { embed, files };
}

function challengeRow(p1Id, p2Id, wager) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`duel_accept_${p1Id}_${p2Id}_${wager || 0}`)
      .setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`duel_decline_${p1Id}`)
      .setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

function combatRow(duel, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`duel_hit_${duel._id}`)
      .setLabel('Attaquer').setEmoji('⚔️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`duel_flee_${duel._id}`)
      .setLabel('Abandonner').setEmoji('🏳️').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

// ── Règlement ───────────────────────────────────────────────────────────────
async function settle(duel, winnerId) {
  if (duel.status === 'finished') return;
  duel.status = 'finished';
  duel.winnerId = winnerId || null;
  await duel.save().catch(() => {});
  if (duel.wager > 0 && winnerId) {
    const bal = await getBalance(duel.guildId, winnerId).catch(() => null);
    if (bal) { bal.coins += duel.wager * 2; await bal.save().catch(() => {}); }
  }
}

// Rembourse les deux mises (fin sans vainqueur : abandon du collecteur, crash…).
async function refund(duel) {
  if (duel.status !== 'active' || !duel.wager) return;
  for (const id of [duel.player1Id, duel.player2Id]) {
    const bal = await getBalance(duel.guildId, id).catch(() => null);
    if (bal) { bal.coins += duel.wager; await bal.save().catch(() => {}); }
  }
}

// ── Collecteur de combat ────────────────────────────────────────────────────
function startCombat(interaction, duel, p1, p2) {
  const message = interaction.message;
  if (!message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({
    filter: i =>
      (i.customId === `duel_hit_${duel._id}` || i.customId === `duel_flee_${duel._id}`) &&
      (i.user.id === duel.player1Id || i.user.id === duel.player2Id),
    time: TURN_TIMEOUT_MS,
  });

  collector.on('collect', async i => {
    try {
      if (i.customId === `duel_flee_${duel._id}`) {
        const winner = i.user.id === duel.player1Id ? duel.player2Id : duel.player1Id;
        await settle(duel, winner);
        collector.stop('finished');
        const finalEmbed = buildArenaEmbed(duel, p1, p2, `🏳️ <@${i.user.id}> abandonne. **<@${winner}>** l'emporte !`);
        finalEmbed.setTitle('🏆 Duel terminé');
        return i.update({ embeds: [finalEmbed], components: [combatRow(duel, true)], files: [] }).catch(() => {});
      }

      // Coup normal : seul le joueur dont c'est le tour peut frapper.
      if (i.user.id !== duel.turn) {
        return i.reply({ content: '⏳ Ce n\'est pas ton tour.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }

      const attackerIsP1 = i.user.id === duel.player1Id;
      const targetId = attackerIsP1 ? duel.player2Id : duel.player1Id;
      const { damage, crit } = rollDamage();

      if (attackerIsP1) duel.hp2 = clampHp(duel.hp2 - damage);
      else duel.hp1 = clampHp(duel.hp1 - damage);
      duel.turn = targetId;

      const note = `**<@${i.user.id}>** inflige **${damage}** dégâts${crit ? ' — 💥 **coup critique !**' : ''}`;
      const targetHp = attackerIsP1 ? duel.hp2 : duel.hp1;

      if (targetHp <= 0) {
        await settle(duel, i.user.id);
        collector.stop('finished');
        const finalEmbed = buildArenaEmbed(duel, p1, p2, `${note}\n\n🏆 **<@${i.user.id}>** remporte le duel !`);
        finalEmbed.setTitle('🏆 Duel terminé');
        return i.update({ embeds: [finalEmbed], components: [combatRow(duel, true)], files: [] }).catch(() => {});
      }

      await duel.save().catch(() => {});
      const { embed, files } = await renderDuel(duel, p1, p2, {
        note,
        hitSide: attackerIsP1 ? 'p2' : 'p1',
      });
      return i.update({ embeds: [embed], components: [combatRow(duel)], files }).catch(() => {});
    } catch (err) {
      console.error('[duel] collect:', err.message);
      if (!i.replied && !i.deferred) await i.reply({ content: '❌ Erreur pendant le combat.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  collector.on('end', async (_collected, reason) => {
    if (reason === 'finished') return;
    const fresh = await Duel.findById(duel._id).catch(() => null);
    if (!fresh || fresh.status !== 'active') return;
    await refund(fresh);
    fresh.status = 'finished';
    await fresh.save().catch(() => {});
    const ended = buildArenaEmbed(fresh, p1, p2, '⏱️ Duel interrompu — les mises ont été rendues.');
    ended.setTitle('⌛ Duel terminé (temps écoulé)');
    await message.edit({ embeds: [ended], components: [combatRow(fresh, true)], files: [] }).catch(() => {});
  });

  return collector;
}

// ── Boutons routés par interactionCreate ────────────────────────────────────
async function handleAccept(interaction, p1Id, p2Id, wager) {
  const client = interaction.client;
  if (interaction.user.id !== p2Id) {
    return interaction.reply({ content: '❌ Ce défi ne t\'est pas destiné.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  const duel = await Duel.findOne({
    guildId: interaction.guildId, player1Id: p1Id, player2Id: p2Id, status: 'pending',
  }).sort({ createdAt: -1 });

  if (!duel) {
    return interaction.update({
      embeds: [errorEmbed('Défi introuvable', 'Ce défi a expiré ou a déjà été traité.')],
      components: [],
    }).catch(() => {});
  }

  // Mise : on vérifie les deux soldes puis on débite (cagnotte conservée en jeu).
  if (duel.wager > 0) {
    const b1 = await getBalance(interaction.guildId, p1Id);
    const b2 = await getBalance(interaction.guildId, p2Id);
    if (b1.coins < duel.wager || b2.coins < duel.wager) {
      duel.status = 'finished';
      await duel.save().catch(() => {});
      return interaction.update({
        embeds: [errorEmbed('Mise impossible', 'Un des deux joueurs n\'a pas assez de coins pour cette mise.')],
        components: [],
      }).catch(() => {});
    }
    b1.coins -= duel.wager;
    b2.coins -= duel.wager;
    await b1.save().catch(() => {});
    await b2.save().catch(() => {});
  }

  duel.status = 'active';
  duel.turn = duel.player1Id;
  duel.hp1 = START_HP;
  duel.hp2 = START_HP;
  await duel.save().catch(() => {});

  const p1 = await fetchUser(client, duel.player1Id);
  const p2 = await fetchUser(client, duel.player2Id);

  const { embed, files } = await renderDuel(duel, p1, p2);
  await interaction.update({
    content: `⚔️ <@${duel.player1Id}> contre <@${duel.player2Id}> — au tour de <@${duel.turn}> !`,
    embeds: [embed],
    components: [combatRow(duel)],
    files,
  }).catch(() => {});

  startCombat(interaction, duel, p1, p2);
}

async function handleDecline(interaction, p1Id) {
  const duel = await Duel.findOne({
    guildId: interaction.guildId, player1Id: p1Id, status: 'pending',
  }).sort({ createdAt: -1 });

  if (!duel || (interaction.user.id !== duel.player2Id && interaction.user.id !== duel.player1Id)) {
    return interaction.reply({ content: '❌ Ce défi n\'existe plus.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  duel.status = 'finished';
  await duel.save().catch(() => {});

  return interaction.update({
    embeds: [errorEmbed('Défi refusé', `<@${duel.player2Id}> ne souhaite pas se battre.`)],
    components: [],
  }).catch(() => {});
}

// ── Commande ────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('duel')
    .setDescription('⚔️ Défier un membre en duel (avec mise en coins optionnelle)')
    .addUserOption(o => o.setName('adversaire').setDescription('Le membre à défier').setRequired(true))
    .addIntegerOption(o =>
      o.setName('mise').setDescription('Coins misés par joueur (optionnel)').setMinValue(0).setMaxValue(MAX_WAGER)),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [errorEmbed('Serveur requis', 'Les duels se déroulent sur un serveur.')], flags: MessageFlags.Ephemeral });
    }

    const opponent = interaction.options.getUser('adversaire');
    const wager = interaction.options.getInteger('mise') ?? 0;

    if (opponent.id === interaction.user.id) {
      return interaction.reply({ embeds: [errorEmbed('Impossible', 'Tu ne peux pas te défier toi-même.')], flags: MessageFlags.Ephemeral });
    }
    if (opponent.bot) {
      return interaction.reply({ embeds: [errorEmbed('Impossible', 'Les bots ne se battent pas.')], flags: MessageFlags.Ephemeral });
    }

    if (wager > 0) {
      const bal = await getBalance(interaction.guildId, interaction.user.id);
      if (bal.coins < wager) {
        return interaction.reply({
          embeds: [errorEmbed('Coins insuffisants', `Il te faut au moins **${wager}** 🪙 pour cette mise (tu as **${bal.coins}**).`)],
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    // Un seul défi en attente entre deux mêmes joueurs.
    await Duel.updateMany(
      { guildId: interaction.guildId, player1Id: interaction.user.id, player2Id: opponent.id, status: 'pending' },
      { status: 'finished' },
    ).catch(() => {});

    await Duel.create({
      guildId: interaction.guildId,
      player1Id: interaction.user.id,
      player2Id: opponent.id,
      wager,
      status: 'pending',
    });

    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle('⚔️ Défi lancé !')
      .setDescription(
        `<@${interaction.user.id}> défie <@${opponent.id}> en duel.` +
        (wager > 0 ? `\n\n💰 Mise : **${wager}** 🪙 par joueur (cagnotte : **${wager * 2}** 🪙).` : '\n\n💰 Duel amical — aucune mise.'),
      )
      .setFooter({ text: 'REZO • En attente d\'acceptation (10 min)' })
      .setTimestamp();

    return interaction.reply({
      content: `<@${opponent.id}>`,
      embeds: [embed],
      components: [challengeRow(interaction.user.id, opponent.id, wager)],
      allowedMentions: { users: [opponent.id] },
    });
  },

  handleAccept,
  handleDecline,

  __testables: { rollDamage, clampHp, hpBar, buildArenaEmbed, START_HP, MAX_WAGER },
};
