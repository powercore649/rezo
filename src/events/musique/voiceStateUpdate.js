'use strict';
// events/musique/voiceStateUpdate.js — Libère le vocal quand la salle se vide.
//
// Deux cas couverts, pour la musique COMME pour la radio :
//   • plus aucun humain avec le bot pendant 45 s → déconnexion propre ;
//   • le bot est déplacé/sorti du vocal à la main → la session est fermée.
// Chaque moteur ne fait rien s'il n'a pas de session sur ce serveur, donc cet
// écouteur ne coûte rien aux autres modules.
const musicEngine = require('../../utils/musicEngine');
const radioEngine = require('../../utils/radioEngine');

module.exports = {
  name: 'voiceStateUpdate',
  execute(oldState, newState) {
    if (!oldState && !newState) return;
    musicEngine.handleVoiceStateUpdate(oldState, newState);
    radioEngine.handleVoiceStateUpdate(oldState, newState);
  },
};
