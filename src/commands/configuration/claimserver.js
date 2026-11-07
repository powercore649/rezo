// commands/configuration/claimserver.js — Récupère les permissions "Extra Owner" après perte de compte
// Nécessite : Clé de récupération (16 caractères) + Code TOTP (6 chiffres)

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const ServerRescue = require('../../models/ServerRescue');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');

// Importation TOTP
let totp;
try {
  const otplib = require('otplib');
  totp = otplib.totp;
} catch (err) {
  console.warn('⚠️ otplib non installé — /claimserver nécessite: npm install otplib');
}

// Délai de verrouillage après trop de tentatives échouées (en minutes)
const LOCKOUT_DURATION = 30;
const MAX_FAILED_ATTEMPTS = 5;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('claimserver')
    .setDescription('🆘 Récupère vos permissions Extra Owner depuis un nouveau compte Discord')
    .addStringOption(option =>
      option
        .setName('cle')
        .setDescription('Votre clé de récupération (format: XXXX-XXXX-XXXX-XXXX)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('code')
        .setDescription('Code 2FA actuel depuis Google Authenticator / Authy (6 chiffres)')
        .setRequired(true)
        .setMinLength(6)
        .setMaxLength(6)
    )
    .setDMPermission(false),

  async execute(interaction) {
    // Vérification des dépendances
    if (!totp) {
      return interaction.reply({
        embeds: [errorEmbed(
          '❌ Dépendances manquantes',
          'Le système de récupération nécessite l\'installation du module `otplib`.\n\nContactez l\'administrateur du bot.'
        )],
        ephemeral: true
      });
    }

    const recoveryKey = interaction.options.getString('cle').toUpperCase().trim();
    const code = interaction.options.getString('code').trim();

    await interaction.deferReply({ ephemeral: true });

    try {
      // Rechercher le système de récupération pour ce serveur
      const rescue = await ServerRescue.findOne({ guildId: interaction.guild.id });

      if (!rescue) {
        return interaction.editReply({
          embeds: [errorEmbed(
            '❌ Système non configuré',
            'Ce serveur n\'a pas de système de récupération configuré.\n\n' +
            'Le propriétaire du serveur doit d\'abord utiliser `/setuprescue` pour activer cette fonctionnalité.'
          )]
        });
      }

      if (!rescue.enabled) {
        return interaction.editReply({
          embeds: [errorEmbed(
            '🔒 Système désactivé',
            'Le système de récupération de ce serveur est actuellement désactivé.\n\n' +
            'Contactez le support du bot pour plus d\'informations.'
          )]
        });
      }

      // Vérifier le verrouillage temporaire
      if (rescue.lockedUntil && new Date() < rescue.lockedUntil) {
        const unlockTime = Math.floor(rescue.lockedUntil.getTime() / 1000);
        return interaction.editReply({
          embeds: [errorEmbed(
            '🔒 Système temporairement verrouillé',
            `Trop de tentatives échouées ont été détectées.\n\n` +
            `Le système sera déverrouillé <t:${unlockTime}:R>.\n\n` +
            `**Temps de déverrouillage :** <t:${unlockTime}:F>`
          )]
        });
      }

      // Vérifier la clé de récupération
      if (recoveryKey !== rescue.recoveryKey) {
        // Incrémenter le compteur d'échecs
        rescue.failedAttempts += 1;
        rescue.lastFailedAttempt = new Date();

        // Verrouiller si trop de tentatives
        if (rescue.failedAttempts >= MAX_FAILED_ATTEMPTS) {
          rescue.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION * 60 * 1000);
          await rescue.save();

          return interaction.editReply({
            embeds: [errorEmbed(
              '🔒 Système verrouillé',
              `Trop de tentatives échouées (${MAX_FAILED_ATTEMPTS}).\n\n` +
              `Le système est verrouillé pendant **${LOCKOUT_DURATION} minutes** par mesure de sécurité.\n\n` +
              `Temps de déverrouillage : <t:${Math.floor(rescue.lockedUntil.getTime() / 1000)}:F>`
            )]
          });
        }

        await rescue.save();

        return interaction.editReply({
          embeds: [errorEmbed(
            '❌ Clé de récupération invalide',
            `La clé de récupération fournie est **incorrecte**.\n\n` +
            `**Tentatives restantes :** ${MAX_FAILED_ATTEMPTS - rescue.failedAttempts}\n\n` +
            `⚠️ Après ${MAX_FAILED_ATTEMPTS} tentatives échouées, le système sera verrouillé pendant ${LOCKOUT_DURATION} minutes.`
          )]
        });
      }

      // Vérifier le code TOTP avec fenêtre de tolérance (accepte ±1 période = 30s avant/après)
      const isValidCode = totp.check(code, rescue.totpSecret) || 
                          totp.verify({ token: code, secret: rescue.totpSecret, window: 2 });
      
      if (!isValidCode) {
        // Incrémenter le compteur d'échecs
        rescue.failedAttempts += 1;
        rescue.lastFailedAttempt = new Date();

        // Verrouiller si trop de tentatives
        if (rescue.failedAttempts >= MAX_FAILED_ATTEMPTS) {
          rescue.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION * 60 * 1000);
          await rescue.save();

          return interaction.editReply({
            embeds: [errorEmbed(
              '🔒 Système verrouillé',
              `Trop de tentatives échouées (${MAX_FAILED_ATTEMPTS}).\n\n` +
              `Le système est verrouillé pendant **${LOCKOUT_DURATION} minutes** par mesure de sécurité.\n\n` +
              `Temps de déverrouillage : <t:${Math.floor(rescue.lockedUntil.getTime() / 1000)}:F>`
            )]
          });
        }

        await rescue.save();

        return interaction.editReply({
          embeds: [errorEmbed(
            '❌ Code 2FA invalide',
            `Le code d'authentification est **incorrect** ou **expiré**.\n\n` +
            `**Tentatives restantes :** ${MAX_FAILED_ATTEMPTS - rescue.failedAttempts}\n\n` +
            `✅ Vérifiez que :\n` +
            `• Votre code provient bien de Google Authenticator / Authy\n` +
            `• L'heure de votre téléphone est synchronisée (essentiel pour TOTP)\n` +
            `• Le code n'a pas expiré (ils changent toutes les 30 secondes)\n\n` +
            `⚠️ Après ${MAX_FAILED_ATTEMPTS} tentatives échouées, le système sera verrouillé pendant ${LOCKOUT_DURATION} minutes.`
          )]
        });
      }

      // ✅ AUTHENTIFICATION RÉUSSIE ✅
      
      // Vérifier que l'utilisateur n'est pas déjà Extra Owner
      const Server = require('../../models/Server');
      let serverConfig = await Server.findOne({ guildId: interaction.guild.id });
      
      const alreadyExtraOwner = serverConfig?.extraOwners?.includes(interaction.user.id);
      
      // Réinitialiser les tentatives échouées
      rescue.failedAttempts = 0;
      rescue.lastFailedAttempt = null;
      rescue.lockedUntil = null;

      // Enregistrer la réclamation dans l'historique
      rescue.claimHistory.push({
        userId: interaction.user.id,
        claimedAt: new Date(),
        success: true
      });

      // Mettre à jour le propriétaire actuel
      const previousOwner = rescue.currentOwnerId;
      rescue.currentOwnerId = interaction.user.id;

      await rescue.save();
      
      // Ajouter l'utilisateur aux Extra Owners du serveur (seulement s'il ne l'est pas déjà)
      if (!alreadyExtraOwner) {
        if (!serverConfig) {
          // Créer la configuration du serveur si elle n'existe pas
          serverConfig = new Server({
            guildId: interaction.guild.id,
            guildName: interaction.guild.name,
            extraOwners: [interaction.user.id]
          });
        } else {
          // Ajouter l'utilisateur aux Extra Owners
          if (!serverConfig.extraOwners) {
            serverConfig.extraOwners = [];
          }
          serverConfig.extraOwners.push(interaction.user.id);
        }
        
        await serverConfig.save();
      }
      
      // Créer l'embed de succès
      const successMsg = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('✅ Récupération réussie !')
        .setDescription(
          `**Bienvenue, <@${interaction.user.id}> !**\n\n` +
          (alreadyExtraOwner 
            ? `✅ Vous êtes déjà **Extra Owner** sur ce serveur.\n\nVotre authentification a été validée avec succès !` 
            : `Vos permissions **Extra Owner** ont été restaurées avec succès sur ce serveur.\n\nVous pouvez maintenant gérer le bot REZO comme auparavant.`)
        )
        .addFields(
          { 
            name: '📋 Informations de récupération', 
            value: 
              `**Serveur :** ${interaction.guild.name}\n` +
              `**Nouveau compte :** <@${interaction.user.id}>\n` +
              `**Ancien compte :** <@${previousOwner}>\n` +
              `**Récupéré le :** <t:${Math.floor(Date.now() / 1000)}:F>`
          },
          {
            name: '🔐 Sécurité',
            value: 
              `✅ Clé de récupération : **Validée**\n` +
              `✅ Code 2FA : **Validé**\n` +
              `✅ Authentification : **Complète**\n` +
              `✅ Permissions Extra Owner : **Accordées**`
          },
          {
            name: '⚠️ Important',
            value: 
              `• Cette action a été enregistrée dans les logs du système\n` +
              `• Votre clé de récupération reste valide pour de futures récupérations\n` +
              `• Conservez toujours votre clé et votre accès 2FA en lieu sûr`
          }
        )
        .setFooter({ 
          text: `Réclamation #${rescue.claimHistory.length} • Système REZO Security` 
        })
        .setTimestamp();

      // Log dans un salon si configuré
      if (serverConfig?.logChannelId) {
        try {
          const logChannel = await interaction.guild.channels.fetch(serverConfig.logChannelId);
          if (logChannel) {
            const logEmbed = new EmbedBuilder()
              .setColor(COLORS.warning)
              .setTitle('🔐 Récupération de serveur effectuée')
              .setDescription(
                `Le système de récupération a été utilisé avec succès.`
              )
              .addFields(
                { name: '👤 Nouveau propriétaire', value: `<@${interaction.user.id}>`, inline: true },
                { name: '👤 Ancien propriétaire', value: `<@${previousOwner}>`, inline: true },
                { name: '📅 Date', value: `<t:${Math.floor(Date.now() / 1000)}:F>` }
              )
              .setTimestamp();
            
            await logChannel.send({ embeds: [logEmbed] });
          }
        } catch (err) {
          console.error('Erreur lors du log de récupération:', err);
        }
      }

      return interaction.editReply({ embeds: [successMsg] });

    } catch (error) {
      console.error('Erreur lors de la récupération du serveur:', error);
      return interaction.editReply({
        embeds: [errorEmbed(
          '❌ Erreur',
          'Une erreur est survenue lors de la récupération du serveur.\n\n' +
          'Veuillez réessayer dans quelques instants ou contactez le support.'
        )]
      });
    }
  }
};
