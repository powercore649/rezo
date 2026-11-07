// utils/welcomeManager.js — Moteur central du système "Bienvenue+" de REZO
// Tout ce qui touche au rendu/envoi des arrivées et départs passe ici :
//   • variables de template riches ({user}, {username}, {mention}, {server},
//     {count}, {memberCount}, {created}, {inviter}, {inviteCode}, {invites},
//     {channel}, {rules}, {date}, {time})
//   • rendu embed ou message brut, avec image canvas stylée optionnelle
//   • MP de bienvenue
//   • boutons d'accueil
//   • compteur de membres dans un salon vocal
//   • statistiques de bienvenue (joins du jour / semaine / total)
const {
  EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { COLORS } = require('./embeds');
const { renderWelcomeImage } = require('./welcomeCards');
const guildBrand = require('./guildBrand');

// ─── Couleurs ─────────────────────────────────────────────────────────────────
const WELCOME_COLOR = 0x57F287; // vert arrivée
const FAREWELL_COLOR = 0xFF6B6B; // rouge départ

function parseColor(input, fallback) {
  if (!input) return fallback;
  const str = String(input).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(str)) return parseInt(str.slice(1), 16);
  const n = Number(str);
  return Number.isInteger(n) && n >= 0 && n <= 0xFFFFFF ? n : fallback;
}

// ─── Variables de template ────────────────────────────────────────────────────
/**
 * Remplace les variables REZO dans un template.
 * @param {string} template
 * @param {object} ctx { member, guild, client, inviterId, inviteCode, inviteCount }
 * @returns {string}
 */
function resolveWelcomePlaceholders(template, ctx) {
  const { member, guild, client, inviterId, inviteCode, inviteCount } = ctx;
  if (!template) return '';
  const now = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  let out = String(template)
    .replaceAll('{user}', `<@${member.id}>`) // {user} = mention (compat ancien système)
    .replaceAll('{mention}', `<@${member.id}>`)
    .replaceAll('{username}', member.user.username)
    .replaceAll('{server}', guild.name)
    .replaceAll('{count}', String(guild.memberCount))
    .replaceAll('{memberCount}', String(guild.memberCount))
    .replaceAll('{membercount}', String(guild.memberCount))
    .replaceAll('{created}', member.user?.createdTimestamp
      ? `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`
      : 'date inconnue')
    .replaceAll('{date}', dateStr)
    .replaceAll('{time}', timeStr)
    .replaceAll('{channel}', ctx.channelId ? `<#${ctx.channelId}>` : '');

  // Salon de règles : rulesChannelId en priorité, sinon détection par nom
  if (out.includes('{rules}')) {
    let rules = null;
    if (guild.rulesChannelId) rules = `<#${guild.rulesChannelId}>`;
    else {
      const found = guild.channels.cache.find(c => /r[èe]glement|rules|bienvenue|accueil/i.test(c.name));
      if (found) rules = `<#${found.id}>`;
    }
    out = out.replaceAll('{rules}', rules || '');
  }

  // Invitation
  out = out.replaceAll('{inviter}', inviterId ? `<@${inviterId}>` : '*inconnu*');
  out = out.replaceAll('{inviteCode}', inviteCode || 'inconnu');
  out = out.replaceAll('{invites}', inviteCount != null ? String(inviteCount) : '?');

  // Émojis d'application REZO (fallback 🚀 si l'emoji n'est pas uploadé)
  if (out.includes('{bump_emoji}')) {
    let emoji = '🚀';
    if (client) {
      try {
        const { getAppEmoji } = require('./emojiSync');
        emoji = getAppEmoji(client, 'bump') || '🚀';
      } catch { /* garde le fallback */ }
    }
    out = out.replaceAll('{bump_emoji}', emoji);
  }

  return out;
}

// ─── Rendu du message principal ───────────────────────────────────────────────
/**
 * Construit le payload Discord (embeds/files/components) du message de bienvenue.
 * @returns {Promise<object|null>} payload prêt pour channel.send()
 */
