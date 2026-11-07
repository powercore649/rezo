'use strict';
// commands/demande-mp.js — Panel de configuration du système "Demande de MP"
// Le message original d'un membre posté dans le salon configuré est supprimé et
// remplacé par un embed (avatar + contenu) avec un fil, pour que le demandeur et
// la personne intéressée puissent discuter proprement.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, ChannelType,
} = require('discord.js');

const MpRequestConfig = require('../../models/MpRequestConfig');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

const COLLECTOR_TIMEOUT_MS = 10 * 60 * 1000;

async function getOrCreateConfig(guildId) {
  let cfg = await MpRequestConfig.findOne({ guildId });
  if (!cfg) cfg = await MpRequestConfig.create({ guildId });
  return cfg;
}

function renderPanel(cfg) {
  const embed = new EmbedBuilder()
    .setColor(parseInt(cfg.embedColor, 16) || COLORS.primary)
    .setTitle('💌 Panel — Demande de MP')
    .setDescription(
      'Dans le salon configuré, un membre doit **mentionner** la personne avec qui il souhaite ' +
      'entrer en communication. Son message est supprimé et remplacé par un embed avec boutons ' +
      '✅ Accepter / ❌ Refuser, réservés à la personne mentionnée. Le fil n\'est créé qu\'en cas d\'acceptation.'
    )
    .addFields(
      { name: '📢 Statut', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '📝 Salon surveillé', value: cfg.channelId ? `<#${cfg.channelId}>` : '*Non défini*', inline: true },
      { name: '📊 Demandes traitées', value: `${cfg.totalRequests}`, inline: true },
      { name: '🎨 Couleur', value: `#${cfg.embedColor}`, inline: true },
      { name: '🗂️ Nom du fil', value: `\`${cfg.threadNameTemplate}\``, inline: true },
      { name: '🕐 Archivage auto', value: `${cfg.autoArchiveMinutes} min`, inline: true },
    )
    .setFooter({ text: 'REZO • Demande de MP' })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('mpreq_channel').setPlaceholder('📝 Choisir le salon à surveiller...').addChannelTypes(ChannelType.GuildText),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mpreq_toggle').setLabel(cfg.enabled ? 'Désactiver' : 'Activer').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('mpreq_modal_color').setLabel('🎨 Couleur').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mpreq_modal_thread').setLabel('🗂️ Nom du fil').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mpreq_refresh').setLabel('🔄 Actualiser').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('demande-mp')
    .setDescription('💌 Configurer le système de demande de MP')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('panel').setDescription('Ouvrir le panel de configuration')),

  async execute(interaction) {
    const guild = interaction.guild;
    let cfg = await getOrCreateConfig(guild.id);

    const reply = await interaction.reply({ ...renderPanel(cfg), ephemeral: true, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: COLLECTOR_TIMEOUT_MS });

    collector.on('collect', async (i) => {
      const id = i.customId;
      cfg = await getOrCreateConfig(guild.id);

      if (id === 'mpreq_refresh') return i.update(renderPanel(cfg));

      if (id === 'mpreq_channel') {
        cfg.channelId = i.values[0];
        await cfg.save();
        return i.update(renderPanel(cfg));
      }

      if (id === 'mpreq_toggle') {
        if (!cfg.enabled && !cfg.channelId) {
          return i.reply({ embeds: [errorEmbed('Salon requis', 'Choisissez d\'abord un salon avant d\'activer le système.')], ephemeral: true });
        }
        cfg.enabled = !cfg.enabled;
        await cfg.save();
        return i.update(renderPanel(cfg));
      }

      if (id === 'mpreq_modal_color') {
        const modal = new ModalBuilder().setCustomId('mpreq_modal_color_submit').setTitle('🎨 Couleur de l\'embed');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('color').setLabel('Code hexadécimal (ex: 5865F2)').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.embedColor),
        ));
        return i.showModal(modal);
      }

      if (id === 'mpreq_modal_thread') {
        const modal = new ModalBuilder().setCustomId('mpreq_modal_thread_submit').setTitle('🗂️ Nom du fil');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('template').setLabel('Utilisez {username} pour le pseudo').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80).setValue(cfg.threadNameTemplate),
        ));
        return i.showModal(modal);
      }
    });

    collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  async handleModal(interaction) {
    const id = interaction.customId;
    const cfg = await getOrCreateConfig(interaction.guild.id);

    if (id === 'mpreq_modal_color_submit') {
      const clean = interaction.fields.getTextInputValue('color').trim().replace(/^#/, '');
      if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
        return interaction.reply({ embeds: [errorEmbed('Couleur invalide', 'Entrez un code hexadécimal à 6 caractères (ex: 5865F2).')], ephemeral: true });
      }
      cfg.embedColor = clean.toUpperCase();
      await cfg.save();
      return interaction.update(renderPanel(cfg)).catch(() => interaction.reply({ embeds: [successEmbed('Couleur mise à jour')], ephemeral: true }));
    }

    if (id === 'mpreq_modal_thread_submit') {
      const template = interaction.fields.getTextInputValue('template').trim();
      if (!template) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Le nom du fil ne peut pas être vide.')], ephemeral: true });
      }
      cfg.threadNameTemplate = template;
      await cfg.save();
      return interaction.update(renderPanel(cfg)).catch(() => interaction.reply({ embeds: [successEmbed('Nom du fil mis à jour')], ephemeral: true }));
    }
  },
};
