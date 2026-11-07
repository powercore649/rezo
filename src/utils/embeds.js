'use strict';
// utils/embeds.js — Passerelle historique vers le nouveau système d'interface.
//
// Toutes les commandes appellent déjà successEmbed / errorEmbed / infoEmbed /
// warningEmbed : elles héritent donc de la refonte visuelle sans être réécrites.
// Les nouveaux panneaux utilisent directement les composants de utils/ui.js
// (panelEmbed, listEmbed, emptyEmbed, metric, progress…).

const { BRAND, applyBrand } = require('./brand');
const ui = require('./ui');

const COLORS = {
  // Rouge vin — couleur de marque REZO (embeds génériques du bot)
  primary:  BRAND.colors.primary,
  wine:     BRAND.colors.wine,
  accent:   BRAND.colors.accent,
  success:  BRAND.colors.success,
  warning:  BRAND.colors.warning,
  error:    BRAND.colors.error,
  info:     BRAND.colors.info,
  muted:    BRAND.colors.muted,
  surface:  BRAND.colors.surface,
};

// Un retour d'action tient sur un écran : titre explicite, une ligne de
// contexte, la signature REZO. Pas de champ superflu.
function toneEmbed(emoji, title, description, color, footer) {
  return applyBrand(ui.panelEmbed({ title: `${emoji} ${title}`, description, color, footer }));
}

function successEmbed(title, description = null) {
  return toneEmbed('✅', title, description, COLORS.success, 'Action réussie');
}

function errorEmbed(title, description = null) {
  return toneEmbed('❌', title, description, COLORS.error, 'Action refusée');
}

function infoEmbed(title, description = null) {
  return toneEmbed('ℹ️', title, description, COLORS.info, 'Information');
}

function warningEmbed(title, description = null) {
  return toneEmbed('⚠️', title, description, COLORS.warning, 'Attention');
}

module.exports = {
  successEmbed,
  errorEmbed,
  infoEmbed,
  warningEmbed,
  COLORS,
  // Nouvelle bibliothèque d'interface, accessible depuis la passerelle.
  PALETTE: ui.PALETTE,
  panelEmbed: ui.panelEmbed,
  listEmbed: ui.listEmbed,
  emptyEmbed: ui.emptyEmbed,
  metric: ui.metric,
  progress: ui.progress,
  divider: ui.divider,
  statusDot: ui.statusDot,
  clip: ui.clip,
  ui,
};
