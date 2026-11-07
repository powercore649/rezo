'use strict';
// core/release.js — identité de version de REZO.
//
// Une seule source décide du nom affiché, de la version et du slogan : les
// embeds (utils/brand), la présence Discord (utils/botStatus) et le site
// (utils/storePages) lisent tous ce module, ce qui évite qu'un numéro de
// version ou un nom divergent d'un endroit à l'autre.
//
// Aucune dépendance : ce module doit rester chargeable hors ligne, sans
// token ni base, pour que les pages et les tests fonctionnent seuls.

const pkg = require('../../package.json');

const RELEASE = Object.freeze({
  name: 'REZO',
  version: pkg.version,
  tagline: 'Le système tout-en-un',
});

function currentRelease() {
  return RELEASE;
}

module.exports = {
  RELEASE,
  currentRelease,
};
