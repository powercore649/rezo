'use strict';
// utils/mpRequestHandler.js — Traite un message posté dans le salon "Demande de MP" :
// exige la mention de la personne visée, supprime l'original, poste un embed avec
// boutons Accepter/Refuser (réservés à la personne mentionnée), et ne crée le fil
// qu'une fois la demande acceptée.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const MpRequest = require('../models/MpRequest');
const { renderThreadName, buildRequestSummary, pickTarget } = require('./mpRequestEngine');
const { COLORS } = require('../utils/embeds');

const NOTICE_DELETE_MS = 7000;

async function sendTemporaryNotice(channel, userId, text) {
  const msg = await channel.send({ content: `<@${userId}> ${text}` }).catch(() => null);
  if (msg) setTimeout(() => msg.delete().catch(() => {}), NOTICE_DELETE_MS);
}

function buildPendingEmbed(cfg, requester, target, summary, attachmentUrl) {
  const embed = new EmbedBuilder()
    .setColor(parseInt(cfg.embedColor, 16) || COLORS.primary)
    .setAuthor({ name: requester.username, iconURL: requester.displayAvatarURL() })
    .setThumbnail(requester.displayAvatarURL({ size: 256 }))
    .setTitle('💌 Nouvelle demande')
    .setDescription(`${summary}\n\n🎯 Souhaite discuter avec <@${target.id}>`)
    .setFooter({ text: `Demandeur : ${requester.id} · En attente de réponse de ${target.username}` })
    .setTimestamp();
  if (attachmentUrl) embed.setImage(attachmentUrl);
  return embed;
}

function buildResponseRow(requestId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mpans_accept_${requestId}`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`mpans_reject_${requestId}`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

async function handleMpRequestMessage(message, cfg) {
  if (message.author.bot) return;

  const channel = message.channel;
  const me = message.guild.members.me;

  const canManage = channel.permissionsFor(me)?.has(['ManageMessages', 'SendMessages', 'EmbedLinks', 'CreatePublicThreads']);
  if (!canManage) {
    console.error(`❌ [demande-mp] Permissions insuffisantes dans #${channel.name} (${message.guild.name}) : ManageMessages/SendMessages/EmbedLinks/CreatePublicThreads requis.`);
    return;
  }

  const mentionedIds = [...message.mentions.users.keys()];
  const pick = pickTarget(mentionedIds, message.author.id, me.id);

  if (!pick.ok) {
    await message.delete().catch(() => {});
    const texts = {
      no_mention:   'Tu dois **mentionner** la personne avec qui tu souhaites entrer en communication (ex: `@Pseudo Salut, on peut discuter ?`).',
      self_mention: 'Tu ne peux pas te mentionner toi-même pour une demande de MP.',
      bot_mention:  'Tu dois mentionner un **membre**, pas le bot.',
    };
    await sendTemporaryNotice(channel, message.author.id, texts[pick.error] || texts.no_mention);
    return;
  }

  const target = await message.guild.members.fetch(pick.targetId).catch(() => null);
  if (!target || target.user.bot) {
    await message.delete().catch(() => {});
    await sendTemporaryNotice(channel, message.author.id, 'La personne mentionnée est introuvable ou est un bot. Réessaie avec un membre valide.');
    return;
  }

  const summary = buildRequestSummary(message.content, message.attachments.size);
  const attachmentUrl = message.attachments.size > 0 ? [...message.attachments.values()][0].url : null;

  await message.delete().catch(() => {});

  const request = await MpRequest.create({
    guildId: message.guild.id, channelId: channel.id,
    requesterId: message.author.id, targetId: target.id,
  });

  const embed = buildPendingEmbed(cfg, message.author, target.user, summary, attachmentUrl);
  let sentMessage;
  try {
    sentMessage = await channel.send({ content: `<@${target.id}>`, embeds: [embed], components: [buildResponseRow(request._id)] });
  } catch (err) {
    console.error('❌ [demande-mp] Échec de l\'envoi de l\'embed:', err.message);
    return;
  }

  request.messageId = sentMessage.id;
  await request.save();

  cfg.totalRequests = (cfg.totalRequests || 0) + 1;
  await cfg.save().catch(() => {});
}

/**
 * Traite le clic sur "Accepter" / "Refuser" — réservé à la personne mentionnée.
 */
async function handleRequestButton(interaction) {
  const isAccept = interaction.customId.startsWith('mpans_accept_');
  const requestId = interaction.customId.replace(isAccept ? 'mpans_accept_' : 'mpans_reject_', '');

  const request = await MpRequest.findById(requestId);
  if (!request) {
    return interaction.reply({ content: '❌ Cette demande n\'existe plus.', ephemeral: true });
  }
  if (request.status !== 'pending') {
    return interaction.reply({ content: '❌ Cette demande a déjà été traitée.', ephemeral: true });
  }
  if (interaction.user.id !== request.targetId) {
    return interaction.reply({ content: '❌ Seule la personne mentionnée peut répondre à cette demande.', ephemeral: true });
  }

  request.status = isAccept ? 'accepted' : 'rejected';
  request.respondedAt = new Date();

  const originalEmbed = interaction.message.embeds[0];
  const updatedEmbed = EmbedBuilder.from(originalEmbed)
    .setColor(isAccept ? COLORS.success : COLORS.error)
    .setFooter({ text: isAccept ? `✅ Acceptée par ${interaction.user.username}` : `❌ Refusée par ${interaction.user.username}` });

  if (!isAccept) {
    await request.save();
    return interaction.update({ embeds: [updatedEmbed], components: [buildResponseRow(requestId, true)] });
  }

  // ── Acceptée : crée le fil et y invite les deux personnes ──
  const MpRequestConfig = require('../models/MpRequestConfig');
  const cfg = await MpRequestConfig.findOne({ guildId: interaction.guild.id });
  const requesterUser = await interaction.client.users.fetch(request.requesterId).catch(() => null);
  const threadName = renderThreadName(cfg?.threadNameTemplate, requesterUser?.username || 'Demande');

  let thread = null;
  try {
    thread = await interaction.message.startThread({ name: threadName, autoArchiveDuration: cfg?.autoArchiveMinutes || 1440 });
    await thread.members.add(request.requesterId).catch(() => {});
    await thread.members.add(request.targetId).catch(() => {});
    await thread.send({
      content: `<@${request.requesterId}> <@${request.targetId}>`,
      embeds: [new EmbedBuilder().setColor(COLORS.info).setDescription('Demande acceptée ! Vous pouvez discuter ici, ou passer en MP si vous préférez. 💬')],
    }).catch(() => {});
  } catch (err) {
    console.error('❌ [demande-mp] Échec de la création du fil:', err.message);
  }

  request.threadId = thread?.id || null;
  await request.save();

  return interaction.update({ embeds: [updatedEmbed], components: [buildResponseRow(requestId, true)] });
}

module.exports = { handleMpRequestMessage, handleRequestButton };
