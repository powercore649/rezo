'use strict';
// commands/communaute/event.js — 🎉 Événements communautaires.
//
// Créer un événement, le publier avec un bouton « Participer », lister les
// prochains et gérer les inscriptions. Le bouton est routé par
// events/core/interactionCreate (event_join_<id>) : il reste cliquable même
// après un redémarrage du bot.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, MessageFlags,
} = require('discord.js');

const Event = require('../../models/Event');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

const MAX_PARTICIPANTS_SHOWN = 30;

// ── Helpers purs (testables hors-ligne) ─────────────────────────────────────
// Accepte « JJ/MM », « JJ/MM/AAAA », « JJ/MM/AAAA HH:MM », « JJ/MM HH:MM » et
// toute date ISO comprise par Date. Sans année, on prend l'année courante, puis
// l'année suivante si la date est déjà passée. Heure par défaut : 20:00.
function parseEventDate(raw, now = new Date()) {
  const v = String(raw || '').trim();
  if (!v) return { date: null, error: 'Date manquante.' };

  const m = v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const hh = m[4] !== undefined ? parseInt(m[4], 10) : 20;
    const mi = m[5] !== undefined ? parseInt(m[5], 10) : 0;
    const year = m[3] ? parseInt(m[3], 10) : now.getFullYear();

    let date = new Date(year, month, day, hh, mi, 0);
    if (Number.isNaN(date.getTime()) || date.getDate() !== day || date.getMonth() !== month || hh > 23 || mi > 59) {
      return { date: null, error: 'Date invalide.' };
    }
    if (!m[3] && date.getTime() < now.getTime()) {
      date = new Date(year + 1, month, day, hh, mi, 0);
    }
    return { date, error: null };
  }

  const iso = new Date(v);
  if (!Number.isNaN(iso.getTime())) return { date: iso, error: null };

  return { date: null, error: 'Format attendu : `JJ/MM`, `JJ/MM/AAAA` ou `JJ/MM/AAAA HH:MM`.' };
}

function participantLine(event) {
  const list = event.participants || [];
  if (!list.length) return '*Personne pour le moment — sois le premier !*';
  return list.slice(0, MAX_PARTICIPANTS_SHOWN).map(id => `<@${id}>`).join(', ') +
    (list.length > MAX_PARTICIPANTS_SHOWN ? ` *+${list.length - MAX_PARTICIPANTS_SHOWN} autre(s)*` : '');
}

function buildEventEmbed(event) {
  const ts = Math.floor(new Date(event.date).getTime() / 1000);
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`🎉 ${event.name}`)
    .setDescription(event.description || '*Aucune description.*')
    .addFields(
      { name: '📅 Quand', value: `<t:${ts}:F>\n(<t:${ts}:R>)`, inline: true },
      { name: '👥 Participants', value: `${(event.participants || []).length}`, inline: true },
      { name: '🧑‍💼 Organisé par', value: `<@${event.createdBy}>`, inline: true },
      { name: '🙋 Inscrits', value: participantLine(event).slice(0, 1024) },
    )
    .setFooter({ text: 'REZO • Événement' })
    .setTimestamp();
}

function joinRow(eventId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`event_join_${eventId}`)
      .setLabel('Participer').setEmoji('🙋').setStyle(ButtonStyle.Success),
  );
}

