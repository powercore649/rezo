'use strict';
// utils/nicknameStyle.js — Style du pseudonyme du bot (police, effet, couleur).
//
// Discord n'accepte pas de balises de couleur dans un pseudo : la seule couleur
// réellement affichée vient du RÔLE le plus haut du membre. Pour un dégradé, on
// utilise les « styles de rôle améliorés » (role colors : primary/secondary/
// tertiary), rendus par le client Discord. Ce module ne fait que calculer :
//   • la transformation du texte (polices Unicode + effets) ;
//   • la palette choisie, en entiers Discord prêts pour `role.setColors()`.
//
// Aucune dépendance Discord ni Mongo : 100 % testable hors-ligne
// (voir tests/nickname-style-smoke.js). L'application en elle-même vit dans
// utils/guildBrand.js.

// Limite Discord : 32 caractères pour un surnom.
const MAX_NICK = 32;

// ─── Polices (jeux de glyphes Unicode) ──────────────────────────────────────
// Chaque police transforme A-Z, a-z et 0-9 ; tout le reste (accents, emoji,
// ponctuation, espaces) est laissé intact pour ne jamais casser un pseudo.
const GOTHIC_UPPER = { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' };
const SCRIPT_UPPER = { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ' };
const SCRIPT_LOWER = { e: 'ℯ', g: 'ℊ', o: 'ℴ' };
const DOUBLE_UPPER = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };
const SMALL_CAPS = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ',
  m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'Q', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
};

function mapped(ch, upper, lower, digits, exceptions = {}) {
  const code = ch.codePointAt(0);
  if (exceptions[ch]) return exceptions[ch];
  if (upper && code >= 0x41 && code <= 0x5a) return String.fromCodePoint(upper + (code - 0x41));
  if (lower && code >= 0x61 && code <= 0x7a) return String.fromCodePoint(lower + (code - 0x61));
  if (digits && code >= 0x30 && code <= 0x39) return String.fromCodePoint(digits + (code - 0x30));
  return ch;
}

const FONT_MAPS = {
  classique: ch => ch,
  gras:         ch => mapped(ch, 0x1d5d4, 0x1d5ee, 0x1d7ec),
  italique:     ch => mapped(ch, 0x1d608, 0x1d622),
  gothique:     ch => mapped(ch, 0x1d504, 0x1d51e, null, GOTHIC_UPPER),
  cursive:      ch => mapped(ch, 0x1d49c, 0x1d4b6, null, { ...SCRIPT_UPPER, ...SCRIPT_LOWER }),
  bulles:       ch => circled(ch),
  'petites-caps': ch => SMALL_CAPS[ch] || ch,
  large:        ch => mapped(ch, 0xff21, 0xff41, 0xff10),
  '8bits':      ch => mapped(ch, 0x1d538, 0x1d552, null, DOUBLE_UPPER),
  mono:         ch => mapped(ch, 0x1d670, 0x1d68a, 0x1d7f6),
};

function circled(ch) {
  const code = ch.codePointAt(0);
  if (code >= 0x41 && code <= 0x5a) return String.fromCodePoint(0x24b6 + (code - 0x41));
  if (code >= 0x61 && code <= 0x7a) return String.fromCodePoint(0x24d0 + (code - 0x61));
  if (code === 0x30) return '⓪';
  if (code >= 0x31 && code <= 0x39) return String.fromCodePoint(0x2460 + (code - 0x31));
  return ch;
}

