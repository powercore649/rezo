// utils/rankCardPanel.js — Panneau de personnalisation de la carte de rang.
//
// Un seul jeu de composants, trois contextes :
//   • scope 'member'  → /rank, l'accent est mis sur SA carte (override membres)
//   • scope 'server'  → /leveling, l'admin règle la carte de rang du serveur
//   • scope 'levelup' → /leveling → 📢 Annonce de niveau, la carte envoyée lors
//     d'une montée de niveau (page « Textes » en plus : titre et sous-titre)
//
// Les identifiants sont préfixés (`rcp_…` pour le membre, `lvlcard_…` pour la
// carte du serveur, `lvucard_…` pour l'annonce de niveau) : le routage global
// peut donc les distinguer sans ambiguïté.
//
// Ce module est PUREMENT fonctionnel (pas d'accès DB, pas de rendu) : il
// construit les payloads et calcule les modifications à appliquer. Les
// commandes se chargent de sauvegarder et de régénérer l'aperçu.
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { COLORS } = require('./embeds');
const {
  DEFAULT_THEME, ACCENT_PRESETS, BG_PRESETS, TEXT_PRESETS,
  BG_STYLE_CHOICES, BAR_STYLE_CHOICES, AVATAR_SHAPE_CHOICES, TOGGLE_CHOICES,
  normalizeHex, isImageUrl, clampDim, normalizeTheme, describeTheme,
} = require('./rankCardTheme');

const { TEXT_DEFAULTS, TEXT_LIMITS, validateText } = require('./levelUpCardTheme');

const SCOPES = {
  member: { prefix: 'rcp', title: '🎨 Ma carte de rang' },
  server: { prefix: 'lvlcard', title: '🎨 Carte de rang du serveur' },
  // Carte de l'annonce de niveau : même panneau, réglages stockés dans
  // XPConfig.levelUpCard (champ nul = hérité de la carte de rang).
  levelup: { prefix: 'lvucard', title: "🎉 Carte d'annonce de niveau" },
};

const CUSTOM_ACCENT = '__custom__';

// ── Pages ────────────────────────────────────────────────────────────────────
// Discord n'accepte QU'UN SEUL menu déroulant par ligne et 5 lignes par
// message. Le panneau compte 6 menus : il est donc scindé en deux pages.
//
// Chaque modification renvoie sur la page qui la contient (voir `pageForKey`),
// ce qui évite de garder un état de navigation côté bot.
const PANEL_PAGES = {
  colors: {
    label: '🎨 Couleurs',
    hint: 'Couleurs, texte, fond et intensité.',
  },
  layout: {
    label: '🧩 Mise en page',
    hint: 'Barre de progression, avatar et éléments affichés.',
  },
  texts: {
    label: '✍️ Textes',
    hint: 'Titre et sous-titre, avec variables.',
  },
};

const PAGE_OF_KEY = {
  // page « Couleurs »
  sel_accent: 'colors', sel_text: 'colors', sel_bgstyle: 'colors',
  btn_bgcolor: 'colors', btn_bgimage: 'colors', btn_dim: 'colors', btn_enabled: 'colors',
  hex_accent: 'colors', hex_bgcolor: 'colors', hex_text: 'colors', bgimage: 'colors', dim: 'colors',
  // page « Mise en page »
  sel_barstyle: 'layout', sel_shape: 'layout', sel_toggle: 'layout', btn_reset: 'layout',
  // page « Textes » (annonce de niveau uniquement)
  btn_title: 'texts', btn_subtitle: 'texts', btn_page_texts: 'texts', title: 'texts', subtitle: 'texts',
};

function pageOf(page) {
  return PANEL_PAGES[page] ? page : 'colors';
}

/** Page qui contient une option (`rcp_sel_toggle` → `layout`). */
function pageForKey(key, fallback = 'colors') {
  return PAGE_OF_KEY[key] || pageOf(fallback);
}

function scopeOf(scope) {
  const s = SCOPES[scope];
  if (!s) throw new Error(`scope inconnu : ${scope}`);
  return s;
}

