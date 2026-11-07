'use strict';
// crons/dailyVotes.js — Réinitialisation des votes quotidiens (minuit).
module.exports = {
  name: 'daily-votes-reset',
  schedule: '0 0 * * *',
  async execute() {
    const { resetDailyVotes } = require('../utils/bumpNetwork');
    await resetDailyVotes();
  },
};
