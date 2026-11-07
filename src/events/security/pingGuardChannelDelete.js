'use strict';
// events/security/pingGuardChannelDelete.js — Mémoire des salons supprimés.
//
// Chaque suppression laisse un instantané (nom, catégorie, sujet, permissions,
// lenteur…) conservé une heure. Si la suppression fait partie d'une attaque,
// la garde des salons — ou /antiping restaurer — peut reconstruire le salon à
// l'identique au lieu de laisser un trou définitif.

const { handleChannelDelete } = require('../../utils/pingGuard');

module.exports = {
  name: 'channelDelete',
  async execute(channel) {
    await handleChannelDelete(channel);
  },
};
