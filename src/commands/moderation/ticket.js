'use strict';
// commands/moderation/ticket.js — 🎫 LA commande unique du système de tickets.
//
// Volontairement SANS sous-commande : `/ticket` ouvre le panel unique
// (utils/ticketPanelView.js) d'où tout se gère — panels, catégories, embed,
// comportement, support, statistiques et blacklist.
//
// Ce fichier ne garde que ce qui doit être porté par la commande : les
// interactions des messages PUBLICS (le menu d'ouverture posté dans un salon,
// les boutons du salon de ticket) que le routeur d'interactions appelle.
//
// Compte rendu : aucun autre fichier ne doit définir la commande `ticket`.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const TicketPanel = require('../../models/TicketPanel');
const { Ticket } = require('../../models/Ticket');
const engine      = require('../../utils/ticketEngine');
const panelView    = require('../../utils/ticketPanelView');
const { errorEmbed, successEmbed } = require('../../utils/embeds');

const { PRIORITIES } = engine;

// ─── Menu d'ouverture posté dans un salon (ticket_open:<panelKey>) ────────────

async function handleOpenSelect(interaction, client) {
  const panelKey = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : 't1';
  const catKey   = interaction.values[0];
  const panel    = await TicketPanel.findOne({ guildId: interaction.guild.id, panelKey }).lean().exec();
  if (!panel) {
    return interaction.reply({ embeds: [errorEmbed('Panel introuvable', 'Ce panel a été supprimé.')], ephemeral: true });
  }
  const cat = (panel.categories || []).find(c => c.key === catKey && c.enabled);
  if (!cat) {
    return interaction.reply({ embeds: [errorEmbed('Catégorie indisponible', 'Cette catégorie n\'existe plus.')], ephemeral: true });
  }
  return engine.showOpenModal(interaction, panel, cat);
}

// ─── Formulaire d'ouverture soumis (ticket_submit:<panelKey>:<catKey>) ───────

async function handleSubmitModal(interaction, client) {
  const [, panelKey, catKey] = interaction.customId.split(':');
  const panel = await TicketPanel.findOne({ guildId: interaction.guild.id, panelKey }).lean().exec();
  if (!panel) return interaction.reply({ embeds: [errorEmbed('Panel introuvable')], ephemeral: true });
  const cat = (panel.categories || []).find(c => c.key === catKey);
  if (!cat) return interaction.reply({ embeds: [errorEmbed('Catégorie introuvable')], ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const fields    = interaction.fields;
  const questions = (cat.questions || []).slice(0, 5);
  let answers = [];
  let subject = null;
  if (questions.length === 0) {
    subject = fields.getTextInputValue('q_sujet');
    answers = [subject];
  } else {
    answers = questions.map((q, idx) => {
      try { return fields.getTextInputValue(`q_${idx}`) || ''; } catch { return ''; }
    });
    subject = answers.find(a => a) || cat.name;
  }

  const result = await engine.createTicket(interaction, client, { panel, cat, answers, subject });
  if (!result.ok) return interaction.editReply({ embeds: [errorEmbed('Ouverture impossible', result.reason)] });
  return interaction.editReply({
    embeds: [successEmbed('🎫 Ticket créé !', `Votre ticket **#${result.number}** (${cat.name}) est disponible ici : <#${result.channel.id}>`)],
  });
}

// ─── Boutons du salon de ticket ──────────────────────────────────────────────

async function handleCloseButton(interaction, client) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket_close_modal_${interaction.customId.replace('ticket_close_btn_', '')}`)
    .setTitle('Fermer le ticket');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('raison').setLabel('Raison de la fermeture (optionnel)')
      .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500),
  ));
  return interaction.showModal(modal);
}

async function handleCloseModal(interaction, client) {
  const raison = interaction.fields.getTextInputValue('raison').trim() || null;
  await interaction.deferReply();
  const result = await engine.closeTicket(interaction, client, { reason: raison });
  if (!result.ok) return interaction.editReply({ embeds: [errorEmbed('Erreur', result.reason)] });
}

async function handleClaimButton(interaction, client) {
  const ticketId = interaction.customId.replace('ticket_claim_', '');
  const ticket   = await Ticket.findById(ticketId).exec().catch(() => null);
  if (!ticket) return interaction.reply({ embeds: [errorEmbed('Ticket introuvable')], ephemeral: true });
  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    return interaction.reply({ embeds: [errorEmbed('Déjà pris en charge', `Ce ticket est déjà claim par <@${ticket.claimedBy}>.`)], ephemeral: true });
  }
  if (ticket.claimedBy === interaction.user.id) {
    ticket.claimedBy = null;
    await ticket.save().catch(() => {});
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x95A5A6)
      .setTitle('↩️ Prise en charge relâchée')
      .setDescription(`Le ticket **#${ticket.number}** est de nouveau libre.`)
      .setTimestamp()] });
  }
  ticket.claimedBy = interaction.user.id;
  await ticket.save().catch(() => {});
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ECC71)
    .setTitle('✋ Ticket pris en charge')
    .setDescription(`<@${interaction.user.id}> s'occupe désormais de ce ticket.`)
    .setTimestamp()] });
  await interaction.channel?.setTopic(`Ticket #${ticket.number} — Claim par ${interaction.user.tag}`).catch(() => {});
}

async function handlePriorityButton(interaction, client) {
  const ticketId = interaction.customId.replace('ticket_priority_', '');
  const modal = new ModalBuilder().setCustomId(`ticket_priority_modal_${ticketId}`).setTitle('Changer la priorité');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('niveau').setLabel('Priorité (low/normal/high/urgent)')
      .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('normal').setMaxLength(6),
  ));
  return interaction.showModal(modal);
}

