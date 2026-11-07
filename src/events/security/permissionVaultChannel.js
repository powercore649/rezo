'use strict';
// events/security/permissionVaultChannel.js — Filet du coffre-fort de permissions.
//
// Si l'entrée d'audit n'arrive pas (permission « Voir le journal d'audit »
// manquante, entrée trop ancienne…), `channelUpdate` déclenche quand même la
// comparaison avec la référence. L'auteur est alors recherché dans le journal
// d'audit ; s'il est introuvable, la modification est traitée comme non
// autorisée (le coffre reste fermé par défaut).

const { handleChannelUpdate } = require('../../utils/permissionVault');

module.exports = {
  name: 'channelUpdate',
  async execute(oldChannel, newChannel, client) {
    try {
      await handleChannelUpdate(client, newChannel, oldChannel);
    } catch (err) {
      console.error('[coffre-fort] channelUpdate:', err.message);
    }
  },
};
