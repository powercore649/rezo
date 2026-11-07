// events/botStatusWatcher.js — Détecte les changements de statut (en ligne /
// absent / ne pas déranger / hors ligne) des bots surveillés, et poste une
// annonce automatique.
//
// ⚠️ Prérequis technique : nécessite l'intent GuildPresences (ajouté dans
// index.js) ET l'activation du "Presence Intent" dans le Discord Developer
// Portal (onglet Bot de l'application). Sans ça, cet événement ne se
// déclenchera jamais — c'est une limite de l'API Discord, pas du code.
//
// Limite connue : Discord met parfois plusieurs secondes à signaler qu'un
// bot est passé hors ligne (le temps que le gateway détecte la déconnexion).
// Une brève coupure réseau du bot surveillé peut donc ne pas être détectée
// instantanément — c'est une limite de la plateforme, pas de ce système.
const { EmbedBuilder } = require('discord.js');
const Server = require('../../models/Server');
const WatchedBot = require('../../models/WatchedBot');
const { formatDuration } = require('../../utils/formatDuration');

const STATUS_LABELS = {
  // Uniquement des emojis Unicode : aucun emoji custom du serveur ou de
  // l'application n'est utilisé dans les annonces.
  online:  { label: 'En ligne',        emoji: '🟢', color: 0x57F287 },
  idle:    { label: 'Absent',          emoji: '🟡', color: 0xFEE75C },
  dnd:     { label: 'Ne pas déranger', emoji: '🔴', color: 0xED4245 },
  offline: { label: 'Hors ligne',      emoji: '⚫', color: 0x747F8D },
  unknown: { label: 'Statut inconnu',  emoji: '❓', color: 0x747F8D },
};

module.exports = {
  name: 'presenceUpdate',
  async execute(oldPresence, newPresence) {
    try {
      const userId = newPresence?.userId;
      if (!userId) return;

      const guild = newPresence.guild;
      if (!guild) return;

      const watched = await WatchedBot.findOne({ guildId: guild.id, botId: userId });
      if (!watched) return; // ce bot n'est surveillé sur aucun serveur — sortie rapide, pas de requête inutile

      const newStatus = newPresence.status || 'offline';
      if (newStatus === watched.lastStatus) return; // pas de changement réel, on n'annonce rien

      const previousStatus = watched.lastStatus;
      const previousSince = watched.lastStatusChangeAt || watched.createdAt || new Date();
      const durationInPrevious = Date.now() - new Date(previousSince).getTime();

      watched.lastStatus = newStatus;
      watched.lastStatusChangeAt = new Date();
      await watched.save();

      // En maintenance : on ne spam pas d'annonce automatique en/hors ligne,
      // le staff sait déjà que c'est prévu. Seul /botwatch maintenance-off
      // redéclenchera une annonce claire de l'état réel.
      if (watched.maintenance) return;

      const server = await Server.findOne({ guildId: guild.id }).lean();
      const channelId = watched.channelId || server?.botWatchChannelId;
      if (!channelId) return;

      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) return;
      const me = guild.members.me;
      if (!channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return;

      const info = STATUS_LABELS[newStatus] || STATUS_LABELS.unknown;
      const prevInfo = STATUS_LABELS[previousStatus] || STATUS_LABELS.unknown;
      const botUser = await guild.client.users.fetch(userId).catch(() => null);

      const embed = new EmbedBuilder()
        .setColor(info.color)
        .setAuthor({ name: watched.botTag || botUser?.username || 'Bot surveillé', iconURL: botUser?.displayAvatarURL?.() })
        .setTitle(`${info.emoji} Changement de statut`)
        .addFields(
          { name: '➡️ Bot', value: `<@${userId}>`, inline: true },
          { name: '➡️ Nouveau statut', value: `${info.emoji} ${info.label}`, inline: true },
          { name: '➡️ Statut précédent', value: `${prevInfo.emoji} ${prevInfo.label}`, inline: true },
          { name: `➡️ Durée passée « ${prevInfo.label} »`, value: formatDuration(durationInPrevious), inline: false },
        )
      .setFooter({ text: 'REZO Corporation • Surveillance des statuts' })
      .setImage('https://media.discordapp.net/attachments/1528873185758417043/1529674117891096686/standard_2.gif?ex=6a62cb89&is=6a617a09&hm=5abe2896afe48831f36cd94edc95ede614fe9dd6ceaa725b6b6755ac9da692d0&=&width=1020&height=360')


        .setTimestamp();

      if (botUser) embed.setThumbnail(botUser.displayAvatarURL({ size: 256 }));

      await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      console.error('❌ botStatusWatcher a échoué:', err);
    }
  },
};
