'use strict';
// src/shard.js — Point d'entrée SHARDÉ.
//
// Usage : npm run start:shards   (ou `node src/shard.js`)
//
// Ce fichier ne joue pas le bot : il lance un ShardingManager, qui démarre
// plusieurs processus `src/index.js`. Chaque processus ne voit qu'une partie des
// serveurs ; le déploiement des commandes et les tâches globales restent sur le
// shard 0 (voir core/sharding.js et core/kernel.js).
//
// Combien de shards ? Par défaut `auto` : Discord recommande le nombre d'après le
// nombre de serveurs. Pour forcer : SHARD_COUNT=4. Pour revenir au mode simple
// (un seul processus) : SHARD_COUNT=off — ou lancez simplement `npm start`.

// Le jeton vient presque toujours de .env : sans ce chargement, `startShards`
// lit process.env.TOKEN vide et refuse de démarrer (le noyau, lui, chargeait
// déjà .env — d'où un mode shardé qui échouait au premier lancement).
require('dotenv').config();

const { startShards, shardPlan } = require('./core/sharding');
const { createLogger } = require('./core/logger');

const log = createLogger('sharding');

let plan;
try {
  plan = shardPlan({ total: process.env.SHARD_COUNT });
} catch (err) {
  log.error(err.message);
  log.error('Corrige SHARD_COUNT dans .env (auto, off, ou un entier ≥ 1), puis relance.');
  process.exit(1);
}

// `SHARD_COUNT=off` ne doit pas laisser le bot éteint : on démarre alors le bot
// en processus unique, exactement comme `npm start`.
if (!plan.enabled) {
  log.warn('sharding désactivé (SHARD_COUNT=off) — démarrage en processus unique');
  require('./index');
} else {
  // Sans cette vérification, un .env incomplet ferait naître N enfants qui
  // meurent aussitôt — et le manager les relancerait en boucle.
  const missing = ['TOKEN', 'MONGODB_URI'].filter(key => !process.env[key]);
  if (missing.length) {
    log.error(`variable(s) manquante(s) dans .env : ${missing.join(', ')} — aucun shard lancé.`);
    process.exit(1);
  }

  log.info(`démarrage shardé — ${plan.reason}`);
  // On transmet explicitement le plan : `startShards` a son propre défaut
  // (`auto`) et ignorerait sinon un SHARD_COUNT=4 pourtant validé juste avant.
  startShards({ logger: log, totalShards: plan.totalShards }).catch(err => {
    log.error('échec du démarrage des shards :', err?.message || err);
    process.exit(1);
  });
}
