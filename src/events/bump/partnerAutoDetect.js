// events/partnerAutoDetect.js — Détection automatique de partenariat.
//
// Fichier INDÉPENDANT de events/messageCreate.js : discord.js/Node autorisent
// plusieurs handlers pour le même événement ('messageCreate'), donc ce
// fichier s'ajoute au chargement automatique de src/index.js SANS modifier
// ni risquer de casser le handler messageCreate.js déjà existant.
//
// Fonctionnement : dès qu'un message contenant un lien d'invitation Discord
// est posté dans le salon de soumission configuré (/partenariat-config
// definir salon_soumission:#salon), le bot :
//   1. Résout le VRAI serveur de l'invitation (nom, icône, membres réels —
//      aucune donnée inventée) via client.fetchInvite()
//   2. Crédite l'auteur du message (+1 partenariat, + total serveur)
//   3. Poste l'annonce automatiquement dans le salon d'annonce configuré
//   4. Réagit sur le message d'origine pour confirmer (✅) ou signaler un
//      souci (❌) — jamais d'échec silencieux.
const Server = require('../../models/Server');
const PartnerStats = require('../../models/PartnerStats');
const { buildPartnerValues, buildPartnerEmbed } = require('../../utils/partnerEmbed');

const INVITE_REGEX = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9-]+)/i;

module.exports = {
  name: 'messageCreate',
  async execute(message, client) {
    try {
      if (!message.guild || message.author.bot) return;

      const server = await Server.findOne({ guildId: message.guild.id }).lean();
      if (!server?.partnerSubmitChannelId) return; // détection auto désactivée pour ce serveur
      if (message.channel.id !== server.partnerSubmitChannelId) return;

      const match = message.content.match(INVITE_REGEX);
      if (!match) {
        // Salon dédié mais aucun lien d'invite détecté : on guide plutôt que
        // d'ignorer silencieusement, sans pour autant spammer une erreur bloquante.
        await message.react('❓').catch(() => {});
        return;
      }

      if (!server.partnerChannelId) {
        await message.react('❌').catch(() => {});
        await message.reply({
          content: "⚠️ Lien d'invitation détecté, mais aucun salon d'annonce n'est configuré. Un admin doit lancer `/partenariat-config definir` (option `salon`).",
        }).catch(() => {});
        return;
      }

      // Résout le vrai serveur derrière l'invitation (nom, icône, membres) —
      // si le lien est invalide/expiré, fetchInvite lève une erreur qu'on gère proprement.
      const invite = await client.fetchInvite(match[1]).catch(() => null);
      if (!invite || !invite.guild) {
        await message.react('❌').catch(() => {});
        await message.reply({ content: "⚠️ Ce lien d'invitation semble invalide ou expiré." }).catch(() => {});
        return;
      }

      const announceChannel = await message.guild.channels.fetch(server.partnerChannelId).catch(() => null);
      if (!announceChannel) {
        await message.react('❌').catch(() => {});
        await message.reply({ content: "⚠️ Le salon d'annonce configuré n'existe plus. Reconfigure-le avec `/partenariat-config definir`." }).catch(() => {});
        return;
      }

      const me = message.guild.members.me;
      const perms = announceChannel.permissionsFor(me);
      if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        await message.react('❌').catch(() => {});
        await message.reply({ content: `⚠️ Je n'ai pas la permission de poster dans ${announceChannel}.` }).catch(() => {});
        return;
      }

      // Incrémente les compteurs (auteur du message = staff qui a fait le partenariat)
      const stats = await PartnerStats.findOneAndUpdate(
        { guildId: message.guild.id, userId: message.author.id },
        { $inc: { count: 1 } },
        { upsert: true, new: true }
      );
      const updatedServer = await Server.findOneAndUpdate(
        { guildId: message.guild.id },
        { $inc: { totalPartnerships: 1 } },
        { new: true }
      );
      const rangCount = await PartnerStats.countDocuments({ guildId: message.guild.id, count: { $gt: stats.count } });

      const values = buildPartnerValues({
        target: message.author,
        guild: message.guild,
        serveurNom: invite.guild.name,           // vrai nom du serveur partenaire, résolu depuis l'invite
        inviteLink: `https://discord.gg/${match[1]}`,
        count: stats.count,
        rang: rangCount + 1,
        total: updatedServer.totalPartnerships,
      });
      const embed = buildPartnerEmbed(updatedServer, values, message.author);

      try {
        await announceChannel.send({ embeds: [embed] });
        await message.react('✅').catch(() => {});
      } catch (sendErr) {
        // Annonce échouée : on annule les compteurs pour rester cohérent
        // avec /partenariat (jamais de compteur sans annonce réelle).
        await PartnerStats.updateOne({ guildId: message.guild.id, userId: message.author.id }, { $inc: { count: -1 } });
        await Server.updateOne({ guildId: message.guild.id }, { $inc: { totalPartnerships: -1 } });
        await message.react('❌').catch(() => {});
        console.error('❌ partnerAutoDetect — échec de l\'envoi, compteurs annulés:', sendErr);
      }
    } catch (err) {
      // Filet de sécurité global : une erreur ici ne doit JAMAIS remonter et
      // casser le traitement des autres messages/événements du bot.
      console.error('❌ partnerAutoDetect a échoué:', err);
    }
  },
};
