'use strict';
// src/index.js — Point d'entrée v2.
//
// Toute la logique de démarrage vit dans le noyau (src/core/kernel.js) :
// validation d'environnement, client Discord, chargement des commandes /
// événements / crons, MongoDB, déploiement des slash commands, arrêt propre.
//
// Ce fichier ne fait plus qu'une chose : lancer le noyau.

const { boot } = require('./core/kernel');

boot().catch(err => {
  console.error('❌ Échec du démarrage du noyau v2 :', err);
  process.exit(1);
});