async function buildWelcomePayload(member, guild, cfg, ctx = {}) {
  const content = resolveWelcomePlaceholders(cfg.message, ctx) || 'Bienvenue !';
  const brandCfg = await guildBrand.prime(guild.id).catch(() => null);
  const useEmbed = cfg.renderStyle !== 'plain';

  // Image canvas
  let attachment = null;
  if (cfg.imageStyle && cfg.imageStyle !== 'off') {
    try {
      const buf = await Promise.race([
        renderWelcomeImage(member, guild, cfg),
        new Promise((_, rej) => setTimeout(() => rej(new Error('welcome-image-timeout')), 7000)),
      ]);
      attachment = new AttachmentBuilder(buf, { name: 'welcome.png' });
    } catch (err) {
      console.warn('[welcomeManager] image bienvenue indisponible:', err.message);
    }
  }

  const payload = {};
  const components = buildWelcomeButtons(cfg.buttons);

  if (useEmbed) {
    const embed = new EmbedBuilder()
      .setColor(parseColor(cfg.embedColor, WELCOME_COLOR))
      .setDescription(content.slice(0, 4000))
      .setTimestamp();
    if (cfg.embedTitle) embed.setTitle(resolveWelcomePlaceholders(cfg.embedTitle, ctx).slice(0, 256));
    if (attachment) {
      embed.setImage('attachment://welcome.png');
      payload.files = [attachment];
    } else if (member.user?.displayAvatarURL) {
      embed.setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 128 }));
    }
    if (brandCfg?.enabled) guildBrand.applyBrandToEmbed(embed, brandCfg);
    payload.embeds = [embed];
    if (components.length) payload.components = components;
    return payload;
  }

  // Message brut : pas d'embed, image en pièce jointe simple
  payload.content = content.slice(0, 2000);
  if (attachment) payload.files = [attachment];
  if (components.length) payload.components = components;
  return payload;
}

// ─── Boutons d'accueil ────────────────────────────────────────────────────────
// Un bouton n'affiche que de l'Unicode : un ancien emoji custom `nom:id` ou
// `<:nom:id>` est ignoré (le bouton reste, sans emoji).
function unicodeButtonEmoji(value) {
  const emoji = String(value || '').trim();
  if (!emoji) return null;
  if (/^<a?:[A-Za-z0-9_]+:\d{5,}>$/.test(emoji)) return null;
  if (/^[A-Za-z0-9_]+:\d{5,}$/.test(emoji)) return null;
  return emoji.slice(0, 16);
}

function buildWelcomeButtons(buttons) {
  const valid = (buttons || [])
    .filter(b => b?.label && b?.url && /^https?:\/\//i.test(b.url))
    .slice(0, 5);
  if (!valid.length) return [];
  return [new ActionRowBuilder().addComponents(
    valid.map(b => {
      const btn = new ButtonBuilder()
        .setLabel(String(b.label).slice(0, 80))
        .setStyle(ButtonStyle.Link)
        .setURL(b.url.slice(0, 512));
      const emoji = unicodeButtonEmoji(b.emoji);
      if (emoji) btn.setEmoji(emoji);
      return btn;
    }),
  )];
}

// ─── Envoi du message de bienvenue ────────────────────────────────────────────
async function sendWelcome(member, cfg, ctx = {}) {
  const guild = member.guild;
  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  // Vérification basique des permissions du bot
  const me = guild.members.me;
  if (!me || !channel.permissionsFor(me).has(PermissionFlagsBits.SendMessages)) return false;

  try {
    const payload = await buildWelcomePayload(member, guild, cfg, ctx);
    const brandCfg = await guildBrand.prime(guild.id).catch(() => null);
    // Le profil serveur (avatar/bannière/surnom du bot) est appliqué par
    // `/branding` via guild.members.editMe : inutile de passer par un webhook.
    const sent = await channel.send(payload);
    return Boolean(sent);
  } catch (err) {
    console.warn('[welcomeManager] envoi bienvenue:', err.message);
    return false;
  }
}

// ─── MP de bienvenue ──────────────────────────────────────────────────────────
async function sendWelcomeDM(member, cfg, ctx = {}) {
  if (!cfg.dmEnabled || !cfg.dmMessage) return false;
  const guild = member.guild;
  const content = resolveWelcomePlaceholders(cfg.dmMessage, { ...ctx, channelId: cfg.channelId });
  try {
    if (cfg.dmEmbed) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`Bienvenue sur ${guild.name} !`)
        .setDescription(content.slice(0, 4000))
        .setThumbnail(guild.iconURL({ extension: 'png', size: 128 }))
        .setTimestamp();
      const brandCfg = await guildBrand.prime(guild.id).catch(() => null);
      if (brandCfg?.enabled) guildBrand.applyBrandToEmbed(embed, brandCfg);
      await member.send({ embeds: [embed] });
    } else {
      await member.send({ content: content.slice(0, 2000) });
    }
    return true;
  } catch {
    return false; // MPs fermés — silencieux, c'est normal
  }
}

