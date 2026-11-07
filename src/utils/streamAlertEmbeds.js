'use strict';
// utils/streamAlertEmbeds.js — Templates de message & embeds stylés pour les alertes Twitch/YouTube
// L'apparence est pilotée par le panneau /streamalerts panel (style, couleur,
// en-tête, titre, description, bouton, image, miniature).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const TWITCH_COLOR  = 0x9146FF;
const YOUTUBE_COLOR = 0xFF0000;

const DEFAULT_TWITCH_MESSAGE  = '🔴 **{streamer}** est en live sur Twitch !';
const DEFAULT_YOUTUBE_MESSAGE = '📺 **{chaine}** vient de publier une nouvelle vidéo !';
const DEFAULT_SOCIAL_MESSAGE  = '📣 **{chaine}** — {titre}';

const STYLE_LABELS = {
  classic: 'Embed (Classic)',
  compact: 'Embed (Compact)',
  text:    'Message texte (sans embed)',
};

// ─── Couleurs ─────────────────────────────────────────────────────────────────
// Accepte '#ff4a4a', '0xFF4A4A', 'FF4A4A' ou un entier. Retourne `fallback` sinon.
function parseColor(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value & 0xFFFFFF;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(?:#|0x)?([0-9a-f]{6})$/i);
    if (m) return parseInt(m[1], 16);
  }
  return fallback;
}

// Inverse de parseColor — sert au panneau (« Color: #ff4a4a »).
function colorToHex(value, fallback = 0x000000) {
  return `#${parseColor(value, fallback).toString(16).padStart(6, '0')}`;
}

// ─── Apparence ────────────────────────────────────────────────────────────────
function normalizeAppearance(opts = {}) {
  const style = STYLE_LABELS[opts.style] ? opts.style : 'classic';
  return {
    color:         opts.color ?? null,
    style,
    headerText:    opts.headerText ?? null,
    titleTemplate: opts.titleTemplate ?? null,
    descriptionTemplate: opts.descriptionTemplate ?? null,
    buttonLabel:   opts.buttonLabel ?? null,
    showImage:     opts.showImage !== false,
    showThumbnail: opts.showThumbnail !== false,
  };
}

// Depuis un document StreamAlert (les champs peuvent être absents : anciennes alertes).
function appearanceFromAlert(alert = {}) {
  return normalizeAppearance({
    color:               alert.embedColor,
    style:               alert.embedStyle,
    headerText:          alert.headerText,
    titleTemplate:       alert.titleTemplate,
    descriptionTemplate: alert.descriptionTemplate,
    buttonLabel:         alert.buttonLabel,
    showImage:           alert.showImage,
    showThumbnail:       alert.showThumbnail,
  });
}

// ─── Remplacer les placeholders ───────────────────────────────────────────────
// Clés historiques ({streamer} {chaine} {titre} {jeu} {lien}) et alias du
// panneau ({title} {channel} {published} {game}).
function renderTemplate(template, data = {}) {
  const map = {
    streamer:  data.streamer || data.chaine || data.channel || '',
    chaine:    data.chaine   || data.channel || data.streamer || '',
    channel:   data.channel  || data.chaine  || data.streamer || '',
    titre:     data.titre    || data.title   || '',
    title:     data.title    || data.titre   || '',
    jeu:       data.jeu      || data.game    || '',
    game:      data.game     || data.jeu     || '',
    lien:      data.lien     || data.link    || '',
    link:      data.link     || data.lien    || '',
    published: data.published || '',
    author:    data.author   || data.auteur || '',
    auteur:    data.auteur   || data.author || '',
  };
  return String(template ?? '').replace(
    /\{(streamer|chaine|channel|titre|title|jeu|game|lien|link|published|author|auteur)\}/g,
    (_, key) => map[key],
  );
}

// ─── Redimensionner une miniature Twitch (URL template {width}x{height}) ─────
function resolveTwitchThumb(url, w = 1280, h = 720) {
  if (!url) return null;
  return url.replace('{width}', w).replace('{height}', h) + `?t=${Date.now()}`;
}

function formatPublished(value) {
  const d = value ? new Date(value) : new Date();
  const ms = Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
  return `<t:${Math.floor(ms / 1000)}:d>`;
}

function clip(text, max) {
  return String(text ?? '').slice(0, max);
}

function linkRow(url, label) {
  if (label === '') return null; // libellé vide = pas de bouton
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel(clip(label, 80)).setStyle(ButtonStyle.Link).setURL(url),
  );
}

// ─── Embed : un streamer Twitch passe en live ─────────────────────────────────
function buildTwitchLiveEmbed(data, appearance = {}) {
  const a = normalizeAppearance(appearance);
  const { login, displayName, avatarUrl, title, gameName, thumbnailUrl, viewerCount, startedAt } = data;
  const url = `https://twitch.tv/${login}`;
  const name = displayName || login;
  const vars = {
    streamer: name,
    channel:  name,
    title:    title || 'Stream en cours',
    game:     gameName || '',
    published: formatPublished(startedAt),
    lien:     url,
  };
  const color  = parseColor(a.color, TWITCH_COLOR);
  const header = renderTemplate(a.headerText || '{streamer} est en live sur Twitch !', vars);
  const embedTitle = renderTemplate(a.titleTemplate || '{title}', vars) || 'Stream en cours';
  const buttonLabel = a.buttonLabel === null ? '🔴 Regarder sur Twitch' : renderTemplate(a.buttonLabel, vars);
  const row = linkRow(url, buttonLabel);

  if (a.style === 'text') return { embed: null, row: null, url };

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: clip(header, 256), iconURL: avatarUrl || undefined, url })
    .setTitle(clip(embedTitle, 256))
    .setURL(url)
    .setFooter({ text: 'REZO • Alertes Twitch' })
    .setTimestamp(startedAt ? new Date(startedAt) : new Date());

  if (a.style === 'classic') {
    const desc = a.descriptionTemplate ? renderTemplate(a.descriptionTemplate, vars) : null;
    if (desc) embed.setDescription(clip(desc, 4096));

    const fields = [];
    if (gameName)                        fields.push({ name: '🎮 Jeu',     value: clip(gameName, 1024), inline: true });
    if (typeof viewerCount === 'number') fields.push({ name: '👀 Viewers', value: String(viewerCount),  inline: true });
    fields.push({ name: '🔗 Lien', value: `[Regarder le stream](${url})`, inline: true });
    embed.addFields(fields);

    if (a.showImage) {
      const thumb = resolveTwitchThumb(thumbnailUrl);
      if (thumb) embed.setImage(thumb);
    }
  }

  if (a.showThumbnail && avatarUrl) embed.setThumbnail(avatarUrl);

  return { embed, row, url };
}