// ── Sélecteurs ───────────────────────────────────────────────────────────────
function accentSelect(theme, customId) {
  const presetValues = ACCENT_PRESETS.map(p => p.value);
  const options = ACCENT_PRESETS.map(p => ({
    label: p.label,
    value: p.value,
    default: theme.accentColor === p.value,
  }));
  options.push({
    label: 'Couleur personnalisée…',
    value: CUSTOM_ACCENT,
    description: 'Saisir un code hexadécimal',
    default: !presetValues.includes(theme.accentColor),
  });
  return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('🎨 Couleur d\'accent').addOptions(options);
}

function bgStyleSelect(theme, customId) {
  return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('🌌 Style de fond')
    .addOptions(BG_STYLE_CHOICES.map(c => ({ ...c, default: theme.bgStyle === c.value })));
}

function barStyleSelect(theme, customId) {
  return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('📊 Barre de progression')
    .addOptions(BAR_STYLE_CHOICES.map(c => ({ ...c, default: theme.barStyle === c.value })));
}

function textColorSelect(theme, customId) {
  const presetValues = TEXT_PRESETS.map(p => p.value);
  const options = TEXT_PRESETS.map(p => ({ label: p.label, value: p.value, default: theme.textColor === p.value }));
  options.push({
    label: 'Couleur personnalisée…',
    value: CUSTOM_ACCENT,
    description: 'Saisir un code hexadécimal',
    default: !presetValues.includes(theme.textColor),
  });
  return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('🖋️ Couleur du texte').addOptions(options);
}

function shapeSelect(theme, customId) {
  return new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('👤 Forme de l\'avatar')
    .addOptions(AVATAR_SHAPE_CHOICES.map(c => ({ ...c, default: theme.avatarShape === c.value })));
}

function toggleSelect(theme, customId) {
  const shown = {
    rank: theme.showRank, messages: theme.showMessages,
    totalXp: theme.showTotalXp, footer: theme.showFooter,
  };
  return new StringSelectMenuBuilder().setCustomId(customId)
    .setPlaceholder('👁️ Éléments affichés sur la carte')
    .setMinValues(0).setMaxValues(TOGGLE_CHOICES.length)
    .addOptions(TOGGLE_CHOICES.map(c => ({ ...c, default: !!shown[c.value] })));
}

// ── Panneau complet (embed + composants) ─────────────────────────────────────
/**
 * Construit le panneau de personnalisation.
 * @param {object} theme  thème courant (sera normalisé)
 * @param {'member'|'server'} scope
 * @param {{ notice?: string, overrideEnabled?: boolean }} [opts]
 */