// ── Inscription (bouton public + sous-commande) ─────────────────────────────
async function registerParticipant(interaction, event) {
  const list = event.participants || [];

  if (list.includes(interaction.user.id)) {
    const payload = { content: '✅ Tu participes déjà à cet événement.', flags: MessageFlags.Ephemeral };
    return interaction.isMessageComponent?.() && !interaction.deferred
      ? interaction.reply(payload).catch(() => {})
      : (interaction.deferred ? interaction.editReply(payload) : interaction.reply(payload)).catch(() => {});
  }

  event.participants = [...list, interaction.user.id];
  await event.save();

  if (interaction.isMessageComponent?.()) {
    await interaction.update({ embeds: [buildEventEmbed(event)], components: [joinRow(event._id)] }).catch(() => {});
    return interaction.followUp({ content: '🎉 Inscription enregistrée !', flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  return interaction.editReply({ embeds: [buildEventEmbed(event)] });
}

async function handleJoin(interaction, eventId) {
  const event = await Event.findById(eventId).catch(() => null);
  if (!event || event.guildId !== interaction.guildId) {
    const payload = { embeds: [errorEmbed('Événement introuvable', 'Cet événement n\'existe plus.')], flags: MessageFlags.Ephemeral };
    return interaction?.reply ? interaction.reply(payload).catch(() => {}) : undefined;
  }
  return registerParticipant(interaction, event);
}

// ── Commande ────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('🎉 Organiser et gérer des événements communautaires')
    .addSubcommand(s => s
      .setName('creer')
      .setDescription('Créer et publier un nouvel événement')
      .addStringOption(o => o.setName('nom').setDescription('Nom de l\'événement').setRequired(true).setMaxLength(100))
      .addStringOption(o => o.setName('date').setDescription('Date : JJ/MM, JJ/MM/AAAA ou JJ/MM/AAAA HH:MM').setRequired(true).setMaxLength(20))
      .addStringOption(o => o.setName('description').setDescription('Détails de l\'événement').setMaxLength(1000))
      .addChannelOption(o => o
        .setName('salon').setDescription('Salon où publier (actuel par défaut)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(s => s.setName('liste').setDescription('Voir les prochains événements du serveur'))
    .addSubcommand(s => s
      .setName('participer')
      .setDescription('S\'inscrire à un événement')
      .addStringOption(o => o.setName('id').setDescription('Identifiant de l\'événement (voir /event liste)').setRequired(true).setMaxLength(30)))
    .addSubcommand(s => s
      .setName('supprimer')
      .setDescription('Supprimer un événement (organisateur ou Gérer le serveur)')
      .addStringOption(o => o.setName('id').setDescription('Identifiant de l\'événement').setRequired(true).setMaxLength(30))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── Créer ──────────────────────────────────────────────────────────────
    if (sub === 'creer') {
      const name = interaction.options.getString('nom').trim();
      const rawDate = interaction.options.getString('date');
      const description = interaction.options.getString('description') || '';
      const channel = interaction.options.getChannel('salon') || interaction.channel;

      const { date, error } = parseEventDate(rawDate);
      if (error) {
        return interaction.reply({ embeds: [errorEmbed('Date invalide', error)], flags: MessageFlags.Ephemeral });
      }

      if (!channel?.isTextBased?.()) {
        return interaction.reply({ embeds: [errorEmbed('Salon invalide', 'Choisis un salon textuel.')], flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ ephemeral: true });

      const event = await Event.create({
        guildId: interaction.guildId,
        name,
        description,
        date,
        createdBy: interaction.user.id,
        channelId: channel.id,
      });

      const message = await channel.send({
        embeds: [buildEventEmbed(event)],
        components: [joinRow(event.id)],
      }).catch(() => null);

      if (!message) {
        await Event.deleteOne({ _id: event._id }).catch(() => {});
        return interaction.editReply({
          embeds: [errorEmbed('Publication impossible', 'Je n\'ai pas pu écrire dans ce salon (permissions manquantes ?).')],
        });
      }

      // ── Centre de notifications — abonnés « Événements » ───────────────
      // Le type était proposé dans les abonnements sans qu'aucun événement
      // ne l'alimente.
      try {
        const { sendNotification } = require('../../utils/notificationManager');
        const ts = Math.floor(new Date(event.date).getTime() / 1000);
        await sendNotification(
          interaction.client,
          interaction.guildId,
          'events',
          new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle('📅 Nouvel événement !')
            .setDescription(
              `**${event.name}** — <t:${ts}:R>\n`
              + `${description || 'Aucune description.'}\n\`${event.id}\``,
            )
            .setTimestamp(),
          `Nouvel événement : ${event.name}`,
        );
      } catch (err) { console.error('event notif:', err.message); }

      return interaction.editReply({
        embeds: [successEmbed('Événement créé !', `**${name}** est publié dans <#${channel.id}>.\nLes membres peuvent s'inscrire avec le bouton **🙋 Participer**.`)],
      });
    }

    // ── Lister ─────────────────────────────────────────────────────────────
    if (sub === 'liste') {
      await interaction.deferReply();
      const events = await Event.find({ guildId: interaction.guildId, date: { $gte: new Date() } })
        .sort({ date: 1 })
        .limit(10);

      if (!events.length) {
        return interaction.editReply({ embeds: [errorEmbed('Aucun événement', 'Aucun événement à venir. Crée-en un avec `/event creer` !')] });
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('📅 Prochains événements')
        .setDescription(events.map(e => {
          const ts = Math.floor(new Date(e.date).getTime() / 1000);
          return `**${e.name}** — <t:${ts}:R> (<t:${ts}:f>)\n\`${e.id}\` • 👥 ${(e.participants || []).length} inscrit(s)`;
        }).join('\n\n').slice(0, 4000))
        .setFooter({ text: 'REZO • Événements' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── Participer ─────────────────────────────────────────────────────────
    if (sub === 'participer') {
      await interaction.deferReply({ ephemeral: true });
      const event = await Event.findById(interaction.options.getString('id')).catch(() => null);
      if (!event || event.guildId !== interaction.guildId) {
        return interaction.editReply({ embeds: [errorEmbed('Événement introuvable', 'Vérifie l\'identifiant avec `/event liste`.')] });
      }
      return registerParticipant(interaction, event);
    }

    // ── Supprimer ──────────────────────────────────────────────────────────
    if (sub === 'supprimer') {
      await interaction.deferReply({ ephemeral: true });
      const event = await Event.findById(interaction.options.getString('id')).catch(() => null);
      if (!event || event.guildId !== interaction.guildId) {
        return interaction.editReply({ embeds: [errorEmbed('Événement introuvable', 'Vérifie l\'identifiant avec `/event liste`.')] });
      }

      const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      if (event.createdBy !== interaction.user.id && !canManage) {
        return interaction.editReply({ embeds: [errorEmbed('Refusé', 'Seul l\'organisateur ou un membre avec **Gérer les événements** peut supprimer cet événement.')] });
      }

      await Event.deleteOne({ _id: event._id });
      return interaction.editReply({ embeds: [successEmbed('Événement supprimé', `**${event.name}** a été supprimé.`)] });
    }
  },

  handleJoin,

  __testables: { parseEventDate, buildEventEmbed, participantLine, joinRow },
};