// ─── Embed : une nouvelle vidéo YouTube est publiée ───────────────────────────
function buildYoutubeVideoEmbed(data, appearance = {}) {
  const a = normalizeAppearance(appearance);
  const { channelName, channelId, channelThumbnail, title, url, thumbnail, description, publishedAt } = data;
  const channelUrl = `https://www.youtube.com/channel/${channelId}`;
  const name = channelName || 'Chaîne YouTube';
  const vars = {
    channel:   name,
    chaine:    name,
    streamer:  name,
    title:     title || 'Nouvelle vidéo',
    published: formatPublished(publishedAt),
    lien:      url,
  };
  const color = parseColor(a.color, YOUTUBE_COLOR);
  const header = renderTemplate(a.headerText || '{channel} a publié une nouvelle vidéo !', vars);
  const embedTitle = renderTemplate(a.titleTemplate || '{title}', vars) || 'Nouvelle vidéo';
  const buttonLabel = a.buttonLabel === null ? '▶️ Regarder sur YouTube' : renderTemplate(a.buttonLabel, vars);
  const row = linkRow(url, buttonLabel);

  if (a.style === 'text') return { embed: null, row: null, url };

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: clip(header, 256), url: channelUrl })
    .setTitle(clip(embedTitle, 256))
    .setURL(url)
    .setFooter({ text: 'REZO • Alertes YouTube' })
    .setTimestamp(publishedAt ? new Date(publishedAt) : new Date());

  if (a.style === 'classic') {
    const desc = a.descriptionTemplate ? renderTemplate(a.descriptionTemplate, vars) : (description || null);
    if (desc) embed.setDescription(clip(desc, 4096));
    if (a.showImage && thumbnail) embed.setImage(thumbnail);
  }

  if (a.showThumbnail) {
    const thumb = channelThumbnail || (a.style === 'compact' ? thumbnail : null);
    if (thumb) embed.setThumbnail(thumb);
  }

  return { embed, row, url };
}

// ─── Embed : une nouvelle publication (RSS/Atom ou Bluesky) ──────────────────
function buildSocialPostEmbed(data, appearance = {}, meta = {}) {
  const a = normalizeAppearance(appearance);
  const { channelName, author, authorAvatar, title, url, description, image, publishedAt } = data;
  const label = meta.label || 'Flux RSS';
  const color = parseColor(a.color, meta.color ?? 0xF26522);
  const displayAuthor = author || channelName || label;
  const displayTitle = title || 'Nouvelle publication';
  const vars = {
    channel: channelName || displayAuthor,
    chaine:  channelName || displayAuthor,
    author:  displayAuthor,
    auteur:  displayAuthor,
    title:   displayTitle,
    titre:   displayTitle,
    published: formatPublished(publishedAt),
    lien:    url || '',
  };

  const header = renderTemplate(a.headerText || '{channel} a publié une nouvelle publication !', vars);
  const embedTitle = renderTemplate(a.titleTemplate || '{title}', vars) || displayTitle;
  const buttonLabel = a.buttonLabel === null
    ? (meta.buttonLabel || '🔗 Lire la publication')
    : renderTemplate(a.buttonLabel, vars);
  const row = url ? linkRow(url, buttonLabel) : null;

  if (a.style === 'text') return { embed: null, row: null, url };

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: clip(header, 256), iconURL: authorAvatar || undefined, url: url || meta.siteUrl || undefined })
    .setTitle(clip(embedTitle, 256))
    .setFooter({ text: `REZO • Alertes ${label}` })
    .setTimestamp(publishedAt ? new Date(publishedAt) : new Date());
  if (url) embed.setURL(url);

  if (a.style === 'classic') {
    const desc = a.descriptionTemplate ? renderTemplate(a.descriptionTemplate, vars) : (description || null);
    if (desc) embed.setDescription(clip(desc, 4096));
    if (a.showImage && image) embed.setImage(image);
  }

  if (a.showThumbnail) {
    const thumb = authorAvatar || (a.style === 'compact' ? image : null);
    if (thumb) embed.setThumbnail(thumb);
  }

  return { embed, row, url };
}

module.exports = {
  TWITCH_COLOR,
  YOUTUBE_COLOR,
  STYLE_LABELS,
  DEFAULT_TWITCH_MESSAGE,
  DEFAULT_YOUTUBE_MESSAGE,
  DEFAULT_SOCIAL_MESSAGE,
  parseColor,
  colorToHex,
  normalizeAppearance,
  appearanceFromAlert,
  formatPublished,
  renderTemplate,
  resolveTwitchThumb,
  buildTwitchLiveEmbed,
  buildYoutubeVideoEmbed,
  buildSocialPostEmbed,
};
