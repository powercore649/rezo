'use strict';
// crons/joinJail.js — Libère les membres en salle d'attente de Vigie.
//
// Pourquoi ce cron : quand un compte est trop récent, le serveur peut choisir
// de ne pas l'expulser mais de le garder en attente jusqu'à ce que son compte
// atteigne l'âge minimum. La libération ne peut pas reposer sur un setTimeout en
// mémoire (il disparaît au redémarrage) : ce balayage reprend chaque membre dont
// l'échéance est passée, lui retire le rôle d'attente et nettoie l'entrée.
//
// Le serveur indisponible n'est jamais perdu : son entrée reste en base et sera
// retraitée au tick suivant.

const JoinGuard = require('../models/JoinGuard');
const { dueEntries } = require('../utils/joinJail');
const { EmbedBuilder } = require('discord.js');
const { COLORS } = require('../utils/embeds');

async function sweepJail(client, { now = Date.now(), limit = 50 } = {}) {
  let handled = 0;

  const docs = await JoinGuard.find({ 'jail.releaseAt': { $lte: new Date(now) } })
    .limit(limit)
    .catch(() => []);
  if (!docs.length) return 0;

  for (const cfg of docs) {
    const due = dueEntries(cfg.jail, now);
    if (!due.length) continue;

    const guild = client?.guilds?.cache?.get(cfg.guildId)
      || await client?.guilds?.fetch?.(cfg.guildId)?.catch?.(() => null);
    // Serveur injoignable (bot retiré, panne réseau) : on garde l'entrée pour
    // ne jamais oublier un membre. Rien n'est supprimé ici.
    if (!guild) continue;

    const releasedIds = [];
    for (const entry of due) {
      const member = await guild.members.fetch(entry.userId).catch(() => null);
      if (member && cfg.quarantineRoleId) {
        // eslint-disable-next-line no-await-in-loop
        await member.roles.remove(cfg.quarantineRoleId, 'Vigie : âge du compte atteint').catch(() => {});
      }
      releasedIds.push(entry.userId);
    }

    const done = new Set(releasedIds);
    cfg.jail = (cfg.jail || []).filter(e => !done.has(e.userId));
    await cfg.save().catch(() => {});
    handled += releasedIds.length;

    if (releasedIds.length && cfg.logChannelId) {
      const channel = guild.channels.cache.get(cfg.logChannelId)
        || await guild.channels.fetch(cfg.logChannelId).catch(() => null);
      if (channel?.isTextBased?.()) {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle('⏳ Salle d’attente — libération')
            .setDescription(
              `${releasedIds.map(id => `<@${id}>`).join(', ')} ${releasedIds.length > 1 ? 'ont' : 'a'} atteint l’âge de compte requis : le rôle d’attente leur a été retiré.`,
            )
            .setFooter({ text: 'REZO • Vigie' })
            .setTimestamp()],
        }).catch(() => {});
      }
    }
  }

  return handled;
}

module.exports = {
  name: 'join-jail',
  schedule: '* * * * *', // chaque minute
  async execute(client) {
    const released = await sweepJail(client);
    if (released > 0) console.log(`⏳ [vigie] ${released} membre(s) sorti(s) de la salle d'attente.`);
    return released;
  },
  sweepJail,
};
