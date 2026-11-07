// commands/configuration/farewell-set.js — Configuration des au-revoirs
// Panel interactif : activation, salon, style embed/brut, texte, titre,
// couleur et image canvas (moteur partagé avec Bienvenue+).
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { Farewell } = require('../../models/Welcome');
const { successEmbed, errorEmbed, infoEmbed, warningEmbed, COLORS } = require('../../utils/embeds');
const { renderWelcomeImage } = require('../../utils/welcomeCards');
const { resolveWelcomePlaceholders, sendFarewell } = require('../../utils/welcomeManager');

const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

async function getOrCreateConfig(guildId) {
  let cfg = await Farewell.findOne({ guildId });
  if (!cfg) cfg = await Farewell.create({ guildId });
  return cfg;
}

// ─── Panneau ──────────────────────────────────────────────────────────────────
function buildPanelEmbed(cfg) {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('👋 Au revoir — Panneau de configuration')
    .setDescription('Annonce élégante quand un membre quitte le serveur.')
    .addFields(
      { name: '⚡ État', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '📺 Salon', value: cfg.channelId ? `<#${cfg.channelId}>` : '*Non défini*', inline: true },
      { name: '🎨 Rendu', value: cfg.renderStyle === 'plain' ? 'Message brut' : 'Embed riche', inline: true },
      { name: '🖼️ Image', value: !cfg.imageStyle || cfg.imageStyle === 'off' ? 'Aucune' : cfg.imageStyle, inline: true },
      { name: '🏷️ Titre', value: cfg.embedTitle || '*(défaut : 👋 Au revoir)*', inline: true },
      { name: '🖌️ Couleur', value: cfg.embedColor || '#FF6B6B', inline: true },
      { name: '✍️ Message actuel', value: `>>> ${(cfg.message || '').slice(0, 300) || '*vide*'}`, inline: false },
      {
        name: '🧩 Variables',
        value: '`{user}` (mention) • `{username}` (sans ping) • `{server}` • `{count}` (membres restants) • `{date}` • `{time}`',
        inline: false,
      },
    );
}

function buildPanelComponents(cfg) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fwell_toggle').setLabel(cfg.enabled ? 'Désactiver' : 'Activer').setEmoji('⚡')
        .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('fwell_channel').setLabel('Salon').setEmoji('📺').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('fwell_style').setLabel('Message').setEmoji('✍️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('fwell_render').setLabel('Rendu').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('fwell_image').setLabel('Image').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('fwell_title').setLabel('Titre').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('fwell_color').setLabel('Couleur').setEmoji('🖌️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('fwell_test').setLabel('Test').setEmoji('🧪').setStyle(ButtonStyle.Primary),
    ),
  ];
}

async function sendPanel(interaction) {
  const cfg = await getOrCreateConfig(interaction.guildId);
  await interaction.reply({
    embeds: [buildPanelEmbed(cfg)],
    components: buildPanelComponents(cfg),
    ephemeral: true,
    fetchReply: true,
  });
}

async function refreshPanel(interaction, cfg) {
  // Le panel étant éphémère, on met simplement à jour la réponse d'origine
  await interaction.message?.edit({
    embeds: [buildPanelEmbed(cfg)],
    components: buildPanelComponents(cfg),
  }).catch(() => {});
}

