'use strict';
// events/security/permissionVault.js — Coffre-fort de permissions : journal d'audit.
//
// `guildAuditLogEntryCreate` est la seule source qui dit QUI a élargi un accès.
// Toute la décision (référence, confiance, réparation, alerte) vit dans
// src/utils/permissionVault.js : cet event ne fait que brancher.

const { handleAuditEntry } = require('../../utils/permissionVault');

module.exports = {
  name: 'guildAuditLogEntryCreate',
  async execute(entry, guild, client) {
    try {
      await handleAuditEntry(client, guild, entry);
    } catch (err) {
      console.error('[coffre-fort] guildAuditLogEntryCreate:', err.message);
    }
  },
};
