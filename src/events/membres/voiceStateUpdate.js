'use strict';
// events/membres/voiceStateUpdate.js — Salon vocal d'attente.
//
// Seul listener `voiceStateUpdate` du bot : il alimente la file d'attente du
// salon vocal configuré via /waitingroom (arrivée → entrée en file + rôle +
// notification staff ; départ → sortie de file + retrait du rôle).
//
// L'intent GuildVoiceStates est obligatoire (voir src/index.js). Le traitement
// est volontairement délégué à utils/waitingRoom.js pour rester testable, et
// toute erreur est avalée : un souci de file d'attente ne doit jamais casser
// le reste du bot.

const waitingRoom = require('../../utils/waitingRoom');
const supportVocal = require('../../utils/supportVocal');

module.exports = {
  name: 'voiceStateUpdate',
  async execute(oldState, newState, client) {
    try {
      await waitingRoom.handleVoiceUpdate(oldState, newState, client);
    } catch (err) {
      console.error('[waitingroom] voiceStateUpdate:', err.message);
    }

    // Support vocal : la demande se ferme quand son salon vocal se vide.
    try {
      await supportVocal.handleVoiceUpdate(oldState, newState, client);
    } catch (err) {
      console.error('[support-vocal] voiceStateUpdate:', err.message);
    }
  },
};
