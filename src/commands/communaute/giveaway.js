// commands/communaute/giveaway.js — Système giveaway avancé v2
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const Giveaway = require('../../models/Giveaway');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');
const { sendNotification } = require('../../utils/notificationManager');

const PAGE_SIZE = 10;
const MAX_TIMEOUT_MS = 2_147_483_647;

// ─── Utilitaires ────────────────────────────────────────────────────────────

// setTimeout sûr — découpe les délais > 24.8j pour éviter l'overflow 32-bit
function scheduleAt(targetDate, callback) {
  const delay = targetDate.getTime() - Date.now();
  if (delay <= 0) return callback();
  if (delay <= MAX_TIMEOUT_MS) return setTimeout(callback, delay);
  return setTimeout(() => scheduleAt(targetDate, callback), MAX_TIMEOUT_MS);
}

function parseTime(str) {
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const n = parseInt(match[1]);
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * units[match[2]];
}

function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}j`;
}

function totalEntries(giveaway) {
  return giveaway.participants.reduce((sum, p) => sum + (p.entries || 1), 0);
}

// Tirage pondéré sans remise
function drawWeightedWinners(participants, count) {
  const pool = participants.map(p => ({ userId: p.userId, weight: Math.max(1, p.entries || 1) }));
  const winners = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const total = pool.reduce((s, p) => s + p.weight, 0);
    let roll = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      roll -= pool[idx].weight;
      if (roll <= 0) break;
    }
    winners.push(pool.splice(idx, 1)[0].userId);
  }
  return winners;
}

// ─── Boutons du message giveaway ────────────────────────────────────────────

function buildGiveawayButtons(giveaway) {
  const ended = giveaway.ended || giveaway.cancelled;
  const paused = giveaway.paused && !ended;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gw_join_${giveaway._id}`)
      .setLabel(paused ? '⏸️ En pause' : '🎉 Participer')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(ended || paused),
    new ButtonBuilder()
      .setCustomId(`gw_list_${giveaway._id}`)
      .setLabel('👥 Participants')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(false), // toujours cliquable pour voir les inscrits
    new ButtonBuilder()
      .setCustomId(`gw_info_${giveaway._id}`)
      .setLabel('ℹ️ Détails')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(ended),
  );

  // Ligne 2 — boutons host (visibles même terminé pour relancer/reroll)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gw_reroll_${giveaway._id}`)
      .setLabel('🔁 Reroll')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!ended || giveaway.cancelled || giveaway.participants.length === 0),
    new ButtonBuilder()
      .setCustomId(`gw_cancel_${giveaway._id}`)
      .setLabel('🗑️ Annuler')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(ended),
  );

  return [row1, row2];
}

// ─── Embed principal du giveaway ────────────────────────────────────────────

