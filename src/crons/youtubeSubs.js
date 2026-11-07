'use strict';
// crons/youtubeSubs.js — Paliers d'abonnés YouTube (toutes les 10 minutes).
module.exports = {
  name: 'youtube-subs',
  // Vérifie d'abord le cache du serveur avant d'appeler l'API → sûr sur chaque shard.
  scope: 'guilds',
  schedule: '*/10 * * * *',
  async execute(client) {
    const { checkYoutubeSubscribers } = require('../utils/youtubeSubScheduler');
    await checkYoutubeSubscribers(client);
  },
};
