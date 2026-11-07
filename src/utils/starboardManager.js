// utils/starboardManager.js — Moteur du système Starboard
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Starboard     = require('../models/Starboard');
const StarboardPost = require('../models/StarboardPost');
const { COLORS }    = require('../utils/embeds');

// ─── Compare une réaction à l'émoji configuré — Unicode uniquement ──────────
// Une réaction custom (emoji.id présent) est ignorée, même si une ancienne
// configuration contenait « nom:id ».
function matchEmoji(emoji, configured) {
  if (!configured || emoji.id) return false;
  return emoji.name === configured;
}

function displayEmoji(configured) {
  const value = String(configured || '').trim();
  // Ancienne config custom ou valeur vide : repli Unicode neutre.
  if (!value || value.includes(':')) return '⭐';
  return value;
}

// ─── Palier atteint pour un nombre d'étoiles donné ────────────────────────────
function getTier(cfg, count) {
  const sorted = [...(cfg.tiers || [])].sort((a, b) => b.threshold - a.threshold);
  return sorted.find(t => count >= t.threshold) || null;
}

// ─── Compte les étoiles valides (filtre bots, auto-star, âge compte, rôles) ───
async function countValidStars(message, cfg) {
  const reaction = message.reactions.cache.find(r => matchEmoji(r.emoji, cfg.emoji));
  if (!reaction) return 0;

  const users = await reaction.users.fetch().catch(() => null);
  if (!users) return 0;

  let count = 0;
  for (const user of users.values()) {
    if (user.bot) continue;
    if (!cfg.selfStarEnabled && user.id === message.author?.id) continue;

    if (cfg.minAccountAgeDays > 0) {
      const ageDays = (Date.now() - user.createdTimestamp) / 86400000;
      if (ageDays < cfg.minAccountAgeDays) continue;
    }

    if (cfg.ignoredRoleIds?.length) {
      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (member && member.roles.cache.some(r => cfg.ignoredRoleIds.includes(r.id))) continue;
    }

    count++;
  }
  return count;
}

// ─── Construit le contenu posté/édité sur le starboard ────────────────────────
function buildStarboardPayload(cfg, message, count, tier) {
  const embed = new EmbedBuilder()
    .setColor(tier ? tier.color : COLORS.primary)
    .setAuthor({ name: message.author?.tag || 'Utilisateur inconnu', iconURL: message.author?.displayAvatarURL?.() })
    .setDescription(message.content ? message.content.slice(0, 3000) : '*Message sans texte (média uniquement)*')
    .addFields({ name: 'Salon', value: `<#${message.channel.id}>`, inline: true })
    .setFooter({ text: tier ? tier.label : 'Starboard' })
    .setTimestamp(message.createdAt);

  const image = message.attachments.find(a => a.contentType?.startsWith('image/'));
  if (image) embed.setImage(image.url);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Voir le message original').setStyle(ButtonStyle.Link).setURL(message.url),
  );

  return {
    content: `${displayEmoji(cfg.emoji)} **${count}** — <#${message.channel.id}>`,
    embeds: [embed],
    components: [row],
  };
}

// ─── Point d'entrée : synchronise l'état du starboard pour UN message ─────────
async function syncStarboardMessage(client, cfg, message) {
  if (!cfg.enabled || !cfg.channelId) return;
  if (!message.guild || !message.author) return;
  if (!cfg.botMessagesEnabled && message.author.bot) return;
  if (cfg.ignoredChannelIds?.includes(message.channel.id)) return;
  if (!cfg.nsfwChannelsEnabled && message.channel.nsfw) return;

  const count = await countValidStars(message, cfg);
  const existing = await StarboardPost.findOne({ guildId: cfg.guildId, sourceMessageId: message.id });

  const starboardChannel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!starboardChannel) return;

  // Sous le seuil : on retire l'entrée existante s'il y en a une.
  if (count < cfg.threshold) {
    if (existing) {
      const msg = await starboardChannel.messages.fetch(existing.starboardMessageId).catch(() => null);
      if (msg) await msg.delete().catch(() => {});
      await StarboardPost.deleteOne({ _id: existing._id });
    }
    return;
  }

  const tier = getTier(cfg, count);
  const payload = buildStarboardPayload(cfg, message, count, tier);

  if (existing) {
    const msg = await starboardChannel.messages.fetch(existing.starboardMessageId).catch(() => null);
    if (msg) {
      await msg.edit(payload).catch(() => {});
      existing.starCount = count;
      existing.updatedAt = new Date();
      await existing.save().catch(() => {});
      return;
    }
  }

  const sent = await starboardChannel.send(payload).catch(() => null);
  if (!sent) return;

  const isNew = !existing;
  await StarboardPost.findOneAndUpdate(
    { guildId: cfg.guildId, sourceMessageId: message.id },
    {
      sourceChannelId:    message.channel.id,
      starboardMessageId: sent.id,
      authorId:           message.author.id,
      starCount:          count,
      updatedAt:          new Date(),
    },
    { upsert: true },
  );

  if (isNew) {
    await Starboard.updateOne({ guildId: cfg.guildId }, { $inc: { totalStarred: 1 } }).catch(() => {});
  }
}

// ─── Nettoyage quand le message SOURCE est supprimé ───────────────────────────
async function removeStarboardPostForSource(client, guildId, sourceMessageId) {
  const cfg = await Starboard.findOne({ guildId });
  if (!cfg || !cfg.deleteOnSourceDelete || !cfg.channelId) return;

  const existing = await StarboardPost.findOne({ guildId, sourceMessageId });
  if (!existing) return;

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (channel) {
    const msg = await channel.messages.fetch(existing.starboardMessageId).catch(() => null);
    if (msg) await msg.delete().catch(() => {});
  }
  await StarboardPost.deleteOne({ _id: existing._id });
}

module.exports = {
  matchEmoji, displayEmoji, getTier, countValidStars,
  buildStarboardPayload, syncStarboardMessage, removeStarboardPostForSource,
};
