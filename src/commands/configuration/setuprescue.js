// commands/configuration/setuprescue.js — Configure le système de récupération de serveur
// Génère un secret TOTP (Google Authenticator) + une clé de récupération unique

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const ServerRescue = require('../../models/ServerRescue');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');

// Importations pour TOTP
let authenticator, totp;
try {
  const otplib = require('otplib');
  authenticator = otplib.authenticator;
  totp = otplib.totp;
} catch (err) {
  console.warn('⚠️ otplib non installé — /setuprescue nécessite: npm install otplib qrcode');
}

let QRCode;
try {
  QRCode = require('qrcode');
} catch (err) {
  console.warn('⚠️ qrcode non installé — /setuprescue nécessite: npm install qrcode');
}

// Génère une clé de récupération au format XXXX-XXXX-XXXX-XXXX
function generateRecoveryKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segments = [];
  
  for (let i = 0; i < 4; i++) {
    let segment = '';
    for (let j = 0; j < 4; j++) {
      segment += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    segments.push(segment);
  }
  
  return segments.join('-');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setuprescue')
    .setDescription('🔐 Configure le système de récupération de serveur (2FA + clé de récupération)')
    .setDefaultMemberPermissions(0) // Administrateur uniquement
    .setDMPermission(false),

  async execute(interaction) {
    // Vérification des dépendances
    if (!authenticator || !QRCode) {
      return interaction.reply({
        embeds: [errorEmbed(
          '❌ Dépendances manquantes',
          'Le système de récupération nécessite l\'installation des modules `otplib` et `qrcode`.\n\nContactez l\'administrateur du bot.'
        )],
        ephemeral: true
      });
    }

    // Seul le propriétaire du serveur peut configurer le système
    const guild = interaction.guild;
    if (interaction.user.id !== guild.ownerId) {
      return interaction.reply({
        embeds: [errorEmbed(
          '🔒 Accès refusé',
          'Seul le **propriétaire du serveur Discord** peut configurer le système de récupération.\n\n' +
          `Propriétaire actuel : <@${guild.ownerId}>`
        )],
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Vérifier si le système est déjà configuré
      const existing = await ServerRescue.findOne({ guildId: guild.id });
      
      if (existing) {
        const embed = new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle('⚠️ Système déjà configuré')
          .setDescription(
            'Votre serveur possède **déjà** un système de récupération actif.\n\n' +
            '**Votre clé de récupération a été générée lors de la première configuration et ne peut pas être régénérée.**\n\n' +
            '⚠️ **IMPORTANT** : Si vous avez perdu votre clé de 16 caractères, vous ne pourrez **PAS** récupérer votre serveur en cas de perte de compte Discord.\n\n' +
            'Pour réinitialiser complètement le système (nouvelle clé + nouveau secret 2FA), contactez le support du bot.'
          )
          .addFields(
            { name: '📅 Configuré le', value: `<t:${Math.floor(existing.createdAt.getTime() / 1000)}:F>`, inline: true },
            { name: '👤 Par', value: `<@${existing.originalOwnerId}>`, inline: true },
            { name: '🔐 Statut', value: existing.enabled ? '✅ Actif' : '❌ Désactivé', inline: true }
          )
          .setFooter({ text: 'Conservez précieusement votre clé de récupération !' });
        
        return interaction.editReply({ embeds: [embed] });
      }

      // Générer le secret TOTP
      const secret = authenticator.generateSecret();
      const recoveryKey = generateRecoveryKey();

      // Générer l'URL pour Google Authenticator / Authy
      const otpauthUrl = authenticator.keyuri(
        guild.name,
        'REZO Security',
        secret
      );

      // Générer le QR Code
      const qrCodeBuffer = await QRCode.toBuffer(otpauthUrl);
      const qrAttachment = new AttachmentBuilder(qrCodeBuffer, { name: 'rezo-2fa-qrcode.png' });

      // Sauvegarder dans la base de données
      const rescue = new ServerRescue({
        guildId: guild.id,
        originalOwnerId: interaction.user.id,
        totpSecret: secret,
        recoveryKey: recoveryKey,
        currentOwnerId: interaction.user.id,
        enabled: true
      });

      await rescue.save();

      // Créer l'embed de confirmation
      const embed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('🔐 Système de récupération configuré !')
        .setDescription(
          '**Votre serveur est maintenant protégé par le système de récupération REZO.**\n\n' +
          'En cas de **terminaison de votre compte Discord**, vous pourrez récupérer vos permissions "Extra Owner" depuis un nouveau compte.\n\n' +
          '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        )
        .addFields(
          {
            name: '📱 ÉTAPE 1 : Configurer votre application 2FA',
            value: 
              '1. Téléchargez **Google Authenticator** ou **Authy** sur votre téléphone\n' +
              '2. Scannez le QR Code ci-dessous avec l\'application\n' +
              '3. L\'application générera un code à 6 chiffres qui change toutes les 30 secondes'
          },
          {
            name: '🔑 ÉTAPE 2 : Sauvegarder votre clé de récupération',
            value: 
              `\`\`\`\n${recoveryKey}\n\`\`\`\n` +
              '⚠️ **CRITIQUE** : Copiez cette clé et conservez-la dans un endroit **ULTRA SÉCURISÉ** :\n' +
              '• Gestionnaire de mots de passe (Bitwarden, 1Password, etc.)\n' +
              '• Coffre-fort physique\n' +
              '• Document chiffré hors ligne\n\n' +
              '**Cette clé ne sera JAMAIS affichée à nouveau.**'
          },
          {
            name: '⚠️ Règles de sécurité ABSOLUES',
            value: 
              '❌ **NE PARTAGEZ JAMAIS** cette clé avec qui que ce soit\n' +
              '❌ **NE LA POSTEZ JAMAIS** en ligne (Discord, email, etc.)\n' +
              '❌ **NE LA PERDEZ PAS** — il est impossible d\'en générer une nouvelle\n' +
              '✅ **SAUVEGARDEZ-LA** immédiatement dans un endroit sûr'
          },
          {
            name: '🆘 Comment récupérer votre serveur ?',
            value: 
              'Si votre compte Discord est terminé :\n' +
              '1. Créez un nouveau compte Discord\n' +
              '2. Rejoignez votre serveur\n' +
              '3. Utilisez `/claimserver` avec votre clé + code 2FA\n' +
              '4. Vos permissions "Extra Owner" seront restaurées'
          }
        )
        .setImage('attachment://rezo-2fa-qrcode.png')
        .setFooter({ 
          text: '⚠️ Ce message est privé et disparaîtra. Sauvegardez MAINTENANT votre clé de récupération !' 
        })
        .setTimestamp();

      // Envoyer aussi un MP de backup (si possible)
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('🔐 Backup de votre clé de récupération REZO')
          .setDescription(
            `**Serveur :** ${guild.name}\n\n` +
            `**Clé de récupération :**\n\`\`\`\n${recoveryKey}\n\`\`\`\n\n` +
            '⚠️ Conservez cette clé dans un endroit ultra sécurisé.\n' +
            '**Elle ne peut PAS être régénérée.**'
          )
          .setTimestamp();

        await interaction.user.send({ embeds: [dmEmbed] });
      } catch (err) {
        // L'utilisateur a peut-être bloqué les MPs
        console.log('Impossible d\'envoyer le backup par MP à', interaction.user.tag);
      }

      return interaction.editReply({ 
        embeds: [embed], 
        files: [qrAttachment]
      });

    } catch (error) {
      console.error('Erreur lors de la configuration du système de récupération:', error);
      return interaction.editReply({
        embeds: [errorEmbed(
          '❌ Erreur',
          'Une erreur est survenue lors de la configuration du système de récupération.\n\n' +
          'Veuillez réessayer dans quelques instants.'
        )]
      });
    }
  }
};
