'use strict';
// commands/bump-notif.js — Panel de configuration avancé du système de notification de bump
// Couvre l'intégralité du comportement du rappel automatique (salon, rôle, message
// personnalisé, couleur, bascules d'affichage, suppression auto) — tout est réellement
// branché sur utils/bumpNetwork.js::sendBumpReminders, qui tourne toutes les 5 minutes.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder,
  TextInputStyle, PermissionFlagsBits, ChannelType,
} = require('discord.js');

const Server = require('../../models/Server');
const BumpNotifConfig = require('../../models/BumpNotifConfig');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');
const { renderTemplate, validateHexColor, resolveNotifChannelId, DEFAULT_TEMPLATE } = require('../../utils/bumpNotifEngine');

const COLLECTOR_TIMEOUT_MS = 10 * 60 * 1000;

async function getOrCreateNotifConfig(guildId) {
  let cfg = await BumpNotifConfig.findOne({ guildId });
  if (!cfg) cfg = await BumpNotifConfig.create({ guildId });
  return cfg;
}
async function getOrCreateServer(guildId, guildName) {
  let server = await Server.findOne({ guildId });
  if (!server) server = await Server.create({ guildId, guildName });
  return server;
}

// ═══════════════════════════════════════════════════════════════════════════
function renderOverview(cfg, server) {
  const channelId = resolveNotifChannelId(cfg, server);
  const preview = renderTemplate(cfg.customMessage, { serveur: server.guildName || 'Votre serveur', streak: server.bumpStreak || 0, coins: 50, total: server.bumpCount || 0 });

  const embed = new EmbedBuilder()
    .setColor(parseInt(cfg.embedColor, 16) || COLORS.warning)
    .setTitle('🔔 Panel — Notifications de bump')
    .setDescription('Personnalisez entièrement le rappel automatique envoyé quand le cooldown de bump se termine.')
    .addFields(
      { name: '📢 Statut', value: server.reminderEnabled ? '🟢 Activés' : '🔴 Désactivés', inline: true },
      { name: '📝 Salon', value: channelId ? `<#${channelId}>` : '*Non défini*', inline: true },
      { name: '🔔 Rôle mentionné', value: server.bumpRoleId ? `<@&${server.bumpRoleId}>` : '*Aucun*', inline: true },
      { name: '🔇 Mention silencieuse', value: cfg.silentPing ? '🟢 Oui (pas de ping)' : '🔴 Non', inline: true },
      { name: '🔥 Bonus streak affiché', value: cfg.showStreakBonus ? '🟢 Oui' : '🔴 Non', inline: true },
      { name: '📊 Total bumps affiché', value: cfg.showTotalBumps ? '🟢 Oui' : '🔴 Non', inline: true },
      { name: '🔔 Bouton rappel DM', value: cfg.showDmButton ? '🟢 Affiché' : '🔴 Masqué', inline: true },
      { name: '🎨 Couleur', value: `#${cfg.embedColor}`, inline: true },
      { name: '🗑️ Auto-suppression', value: cfg.autoDeleteMinutes > 0 ? `${cfg.autoDeleteMinutes} min` : '*Jamais*', inline: true },
      { name: '💬 Aperçu du message', value: preview, inline: false },
    )
    .setFooter({ text: 'REZO • Vérification toutes les 5 minutes' })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('bumpnotif_channel').setPlaceholder('📝 Salon de notification dédié...').addChannelTypes(ChannelType.GuildText),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('bumpnotif_role').setPlaceholder('🔔 Rôle à mentionner...'),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bumpnotif_toggle_enabled').setLabel(server.reminderEnabled ? 'Désactiver' : 'Activer').setStyle(server.reminderEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bumpnotif_toggle_silent').setLabel(`Silencieux: ${cfg.silentPing ? 'ON' : 'OFF'}`).setStyle(cfg.silentPing ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bumpnotif_toggle_streak').setLabel(`Streak: ${cfg.showStreakBonus ? 'ON' : 'OFF'}`).setStyle(cfg.showStreakBonus ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bumpnotif_toggle_total').setLabel(`Total: ${cfg.showTotalBumps ? 'ON' : 'OFF'}`).setStyle(cfg.showTotalBumps ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bumpnotif_toggle_dm').setLabel(`Bouton DM: ${cfg.showDmButton ? 'ON' : 'OFF'}`).setStyle(cfg.showDmButton ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bumpnotif_modal_message').setLabel('💬 Message personnalisé').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bumpnotif_modal_color').setLabel('🎨 Couleur').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bumpnotif_modal_autodelete').setLabel('🗑️ Auto-suppression').setStyle(ButtonStyle.Secondary),
  );
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bumpnotif_reset_message').setLabel('↩️ Message par défaut').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bumpnotif_refresh').setLabel('🔄 Actualiser').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bump-notif')
    .setDescription('🔔 Configurer les notifications de rappel de bump')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('panel').setDescription('Ouvrir le panel de configuration avancé')),

  async execute(interaction) {
    const guild = interaction.guild;
    let cfg = await getOrCreateNotifConfig(guild.id);
    let server = await getOrCreateServer(guild.id, guild.name);

    const reply = await interaction.reply({ ...renderOverview(cfg, server), ephemeral: true, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: COLLECTOR_TIMEOUT_MS });

    collector.on('collect', async (i) => {
      const id = i.customId;
      cfg = await getOrCreateNotifConfig(guild.id);
      server = await getOrCreateServer(guild.id, guild.name);

      if (id === 'bumpnotif_refresh') return i.update(renderOverview(cfg, server));

      if (id === 'bumpnotif_channel') { cfg.notifChannelId = i.values[0]; await cfg.save(); return i.update(renderOverview(cfg, server)); }
      if (id === 'bumpnotif_role') { server.bumpRoleId = i.values[0]; await server.save(); return i.update(renderOverview(cfg, server)); }

      if (id === 'bumpnotif_toggle_enabled') { server.reminderEnabled = !server.reminderEnabled; await server.save(); return i.update(renderOverview(cfg, server)); }
      if (id === 'bumpnotif_toggle_silent') { cfg.silentPing = !cfg.silentPing; await cfg.save(); return i.update(renderOverview(cfg, server)); }
      if (id === 'bumpnotif_toggle_streak') { cfg.showStreakBonus = !cfg.showStreakBonus; await cfg.save(); return i.update(renderOverview(cfg, server)); }
      if (id === 'bumpnotif_toggle_total') { cfg.showTotalBumps = !cfg.showTotalBumps; await cfg.save(); return i.update(renderOverview(cfg, server)); }
      if (id === 'bumpnotif_toggle_dm') { cfg.showDmButton = !cfg.showDmButton; await cfg.save(); return i.update(renderOverview(cfg, server)); }

      if (id === 'bumpnotif_reset_message') { cfg.customMessage = null; await cfg.save(); return i.update(renderOverview(cfg, server)); }

      if (id === 'bumpnotif_modal_message') {
        const modal = new ModalBuilder().setCustomId('bumpnotif_modal_message_submit').setTitle('💬 Message personnalisé');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('message').setLabel('Message ({serveur} {streak} {coins} {total})').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setValue(cfg.customMessage || DEFAULT_TEMPLATE),
        ));
        return i.showModal(modal);
      }
      if (id === 'bumpnotif_modal_color') {
        const modal = new ModalBuilder().setCustomId('bumpnotif_modal_color_submit').setTitle('🎨 Couleur de l\'embed');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('color').setLabel('Code hexadécimal (ex: FEE75C)').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.embedColor),
        ));
        return i.showModal(modal);
      }
      if (id === 'bumpnotif_modal_autodelete') {
        const modal = new ModalBuilder().setCustomId('bumpnotif_modal_autodelete_submit').setTitle('🗑️ Auto-suppression');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('minutes').setLabel('Minutes avant suppression (0 = jamais)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cfg.autoDeleteMinutes)),
        ));
        return i.showModal(modal);
      }
    });

    collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  async handleModal(interaction) {
    const id = interaction.customId;
    const guild = interaction.guild;
    const cfg = await getOrCreateNotifConfig(guild.id);
    const server = await getOrCreateServer(guild.id, guild.name);

    if (id === 'bumpnotif_modal_message_submit') {
      cfg.customMessage = interaction.fields.getTextInputValue('message').trim();
      await cfg.save();
      return interaction.update(renderOverview(cfg, server)).catch(() => interaction.reply({ embeds: [successEmbed('Message mis à jour')], ephemeral: true }));
    }

    if (id === 'bumpnotif_modal_color_submit') {
      const result = validateHexColor(interaction.fields.getTextInputValue('color'));
      if (!result.ok) return interaction.reply({ embeds: [errorEmbed('Couleur invalide', result.error)], ephemeral: true });
      cfg.embedColor = result.hex;
      await cfg.save();
      return interaction.update(renderOverview(cfg, server)).catch(() => interaction.reply({ embeds: [successEmbed('Couleur mise à jour')], ephemeral: true }));
    }

    if (id === 'bumpnotif_modal_autodelete_submit') {
      const minutes = parseInt(interaction.fields.getTextInputValue('minutes'));
      if (isNaN(minutes) || minutes < 0 || minutes > 1440) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Entrez un nombre de minutes entre 0 et 1440 (24h).')], ephemeral: true });
      }
      cfg.autoDeleteMinutes = minutes;
      await cfg.save();
      return interaction.update(renderOverview(cfg, server)).catch(() => interaction.reply({ embeds: [successEmbed('Auto-suppression mise à jour')], ephemeral: true }));
    }
  },
};
