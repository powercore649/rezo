'use strict';
// crons/weeklyRecap.js — Récap hebdomadaire d'activité (chaque minute).
module.exports = {
  name: 'weekly-recap',
  schedule: '* * * * *',
  async execute(client) {
    const { sendWeeklyRecaps } = require('../utils/weeklyRecap');
    await sendWeeklyRecaps(client);
  },
};
