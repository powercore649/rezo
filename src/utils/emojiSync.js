'use strict';
// utils/emojiSync.js — Emojis animés REZO, sans Unicode.
//
// Les emojis vivent sur l'application Discord, importés par
// `scripts/import-emojis.js`, qui écrit leurs identifiants dans
// `src/data/appEmojis.json`. Ce module fournit trois choses :
//
//   • `e('nom')` / `getAppEmoji('nom')` — la balise `<a:rezo_x:id>` d'un nom
//     logique, ou une chaîne vide si l'emoji n'a pas été importé (aucun repli
//     Unicode : décision de produit) ;
//   • `emojiObject('nom')` — la forme { id, name, animated } exigée par les
//     boutons, menus et réactions ;
//   • `replaceUnicode(texte)` — convertit les emojis Unicode d'un texte en
//     emojis animés, et retire ceux qui n'ont pas d'équivalent. Appelé par
//     `ui.normalizeEmbedData`, donc sur tous les embeds du bot.
//
// Le fichier d'identifiants reste facultatif : sans lui, les textes perdent
// simplement leurs emojis, le bot ne casse pas.

const fs = require('fs');
const path = require('path');

const REGISTRY_FILE = path.join(__dirname, '..', 'data', 'appEmojis.json');

let registry = null;

function loadRegistry() {
  if (registry) return registry;
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    registry = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    registry = {};
  }
  return registry;
}

/** Nom logique → nom de l'emoji sur l'application Discord. */
const CUSTOM = {
  // Navigation et retours d'action
  arrow:       'rezo_fleche',
  next:        'rezo_suivant',
  loading:     'rezo_chargement',
  dots:        'rezo_points',
  check:       'rezo_valide',
  check_blue:  'rezo_check_bleu',
  check_dark:  'rezo_check_noir',
  alert:       'rezo_alerte',
  warning:     'rezo_attention',
  // Domaines fonctionnels
  shield:      'rezo_bouclier',
  siren:       'rezo_sirene',
  mute:        'rezo_muet',
  pin:         'rezo_punaise',
  trash:       'rezo_poubelle',
  bin:         'rezo_corbeille',
  gem:         'rezo_gemme',
  money:       'rezo_argent',
  calc:        'rezo_calcul',
  cone:        'rezo_cone',
  triangle:    'rezo_triangle',
  // Communauté
  party:       'rezo_fete',
  steve:       'rezo_steve',
  dank:        'rezo_dank',
};

/**
 * Équivalents Unicode → nom logique. Toute l'interface du bot passait par ces
 * emojis : chaque entrée choisit l'emoji animé qui porte le même sens, ou le
 * plus proche. Un emoji absent de cette table est retiré du texte.
 */
const UNICODE_TO_KEY = {
  // Validation / succès
  '✅': 'check', '✔️': 'check', '☑️': 'check', '🟢': 'check', '📈': 'check',
  '✋': 'check', '👍': 'check',
  // Erreur / refus / alerte
  '❌': 'alert', '⛔': 'alert', '🚫': 'alert', '🔴': 'alert', '❓': 'alert',
  '📉': 'alert', '☠️': 'alert', '🏴': 'alert',
  '⚠️': 'warning', '❗': 'warning', '❕': 'warning', 'ℹ️': 'pin', '📌': 'pin',
  // Protection
  '🛡️': 'shield', '🔒': 'shield', '🔐': 'shield', '🔓': 'shield',
  // Réglages / objet
  '⚙️': 'pin', '🔑': 'pin', '📝': 'pin', '✏️': 'pin', '🎫': 'pin',
  '🗂️': 'pin', '🗒️': 'pin', '🏷️': 'pin', '🎭': 'pin', '📎': 'pin',
  // Mesure / données
  '📊': 'calc', '📋': 'calc', '📅': 'calc', '🧾': 'calc', '🧮': 'calc',
  '🗓️': 'calc', '📁': 'calc',
  // Valeur / récompense
  '⭐': 'gem', '🏆': 'gem', '🏅': 'gem', '👑': 'gem', '💎': 'gem',
  '✨': 'gem', '💡': 'gem', '🌟': 'gem',
  // Argent
  '🪙': 'money', '💰': 'money', '💸': 'money', '💵': 'money',
  // Suppression
  '🗑️': 'trash', '♻️': 'trash', '🧹': 'trash',
  // Communauté
  '🎉': 'party', '🎊': 'party', '👋': 'party', '👥': 'party', '🙌': 'party',
  '🎁': 'party', '❤️': 'party', '💖': 'party',
  // Attente / rafraîchissement
  '🔄': 'loading', '⏳': 'loading', '⏱️': 'loading', '⏰': 'loading',
  '⏲️': 'loading', '🕒': 'loading', '⚡': 'loading', '🕐': 'loading',
  // Alarme / sécurité active
  '🚨': 'siren', '🔔': 'siren', '📢': 'siren', '📣': 'siren', '🧨': 'siren',
  '🔥': 'siren',
  // Direction / navigation
  '🚀': 'arrow', '▶️': 'arrow', '📤': 'arrow', '📥': 'arrow',
  '➡️': 'next', '↩️': 'next', '🔗': 'next', '🔍': 'next', '🔎': 'next',
  '🚪': 'next', '⬅️': 'next', '⬆️': 'next', '⬇️': 'next',
  // Installation / construction
  '🧩': 'cone', '🏗️': 'cone', '🛠️': 'cone', '🧰': 'cone', '🚧': 'cone',
  '➕': 'cone', '🏠': 'cone',
  // Silence
  '🔕': 'mute', '🤫': 'mute',
  // Décor
  '🎨': 'triangle', '🖼️': 'triangle', '🔺': 'triangle', '🔻': 'triangle',
  // Personnages / réactions
  '🤖': 'steve', '👤': 'steve', '🧑': 'steve', '😀': 'dank', '😂': 'dank',
  '💬': 'dank', '🧠': 'dank', '🗿': 'dank',
};

