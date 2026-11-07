'use strict';
// utils/avisUI.js — Éléments d'interface partagés entre /avis, /avis-panel et /avis-voir
// Extrait de commands/avis.js pour permettre de scinder le panel et la navigation
// en commandes indépendantes sans dupliquer le rendu (embeds, images, boutons).

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, PermissionFlagsBits,
} = require('discord.js');

const { AvisConfig, AVIS_TAGS } = require('../models/Review');
const { COLORS } = require('../utils/embeds');

const TAG_LABELS = {
  communaute_active:   '🗣️ Communauté active',
  bonne_moderation:    '🛡️ Bonne modération',
  evenements:          '🎉 Événements réguliers',
  partenariats_sympas: '🤝 Partenariats sympas',
  bon_design:          '🎨 Bon design',
  peu_actif:           '🐌 Peu actif',
  en_croissance:       '📈 En pleine croissance',
  support_reactif:     '💬 Support réactif',
};

function stars(rating) { return '⭐'.repeat(rating) + '☆'.repeat(5 - rating); }
function isMod(interaction) { return interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild); }

async function getOrCreateConfig(guildId) {
  let config = await AvisConfig.findOne({ guildId });
  if (!config) config = await AvisConfig.create({ guildId });
  return config;
}

// ─── Carte d'avis (utilisée par /avis-voir) — images jointes incluses ────────
function buildReviewCard({ review, index, total, author, config, canReply }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(stars(review.rating))
    .setDescription(review.comment)
    .addFields(
      { name: '👍 Utile', value: `${review.helpfulUp.length}`, inline: true },
      { name: '👎 Pas utile', value: `${review.helpfulDown.length}`, inline: true },
      { name: '📅 Publié', value: `<t:${Math.floor(new Date(review.createdAt).getTime() / 1000)}:R>${review.editedAt ? ' *(modifié)*' : ''}`, inline: true },
    )
    .setFooter({ text: `Avis ${index + 1} / ${total}` })
    .setTimestamp();

  if (review.anonymous) {
    embed.setAuthor({ name: 'Avis anonyme 🕵️' });
  } else {
    embed.setAuthor({ name: author?.username || 'Utilisateur inconnu', iconURL: author?.displayAvatarURL?.() });
  }

  if (review.tags?.length) {
    embed.addFields({ name: '🏷️ Tags', value: review.tags.map(t => TAG_LABELS[t] || t).join(' · '), inline: false });
  }
  if (review.ownerReply?.text) {
    embed.addFields({ name: '💬 Réponse du staff', value: review.ownerReply.text, inline: false });
  }

  // ── Images jointes : la première en grand sur la carte, les suivantes en embeds additionnels ──
  const embeds = [embed];
  if (review.mediaUrls?.length) {
    embed.setImage(review.mediaUrls[0]);
    for (const url of review.mediaUrls.slice(1)) {
      embeds.push(new EmbedBuilder().setColor(COLORS.primary).setImage(url));
    }
  }

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('avis_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId('avis_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1),
    new ButtonBuilder().setCustomId('avis_close').setLabel('✖').setStyle(ButtonStyle.Danger),
  );
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('avis_helpful_up').setLabel('👍 Utile').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('avis_helpful_down').setLabel('👎 Pas utile').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('avis_report').setLabel('🚩 Signaler').setStyle(ButtonStyle.Danger),
  );
  if (canReply && config.allowOwnerReply) {
    actionRow.addComponents(
      new ButtonBuilder().setCustomId('avis_reply').setLabel(review.ownerReply?.text ? '✏️ Modifier la réponse' : '💬 Répondre').setStyle(ButtonStyle.Primary),
    );
  }

  return { embeds, components: [navRow, actionRow] };
}

// ─── Panel de configuration avancé (utilisé par /avis-panel) ────────────────
function renderPanel(config) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('⭐ Panel — Système d\'avis')
    .setDescription('Configurez chaque aspect des avis laissés sur votre serveur.')
    .addFields(
      { name: '📢 Statut', value: config.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '📋 Salon de logs', value: config.logChannelId ? `<#${config.logChannelId}>` : '*Aucun*', inline: true },
      { name: '📣 Salon de publication', value: config.reviewChannelId ? `<#${config.reviewChannelId}>` : '*Aucun*', inline: true },
      { name: '🕒 Ancienneté requise', value: config.minJoinDays > 0 ? `${config.minJoinDays} jour(s) sur le serveur` : '*Désactivée*', inline: true },
      { name: '🔒 Âge de compte requis', value: config.minAccountAgeDays > 0 ? `${config.minAccountAgeDays} jour(s)` : '*Désactivé*', inline: true },
      { name: '🕵️ Avis anonymes', value: config.allowAnonymous ? '🟢 Autorisés' : '🔴 Interdits', inline: true },
      { name: '💬 Réponses du staff', value: config.allowOwnerReply ? '🟢 Activées' : '🔴 Désactivées', inline: true },
      { name: '🕵️‍♂️ Modération manuelle', value: config.requireApproval ? '🟢 Activée (validation requise)' : '🔴 Désactivée (publication immédiate)', inline: true },
      { name: '🚩 Seuil de masquage auto', value: `${config.reportThreshold} signalement(s)`, inline: true },
      { name: '⏱️ Cooldown de modification', value: `${config.editCooldownHours}h`, inline: true },
      { name: '🏷️ Tags actifs', value: (config.activeTags || []).map(t => TAG_LABELS[t] || t).join(', ') || '*Aucun*', inline: false },
    )
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('avispanel_log').setPlaceholder('📋 Salon de logs...').addChannelTypes(ChannelType.GuildText),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('avispanel_publish').setPlaceholder('📣 Salon de publication...').addChannelTypes(ChannelType.GuildText),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('avispanel_toggle_enabled').setLabel(config.enabled ? 'Désactiver' : 'Activer').setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('avispanel_toggle_anon').setLabel(`Anonymes: ${config.allowAnonymous ? 'ON' : 'OFF'}`).setStyle(config.allowAnonymous ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('avispanel_toggle_reply').setLabel(`Réponses staff: ${config.allowOwnerReply ? 'ON' : 'OFF'}`).setStyle(config.allowOwnerReply ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('avispanel_toggle_approval').setLabel(`Modération: ${config.requireApproval ? 'ON' : 'OFF'}`).setStyle(config.requireApproval ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('avispanel_modal_thresholds').setLabel('🕒 Ancienneté & Cooldowns').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('avispanel_tags').setLabel('🏷️ Gérer les tags').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('avispanel_refresh').setLabel('🔄 Actualiser').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4] };
}

function renderTagsView(config) {
  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('🏷️ Tags disponibles').setDescription('Choisissez les tags que les membres pourront ajouter à leurs avis.');
  const menu = new StringSelectMenuBuilder()
    .setCustomId('avispanel_tags_select')
    .setPlaceholder('Tags actifs...')
    .setMinValues(0)
    .setMaxValues(AVIS_TAGS.length)
    .addOptions(AVIS_TAGS.map(key => ({ label: TAG_LABELS[key], value: key, default: (config.activeTags || []).includes(key) })));
  const back = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('avispanel_back').setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), back] };
}

module.exports = { TAG_LABELS, stars, isMod, getOrCreateConfig, buildReviewCard, renderPanel, renderTagsView };
