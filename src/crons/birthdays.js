'use strict';
// crons/birthdays.js — Vérification horaire des anniversaires.
//
// Toutes les heures (à :05) plutôt qu'une fois par jour : si le bot démarre à
// 14 h, rate la tâche ou reste hors ligne à 9 h, l'annonce part quand même dès
// que l'heure configurée est atteinte. L'idempotence est garantie par
// `lastAnnouncedOn` (une annonce par jour et par membre).
module.exports = {
  name: 'birthdays',
  // Chaque shard ne voit que ses serveurs : le cron doit tourner partout.
  scope: 'guilds',
  schedule: '5 * * * *',
  async execute(client) {
    const { checkBirthdays } = require('../utils/birthdayScheduler');
    await checkBirthdays(client);
  },
};
