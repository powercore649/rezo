'use strict';
// utils/ui.js — REFONTE VISUELLE REZO : moteur de thème global + composants.
//
// Le bot comptait plus de 500 embeds écrits à la main, chacun avec sa couleur,
// son pied de page et ses propres limites. Réécrire 180 fichiers un par un
// aurait été long et fragile : ce module normalise donc l'apparence au moment
// de l'envoi, via EmbedBuilder#toJSON.
//
// Conséquences concrètes, pour TOUS les embeds du bot (commandes, panneaux,
// logs, alertes, messages automatiques) :
//   • couleur de marque appliquée quand aucune n'est définie ;
//   • signature REZO unifiée en pied de page ;
//   • limites Discord respectées (titre, description, champs, budget total) :
//     plus d'embed refusé (« Invalid Form Body ») parce qu'il était trop long.
//
// Les panneaux qui veulent aller plus loin utilisent les composants exportés
// ici (panelEmbed, listEmbed, emptyEmbed, metric, progress, statusDot).

const { BRAND } = require('./brand');
const emojiSync = require('./emojiSync');

// ─── Jetons de design ────────────────────────────────────────────────────────
const PALETTE = {
  brand:   BRAND.colors.primary,
  gold:    BRAND.colors.accent,
  success: BRAND.colors.success,
  warning: BRAND.colors.warning,
  danger:  BRAND.colors.error,
  info:    BRAND.colors.info,
  muted:   BRAND.colors.muted,
  surface: BRAND.colors.surface,
};

const GLYPH = {
  full:  '▰',
  empty: '▱',
  rule:  '▬',
  dot:   '•',
};

const LIMITS = {
  title:       256,
  description: 4096,
  fieldName:   256,
  fieldValue:  1024,
  fields:      25,
  footer:      2048,
  total:       5800, // marge sous la limite Discord de 6000 caractères
};

const TONE_EMOJI = { ok: '🟢', warn: '🟡', partial: '🟡', off: '🔴', error: '🔴' };

// ─── Helpers texte ───────────────────────────────────────────────────────────
function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function divider(length = 12) {
  return GLYPH.rule.repeat(Math.max(1, length));
}

function footerText(context = null) {
  return context
    ? `${BRAND.name} ${GLYPH.dot} ${context}`
    : `${BRAND.name} ${GLYPH.dot} v${BRAND.version}`;
}

function statusDot(ok) {
  return ok ? TONE_EMOJI.ok : TONE_EMOJI.off;
}

function toneDot(level) {
  return TONE_EMOJI[level] || TONE_EMOJI.off;
}

function progress(percent, { length = 12, label = true } = {}) {
  const value = Number(percent);
  const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
  const filled = Math.round((pct / 100) * length);
  const bar = GLYPH.full.repeat(filled) + GLYPH.empty.repeat(Math.max(0, length - filled));
  return label ? `${bar} \`${pct}%\`` : bar;
}

/** Champ de métrique homogène : libellé en gras, valeur en dessous. */
function metric(label, value, inline = true) {
  return { name: String(label), value: String(value), inline };
}

