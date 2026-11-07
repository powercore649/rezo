'use strict';
// utils/youtubeSubScheduler.js — Vérifie les paliers d'abonnés YouTube toutes les 10 min

const https = require('https');
const YoutubeSubAlert = require('../models/YoutubeSubAlert');
const { isLicensed }  = require('./licenseGate');
const {
  formatNumber,
  getNextMilestone,
  buildProgressBar,
  DEFAULT_MILESTONES,
  buildPreviewEmbed,
} = require('../commands/configuration/youtube-sub');

const API_KEY = () => process.env.YOUTUBE_API_KEY || null;

// ─── Fetch le compteur d'abonnés d'une chaîne ─────────────────────────────────
async function fetchSubscriberCount(ytChannelId) {
  return new Promise((resolve, reject) => {
    const key = API_KEY();
    if (!key) return reject(new Error('YOUTUBE_API_KEY manquant'));

    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${ytChannelId}&key=${key}`;
    const req = https.get(url, { timeout: 10000 }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) return reject(new Error(json?.error?.message || `HTTP ${res.statusCode}`));
          const stats    = json.items?.[0]?.statistics;
          const hidden   = stats?.hiddenSubscriberCount === true;
          const count    = parseInt(stats?.subscriberCount || '0', 10);
          resolve({ count, hidden });
        } catch (e) {
          reject(new Error('Réponse YouTube invalide'));
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Construire le message de notification ────────────────────────────────────
function buildNotificationContent(alert, palier, newCount) {
  const next     = getNextMilestone(newCount, alert.customMilestones);
  const progress = buildProgressBar(newCount, next);

  const vars = {
    '{chaine}':         alert.ytChannelName || 'La chaîne',
    '{abonnes}':        formatNumber(newCount),
    '{palier}':         formatNumber(palier),
    '{prochainpalier}': next ? formatNumber(next) : '—',
    '{progression}':    progress,
    '{url}':            `https://youtube.com/channel/${alert.ytChannelId}`,
    '{serveur}':        '{{GUILD_NAME}}', // remplacé au moment de l'envoi
  };

  let text = alert.customMessage
    || '🎉 **{chaine}** vient de franchir le cap des **{palier} abonnés** !\n\n📊 Total actuel : **{abonnes}** abonnés\n🎯 Prochain palier : **{prochainpalier}**\n`{progression}`';

  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(k, v);
  }

  return text;
}

// ─── Vérification principale ──────────────────────────────────────────────────
async function checkYoutubeSubscribers(client) {
  if (!API_KEY()) return; // silencieux si API non configurée

  // Chaque shard ne lit que ses serveurs : l'appel API ne part que pour une
  // chaîne réellement suivie par un serveur de ce processus.
  const { guildScope } = require('../core/sharding');
  const alerts = await YoutubeSubAlert.find(guildScope(client, { enabled: true })).exec();
  if (!alerts.length) return;

  // Cache licence pour éviter N requêtes Mongo
  const licenseCache = new Map();

  for (const alert of alerts) {
    try {
      // ── Vérification licence ──────────────────────────────────────────────
      if (!licenseCache.has(alert.guildId)) {
        licenseCache.set(alert.guildId, await isLicensed(alert.guildId).catch(() => false));
      }
      if (!licenseCache.get(alert.guildId)) continue;

      // ── Récupérer le salon Discord ────────────────────────────────────────
      const guild = client.guilds.cache.get(alert.guildId);
      if (!guild) continue;

      const channel = guild.channels.cache.get(alert.channelId);
      if (!channel?.isTextBased()) continue;

      // ── Fetch le compteur YouTube ─────────────────────────────────────────
      const { count, hidden } = await fetchSubscriberCount(alert.ytChannelId).catch(err => {
        console.error(`[YoutubeSub] ${alert.ytChannelId}: ${err.message}`);
        alert.lastError = err.message;
        alert.save().catch(() => {});
        return { count: null, hidden: false };
      });

      if (count === null) continue;

      // ── Détecter les paliers franchis ─────────────────────────────────────
      const milestones  = alert.customMilestones.length
        ? [...alert.customMilestones].sort((a, b) => a - b)
        : DEFAULT_MILESTONES;

      const prevCount   = alert.lastSubCount || 0;
      const lastNotified = alert.lastNotifiedCount || 0;

      // Tous les paliers entre lastNotifiedCount (exclu) et count (inclus)
      const crossed = milestones.filter(m => m > lastNotified && m <= count);

      if (crossed.length > 0) {
        // Notifier chaque palier franchi (au max 3 d'un coup pour éviter le spam)
        for (const palier of crossed.slice(0, 3)) {
          const text    = buildNotificationContent(alert, palier, count)
            .replaceAll('{{GUILD_NAME}}', guild.name);
          const mention = alert.mentionRoleId ? `<@&${alert.mentionRoleId}> ` : '';

          const msgPayload = { content: mention + text };

          if (alert.showEmbed) {
            const { EmbedBuilder } = require('discord.js');
            const color    = parseInt((alert.embedColor || '0xFF0000').replace('0x', ''), 16) || 0xFF0000;
            const next     = getNextMilestone(count, alert.customMilestones);
            const progress = buildProgressBar(count, next);

            const embed = new EmbedBuilder()
              .setColor(color)
              .setAuthor({
                name:    alert.ytChannelName || 'YouTube',
                iconURL: alert.ytThumbnail || undefined,
                url:     `https://youtube.com/channel/${alert.ytChannelId}`,
              })
              .setTitle(`🎯 ${formatNumber(palier)} abonnés atteints !`)
              .setDescription(text)
              .setThumbnail(alert.ytThumbnail || null)
              .addFields(
                { name: '📊 Abonnés actuels',  value: `**${formatNumber(count)}**`,                   inline: true },
                { name: '🎯 Prochain palier',   value: next ? `**${formatNumber(next)}**` : '—',       inline: true },
                { name: '📈 Progression',       value: `\`${progress}\``,                              inline: false },
              )
              .setFooter({ text: hidden ? 'Compteur masqué par YouTube — valeur approximative' : 'YouTube Sub Alert • REZO' })
              .setTimestamp();

            msgPayload.content = mention || undefined;
            msgPayload.embeds  = [embed];
          }

          await channel.send(msgPayload).catch(err =>
            console.error(`[YoutubeSub] send ${alert.guildId}:`, err.message)
          );

          console.log(`🔔 [YoutubeSub] ${alert.ytChannelName} → ${formatNumber(palier)} abonnés (${alert.guildId})`);

          // Petit délai entre les notifications si plusieurs paliers franchis
          if (crossed.length > 1) await new Promise(r => setTimeout(r, 1000));
        }

        alert.lastNotifiedCount = crossed[crossed.length - 1];
      }

      // ── Mise à jour du compteur ───────────────────────────────────────────
      alert.lastSubCount  = count;
      alert.lastCheckedAt = new Date();
      alert.lastError     = null;
      await alert.save().catch(() => {});

    } catch (err) {
      console.error(`[YoutubeSub] alert ${alert._id}:`, err.message);
    }
  }
}

module.exports = { checkYoutubeSubscribers };