function buildGiveawayEmbed(giveaway) {
  const ended   = giveaway.ended || giveaway.cancelled;
  const paused  = giveaway.paused && !ended;
  const entries = totalEntries(giveaway);

  let color = 0xF1C40F; // jaune = en cours
  if (giveaway.cancelled) color = COLORS.error;
  else if (ended) color = COLORS.info;
  else if (paused) color = 0xE67E22; // orange = pause

  const endTs = Math.floor(giveaway.endAt.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎉 ${giveaway.prize}`)
    .addFields(
      { name: '🏆 Gagnant(s)', value: `**${giveaway.winners}**`, inline: true },
      { name: '👥 Participants', value: `**${giveaway.participants.length}**${entries !== giveaway.participants.length ? ` *(${entries} entrées)*` : ''}`, inline: true },
      { name: '🎟️ Organisateur', value: `<@${giveaway.hostId}>`, inline: true },
    )
    .setTimestamp(giveaway.endAt);

  // Description custom
  if (giveaway.description) {
    embed.setDescription(giveaway.description + '\n\u200b');
  }

  // Restrictions
  const restrictions = [];
  if (giveaway.requiredRoleId) restrictions.push(`• Rôle requis : <@&${giveaway.requiredRoleId}>`);
  if (giveaway.allowedRoles?.length) {
    restrictions.push(`• Rôle(s) requis : ${giveaway.allowedRoles.map(r => `<@&${r}>`).join(' ou ')}`);
  }
  if (giveaway.blacklistedRoles?.length) {
    restrictions.push(`• Rôle(s) exclus : ${giveaway.blacklistedRoles.map(r => `<@&${r}>`).join(', ')}`);
  }
  if (giveaway.maxParticipants) {
    restrictions.push(`• Places max : **${giveaway.participants.length}/${giveaway.maxParticipants}**`);
  }
  if (restrictions.length) {
    embed.addFields({ name: '🔒 Conditions', value: restrictions.join('\n'), inline: false });
  }

  // Entrées bonus
  if (giveaway.bonusRoles?.length) {
    embed.addFields({
      name: '⭐ Entrées bonus',
      value: giveaway.bonusRoles.map(b => `<@&${b.roleId}> : +${b.entries}`).join('\n'),
      inline: false,
    });
  }

  // État
  if (giveaway.cancelled) {
    embed.addFields({ name: '❌ Statut', value: 'Ce giveaway a été annulé.', inline: false });
    embed.setFooter({ text: 'Giveaway annulé' });
  } else if (ended) {
    if (giveaway.winnerIds.length > 0) {
      embed.addFields({
        name: `🎊 Gagnant${giveaway.winnerIds.length > 1 ? 's' : ''}`,
        value: giveaway.winnerIds.map(id => `<@${id}>`).join(', '),
        inline: false,
      });
    } else {
      embed.addFields({ name: '😔 Résultat', value: 'Aucun participant éligible.', inline: false });
    }
    const rerollTxt = giveaway.rerollCount > 0 ? ` • ${giveaway.rerollCount} reroll(s)` : '';
    embed.setFooter({ text: `Giveaway terminé${rerollTxt}` });
  } else if (paused) {
    embed.addFields({ name: '⏸️ Statut', value: 'Le giveaway est en pause. Les participations sont suspendues.', inline: false });
    embed.setFooter({ text: 'Giveaway en pause' });
  } else {
    embed.addFields({ name: '⏰ Fin', value: `<t:${endTs}:R> (<t:${endTs}:f>)`, inline: false });
    embed.setFooter({ text: 'Cliquez sur 🎉 pour participer' });
  }

  if (giveaway.imageUrl) embed.setImage(giveaway.imageUrl);
  if (giveaway.thumbnailUrl) embed.setThumbnail(giveaway.thumbnailUrl);

  return embed;
}

// ─── Fin de giveaway ────────────────────────────────────────────────────────

async function endGiveaway(giveaway, client, { silent = false } = {}) {
  if (giveaway.ended || giveaway.cancelled) return;

  const winners = drawWeightedWinners(giveaway.participants, giveaway.winners);
  await Giveaway.updateOne({ _id: giveaway._id }, { ended: true, winnerIds: winners });
  giveaway.ended    = true;
  giveaway.winnerIds = winners;

  try {
    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
    if (!channel) return;

    // Désactive les boutons + met à jour l'embed
    if (giveaway.messageId) {
      const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
      if (msg) {
        const fresh = await Giveaway.findById(giveaway._id);
        await msg.edit({
          embeds: [buildGiveawayEmbed(fresh)],
          components: buildGiveawayButtons(fresh),
        }).catch(() => {});
      }
    }

    if (!silent) {
      if (winners.length > 0) {
        // Message de félicitations public
        await channel.send({
          content: winners.map(id => `<@${id}>`).join(', '),
          embeds: [new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle('🎊 Félicitations !')
            .setDescription(`${winners.map(id => `<@${id}>`).join(', ')} ${winners.length > 1 ? 'ont gagné' : 'a gagné'} **${giveaway.prize}** !`)
            .addFields({ name: '📋 Reroll', value: 'Les admins peuvent cliquer sur **🔁 Reroll** pour retirer un nouveau gagnant.', inline: false })
            .setFooter({ text: `Organisé par — ${giveaway.hostId} • ID: ${giveaway._id}` })
            .setTimestamp()],
        });

        // DM aux gagnants si activé
        if (giveaway.dmWinners) {
          for (const winnerId of winners) {
            const user = await client.users.fetch(winnerId).catch(() => null);
            if (!user) continue;
            await user.send({
              embeds: [new EmbedBuilder()
                .setColor(COLORS.success)
                .setTitle('🎉 Vous avez gagné un giveaway !')
                .setDescription(`Vous avez gagné **${giveaway.prize}** sur **${channel.guild?.name ?? 'un serveur'}** !\nContactez l'organisateur <@${giveaway.hostId}> pour récupérer votre lot.`)
                .setTimestamp()],
            }).catch(() => {}); // DM peut être fermé
          }
        }

        // Notification centre
        sendNotification(client, giveaway.guildId, 'giveaways', new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('🎊 Giveaway terminé !')
          .setDescription(`**${giveaway.prize}**\nGagnant(s) : ${winners.map(id => `<@${id}>`).join(', ')}`)
          .setTimestamp(), `Giveaway terminé : ${giveaway.prize}`).catch(() => {});
      } else {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.warning)
            .setTitle('😔 Giveaway terminé sans gagnant')
            .setDescription(`Le giveaway pour **${giveaway.prize}** s'est terminé sans participant éligible.`)
            .setTimestamp()],
        });
      }
    }
  } catch (err) {
    console.error('❌ endGiveaway:', err.message);
  }
}

// ─── Reprogrammation au démarrage ───────────────────────────────────────────

async function rescheduleActiveGiveaways(client) {
  const active = await Giveaway.find({ ended: false, cancelled: false });
  let rescheduled = 0, endedImmediately = 0;

  for (const giveaway of active) {
    if (giveaway.paused) continue; // en pause → ne pas reprogrammer

    // Recalculer endAt réel si le bot était éteint pendant une pause
    const effectiveEnd = giveaway.endAt;

    if (effectiveEnd.getTime() <= Date.now()) {
      Giveaway.findById(giveaway._id).then(fresh => {
        if (fresh && !fresh.ended && !fresh.cancelled) endGiveaway(fresh, client).catch(console.error);
      });
      endedImmediately++;
    } else {
      scheduleAt(effectiveEnd, () => {
        Giveaway.findById(giveaway._id).then(fresh => {
          if (fresh && !fresh.ended && !fresh.cancelled && !fresh.paused) endGiveaway(fresh, client).catch(console.error);
        });
      });
      rescheduled++;
    }
  }
  console.log(`🎉 Giveaways : ${rescheduled} reprogrammé(s), ${endedImmediately} terminé(s) immédiatement`);
  return { rescheduled, endedImmediately };
}