async function handlePriorityModal(interaction, client) {
  const ticketId = interaction.customId.replace('ticket_priority_modal_', '');
  const niveau   = String(interaction.fields.getTextInputValue('niveau') || '').toLowerCase().trim();
  if (!PRIORITIES[niveau]) {
    return interaction.reply({ embeds: [errorEmbed('Priorité invalide', 'Utilisez : low, normal, high ou urgent')], ephemeral: true });
  }
  const ticket = await Ticket.findById(ticketId).exec().catch(() => null);
  if (!ticket) return interaction.reply({ embeds: [errorEmbed('Ticket introuvable')], ephemeral: true });
  ticket.priority = niveau;
  await ticket.save().catch(() => {});
  const pr = PRIORITIES[niveau];
  await interaction.channel?.setTopic(`Ticket #${ticket.number} — Priorité : ${pr.label}`).catch(() => {});
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(pr.color)
    .setTitle(`${pr.emoji} Priorité : ${pr.label}`)
    .setDescription(`Ticket **#${ticket.number}** → **${pr.label}**`)
    .setTimestamp()] });
}

async function handleReopen(interaction, client) {
  const ticketId = interaction.customId.replace('ticket_reopen_', '');
  await interaction.deferReply();
  const result = await engine.reopenTicket(interaction, client, ticketId);
  if (!result.ok) return interaction.editReply({ embeds: [errorEmbed('Erreur', result.reason)] });
  return interaction.editReply({ embeds: [successEmbed('Ticket ré-ouvert', `Le ticket **#${result.ticket.number}** est de nouveau actif.`)] });
}

async function handleDelete(interaction, client) {
  const ticketId = interaction.customId.replace('ticket_delete_', '');
  await interaction.deferReply();
  const result = await engine.deleteTicket(interaction, client, ticketId);
  if (!result.ok) return interaction.editReply({ embeds: [errorEmbed('Erreur', result.reason)] });
  return interaction.editReply({ embeds: [successEmbed('Ticket supprimé', `Le ticket **#${result.ticket?.number ?? ''}** et son salon ont été supprimés.`)] });
}

// ─── Sondage de satisfaction (boutons ⭐ du ticket fermé) ─────────────────────

async function handleRate(interaction, client) {
  const parts    = interaction.customId.split('_');
  const ticketId = parts[2];
  const stars    = Math.min(5, Math.max(1, parseInt(parts[3], 10) || 0));
  const ticket   = await Ticket.findById(ticketId).exec().catch(() => null);
  if (!ticket) return interaction.reply({ content: 'Ticket introuvable.', ephemeral: true });
  ticket.rating = stars;
  await ticket.save().catch(() => {});
  return interaction.update({
    embeds: [new EmbedBuilder().setColor(0x57F287)
      .setTitle('⭐ Merci pour votre avis !')
      .setDescription(`Vous avez noté le ticket **#${ticket.number}** : ${'⭐'.repeat(stars)} (${stars}/5)`)],
    components: [],
  });
}

// ─── Transcript du ticket courant (bouton/commande depuis le panel) ──────────

async function handleTranscript(interaction, client) {
  const ticket = await engine.findTicketInChannel(interaction).catch(() => null);
  if (!ticket) {
    const payload = { embeds: [errorEmbed('Pas un ticket', 'Ce salon n\'est pas un ticket ouvert.')], ephemeral: true };
    return interaction.deferred || interaction.replied
      ? interaction.editReply(payload).catch(() => {})
      : interaction.reply(payload).catch(() => {});
  }
  const file = await engine.generateTranscript(client, interaction.guild, ticket, interaction.channel).catch(() => null);
  if (!file) {
    const payload = { embeds: [errorEmbed('Erreur', 'Impossible de générer le transcript.')], ephemeral: true };
    return interaction.deferred || interaction.replied
      ? interaction.editReply(payload).catch(() => {})
      : interaction.reply(payload).catch(() => {});
  }
  const { AttachmentBuilder } = require('discord.js');
  const attachment = new AttachmentBuilder(file, { name: `transcript-${ticket.number}.html` });
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ content: `📄 Transcript du ticket **#${ticket.number}**`, files: [attachment] }).catch(() => {});
  }
  return interaction.reply({ content: `📄 Transcript du ticket **#${ticket.number}**`, files: [attachment], ephemeral: true }).catch(() => {});
}

// ─── Modaux du système (fermeture, priorité, panel) ──────────────────────────

async function handleModal(interaction, client) {
  // Modaux du panel unique (personnalisation) ET modaux du salon de ticket.
  if (interaction.customId.startsWith('tp_modal_'))              return panelView.handlePanelModal(interaction, client);
  if (interaction.customId.startsWith('ticket_close_modal_'))    return handleCloseModal(interaction, client);
  if (interaction.customId.startsWith('ticket_priority_modal_')) return handlePriorityModal(interaction, client);
}

// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('🎫 Gérer tout le système de tickets — panels, catégories, support et stats'),

  // Commande unique : ouvre le panel, aucune sous-commande.
  async execute(interaction, client) {
    return panelView.openPanel(interaction, client);
  },

  handleModal,
  handleOpenSelect,
  handleSubmitModal,
  handleCloseButton,
  handleCloseModal,
  handleClaimButton,
  handlePriorityButton,
  handlePriorityModal,
  handleReopen,
  handleDelete,
  handleRate,
  handleTranscript,

  // Rendu du panel exposé pour la suite de tests (pur, sans I/O).
  __testables: panelView.__testables,
};
