'use strict';
// crons/antiNukePanic.js — Sentinel : levée automatique du confinement.
//
// Le mode panique verrouille tous les salons. S'il est activé puis que le bot
// redémarre, un simple `setTimeout` serait perdu : ce cron rend la levée
// fiable puisqu'elle repose sur l'horodatage stocké en base (panicSince).

const { releaseExpiredPanic } = require('../utils/antinukeActions');
const AntiNuke = require('../models/AntiNuke');

module.exports = {
  name: 'antiNukePanic',
  schedule: '* * * * *', // chaque minute
  async execute(client) {
    const pending = await AntiNuke.countDocuments({ panicActive: true, panicAutoMin: { $gt: 0 } }).catch(() => 0);
    if (!pending) return;
    const released = await releaseExpiredPanic(client);
    if (released) console.log(`🛡️ [anti-nuke] ${released} confinement(s) levé(s) automatiquement`);
  },
};
