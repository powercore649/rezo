'use strict';
// crons/leaderboardAutopost.js — Auto-post configurable du classement (chaque minute).
module.exports = {
  name: 'leaderboard-autopost',
  schedule: '* * * * *',
  async execute(client) {
    const { postScheduledLeaderboards } = require('../commands/bump-reseau/leaderboard');
    await postScheduledLeaderboards(client);
  },
};
