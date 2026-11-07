'use strict';
// events/security/antiVpnLockSync.js — Verrouillage total : rattrapage au démarrage.
//
// Pendant que le bot est hors ligne, des salons ont pu être créés (ou des
// overwrites supprimés). Au démarrage, on réapplique le refus « Voir les
// salons » pour le rôle de verrouillage sur les serveurs où l'anti-VPN est
// actif. L'opération est idempotente : un salon déjà verrouillé ne coûte
// aucun appel Discord.
module.exports = {
  name: 'clientReady',
  once: true,
  execute(_readyClient, client) {
    const bot = client || _readyClient;
    setImmediate(async () => {
      try {
        const { AntiVPN } = require('../../models/AntiVPN');
        const { isLockEnabled, syncGuild } = require('../../utils/antiVpnLock');
        for (const guild of bot?.guilds?.cache?.values?.() || []) {
          try {
            const cfg = await AntiVPN.findOne({ guildId: guild.id, enabled: true });
            if (!cfg || !isLockEnabled(cfg)) continue;
            await syncGuild(guild, cfg, { logger: console });
          } catch (err) {
            console.error(`anti-vpn verrouillage (${guild.id}):`, err.message);
          }
        }
      } catch (err) {
        console.error('anti-vpn verrouillage au démarrage:', err.message);
      }
    });
  },
};