function buildCardPanel(theme, scope, opts = {}) {
  const { prefix, title } = scopeOf(scope);
  const t = normalizeTheme(theme);
  const { notice = null, overrideEnabled = null } = opts;
  // Textes effectifs (annonce de niveau uniquement)
  const texts = opts.texts || {};
  const textTitle = texts.title || TEXT_DEFAULTS.title;
  const textSubtitle = texts.subtitle || TEXT_DEFAULTS.subtitle;
  // La page « Textes » n'existe que pour l'annonce de niveau.
  const requested = pageOf(opts.page);
  const page = requested === 'texts' && scope !== 'levelup' ? 'colors' : requested;

  const lines = [describeTheme(t)];
  if (scope === 'member') {
    lines.push(overrideEnabled
      ? '\n🟢 **Ta personnalisation est active** (elle remplace celle du serveur).'
      : '\n⚪ **Tu utilises la carte du serveur.** Un changement l\'active automatiquement.');
  } else if (scope === 'levelup') {
    lines.push(`\n✍️ **Titre** : \`${textTitle}\``);
    lines.push(`**Sous-titre** : \`${textSubtitle}\``);
    lines.push(texts.custom
      ? '🎨 Visuels **propres aux annonces de niveau** (le reste suit la carte de rang).'
      : '🎨 Visuels **hérités de la carte de rang** — modifie un réglage pour les détacher.');
  } else {
    lines.push('\nCes réglages s\'appliquent à **tous** les membres du serveur (sauf ceux qui ont personnalisé leur carte).');
  }
  const meta = PANEL_PAGES[page];
  lines.push(`\n📄 Page **${meta.label}** — ${meta.hint}`);
  if (notice) lines.push(`\n${notice}`);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`${title} — ${meta.label}`)
    .setDescription(lines.join('\n'))
    .setImage('attachment://card.png')
    .setFooter({ text: scope === 'levelup' ? 'REZO • Annonce de niveau' : 'REZO • Carte de rang' });

  const button = (id, label, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

  // UN SEUL menu par ligne : chaque sélecteur occupe toute la largeur.
  const components = [];

  if (scope === 'levelup' && page === 'texts') {
    components.push(new ActionRowBuilder().addComponents(
      button(`${prefix}_btn_page_layout`, 'Mise en page', '◀'),
      button(`${prefix}_btn_title`, 'Titre', '✍️', ButtonStyle.Primary),
      button(`${prefix}_btn_subtitle`, 'Sous-titre', '💬', ButtonStyle.Primary),
    ));
  } else if (page === 'layout') {
    components.push(new ActionRowBuilder().addComponents(barStyleSelect(t, `${prefix}_sel_barstyle`)));
    components.push(new ActionRowBuilder().addComponents(shapeSelect(t, `${prefix}_sel_shape`)));
    components.push(new ActionRowBuilder().addComponents(toggleSelect(t, `${prefix}_sel_toggle`)));
    const nav = [button(`${prefix}_btn_page_colors`, 'Couleurs', '◀')];
    if (scope === 'levelup') nav.push(button(`${prefix}_btn_page_texts`, 'Textes', '✍️'));
    nav.push(button(`${prefix}_btn_reset`, 'Réinitialiser', '↩️', ButtonStyle.Danger));
    components.push(new ActionRowBuilder().addComponents(...nav));
  } else {
    components.push(new ActionRowBuilder().addComponents(accentSelect(t, `${prefix}_sel_accent`)));
    components.push(new ActionRowBuilder().addComponents(textColorSelect(t, `${prefix}_sel_text`)));
    components.push(new ActionRowBuilder().addComponents(bgStyleSelect(t, `${prefix}_sel_bgstyle`)));
    const actions = [
      button(`${prefix}_btn_bgcolor`, 'Fond : couleur', '🌈'),
      button(`${prefix}_btn_bgimage`, 'Fond : image', '🖼️'),
      button(`${prefix}_btn_dim`, 'Intensité', '🌗'),
    ];
    if (scope === 'member') {
      actions.push(new ButtonBuilder()
        .setCustomId(`${prefix}_btn_enabled`)
        .setLabel(overrideEnabled ? 'Carte du serveur' : 'Activer ma carte')
        .setEmoji(overrideEnabled ? '⚪' : '🟢')
        .setStyle(overrideEnabled ? ButtonStyle.Secondary : ButtonStyle.Success));
    }
    actions.push(button(`${prefix}_btn_page_layout`, 'Mise en page', '▶'));
    components.push(new ActionRowBuilder().addComponents(...actions));
  }

  return { embed, components, theme: t, page };
}

// ── Modaux ───────────────────────────────────────────────────────────────────
const MODAL_KEYS = ['hex_accent', 'hex_bgcolor', 'hex_text', 'bgimage', 'dim', 'title', 'subtitle'];

