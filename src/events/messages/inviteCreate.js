const { primeGuildCache } = require('../../utils/inviteCache');

module.exports = {
  name: 'inviteCreate',
  async execute(invite, client) {
    try {
      if (invite.guild) await primeGuildCache(invite.guild);
    } catch (err) {
      console.error('[inviteCreate] resynchro cache échouée:', err.message);
    }
  },
};
