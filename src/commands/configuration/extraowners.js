// commands/configuration/extraowners.js — Gestion des Extra Owners du serveur
// Permet au propriétaire du serveur de gérer manuellement les Extra Owners

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');
const { 
  listExtraOwners, 
  addExtraOwner, 
  removeExtraOwner,
  isBotOwner 
} = require('../../utils/extraOwnerCheck');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('extraowners')
    .setDescription('👑 Gérer les Extra Owners du serveur (permissions étendues sur le bot)')
    .setDefaultMemberPermissions(0) // Administrateur uniquement
    .setDMPermission(false)
    .addSubcommand(sub => 
      sub
        .setName('liste')
        .setDescription('Afficher tous les Extra Owners du serveur')
    )
    .addSubcommand(sub =>
      sub
        .setName('ajouter')
        .setDescription('Ajouter un Extra Owner au serveur')
        .addUserOption(option =>
          option
            .setName('utilisateur')
            .setDescription('L\'utilisateur à promouvoir Extra Owner')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('retirer')
        .setDescription('Retirer un Extra Owner du serveur')
        .addUserOption(option =>
          option
            .setName('utilisateur')
            .setDescription('L\'utilisateur à rétrograder')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const guild = interaction.guild;
    const subcommand = interaction.options.getSubcommand();

    // Vérification des permissions : Seul le propriétaire du serveur ou un bot owner peut gérer
    const isOwner = interaction.user.id === guild.ownerId;
    const isBotAdmin = isBotOwner(interaction.user.id);

    if (!isOwner && !isBotAdmin) {
      return interaction.reply({
        embeds: [errorEmbed(
          '🔒 Accès refusé',
          'Seul le **propriétaire du serveur Discord** peut gérer les Extra Owners.\n\n' +
          `Propriétaire actuel : <@${guild.ownerId}>`
        )],
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // ── LISTE ───────────────────────────────────────────────────────────
      if (subcommand === 'liste') {
        const extraOwners = await listExtraOwners(guild.id);

        if (extraOwners.length === 0) {
          const embed = new EmbedBuilder()
            .setColor(COLORS.primary)
            .setTitle('👑 Extra Owners du serveur')
            .setDescription(
              '**Aucun Extra Owner configuré sur ce serveur.**\n\n' +
              'Les Extra Owners sont des utilisateurs avec des permissions étendues sur le bot REZO, ' +
              'similaires au propriétaire du serveur Discord.\n\n' +
              '**Utilisation :**\n' +
              '• `/extraowners ajouter` - Ajouter un Extra Owner\n' +
              '• `/setuprescue` - Configurer le système de récupération 2FA'
            )
            .setFooter({ text: `Serveur : ${guild.name}` });

          return interaction.editReply({ embeds: [embed] });
        }

        const embed = new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('👑 Extra Owners du serveur')
          .setDescription(
            `Ce serveur possède **${extraOwners.length}** Extra Owner(s) :\n\n` +
            extraOwners.map((id, index) => `${index + 1}. <@${id}> (\`${id}\`)`).join('\n')
          )
          .addFields({
            name: 'ℹ️ Information',
            value: 
              'Les Extra Owners ont des permissions étendues sur le bot, ' +
              'y compris la gestion des configurations avancées et l\'accès au système de récupération.'
          })
          .setFooter({ text: `Serveur : ${guild.name} • ${extraOwners.length} Extra Owner(s)` })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── AJOUTER ─────────────────────────────────────────────────────────
      if (subcommand === 'ajouter') {
        const targetUser = interaction.options.getUser('utilisateur');

        // Vérifications
        if (targetUser.bot) {
          return interaction.editReply({
            embeds: [errorEmbed(
              '❌ Action impossible',
              'Vous ne pouvez pas ajouter un bot comme Extra Owner.'
            )]
          });
        }

        if (targetUser.id === guild.ownerId) {
          return interaction.editReply({
            embeds: [errorEmbed(
              '❌ Action inutile',
              'Le propriétaire du serveur Discord possède déjà toutes les permissions.\n\n' +
              'Il n\'a pas besoin d\'être Extra Owner.'
            )]
          });
        }

        // Ajouter l'Extra Owner
        const added = await addExtraOwner(targetUser.id, guild.id);

        if (!added) {
          return interaction.editReply({
            embeds: [errorEmbed(
              '⚠️ Déjà Extra Owner',
              `<@${targetUser.id}> est déjà un Extra Owner de ce serveur.`
            )]
          });
        }

        const embed = new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('✅ Extra Owner ajouté')
          .setDescription(
            `<@${targetUser.id}> a été promu **Extra Owner** sur ce serveur.\n\n` +
            `Cet utilisateur dispose maintenant de permissions étendues sur le bot REZO.`
          )
          .addFields(
            { name: '👤 Utilisateur', value: `<@${targetUser.id}>`, inline: true },
            { name: '🆔 ID', value: `\`${targetUser.id}\``, inline: true },
            { name: '👑 Ajouté par', value: `<@${interaction.user.id}>`, inline: true }
          )
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setFooter({ text: `Serveur : ${guild.name}` })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      // ── RETIRER ─────────────────────────────────────────────────────────
      if (subcommand === 'retirer') {
        const targetUser = interaction.options.getUser('utilisateur');

        // Retirer l'Extra Owner
        const removed = await removeExtraOwner(targetUser.id, guild.id);

        if (!removed) {
          return interaction.editReply({
            embeds: [errorEmbed(
              '⚠️ Pas un Extra Owner',
              `<@${targetUser.id}> n'est pas un Extra Owner de ce serveur.`
            )]
          });
        }

        const embed = new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('✅ Extra Owner retiré')
          .setDescription(
            `<@${targetUser.id}> n'est plus un **Extra Owner** sur ce serveur.\n\n` +
            `Les permissions étendues sur le bot REZO ont été révoquées.`
          )
          .addFields(
            { name: '👤 Utilisateur', value: `<@${targetUser.id}>`, inline: true },
            { name: '🆔 ID', value: `\`${targetUser.id}\``, inline: true },
            { name: '👑 Retiré par', value: `<@${interaction.user.id}>`, inline: true }
          )
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setFooter({ text: `Serveur : ${guild.name}` })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

    } catch (error) {
      console.error('Erreur dans /extraowners:', error);
      return interaction.editReply({
        embeds: [errorEmbed(
          '❌ Erreur',
          'Une erreur est survenue lors de l\'exécution de la commande.\n\n' +
          'Veuillez réessayer dans quelques instants.'
        )]
      });
    }
  }
};
