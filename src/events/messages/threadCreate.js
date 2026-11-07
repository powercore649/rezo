// events/threadCreate.js — Message d'accueil auto sur les nouveaux posts forum
const { ChannelType } = require('discord.js');
const ForumWelcome = require('../../models/ForumWelcome');
const { postForumWelcome } = require('../../utils/forumWelcomeManager');

module.exports = {
  name: 'threadCreate',
  async execute(thread, newlyCreated, client) {
    try {
      // On ne réagit qu'aux nouveaux threads (pas ceux chargés au démarrage),
      // et uniquement si le parent est un salon Forum.
      if (!newlyCreated) return;
      if (!thread.guild) return;
      if (thread.parent?.type !== ChannelType.GuildForum) return;

      const cfg = await ForumWelcome.findOne({
        guildId: thread.guild.id,
        forumChannelId: thread.parentId,
        enabled: true,
      }).lean();
      if (!cfg) return;

      // Vérifier que le bot peut bien écrire/épingler dans ce post.
      const me = thread.guild.members.me;
      const perms = thread.permissionsFor?.(me) || thread.parent.permissionsFor?.(me);
      if (perms && (!perms.has('SendMessagesInThreads') && !perms.has('SendMessages'))) return;

      // Léger délai pour laisser Discord finaliser la création du post
      // (tags appliqués, message de lancement disponible) avant de poster.
      setTimeout(() => {
        postForumWelcome(thread, cfg).catch(err => console.error('threadCreate forumWelcome:', err.message));
      }, 1500);
    } catch (err) {
      console.error('❌ threadCreate:', err.message);
    }
  },
};
