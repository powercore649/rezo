'use strict';
// commands/invites-avance.js — Système d'invitations avancé.
//
// /invites voir      → carte PNG + embed détaillé (rang, progression, source)
// /invites classement → podium paginé avec boutons (aucune commande en plus)
// /invites invites-par → liste des membres invités
// /invites bonus     → ajustement manuel (staff)
// /invites creer     → création d'une invitation suivie (usages/expiration)
const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, AttachmentBuilder,
} = require('discord.js');
const InviteUse = require('../../models/InviteUse');
const InviteConfig = require('../../models/InviteConfig');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');
const { renderInviteCardSafe, INVITE_CARD_FILENAME } = require('../../utils/inviteCard');
const {
  computeInviteStats, getInviteRank, getInviteLeaderboard,
  progressToMilestone, formatRank,
} = require('../../utils/inviteEngine');

const MEDALS = ['🥇', '🥈', '🥉'];
const PAGE_SIZE = 10;
const COLLECTOR_MS = 3 * 60 * 1000;

function leaderboardEmbed({ guildName, data, userId }) {
  const lines = data.rows.map((row, index) => {
    const rank = (data.page - 1) * PAGE_SIZE + index + 1;
    const medal = MEDALS[rank - 1] || `**#${rank}**`;
    return `${medal} <@${row.inviterId}> — **${row.total}** invitation(s)`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🏆 Classement des invitations — ${guildName}`)
    .setDescription(lines.join('\n') || '*Aucune invitation active pour le moment.*')
    .setFooter({
      text: `Page ${data.page}/${data.totalPages} · ${data.total} inviteur(s) · demandé par ${userId ? 'toi' : 'REZO'}`,
    })
    .setTimestamp();
}

function leaderboardComponents(data) {
  if (data.totalPages <= 1) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`invlb_prev_${Math.max(1, data.page - 1)}`)
      .setLabel('◀ Précédent')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(data.page <= 1),
    new ButtonBuilder()
      .setCustomId(`invlb_next_${Math.min(data.totalPages, data.page + 1)}`)
      .setLabel('Suivant ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(data.page >= data.totalPages),
  )];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invites')
    .setDescription('🔗 Statistiques avancées du système d\'invitations')
    .addSubcommand(s => s.setName('voir')
      .setDescription('Voir la carte d\'invitations d\'un membre')
      .addUserOption(o => o.setName('membre').setDescription('Membre à consulter (par défaut: vous)'))
      .addBooleanOption(o => o.setName('carte').setDescription('Afficher la carte PNG (par défaut: oui)')))
    .addSubcommand(s => s.setName('classement')
      .setDescription('Voir le classement des meilleurs inviteurs du serveur')
      .addIntegerOption(o => o.setName('page').setDescription('Numéro de page').setMinValue(1)))
    .addSubcommand(s => s.setName('invites-par')
      .setDescription('Lister les membres invités par une personne précise')
      .addUserOption(o => o.setName('membre').setDescription('L\'inviteur').setRequired(true)))
    .addSubcommand(s => s.setName('bonus')
      .setDescription('Ajouter/retirer manuellement des invitations bonus à un membre')
      .addUserOption(o => o.setName('membre').setDescription('Membre concerné').setRequired(true))
      .addIntegerOption(o => o.setName('montant').setDescription('Nombre à ajouter (négatif pour retirer)').setRequired(true)))
    .addSubcommand(s => s.setName('creer')
      .setDescription('Créer une invitation suivie (usages limités, expiration)')
      .addIntegerOption(o => o.setName('usages').setDescription('Nombre maximum d\'utilisations (0 = illimité)').setMinValue(0).setMaxValue(100))
      .addIntegerOption(o => o.setName('expiration').setDescription('Expiration en heures (0 = jamais)').setMinValue(0).setMaxValue(168))
      .addBooleanOption(o => o.setName('unique').setDescription('Un seul membre peut l\'utiliser (usage unique)'))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const guild = interaction.guild;

    if (sub === 'voir') {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser('membre') || interaction.user;
      const targetMember = interaction.options.getMember('membre') || (targetUser.id === interaction.user.id ? interaction.member : null);
      const showCard = interaction.options.getBoolean('carte') ?? true;

      const [stats, cfg, ownRecord] = await Promise.all([
        computeInviteStats(guildId, targetUser.id),
        InviteConfig.findOne({ guildId }).lean().catch(() => null),
        InviteUse.findOne({ guildId, userId: targetUser.id }).sort({ joinedAt: -1 }),
      ]);
      const rank = await getInviteRank(guildId, targetUser.id, stats.active);

      const displayName = targetMember?.displayName || targetUser.username;
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setAuthor({ name: `Invitations de ${displayName}`, iconURL: targetUser.displayAvatarURL({ size: 128 }) })
        .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: '✅ Invitations actives', value: `**${stats.active}**`, inline: true },
          { name: '🏅 Rang', value: `**${formatRank(rank)}**`, inline: true },
          { name: '📥 Total invités', value: `${stats.joins}`, inline: true },
          { name: '📤 Repartis', value: `${stats.leaves}`, inline: true },
          { name: '⚠️ Fake (compte trop récent)', value: `${stats.fakes}`, inline: true },
          { name: '🪙 Récompense / invitation', value: cfg?.rewardCoins > 0 ? `${cfg.rewardCoins} coins` : '*Désactivée*', inline: true },
        )
        .setFooter({ text: 'REZO • Invitations' })
        .setTimestamp();

      const progress = progressToMilestone(stats.active, cfg?.milestoneStep || 0);
      if (progress) {
        embed.addFields({
          name: '🏆 Prochain palier',
          value: `**${stats.active} / ${progress.next}** — encore **${progress.remaining}** invitation(s)`,
        });
      }

      if (ownRecord) {
        embed.addFields({
          name: '🎟️ Invité par',
          value: ownRecord.inviterId
            ? `<@${ownRecord.inviterId}> (\`${ownRecord.code || 'inconnu'}\`)`
            : 'Inconnu',
          inline: false,
        });
      }

      const card = showCard
        ? await renderInviteCardSafe({
          member: targetMember || targetUser,
          guild,
          stats,
          rank,
          caption: `${guild.name} · ${stats.active} invitation(s) active(s)`,
        })
        : null;
      if (card) embed.setImage(`attachment://${INVITE_CARD_FILENAME}`);

      return interaction.editReply({
        embeds: [embed],
        files: card ? [new AttachmentBuilder(card, { name: INVITE_CARD_FILENAME })] : [],
      });
    }

    if (sub === 'classement') {
      await interaction.deferReply();
      const requested = interaction.options.getInteger('page') || 1;
      const data = await getInviteLeaderboard(guildId, requested, PAGE_SIZE);

      if (!data.total) {
        return interaction.editReply({ embeds: [errorEmbed('Aucune donnée', 'Aucune invitation n\'a encore été trackée sur ce serveur.')] });
      }

      const embed = leaderboardEmbed({ guildName: guild.name, data, userId: interaction.user.id });
      const ownRank = await getInviteRank(guildId, interaction.user.id);
      if (ownRank) embed.addFields({ name: '📍 Ta position', value: `**${formatRank(ownRank)}**`, inline: true });

      const message = await interaction.editReply({
        embeds: [embed],
        components: leaderboardComponents(data),
        fetchReply: true,
      });

      if (data.totalPages <= 1) return message;

      const collector = message.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith('invlb_'),
        time: COLLECTOR_MS,
      });

      collector.on('collect', async (i) => {
        const page = Number(i.customId.split('_').pop()) || 1;
        const next = await getInviteLeaderboard(guildId, page, PAGE_SIZE);
        const nextEmbed = leaderboardEmbed({ guildName: guild.name, data: next, userId: i.user.id });
        const nextOwnRank = await getInviteRank(guildId, i.user.id);
        if (nextOwnRank) nextEmbed.addFields({ name: '📍 Ta position', value: `**${formatRank(nextOwnRank)}**`, inline: true });
        await i.update({ embeds: [nextEmbed], components: leaderboardComponents(next) });
      });

      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return message;
    }

    if (sub === 'invites-par') {
      await interaction.deferReply();
      const target = interaction.options.getUser('membre');
      const records = await InviteUse.find({ guildId, inviterId: target.id }).sort({ joinedAt: -1 }).limit(25);

      if (!records.length) {
        return interaction.editReply({ embeds: [errorEmbed('Aucune invitation', `${target.tag} n'a invité personne pour le moment.`)] });
      }

      const lines = records.map((r) => {
        const status = r.fake ? '⚠️ fake' : r.left ? '📤 reparti' : '✅ actif';
        return `<@${r.userId}> — ${status} — <t:${Math.floor(new Date(r.joinedAt).getTime() / 1000)}:R>`;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`🔗 Invitations de ${target.tag}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: records.length === 25 ? '25 dernières invitations affichées' : `${records.length} invitation(s) au total` })
        .setThumbnail(target.displayAvatarURL())
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'bonus') {
      // Vérification manuelle de permission (setDefaultMemberPermissions ne s'applique pas
      // au niveau sous-commande ; pattern déjà utilisé ailleurs dans le bot)
      if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Vous devez avoir la permission **Gérer le serveur** pour utiliser cette commande.')], ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const target = interaction.options.getUser('membre');
      const montant = interaction.options.getInteger('montant');

      // Les invitations bonus sont représentées par des entrées InviteUse synthétiques
      // (inviterId = target, userId = un identifiant unique fictif, method = 'unknown', code = 'BONUS')
      // afin de s'intégrer nativement au comptage/classement existant.
      let removedBonus = 0;
      let missing = 0;

      if (montant > 0) {
        const docs = Array.from({ length: montant }, (_, i) => ({
          guildId,
          userId: `bonus-${target.id}-${Date.now()}-${i}`,
          userTag: 'Bonus manuel',
          inviterId: target.id,
          inviterTag: target.tag,
          code: 'BONUS',
          method: 'unknown',
          fake: false,
          left: false,
        }));
        await InviteUse.insertMany(docs);
      } else if (montant < 0) {
        const wanted = Math.abs(montant);
        // Seuls les bonus sont retirés, et les plus anciens d'abord : avant, la
        // commande supprimait les invitations les plus récentes sans distinguer
        // un bonus d'une vraie invitation, donc un retrait de bonus pouvait
        // effacer en silence une invitation gagnée sur le terrain.
        const bonusDocs = await InviteUse.find({
          guildId, inviterId: target.id, code: 'BONUS', left: false,
        }).sort({ joinedAt: 1 }).limit(wanted);

        if (bonusDocs.length) {
          await InviteUse.deleteMany({ _id: { $in: bonusDocs.map(d => d._id) } });
          removedBonus = bonusDocs.length;
        }
        missing = wanted - removedBonus;
      }

      const stats = await computeInviteStats(guildId, target.id);
      const details = [];
      if (montant > 0) details.push(`➕ **${montant}** invitation(s) bonus ajoutée(s).`);
      if (removedBonus) details.push(`➖ **${removedBonus}** bonus retiré(s).`);
      if (missing > 0) {
        details.push(`⚠️ **${missing}** retrait(s) ignoré(s) : il ne reste que de vraies invitations, et cette commande ne retire que les bonus.`);
      }

      return interaction.editReply({
        embeds: [successEmbed('Bonus appliqué', `${details.join('\n') || 'Aucun changement.'}\n\n${target} a maintenant **${stats.active}** invitation(s) active(s).`)],
      });
    }

    if (sub === 'creer') {
      if (!interaction.member?.permissions?.has(PermissionFlagsBits.CreateInstantInvite)) {
        return interaction.reply({
          embeds: [errorEmbed('Permission refusée', 'Vous devez avoir la permission **Créer une invitation** pour utiliser cette commande.')],
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });
      const maxUses = interaction.options.getInteger('usages') ?? 0;
      const hours = interaction.options.getInteger('expiration') ?? 0;
      const unique = interaction.options.getBoolean('unique') ?? false;

      try {
        const invite = await guild.invites.create(interaction.channel, {
          maxUses,
          maxAge: hours * 3600,
          unique,
          reason: `Invitation créée par ${interaction.user.tag}`,
        });

        const embed = new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('🔗 Invitation créée')
          .setDescription(`**${invite.url || `https://discord.gg/${invite.code}`}**\nPartagez ce lien : chaque arrivée sera attribuée automatiquement à vous.`)
          .addFields(
            { name: '🎯 Usages', value: maxUses > 0 ? `${maxUses}` : 'Illimités', inline: true },
            { name: '⏳ Expiration', value: hours > 0 ? `<t:${Math.floor(Date.now() / 1000) + hours * 3600}:R>` : 'Jamais', inline: true },
            { name: '1️⃣ Usage unique', value: unique ? '✅ Oui' : '❌ Non', inline: true },
          )
          .setFooter({ text: 'REZO • Invitation suivie' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({
          embeds: [errorEmbed('Création impossible', `Discord a refusé la création : ${err.message}`)],
        });
      }
    }
  },
};