const FONTS = [
  { key: 'classique',     label: 'Classique',     hint: 'Aucune transformation' },
  { key: 'gras',          label: 'Gras',          hint: '𝗚𝗿𝗮𝘀 sans-serif' },
  { key: 'italique',      label: 'Italique',      hint: '𝘐𝘵𝘢𝘭𝘪𝘲𝘶𝘦 sans-serif' },
  { key: 'gothique',      label: 'Gothique',      hint: '𝔊𝔬𝔱𝔥𝔦𝔮𝔲𝔢 médiéval' },
  { key: 'cursive',       label: 'Cursive',       hint: '𝒞𝓊𝓇𝓈𝒾𝓋ℯ manuscrite' },
  { key: 'bulles',        label: 'Bulles',        hint: 'Ⓑⓤⓛⓛⓔⓢ cerclé' },
  { key: 'petites-caps',  label: 'Petites caps',  hint: 'ᴘᴇᴛɪᴛᴇs ᴄᴀᴘɪᴛᴀʟᴇs' },
  { key: 'large',         label: 'Large',         hint: 'Ｌａｒｇｅ pleine chasse' },
  { key: '8bits',         label: '8 bits',        hint: '𝔻𝕠𝕦𝕓𝕝𝕖 𝕥𝕣𝕒𝕚𝕥 rétro' },
  { key: 'mono',          label: 'Mono',          hint: '𝙼𝚘𝚗𝚘𝚜𝚙𝚊𝚌𝚎 terminal' },
];

// ─── Effets ─────────────────────────────────────────────────────────────────
// `degrade` ne change PAS les glyphes : c'est la couleur (rôle) qui fait le
// dégradé. Les autres effets agissent sur le texte lui-même.
const EFFECTS = [
  { key: 'uni',      label: 'Uni',      hint: 'Texte simple',                    glyph: false },
  { key: 'degrade',  label: 'Dégradé',  hint: 'Couleur dégradée (rôle Discord)', glyph: false },
  { key: 'neon',     label: 'Néon',     hint: 'Lettres espacées',                glyph: true },
  { key: 'cartoon',  label: 'Cartoon',  hint: 'Lettres en bulles',               glyph: true },
  { key: 'pop',      label: 'Pop',      hint: 'Petites capitales',               glyph: true },
  { key: 'gelatine', label: 'Gélatine', hint: 'Lettres qui tremblent',           glyph: true },
  { key: 'prisme',   label: 'Prisme',   hint: 'Polices alternées',               glyph: true },
];

// ─── Couleurs (dégradés) ────────────────────────────────────────────────────
// Deux teintes : Discord interpole entre les deux. Ces valeurs sont des
// entiers Discord (0xRRGGBB), prêts pour `role.setColors()`.
// `emojis` sert au rendu « sans boost » : deux pastilles colorées encadrent le
// pseudo, seul moyen d'afficher deux teintes sans les styles de rôle améliorés.
const PALETTES = [
  { key: 'none',   label: 'Aucune',            swatch: '⬜', primary: null,     secondary: null,     emojis: null },
  { key: 'pastel', label: 'Pastel',            swatch: '🟪', primary: 0x8fb3ff, secondary: 0xc9a7ff, emojis: ['🟪', '🩵'] },
  { key: 'rose',   label: 'Rose',              swatch: '🩷', primary: 0xff7fae, secondary: 0xffa8c9, emojis: ['💗', '🩷'] },
  { key: 'sunset', label: 'Coucher de soleil', swatch: '🟧', primary: 0xffa36b, secondary: 0xff6b8b, emojis: ['🧡', '🩷'] },
  { key: 'menthe', label: 'Menthe',            swatch: '🟩', primary: 0x8bd46e, secondary: 0x5fd1a0, emojis: ['💚', '🩵'] },
  { key: 'ocean',  label: 'Océan',             swatch: '🟦', primary: 0x6ec6ff, secondary: 0x8e9bff, emojis: ['🩵', '💙'] },
  { key: 'prisme', label: 'Prisme',            swatch: '🟣', primary: 0xb18cff, secondary: 0xff8fd8, emojis: ['🟣', '🩷'] },
];

// Encadrement du pseudo : rendu visible de deux couleurs sans boost.
const WRAPS = [
  { key: 'none',     label: 'Aucun' },
  { key: 'pastilles', label: 'Pastilles colorées' },
];

function hex(value) {
  return value === null || value === undefined ? null : `#${Number(value).toString(16).toUpperCase().padStart(6, '0')}`;
}

function fontByKey(key) {
  return FONTS.find(f => f.key === String(key || '').toLowerCase()) || null;
}

