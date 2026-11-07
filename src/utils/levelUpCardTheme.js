// utils/levelUpCardTheme.js — Carte de l'annonce de niveau : thème + textes.
//
// Deux couches, comme la carte de rang :
//   • base   — le thème de rang résolu (serveur + override du membre) ;
//   • delta  — XPConfig.levelUpCard, dont les champs nuls sont IGNORÉS.
//
// Conséquence voulue : sans réglage spécifique, la carte d'annonce de niveau est
// exactement la carte de rang. Un admin qui ne change qu'une couleur d'accent
// pour les annonces de niveau voit le reste continuer à suivre la carte de rang.
//
// Les textes (title/subtitle) sont propres au level-up et acceptent des
// variables résolues AVANT le rendu : {user} {level} {rank} {server}
// {messages} {xp}. Aucune requête DB ici : le renderer ne reçoit que du validé.
const {
  DEFAULT_THEME, ENUMS, BOOLEAN_KEYS, normalizeHex, normalizeTheme, resolveCardTheme,
} = require('./rankCardTheme');

// Clés de thème qui ne sont ni des couleurs ni des énumérations ni des booléens
const NUMBER_KEYS = ['bgDim'];
const HEX_KEYS = ['accentColor', 'bgColor', 'textColor'];

const TEXT_DEFAULTS = Object.freeze({
  title: 'NIVEAU {level}',
  subtitle: 'Félicitations {user} !',
});

// Bornes de saisie (modaux Discord + affichage sur l'image)
const TEXT_LIMITS = Object.freeze({ title: 40, subtitle: 70 });

const TEXT_KEYS = Object.freeze(['title', 'subtitle']);

/**
 * Un réglage stocké est-il exploitable ?
 * Une valeur illisible (couleur ou énumération inconnue, nombre non fini) est
 * IGNORÉE : la carte d'annonce retombe alors sur la carte de rang au lieu de
 * casser le rendu ou d'oublier l'héritage.
 */
function isUsableOverride(key, value) {
  if (value === undefined || value === null) return false;
  if (HEX_KEYS.includes(key)) return !!normalizeHex(value);
  if (NUMBER_KEYS.includes(key)) return Number.isFinite(Number(value));
  if (ENUMS[key]) return ENUMS[key].includes(value);
  if (BOOLEAN_KEYS.includes(key)) return typeof value === 'boolean';
  return false;
}

const VARIABLES = Object.freeze([
  { token: '{user}', label: 'pseudo du membre' },
  { token: '{level}', label: 'nouveau niveau' },
  { token: '{rank}', label: 'classement dans le serveur' },
  { token: '{server}', label: 'nom du serveur' },
  { token: '{messages}', label: 'nombre de messages' },
  { token: '{xp}', label: 'XP totale' },
]);

const fmt = n => Number(n || 0).toLocaleString('fr-FR');

function asPlain(raw) {
  if (!raw) return {};
  return typeof raw.toObject === 'function' ? raw.toObject() : raw;
}

/** Nettoie un texte du panneau : espaces superflus retirés, chaîne vide → null. */
function normalizeText(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, max);
}

/**
 * Valide une saisie de modal.
 * @returns {{ value?: string|null, error?: string }}
 */
function validateText(key, value) {
  if (!TEXT_KEYS.includes(key)) return { error: 'Texte inconnu.' };
  const max = TEXT_LIMITS[key];
  const raw = String(value ?? '').trim();
  if (raw.length > max) return { error: `Trop long : ${max} caractères maximum (${raw.length} saisis).` };
  return { value: normalizeText(raw, max) };
}

/**
 * Remplace les variables d'un titre/sous-titre.
 * Les jetons inconnus sont laissés tels quels (aucune surprise silencieuse).
 */
function fillLevelUpText(template, vars = {}) {
  const map = {
    user: String(vars.user ?? 'Membre'),
    level: fmt(vars.level),
    rank: vars.rank ? `#${fmt(vars.rank)}` : '—',
    server: String(vars.server ?? 'le serveur'),
    messages: fmt(vars.messages),
    xp: fmt(vars.totalXp ?? vars.xp),
  };
  return String(template ?? '').replace(
    /\{(user|level|rank|server|messages|xp)\}/gi,
    (match, key) => map[String(key).toLowerCase()] ?? match,
  );
}

/**
 * Thème + textes effectifs de la carte d'annonce de niveau.
 * @returns {{ theme: object, title: string, subtitle: string, overrides: string[], custom: boolean }}
 */
function resolveLevelUpTheme(cfg = null, pref = null) {
  const base = resolveCardTheme(cfg, pref);
  const raw = asPlain(cfg && cfg.levelUpCard);

  const patch = {};
  for (const key of Object.keys(DEFAULT_THEME)) {
    if (isUsableOverride(key, raw[key])) patch[key] = raw[key];
  }

  const title = normalizeText(raw.title, TEXT_LIMITS.title) || TEXT_DEFAULTS.title;
  const subtitle = normalizeText(raw.subtitle, TEXT_LIMITS.subtitle) || TEXT_DEFAULTS.subtitle;

  return {
    theme: normalizeTheme({ ...base, ...patch }),
    title,
    subtitle,
    overrides: Object.keys(patch),
    custom: Object.keys(patch).length > 0 || title !== TEXT_DEFAULTS.title || subtitle !== TEXT_DEFAULTS.subtitle,
  };
}

/** Valeur à réinitialiser pour revenir à « hérite de la carte de rang ». */
function levelUpCardResetPatch() {
  const patch = {};
  for (const key of Object.keys(DEFAULT_THEME)) patch[key] = null;
  patch.title = null;
  patch.subtitle = null;
  return patch;
}

/** Description lisible pour l'embed du panneau (/leveling). */
function describeLevelUpCard(resolved) {
  const r = resolved || resolveLevelUpTheme();
  const parts = [
    `**Titre** : \`${r.title}\``,
    `**Sous-titre** : \`${r.subtitle}\``,
  ];
  if (r.overrides.length) {
    parts.push(`🎨 ${r.overrides.length} réglage(s) visuel(s) propre(s) aux annonces de niveau.`);
  } else {
    parts.push('🎨 Les visuels suivent la **carte de rang** (aucun réglage spécifique).');
  }
  return parts.join('\n');
}

module.exports = {
  TEXT_DEFAULTS, TEXT_LIMITS, TEXT_KEYS, VARIABLES,
  normalizeText, validateText, fillLevelUpText, isUsableOverride,
  resolveLevelUpTheme, levelUpCardResetPatch, describeLevelUpCard,
};
