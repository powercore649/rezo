// events/partnerConfigModal.js — Traite la soumission de la modale ouverte
// par /partenariat-config builder.
//
// Fichier INDÉPENDANT de events/interactionCreate.js : comme pour
// partnerAutoDetect.js, discord.js/Node autorisent plusieurs handlers pour
// le même événement ('interactionCreate'), donc ce fichier s'ajoute au
// chargement automatique SANS toucher au routage existant. Il ne traite que
// les soumissions dont le customId est exactement 'partner_config_modal' et
// ignore silencieusement tout le reste (aucun risque d'interférer avec les
// autres modales du bot).
const Server = require('../../models/Server');
const { errorEmbed, successEmbed } = require('../../utils/embeds');
const { HEX_REGEX, URL_REGEX, buildPartnerValues, buildPartnerEmbed, applyPlaceholders } = require('../../utils/partnerEmbed');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    try {
      if (!interaction.isModalSubmit() || interaction.customId !== 'partner_config_modal') return;
      if (!interaction.guild) return;

      const titre = interaction.fields.getTextInputValue('partner_titre').trim();
      const message = interaction.fields.getTextInputValue('partner_message').trim();
      const couleur = interaction.fields.getTextInputValue('partner_couleur').trim();
      const footer = interaction.fields.getTextInputValue('partner_footer').trim();
      const miniature = interaction.fields.getTextInputValue('partner_miniature').trim();

      if (!HEX_REGEX.test(couleur)) {
        return interaction.reply({
          embeds: [errorEmbed('Couleur invalide', 'Utilise un code hexadécimal du type `#7c6cf0`. Rien n\'a été enregistré, relance `/partenariat-config builder`.')],
          ephemeral: true,
        });
      }
      const miniatureLower = miniature.toLowerCase();
      if (miniature && !['avatar', 'aucune'].includes(miniatureLower) && !URL_REGEX.test(miniature)) {
        return interaction.reply({
          embeds: [errorEmbed('Miniature invalide', 'Utilise `avatar`, `aucune`, ou une URL commençant par http(s)://. Rien n\'a été enregistré.')],
          ephemeral: true,
        });
      }

      const guildId = interaction.guild.id;
      let server = await Server.findOne({ guildId });
      if (!server) server = await Server.create({ guildId, guildName: interaction.guild.name });

      server.partnerTitle = titre;
      server.partnerMessage = message;
      server.partnerColor = couleur;
      server.partnerFooter = footer || '';
      server.partnerThumbnail = miniatureLower === 'aucune' ? 'none' : (miniatureLower === 'avatar' ? 'avatar' : miniature);
      await server.save();

      // Aperçu construit avec le MÊME module que le message réel envoyé par
      // /partenariat — garantit qu'il n'y a jamais de divergence.
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

      const note = server.partnerChannelId
        ? `Les annonces sont postées dans <#${server.partnerChannelId}>.`
        : "⚠️ Aucun salon d'annonce n'est encore configuré — lance `/partenariat-config definir` pour en choisir un.";
      const imageNote = server.partnerImage
        ? ''
        : "\n💡 Pour ajouter une image/bannière (non modifiable ici, 5 champs max par fenêtre), utilise `/partenariat-config definir image:<url>`.";

      return interaction.reply({
        content: `✅ Embed personnalisé enregistré. ${note}${imageNote}`,
        embeds: [preview],
        ephemeral: true,
      });
    } catch (err) {
      // Filet de sécurité : une erreur ici ne doit jamais remonter et casser
      // le traitement des autres interactions du bot.
      console.error('❌ partnerConfigModal a échoué:', err);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [errorEmbed('Erreur', "Une erreur est survenue, rien n'a été enregistré. Réessaie.")],
          ephemeral: true,
        }).catch(() => {});
      }
    }
  },
};
