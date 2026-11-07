'use strict';
// crons/siteStatus.js — Surveillance des sites web (une passe par minute).
//
// Le cron ne décide de rien : il demande au moteur de vérifier les sites dont
// l'intervalle est écoulé. Un site configuré « toutes les 15 minutes » n'est donc
// réellement appelé que toutes les 15 minutes, même si la passe tourne chaque minute.
module.exports = {
  name: 'site-status',
  // Les alertes passent par le cache du serveur → un passage par shard.
  scope: 'guilds',
  schedule: '* * * * *',
  async execute(client) {
    const { runSiteChecks } = require('../utils/siteMonitorEngine');
    const summary = await runSiteChecks(client);
    if (summary.checked) {
      console.log(`🛰️ [SiteMonitor] ${summary.checked} site(s) vérifié(s), ${summary.alerts} alerte(s)`);
    }
  },
};
