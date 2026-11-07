'use strict';
// crons/treasure.js — Trésors cachés : apparitions dues, indices supplémentaires
// et coffres refermés. Une passe par minute (le rythme se règle en minutes).
module.exports = {
  name: 'treasure',
  // Le coffre a besoin du cache du serveur (salons, membres) → un passage par shard.
  scope: 'guilds',
  schedule: '* * * * *',
  async execute(client) {
    const { tickTreasures } = require('../utils/treasureEngine');
    const summary = await tickTreasures(client);
    if (summary.spawned || summary.expired || summary.clues) {
      console.log(`[trésors] coffres apparus : ${summary.spawned} · indices tombés : ${summary.clues} · refermés : ${summary.expired}`);
    }
  },
};
