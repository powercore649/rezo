'use strict';
// events/security/antiNuke.js — Sentinel : écoute du journal d'audit Discord.
//
// L'événement `guildAuditLogEntryCreate` fournit chaque entrée du journal
// d'audit en temps réel (intent GUILD_MODERATION). C'est de là que viennent les
// informations que les autres events ne donnent pas : QUI a supprimé le salon,
// QUI a banni, QUI a créé un webhook…
//
// Le traitement (décision + sanction + réparation) vit dans
// src/utils/antinukeActions.js : cet event ne fait que brancher et protéger.

const { handleAuditEntry } = require('../../utils/antinukeActions');

module.exports = {
  name: 'guildAuditLogEntryCreate',
  async execute(entry, guild, client) {
    try {
      await handleAuditEntry(client, guild, entry);
    } catch (err) {
      console.error('[anti-nuke] guildAuditLogEntryCreate:', err.message);
    }
  },
};
