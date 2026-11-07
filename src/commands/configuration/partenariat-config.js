// commands/partenariat-config.js — Configure le salon et personnalise
// intégralement l'embed d'annonce automatique du système de partenariats
// (voir /partenariat). Utilise le module partagé utils/partnerEmbed pour
// que l'aperçu soit garanti identique au message réel.
const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const Server = require('../../models/Server');
const { successEmbed, errorEmbed, COLORS } = require('../../utils/embeds');
const {
  AVAILABLE_VARIABLES, HEX_REGEX, URL_REGEX,
  buildPartnerValues, buildPartnerEmbed, applyPlaceholders,
} = require('../../utils/partnerEmbed');

const DEFAULTS = {
  partnerChannelId: null,
  partnerSubmitChannelId: null,
  partnerTitle: '🤝 Nouveau partenariat !',
  partnerMessage: "Merci {user} d'avoir effectué un nouveau partenariat avec nous ! 🎉",
  partnerColor: '#7c6cf0',
  partnerFooter: '',
  partnerThumbnail: 'avatar',
  partnerImage: null,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('partenariat-config')
    .setDescription('⚙️ Configurer les annonces automatiques de partenariat')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc.setName('definir')
        .setDescription("Définir le salon et personnaliser l'embed d'annonce")
        .addChannelOption((o) =>
          o.setName('salon').setDescription('Salon où poster les annonces de partenariat').setRequired(true).addChannelTypes(ChannelType.GuildText))
        .addChannelOption((o) =>
          o.setName('salon_soumission').setDescription('Salon surveillé : poster un lien d\'invite ici déclenche l\'annonce automatiquement').setRequired(false).addChannelTypes(ChannelType.GuildText))
        .addStringOption((o) => o.setName('titre').setDescription("Titre de l'embed").setRequired(false))
        .addStringOption((o) => o.setName('message').setDescription('Description — voir /partenariat-config variables').setRequired(false))
        .addStringOption((o) => o.setName('couleur').setDescription('Couleur hex, ex: #7c6cf0').setRequired(false))
        .addStringOption((o) => o.setName('footer').setDescription("Texte de pied d'embed (accepte les variables)").setRequired(false))
        .addStringOption((o) => o.setName('miniature').setDescription('"avatar", "aucune", ou une URL d\'image').setRequired(false))
        .addStringOption((o) => o.setName('image').setDescription("URL d'une grande image/bannière (optionnel)").setRequired(false)))
    .addSubcommand((sc) => sc.setName('voir').setDescription('Voir la configuration actuelle'))
    .addSubcommand((sc) => sc.setName('builder').setDescription('Éditeur interactif (fenêtre pré-remplie) pour personnaliser l\'embed'))
    .addSubcommand((sc) => sc.setName('variables').setDescription('Lister les variables disponibles pour personnaliser le message'))
    .addSubcommand((sc) => sc.setName('reinitialiser').setDescription('Revenir aux réglages par défaut')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // ── /partenariat-config variables ──────────────────────────────────
    if (sub === 'variables') {
      const list = Object.entries(AVAILABLE_VARIABLES)
        .map(([key, desc]) => `\`${key}\` — ${desc}`)
        .join('\n');
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('🧩 Variables disponibles')
        .setDescription(list)
        .setFooter({ text: 'Utilisables dans le titre, le message et le footer (/partenariat-config definir)' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    let server = await Server.findOne({ guildId });
    if (!server) server = await Server.create({ guildId, guildName: interaction.guild.name });

    // ── /partenariat-config builder ────────────────────────────────────
    if (sub === 'builder') {
      const modal = new ModalBuilder().setCustomId('partner_config_modal').setTitle('🎨 Éditeur d\'embed — Partenariats');

      const titreInput = new TextInputBuilder()
        .setCustomId('partner_titre')
        .setLabel('Titre de l\'embed')
        .setStyle(TextInputStyle.Short)
        .setValue(server.partnerTitle || '')
        .setMaxLength(256)
        .setRequired(true);

      const messageInput = new TextInputBuilder()
        .setCustomId('partner_message')
        .setLabel('Message (voir /partenariat-config variables)')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(server.partnerMessage || '')
        .setMaxLength(2000)
        .setRequired(true);

      const couleurInput = new TextInputBuilder()
        .setCustomId('partner_couleur')
        .setLabel('Couleur hex (ex: #7c6cf0)')
        .setStyle(TextInputStyle.Short)
        .setValue(server.partnerColor || '#7c6cf0')
        .setMaxLength(7)
        .setRequired(true);

      const footerInput = new TextInputBuilder()
        .setCustomId('partner_footer')
        .setLabel('Footer (optionnel, accepte les variables)')
        .setStyle(TextInputStyle.Short)
        .setValue(server.partnerFooter || '')
        .setMaxLength(2048)
        .setRequired(false);

      const miniatureInput = new TextInputBuilder()
        .setCustomId('partner_miniature')
        .setLabel('Miniature : "avatar", "aucune" ou une URL')
        .setStyle(TextInputStyle.Short)
        .setValue(server.partnerThumbnail || 'avatar')
        .setMaxLength(500)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(titreInput),
        new ActionRowBuilder().addComponents(messageInput),
        new ActionRowBuilder().addComponents(couleurInput),
        new ActionRowBuilder().addComponents(footerInput),
        new ActionRowBuilder().addComponents(miniatureInput),
      );

      return interaction.showModal(modal);
    }

    // ── /partenariat-config voir ───────────────────────────────────────
    if (sub === 'voir') {
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('⚙️ Configuration des partenariats')
        .addFields(
          { name: 'Salon d\'annonce', value: server.partnerChannelId ? `<#${server.partnerChannelId}>` : '*Non défini*' },
          { name: 'Salon de soumission (auto)', value: server.partnerSubmitChannelId ? `<#${server.partnerSubmitChannelId}>` : '*Non défini — détection automatique désactivée*' },
          { name: 'Titre', value: server.partnerTitle || '*Non défini*' },
          { name: 'Message', value: server.partnerMessage || '*Non défini*' },
          { name: 'Couleur', value: server.partnerColor },
          { name: 'Footer', value: server.partnerFooter || '*Aucun*' },
          { name: 'Miniature', value: server.partnerThumbnail },
          { name: 'Image', value: server.partnerImage || '*Aucune*' },
          { name: 'Total partenariats (serveur)', value: `${server.totalPartnerships || 0}` },
        )
        .setFooter({ text: '/partenariat-config variables pour la liste des variables disponibles' });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // ── /partenariat-config reinitialiser ──────────────────────────────
    if (sub === 'reinitialiser') {
      Object.assign(server, DEFAULTS);
      await server.save();
      return interaction.reply({
        embeds: [successEmbed('Réinitialisé', 'La configuration des partenariats est revenue aux réglages par défaut. Le compteur total est conservé.')],
        ephemeral: true,
      });
    }

    // ── /partenariat-config definir ────────────────────────────────────
    const salon = interaction.options.getChannel('salon');
    const salonSoumission = interaction.options.getChannel('salon_soumission');
    const titre = interaction.options.getString('titre');
    const message = interaction.options.getString('message');
    const couleur = interaction.options.getString('couleur');
    const footer = interaction.options.getString('footer');
    const miniature = interaction.options.getString('miniature');
    const image = interaction.options.getString('image');

    if (couleur && !HEX_REGEX.test(couleur)) {
      return interaction.reply({
        embeds: [errorEmbed('Couleur invalide', 'Utilise un code hexadécimal du type `#7c6cf0`.')],
        ephemeral: true,
      });
    }
    if (miniature && !['avatar', 'aucune'].includes(miniature.toLowerCase()) && !URL_REGEX.test(miniature)) {
      return interaction.reply({
        embeds: [errorEmbed('Miniature invalide', 'Utilise `avatar`, `aucune`, ou une URL commençant par http(s)://.')],
        ephemeral: true,
      });
    }
    if (image && !URL_REGEX.test(image)) {
      return interaction.reply({
        embeds: [errorEmbed('Image invalide', "L'URL doit commencer par http(s)://.")],
        ephemeral: true,
      });
    }

    server.partnerChannelId = salon.id;
    if (salonSoumission) server.partnerSubmitChannelId = salonSoumission.id;
    if (titre) server.partnerTitle = titre;
    if (message) server.partnerMessage = message;
    if (couleur) server.partnerColor = couleur;
    if (footer !== null) server.partnerFooter = footer || '';
    if (miniature) {
      const m = miniature.toLowerCase();
      server.partnerThumbnail = m === 'aucune' ? 'none' : (m === 'avatar' ? 'avatar' : miniature);
    }
    if (image !== null) server.partnerImage = image || null;
    await server.save();

    // Aperçu construit avec le MÊME code que le message réel (utils/partnerEmbed) :
    // ce que l'admin voit ici est garanti identique à ce qui sera posté.
    const previewValues = buildPartnerValues({
      target: interaction.user,
      guild: interaction.guild,
      serveurNom: 'Nom Du Serveur Partenaire',
      inviteLink: 'https://discord.gg/exemple',
      count: 3,
      rang: 1,
      total: (server.totalPartnerships || 0) + 1,
    });
    const preview = buildPartnerEmbed(server, previewValues, interaction.user);
    const existingFooter = server.partnerFooter ? applyPlaceholders(server.partnerFooter, previewValues) : null;
    preview.setFooter({ text: existingFooter ? `${existingFooter} • Aperçu (valeurs fictives)` : 'Aperçu (valeurs fictives)' });

    return interaction.reply({
      content: `✅ Configuration enregistrée. Les annonces seront postées dans <#${salon.id}>. Voici un aperçu :`,
      embeds: [preview],
      ephemeral: true,
    });
  },
};
