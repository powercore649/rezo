'use strict';
// utils/avisLogger.js — Journalisation configurable du système d'avis
const { EmbedBuilder } = require('discord.js');
const { AvisConfig } = require('../models/Review');
const { COLORS } = require('../utils/embeds');

const LOG_META = {
  created:    { label: '⭐ Nouvel avis',              color: COLORS.info },
  edited:     { label: '✏️ Avis modifié',              color: COLORS.warning },
  deleted:    { label: '🗑️ Avis supprimé',             color: COLORS.error },
  reported:   { label: '🚩 Avis signalé',              color: COLORS.warning },
  auto_hidden:{ label: '👁️‍🗨️ Avis masqué automatiquement', color: COLORS.error },
  owner_reply:{ label: '💬 Réponse du staff publiée',   color: COLORS.success },
};

async function logAction({ client, guildId, userId, action, detail = '' }) {
  if (!client) return;
  try {
    const config = await AvisConfig.findOne({ guildId });
    if (!config?.logChannelId) return;

    const guild = client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(config.logChannelId);
    if (!channel?.isTextBased()) return;

    const meta = LOG_META[action] || { label: action, color: COLORS.info };
    const embed = new EmbedBuilder()
      .setColor(meta.color)
      .setTitle(meta.label)
      .setDescription([`**Membre :** <@${userId}>`, detail ? `**Détail :** ${detail}` : null].filter(Boolean).join('\n'))
      .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (_) { /* le logging ne doit jamais faire planter l'action principale */ }
}

module.exports = { logAction, LOG_META };
