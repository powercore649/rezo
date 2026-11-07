'use strict';
// commands/utilitaires/embed.js — 🎨 Studio d'embeds (multi-panels, persistant).
//
// `/embed` ouvre un studio éphémère : plusieurs embeds par serveur, contenu,
// apparence complète, champs, boutons-liens, aperçu, publication et mise à jour.
// Tout est conservé en base (models/EmbedPanel.js) : rien ne se perd à la
// fermeture du panneau ni au redémarrage du bot.

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const studio = require('../../utils/embedStudio');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('embed')
    .setDescription('🎨 Créer et gérer des embeds personnalisés (multi-panels)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    return studio.openStudio(interaction);
  },

  // Routé par interactionCreate pour les modaux `es_modal_*`.
  async handleStudioModal(interaction) {
    return studio.handleStudioModal(interaction);
  },

  // Routé par interactionCreate : choix du rôle d'un bouton de rôle.
  async handleStudioRoleSelect(interaction) {
    return studio.attachRole(interaction);
  },

  // Routé par interactionCreate : clic sur un bouton publié (rôle, réponse, ticket).
  async handleEmbedButton(interaction) {
    const { handleEmbedButton } = require('../../utils/embedButtonActions');
    return handleEmbedButton(interaction);
  },
};
