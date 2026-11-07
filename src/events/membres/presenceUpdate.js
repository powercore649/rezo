'use strict';
// events/membres/presenceUpdate.js — Vanity par statut.
//
// Branché uniquement sur le moteur : toute la logique (conditions, rôle,
// annonce, logs) vit dans utils/vanityEngine.js. Cet événement ne fait que
// transmettre la présence au moteur, sans jamais laisser une erreur remonter
// jusqu'à la gateway.

const vanity = require('../../utils/vanityEngine');

module.exports = {
  name: 'presenceUpdate',
  async execute(oldPresence, newPresence) {
    await vanity.handlePresenceUpdate(oldPresence, newPresence).catch(err => {
      console.error('[vanity] presenceUpdate :', err.message);
    });
  },
};
