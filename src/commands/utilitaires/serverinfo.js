// commands/utilitaires/serverinfo.js — Informations détaillées du serveur
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { COLORS } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('📊 Affiche les informations détaillées du serveur'),

  async execute(interaction) {
    const { guild } = interaction;

    // Récupérer toutes les données
    const owner = await guild.fetchOwner();
    const members = await guild.members.fetch();
    
    // Statistiques membres
    const totalMembers = guild.memberCount;
    const humans = members.filter(m => !m.user.bot).size;
    const bots = members.filter(m => m.user.bot).size;
    const onlineMembers = members.filter(m => m.presence?.status !== 'offline' && !m.user.bot).size;

    // Statistiques salons
    const channels = guild.channels.cache;
    const textChannels = channels.filter(c => c.type === 0).size; // Text channels
    const voiceChannels = channels.filter(c => c.type === 2).size; // Voice channels
    const categories = channels.filter(c => c.type === 4).size; // Categories
    const announcements = channels.filter(c => c.type === 5).size; // Announcement channels
    const threads = guild.channels.cache.filter(c => c.isThread()).size;

    // Statistiques rôles et emojis
    const roles = guild.roles.cache.size - 1; // -1 pour exclure @everyone
    const emojis = guild.emojis.cache.size;
    const staticEmojis = guild.emojis.cache.filter(e => !e.animated).size;
    const animatedEmojis = guild.emojis.cache.filter(e => e.animated).size;

    // Boosts
    const boostLevel = guild.premiumTier;
    const boostCount = guild.premiumSubscriptionCount || 0;
    const boostEmoji = ['❌', '🥉', '🥈', '🥇'][boostLevel];

    // Niveaux de vérification
    const verificationLevels = {
      0: 'Aucun',
      1: 'Faible',
      2: 'Moyen',
      3: 'Élevé',
      4: 'Très élevé'
    };

    // Filtres de contenu explicite
    const explicitFilters = {
      0: 'Désactivé',
      1: 'Membres sans rôle',
      2: 'Tous les membres'
    };

    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`📊 Informations sur ${guild.name}`)
      .setThumbnail(guild.iconURL({ dynamic: true, size: 512 }))
      .addFields(
        {
          name: '👑 Propriétaire',
          value: `${owner.user.tag}\n<@${owner.id}>`,
          inline: true
        },
        {
          name: '📅 Création',
          value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>\n<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`,
          inline: true
        },
        {
          name: '🆔 ID du serveur',
          value: `\`${guild.id}\``,
          inline: true
        },
        {
          name: '👥 Membres',
          value: 
            `**Total:** ${totalMembers}\n` +
            `**Humains:** ${humans}\n` +
            `**Bots:** ${bots}\n` +
            `**En ligne:** ${onlineMembers}`,
          inline: true
        },
        {
          name: '💬 Salons',
          value:
            `**Total:** ${channels.size}\n` +
            `📝 Texte: ${textChannels}\n` +
            `🔊 Vocal: ${voiceChannels}\n` +
            `📁 Catégories: ${categories}\n` +
            `📢 Annonces: ${announcements}\n` +
            `🧵 Fils: ${threads}`,
          inline: true
        },
        {
          name: '🎨 Autres',
          value:
            `**Rôles:** ${roles}\n` +
            `**Emojis:** ${emojis}\n` +
            `└ Statiques: ${staticEmojis}\n` +
            `└ Animés: ${animatedEmojis}`,
          inline: true
        },
        {
          name: `${boostEmoji} Niveau de boost`,
          value: 
            `**Niveau:** ${boostLevel}\n` +
            `**Boosts:** ${boostCount}`,
          inline: true
        },
        {
          name: '🔒 Sécurité',
          value:
            `**Vérification:** ${verificationLevels[guild.verificationLevel]}\n` +
            `**Filtre explicite:** ${explicitFilters[guild.explicitContentFilter]}\n` +
            `**2FA requis:** ${guild.mfaLevel === 1 ? 'Oui' : 'Non'}`,
          inline: true
        },
        {
          name: '🌍 Région & Langue',
          value:
            `**Langue préférée:** ${guild.preferredLocale}\n` +
            `**Vanity URL:** ${guild.vanityURLCode ? `discord.gg/${guild.vanityURLCode}` : 'Aucune'}`,
          inline: true
        }
      )
      .setFooter({ text: `Demandé par ${interaction.user.username}` })
      .setTimestamp();

    // Ajouter la bannière si elle existe
    if (guild.banner) {
      embed.setImage(guild.bannerURL({ size: 1024 }));
    }

    await interaction.reply({ embeds: [embed] });
  }
};
