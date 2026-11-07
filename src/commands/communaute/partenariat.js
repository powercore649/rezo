// commands/partenariat.js — Enregistre un partenariat effectué : incrémente
// le compteur du membre crédité + le total du serveur, puis poste
// automatiquement l'embed configuré via /partenariat-config.
const { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const Server = require('../../models/Server');
const PartnerStats = require('../../models/PartnerStats');
const { errorEmbed } = require('../../utils/embeds');
const { buildPartnerValues, buildPartnerEmbed } = require('../../utils/partnerEmbed');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('partenariat')
    .setDescription("🤝 Enregistrer un partenariat effectué et poster l'annonce automatique")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('membre').setDescription('Membre à créditer (défaut : toi-même)').setRequired(false))
    .addStringOption((o) => o.setName('serveur').setDescription('Nom du serveur partenaire').setRequired(false))
    .addStringOption((o) => o.setName('invite').setDescription("Lien d'invitation du serveur partenaire").setRequired(false))
    .addStringOption((o) => o.setName('description').setDescription('Détail optionnel du partenariat').setRequired(false)),

  async execute(interaction) {
    const guild = interaction.guild;
    const guildId = guild.id;
    const target = interaction.options.getUser('membre') || interaction.user;
    const serveurNom = interaction.options.getString('serveur');
    const inviteLink = interaction.options.getString('invite');
    const description = interaction.options.getString('description');

    const server = await Server.findOne({ guildId });
    if (!server?.partnerChannelId) {
      return interaction.reply({
        embeds: [errorEmbed(
          'Aucun salon configuré',
          "Configure d'abord un salon d'annonce avec `/partenariat-config definir` avant d'enregistrer un partenariat."
        )],
        ephemeral: true,
      });
    }

    const channel = await guild.channels.fetch(server.partnerChannelId).catch(() => null);
    if (!channel) {
      return interaction.reply({
        embeds: [errorEmbed(
          'Salon introuvable',
          "Le salon configuré n'existe plus ou n'est plus accessible. Reconfigure-le avec `/partenariat-config definir`."
        )],
        ephemeral: true,
      });
    }

    // Vérifie que le bot peut effectivement écrire et poster un embed dans ce
    // salon AVANT de toucher aux compteurs — pour ne jamais incrémenter un
    // partenariat qui ne serait finalement pas annoncé.
    const me = guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks])) {
      return interaction.reply({
        embeds: [errorEmbed(
          'Permissions manquantes',
          `Je n'ai pas la permission d'envoyer des messages/embeds dans ${channel}. Vérifie mes permissions sur ce salon.`
        )],
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    // Incrémente (ou crée) le compteur du membre crédité + le total du
    // serveur, de façon atomique pour éviter toute perte en cas d'utilisations
    // simultanées de la commande.
    const stats = await PartnerStats.findOneAndUpdate(
      { guildId, userId: target.id },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    const updatedServer = await Server.findOneAndUpdate(
      { guildId },
      { $inc: { totalPartnerships: 1 } },
      { new: true }
    );

    const rangCount = await PartnerStats.countDocuments({ guildId, count: { $gt: stats.count } });
    const rang = rangCount + 1;

    const values = buildPartnerValues({
      target, guild, serveurNom, inviteLink,
      count: stats.count, rang, total: updatedServer.totalPartnerships,
    });
    const embed = buildPartnerEmbed(updatedServer, values, target);
    if (description) embed.addFields({ name: 'Détails', value: description.slice(0, 1024) });

    try {
      await channel.send({ embeds: [embed] });
    } catch (err) {
      // L'envoi a échoué malgré la vérification de permissions (salon
      // supprimé entre-temps, erreur réseau…) — on annule proprement les
      // compteurs pour ne jamais laisser un chiffre qui ne correspond à
      // aucune annonce réellement publiée.
      await PartnerStats.updateOne({ guildId, userId: target.id }, { $inc: { count: -1 } });
      await Server.updateOne({ guildId }, { $inc: { totalPartnerships: -1 } });
      console.error('❌ /partenariat — échec de l\'envoi, compteurs annulés:', err);
      return interaction.editReply({
        embeds: [errorEmbed('Échec de l\'envoi', "L'annonce n'a pas pu être publiée, aucun compteur n'a été modifié. Réessaie dans un instant.")],
      });
    }

    return interaction.editReply({
      content: `✅ Partenariat enregistré pour ${target}. Annonce publiée dans ${channel} — total : **${stats.count}** partenariat(s) (classement : #${rang}).`,
    });
  },
};