// ─── Pagination participants ─────────────────────────────────────────────────

function buildParticipantsPage(giveaway, page, perPage = PAGE_SIZE) {
  const sorted = [...giveaway.participants].sort((a, b) => a.joinedAt - b.joinedAt);
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const slice = sorted.slice(page * perPage, page * perPage + perPage);

  const isWinner = new Set(giveaway.winnerIds ?? []);
  const lines = slice.map((p, i) => {
    const rank       = page * perPage + i + 1;
    const entriesTxt = p.entries > 1 ? ` *(×${p.entries})*` : '';
    const crown      = isWinner.has(p.userId) ? ' 👑' : '';
    return `\`${String(rank).padStart(3, ' ')}.\` <@${p.userId}>${entriesTxt}${crown}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`👥 Participants — ${giveaway.prize}`)
    .setDescription(lines.length ? lines.join('\n') : '*Aucun participant pour le moment.*')
    .setFooter({ text: `Page ${page + 1}/${totalPages} • ${sorted.length} participant(s) • ${totalEntries(giveaway)} entrée(s)` });

  return { embed, page, totalPages };
}

function buildPaginationRow(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gw_page_first').setLabel('«').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('gw_page_prev').setLabel('‹').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('gw_page_next').setLabel('›').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId('gw_page_last').setLabel('»').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );
}

// ─── Slash command ───────────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('🎉 Gérer les giveaways')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // ── créer ──────────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('créer')
      .setDescription('Créer un giveaway')
      .addStringOption(o => o.setName('prix').setDescription('Lot mis en jeu').setRequired(true))
      .addStringOption(o => o.setName('durée').setDescription('Durée : 10m, 1h, 2d…').setRequired(true))
      .addIntegerOption(o => o.setName('gagnants').setDescription('Nombre de gagnants (défaut: 1)').setMinValue(1).setMaxValue(20))
      .addStringOption(o => o.setName('description').setDescription('Description affichée dans l\'embed (optionnel)'))
      .addRoleOption(o => o.setName('rôle_requis').setDescription('Rôle obligatoire pour participer (optionnel)'))
      .addRoleOption(o => o.setName('rôle_exclu').setDescription('Rôle interdit de participation (optionnel)'))
      .addIntegerOption(o => o.setName('max_participants').setDescription('Nombre max de participants (optionnel)').setMinValue(1).setMaxValue(10000))
      .addBooleanOption(o => o.setName('dm_gagnants').setDescription('Envoyer un DM aux gagnants ? (défaut: non)'))
      .addStringOption(o => o.setName('image').setDescription('URL d\'une image pour l\'embed (optionnel)'))
      .addStringOption(o => o.setName('thumbnail').setDescription('URL d\'un thumbnail pour l\'embed (optionnel)')))

    // ── terminer ───────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('terminer')
      .setDescription('Terminer manuellement un giveaway')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true)))

    // ── annuler ────────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('annuler')
      .setDescription('Annuler un giveaway sans tirer de gagnant')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true)))

    // ── pause / reprendre ──────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('pause')
      .setDescription('Mettre un giveaway en pause (suspend les participations)')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true)))

    .addSubcommand(s => s
      .setName('reprendre')
      .setDescription('Reprendre un giveaway mis en pause')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true)))

    // ── reroll ─────────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('reroll')
      .setDescription('Retirer un nouveau gagnant sur un giveaway terminé')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true))
      .addIntegerOption(o => o.setName('gagnants').setDescription('Nombre de nouveaux gagnants (défaut: même qu\'à l\'origine)').setMinValue(1).setMaxValue(20)))

    // ── stats ──────────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('stats')
      .setDescription('Voir les statistiques d\'un giveaway')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true)))

    // ── liste ──────────────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('liste')
      .setDescription('Voir les giveaways en cours sur ce serveur'))

    // ── participants ───────────────────────────────────────────────────────
    .addSubcommand(s => s
      .setName('participants')
      .setDescription('Voir la liste paginée des participants')
      .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true)))

    // ── bonus-role ─────────────────────────────────────────────────────────
    .addSubcommandGroup(g => g
      .setName('bonus-role')
      .setDescription('Gérer les entrées bonus par rôle')
      .addSubcommand(s => s
        .setName('ajouter')
        .setDescription('Donner des entrées bonus à un rôle')
        .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true))
        .addRoleOption(o => o.setName('rôle').setDescription('Rôle concerné').setRequired(true))
        .addIntegerOption(o => o.setName('entrées').setDescription('Entrées bonus accordées').setRequired(true).setMinValue(1).setMaxValue(50)))
      .addSubcommand(s => s
        .setName('retirer')
        .setDescription('Retirer le bonus d\'un rôle')
        .addStringOption(o => o.setName('message_id').setDescription('ID du message du giveaway').setRequired(true))
        .addRoleOption(o => o.setName('rôle').setDescription('Rôle concerné').setRequired(true)))),

  // ─── execute ─────────────────────────────────────────────────────────────
  async execute(interaction, client) {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    const guild = interaction.guild;

    // ── bonus-role ──────────────────────────────────────────────────────
    if (group === 'bonus-role') {
      const msgId    = interaction.options.getString('message_id');
      const role     = interaction.options.getRole('rôle');
      const giveaway = await Giveaway.findOne({ messageId: msgId, guildId: guild.id });
      if (!giveaway)       return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });
      if (giveaway.ended)  return interaction.reply({ embeds: [errorEmbed('Terminé', 'Ce giveaway est déjà terminé.')], ephemeral: true });

      if (sub === 'ajouter') {
        const entries = interaction.options.getInteger('entrées');
        giveaway.bonusRoles = giveaway.bonusRoles.filter(b => b.roleId !== role.id);
        giveaway.bonusRoles.push({ roleId: role.id, entries });
        await giveaway.save();
        // Met à jour l'embed du message
        await _refreshMessage(giveaway, client);
        return interaction.reply({ embeds: [successEmbed('Bonus ajouté', `<@&${role.id}> donne désormais **+${entries}** entrée(s). L'embed a été mis à jour.`)], ephemeral: true });
      }
      if (sub === 'retirer') {
        giveaway.bonusRoles = giveaway.bonusRoles.filter(b => b.roleId !== role.id);
        await giveaway.save();
        await _refreshMessage(giveaway, client);
        return interaction.reply({ embeds: [successEmbed('Bonus retiré', `<@&${role.id}> n'accorde plus d'entrées bonus.`)], ephemeral: true });
      }
    }

    // ── créer ───────────────────────────────────────────────────────────
    if (sub === 'créer') {
      const prize          = interaction.options.getString('prix');
      const dureeStr       = interaction.options.getString('durée');
      const winnersCount   = interaction.options.getInteger('gagnants') ?? 1;
      const description    = interaction.options.getString('description') ?? null;
      const requiredRole   = interaction.options.getRole('rôle_requis');
      const blacklistRole  = interaction.options.getRole('rôle_exclu');
      const maxPart        = interaction.options.getInteger('max_participants') ?? null;
      const dmWinners      = interaction.options.getBoolean('dm_gagnants') ?? false;
      const imageUrl       = interaction.options.getString('image') ?? null;
      const thumbnailUrl   = interaction.options.getString('thumbnail') ?? null;
      const ms = parseTime(dureeStr);

      if (!ms || ms < 10_000 || ms > 30 * 86_400_000) {
        return interaction.reply({ embeds: [errorEmbed('Durée invalide', 'Format : `10s`, `5m`, `2h`, `7d`. Min 10s, max 30 jours.')], ephemeral: true });
      }
      // Validation URLs
      const urlRegex = /^https?:\/\/.+/i;
      if (imageUrl && !urlRegex.test(imageUrl))
        return interaction.reply({ embeds: [errorEmbed('URL invalide', 'L\'URL de l\'image doit commencer par `http://` ou `https://`.')], ephemeral: true });
      if (thumbnailUrl && !urlRegex.test(thumbnailUrl))
        return interaction.reply({ embeds: [errorEmbed('URL invalide', 'L\'URL du thumbnail doit commencer par `http://` ou `https://`.')], ephemeral: true });

      await interaction.deferReply({ ephemeral: true });

      const endAt    = new Date(Date.now() + ms);
      const giveaway = await Giveaway.create({
        guildId:          guild.id,
        channelId:        interaction.channel.id,
        hostId:           interaction.user.id,
        prize, description, imageUrl, thumbnailUrl,
        winners:          winnersCount,
        endAt,
        requiredRoleId:   requiredRole?.id ?? null,
        blacklistedRoles: blacklistRole ? [blacklistRole.id] : [],
        maxParticipants:  maxPart,
        dmWinners,
      });

      const embed  = buildGiveawayEmbed(giveaway);
      const rows   = buildGiveawayButtons(giveaway);
      const msg    = await interaction.channel.send({ embeds: [embed], components: rows });
      await Giveaway.updateOne({ _id: giveaway._id }, { messageId: msg.id });
      giveaway.messageId = msg.id;

      // Notification DM abonnés
      sendNotification(client, guild.id, 'giveaways', new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('🎉 Nouveau giveaway !')
        .setDescription(`**${prize}**\nSe termine <t:${Math.floor(endAt.getTime() / 1000)}:R> sur **${guild.name}**.`)
        .setURL(msg.url)
        .setTimestamp(), `Nouveau giveaway : ${prize}`).catch(() => {});

      // Programmation fin automatique
      scheduleAt(endAt, () => {
        Giveaway.findById(giveaway._id).then(fresh => {
          if (fresh && !fresh.ended && !fresh.cancelled && !fresh.paused) endGiveaway(fresh, client).catch(console.error);
        });
      });

      const summary = [
        `🎁 **Prix** : ${prize}`,
        `⏰ **Durée** : ${formatDuration(ms)}`,
        `🏆 **Gagnants** : ${winnersCount}`,
        maxPart ? `👥 **Max participants** : ${maxPart}` : null,
        requiredRole ? `🔒 **Rôle requis** : <@&${requiredRole.id}>` : null,
        blacklistRole ? `🚫 **Rôle exclu** : <@&${blacklistRole.id}>` : null,
        dmWinners ? `📬 **DM gagnants** : Oui` : null,
      ].filter(Boolean).join('\n');

      return interaction.editReply({ embeds: [successEmbed('Giveaway créé !', summary)] });
    }

    // ── terminer ────────────────────────────────────────────────────────
    if (sub === 'terminer') {
      const msgId    = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOne({ messageId: msgId, guildId: guild.id });
      if (!giveaway)      return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });
      if (giveaway.ended) return interaction.reply({ embeds: [errorEmbed('Déjà terminé', 'Ce giveaway est déjà terminé.')], ephemeral: true });

      await interaction.deferReply({ ephemeral: true });
      await endGiveaway(giveaway, client);
      return interaction.editReply({ embeds: [successEmbed('Giveaway terminé !', 'Les gagnants ont été tirés au sort et les boutons désactivés.')] });
    }

    // ── annuler ──────────────────────────────────────────────────────────
    if (sub === 'annuler') {
      const msgId    = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOne({ messageId: msgId, guildId: guild.id });
      if (!giveaway)           return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });
      if (giveaway.ended || giveaway.cancelled) return interaction.reply({ embeds: [errorEmbed('Déjà terminé', 'Ce giveaway est déjà terminé ou annulé.')], ephemeral: true });

      await interaction.deferReply({ ephemeral: true });
      await Giveaway.updateOne({ _id: giveaway._id }, { cancelled: true, ended: true });
      giveaway.cancelled = true;
      giveaway.ended     = true;

      await _refreshMessage(giveaway, client);
      await interaction.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle('❌ Giveaway annulé')
          .setDescription(`Le giveaway pour **${giveaway.prize}** a été annulé par <@${interaction.user.id}>.`)
          .setTimestamp()],
      }).catch(() => {});

      return interaction.editReply({ embeds: [successEmbed('Giveaway annulé', `Le giveaway **${giveaway.prize}** a été annulé. Aucun gagnant ne sera tiré.`)] });
    }

    // ── pause ────────────────────────────────────────────────────────────
    if (sub === 'pause') {
      const msgId    = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOne({ messageId: msgId, guildId: guild.id });
      if (!giveaway)       return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });
      if (giveaway.ended)  return interaction.reply({ embeds: [errorEmbed('Terminé', 'Ce giveaway est terminé.')], ephemeral: true });
      if (giveaway.paused) return interaction.reply({ embeds: [errorEmbed('Déjà en pause', 'Ce giveaway est déjà en pause. Utilisez `/giveaway reprendre`.')], ephemeral: true });

      await Giveaway.updateOne({ _id: giveaway._id }, { paused: true, pausedAt: new Date() });
      giveaway.paused   = true;
      giveaway.pausedAt = new Date();

      await _refreshMessage(giveaway, client);
      return interaction.reply({ embeds: [successEmbed('Giveaway en pause', `Le giveaway **${giveaway.prize}** est maintenant en pause. Utilisez \`/giveaway reprendre\` pour continuer.`)], ephemeral: true });
    }

    // ── reprendre ────────────────────────────────────────────────────────
    if (sub === 'reprendre') {
      const msgId    = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOne({ messageId: msgId, guildId: guild.id });
      if (!giveaway)        return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });
      if (giveaway.ended)   return interaction.reply({ embeds: [errorEmbed('Terminé', 'Ce giveaway est terminé.')], ephemeral: true });
      if (!giveaway.paused) return interaction.reply({ embeds: [errorEmbed('Pas en pause', 'Ce giveaway n\'est pas en pause.')], ephemeral: true });

      // Décale endAt du temps passé en pause
      const pausedMs    = Date.now() - new Date(giveaway.pausedAt).getTime();
      const newEndAt    = new Date(giveaway.endAt.getTime() + pausedMs);
      const totalPaused = (giveaway.pausedDuration || 0) + pausedMs;

      await Giveaway.updateOne({ _id: giveaway._id }, {
        paused: false, pausedAt: null, endAt: newEndAt,
        pausedDuration: totalPaused,
      });
      giveaway.paused    = false;
      giveaway.pausedAt  = null;
      giveaway.endAt     = newEndAt;

      // Reprogrammer le timer
      scheduleAt(newEndAt, () => {
        Giveaway.findById(giveaway._id).then(fresh => {
          if (fresh && !fresh.ended && !fresh.cancelled && !fresh.paused) endGiveaway(fresh, client).catch(console.error);
        });
      });

      await _refreshMessage(giveaway, client);
      return interaction.reply({
        embeds: [successEmbed('Giveaway repris !', `Le giveaway **${giveaway.prize}** reprend. Nouvelle fin : <t:${Math.floor(newEndAt.getTime() / 1000)}:R>.\n*(La pause a duré ${formatDuration(pausedMs)})*`)],
        ephemeral: true,
      });
    }

    // ── reroll ───────────────────────────────────────────────────────────
    if (sub === 'reroll') {
      const msgId    = interaction.options.getString('message_id');
      const count    = interaction.options.getInteger('gagnants') ?? null;
      const giveaway = await Giveaway.findOne({ messageId: msgId, guildId: guild.id });
      if (!giveaway)        return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });
      if (!giveaway.ended)  return interaction.reply({ embeds: [errorEmbed('En cours', 'Ce giveaway est encore en cours.')], ephemeral: true });
      if (giveaway.cancelled) return interaction.reply({ embeds: [errorEmbed('Annulé', 'Ce giveaway a été annulé.')], ephemeral: true });
      if (giveaway.participants.length === 0) return interaction.reply({ embeds: [errorEmbed('Aucun participant', 'Impossible de faire un reroll sans participants.')], ephemeral: true });

      const newCount  = count ?? giveaway.winners;
      const newWinners = drawWeightedWinners(giveaway.participants, newCount);

      await Giveaway.updateOne({ _id: giveaway._id }, {
        winnerIds: newWinners,
        $inc: { rerollCount: 1 },
      });
      giveaway.winnerIds   = newWinners;
      giveaway.rerollCount = (giveaway.rerollCount || 0) + 1;

      await _refreshMessage(giveaway, client);

      const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
      if (channel) {
        await channel.send({
          content: newWinners.map(id => `<@${id}>`).join(', '),
          embeds: [new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle('🔁 Nouveau tirage !')
            .setDescription(`Nouveau(x) gagnant(s) pour **${giveaway.prize}** :\n${newWinners.map(id => `<@${id}>`).join(', ')}`)
            .setFooter({ text: `Reroll n°${giveaway.rerollCount} • par ${interaction.user.tag}` })
            .setTimestamp()],
        }).catch(() => {});

        if (giveaway.dmWinners) {
          for (const wid of newWinners) {
            const user = await client.users.fetch(wid).catch(() => null);
            if (user) {
              await user.send({
                embeds: [new EmbedBuilder()
                  .setColor(COLORS.success)
                  .setTitle('🎉 Vous avez gagné (reroll) !')
                  .setDescription(`Vous avez gagné **${giveaway.prize}** sur **${guild.name}** suite à un reroll !\nContactez <@${giveaway.hostId}> pour récupérer votre lot.`)
                  .setTimestamp()],
              }).catch(() => {});
            }
          }
        }
      }

      return interaction.reply({
        embeds: [successEmbed('Reroll effectué !', `Nouveau(x) gagnant(s) : ${newWinners.map(id => `<@${id}>`).join(', ')}`)],
        ephemeral: true,
      });
    }

    // ── stats ─────────────────────────────────────────────────────────────
    if (sub === 'stats') {
      const msgId    = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOne({ messageId: msgId, guildId: guild.id });
      if (!giveaway) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });

      const entries   = totalEntries(giveaway);
      const duration  = giveaway.endAt.getTime() - giveaway.createdAt.getTime();
      const elapsed   = Math.min(Date.now() - giveaway.createdAt.getTime(), duration);
      const progress  = Math.round((elapsed / duration) * 100);
      const barFilled = Math.round(progress / 10);
      const bar       = '█'.repeat(barFilled) + '░'.repeat(10 - barFilled) + ` ${progress}%`;

      // Top 5 par entrées
      const top5 = [...giveaway.participants]
        .sort((a, b) => b.entries - a.entries)
        .slice(0, 5)
        .map((p, i) => `**${i + 1}.** <@${p.userId}> — ${p.entries} entrée(s)`);

      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`📊 Stats — ${giveaway.prize}`)
        .addFields(
          { name: '🏆 Gagnants prévus', value: `**${giveaway.winners}**`, inline: true },
          { name: '👥 Participants', value: `**${giveaway.participants.length}**`, inline: true },
          { name: '🎟️ Entrées totales', value: `**${entries}**`, inline: true },
          { name: '⏱️ Durée totale', value: formatDuration(duration), inline: true },
          { name: '📅 Créé le', value: `<t:${Math.floor(giveaway.createdAt.getTime() / 1000)}:f>`, inline: true },
          { name: '🏁 Fin le', value: `<t:${Math.floor(giveaway.endAt.getTime() / 1000)}:f>`, inline: true },
          { name: '📈 Progression', value: giveaway.ended ? '✅ Terminé' : `\`${bar}\``, inline: false },
        )
        .setFooter({ text: `ID: ${giveaway._id}` });

      if (giveaway.ended && giveaway.winnerIds.length > 0) {
        embed.addFields({
          name: '🎊 Gagnant(s)',
          value: giveaway.winnerIds.map(id => `<@${id}>`).join(', '),
          inline: false,
        });
      }
      if (giveaway.rerollCount > 0) {
        embed.addFields({ name: '🔁 Rerolls', value: `**${giveaway.rerollCount}**`, inline: true });
      }
      if (top5.length > 0) {
        embed.addFields({ name: '🥇 Top entrées', value: top5.join('\n'), inline: false });
      }
      if (giveaway.bonusRoles?.length) {
        embed.addFields({
          name: '⭐ Rôles bonus actifs',
          value: giveaway.bonusRoles.map(b => `<@&${b.roleId}> : +${b.entries}`).join('\n'),
          inline: false,
        });
      }

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── liste ─────────────────────────────────────────────────────────────
    if (sub === 'liste') {
      const actifs = await Giveaway.find({ guildId: guild.id, ended: false, cancelled: false })
        .sort({ endAt: 1 }).limit(10);

      if (actifs.length === 0) {
        return interaction.reply({ embeds: [errorEmbed('Aucun giveaway', 'Aucun giveaway en cours sur ce serveur.')], ephemeral: true });
      }

      const lines = actifs.map((g, i) =>
        `**${i + 1}.** 🎉 **${g.prize}** — ${g.participants.length} participant(s) — Fin <t:${Math.floor(g.endAt.getTime() / 1000)}:R>${g.paused ? ' *(en pause)*' : ''}`
      );

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(`🎉 Giveaways en cours — ${guild.name}`)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `${actifs.length} giveaway(s) actif(s)` })
          .setTimestamp()],
        ephemeral: true,
      });
    }

    // ── participants ──────────────────────────────────────────────────────
    if (sub === 'participants') {
      const msgId    = interaction.options.getString('message_id');
      const giveaway = await Giveaway.findOne({ messageId: msgId, guildId: guild.id });
      if (!giveaway) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });

      let page = 0;
      const { embed, totalPages } = buildParticipantsPage(giveaway, page);

      if (totalPages <= 1) return interaction.reply({ embeds: [embed], ephemeral: true });

      const reply = await interaction.reply({ embeds: [embed], components: [buildPaginationRow(page, totalPages)], ephemeral: true, fetchReply: true });
      const col   = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 5 * 60_000 });

      col.on('collect', async i => {
        const fresh = await Giveaway.findById(giveaway._id);
        if (i.customId === 'gw_page_first') page = 0;
        else if (i.customId === 'gw_page_prev')  page = Math.max(0, page - 1);
        else if (i.customId === 'gw_page_next')  page += 1;
        else if (i.customId === 'gw_page_last')  page = Infinity;
        const built = buildParticipantsPage(fresh, page);
        page = built.page;
        await i.update({ embeds: [built.embed], components: [buildPaginationRow(page, built.totalPages)] });
      });
      col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
    }
  },

  // ─── Bouton participer ────────────────────────────────────────────────────
  async handleJoin(interaction, giveawayId) {
    const giveaway = await Giveaway.findById(giveawayId);
    if (!giveaway || giveaway.ended || giveaway.cancelled) {
      return interaction.reply({ embeds: [errorEmbed('Giveaway terminé', 'Ce giveaway est terminé.')], ephemeral: true });
    }
    if (giveaway.paused) {
      return interaction.reply({ embeds: [errorEmbed('En pause', 'Ce giveaway est actuellement en pause. Revenez plus tard !')], ephemeral: true });
    }

    const userId = interaction.user.id;
    const member = interaction.member;

    // Vérification rôle blacklisté
    const allBlacklisted = [
      ...(giveaway.blacklistedRoles ?? []),
    ];
    for (const roleId of allBlacklisted) {
      if (member.roles.cache.has(roleId)) {
        return interaction.reply({ embeds: [errorEmbed('Interdit', `Ton rôle <@&${roleId}> t'empêche de participer à ce giveaway.`)], ephemeral: true });
      }
    }

    // Vérification rôle requis
    const requiredRoles = [
      ...(giveaway.requiredRoleId ? [giveaway.requiredRoleId] : []),
      ...(giveaway.allowedRoles ?? []),
    ];
    if (requiredRoles.length > 0) {
      const hasRole = requiredRoles.some(r => member.roles.cache.has(r));
      if (!hasRole) {
        const roleList = requiredRoles.map(r => `<@&${r}>`).join(' ou ');
        return interaction.reply({ embeds: [errorEmbed('Rôle requis', `Tu dois avoir l'un de ces rôles pour participer : ${roleList}`)], ephemeral: true });
      }
    }

    // Toggle participation
    const existingIdx = giveaway.participants.findIndex(p => p.userId === userId);
    if (existingIdx !== -1) {
      giveaway.participants.splice(existingIdx, 1);
      await giveaway.save();
      await interaction.update({ embeds: [buildGiveawayEmbed(giveaway)], components: buildGiveawayButtons(giveaway) });
      return interaction.followUp({ embeds: [successEmbed('Retiré', 'Tu as été retiré du giveaway. Clique à nouveau pour rejoindre.')], ephemeral: true });
    }

    // Vérification max participants
    if (giveaway.maxParticipants && giveaway.participants.length >= giveaway.maxParticipants) {
      return interaction.reply({ embeds: [errorEmbed('Complet', `Ce giveaway est complet (${giveaway.maxParticipants} places max).`)], ephemeral: true });
    }

    // Calcul des entrées
    let entries = 1;
    for (const bonus of giveaway.bonusRoles) {
      if (member.roles.cache.has(bonus.roleId)) entries += bonus.entries;
    }

    giveaway.participants.push({ userId, joinedAt: new Date(), entries });
    await giveaway.save();
    await interaction.update({ embeds: [buildGiveawayEmbed(giveaway)], components: buildGiveawayButtons(giveaway) });
    return interaction.followUp({
      embeds: [successEmbed('Inscrit !', `Tu participes au giveaway pour **${giveaway.prize}** ! 🎉${entries > 1 ? `\nGrâce à tes rôles, tu as **${entries} entrées** dans le tirage.` : ''}`)],
      ephemeral: true,
    });
  },

  // ─── Bouton "👥 Participants" sur le message public ───────────────────────
  async handleListButton(interaction, giveawayId) {
    const giveaway = await Giveaway.findById(giveawayId);
    if (!giveaway) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Ce giveaway n\'existe plus.')], ephemeral: true });

    let page = 0;
    const { embed, totalPages } = buildParticipantsPage(giveaway, page);
    if (totalPages <= 1) return interaction.reply({ embeds: [embed], ephemeral: true });

    const reply = await interaction.reply({ embeds: [embed], components: [buildPaginationRow(page, totalPages)], ephemeral: true, fetchReply: true });
    const col   = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 5 * 60_000 });

    col.on('collect', async i => {
      const fresh = await Giveaway.findById(giveawayId);
      if (!fresh) return;
      if (i.customId === 'gw_page_first')     page = 0;
      else if (i.customId === 'gw_page_prev') page = Math.max(0, page - 1);
      else if (i.customId === 'gw_page_next') page += 1;
      else if (i.customId === 'gw_page_last') page = Infinity;
      const built = buildParticipantsPage(fresh, page);
      page = built.page;
      await i.update({ embeds: [built.embed], components: [buildPaginationRow(page, built.totalPages)] });
    });
    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Bouton "ℹ️ Détails" ──────────────────────────────────────────────────
  async handleInfoButton(interaction, giveawayId) {
    const giveaway = await Giveaway.findById(giveawayId);
    if (!giveaway) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Ce giveaway n\'existe plus.')], ephemeral: true });

    const entries = totalEntries(giveaway);
    const existing = giveaway.participants.find(p => p.userId === interaction.user.id);

    const lines = [
      `🎁 **Prix** : ${giveaway.prize}`,
      giveaway.description ? `📝 **Description** : ${giveaway.description}` : null,
      `🏆 **Gagnants** : ${giveaway.winners}`,
      `👥 **Participants** : ${giveaway.participants.length}`,
      `🎟️ **Entrées totales** : ${entries}`,
      `⏰ **Fin** : <t:${Math.floor(giveaway.endAt.getTime() / 1000)}:R>`,
      giveaway.maxParticipants ? `🚪 **Places** : ${giveaway.participants.length}/${giveaway.maxParticipants}` : null,
      giveaway.bonusRoles?.length ? `⭐ **Bonus actifs** : ${giveaway.bonusRoles.map(b => `<@&${b.roleId}> +${b.entries}`).join(', ')}` : null,
      '\n**Votre statut :**',
      existing ? `✅ Inscrit avec **${existing.entries}** entrée(s)` : '❌ Non inscrit',
    ].filter(Boolean);

    return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLORS.primary).setTitle('ℹ️ Détails du giveaway').setDescription(lines.join('\n')).setTimestamp()], ephemeral: true });
  },

  // ─── Bouton "🔁 Reroll" sur le message public ─────────────────────────────
  async handleRerollButton(interaction, giveawayId) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Seuls les administrateurs peuvent faire un reroll.')], ephemeral: true });
    }
    const giveaway = await Giveaway.findById(giveawayId);
    if (!giveaway)         return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });
    if (!giveaway.ended)   return interaction.reply({ embeds: [errorEmbed('En cours', 'Ce giveaway est encore en cours.')], ephemeral: true });
    if (giveaway.cancelled) return interaction.reply({ embeds: [errorEmbed('Annulé', 'Ce giveaway a été annulé.')], ephemeral: true });
    if (giveaway.participants.length === 0) return interaction.reply({ embeds: [errorEmbed('Aucun participant', 'Pas de participants pour faire un reroll.')], ephemeral: true });

    const newWinners = drawWeightedWinners(giveaway.participants, giveaway.winners);
    await Giveaway.updateOne({ _id: giveaway._id }, { winnerIds: newWinners, $inc: { rerollCount: 1 } });
    giveaway.winnerIds   = newWinners;
    giveaway.rerollCount = (giveaway.rerollCount || 0) + 1;

    await interaction.update({ embeds: [buildGiveawayEmbed(giveaway)], components: buildGiveawayButtons(giveaway) });
    await interaction.followUp({
      content: newWinners.map(id => `<@${id}>`).join(', '),
      embeds: [new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('🔁 Nouveau tirage !')
        .setDescription(`${newWinners.map(id => `<@${id}>`).join(', ')} ${newWinners.length > 1 ? 'ont gagné' : 'a gagné'} **${giveaway.prize}** !`)
        .setFooter({ text: `Reroll n°${giveaway.rerollCount} par ${interaction.user.tag}` })
        .setTimestamp()],
    });
  },

  // ─── Bouton "🗑️ Annuler" sur le message public ───────────────────────────
  async handleCancelButton(interaction, giveawayId) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Seuls les administrateurs peuvent annuler un giveaway.')], ephemeral: true });
    }
    const giveaway = await Giveaway.findById(giveawayId);
    if (!giveaway)                      return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Giveaway introuvable.')], ephemeral: true });
    if (giveaway.ended || giveaway.cancelled) return interaction.reply({ embeds: [errorEmbed('Déjà terminé', 'Ce giveaway est déjà terminé.')], ephemeral: true });

    await Giveaway.updateOne({ _id: giveaway._id }, { cancelled: true, ended: true });
    giveaway.cancelled = true;
    giveaway.ended     = true;

    await interaction.update({ embeds: [buildGiveawayEmbed(giveaway)], components: buildGiveawayButtons(giveaway) });
    await interaction.followUp({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle('❌ Giveaway annulé')
        .setDescription(`Le giveaway pour **${giveaway.prize}** a été annulé par <@${interaction.user.id}>.`)
        .setTimestamp()],
    });
  },

  endGiveaway,
  rescheduleActiveGiveaways,
};

// ─── Utilitaire interne : rafraîchir le message Discord ───────────────────────
async function _refreshMessage(giveaway, client) {
  if (!giveaway.messageId) return;
  try {
    const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
    if (!channel) return;
    const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (!msg) return;
    const fresh = await Giveaway.findById(giveaway._id);
    if (!fresh) return;
    await msg.edit({ embeds: [buildGiveawayEmbed(fresh)], components: buildGiveawayButtons(fresh) });
  } catch (err) {
    console.error('_refreshMessage giveaway:', err.message);
  }
}
