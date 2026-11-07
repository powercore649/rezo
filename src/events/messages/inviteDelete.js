const { primeGuildCache } = require('../../utils/inviteCache');

module.exports = {
  name: 'inviteDelete',
  async execute(invite, client) {
    try {
      if (invite.guild) await primeGuildCache(invite.guild);
    } catch (err) {
      console.error('[inviteDelete] resynchro cache échouée:', err.message);
    }
  },
};