function effectByKey(key) {
  return EFFECTS.find(e => e.key === String(key || '').toLowerCase()) || null;
}

function paletteByKey(key) {
  return PALETTES.find(p => p.key === String(key || '').toLowerCase()) || null;
}

function wrapByKey(key) {
  return WRAPS.find(w => w.key === String(key || '').toLowerCase()) || null;
}

// ─── Rendu ──────────────────────────────────────────────────────────────────
/**
 * Rend le pseudo stylé, borné à 32 caractères (limite Discord).
 *
 * `effect.glyph` (cartoon, pop, gélatine, prisme) remplace les glyphes : la
 * police choisie n'est alors pas appliquée. `degrade` et `uni` conservent la
 * police.
 *
 * @param {string} text
 * @param {{ font?: string, effect?: string }} style
 * @returns {string}
 */
function render(text, { font = 'classique', effect = 'uni' } = {}) {
  const base = Array.from(String(text ?? '').normalize('NFKC')).slice(0, MAX_NICK);
  const fontMap = FONT_MAPS[fontByKey(font)?.key || 'classique'] || FONT_MAPS.classique;
  const chosen = effectByKey(effect)?.key || 'uni';

  let chars;
  if (chosen === 'cartoon') chars = base.map(circled);
  else if (chosen === 'pop') chars = base.map(ch => SMALL_CAPS[ch] || ch);
  else if (chosen === 'prisme') {
    const cycle = [FONT_MAPS.gothique, FONT_MAPS.cursive, FONT_MAPS.gras];
    chars = base.map((ch, i) => cycle[i % cycle.length](ch));
  } else chars = base.map(fontMap);

  let out = chars.join('');
  if (chosen === 'neon') out = chars.join('\u2009');
  else if (chosen === 'gelatine') out = chars.map((ch, i) => (i % 2 ? `${ch}\u0303` : ch)).join('');

  // On re-borne après transformation : les accents combinants et les espaces
  // fines comptent aussi dans la limite Discord. Pas de normalisation NFC en
  // gélatine : elle composerait les accents et effacerait le tremblement voulu.
  const trimmed = Array.from(out).slice(0, MAX_NICK).join('');
  return chosen === 'gelatine' ? trimmed : trimmed.normalize('NFC');
}

/** Le texte stylé tient-il dans la limite Discord ? */
function fits(text) {
  return Array.from(String(text ?? '')).length <= MAX_NICK;
}

/**
 * Pseudo final : texte stylé + éventuelles pastilles de couleur.
 *
 * Les pastilles existent parce qu'un dégradé de rôle exige les styles de rôle
 * améliorés (3 boosts). Sans eux, Discord n'affiche qu'une couleur unie ; deux
 * emoji colorés garantissent un rendu bicolore visible partout.
 */
function renderNickname(cfg = {}) {
  const base = render(cfg.nickname || cfg.displayName || 'REZO', {
    font: cfg.nicknameFont,
    effect: cfg.nicknameEffect,
  });
  const palette = activePalette(cfg);
  if (cfg.nicknameWrap !== 'pastilles' || !palette?.emojis) return base;

  const budget = Math.max(1, MAX_NICK - 2); // deux emoji = deux caractères
  return `${palette.emojis[0]}${Array.from(base).slice(0, budget).join('')}${palette.emojis[1]}`;
}

/** Pseudo affiché pour cette configuration (nom → surnom → défaut). */
function renderForConfig(cfg = {}) {
  return renderNickname(cfg);
}

/** Palette réellement applicable (null si aucune / inconnue). */
function activePalette(cfg = {}) {
  const palette = paletteByKey(cfg.nicknamePalette);
  return palette && palette.key !== 'none' ? palette : null;
}

module.exports = {
  MAX_NICK,
  FONTS,
  EFFECTS,
  PALETTES,
  WRAPS,
  FONT_MAPS,
  fontByKey,
  effectByKey,
  paletteByKey,
  wrapByKey,
  activePalette,
  hex,
  render,
  renderNickname,
  renderForConfig,
  fits,
};
