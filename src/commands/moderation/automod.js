'use strict';
// commands/moderation/automod.js — Anti-spam / anti-liens / anti-majuscules.
// Le handler handleMessage() est appelé par l'event messageCreate ; la config
// vient du modèle AutoMod, éditée via /securite.
//
// v2 de l'anti-spam :
//   • fenêtres glissantes BORNÉES (l'ancienne `Map` grandissait sans limite et
//     fuyait sur un bot multi-serveurs) ;
//   • détection des DOUBLONS (même contenu répété) en plus du simple compteur ;
//   • détection des MENTIONS DE MASSE ;
//   • sanctions réelles pour `kick`/`ban` (elles étaient configurées mais
//     jamais appliquées) et mute ESCALADÉ à chaque récidive ;
//   • les alertes partent dans le salon de logs AutoMod (`/securite` → Logs),
//     et retombent sur le modlog général s'il n'est pas configuré.
//
// Le spam par WEBHOOK est traité séparément (utils/antiSpam.js →
// handleWebhookMessage), car un webhook n'a pas de membre à sanctionner.

const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const AutoMod = require('../../models/AutoMod');
const {
  sendAntiSpamLog, detectMemberSpam, nextMuteDuration, resetMemberWindow,
} = require('../../utils/antiSpam');

// ── Petites aides ─────────────────────────────────────────────────────────────
function isExempt(message, cfg) {
  if (!message.member) return true;
  if (message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  if (cfg.exemptRoles?.some(r => message.member.roles.cache.has(r))) return true;
  if (cfg.exemptChannels?.includes(message.channel.id)) return true;
  return false;
}

const ACTION_LABELS = {
  delete: 'Message supprimé',
  warn: 'Avertissement + mute',
  mute: 'Mute temporaire',
  kick: 'Expulsion',
  ban: 'Bannissement',
};

/**
 * Applique une sanction réelle. Renvoie le libellé effectif (ou null si le bot
 * n'a pas la permission). Toute erreur reste silencieuse : l'auto-modération ne
 * doit jamais interrompre le traitement du message suivant.
 */
async function applyAction(message, action, muteDurationMin, { escalate = false } = {}) {
  const member = message.member;
  const me = message.guild?.members?.me;
  if (!member || !me) return null;

  const outranks = member.roles.highest.position < me.roles.highest.position
    && (message.guild.ownerId === me.id || member.id !== message.guild.ownerId);

  try {
    if (action === 'warn' || action === 'delete') {
      await message.delete().catch(() => {});
    }
    if (action === 'warn' || action === 'mute') {
      if (!me.permissions.has(PermissionFlagsBits.ModerateMembers) || !outranks) return 'delete';
      const minutes = nextMuteDuration(message.guild.id, member.id, muteDurationMin || 10, { escalate });
      await member.timeout(Math.max(1, minutes) * 60_000, 'AutoMod — infraction').catch(() => {});
      return `mute ${minutes} min`;
    }
    if (action === 'kick') {
      if (!me.permissions.has(PermissionFlagsBits.KickMembers) || !outranks) return 'delete';
      await member.kick('AutoMod — infraction').catch(() => {});
      return ACTION_LABELS.kick;
    }
    if (action === 'ban') {
      if (!me.permissions.has(PermissionFlagsBits.BanMembers) || !outranks) return 'delete';
      await member.ban({ reason: 'AutoMod — infraction' }).catch(() => {});
      return ACTION_LABELS.ban;
    }
  } catch (_) { /* best effort */ }
  return null;
}

async function logInfraction(client, guildId, cfg, title, fields) {
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle(`🛡️ AutoMod — ${title}`)
    .addFields(fields)
    .setTimestamp();
  await sendAntiSpamLog(client, guildId, cfg, embed);
}

// ── Infraction anti-spam (flood, doublons, mentions) ─────────────────────────
async function handleSpamSignal(message, cfg, detection) {
  const { flood, duplicate, mention, count, duplicates, mentions, settings } = detection;

  let reason = null;
  if (flood) reason = `Flood — ${count} messages en ${Math.round(settings.spamWindow / 1000)} s`;
  else if (duplicate) reason = `Doublons — ${duplicates} fois le même message`;
  else if (mention) reason = `Mentions de masse — ${mentions} mentions dans un message`;

  if (!reason) return false;

  resetMemberWindow(message.guild.id, message.author.id);
  const effect = await applyAction(message, cfg.spamAction, cfg.spamMuteDuration, { escalate: cfg.spamEscalate !== false });

  await logInfraction(message.client, message.guild.id, cfg, 'Spam détecté', [
    { name: '👤 Membre', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
    { name: '💬 Salon', value: `<#${message.channelId}>`, inline: true },
    { name: '⚡ Action', value: effect || `\`${cfg.spamAction}\` (permissions insuffisantes)`, inline: true },
    { name: '🚨 Détection', value: reason, inline: false },
    { name: '📝 Message', value: (message.content || '*pièce jointe*').slice(0, 500), inline: false },
  ]);
  return true;
}

// ── Anti-liens : supprime les URL hors whitelist ─────────────────────────────
function containsForbiddenLink(message, cfg) {
  const urlRegex = /(https?:\/\/|www\.)[^\s<]+/gi;
  const found = message.content.match(urlRegex);
  if (!found) return false;
  const whitelist = (cfg.linksWhitelist || []).map(d => d.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  return found.some(url => {
    try {
      const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
      return !whitelist.some(d => host === d || host.endsWith(`.${d}`));
    } catch {
      return true; // URL malformée → considérée interdite
    }
  });
}

async function handleLinks(message, cfg) {
  if (!containsForbiddenLink(message, cfg)) return false;
  const effect = await applyAction(message, cfg.linksAction === 'mute' ? 'mute' : 'delete', 10, { escalate: cfg.spamEscalate !== false });
  await logInfraction(message.client, message.guild.id, cfg, 'Lien non autorisé', [
    { name: '👤 Membre', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
    { name: '💬 Salon', value: `<#${message.channelId}>`, inline: true },
    { name: '⚡ Action', value: effect || 'delete', inline: true },
    { name: '🔗 Message', value: (message.content || '').slice(0, 1024) || '*pièce jointe*', inline: false },
  ]);
  return true;
}

// ── Anti-majuscules : % de caps sur un message assez long ────────────────────
async function handleCaps(message, cfg) {
  const content = (message.content || '').replace(/\s/g, '');
  if (content.length < (cfg.capsMinLength || 10)) return false;
  const letters = content.replace(/[0-9\p{P}\p{S}]/gu, '');
  if (!letters.length) return false;
  const capsRatio = (letters.match(/[A-ZÀ-ÖØ-Þ]/gu) || []).length / letters.length;
  if (capsRatio * 100 < (cfg.capsThreshold || 70)) return false;

  await message.delete().catch(() => {});
  await logInfraction(message.client, message.guild.id, cfg, 'Trop de majuscules', [
    { name: '👤 Membre', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: true },
    { name: '💬 Salon', value: `<#${message.channelId}>`, inline: true },
    { name: '📈 Ratio', value: `${Math.round(capsRatio * 100)}%`, inline: true },
  ]);
  return true;
}

// ── Point d'entrée appelé par messageCreate ───────────────────────────────────
const readAutoMod = require('../../utils/guildConfigCache').registerModel(AutoMod);

async function handleMessage(message) {
  if (!message.guild || message.author?.bot) return false;

  // Cache partagé : messageCreate vient déjà de lire cette configuration, la
  // seconde lecture ne coûte donc aucune requête.
  const cfg = await readAutoMod({ guildId: message.guild.id });
  if (!cfg) return false;
  if (isExempt(message, cfg)) return false;
  if (message.channel.type === ChannelType.GuildForum) return false;

  if (cfg.spamEnabled) {
    const detection = detectMemberSpam(message, cfg);
    if (await handleSpamSignal(message, cfg, detection)) return true;
  }
  if (cfg.linksEnabled && await handleLinks(message, cfg)) return true;
  if (cfg.capsEnabled  && await handleCaps(message, cfg))  return true;
  return false;
}

// ── Exports ───────────────────────────────────────────────────────────────────
// Ce module fournit l'enforcement de l'auto-modération (`handleMessage`, appelé
// par l'event messageCreate). Il n'expose pas de slash command : `/automod`
// faisait doublon avec le panneau `/securite` (mêmes réglages, mêmes exemptions)
// et consommait un slot sur la limite Discord de 100 commandes globales.
module.exports = { handleMessage, applyAction, isExempt, containsForbiddenLink };
