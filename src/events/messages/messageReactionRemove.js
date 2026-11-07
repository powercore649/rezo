// events/messageReactionRemove.js
const Starboard = require('../../models/Starboard');
const { matchEmoji, syncStarboardMessage } = require('../../utils/starboardManager');

module.exports = {
  name: 'messageReactionRemove',
  async execute(reaction, user, client) {
    try {
      if (user.bot) return;

      if (reaction.partial) await reaction.fetch().catch(() => {});
      if (reaction.message.partial) await reaction.message.fetch().catch(() => {});

      const message = reaction.message;
      if (!message.guild) return;

      const cfg = await Starboard.findOne({ guildId: message.guild.id, enabled: true });
      if (!cfg) return;
      if (!matchEmoji(reaction.emoji, cfg.emoji)) return;

      await syncStarboardMessage(client, cfg, message);
    } catch (err) {
      console.error('❌ messageReactionRemove (starboard):', err.message);
    }
  },
};
