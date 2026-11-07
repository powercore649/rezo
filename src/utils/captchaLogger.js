'use strict';
// utils/captchaLogger.js — Journalisation configurable du système de captcha
const { EmbedBuilder } = require('discord.js');
const { CaptchaLog } = require('../models/Captcha');
const { COLORS } = require('../utils/embeds');

const LOG_META = {
  sent:          { label: '📨 Captcha envoyé',            color: COLORS.info },
  success:       { label: '✅ Vérification réussie',       color: COLORS.success },
  fail:          { label: '❌ Réponse incorrecte',         color: COLORS.warning },
  regenerated:   { label: '🔄 Image régénérée',            color: COLORS.info },
  timeout:       { label: '⏱️ Temps écoulé',               color: COLORS.error },
  kicked:        { label: '👢 Membre expulsé',             color: COLORS.error },
  bypassed:      { label: '🛡️ Captcha ignoré (rôle géré par Discord)', color: COLORS.success },
  blocked_age:   { label: '🚫 Bloqué (compte trop récent)', color: COLORS.error },
  // ── Étanchéité (captcha non contournable) ──
  bot_blocked:     { label: '🤖 Bot refusé (captcha)',                       color: COLORS.error },
  delivery_failed: { label: '⛔ Captcha non délivrable — accès refusé',       color: COLORS.error },
  bypass_refused:  { label: '🚫 Bypass invalide ignoré',                     color: COLORS.warning },
  role_stripped:   { label: '🧹 Rôle vérifié retiré à\'arrivée',            color: COLORS.warning },
  gate_on:         { label: '🔒 Captcha activé',                            color: COLORS.success },
  gate_off:        { label: '🔓 Captcha désactivé',                         color: COLORS.warning },
  bypass_set:      { label: '🛡️ Rôle de bypass défini',                    color: COLORS.info },
};

async function logAction({ client, guildId, userId, action, detail = '' }) {
  await CaptchaLog.create({ guildId, userId, action, detail });

  if (!client) return;
  try {
    const { CaptchaConfig } = require('../models/Captcha');
    const config = await CaptchaConfig.findOne({ guildId });
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
  } catch (_) { /* le logging ne doit jamais faire planter la vérification */ }
}

module.exports = { logAction, LOG_META };