function buildCardModal(theme, key, scope, texts = {}) {
  if (!MODAL_KEYS.includes(key)) return null;
  const { prefix } = scopeOf(scope);
  const t = normalizeTheme(theme);
  const modal = new ModalBuilder().setCustomId(`${prefix}_modal_${key}`);

  const hexInput = (label, value) => new TextInputBuilder()
    .setCustomId('hex').setLabel(label).setStyle(TextInputStyle.Short)
    .setMinLength(6).setMaxLength(7).setValue(value).setRequired(true);

  if (key === 'hex_accent') {
    modal.setTitle('🎨 Couleur d\'accent');
    modal.addComponents(new ActionRowBuilder().addComponents(hexInput('Code hexadécimal (ex: 8B1A1A)', t.accentColor)));
  } else if (key === 'hex_bgcolor') {
    modal.setTitle('🌈 Couleur de fond');
    modal.addComponents(new ActionRowBuilder().addComponents(hexInput('Code hexadécimal (ex: 0C0D16)', t.bgColor)));
  } else if (key === 'hex_text') {
    modal.setTitle('🖋️ Couleur du texte');
    modal.addComponents(new ActionRowBuilder().addComponents(hexInput('Code hexadécimal (ex: FFFFFF)', t.textColor)));
  } else if (key === 'bgimage') {
    modal.setTitle('🖼️ Image de fond');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('url').setLabel('URL de l\'image (vide = aucune)')
        .setStyle(TextInputStyle.Short).setMaxLength(400).setValue(t.bgImage || '').setRequired(false),
    ));
  } else if (key === 'title' || key === 'subtitle') {
    const isTitle = key === 'title';
    const value = (texts[key] || TEXT_DEFAULTS[key] || '').toString();
    modal.setTitle(isTitle ? '✍️ Titre de l\'annonce' : '💬 Sous-titre de l\'annonce');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(key)
        .setLabel(isTitle ? `Titre (max ${TEXT_LIMITS.title} caractères)` : `Sous-titre (max ${TEXT_LIMITS.subtitle} caractères)`)
        .setStyle(TextInputStyle.Short).setMaxLength(TEXT_LIMITS[key])
        .setValue(value.slice(0, TEXT_LIMITS[key])).setRequired(false),
    ));
  } else if (key === 'dim') {
    modal.setTitle('🌗 Intensité du fond');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('dim').setLabel('Assombrissement en % (0 = net, 90 = sombre)')
        .setStyle(TextInputStyle.Short).setMaxLength(2).setValue(String(Math.round(t.bgDim * 100))).setRequired(true),
    ));
  }
  return modal;
}

// ── Application d'une modification ───────────────────────────────────────────
/**
 * Calcule la modification à appliquer pour une interaction de composant.
 * @returns {{ patch?: object, notice?: string, action?: 'reset'|'toggleEnabled'|{ modal: string } }}
 */
function applyCardOption(theme, key, values = [], scope = 'member') {
  const t = normalizeTheme(theme);
  const value = values[0];

  switch (key) {
    case 'sel_accent':
      if (value === CUSTOM_ACCENT) return { action: { modal: 'hex_accent' } };
      return { patch: { accentColor: value }, notice: `🎨 Accent mis à jour : \`${value}\`` };

    case 'sel_bgstyle':
      if (value === 'image' && !t.bgImage) return { patch: { bgStyle: 'image' }, action: { modal: 'bgimage' } };
      return { patch: { bgStyle: value }, notice: `🌌 Style de fond : **${value}**` };

    case 'sel_barstyle':
      return { patch: { barStyle: value }, notice: `📊 Barre : **${value}**` };

    case 'sel_text':
      if (value === CUSTOM_ACCENT) return { action: { modal: 'hex_text' } };
      return { patch: { textColor: value }, notice: `🖋️ Texte : \`${value}\`` };

    case 'sel_shape':
      return { patch: { avatarShape: value }, notice: `👤 Avatar : **${value}**` };

    case 'sel_toggle': {
      const shown = Array.isArray(values) ? values : [];
      return {
        patch: {
          showRank: shown.includes('rank'),
          showMessages: shown.includes('messages'),
          showTotalXp: shown.includes('totalXp'),
          showFooter: shown.includes('footer'),
        },
        notice: shown.length ? `👁️ Affiché : ${shown.join(', ')}` : '👁️ Carte épurée : pseudo, niveau et barre uniquement',
      };
    }

    case 'btn_title':
    case 'btn_subtitle':
      if (scope !== 'levelup') return { notice: '⚠️ Ces textes concernent uniquement la carte d\'annonce de niveau.' };
      return { action: { modal: key === 'btn_title' ? 'title' : 'subtitle' } };

    case 'btn_bgcolor': return { action: { modal: 'hex_bgcolor' } };
    case 'btn_bgimage': return { action: { modal: 'bgimage' } };
    case 'btn_dim':     return { action: { modal: 'dim' } };

    case 'btn_reset':
      return { action: 'reset' };

    case 'btn_page_layout':
      return { action: { page: 'layout' } };

    case 'btn_page_colors':
      return { action: { page: 'colors' } };

    case 'btn_page_texts':
      if (scope !== 'levelup') return { notice: '⚠️ Cette page concerne uniquement la carte d\'annonce de niveau.' };
      return { action: { page: 'texts' } };

    case 'btn_enabled':
      if (scope !== 'member') return { notice: '⚠️ Ce bouton n\'a pas de sens pour la carte du serveur.' };
      return { action: 'toggleEnabled' };

    default:
      return { notice: '⚠️ Option inconnue.' };
  }
}

