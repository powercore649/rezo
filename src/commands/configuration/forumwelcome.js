// commands/forumwelcome.js — Message d'accueil automatique pour les salons Forum
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
} = require('discord.js');
const ForumWelcome = require('../../models/ForumWelcome');
const { buildWelcomeEmbed, buildWelcomeRow } = require('../../utils/forumWelcomeManager');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');

async function getOrCreate(guildId, forumChannelId) {
  let cfg = await ForumWelcome.findOne({ guildId, forumChannelId });
  if (!cfg) cfg = await ForumWelcome.create({ guildId, forumChannelId });
  return cfg;
}

// ─── Embed du panel de configuration pour UN forum ───────────────────────────
function buildConfigEmbed(cfg, forumChannel) {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🗂️ Message d'accueil — #${forumChannel.name}`)
    .addFields(
      { name: '📢 Statut', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '📌 Épinglé automatiquement', value: cfg.pinMessage ? 'Oui' : 'Non', inline: true },
      { name: '🔗 Bouton lien', value: cfg.buttonLabel && cfg.buttonUrl ? `\`${cfg.buttonLabel}\` → ${cfg.buttonUrl}` : '*Aucun*', inline: true },
      { name: '📝 Titre', value: `\`${cfg.title}\``, inline: false },
      { name: '💬 Message', value: cfg.message.length > 400 ? cfg.message.slice(0, 400) + '…' : cfg.message, inline: false },
    )
    .setFooter({ text: 'Placeholders disponibles : {username} {titre} {forum} {tags}' });
}

function buildConfigRow1(cfg) {
  const id = cfg.forumChannelId;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`fw_toggle:${id}`).setLabel(cfg.enabled ? '🔴 Désactiver' : '🟢 Activer').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`fw_toggle_pin:${id}`).setLabel(cfg.pinMessage ? '📌 Ne plus épingler' : '📌 Épingler').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`fw_edit_message:${id}`).setLabel('✏️ Modifier le message').setStyle(ButtonStyle.Primary),
  );
}

function buildConfigRow2(cfg) {
  const id = cfg.forumChannelId;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`fw_edit_button:${id}`).setLabel('🔗 Bouton lien').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`fw_delete:${id}`).setLabel('🗑️ Supprimer la config').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('fw_back').setLabel('← Changer de forum').setStyle(ButtonStyle.Secondary),
  );
}

function buildSelectEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🗂️ Message d\'accueil — Salons Forum')
    .setDescription('Sélectionne un salon **Forum** ci-dessous pour configurer (ou modifier) son message d\'accueil automatique, posté à chaque nouveau post.');
}

function buildSelectRow() {
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('fw_select_forum')
      .setPlaceholder('Choisir un salon forum...')
      .addChannelTypes(ChannelType.GuildForum),
  );
}

function buildCloseRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fw_close').setLabel('✖ Fermer').setStyle(ButtonStyle.Secondary),
  );
}

