// commands/starboard.js — Starboard avancé, panel de configuration complet
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, ChannelType,
} = require('discord.js');
const Starboard = require('../../models/Starboard');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');
const { displayEmoji } = require('../../utils/starboardManager');

async function getOrCreate(guildId) {
  let cfg = await Starboard.findOne({ guildId });
  if (!cfg) cfg = await Starboard.create({ guildId });
  return cfg;
}

// ─── Parse un émoji saisi par l'utilisateur — Unicode uniquement ────────────
function parseEmojiInput(raw) {
  const trimmed = String(raw || '').trim();
  // Un tag custom (ou l'ancien format « nom:id ») n'est jamais accepté : les
  // annonces et embeds du bot ne doivent afficher que de l'Unicode.
  if (/^<a?:[A-Za-z0-9_]+:\d{5,}>$/.test(trimmed)) return '';
  if (/^[A-Za-z0-9_]+:\d{5,}$/.test(trimmed)) return '';
  return trimmed;
}

// ─── Parse le texte des paliers ("seuil|label|#couleur" par ligne) ────────────
function parseTiersInput(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const tiers = [];
  for (const line of lines) {
    const [thresholdStr, label, color] = line.split('|').map(s => s?.trim());
    const threshold = parseInt(thresholdStr, 10);
    if (!Number.isFinite(threshold) || !label || !/^#?[0-9a-fA-F]{6}$/.test(color || '')) return null;
    tiers.push({ threshold, label, color: color.startsWith('#') ? color : `#${color}` });
  }
  return tiers.length ? tiers : null;
}

// ─── Embed du panel ────────────────────────────────────────────────────────
function buildPanelEmbed(cfg, guild) {
  const sortedTiers = [...cfg.tiers].sort((a, b) => a.threshold - b.threshold);
  const tiersText = sortedTiers.length
    ? sortedTiers.map(t => `**${t.threshold}**+ → ${t.label} \`${t.color}\``).join('\n')
    : '*Aucun palier configuré*';

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('⭐ Starboard — Panel de configuration avancé')
    .setDescription('Met en avant les meilleurs messages du serveur dans un salon dédié, dès qu\'ils atteignent un certain nombre de réactions ⭐.')
    .addFields(
      { name: '📢 Statut', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '📍 Salon', value: cfg.channelId ? `<#${cfg.channelId}>` : '*Non défini*', inline: true },
      { name: '🎯 Seuil', value: `${cfg.threshold} ${displayEmoji(cfg.emoji)}`, inline: true },
      { name: '🙋 Auto-star', value: cfg.selfStarEnabled ? '✅ Autorisé' : '❌ Interdit', inline: true },
      { name: '🤖 Messages de bots', value: cfg.botMessagesEnabled ? '✅ Éligibles' : '❌ Exclus', inline: true },
      { name: '🔞 Salons NSFW', value: cfg.nsfwChannelsEnabled ? '✅ Éligibles' : '❌ Exclus', inline: true },
      { name: '🗑️ Suppression auto', value: cfg.deleteOnSourceDelete ? '✅ Activée' : '❌ Désactivée', inline: true },
      { name: '👶 Âge min. du compte', value: cfg.minAccountAgeDays > 0 ? `${cfg.minAccountAgeDays} jour(s)` : '*Aucune limite*', inline: true },
      { name: '💫 Total mis en avant', value: `${cfg.totalStarred}`, inline: true },
      { name: '🚫 Salons ignorés', value: cfg.ignoredChannelIds.length ? cfg.ignoredChannelIds.map(id => `<#${id}>`).join(', ') : '*Aucun*', inline: false },
      { name: '🚫 Rôles ignorés (réactions non comptées)', value: cfg.ignoredRoleIds.length ? cfg.ignoredRoleIds.map(id => `<@&${id}>`).join(', ') : '*Aucun*', inline: false },
      { name: '🏆 Paliers', value: tiersText, inline: false },
    )
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setFooter({ text: 'REZO • Starboard v1' })
    .setTimestamp();
}

function buildComponents(cfg) {
  const row1 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('sb_select_channel')
      .setPlaceholder('📍 Choisir le salon starboard...')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sb_set_emoji').setLabel('⭐ Émoji').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sb_set_threshold').setLabel('🎯 Seuil').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sb_set_minage').setLabel('👶 Âge min. compte').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sb_set_tiers').setLabel('🏆 Paliers').setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sb_toggle_enabled').setLabel(cfg.enabled ? '🔴 Désactiver' : '🟢 Activer').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('sb_toggle_selfstar').setLabel('🙋 Auto-star').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sb_toggle_botmsg').setLabel('🤖 Msgs bots').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sb_toggle_nsfw').setLabel('🔞 NSFW').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sb_toggle_autodelete').setLabel('🗑️ Suppr. auto').setStyle(ButtonStyle.Secondary),
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('sb_select_ignored_channels')
      .setPlaceholder('🚫 Salons à exclure du starboard...')
      .setMinValues(0)
      .setMaxValues(10)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum),
  );

  const row5 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('sb_select_ignored_roles')
      .setPlaceholder('🚫 Rôles dont les réactions ne comptent pas...')
      .setMinValues(0)
      .setMaxValues(10),
  );

  return [row1, row2, row3, row4, row5];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('starboard')
    .setDescription('⭐ Panel de configuration du Starboard')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);

    const refresh = async i => {
      const freshCfg = await getOrCreate(interaction.guild.id);
      await i.update({ embeds: [buildPanelEmbed(freshCfg, interaction.guild)], components: buildComponents(freshCfg) });
    };

    const reply = await interaction.reply({
      embeds: [buildPanelEmbed(cfg, interaction.guild)],
      components: buildComponents(cfg),
      ephemeral: true,
      fetchReply: true,
    });

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 15 * 60 * 1000,
    });

    col.on('collect', async i => {
      try {
        const liveCfg = await getOrCreate(interaction.guild.id);

        // ── Sélection du salon starboard ────────────────────────────────
        if (i.customId === 'sb_select_channel') {
          liveCfg.channelId = i.values[0];
          await liveCfg.save();
          return refresh(i);
        }

        // ── Salons / rôles ignorés ──────────────────────────────────────
        if (i.customId === 'sb_select_ignored_channels') {
          liveCfg.ignoredChannelIds = i.values;
          await liveCfg.save();
          return refresh(i);
        }
        if (i.customId === 'sb_select_ignored_roles') {
          liveCfg.ignoredRoleIds = i.values;
          await liveCfg.save();
          return refresh(i);
        }

        // ── Toggles ──────────────────────────────────────────────────────
        if (i.customId === 'sb_toggle_enabled') {
          if (!liveCfg.channelId && !liveCfg.enabled) {
            return i.reply({ embeds: [errorEmbed('Salon requis', 'Choisis un salon starboard avant d\'activer le système.')], ephemeral: true });
          }
          liveCfg.enabled = !liveCfg.enabled;
          await liveCfg.save();
          return refresh(i);
        }
        if (i.customId === 'sb_toggle_selfstar') {
          liveCfg.selfStarEnabled = !liveCfg.selfStarEnabled;
          await liveCfg.save();
          return refresh(i);
        }
        if (i.customId === 'sb_toggle_botmsg') {
          liveCfg.botMessagesEnabled = !liveCfg.botMessagesEnabled;
          await liveCfg.save();
          return refresh(i);
        }
        if (i.customId === 'sb_toggle_nsfw') {
          liveCfg.nsfwChannelsEnabled = !liveCfg.nsfwChannelsEnabled;
          await liveCfg.save();
          return refresh(i);
        }
        if (i.customId === 'sb_toggle_autodelete') {
          liveCfg.deleteOnSourceDelete = !liveCfg.deleteOnSourceDelete;
          await liveCfg.save();
          return refresh(i);
        }

        // ── Modaux ──────────────────────────────────────────────────────
        if (i.customId === 'sb_set_emoji') {
          const modal = new ModalBuilder().setCustomId('sb_modal_emoji').setTitle('⭐ Émoji déclencheur');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('sb_emoji').setLabel('Émoji Unicode (ex: ⭐)').setStyle(TextInputStyle.Short).setValue(displayEmoji(liveCfg.emoji)).setMaxLength(16).setRequired(true),
          ));
          return i.showModal(modal);
        }
        if (i.customId === 'sb_set_threshold') {
          const modal = new ModalBuilder().setCustomId('sb_modal_threshold').setTitle('🎯 Seuil de réactions');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('sb_threshold').setLabel('Nombre de réactions requises (1-500)').setStyle(TextInputStyle.Short).setValue(String(liveCfg.threshold)).setMaxLength(3).setRequired(true),
          ));
          return i.showModal(modal);
        }
        if (i.customId === 'sb_set_minage') {
          const modal = new ModalBuilder().setCustomId('sb_modal_minage').setTitle('👶 Âge minimum du compte');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('sb_minage').setLabel('Âge min. du compte pour voter (0 = aucun)').setStyle(TextInputStyle.Short).setValue(String(liveCfg.minAccountAgeDays)).setMaxLength(3).setRequired(true),
          ));
          return i.showModal(modal);
        }
        if (i.customId === 'sb_set_tiers') {
          const currentText = [...liveCfg.tiers]
            .sort((a, b) => a.threshold - b.threshold)
            .map(t => `${t.threshold}|${t.label}|${t.color}`)
            .join('\n');
          const modal = new ModalBuilder().setCustomId('sb_modal_tiers').setTitle('🏆 Paliers (1 par ligne)');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('sb_tiers')
              .setLabel('Format : seuil|label|#couleur')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(currentText)
              .setMaxLength(1000)
              .setRequired(true),
          ));
          return i.showModal(modal);
        }
      } catch (err) {
        console.error('starboard panel:', err.message);
      }
    });

    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Soumissions de modaux (routées depuis interactionCreate.js) ──────────
  async handleModal(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);

    if (interaction.customId === 'sb_modal_emoji') {
      const raw = interaction.fields.getTextInputValue('sb_emoji');
      cfg.emoji = parseEmojiInput(raw);
    }

    if (interaction.customId === 'sb_modal_threshold') {
      const n = parseInt(interaction.fields.getTextInputValue('sb_threshold'), 10);
      if (!Number.isFinite(n) || n < 1 || n > 500) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Le seuil doit être un nombre entre 1 et 500.')], ephemeral: true });
      }
      cfg.threshold = n;
    }

    if (interaction.customId === 'sb_modal_minage') {
      const n = parseInt(interaction.fields.getTextInputValue('sb_minage'), 10);
      if (!Number.isFinite(n) || n < 0 || n > 365) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'L\'âge minimum doit être un nombre entre 0 et 365.')], ephemeral: true });
      }
      cfg.minAccountAgeDays = n;
    }

    if (interaction.customId === 'sb_modal_tiers') {
      const raw = interaction.fields.getTextInputValue('sb_tiers');
      const tiers = parseTiersInput(raw);
      if (!tiers) {
        return interaction.reply({
          embeds: [errorEmbed('Format invalide', 'Chaque ligne doit suivre le format `seuil|label|#couleur`, ex: `10|🥈 Argent|#C0C0C0`.')],
          ephemeral: true,
        });
      }
      cfg.tiers = tiers;
    }

    await cfg.save();

    const payload = { embeds: [buildPanelEmbed(cfg, interaction.guild)], components: buildComponents(cfg) };
    if (interaction.isFromMessage?.()) {
      return interaction.update(payload);
    }
    return interaction.reply({ ...payload, ephemeral: true });
  },

  getOrCreate,
};
