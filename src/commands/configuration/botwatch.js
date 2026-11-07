// commands/botwatch.js — Panel interactif complet pour /botwatch :
// boutons, menus déroulants (choix de bot/salon), modale pour la raison de
// maintenance. Tout est géré par un collector LOCAL attaché à ce message
// précis — aucune dépendance à interactionCreate.js, donc aucun risque pour
// le reste du bot.
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  UserSelectMenuBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const Server = require('../../models/Server');
const WatchedBot = require('../../models/WatchedBot');
const { COLORS } = require('../../utils/embeds');
const { formatDuration } = require('../../utils/formatDuration');

const STATUS_LABELS = {
  online: '🟢 En ligne', idle: '🌙 Absent', dnd: '⛔ Ne pas déranger',
  offline: '🔴 Hors ligne', unknown: '⚪ Inconnu',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botwatch')
    .setDescription('🤖 Panel interactif de configuration de la surveillance de bots')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const guildId = interaction.guild.id;
    let screen = 'main';       // 'main' | 'add' | 'list' | 'detail' | 'channel'
    let selectedBotId = null;

    // ── Construction des écrans ────────────────────────────────────────
    async function buildMainScreen() {
      const server = await Server.findOne({ guildId }).lean();
      const count = await WatchedBot.countDocuments({ guildId });

      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('🤖 Panel — Surveillance de bots')
        .addFields(
          { name: 'Salon par défaut', value: server?.botWatchChannelId ? `<#${server.botWatchChannelId}>` : '*Non défini*', inline: true },
          { name: 'Bots surveillés', value: `${count}`, inline: true },
        )
        .setFooter({ text: 'Ce panel expire après 10 minutes d\'inactivité' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bwp_add').setLabel('➕ Ajouter un bot').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bwp_list').setLabel('📋 Gérer les bots').setStyle(ButtonStyle.Primary).setDisabled(count === 0),
        new ButtonBuilder().setCustomId('bwp_channel').setLabel('📍 Salon par défaut').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('bwp_close').setLabel('✖ Fermer').setStyle(ButtonStyle.Danger),
      );
      return { embeds: [embed], components: [row] };
    }

    function buildAddScreen() {
      const embed = new EmbedBuilder().setColor(COLORS.primary).setTitle('➕ Ajouter un bot').setDescription('Sélectionne le bot à surveiller ci-dessous.');
      const row1 = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('bwp_add_select').setPlaceholder('Choisir un bot…'),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bwp_back').setLabel('⬅ Retour').setStyle(ButtonStyle.Secondary),
      );
      return { embeds: [embed], components: [row1, row2] };
    }

    async function buildListScreen() {
      const bots = await WatchedBot.find({ guildId }).lean();
      const embed = new EmbedBuilder().setColor(COLORS.primary).setTitle('📋 Gérer les bots surveillés')
        .setDescription(bots.length ? 'Sélectionne un bot pour voir le détail et les actions.' : 'Aucun bot surveillé.');

      const components = [];
      if (bots.length > 0) {
        components.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('bwp_detail_select').setPlaceholder('Choisir un bot…')
            .addOptions(bots.slice(0, 25).map((b) => ({
              label: (b.botTag || b.botId).slice(0, 90),
              value: b.botId,
              description: b.maintenance ? '🛠️ En maintenance' : (STATUS_LABELS[b.lastStatus] || STATUS_LABELS.unknown),
            }))),
        ));
      }
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bwp_back').setLabel('⬅ Retour').setStyle(ButtonStyle.Secondary),
      ));
      return { embeds: [embed], components };
    }

    async function buildDetailScreen(botId) {
      const bot = await WatchedBot.findOne({ guildId, botId }).lean();
      if (!bot) return buildListScreen();

      const sinceText = formatDuration(Date.now() - new Date(bot.lastStatusChangeAt || bot.createdAt).getTime());
      const embed = new EmbedBuilder().setColor(COLORS.primary).setTitle(`🤖 ${bot.botTag || bot.botId}`)
        .addFields(
          { name: 'Statut', value: bot.maintenance ? '🛠️ En maintenance' : (STATUS_LABELS[bot.lastStatus] || STATUS_LABELS.unknown), inline: true },
          { name: 'Depuis', value: bot.maintenance ? formatDuration(Date.now() - new Date(bot.maintenanceSince || bot.updatedAt).getTime()) : sinceText, inline: true },
          { name: 'Salon d\'annonce', value: bot.channelId ? `<#${bot.channelId}>` : '*Salon par défaut*', inline: true },
        );
      if (bot.maintenance && bot.maintenanceReason) embed.addFields({ name: 'Raison', value: bot.maintenanceReason });

      const row1 = new ActionRowBuilder().addComponents(
        bot.maintenance
          ? new ButtonBuilder().setCustomId('bwp_maint_off').setLabel('✅ Retirer la maintenance').setStyle(ButtonStyle.Success)
          : new ButtonBuilder().setCustomId('bwp_maint_on').setLabel('🛠️ Passer en maintenance').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('bwp_remove').setLabel('🗑️ Retirer de la surveillance').setStyle(ButtonStyle.Danger),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId('bwp_bot_channel').setPlaceholder('Changer le salon spécifique de ce bot…').addChannelTypes(ChannelType.GuildText),
      );
      const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bwp_list').setLabel('⬅ Retour à la liste').setStyle(ButtonStyle.Secondary),
      );
      return { embeds: [embed], components: [row1, row2, row3] };
    }

    function buildChannelScreen() {
      const embed = new EmbedBuilder().setColor(COLORS.primary).setTitle('📍 Salon d\'annonce par défaut').setDescription('Sélectionne le salon où seront postées les annonces de statut par défaut.');
      const row1 = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId('bwp_channel_select').setPlaceholder('Choisir un salon…').addChannelTypes(ChannelType.GuildText),
      );
      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bwp_back').setLabel('⬅ Retour').setStyle(ButtonStyle.Secondary),
      );
      return { embeds: [embed], components: [row1, row2] };
    }

    // ── Affichage initial ────────────────────────────────────────────────
    const reply = await interaction.reply({ ...(await buildMainScreen()), ephemeral: true, fetchReply: true });

    const collector = reply.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id,
      time: 600000, // 10 minutes
    });

    collector.on('collect', async (i) => {
      try {
        const id = i.customId;

        if (id === 'bwp_close') {
          await i.update({ content: '👋 Panel fermé.', embeds: [], components: [] });
          collector.stop();
          return;
        }
        if (id === 'bwp_add') { screen = 'add'; return i.update(buildAddScreen()); }
        if (id === 'bwp_list') { screen = 'list'; return i.update(await buildListScreen()); }
        if (id === 'bwp_channel') { screen = 'channel'; return i.update(buildChannelScreen()); }
        if (id === 'bwp_back') { screen = 'main'; return i.update(await buildMainScreen()); }

        if (id === 'bwp_add_select') {
          const bot = i.users.first();
          if (!bot.bot) {
            return i.reply({ content: '⚠️ Ce n\'est pas un compte bot.', ephemeral: true });
          }
          const member = await interaction.guild.members.fetch(bot.id).catch(() => null);
          const initialStatus = member?.presence?.status || 'unknown';
          await WatchedBot.findOneAndUpdate(
            { guildId, botId: bot.id },
            { botTag: bot.username, lastStatus: initialStatus, lastStatusChangeAt: new Date() },
            { upsert: true }
          );
          screen = 'list';
          return i.update(await buildListScreen());
        }

        if (id === 'bwp_channel_select') {
          const channel = i.channels.first();
          let server = await Server.findOne({ guildId });
          if (!server) server = await Server.create({ guildId, guildName: interaction.guild.name });
          server.botWatchChannelId = channel.id;
          await server.save();
          screen = 'main';
          return i.update(await buildMainScreen());
        }

        if (id === 'bwp_detail_select') {
          selectedBotId = i.values[0];
          screen = 'detail';
          return i.update(await buildDetailScreen(selectedBotId));
        }

        if (id === 'bwp_bot_channel') {
          const channel = i.channels.first();
          await WatchedBot.updateOne({ guildId, botId: selectedBotId }, { channelId: channel.id });
          return i.update(await buildDetailScreen(selectedBotId));
        }

        if (id === 'bwp_remove') {
          await WatchedBot.deleteOne({ guildId, botId: selectedBotId });
          selectedBotId = null;
          screen = 'list';
          return i.update(await buildListScreen());
        }

        if (id === 'bwp_maint_off') {
          await WatchedBot.updateOne(
            { guildId, botId: selectedBotId },
            { maintenance: false, maintenanceReason: '', maintenanceSince: null, maintenanceBy: null, lastStatusChangeAt: new Date() }
          );
          return i.update(await buildDetailScreen(selectedBotId));
        }

        if (id === 'bwp_maint_on') {
          const modal = new ModalBuilder().setCustomId('bwp_maint_modal').setTitle('Passer en maintenance');
          const reasonInput = new TextInputBuilder()
            .setCustomId('bwp_maint_reason')
            .setLabel('Raison (optionnel)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(200);
          modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
          await i.showModal(modal);

          const modalSubmit = await i.awaitModalSubmit({
            filter: (m) => m.customId === 'bwp_maint_modal' && m.user.id === interaction.user.id,
            time: 120000,
          }).catch(() => null);
          if (!modalSubmit) return;

          const raison = modalSubmit.fields.getTextInputValue('bwp_maint_reason') || '';
          await WatchedBot.updateOne(
            { guildId, botId: selectedBotId },
            { maintenance: true, maintenanceReason: raison, maintenanceSince: new Date(), maintenanceBy: interaction.user.id }
          );

          if (modalSubmit.isFromMessage()) {
            await modalSubmit.update(await buildDetailScreen(selectedBotId));
          } else {
            await modalSubmit.reply({ content: '✅ Maintenance activée.', ephemeral: true });
          }
          return;
        }
      } catch (err) {
        console.error('❌ botwatch a échoué:', err);
        await i.reply({ content: '⚠️ Une erreur est survenue.', ephemeral: true }).catch(() => {});
      }
    });

    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
  },
};
