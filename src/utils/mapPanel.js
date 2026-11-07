'use strict';
// utils/mapPanel.js — Embed et boutons de la carte interactive.
//
// Le panneau est PUBLIC : tout le monde peut déplacer la carte d'un message,
// comme on ferait glisser une carte papier posée sur la table. Aucune donnée
// sensible n'y transite — seulement un point géographique choisi par l'auteur.
//
// Deux états cohabitent, et c'est volontaire :
//   • la VUE (centre, zoom, style) voyage dans le customId de chaque bouton :
//     elle est donc toujours juste, y compris après un redémarrage du bot ;
//   • le LIBELLÉ du lieu (« Tour Eiffel, Paris ») est gardé en mémoire, indexé
//     par l'id du message : il ne sert qu'à l'affichage, et s'il est perdu on
//     retombe proprement sur les coordonnées.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { COLORS } = require('./embeds');
const brand = require('./brand');
const {
  encodeState, decodeState, formatCoords, normalizeState, pan, zoomBy, nextTheme,
  googleMapsLink, themeLabel, MAX_ZOOM,
} = require('./mapEngine');

const IMAGE_NAME = 'carte.png';

/** Nom de la pièce jointe associé au format renvoyé par le rendu. */
function imageNameFor(mime) {
  return mime === 'image/jpeg' ? 'carte.jpg' : IMAGE_NAME;
}
const MAX_PANELS = 800;

const panels = new Map(); // messageId → { label, origin }

function remember(messageId, meta) {
  if (!messageId) return;
  if (panels.size >= MAX_PANELS) {
    const oldest = panels.keys().next().value;
    if (oldest !== undefined) panels.delete(oldest);
  }
  panels.set(messageId, {
    label: meta?.label || null,
    origin: meta?.origin ? normalizeState(meta.origin) : null,
  });
}

function recall(messageId) {
  return panels.get(messageId) || null;
}

function forget(messageId) {
  panels.delete(messageId);
}

/**
 * Applique un bouton à la vue courante.
 * `reset` revient au lieu d'origine (s'il est encore connu) en gardant le style ;
 * `style` bascule clair/sombre sans bouger la vue.
 */
function nextState(state, meta = null) {
  const current = normalizeState(state);
  const action = state?.action;

  if (action === 'reset') {
    const origin = meta?.origin ? normalizeState(meta.origin) : null;
    return origin ? { ...origin, theme: current.theme } : current;
  }
  if (action === 'style') {
    return { ...current, theme: nextTheme(current.theme) };
  }
  if (action === 'in') return zoomBy(current, 1);
  if (action === 'out') return zoomBy(current, -1);
  return pan(current, action);
}

function titleFor(state, label) {
  if (label) return `🗺️ ${label}`.slice(0, 256);
  return `🗺️ Carte — ${formatCoords(state.lat, state.lon, 3)}`;
}

/**
 * @param {{lat:number, lon:number, zoom:number, theme:string}} state
 * @param {{label?:string|null, attribution?:string, hasImage?:boolean, notice?:string|null}} [options]
 */
function mapEmbed(state, {
  label = null,
  attribution = '© OpenStreetMap contributors · Esri',
  hasImage = true,
  notice = null,
  imageName = IMAGE_NAME,
} = {}) {
  const view = normalizeState(state);
  const lines = [
    notice || '',
    `📍 \`${formatCoords(view.lat, view.lon)}\` · ${themeLabel(view.theme)}`,
    hasImage
      ? 'Utilise **⬅️ ⬆️ ⬇️ ➡️** pour te déplacer, **➕ ➖** pour zoomer. **🎯** revient au point de départ, **🌓** change de fond de carte.'
      : '⚠️ Rendu d’image indisponible sur cette machine — la carte reste consultable via le lien ci-dessous.',
    `[Ouvrir dans Google Maps](${googleMapsLink(view)})`,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: brand.footer('Cartographie') })
    .setTitle(titleFor(view, label))
    .setDescription(lines.join('\n').slice(0, 4000))
    .addFields(
      { name: '🔍 Zoom', value: `**${view.zoom}** / ${MAX_ZOOM}`, inline: true },
      { name: '🎨 Fond', value: themeLabel(view.theme), inline: true },
      { name: '🧭 Sources', value: 'OpenStreetMap · Esri', inline: true },
    )
    .setFooter({ text: brand.footer(`${attribution} • carte interactive`) });

  if (hasImage) embed.setImage(`attachment://${imageName}`);
  return embed;
}

function mapComponents(state) {
  const view = normalizeState(state);
  const button = (action, emoji, label, style = ButtonStyle.Secondary) => {
    const b = new ButtonBuilder()
      .setCustomId(encodeState({ ...view, action }))
      .setEmoji(emoji)
      .setLabel(label)
      .setStyle(style);
    return b;
  };

  const row1 = new ActionRowBuilder().addComponents(
    button('left', '⬅️', 'Gauche'),
    button('up', '⬆️', 'Haut'),
    button('down', '⬇️', 'Bas'),
    button('right', '➡️', 'Droite'),
  );

  const row2 = new ActionRowBuilder().addComponents(
    button('out', '➖', 'Dézoomer'),
    button('in', '➕', 'Zoomer', ButtonStyle.Primary),
    button('reset', '🎯', 'Recentrer'),
    button('style', '🌓', 'Style'),
    new ButtonBuilder()
      .setLabel('Google Maps')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Link)
      .setURL(googleMapsLink(view)),
  );

  return [row1, row2];
}

module.exports = {
  IMAGE_NAME,
  imageNameFor,
  MAX_PANELS,
  mapEmbed,
  mapComponents,
  nextState,
  remember,
  recall,
  forget,
  titleFor,
  decodeState,
};
