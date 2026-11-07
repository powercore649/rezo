'use strict';
// utils/tempBanSweep.js — Levée des bans temporaires, compatible sharding.
//
// Le balayage tournait dans chaque processus `ready` et marquait un ban « fait »
// dès que le serveur n'était pas dans SON cache. En mode shardé, cela soldait
// les bans des serveurs hébergés par les autres shards SANS les lever : le
// membre restait banni pour toujours.
//
// Règle : le shard qui héberge le serveur agit depuis son cache. Pour un serveur
// absent du cache (bot fraîchement arrivé, serveur quitté), seul le shard 0
// tente l'opération via REST — les autres laissent la ligne en attente, sinon N
// processus lanceraient le même unban.

const { isPrimaryShard } = require('../core/sharding');

/**
 * @returns {Promise<{scanned:number, unbanned:number, deferred:number, cleared:number, failed:number}>}
 */
async function sweepExpiredTempBans(client, {
  TempBan = require('../models/TempBan'),
  now = Date.now(),
  logger = console,
} = {}) {
  const summary = { scanned: 0, unbanned: 0, deferred: 0, cleared: 0, failed: 0 };

  let bans = [];
  try {
    bans = await TempBan.find({ done: false, unbanAt: { $lte: new Date(now) } });
  } catch (err) {
    logger?.error?.('unban auto (lecture):', err.message);
    return summary;
  }

  for (const ban of bans) {
    summary.scanned++;

    let guild = client?.guilds?.cache?.get?.(ban.guildId) || null;

    if (!guild) {
      const sharded = Boolean(client?.shard);
      const primary = !sharded || isPrimaryShard(client);

      if (!primary) {
        summary.deferred++;
        continue;
      }

      if (typeof client?.guilds?.fetch === 'function') {
        guild = await client.guilds.fetch(ban.guildId).catch(() => null);
      }
    }

    // Serveur quitté (ou introuvable) : plus rien à lever, on solde la ligne.
    if (!guild) {
      ban.done = true;
      await ban.save().catch(() => {});
      summary.cleared++;
      continue;
    }

    try {
      await guild.members.unban(ban.userId, 'TempBan expiré');
      summary.unbanned++;
      logger?.log?.(`✅ Unban auto : ${ban.userId} sur ${ban.guildId}`);
    } catch (err) {
      // 10026 = Unknown Ban : le ban n'existe déjà plus, la ligne est soldée.
      if (err?.code === 10026 || /unknown ban/i.test(err?.message || '')) {
        summary.cleared++;
      } else {
        summary.failed++;
        logger?.warn?.(`unban auto ${ban.userId}@${ban.guildId} : ${err.message}`);
        continue;
      }
    }

    ban.done = true;
    await ban.save().catch(() => {});
  }

  return summary;
}

module.exports = { sweepExpiredTempBans };
