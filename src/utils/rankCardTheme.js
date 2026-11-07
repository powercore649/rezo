// utils/rankCardTheme.js — Thème de la carte de rang (deux niveaux de personnalisation)
//
//   • thème du serveur — XPConfig.rankCard, réglé par un admin via /leveling
//   • override membre  — RankCardPref, facultatif et prioritaire, défini via /rank
//
// resolveCardTheme() fusionne les deux puis renvoie un thème COMPLET et VALIDÉ :
// le renderer ne reçoit jamais une couleur, une URL, une énumération ou un
// nombre invalide (valeur de repli sinon). Aucune requête DB ici.

const DEFAULT_THEME = Object.freeze({
  accentColor: '#8B1A1A',   // couleur principale (anneau, barre, pastille)
  bgStyle:     'gradient',  // gradient | solid | image
  bgColor:     '#0C0D16',   // couleur de fond (style « solid »)
  bgImage:     null,        // URL https de l'image de fond (style « image »)
  bgDim:       0.55,        // assombrissement de l'image, 0 → 0.9
  textColor:   '#FFFFFF',   // couleur du nom
  barStyle:    'gradient',  // gradient | solid | segments
  avatarShape: 'circle',    // circle | rounded | square
  showRank:    true,
  showMessages:true,
  showTotalXp: true,
  showFooter:  true,
});

// Énumérations autorisées (une valeur inconnue retombe sur le défaut)
const ENUMS = {
  bgStyle:     ['gradient', 'solid', 'image'],
  barStyle:    ['gradient', 'solid', 'segments'],
  avatarShape: ['circle', 'rounded', 'square'],
};

const BOOLEAN_KEYS = ['showRank', 'showMessages', 'showTotalXp', 'showFooter'];

// ── Presets proposés dans les menus (labels FR) ──────────────────────────────
const ACCENT_PRESETS = [
  { label: 'Rouge vin (REZO)', value: '#8B1A1A' },
  { label: 'Bleu Discord',     value: '#5865F2' },
  { label: 'Violet',           value: '#9B59B6' },
  { label: 'Rose',             value: '#EB459E' },
  { label: 'Cyan',             value: '#1ABC9C' },
  { label: 'Vert émeraude',    value: '#57F287' },
  { label: 'Orange',           value: '#E67E22' },
  { label: 'Jaune doré',       value: '#FEE75C' },
];

const BG_PRESETS = [
  { label: 'Noir nuit',     value: '#0C0D16' },
  { label: 'Bleu nuit',     value: '#0E1526' },
  { label: 'Violet sombre', value: '#160F26' },
  { label: 'Brun sombre',   value: '#1A1212' },
  { label: 'Gris ardoise',  value: '#1B1D22' },
  { label: 'Presque noir',  value: '#050509' },
];

const TEXT_PRESETS = [
  { label: 'Blanc',       value: '#FFFFFF' },
  { label: 'Blanc cassé', value: '#EDEFF7' },
  { label: 'Noir',        value: '#101014' },
];

const BG_STYLE_CHOICES = [
  { label: 'Dégradé (défaut)', value: 'gradient', description: 'Dégradé généré à partir de la couleur de fond' },
  { label: 'Couleur unie',     value: 'solid',    description: 'Fond de couleur plate, halo d\'accent discret' },
  { label: 'Image',            value: 'image',    description: 'Image de fond personnalisée (URL), assombrie pour la lisibilité' },
];

const BAR_STYLE_CHOICES = [
  { label: 'Dégradé', value: 'gradient', description: 'Remplissage en dégradé vers l\'accent clair' },
  { label: 'Uni',     value: 'solid',    description: 'Remplissage d\'une seule couleur' },
  { label: 'Segments',value: 'segments', description: 'Barre découpée en cases, façon MEE6' },
];

const AVATAR_SHAPE_CHOICES = [
  { label: 'Cercle (défaut)', value: 'circle',  description: 'Avatar rond avec anneau' },
  { label: 'Arrondi',         value: 'rounded', description: 'Carré aux coins arrondis' },
  { label: 'Carré',           value: 'square',  description: 'Plein cadre' },
];

const TOGGLE_CHOICES = [
  { label: 'Rang (#42)',        value: 'rank',     description: 'Pastille de classement en haut à droite' },
  { label: 'Messages',          value: 'messages', description: 'Nombre de messages sous le pseudo' },
  { label: 'XP total',          value: 'totalXp',  description: 'XP cumulé depuis toujours' },
  { label: 'Signature REZO',    value: 'footer',   description: 'Petite signature en bas de la carte' },
];

// ── Validation ───────────────────────────────────────────────────────────────
/** Normalise une couleur en `#RRGGBB`. Renvoie `fallback` si invalide. */
function normalizeHex(value, fallback = null) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(value ?? '').trim());
  return m ? `#${m[1].toUpperCase()}` : fallback;
}

