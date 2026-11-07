'use strict';
// events/security/permissionVaultRole.js — Filet du coffre-fort (rôles).
//
// Une permission ajoutée à un rôle verrouillé ne produit pas forcément
// d'entrée d'audit exploitable : `roleUpdate` garantit la vérification.

const { handleRoleUpdate } = require('../../utils/permissionVault');

module.exports = {
  name: 'roleUpdate',
  async execute(oldRole, newRole, client) {
    try {
      await handleRoleUpdate(client, newRole, oldRole);
    } catch (err) {
      console.error('[coffre-fort] roleUpdate:', err.message);
    }
  },
};
