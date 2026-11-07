'use strict';
// events/core/guildDelete.js — Le bot quitte un serveur

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Server     = require('../../models/Server');
const { COLORS } = require('../../utils/embeds');

// Même invitation de support que /help, /botinfo et le message d'arrivée.
const SUPPORT_URL = 'https://discord.gg/ts5mh326ew';

module.exports = {
  name: 'guildDelete',
  async execute(guild, client) {
    // Ignore les serveurs simplement indisponibles (panne Discord)
    if (!guild.available) return;

    console.log(`➖ Quitté : ${guild.name} (${guild.id}) — ${guild.memberCount} membres`);

    // ── Pont inter-serveurs : on ne laisse pas de webhook derrière nous ────
    try {
      await require('../../utils/bridgeEngine').releaseGuild(guild.id, client);
    } catch (err) {
      console.warn(`⚠️ Pont — nettoyage impossible (${guild.name}) : ${err.message}`);
    }

    // ── Mise à jour en base ───────────────────────────────────────────────────
    await Server.findOneAndUpdate(
      { guildId: guild.id },
      { active: false, leftAt: new Date() },
    ).catch(() => {});

    const totalGuilds = client.guilds.cache.size;
    const iconURL     = client.user.displayAvatarURL({ size: 256 });
    const guildIcon   = guild.iconURL({ dynamic: true, size: 256 }) || iconURL;
    const inviteURL   = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot+applications.commands`;

    // ── DM à l'owner ─────────────────────────────────────────────────────────
    try {
      const owner = await guild.fetchOwner().catch(() => null);
      if (owner) {
        const dmEmbed = new EmbedBuilder()
          .setColor(COLORS.warning || 0xFEE75C)
          .setAuthor({ name: client.user.username, iconURL })
          .setTitle(`${client.user.username} a quitté ${guild.name}`)
          .setDescription([
            `Bonjour **${owner.user.username}**,`,
            '',
            `**${client.user.username}** ne fait plus partie de **${guild.name}**.`,
            '',
            'Si c\'était involontaire, vous pouvez me réinviter en un clic ci-dessous.',
            'Toutes vos données (tickets, config, niveaux…) sont conservées pendant **30 jours**.',
            '',
            '**📬 Un problème ou une suggestion ?**',
            'Notre équipe de support est disponible sur notre serveur Discord.',
            '',
            '*Merci d\'avoir utilisé nos services. À bientôt peut-être !* 👋',
          ].join('\n'))
          .setThumbnail(iconURL)
          .setFooter({ text: `${client.user.username} • Bot tout-en-un`, iconURL })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('➕ Réinviter le bot')
            .setStyle(ButtonStyle.Link)
            .setURL(inviteURL),
          new ButtonBuilder()
            .setLabel('💬 Serveur de support')
            .setStyle(ButtonStyle.Link)
            .setURL(SUPPORT_URL),
        );

        await owner.send({ embeds: [dmEmbed], components: [row] }).catch(() => {});
      }
    } catch (err) {
      console.warn(`⚠️ DM owner impossible au départ (${guild.name}) : ${err.message}`);
    }

    // ── Log interne vers le salon de logs du propriétaire du bot ─────────────
    const logChannelId = process.env.LOG_CHANNEL_ID;
    if (logChannelId) {
      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel) {
        const logEmbed = new EmbedBuilder()
          .setColor(0xED4245)
          .setAuthor({ name: '➖ Serveur quitté', iconURL: guildIcon })
          .setTitle(guild.name)
          .setThumbnail(guildIcon)
          .addFields(
            { name: 'ID',          value: `\`${guild.id}\``,                                   inline: true },
            { name: 'Membres',     value: `**${guild.memberCount}**`,                           inline: true },
            { name: 'Total bot',   value: `**${totalGuilds}** serveurs`,                        inline: true },
            { name: 'Rejoint le',  value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          )
          .setFooter({ text: `ID : ${guild.id}` })
          .setTimestamp();
        logChannel.send({ embeds: [logEmbed] }).catch(() => {});
      }
    }
  },
};