/**
 * Valide et convertit la soumission d'un modal.
 * @returns {{ patch?: object, notice?: string, error?: string }}
 */
function applyCardModal(key, fields, scope = 'member') {
  const read = name => (fields.getTextInputValue ? fields.getTextInputValue(name) : fields[name]) ?? '';

  if (key === 'hex_accent' || key === 'hex_bgcolor' || key === 'hex_text') {
    const hex = normalizeHex(read('hex'));
    if (!hex) return { error: 'Couleur invalide : utilise un code hexadécimal à 6 chiffres, ex. `8B1A1A`.' };
    const field = { hex_accent: 'accentColor', hex_bgcolor: 'bgColor', hex_text: 'textColor' }[key];
    return { patch: { [field]: hex }, notice: `✅ Couleur enregistrée : \`${hex}\`` };
  }

  if (key === 'bgimage') {
    const raw = String(read('url')).trim();
    if (!raw || /^(aucune|none|-)$/i.test(raw)) {
      return { patch: { bgImage: null }, notice: '🖼️ Image de fond retirée.' };
    }
    const url = isImageUrl(raw);
    if (!url) return { error: 'URL invalide : elle doit commencer par `http://` ou `https://` (lien direct vers l\'image).' };
    return { patch: { bgImage: url, bgStyle: 'image' }, notice: '🖼️ Image de fond enregistrée.' };
  }

  if (key === 'dim') {
    const raw = read('dim').replace('%', '').trim();
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 90) return { error: 'Indique un pourcentage entre `0` et `90`.' };      return { patch: { bgDim: clampDim(n / 100) }, notice: `🌗 Intensité du fond : ${Math.round(n)}%` };
  }

  if (key === 'title' || key === 'subtitle') {
    if (scope !== 'levelup') return { error: 'Texte réservé à la carte d\'annonce de niveau.' };
    const res = validateText(key, read(key));
    if (res.error) return { error: res.error };
    const fallback = TEXT_DEFAULTS[key];
    const label = key === 'title' ? 'Titre' : 'Sous-titre';
    return {
      patch: { [key]: res.value },
      notice: res.value
        ? `✅ ${label} enregistré : \`${res.value}\``
        : `↩️ ${label} réinitialisé (\`${fallback}\`).`,
    };
  }

  return { error: 'Paramètre inconnu.' };
}

/** Extrait la clé d'option d'un customId préfixé (`rcp_sel_accent` → `sel_accent`). */
function optionKeyFromId(customId, scope) {
  const { prefix } = scopeOf(scope);
  return String(customId).startsWith(`${prefix}_`) ? customId.slice(prefix.length + 1) : null;
}

/** Extrait la clé de modal d'un customId préfixé (`rcp_modal_dim` → `dim`). */
function modalKeyFromId(customId, scope) {
  const { prefix } = scopeOf(scope);
  return String(customId).startsWith(`${prefix}_modal_`) ? customId.slice(prefix.length + 7) : null;
}

/** Vrai si le thème correspond encore aux valeurs d'usine (rien de personnalisé). */
function isDefaultTheme(theme) {
  const t = normalizeTheme(theme);
  const d = normalizeTheme(DEFAULT_THEME, t.accentColor === DEFAULT_THEME.accentColor ? null : t.accentColor);
  return JSON.stringify({ ...t, accentColor: '' }) === JSON.stringify({ ...d, accentColor: '' });
}

module.exports = {
  SCOPES, MODAL_KEYS, CUSTOM_ACCENT, BG_PRESETS, PANEL_PAGES,
  buildCardPanel, buildCardModal, applyCardOption, applyCardModal,
  optionKeyFromId, modalKeyFromId, isDefaultTheme, pageOf, pageForKey,
  accentSelect, bgStyleSelect, barStyleSelect, textColorSelect, shapeSelect, toggleSelect,
};
