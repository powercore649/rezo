'use strict';
// events/membres/antiraid.js — Anti-raid : hook d'arrivée de membre.
// Discord.js déclenche tous les listeners guildMemberAdd dans l'ordre de
// chargement (ordres alphabétique) : antiraid.js passe AVANT guildMemberAdd.js,
// donc la protection s'applique avant bienvenue/invites/captcha.

const { joinAction } = require('../../utils/antiraidActions');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member, client) {
    try {
      const res = await joinAction(member, client);
      if (res?.action === 'banned' || res?.action === 'kicked') return; // membre parti — rien d'autre à faire
    } catch (err) {
      console.error('[anti-raid] guildMemberAdd:', err.message);
    }
  },
};
