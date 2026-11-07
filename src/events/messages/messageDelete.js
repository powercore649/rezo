module.exports = {
  name: 'messageDelete',
  execute(message) {
    // ── Pont inter-serveurs : suppression propagée partout ────────────────
    // Fait avant tout autre traitement : un message partiel n'a qu'un id, et
    // c'est justement tout ce dont la correspondance a besoin.
    try {
      if (message.guild) {
        const bridge = require('../../utils/bridgeEngine');
        bridge.handleDeletedMessage(message.client, message).catch(() => {});
      }
    } catch (_) {}

    if (!message.author || message.author.bot) return;
    if (!message.content && !message.attachments.size) return;
    // ── Starboard : retirer l'entrée si le message source est supprimé ────
    try {
      if (message.guild) {
        const { removeStarboardPostForSource } = require('../../utils/starboardManager');
        removeStarboardPostForSource(message.client, message.guild.id, message.id).catch(() => {});
      }
    } catch (_) {}

    // ── Logs configurables : messages supprimés (Feature 3) ───────────────
    try {
      if (!message.guild) return;
      const GuildLogs = require('../../models/GuildLogs');
      const { EmbedBuilder } = require('discord.js');
      const { COLORS } = require('../../utils/embeds');

      GuildLogs.findOne({ guildId: message.guild.id }).then(async logsCfg => {
        if (!logsCfg?.messages?.enabled || !logsCfg.messages.channelId) return;
        const ch = await message.guild.channels.fetch(logsCfg.messages.channelId).catch(() => null);
        if (!ch || !ch.isTextBased()) return;

        const content = message.content ? message.content.slice(0, 1000) : '*Aucun contenu (média ou embed)*';
        const embed = new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('🗑️ Message supprimé')
          .addFields(
            { name: '👤 Auteur', value: message.author ? `${message.author.tag} (\`${message.author.id}\`)` : '*Inconnu*', inline: true },
            { name: '📋 Salon', value: `<#${message.channel.id}>`, inline: true },
            { name: '📝 Contenu', value: content },
          )
          .setTimestamp();
        ch.send({ embeds: [embed] }).catch(() => {});
      }).catch(() => {});
    } catch (_) {}
  },
};
