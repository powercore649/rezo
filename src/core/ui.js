'use strict';
// core/ui.js — Point d'entrée unique pour l'apparence (v2).
//
// Regroupe l'identité REZO (utils/brand) et les embeds standard
// (utils/embeds) derrière un seul import, et ajoute quelques primitives de
// présentation réutilisables. Les commandes v2 n'importent plus trois modules
// différents pour dessiner une carte.

const embeds = require('../utils/embeds');
const brand = require('../utils/brand');

// Carte brandée générique (couleur, auteur signature, pied REZO).
function card({
  title = null,
  description = null,
  fields = null,
  color = undefined,
  footer = null,
  timestamp = false,
} = {}) {
  return brand.brandEmbed({
    title,
    description,
    fields,
    color: color ?? brand.BRAND.colors.primary,
    footerText: footer,
    timestamp,
  });
}

function bullets(items = [], { icon = '•' } = {}) {
  return items.map(i => `${icon} ${i}`).join('\n');
}

function numbered(items = []) {
  return items.map((i, n) => `**${n + 1}.** ${i}`).join('\n');
}

// Barre de progression brandée (ré-export pratique).
function progress(percent, opts = {}) {
  return brand.bar(percent, opts);
}

module.exports = {
  ...embeds,
  brand,
  BRAND: brand.BRAND,
  card,
  bullets,
  numbered,
  progress,
};
