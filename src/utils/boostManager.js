'use strict';
// utils/boostManager.js — Construit et envoie le message de boost, gère le rôle bonus.
//
// Objectif « 100% fiable » : au lieu d'échouer en silence (salon introuvable,
// permissions manquantes, rôle supprimé/trop haut), chaque étape renvoie un
// résultat explicite et applique un repli :
//   • salon configuré → salon système → premier salon textuel utilisable ;
//   • rôle bonus ajouté seulement s'il existe, n'est pas géré et est sous le
//     rôle le plus haut du bot ; retiré proprement au dé-boost.

const { EmbedBuilder } = require('discord.js');

const SEND_PERMS = ['ViewChannel', 'SendMessages', 'EmbedLinks'];
const DEFAULT_COLOR = 0xF47FFF;

function fillPlaceholders(str, member) {
  if (!str) return str;
  const boostCount = member.guild.premiumSubscriptionCount ?? 0;
  const level = member.guild.premiumTier ?? 0;
  return str
    .replaceAll('{user}', member.user.tag)
    .replaceAll('{mention}', `<@${member.id}>`)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{boostcount}', String(boostCount))
    .replaceAll('{level}', String(level))
    .replaceAll('{membercount}', String(member.guild.memberCount));
}

// Couleur tolérante : accepte « #F47FFF », « F47FFF » ou un entier ; retombe sur le rose boost.
function normalizeColor(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(raw || '').trim());
  return m ? parseInt(m[1], 16) : DEFAULT_COLOR;
}

function isHttpImage(url) {
  return typeof url === 'string' && /^https?:\/\/.+/i.test(url.trim());
}

function buildBoostEmbed(member, config = {}) {
  const embed = new EmbedBuilder().setColor(normalizeColor(config.color)).setTimestamp();

  const title = fillPlaceholders(config.title, member);
  const description = fillPlaceholders(config.description, member);
  if (title) embed.setTitle(title.slice(0, 256));
  if (description) embed.setDescription(description.slice(0, 4096));
  if (config.footerText) embed.setFooter({ text: fillPlaceholders(config.footerText, member).slice(0, 2048) });
  if (isHttpImage(config.imageUrl)) embed.setImage(config.imageUrl.trim());

  if (config.useAvatar) {
    embed.setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }));
  } else if (config.useServerIcon && member.guild.iconURL()) {
    embed.setThumbnail(member.guild.iconURL({ extension: 'png', size: 256 }));
  }

  return embed;
}

// ── Choix du salon d'annonce (avec replis) ──────────────────────────────────
function canSend(guild, channel) {
  if (!channel?.isTextBased?.()) return false;
  const perms = channel.permissionsFor?.(guild?.members?.me);
  if (!perms?.has) return true; // non vérifiable → on tente quand même
  return perms.has(SEND_PERMS);
}

async function resolveAnnounceChannel(guild, config = {}) {
  if (!guild) return null;

  if (config.channelId) {
    const configured = guild.channels.cache.get(config.channelId)
      || await guild.channels.fetch(config.channelId).catch(() => null);
    if (canSend(guild, configured)) return configured;
  }

  if (canSend(guild, guild.systemChannel)) return guild.systemChannel;

  const fallback = guild.channels.cache.find?.(c => canSend(guild, c));
  return fallback || null;
}

// ── Rôle bonus des boosters ─────────────────────────────────────────────────
async function applyBoosterRole(member, config = {}) {
  const roleId = config.boosterRoleId;
  if (!roleId) return false;
  if (member.roles.cache.has(roleId)) return true; // déjà attribué → succès

  const role = member.guild.roles.cache.get(roleId)
    || await member.guild.roles.fetch(roleId).catch(() => null);
  if (!role || role.managed) return false;

  const me = member.guild.members.me;
  if (me && member.guild.ownerId !== me.id && role.position >= me.roles.highest.position) {
    console.error(`[boost] rôle bonus « ${role.name} » trop haut pour le bot — non attribué.`);
    return false;
  }

  await member.roles.add(roleId, 'Boost du serveur — rôle bonus').catch(err => console.error('❌ boosterRoleId:', err.message));
  return member.roles.cache.has(roleId);
}

async function removeBoosterRole(member, config = {}) {
  const roleId = config.boosterRoleId;
  if (!roleId || !member.roles.cache.has(roleId)) return false;
  await member.roles.remove(roleId, 'Boost terminé').catch(() => {});
  return !member.roles.cache.has(roleId);
}

// ── Envoi du message de boost (résultat explicite) ──────────────────────────
async function sendBoostMessage(member, config = {}) {
  const result = { sent: false, channelId: null, roleAdded: false, reason: null };

  const channel = await resolveAnnounceChannel(member.guild, config);
  if (!channel) {
    result.reason = 'no_channel';
  } else {
    const embed = buildBoostEmbed(member, config);
    const pingRoleValid = config.pingRoleId && member.guild.roles.cache.has(config.pingRoleId);
    const content = pingRoleValid ? `<@&${config.pingRoleId}>` : null;

    const msg = await channel
      .send({ content, embeds: [embed], allowedMentions: pingRoleValid ? { roles: [config.pingRoleId] } : undefined })
      .catch(err => { console.error('❌ sendBoostMessage:', err.message); return null; });

    if (msg) { result.sent = true; result.channelId = channel.id; }
    else result.reason = 'send_failed';
  }

  result.roleAdded = await applyBoosterRole(member, config);
  return result;
}

module.exports = {
  sendBoostMessage,
  buildBoostEmbed,
  fillPlaceholders,
  normalizeColor,
  resolveAnnounceChannel,
  applyBoosterRole,
  removeBoosterRole,
};