/** URL d'image acceptée (http/https uniquement, longueur bornée). */
function isImageUrl(value) {
  const url = String(value ?? '').trim();
  return /^https?:\/\/\S{3,400}$/i.test(url) ? url : null;
}

/** Assombrissement du fond : 0 (aucun) → 0.9 (presque noir). */
function clampDim(value, fallback = DEFAULT_THEME.bgDim) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(0.9, Math.round(n * 100) / 100));
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Complète et valide un thème partiel. `legacyAccent` sert de repli quand la
 * couleur d'accent n'est pas définie (compatibilité avec l'ancien `cardColor`).
 */
function normalizeTheme(raw = {}, legacyAccent = null) {
  const src = raw && raw.toObject ? raw.toObject() : (raw || {});
  const def = DEFAULT_THEME;

  return {
    accentColor:  normalizeHex(src.accentColor, normalizeHex(legacyAccent, def.accentColor)),
    bgStyle:      pickEnum(src.bgStyle, ENUMS.bgStyle, def.bgStyle),
    bgColor:      normalizeHex(src.bgColor, def.bgColor),
    bgImage:      isImageUrl(src.bgImage),
    bgDim:        clampDim(src.bgDim, def.bgDim),
    textColor:    normalizeHex(src.textColor, def.textColor),
    barStyle:     pickEnum(src.barStyle, ENUMS.barStyle, def.barStyle),
    avatarShape:  pickEnum(src.avatarShape, ENUMS.avatarShape, def.avatarShape),
    showRank:     src.showRank     === undefined || src.showRank     === null ? def.showRank     : !!src.showRank,
    showMessages: src.showMessages === undefined || src.showMessages === null ? def.showMessages : !!src.showMessages,
    showTotalXp:  src.showTotalXp  === undefined || src.showTotalXp  === null ? def.showTotalXp  : !!src.showTotalXp,
    showFooter:   src.showFooter   === undefined || src.showFooter   === null ? def.showFooter   : !!src.showFooter,
  };
}

/**
 * Fusionne le thème du serveur et l'override du membre.
 * Sans override actif, le thème du serveur est renvoyé tel quel.
 */
function resolveCardTheme(serverConfig = null, memberPref = null) {
  const server = normalizeTheme(
    serverConfig && serverConfig.rankCard ? serverConfig.rankCard : null,
    serverConfig ? serverConfig.cardColor : null,
  );

  const pref = memberPref && memberPref.toObject ? memberPref.toObject() : memberPref;
  if (!pref || !pref.enabled) return server;

  const overrides = {};
  for (const key of Object.keys(DEFAULT_THEME)) {
    const value = pref[key];
    if (value !== undefined && value !== null) overrides[key] = value;
  }
  return normalizeTheme({ ...server, ...overrides });
}

// ── Libellés pour les embeds ─────────────────────────────────────────────────
const BG_STYLE_LABEL = { gradient: 'Dégradé', solid: 'Couleur unie', image: 'Image' };
const BAR_STYLE_LABEL = { gradient: 'Dégradé', solid: 'Uni', segments: 'Segments' };
const SHAPE_LABEL     = { circle: 'Cercle', rounded: 'Arrondi', square: 'Carré' };

/** Description lisible du thème, pour les panneaux /rank et /leveling. */
function describeTheme(theme) {
  const t = normalizeTheme(theme);
  const hidden = [
    t.showRank ? null : 'rang',
    t.showMessages ? null : 'messages',
    t.showTotalXp ? null : 'XP total',
    t.showFooter ? null : 'signature',
  ].filter(Boolean);

  return [
    `**Accent** : \`${t.accentColor}\``,
    `**Fond** : ${BG_STYLE_LABEL[t.bgStyle]}${t.bgStyle === 'solid' ? ` (\`${t.bgColor}\`)` : ''}${t.bgStyle === 'image' ? (t.bgImage ? ` ([voir](${t.bgImage}))` : ' *(aucune image définie)*') : ''}`,
    `**Barre** : ${BAR_STYLE_LABEL[t.barStyle]} · **Avatar** : ${SHAPE_LABEL[t.avatarShape]} · **Texte** : \`${t.textColor}\``,
    hidden.length ? `**Masqué** : ${hidden.join(', ')}` : '**Affiché** : tout',
  ].join('\n');
}

module.exports = {
  DEFAULT_THEME, ENUMS, BOOLEAN_KEYS,
  ACCENT_PRESETS, BG_PRESETS, TEXT_PRESETS,
  BG_STYLE_CHOICES, BAR_STYLE_CHOICES, AVATAR_SHAPE_CHOICES, TOGGLE_CHOICES,
  BG_STYLE_LABEL, BAR_STYLE_LABEL, SHAPE_LABEL,
  normalizeHex, isImageUrl, clampDim, normalizeTheme, resolveCardTheme, describeTheme,
};
