'use strict';
// events/security/antiVpnChannelCreate.js — Verrouillage total : nouveau salon.
//
// Le rôle « mur » n'a de refus que sur les salons qui existaient au moment du
// verrouillage. Un salon créé plus tard serait donc visible par un membre non
// vérifié : on ajoute ici la même entrée (refus de « Voir les salons »), sans
// toucher aux autres permissions du salon.
module.exports = {
  name: 'channelCreate',
  async execute(channel) {
    const guild = channel?.guild;
    if (!guild) return;
    try {
      const { AntiVPN } = require('../../models/AntiVPN');
      const { isLockEnabled, applyChannelLock } = require('../../utils/antiVpnLock');
      const cfg = await AntiVPN.findOne({ guildId: guild.id, enabled: true });
      if (!cfg || !isLockEnabled(cfg)) return;
      const roleId = cfg.verification?.lockRoleId;
      if (!roleId) return;
      await applyChannelLock(channel, roleId);
    } catch (err) {
      console.error('anti-vpn channelCreate:', err.message);
    }
  },
};