// ─── Normalisation (thème global) ────────────────────────────────────────────
function sizeOf(data = {}) {
  return (data.title?.length || 0)
    + (data.description?.length || 0)
    + (data.author?.name?.length || 0)
    + (data.footer?.text?.length || 0)
    + (data.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

/**
 * Normalise un embed sérialisé. Pure : l'objet d'entrée n'est jamais modifié,
 * ce qui rend la fonction testable et sûre à appeler à chaque envoi.
 */
function normalizeEmbedData(input = {}) {
  if (!input || typeof input !== 'object') return input;

  const data = { ...input };

  // Conversion Unicode → emojis animés AVANT les limites : une balise
  // `<a:rezo_x:123…>` est bien plus longue qu'un emoji Unicode, il faut donc
  // la compter dans le budget. Un emoji sans équivalent est retiré.
  try {
    if (data.title) data.title = emojiSync.replaceUnicode(data.title);
    if (data.description) data.description = emojiSync.replaceUnicode(data.description);
    if (data.author?.name) data.author = { ...data.author, name: emojiSync.replaceUnicode(data.author.name) };
    if (data.footer?.text) data.footer = { ...data.footer, text: emojiSync.replaceUnicode(data.footer.text) };
    if (Array.isArray(data.fields)) {
      data.fields = data.fields.map(field => (field && typeof field === 'object'
        ? {
          ...field,
          name: typeof field.name === 'string' ? emojiSync.replaceUnicode(field.name) : field.name,
          value: typeof field.value === 'string' ? emojiSync.replaceUnicode(field.value) : field.value,
        }
        : field));
    }
  } catch { /* la conversion ne doit jamais empêcher un envoi */ }

  if (!Number.isFinite(data.color)) data.color = PALETTE.brand;
  if (data.title) data.title = clip(data.title, LIMITS.title);
  if (data.description) data.description = clip(data.description, LIMITS.description);
  if (data.author?.name) data.author = { ...data.author, name: clip(data.author.name, 256) };

  if (Array.isArray(data.fields)) {
    data.fields = data.fields
      .filter(field => field && String(field.name ?? '').trim() && String(field.value ?? '').trim())
      .slice(0, LIMITS.fields)
      .map(field => ({
        name:   clip(field.name, LIMITS.fieldName),
        value:  clip(field.value, LIMITS.fieldValue),
        inline: Boolean(field.inline),
      }));
    if (!data.fields.length) delete data.fields;
  }

  const footer = data.footer || {};
  data.footer = { text: clip(String(footer.text || '').trim() || footerText(), LIMITS.footer) };
  if (footer.iconURL) data.footer.iconURL = footer.iconURL;

  // Budget global : on rogne la description puis les champs les moins utiles
  // (les derniers) plutôt que de laisser Discord refuser l'embed entier.
  let overflow = sizeOf(data) - LIMITS.total;
  if (overflow > 0 && data.description) {
    data.description = clip(data.description, Math.max(0, data.description.length - overflow - 1));
    if (!data.description) delete data.description;
    overflow = sizeOf(data) - LIMITS.total;
  }
  if (overflow > 0 && Array.isArray(data.fields)) {
    while (overflow > 0 && data.fields.length > 1) {
      data.fields.pop();
      overflow = sizeOf(data) - LIMITS.total;
    }
    if (overflow > 0 && data.fields.length === 1) {
      const only = data.fields[0];
      only.value = clip(only.value, Math.max(0, only.value.length - overflow - 1));
    }
    if (!data.fields.length) delete data.fields;
  }

  return data;
}

let themeInstalled = false;

/**
 * Branche le thème sur EmbedBuilder#toJSON. Idempotent : appelable depuis le
 * démarrage comme depuis un test sans jamais doubler le traitement.
 */
function installGlobalTheme() {
  if (themeInstalled) return;
  const { EmbedBuilder } = require('discord.js');
  if (EmbedBuilder.prototype.__rezoTheme) { themeInstalled = true; return; }

  const original = EmbedBuilder.prototype.toJSON;
  EmbedBuilder.prototype.toJSON = function rezoThemedJSON() {
    const data = original.call(this);
    try {
      return normalizeEmbedData(data);
    } catch {
      return data; // une normalisation ne doit jamais empêcher un envoi
    }
  };

  Object.defineProperty(EmbedBuilder.prototype, '__rezoTheme', { value: true });

  // Boutons, menus et modaux ne passent pas par EmbedBuilder : sans ce
  // branchement, leurs libellés garderaient des emojis Unicode alors que les
  // embeds sont déjà convertis. On convertit au moment de la sérialisation.
  const {
    ButtonBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    UserSelectMenuBuilder,
    RoleSelectMenuBuilder,
    MentionableSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
  } = require('discord.js');

  const patchText = (Builder, fields) => {
    if (typeof Builder?.prototype?.toJSON !== 'function') return;
    const original = Builder.prototype.toJSON;
    Builder.prototype.toJSON = function rezoEmojiJSON() {
      const data = original.call(this);
      try {
        for (const field of fields) {
          if (typeof data?.[field] === 'string') data[field] = emojiSync.replaceUnicode(data[field]);
        }
        if (Array.isArray(data?.options)) {
          data.options = data.options.map(option => {
            const next = {
              ...option,
              label: typeof option.label === 'string' ? emojiSync.replaceUnicode(option.label) : option.label,
              description: typeof option.description === 'string'
                ? emojiSync.replaceUnicode(option.description)
                : option.description,
            };
            if (next.emoji) {
              const resolved = emojiSync.resolveEmoji(next.emoji);
              if (resolved) next.emoji = resolved;
              else delete next.emoji;
            }
            return next;
          });
        }
      } catch { /* jamais bloquant */ }
      return data;
    };
  };

  // Les boutons n'affichent aucun emoji : ni Unicode, ni custom. Le libellé est
  // nettoyé et la propriété emoji retirée — y compris pour les commandes qui
  // appellent encore setEmoji() à la main.
  const originalButtonJSON = ButtonBuilder.prototype.toJSON;
  ButtonBuilder.prototype.toJSON = function rezoButtonJSON() {
    const data = originalButtonJSON.call(this);
    try {
      if (typeof data?.label === 'string') data.label = emojiSync.stripEmojis(data.label);
      if (data && 'emoji' in data) delete data.emoji;
    } catch { /* jamais bloquant */ }
    return data;
  };

  // Les menus de sélection, eux, portent des emojis animés : un pictogramme est
  // résolu vers son équivalent REZO, un emoji étranger au bot est retiré.
  const originalOptionJSON = StringSelectMenuOptionBuilder.prototype.toJSON;
  StringSelectMenuOptionBuilder.prototype.toJSON = function rezoOptionJSON() {
    const data = originalOptionJSON.call(this);
    try {
      if (data?.emoji) {
        const resolved = emojiSync.resolveEmoji(data.emoji);
        if (resolved) data.emoji = resolved;
        else delete data.emoji;
      }
    } catch { /* jamais bloquant */ }
    return data;
  };

  patchText(StringSelectMenuBuilder, ['placeholder']);
  patchText(StringSelectMenuOptionBuilder, ['label', 'description']);
  patchText(UserSelectMenuBuilder, ['placeholder']);
  patchText(RoleSelectMenuBuilder, ['placeholder']);
  patchText(MentionableSelectMenuBuilder, ['placeholder']);
  patchText(ChannelSelectMenuBuilder, ['placeholder']);
  patchText(ModalBuilder, ['title']);
  patchText(TextInputBuilder, ['label', 'placeholder']);

  themeInstalled = true;
}

// ─── Composants de panneau ───────────────────────────────────────────────────
/**
 * Panneau standard : titre, sur-titre + filet, description, champs, signature.
 * C'est la brique commune à tous les écrans refaits.
 */
function panelEmbed({
  title = null,
  subtitle = null,
  description = null,
  fields = [],
  color = PALETTE.brand,
  footer = null,
  thumbnail = null,
  image = null,
  author = null,
  url = null,
  timestamp = true,
} = {}) {
  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder().setColor(color);

  if (author) embed.setAuthor(typeof author === 'string' ? { name: author } : author);
  if (title) embed.setTitle(title);
  if (url) embed.setURL(url);

  const body = [];
  if (subtitle) { body.push(subtitle); body.push(divider()); }
  if (description) body.push(description);
  if (body.length) embed.setDescription(body.join('\n'));

  if (fields.length) embed.addFields(fields);
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);

  embed.setFooter({ text: footerText(footer) });
  if (timestamp) embed.setTimestamp();

  return embed;
}

/**
 * Liste standard : puces, état vide explicite et compteur de dépassement.
 * `items` accepte des chaînes déjà formatées.
 */
function listEmbed({
  title = null,
  subtitle = null,
  items = [],
  empty = '*Rien à afficher pour le moment.*',
  footer = null,
  color = PALETTE.brand,
  max = 12,
  thumbnail = null,
  timestamp = true,
} = {}) {
  const list = Array.isArray(items) ? items.filter(item => String(item ?? '').trim()) : [];
  const shown = list.slice(0, Math.max(1, max));
  const lines = shown.length ? shown.map(item => String(item)) : [empty];
  if (list.length > shown.length) {
    lines.push(`*… et ${list.length - shown.length} autre(s).*`);
  }

  return panelEmbed({
    title,
    subtitle,
    description: lines.join('\n'),
    color,
    footer,
    thumbnail,
    timestamp,
  });
}

/** État vide homogène (gris neutre, jamais une erreur). */
function emptyEmbed(title, description = null) {
  return panelEmbed({ title, description, color: PALETTE.muted });
}

module.exports = {
  PALETTE,
  GLYPH,
  LIMITS,
  clip,
  divider,
  footerText,
  statusDot,
  toneDot,
  progress,
  metric,
  sizeOf,
  normalizeEmbedData,
  installGlobalTheme,
  panelEmbed,
  listEmbed,
  emptyEmbed,
};
