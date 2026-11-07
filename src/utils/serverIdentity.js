'use strict';
// utils/serverIdentity.js — La marque du serveur, partout.
//
// `/branding` personnalise déjà les embeds et le profil de membre du bot. Ce
// module en fait la SOURCE UNIQUE pour tout le reste : les cartes dessinées en
// canvas (rang, niveau, bienvenue, profil, radio, vocal, trésor, bump) et les
// titres/embeds de module qui écrivaient « REZO » en dur.
//
// Lecture SYNCHRONE : l'identité d'un serveur est amorcée une fois par les
// événements (`guildBrand.prime` + AsyncLocalStorage), donc un rendu de carte
// n'attend jamais la base. Hors contexte (tâche planifiée, MP), le repli est la
// marque REZO : jamais d'exception, jamais de carte sans nom.
//
// Aucune dépendance à Discord : tout est testable sans client ni MongoDB.

const guildBrand = require('./guildBrand');

const MAX_NAME = 32;
const MAX_EMOJI = 16;
const MAX_FALLBACK_NAME = 22; // lisible dans un pied de carte

// Marque par défaut : celle du bot quand le serveur n'a rien personnalisé.
const DEFAULTS = Object.freeze({
  name: 'REZO',
  emoji: '✨',
  colorHex: '#8B1A1A',
  colorInt: 0x8B1A1A,
});

function cleanText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Emoji signature : 1 à 16 caractères, sans espace. Un texte quelconque est
 * refusé (un « emoji » de 200 lettres nuirait à tous les rendus).
 */
function normalizeEmoji(value) {
  const text = cleanText(value, MAX_EMOJI);
  if (!text) return null;
  if (/\s/.test(text)) return null;
  return text;
}

/** '#abc' | '8b1a1a' | '0x8B1A1A' → '#8B1A1A', sinon null. */
function toHexString(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null;
  const full = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw;
  return `#${full.toUpperCase()}`;
}

/**
 * Identité complète à partir d'une configuration d'identité (pure).
 * Une identité désactivée n'expose QUE les valeurs par défaut : la personne qui
 * désactive la personnalisation retrouve exactement l'apparence d'origine.
 */
function identityFromConfig(cfg = null, guildId = null) {
  const raw = cfg || {};
  const enabled = Boolean(raw.enabled);

  const name = (enabled && cleanText(raw.displayName, MAX_NAME)) || DEFAULTS.name;
  const emoji = enabled ? normalizeEmoji(raw.emoji) : null;
  const colorHex = (enabled && toHexString(raw.color)) || DEFAULTS.colorHex;

  return {
    guildId: raw.guildId || guildId || null,
    enabled,
    name,
    emoji,
    colorHex,
    colorInt: guildBrand.parseHexColor(colorHex) ?? DEFAULTS.colorInt,
    footer: (enabled && cleanText(raw.footerText, 120)) || null,
    avatarUrl: (enabled && raw.avatarUrl) || null,
  };
}

/**
 * Identité du serveur courant (contexte AsyncLocalStorage) ou du serveur donné.
 * Ne lit que le cache : appelable dans un rendu de carte sans await.
 */
function currentIdentity(guildId = null) {
  let cfg = null;
  try {
    cfg = guildBrand.getCachedConfig(guildId);
  } catch {
    cfg = null;
  }
  return identityFromConfig(cfg, guildId);
}

/** Nom affiché, borné pour un rendu canvas (une seule ligne courte). */
function nameFor(identity, max = MAX_FALLBACK_NAME) {
  const id = identity || currentIdentity();
  const name = String(id.name || DEFAULTS.name);
  return name.length <= max ? name : name.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * Signature « Nom • suffixe » des pieds de page et des cartes.
 * Sans suffixe, renvoie simplement le nom du serveur.
 */
function signatureFor(suffix = null, identity = null) {
  const id = identity || currentIdentity();
  const tail = cleanText(suffix, 200);
  return tail ? `${id.name} • ${tail}` : id.name;
}

/** Couleur d'accent hexadécimale (repli si le serveur n'en a pas). */
function accentHex(identity = null, fallback = DEFAULTS.colorHex) {
  const id = identity || currentIdentity();
  return id.enabled ? id.colorHex : fallback;
}

/** Couleur d'accent entière Discord (repli si le serveur n'en a pas). */
function accentInt(identity = null, fallback = DEFAULTS.colorInt) {
  const id = identity || currentIdentity();
  return id.enabled ? id.colorInt : fallback;
}

/** Couleur d'accent en composantes RGB (canvas), repli si le serveur n'en a pas. */
function accentRgb(identity = null, fallback = { r: 139, g: 26, b: 26 }) {
  const id = identity || currentIdentity();
  if (!id.enabled) return fallback;
  const n = id.colorInt;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Nom + emoji signature, pour un auteur d'embed. */
function authorNameFor(identity = null) {
  const id = identity || currentIdentity();
  return id.emoji ? `${id.name} ${id.emoji}` : id.name;
}

module.exports = {
  DEFAULTS,
  MAX_NAME,
  MAX_EMOJI,
  cleanText,
  toHexString,
  normalizeEmoji,
  identityFromConfig,
  currentIdentity,
  nameFor,
  signatureFor,
  accentHex,
  accentInt,
  accentRgb,
  authorNameFor,
};
