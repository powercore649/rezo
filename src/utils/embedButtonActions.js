'use strict';
// utils/embedButtonActions.js — Actions des boutons publiés par le studio /embed.
//
// Un bouton publié vit dans un message public : il n'est relié à aucun
// collecteur. `es_btn:<panelKey>:<index>` retrouve le document et exécute
// l'action du moment — modifier le bouton dans le studio suffit donc, sans
// republier le message.
//
// Types : link (Discord gère le clic), role (donne/retire/bascule), reply
// (réponse éphémère), ticket (ouvre le menu d'un panel de tickets).

const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const EmbedPanel = require('../models/EmbedPanel');
const TicketPanel = require('../models/TicketPanel');
const engine = require('./ticketEngine');
const { successEmbed, errorEmbed, infoEmbed } = require('./embeds');

const ephemeral = (interaction, embed) => interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});

async function handleEmbedButton(interaction) {
  if (!interaction.guild) return;

  const [, panelKey, idxRaw] = interaction.customId.split(':');
  const idx = parseInt(idxRaw, 10);

  const panel = await EmbedPanel.findOne({ guildId: interaction.guildId, panelKey }).lean().exec().catch(() => null);
  const button = panel?.buttons?.[idx];
  if (!button) return ephemeral(interaction, errorEmbed('Bouton inconnu', 'Ce bouton n’existe plus sur ce serveur.'));

  if (button.type === 'role') return handleRole(interaction, button);
  if (button.type === 'reply') {
    return interaction.reply({ content: button.response || '—', ephemeral: true }).catch(() => {});
  }
  if (button.type === 'ticket') return handleTicket(interaction, button);

  return ephemeral(interaction, errorEmbed('Action inconnue', 'Ce type de bouton n’est pas reconnu.'));
}

async function handleRole(interaction, button) {
  const role = button.roleId ? await interaction.guild.roles.fetch(button.roleId).catch(() => null) : null;
  if (!role) {
    return ephemeral(interaction, errorEmbed('Rôle introuvable', 'Le rôle associé à ce bouton a été supprimé.'));
  }

  const me = interaction.guild.members.me;
  if (!me?.permissions?.has?.('ManageRoles')) {
    return ephemeral(interaction, errorEmbed('Permission manquante', 'Le bot doit avoir la permission **Gérer les rôles**.'));
  }
  if (role.managed) {
    return ephemeral(interaction, errorEmbed('Rôle géré', 'Ce rôle est géré par une intégration : il ne peut pas être attribué.'));
  }
  if (role.position >= me.roles.highest.position) {
    return ephemeral(interaction, errorEmbed('Hiérarchie', 'Ce rôle est au-dessus du rôle le plus haut du bot : je ne peux pas le gérer.'));
  }

  const has = interaction.member.roles.cache.has(role.id);
  let action = button.roleMode || 'toggle';
  if (action === 'toggle') action = has ? 'remove' : 'add';

  if (action === 'add' && has) return ephemeral(interaction, infoEmbed('Déjà attribué', `Vous avez déjà ${role}.`));
  if (action === 'remove' && !has) return ephemeral(interaction, infoEmbed('Non attribué', `Vous n’avez pas ${role}.`));

  try {
    if (action === 'add') await interaction.member.roles.add(role);
    else await interaction.member.roles.remove(role);
  } catch (err) {
    return ephemeral(interaction, errorEmbed('Échec', `Impossible de modifier vos rôles : ${err.message}`));
  }

  return ephemeral(interaction, successEmbed(
    action === 'add' ? '🎭 Rôle ajouté' : '🎭 Rôle retiré',
    action === 'add' ? `Vous avez reçu ${role}.` : `Le rôle ${role} vous a été retiré.`,
  ));
}

async function handleTicket(interaction, button) {
  const panelKey = button.ticketPanel || 't1';
  const panel = await TicketPanel.findOne({ guildId: interaction.guildId, panelKey }).lean().exec().catch(() => null);
  if (!panel) return ephemeral(interaction, errorEmbed('Support indisponible', 'Le panel de tickets associé n’existe plus.'));

  const cats = (panel.categories || []).filter(c => c.enabled !== false);
  if (!cats.length) return ephemeral(interaction, errorEmbed('Support indisponible', 'Aucune catégorie de ticket n’est active.'));

  // Le menu réutilise le routeur du système de tickets (`ticket_open:<clé>`) :
  // la création du ticket reste centralisée dans ticketEngine.
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_open:${panel.panelKey}`)
    .setPlaceholder('Choisissez une catégorie…')
    .addOptions(cats.slice(0, 25).map(c => ({
      label: `${c.emoji || '🎫'} ${c.name}`.slice(0, 100),
      value: c.key,
      description: (c.description || 'Ouvrir un ticket').slice(0, 100),
    })));

  return interaction.reply({
    embeds: [infoEmbed('🎫 Support', 'Sélectionnez la catégorie de votre demande.')],
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  }).catch(() => {});
}

module.exports = { handleEmbedButton, handleRole, handleTicket };