const PICTOGRAPH = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

/**
 * Entrée du registre pour un nom logique, ou null si l'emoji n'est pas importé.
 * @returns {{id:string,name:string,animated:boolean}|null}
 */
function emojiEntry(name) {
  if (typeof name !== 'string' || !name) return null;
  const data = loadRegistry();
  const customName = CUSTOM[name] || name;
  const entry = data[customName];
  if (!entry || !entry.id) return null;
  return { id: String(entry.id), name: customName, animated: Boolean(entry.animated) };
}

/**
 * Balise Discord d'un nom logique. Chaîne vide si l'emoji n'est pas importé :
 * aucun repli Unicode, par choix — un texte sans emoji reste lisible.
 */
function getAppEmoji(name, clientOverride) {
  const key = typeof name === 'string' ? name : clientOverride;
  if (typeof key !== 'string') return '';
  const entry = emojiEntry(key);
  return entry ? `<${entry.animated ? 'a' : ''}:${entry.name}:${entry.id}>` : '';
}

/** Forme objet pour `setEmoji()`, les options de menu et les réactions. */
function emojiObject(name) {
  return emojiEntry(name);
}

/** Nom logique correspondant à un emoji Unicode, ou null. */
function keyForUnicode(glyph) {
  if (UNICODE_TO_KEY[glyph]) return UNICODE_TO_KEY[glyph];
  const plain = glyph.replace(/\uFE0F/g, '');
  return UNICODE_TO_KEY[plain] || null;
}

/**
 * Remplace les emojis Unicode d'un texte par les emojis animés équivalents et
 * retire ceux qui n'en ont pas. Les glyphes de marque (▬ ▰ ▱ •) ne sont pas
 * des emojis et restent intacts.
 */
function replaceUnicode(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!PICTOGRAPH.test(text)) {
    PICTOGRAPH.lastIndex = 0;
    return text;
  }
  PICTOGRAPH.lastIndex = 0;

  const replaced = text.replace(PICTOGRAPH, glyph => {
    const key = keyForUnicode(glyph);
    return key ? getAppEmoji(key) : '';
  });

  // Un emoji retiré laisse un vide : on nettoie les espaces en bord de ligne,
  // sans toucher aux alignements internes (barres, tableaux).
  return replaced
    .split('\n')
    .map(line => line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''))
    .join('\n');
}

const CUSTOM_TAG = /<a?:([a-zA-Z0-9_]+):(\d+)>/g;

/**
 * Retire tous les emojis d'un texte, Unicode comme balises custom.
 * Sert aux boutons, qui n'en portent aucun.
 */
function stripEmojis(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(CUSTOM_TAG, ' ')
    .replace(PICTOGRAPH, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim();
}

/**
 * Résout un emoji quelconque vers un emoji animé REZO.
 * Accepte une balise `<a:nom:id>`, un pictogramme Unicode ou un objet
 * `{ id, name, animated }`. Renvoie null quand il n'y a pas d'équivalent :
 * les menus n'acceptent que les emojis du bot, pas ceux d'un autre serveur.
 */
function resolveEmoji(raw) {
  if (!raw) return null;
  const data = loadRegistry();

  if (typeof raw === 'object') {
    const name = String(raw.name || '');
    const entry = data[name];
    if (entry?.id) return { id: String(entry.id), name, animated: Boolean(entry.animated) };
    // discord.js peut livrer un pictogramme sous la forme { name: '📊' }.
    const key = keyForUnicode(name);
    return key ? emojiObject(key) : null;
  }

  const text = String(raw).trim();
  const tag = text.match(/^<a?:([a-zA-Z0-9_]+):(\d+)>$/);
  if (tag) {
    const entry = data[tag[1]];
    return entry?.id ? { id: String(entry.id), name: tag[1], animated: Boolean(entry.animated) } : null;
  }

  const key = keyForUnicode(text);
  return key ? emojiObject(key) : null;
}

/**
 * Ancien point de synchronisation au démarrage : l'import se fait désormais
 * explicitement avec `npm run emojis:import`, jamais silencieusement au boot.
 */
async function syncApplicationEmojis() {
  return { created: 0, skipped: 'import-externe' };
}

/** Alias court — pratique dans les templates. */
const e = getAppEmoji;

module.exports = {
  syncApplicationEmojis,
  getAppEmoji,
  e,
  emojiObject,
  emojiEntry,
  replaceUnicode,
  keyForUnicode,
  stripEmojis,
  resolveEmoji,
  CUSTOM,
  UNICODE_TO_KEY,
  REGISTRY_FILE,
};