async function renderForumPanel(interactionLike, guild, forumChannelId) {
  const forumChannel = guild.channels.cache.get(forumChannelId);
  if (!forumChannel) {
    return interactionLike.update({
      embeds: [errorEmbed('Salon introuvable', 'Ce salon forum n\'existe plus ou est inaccessible.')],
      components: [buildSelectRow(), buildCloseRow()],
    });
  }
  const cfg = await getOrCreate(guild.id, forumChannelId);
  return interactionLike.update({
    embeds: [buildConfigEmbed(cfg, forumChannel)],
    components: [buildConfigRow1(cfg), buildConfigRow2(cfg), buildCloseRow()],
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('forumwelcome')
    .setDescription('🗂️ Message d\'accueil automatique pour les salons Forum')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand(s => s.setName('panel').setDescription('Ouvrir le panel de configuration')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub !== 'panel') return;

    const reply = await interaction.reply({
      embeds: [buildSelectEmbed()],
      components: [buildSelectRow(), buildCloseRow()],
      ephemeral: true,
      fetchReply: true,
    });

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 10 * 60 * 1000,
    });

    col.on('collect', async i => {
      try {
        if (i.customId === 'fw_close') return i.update({ components: [] });

        if (i.customId === 'fw_select_forum') {
          return renderForumPanel(i, interaction.guild, i.values[0]);
        }

        if (i.customId === 'fw_back') {
          return i.update({ embeds: [buildSelectEmbed()], components: [buildSelectRow(), buildCloseRow()] });
        }

        if (i.customId.startsWith('fw_toggle:')) {
          const id = i.customId.split(':')[1];
          const cfg = await getOrCreate(interaction.guild.id, id);
          cfg.enabled = !cfg.enabled;
          await cfg.save();
          return renderForumPanel(i, interaction.guild, id);
        }

        if (i.customId.startsWith('fw_toggle_pin:')) {
          const id = i.customId.split(':')[1];
          const cfg = await getOrCreate(interaction.guild.id, id);
          cfg.pinMessage = !cfg.pinMessage;
          await cfg.save();
          return renderForumPanel(i, interaction.guild, id);
        }

        if (i.customId.startsWith('fw_delete:')) {
          const id = i.customId.split(':')[1];
          await ForumWelcome.deleteOne({ guildId: interaction.guild.id, forumChannelId: id });
          return i.update({
            embeds: [successEmbed('Configuration supprimée', 'Le message d\'accueil de ce forum a été retiré.')],
            components: [buildSelectRow(), buildCloseRow()],
          });
        }

        if (i.customId.startsWith('fw_edit_message:')) {
          const id = i.customId.split(':')[1];
          const cfg = await getOrCreate(interaction.guild.id, id);

          const modal = new ModalBuilder()
            .setCustomId(`fw_modal_message:${id}`)
            .setTitle('Modifier le message d\'accueil')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('fw_title')
                  .setLabel('Titre')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(256)
                  .setValue(cfg.title)
                  .setRequired(true),
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('fw_message')
                  .setLabel('Message ({username} {titre} {forum} {tags})')
                  .setStyle(TextInputStyle.Paragraph)
                  .setMaxLength(4000)
                  .setValue(cfg.message)
                  .setRequired(true),
              ),
            );
          return i.showModal(modal);
        }

        if (i.customId.startsWith('fw_edit_button:')) {
          const id = i.customId.split(':')[1];
          const cfg = await getOrCreate(interaction.guild.id, id);

          const modal = new ModalBuilder()
            .setCustomId(`fw_modal_button:${id}`)
            .setTitle('Bouton lien (optionnel)')
            .addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('fw_button_label')
                  .setLabel('Texte du bouton (vide = retirer le bouton)')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(80)
                  .setValue(cfg.buttonLabel || '')
                  .setRequired(false),
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                  .setCustomId('fw_button_url')
                  .setLabel('URL du bouton (https://...)')
                  .setStyle(TextInputStyle.Short)
                  .setMaxLength(300)
                  .setValue(cfg.buttonUrl || '')
                  .setRequired(false),
              ),
            );
          return i.showModal(modal);
        }
      } catch (err) {
        console.error('forumwelcome panel:', err.message);
      }
    });

    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Soumissions de modaux (routées depuis interactionCreate.js) ──────────
  async handleModal(interaction) {
    const [prefix, forumChannelId] = interaction.customId.split(':');
    const cfg = await getOrCreate(interaction.guild.id, forumChannelId);

    if (prefix === 'fw_modal_message') {
      cfg.title = interaction.fields.getTextInputValue('fw_title').trim() || cfg.title;
      cfg.message = interaction.fields.getTextInputValue('fw_message').trim() || cfg.message;
      await cfg.save();
    }

    if (prefix === 'fw_modal_button') {
      const label = interaction.fields.getTextInputValue('fw_button_label').trim();
      const url   = interaction.fields.getTextInputValue('fw_button_url').trim();

      if (!label || !url) {
        cfg.buttonLabel = null;
        cfg.buttonUrl = null;
      } else if (!/^https?:\/\//i.test(url)) {
        return interaction.reply({
          embeds: [errorEmbed('URL invalide', 'L\'URL du bouton doit commencer par `http://` ou `https://`.')],
          ephemeral: true,
        });
      } else {
        cfg.buttonLabel = label;
        cfg.buttonUrl = url;
      }
      await cfg.save();
    }

    const forumChannel = interaction.guild.channels.cache.get(forumChannelId);
    const payload = {
      embeds: [buildConfigEmbed(cfg, forumChannel)],
      components: [buildConfigRow1(cfg), buildConfigRow2(cfg), buildCloseRow()],
    };

    // Le modal a été ouvert depuis un bouton sur le panel : on édite ce même
    // message pour rester dans le flux, au lieu d'envoyer une nouvelle réponse.
    if (interaction.isFromMessage?.()) {
      return interaction.update(payload);
    }
    return interaction.reply({ ...payload, ephemeral: true });
  },
};
