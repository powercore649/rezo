'use strict';
// events/security/pingGuardChannelCreate.js — Garde des noms de salons.
//
// Un salon dont le nom est un vecteur d'attaque (invitation Discord, « nuke »,
// « free nitro »…) est supprimé, son auteur banni, et les salons que cet auteur
// venait de supprimer sont reconstruits. L'écoute du journal d'audit sert à
// identifier l'auteur : sans cette permission, le salon est quand même supprimé
// mais personne n'est banni au hasard.

const { handleChannelCreate } = require('../../utils/pingGuard');

module.exports = {
  name: 'channelCreate',
  async execute(channel) {
    await handleChannelCreate(channel);
  },
};
