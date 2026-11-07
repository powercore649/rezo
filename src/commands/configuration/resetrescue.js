// commands/configuration/resetrescue.js — Réinitialise le système de récupération en cas de blocage
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const ServerRescue = require('../../models/ServerRescue');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');
const { isBotOwner } = require('../../utils/extraOwnerCheck');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('resetrescue')
    .setDescription('🔓 Réinitialise le verrouillage du système de récupération (Urgence)')
    .setDefaultMemberPermissions(0)
    .setDMPermission(false),

  async execute(interaction) {
    const guild = interaction.guild;
    
    // Seul le propriétaire du serveur OU les bot owners peuvent utiliser cette commande
    const isOwner = interaction.user.id === guild.ownerId;
    const isBotAdmin = isBotOwner(interaction.user.id);

    if (!isOwner && !isBotAdmin) {
      return interaction.reply({
        embeds: [errorEmbed(
          '🔒 Accès refusé',
          'Seul le **propriétaire du serveur Discord** ou les **administrateurs du bot** peuvent réinitialiser le système.\n\n' +
          `Propriétaire actuel : <@${guild.ownerId}>`
        )],
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const rescue = await ServerRescue.findOne({ guildId: guild.id });

      if (!rescue) {
        return interaction.editReply({
          embeds: [errorEmbed(
            '❌ Système non configuré',
            'Ce serveur n\'a pas de système de récupération configuré.\n\nUtilisez `/setuprescue` pour le configurer.'
          )]
        });
      }

      // Réinitialiser les tentatives échouées et le verrouillage
      const wasLocked = rescue.lockedUntil && new Date() < rescue.lockedUntil;
      
      rescue.failedAttempts = 0;
      rescue.lastFailedAttempt = null;
      rescue.lockedUntil = null;
      
      await rescue.save();

      const embed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('🔓 Système déverrouillé')
        .setDescription(
          `Le système de récupération a été réinitialisé avec succès.\n\n` +
          `**Actions effectuées :**\n` +
          `✅ Compteur de tentatives échouées remis à zéro\n` +
          `✅ Verrouillage temporaire supprimé${wasLocked ? ' (le système était verrouillé)' : ''}\n\n` +
          `**Le système est maintenant accessible.**\n\n` +
          `Vous pouvez utiliser \`/claimserver\` avec votre clé de récupération et code 2FA.`
        )
        .addFields(
          {
            name: '⚠️ Important',
            value: 
              '• Cette commande ne supprime PAS le système de récupération\n' +
              '• Elle déverrouille uniquement l\'accès après trop de tentatives\n' +
              '• Votre clé de récupération et secret 2FA restent inchangés'
          }
        )
        .setFooter({ text: `Réinitialisé par ${interaction.user.username}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      // Log dans le salon de logs si configuré
      const Server = require('../../models/Server');
      const serverConfig = await Server.findOne({ guildId: guild.id });
      
      if (serverConfig?.logChannelId) {
        try {
          const logChannel = await guild.channels.fetch(serverConfig.logChannelId);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setColor(COLORS.warning)
              .setTitle('🔓 Système de récupération réinitialisé')
              .setDescription(
                `Le système de récupération a été déverrouillé.`
              )
              .addFields(
                { name: '👤 Par', value: `<@${interaction.user.id}>`, inline: true },
                { name: '📅 Date', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }
              )
              .setTimestamp();
            
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          console.error('Erreur log reset rescue:', err);
        }
      }

    } catch (error) {
      console.error('Erreur réinitialisation rescue:', error);
      return interaction.editReply({
        embeds: [errorEmbed(
          '❌ Erreur',
          'Une erreur est survenue lors de la réinitialisation.\n\nRéessayez dans quelques instants.'
        )]
      });
    }
  }
};