// ─── Message d'au revoir ──────────────────────────────────────────────────────
async function sendFarewell(member, cfg) {
  const guild = member.guild;
  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const ctx = { member, guild };
  const content = resolveWelcomePlaceholders(cfg.message || '**{username}** a quitté le serveur.', ctx);

  let attachment = null;
  if (cfg.imageStyle && cfg.imageStyle !== 'off') {
    try {
      const buf = await Promise.race([
        renderWelcomeImage(member, guild, cfg),
        new Promise((_, rej) => setTimeout(() => rej(new Error('farewell-image-timeout')), 7000)),
      ]);
      attachment = new AttachmentBuilder(buf, { name: 'farewell.png' });
    } catch (err) {
      console.warn('[welcomeManager] image au revoir indisponible:', err.message);
    }
  }

  try {
    const brandCfg = await guildBrand.prime(guild.id).catch(() => null);

    if (cfg.renderStyle === 'plain') {
      const payload = { content: content.slice(0, 2000) };
      if (attachment) payload.files = [attachment];
      const sent = await channel.send(payload);
      return Boolean(sent);
    }

    const embed = new EmbedBuilder()
      .setColor(parseColor(cfg.embedColor, FAREWELL_COLOR))
      .setDescription(content.slice(0, 4000))
      .setTimestamp();
    if (cfg.embedTitle) embed.setTitle(resolveWelcomePlaceholders(cfg.embedTitle, ctx).slice(0, 256));
    if (attachment) embed.setImage('attachment://farewell.png');
    else embed.setThumbnail(member.user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || undefined);
    if (brandCfg?.enabled) guildBrand.applyBrandToEmbed(embed, brandCfg);

    const payload = { embeds: [embed] };
    if (attachment) payload.files = [attachment];
    const sent = await channel.send(payload);
    return Boolean(sent);
  } catch (err) {
    console.warn('[welcomeManager] envoi au revoir:', err.message);
    return false;
  }
}

// ─── Compteur de membres (salon vocal renommé) ────────────────────────────────
async function updateMemberCounter(guild, cfg) {
  if (!cfg?.counterEnabled || !cfg.counterChannelId) return false;
  const ch = await guild.channels.fetch(cfg.counterChannelId).catch(() => null);
  if (!ch || (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice)) return false;

  const me = guild.members.me;
  if (!me || !ch.permissionsFor(me).has(PermissionFlagsBits.ManageChannels)) return false;

  const name = (cfg.counterTemplate || '👥 {count} membres')
    .replaceAll('{count}', String(guild.memberCount))
    .replaceAll('{server}', guild.name)
    .slice(0, 100);

  if (ch.name !== name) {
    await ch.setName(name, 'Compteur de membres REZO').catch(() => {});
  }
  return true;
}

// ─── Statistiques de bienvenue ────────────────────────────────────────────────
async function recordJoinStats(Welcome, guild) {
  try {
    const cfg = await Welcome.findOne({ guildId: guild.id });
    if (!cfg) return null;
    const now = new Date();
    const s = cfg.stats;
    if (!s) return null;

    // Reset quotidien implicite : si le dernier join date d'hier ou avant
    if (!s.lastJoinDate || !isSameDay(s.lastJoinDate, now)) s.joinsToday = 0;
    // Reset hebdomadaire (semaine ISO glissante de 7 jours)
    if (!s.lastWeekReset || now - s.lastWeekReset >= 7 * 86400000) {
      s.joinsWeek = 0;
      s.lastWeekReset = now;
    }

    s.joinsToday += 1;
    s.joinsWeek += 1;
    s.joinsTotal += 1;
    s.lastJoinDate = now;
    await cfg.save();
    return s;
  } catch (err) {
    console.warn('[welcomeManager] stats:', err.message);
    return null;
  }
}

async function recordLeaveStats(Welcome, guild) {
  try {
    const cfg = await Welcome.findOne({ guildId: guild.id });
    if (!cfg?.stats) return;
    cfg.stats.joinsTotal = Math.max(0, cfg.stats.joinsTotal - 1);
    await cfg.save();
  } catch { /* non critique */ }
}

function isSameDay(a, b) {
  return a && b && a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

module.exports = {
  resolveWelcomePlaceholders,
  buildWelcomePayload,
  buildWelcomeButtons,
  unicodeButtonEmoji,
  sendWelcome,
  sendWelcomeDM,
  sendFarewell,
  updateMemberCounter,
  recordJoinStats,
  recordLeaveStats,
  parseColor,
  WELCOME_COLOR,
  FAREWELL_COLOR,
};
