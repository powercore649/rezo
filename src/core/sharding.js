'use strict';
// core/sharding.js — Mode shardé (plusieurs processus Discord pour un seul bot).
//
// Pourquoi : au-delà de ~2 500 serveurs, une seule connexion Gateway devient le
// goulot (limite de débit, latence des événements, mémoire d'un process). Discord
// impose alors de répartir les serveurs sur plusieurs connexions — les shards.
// Chaque shard est un processus Node complet qui ne voit qu'une partie des
// serveurs ; le bot, lui, reste un seul.
//
// Ce module ne contient que la logique de décision et le lancement. Le noyau
// (`kernel.js`) en déduit les règles qui comptent :
//   • le déploiement des slash commands n'est fait QUE par le shard 0 ;
//   • les crons ne tournent QUE sur le shard 0 (sinon N exécutions par nuit) ;
//   • chaque shard garde sa propre connexion Mongo (pool borné).
//
// `SHARD_COUNT` dans .env : `auto` (défaut), un entier, ou `off` pour rester en
// processus unique.

const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'index.js');

/**
 * Décide du mode de démarrage, sans effet de bord.
 * @param {{ total?: string|number, recommended?: number }} [opts]
 * @returns {{ enabled:boolean, totalShards:number|'auto'|null, recommended:number, reason:string }}
 */
function shardPlan({ total = process.env.SHARD_COUNT ?? 'auto', recommended = 0 } = {}) {
  const raw = typeof total === 'string' ? total.trim().toLowerCase() : total;

  if (raw === 'off' || raw === 'none' || raw === false || raw === 0 || raw === '0') {
    return { enabled: false, totalShards: null, recommended, reason: 'sharding désactivé (SHARD_COUNT=off)' };
  }
  if (raw === '' || raw === 'auto' || raw == null) {
    return { enabled: true, totalShards: 'auto', recommended, reason: 'nombre de shards calculé par Discord' };
  }

  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`SHARD_COUNT invalide : « ${total} » (attendu : auto, off, ou un entier ≥ 1)`);
  }
  return { enabled: true, totalShards: count, recommended, reason: `${count} shard(s) imposé(s) par SHARD_COUNT` };
}

/**
 * Crée le ShardingManager (injectable pour les tests).
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} [opts.file]           Processus enfant à lancer (src/index.js).
 * @param {string|number} [opts.totalShards]
 * @param {boolean} [opts.respawn]
 * @param {Function} [opts.ShardingManagerClass] Classe injectable.
 */
function createManager({
  token,
  file = DEFAULT_FILE,
  totalShards = 'auto',
  respawn = true,
  execArgv = [],
  ShardingManagerClass = require('discord.js').ShardingManager,
} = {}) {
  if (!token) throw new Error('TOKEN manquant : impossible de démarrer les shards');
  return new ShardingManagerClass(file, { token, totalShards, respawn, execArgv });
}

/**
 * Démarre les shards et branche l'arrêt propre.
 * @param {object} opts
 * @param {string} [opts.token]      Par défaut `process.env.TOKEN`.
 * @param {object} [opts.logger]     Logger noyau (sinon console).
 * @param {Function} [opts.onShardCreate] Callback de test / instrumentation.
 * @returns {Promise<object>} le manager (une fois `spawn()` appelé)
 */
