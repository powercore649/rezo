'use strict';
// events/aiPlaygroundAutoUnlock.js — Déverrouille tout seul les serveurs dont
// l'IA a été mise en pause parce que tous les moteurs étaient à leur quota.
// Fichier indépendant : plusieurs listeners 'clientReady' coexistent sans conflit.
//
// Un verrou POSE PAR UN ADMIN (raison explicite) n'est jamais levé ici : seul le
// verrou de quota est temporaire.

const { EmbedBuilder } = require('discord.js');
const AiConfig = require('../../models/AiConfig');
const { getStatusMap } = require('../../utils/aiService');
const { pickAvailableModel } = require('../../utils/aiQuotaEngine');
const { invalidate } = require('../../utils/aiConfig');
const { COLORS } = require('../../utils/embeds');

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const MANUAL_PATTERN = /manuel/i;

async function checkLockedGuilds(client) {
  try {
    const lockedConfigs = await AiConfig.find({ locked: true });

    for (const cfg of lockedConfigs) {
      try {
        // Verrou manuel sans échéance : on n'y touche pas.
        if (MANUAL_PATTERN.test(cfg.lockedReason || '') && !cfg.lockedUntil) continue;

        const statusMap = await getStatusMap(cfg.modelChain?.length ? cfg.modelChain : ['gemini-2.5-flash']);
        const pick = pickAvailableModel(cfg.modelChain?.length ? cfg.modelChain : ['gemini-2.5-flash'], statusMap, new Date());
        if (pick.allExhausted) continue; // toujours indisponible, on repasse au prochain cycle

        const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
        if (!guild) continue;

        cfg.locked = false;
        cfg.lockedReason = null;
        cfg.lockedAt = null;
        cfg.lockedUntil = null;
        await cfg.save();
        invalidate(cfg.guildId);

        // On prévient dans le salon de discussion s'il existe — pas partout.
        const targetId = cfg.playgroundChannelId || cfg.channelIds?.[0];
        if (!targetId) continue;
        const channel = guild.channels.cache.get(targetId)
          || await guild.channels.fetch(targetId).catch(() => null);

        if (channel?.isTextBased?.()) {
          await channel.send({
            embeds: [new EmbedBuilder()
              .setColor(COLORS.success)
              .setTitle('🔓 Je peux répondre à nouveau')
              .setDescription('Les moteurs sont de nouveau disponibles : vous pouvez reprendre la conversation.')
              .setFooter({ text: 'REZO • nova_lead_' })],
          }).catch(() => {});
        }
      } catch (err) {
        console.error(`❌ aiPlaygroundAutoUnlock (${cfg.guildId}):`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ aiPlaygroundAutoUnlock:', err.message);
  }
}

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    checkLockedGuilds(client);
    setInterval(() => checkLockedGuilds(client), CHECK_INTERVAL_MS);
  },
};