// ─── Commande ─────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('farewell-set')
    .setDescription('👋 Système d\'au revoir : message, embed, image canvas')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('panel').setDescription('Ouvrir le panneau de configuration')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'panel') return sendPanel(interaction);
  },

  // ─── Boutons du panneau ──────────────────────────────────────────────────────
  async handleButton(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur**.')], ephemeral: true });
    }
    const id = interaction.customId;
    const cfg = await getOrCreateConfig(interaction.guildId);

    if (id === 'fwell_toggle') {
      if (!cfg.enabled && !cfg.channelId) {
        return interaction.reply({ embeds: [warningEmbed('Salon requis', 'Choisis d\'abord un salon (bouton 📺).')], ephemeral: true });
      }
      cfg.enabled = !cfg.enabled;
      await cfg.save();
      await interaction.deferUpdate();
      await interaction.editReply({ embeds: [buildPanelEmbed(cfg)], components: buildPanelComponents(cfg) });
      return;
    }

    if (id === 'fwell_channel') {
      const options = interaction.guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText)
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .first(25)
        .map(c => ({ label: c.name.slice(0, 100), value: c.id }));
      if (!options.length) {
        return interaction.reply({ embeds: [errorEmbed('Aucun salon', 'Aucun salon texte trouvé.')], ephemeral: true });
      }
      return interaction.reply({
        embeds: [infoEmbed('Salon des au-revoirs', 'Choisis où poster les messages de départ.')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('fwells_channel').setPlaceholder('Salon des au-revoirs').addOptions(options),
        )],
        ephemeral: true,
      });
    }

    if (id === 'fwell_style') {
      const modal = new ModalBuilder().setCustomId('fwellm_message').setTitle('✍️ Message d\'au revoir');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('fwell_message')
            .setLabel('Message (variables : {username}, {count}…)')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(cfg.message || '**{username}** ({user}) a quitté le serveur.')
            .setMaxLength(1500)
            .setRequired(true),
        ),
      );
      return interaction.showModal(modal);
    }

    if (id === 'fwell_render') {
      return interaction.reply({
        embeds: [infoEmbed('Style de rendu', 'Embed riche ou message brut.')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('fwells_render').addOptions([
            { label: 'Embed riche', value: 'embed', description: 'Embed coloré avec titre et image' },
            { label: 'Message brut', value: 'plain', description: 'Texte simple, sans embed' },
          ]),
        )],
        ephemeral: true,
      });
    }

    if (id === 'fwell_image') {
      return interaction.reply({
        embeds: [infoEmbed('Image d\'au revoir', 'Même moteur que Bienvenue+ : la carte affiche le nom du départ.')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId('fwells_image').addOptions([
            { label: 'Aucune image', value: 'off', description: 'Embed avec miniature de l\'avatar', emoji: '🚫' },
            { label: 'Gradient néon', value: 'gradient', description: 'Grille futuriste + dégradé violet/rose', emoji: '🌈' },
            { label: 'Vitrail de glace', value: 'glass', description: 'Carte de glace bleue, reflets et halos', emoji: '❄️' },
            { label: 'Bandeau diagonal', value: 'banner', description: 'Bandeau coloré, pastille avatar à gauche', emoji: '🎭' },
            { label: 'Carte épurée', value: 'minimal', description: 'Fond clair, cadre fin, typographie centrée', emoji: '⬜' },
          ]),
        )],
        ephemeral: true,
      });
    }

    if (id === 'fwell_title') {
      const modal = new ModalBuilder().setCustomId('fwellm_title').setTitle('🏷️ Titre de l\'embed');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('fwell_title')
            .setLabel('Titre (variables acceptées, vide = défaut)')
            .setStyle(TextInputStyle.Short)
            .setValue(cfg.embedTitle || '👋 Au revoir')
            .setMaxLength(256)
            .setRequired(false),
        ),
      );
      return interaction.showModal(modal);
    }

    if (id === 'fwell_color') {
      const modal = new ModalBuilder().setCustomId('fwellm_color').setTitle('🖌️ Couleur de l\'embed');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('fwell_color')
            .setLabel('Couleur hexadécimale (ex : #FF6B6B)')
            .setStyle(TextInputStyle.Short)
            .setValue(cfg.embedColor || '#FF6B6B')
            .setMaxLength(7)
            .setRequired(true),
        ),
      );
      return interaction.showModal(modal);
    }

    if (id === 'fwell_test') {
      await interaction.deferReply({ ephemeral: true });
      const member = interaction.member;
      const payloadEmbed = new EmbedBuilder()
        .setColor(0xFF6B6B)
        .setTitle('🧪 Aperçu de l\'au revoir');
      try {
        const ctx = { member, guild: interaction.guild };
        const text = resolveWelcomePlaceholders(cfg.message || '**{username}** a quitté le serveur.', ctx);
        if (cfg.imageStyle && cfg.imageStyle !== 'off') {
          const buf = await renderWelcomeImage(member, interaction.guild, { ...cfg, imageText: cfg.imageText || 'AU REVOIR' });
          payloadEmbed.setImage('attachment://farewell-preview.png');
          return interaction.editReply({
            embeds: [payloadEmbed.setDescription(text.slice(0, 4000))],
            files: [new AttachmentBuilder(buf, { name: 'farewell-preview.png' })],
          });
        }
        payloadEmbed.setDescription(text.slice(0, 4000)).setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 128 }));
        return interaction.editReply({ embeds: [payloadEmbed] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Échec de l\'aperçu', err.message)] });
      }
    }
  },

  // ─── Menus déroulants ────────────────────────────────────────────────────────
  async handleSelect(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur**.')], ephemeral: true });
    }
    const cfg = await getOrCreateConfig(interaction.guildId);
    const value = interaction.values[0];

    if (interaction.customId === 'fwells_channel') {
      cfg.channelId = value;
      await cfg.save();
      await interaction.update({ embeds: [successEmbed('Salon enregistré', `Les au-revoirs seront postés dans <#${value}>.`)], components: [] });
      return;
    }

    if (interaction.customId === 'fwells_render') {
      cfg.renderStyle = value;
      await cfg.save();
      await interaction.update({ embeds: [successEmbed('Rendu enregistré', value === 'plain' ? 'Message brut.' : 'Embed riche.')], components: [] });
      return;
    }

    if (interaction.customId === 'fwells_image') {
      cfg.imageStyle = value;
      await cfg.save();
      await interaction.update({ embeds: [successEmbed('Image enregistrée', value === 'off' ? 'Aucune image.' : `Style : **${value}**.`)], components: [] });
      return;
    }
  },

  // ─── Modaux ──────────────────────────────────────────────────────────────────
  async handleModal(interaction) {
    const id = interaction.customId;
    const cfg = await getOrCreateConfig(interaction.guildId);

    if (id === 'fwellm_message') {
      cfg.message = interaction.fields.getTextInputValue('fwell_message');
      await cfg.save();
      await interaction.reply({ embeds: [successEmbed('Message mis à jour', `>>> ${cfg.message.slice(0, 500)}`)], ephemeral: true });
      return;
    }

    if (id === 'fwellm_title') {
      const v = interaction.fields.getTextInputValue('fwell_title').trim();
      cfg.embedTitle = v || '👋 Au revoir';
      await cfg.save();
      await interaction.reply({ embeds: [successEmbed('Titre mis à jour', `Nouveau titre : **${cfg.embedTitle}**`)], ephemeral: true });
      return;
    }

    if (id === 'fwellm_color') {
      const v = interaction.fields.getTextInputValue('fwell_color').trim();
      if (!HEX_REGEX.test(v)) {
        return interaction.reply({ embeds: [errorEmbed('Couleur invalide', 'Format attendu : `#RRGGBB` (ex : `#FF6B6B`).')], ephemeral: true });
      }
      cfg.embedColor = v;
      await cfg.save();
      await interaction.reply({ embeds: [successEmbed('Couleur mise à jour', `Nouvelle couleur : **${v}**`)], ephemeral: true });
      return;
    }
  },
};
