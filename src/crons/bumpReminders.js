'use strict';
// crons/bumpReminders.js — Rappels de bump (toutes les 5 minutes).
module.exports = {
  name: 'bump-reminders',
  schedule: '*/5 * * * *',
  async execute(client) {
    const { sendBumpReminders } = require('../utils/bumpNetwork');
    await sendBumpReminders(client);
  },
};