async function startShards({
  token = process.env.TOKEN,
  file = DEFAULT_FILE,
  totalShards = 'auto',    respawn = true,
    logger = null,
    onShardCreate = null,
  ShardingManagerClass = undefined,
  manager: provided = null,
  processRef = process,
} = {}) {
  const plan = shardPlan({ total: totalShards });
  if (!plan.enabled) {
    logger?.warn?.('sharding désactivé — démarrage en processus unique');
    return null;
  }

  const manager = provided || createManager({
    token, file, totalShards: plan.totalShards, respawn,
    ...(ShardingManagerClass ? { ShardingManagerClass } : {}),
  });

  manager.on('shardCreate', shard => {
    logger?.info?.(`shard ${shard.id} lancé (${plan.reason})`);
    try { onShardCreate?.(shard, manager); } catch { /* un callback de test ne doit pas tuer le manager */ }
  });

  // Sans ces écouteurs, un shard qui tombe ou se reconnecte est invisible dans
  // les logs : on ne sait pas si le bot couvre encore tous ses serveurs.
  const report = (event, level, phrase, detailOf = null) => {
    if (typeof manager.on !== 'function') return;
    manager.on(event, (shard, payload) => {
      const id = shard?.id ?? '?';
      const detail = detailOf && payload ? ` : ${detailOf(payload)}` : '';
      logger?.[level]?.(`shard ${id} ${phrase}${detail}`);
    });
  };
  report('shardReady', 'info', 'prêt');
  report('shardResume', 'info', 'reconnecté');
  report('shardReconnecting', 'warn', 'se reconnecte…');
  report('shardDisconnect', 'warn', 'déconnecté — reconnexion automatique', code => `code ${code}`);
  report('shardError', 'error', 'a rencontré une erreur', err => err?.message || String(err));

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger?.warn?.(`arrêt demandé (${signal}) — fermeture des shards…`);

    // On laisse aux enfants le temps de fermer leur connexion Mongo, mais pas
    // indéfiniment : un shard bloqué ne doit pas empêcher le redémarrage.
    const deaths = [...manager.shards.values()].map(shard => new Promise(resolve => {
      if (typeof shard.once !== 'function') return resolve();
      const timer = setTimeout(resolve, 5000);
      timer.unref?.();
      shard.once('death', () => { clearTimeout(timer); resolve(); });
    }));

    try {
      for (const shard of manager.shards.values()) {
        try { shard.kill(); } catch { /* déjà arrêté */ }
      }
      await Promise.race([
        Promise.all(deaths),
        new Promise(resolve => { const t = setTimeout(resolve, 6000); t.unref?.(); }),
      ]);
    } finally {
      logger?.info?.(`${manager.shards.size} shard(s) fermé(s)`);
      processRef?.exit?.(0);
    }
  };
  manager.__stop = stop; // exposé pour les tests : simule un signal sans toucher au vrai process
  if (typeof processRef?.once === 'function') {
    processRef.once('SIGINT', () => stop('SIGINT'));
    processRef.once('SIGTERM', () => stop('SIGTERM'));
  }

  await manager.spawn();
  logger?.info?.(`${manager.shards.size} shard(s) en ligne`);
  return manager;
}

/**
 * Résumé lisible du shard courant, utilisable partout (panel, logs, /ping).
 * Fonctionne aussi en processus unique : `sharded:false`, un seul shard logique.
 */
function shardInfo(client) {
  const shard = client?.shard;
  if (!shard) return { sharded: false, ids: [0], count: 1, primary: true, current: 0 };
  const ids = Array.isArray(shard.ids) && shard.ids.length ? shard.ids : [0];
  const count = Number(shard.count) || ids.length;
  return {
    sharded: true,
    ids,
    count,
    primary: ids.includes(0),
    current: ids[0],
  };
}

/** Ce processus doit-il déployer les commandes et planifier les crons globaux ? */
function isPrimaryShard(client) {
  return shardInfo(client).primary;
}

/**
 * Identifiants des serveurs que CE processus voit, ou `null` en mode simple.
 *
 * C'est la brique qui évite les doublons : un planificateur qui tourne sur tous
 * les shards ne doit interroger que les serveurs de son shard (sinon N envois
 * pour un seul serveur, ou un état marqué comme « envoyé » par le mauvais
 * processus). `null` = pas de sharding, aucun filtre à appliquer.
 *
 * @returns {string[]|null}
 */
function visibleGuildIds(client) {
  if (!client?.shard) return null;
  const cache = client.guilds?.cache;
  if (!cache) return [];
  return [...cache.keys()];
}

/**
 * Ce processus est-il responsable de ce serveur ?
 * Vrai en mode simple (un seul processus voit tout) ; en mode shardé, seul le
 * shard qui héberge le serveur doit agir dessus.
 */
function ownsGuild(client, guildId) {
  if (!guildId) return false;
  const ids = visibleGuildIds(client);
  if (ids === null) return true;
  return ids.includes(String(guildId));
}

/** Filtre Mongo restreint aux serveurs visibles (inchangé en mode simple). */
function guildScope(client, filter = {}, field = 'guildId') {
  const ids = visibleGuildIds(client);
  if (ids === null) return { ...filter };
  return { ...filter, [field]: { $in: ids } };
}

module.exports = {
  DEFAULT_FILE,
  shardPlan,
  createManager,
  startShards,
  shardInfo,
  isPrimaryShard,
  visibleGuildIds,
  ownsGuild,
  guildScope,
};
