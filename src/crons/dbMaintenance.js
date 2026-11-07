'use strict';
// crons/dbMaintenance.js — Entretien quotidien de la base (04:00).
//
// Supprime les documents sortis de leur durée de vie (voir utils/dbMaintenance)
// et rejoue les index déclarés. Le noyau ne planifie ce cron que sur le shard 0,
// pour qu'un déploiement shardé ne lance pas N fois le même DELETE.
module.exports = {
  name: 'db-maintenance',
  schedule: '0 4 * * *',
  async execute() {
    const { runMaintenance } = require('../utils/dbMaintenance');
    const { createLogger } = require('../core/logger');
    const log = createLogger('db-maintenance');
    const summary = await runMaintenance({ indexes: true, logger: log });
    if (summary.errors) log.warn(`${summary.errors} règle(s) en échec — voir les logs ci-dessus`);
  },
};
