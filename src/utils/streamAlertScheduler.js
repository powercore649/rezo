'use strict';
// utils/streamAlertScheduler.js — Planificateur autonome des alertes Twitch & YouTube
// Indépendant des autres crons — deux boucles séparées (Twitch : rapide, YouTube : API officielle).

const StreamAlert = require('../models/StreamAlert');
const { visibleGuildIds } = require('../core/sharding');
const twitch      = require('./twitchFetcher');
const youtube     = require('./youtubeFetcher');
const social      = require('./socialFetchers');
const { checkAccess } = require('./licenseGate');
// `serialized` empêche un passage de s'empiler sur le précédent.
// Sans cet import, startStreamAlertScheduler() levait une ReferenceError et
// AUCUNE alerte (Twitch, YouTube, RSS, Bluesky) ne partait jamais.
const { serialized } = require('./concurrency');
const {
  renderTemplate,
  appearanceFromAlert,
  DEFAULT_TWITCH_MESSAGE,
  DEFAULT_YOUTUBE_MESSAGE,
  DEFAULT_SOCIAL_MESSAGE,
  buildTwitchLiveEmbed,
  buildYoutubeVideoEmbed,
  buildSocialPostEmbed,
} = require('./streamAlertEmbeds');

let twitchStarted  = false;
let youtubeStarted = false;
let rssStarted     = false;
let blueskyStarted = false;

const RSS_COLOR     = 0xF26522;
const BLUESKY_COLOR = 0x1185FE;

/**
 * En mode shardé, chaque processus ne doit interroger que ses propres serveurs.
 *
 * Sans ce filtre, un shard qui ne voit pas le serveur lisait quand même l'API
 * (Twitch/RSS/Bluesky/YouTube) puis marquait l'alerte « déjà notifiée » : le
 * vrai shard, lui, ne recevait plus rien. Le filtre garantit un seul traitement
 * par alerte, par le seul processus capable de l'envoyer.
 */
function scopedFilter(client, filter) {
  const ids = visibleGuildIds(client);
  if (ids === null) return filter;
  return { ...filter, guildId: { $in: ids } };
}

// ─── Le serveur a-t-il le droit de recevoir ses alertes ? ─────────────────────
// On interroge `checkAccess`, exactement comme la commande `/streamalerts` :
// licence active OU essai gratuit en cours. Utiliser `isLicensed` ici rendait
// le panneau utilisable en essai alors qu'aucune alerte ne partait jamais —
// la pire des situations : configuré, silencieux, sans explication.
// La réponse est mise en cache 60 s par le portail : aucun coût par passage.
async function canUseAlerts(guildId) {
  try {
    return (await checkAccess(guildId, 'streamalerts')).ok === true;
  } catch {
    return false; // base en erreur : on n'envoie pas dans le vide
  }
}

// ─── Envoyer un message d'alerte dans un salon Discord ────────────────────────
async function sendAlert(client, alert, { embed, row, url }, defaultMessage, placeholders) {
  const guild = client.guilds.cache.get(alert.guildId);
  if (!guild) return null;
  const channel = guild.channels.cache.get(alert.channelId);
  if (!channel?.isTextBased()) return null;

  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has(['SendMessages', 'EmbedLinks'])) return null;

  const mention  = alert.roleId ? `<@&${alert.roleId}> ` : '';
  const template = alert.customMessage?.trim() || defaultMessage;
  const content  = mention + renderTemplate(template, { ...placeholders, lien: url });

  // Style « Message texte » → pas d'embed, pas de bouton (uniquement le contenu).
  const payload = { content };
  if (embed) payload.embeds = [embed];
  if (row)   payload.components = [row];

  try {
    return await channel.send(payload);
  } catch (err) {
    console.error(`[StreamAlerts] Envoi échoué (${alert.platform}/${alert.identifier}):`, err.message);
    return null;
  }
}

// ─── TWITCH — vérifier tous les streamers suivis (tous serveurs confondus) ───
async function checkTwitch(client) {
  if (!twitch.isConfigured()) return; // Silencieux si non configuré

  const alerts = await StreamAlert.find(scopedFilter(client, { platform: 'twitch', enabled: true }));
  if (!alerts.length) return;

  const logins = [...new Set(alerts.map((a) => a.identifier.toLowerCase()))];

  let liveStreams = [];
  try {
    liveStreams = await twitch.getStreamsByLogin(logins);
  } catch (err) {
    console.error('[StreamAlerts][Twitch] Erreur API:', err.message);
    return;
  }

  const liveByLogin = new Map(liveStreams.map((s) => [s.user_login.toLowerCase(), s]));

  for (const alert of alerts) {
    try {
      // ── Vérification licence ──────────────────────────────────────────────
      if (!(await canUseAlerts(alert.guildId))) continue;

      const stream = liveByLogin.get(alert.identifier.toLowerCase());

      // ── Passe en live ──────────────────────────────────────────────────
      if (stream && (!alert.isLive || alert.lastStreamId !== stream.id)) {
        const { embed, row, url } = buildTwitchLiveEmbed({
          login:        alert.identifier,
          displayName:  stream.user_name || alert.displayName || alert.identifier,
          avatarUrl:    alert.avatarUrl,
          title:        stream.title,
          gameName:     stream.game_name,
          thumbnailUrl: stream.thumbnail_url,
          viewerCount:  stream.viewer_count,
          startedAt:    stream.started_at,
        }, appearanceFromAlert(alert));

        const msg = await sendAlert(client, alert, { embed, row, url }, DEFAULT_TWITCH_MESSAGE, {
          streamer: stream.user_name || alert.displayName || alert.identifier,
          titre:    stream.title || '',
          jeu:      stream.game_name || '',
        });

        alert.isLive        = true;
        alert.lastStreamId  = stream.id;
        alert.liveMessageId = msg?.id || null;
        alert.liveChannelId = msg?.channelId || null;
        alert.lastCheckedAt = new Date();
        if (msg) alert.lastNotifiedAt = new Date();
        alert.lastError     = null;
        await alert.save();

        if (msg) console.log(`🔴 [StreamAlerts] ${alert.identifier} est en live → ${alert.guildId}`);
      }
      // ── Passe hors-ligne ──────────────────────────────────────────────
      else if (!stream && alert.isLive) {
        alert.isLive        = false;
        alert.lastStreamId  = null;
        alert.liveMessageId = null;
        alert.liveChannelId = null;
        alert.lastCheckedAt = new Date();
        await alert.save();
      } else {
        alert.lastCheckedAt = new Date();
        await alert.save().catch(() => {});
      }
    } catch (err) {
      console.error(`[StreamAlerts][Twitch] ${alert.identifier}:`, err.message);
      alert.lastError = err.message;
      await alert.save().catch(() => {});
    }
  }
}

// ─── YOUTUBE — vérifier chaque chaîne suivie via l'API officielle ─────────────
async function checkYoutube(client) {
  if (!youtube.isConfigured()) return; // Silencieux si non configuré

  const alerts = await StreamAlert.find(scopedFilter(client, { platform: 'youtube', enabled: true }));
  if (!alerts.length) return;

  for (const alert of alerts) {
    try {
      // ── Vérification licence ──────────────────────────────────────────────
      if (!(await canUseAlerts(alert.guildId))) continue;

      // Récupérer/rafraîchir l'ID de playlist "uploads" si manquant (migration ou 1ère fois)
      let playlistId = alert.uploadsPlaylistId;
      if (!playlistId) {
        const info = await youtube.fetchChannelInfo({ id: alert.identifier });
        if (!info?.uploadsPlaylistId) {
          alert.lastError = 'Chaîne introuvable via l\'API YouTube';
          await alert.save().catch(() => {});
          continue;
        }
        playlistId = info.uploadsPlaylistId;
        alert.uploadsPlaylistId = playlistId;
        alert.displayName       = info.title || alert.displayName;
        alert.avatarUrl         = info.thumbnail || alert.avatarUrl;
      }

      const videos = await youtube.fetchLatestVideos(playlistId, 5);
      if (!videos.length) { alert.lastCheckedAt = new Date(); await alert.save().catch(() => {}); continue; }

      const latest = videos[0];

      // Baseline — première vérification, on ne poste pas l'historique
      if (!alert.lastVideoId) {
        alert.lastVideoId   = latest.videoId;
        alert.lastCheckedAt = new Date();
        await alert.save();
        continue;
      }

      if (latest.videoId !== alert.lastVideoId) {
        // Poster les nouvelles vidéos non encore vues (de la plus ancienne à la plus récente)
        const idx = videos.findIndex((v) => v.videoId === alert.lastVideoId);
        const toPost = idx === -1 ? [latest] : videos.slice(0, idx).reverse();

        // « Shorts: Off » → on ignore les vidéos de 60 s ou moins. Si l'API des
        // durées échoue, on notifie quand même plutôt que de perdre la vidéo.
        let candidates = toPost;
        if (alert.notifyShorts === false) {
          const durations = await youtube.fetchVideoDurations(toPost.map((v) => v.videoId)).catch(() => null);
          if (durations) {
            candidates = toPost.filter((v) => !youtube.isShortDuration(durations[v.videoId]));
          }
        }

        for (const video of candidates) {
          const { embed, row, url } = buildYoutubeVideoEmbed({
            channelName:      alert.displayName,
            channelId:        alert.identifier,
            channelThumbnail: alert.avatarUrl,
            title:            video.title,
            url:              video.url,
            thumbnail:        video.thumbnail,
            description:      video.description,
            publishedAt:      video.publishedAt,
          }, appearanceFromAlert(alert));

          const msg = await sendAlert(client, alert, { embed, row, url }, DEFAULT_YOUTUBE_MESSAGE, {
            chaine: alert.displayName || alert.identifier,
            titre:  video.title || '',
          });

          if (msg) {
            alert.lastNotifiedAt = new Date();
            console.log(`📺 [StreamAlerts] Nouvelle vidéo ${alert.identifier} → ${alert.guildId}`);
          }
          await new Promise((r) => setTimeout(r, 400));
        }

        alert.lastVideoId = latest.videoId;
      }

      alert.lastCheckedAt = new Date();
      alert.lastError     = null;
      await alert.save();
    } catch (err) {
      console.error(`[StreamAlerts][YouTube] ${alert.identifier}:`, err.message);
      alert.lastError = err.message;
      await alert.save().catch(() => {});
    }

    // Petite pause entre chaque chaîne (confort, pas requis par le quota)
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ─── Vérifie qu'une alerte peut réellement poster (licence + salon) ──────────
async function canDeliver(client, alert) {
  if (!(await canUseAlerts(alert.guildId))) return false;
  const guild = client.guilds.cache.get(alert.guildId);
  if (!guild) return false;
  const channel = guild.channels.cache.get(alert.channelId);
  return Boolean(channel?.isTextBased());
}

// ─── RSS / Atom — aucune clé API ─────────────────────────────────────────────
async function checkRss(client) {
  const alerts = await StreamAlert.find(scopedFilter(client, { platform: 'rss', enabled: true }));
  if (!alerts.length) return;

  for (const alert of alerts) {
    try {
      if (!(await canDeliver(client, alert))) continue;

      let feed;
      try {
        feed = await social.fetchRssFeed(alert.identifier);
      } catch (err) {
        alert.lastCheckedAt = new Date();
        alert.lastError = `Flux inaccessible : ${err.message}`;
        await alert.save().catch(() => {});
        continue;
      }

      alert.lastCheckedAt = new Date();
      alert.lastError = null;
      if (!alert.displayName && feed.title) alert.displayName = feed.title;
      if (!alert.avatarUrl && feed.image) alert.avatarUrl = feed.image;

      if (!feed.items.length) {
        await alert.save().catch(() => {});
        continue;
      }

      // Premier passage : on mémorise la tête du flux sans spammer l'historique.
      if (!alert.lastPostId) {
        alert.lastPostId = feed.items[0].id;
        alert.lastPostAt = feed.items[0].publishedAt || new Date();
        await alert.save().catch(() => {});
        continue;
      }

      const fresh = social.pickNewItems(feed.items, alert.lastPostId, 3);

      for (const item of fresh) {
        const { embed, row, url } = buildSocialPostEmbed({
          channelName:  alert.displayName || feed.title,
          author:       item.author,
          authorAvatar: alert.avatarUrl || feed.image,
          title:        item.title,
          url:          item.url,
          description:  item.description,
          image:        item.image,
          publishedAt:  item.publishedAt,
        }, appearanceFromAlert(alert), { label: 'Flux RSS', color: RSS_COLOR });

        const msg = await sendAlert(client, alert, { embed, row, url: url || alert.identifier }, DEFAULT_SOCIAL_MESSAGE, {
          chaine: alert.displayName || feed.title,
          titre:  item.title,
          auteur: item.author || '',
        });

        if (msg) {
          alert.lastNotifiedAt = new Date();
          console.log(`📰 [StreamAlerts] Nouvel article ${alert.identifier} → ${alert.guildId}`);
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      alert.lastPostId = feed.items[0].id;
      alert.lastPostAt = feed.items[0].publishedAt || new Date();
      await alert.save().catch(() => {});
    } catch (err) {
      console.error(`[StreamAlerts][RSS] ${alert.identifier}:`, err.message);
      alert.lastError = err.message;
      await alert.save().catch(() => {});
    }
  }
}

// ─── Bluesky — API publique, aucun compte ni clé ────────────────────────────
async function checkBluesky(client) {
  const alerts = await StreamAlert.find(scopedFilter(client, { platform: 'bluesky', enabled: true }));
  if (!alerts.length) return;

  for (const alert of alerts) {
    try {
      if (!(await canDeliver(client, alert))) continue;

      let feed;
      try {
        feed = await social.fetchBlueskyFeed(alert.identifier, { limit: 10 });
      } catch (err) {
        alert.lastCheckedAt = new Date();
        alert.lastError = `Profil inaccessible : ${err.message}`;
        await alert.save().catch(() => {});
        continue;
      }

      alert.lastCheckedAt = new Date();
      alert.lastError = null;
      if (!alert.displayName && feed.displayName) alert.displayName = feed.displayName;
      if (!alert.avatarUrl && feed.avatar) alert.avatarUrl = feed.avatar;

      if (!feed.items.length) {
        await alert.save().catch(() => {});
        continue;
      }

      if (!alert.lastPostId) {
        alert.lastPostId = feed.items[0].id;
        alert.lastPostAt = feed.items[0].publishedAt || new Date();
        await alert.save().catch(() => {});
        continue;
      }

      const fresh = social.pickNewItems(feed.items, alert.lastPostId, 3);

      for (const post of fresh) {
        const { embed, row, url } = buildSocialPostEmbed({
          channelName:  alert.displayName || feed.handle,
          author:       post.author,
          authorAvatar: post.avatar || alert.avatarUrl || feed.avatar,
          title:        post.title,
          url:          post.url,
          description:  post.description,
          image:        post.image,
          publishedAt:  post.publishedAt,
        }, appearanceFromAlert(alert), { label: 'Bluesky', color: BLUESKY_COLOR, buttonLabel: '🦋 Voir le post' });

        const msg = await sendAlert(client, alert, { embed, row, url: url || `https://bsky.app/profile/${feed.handle}` }, DEFAULT_SOCIAL_MESSAGE, {
          chaine: alert.displayName || feed.handle,
          titre:  post.title,
          auteur: post.author || '',
        });

        if (msg) {
          alert.lastNotifiedAt = new Date();
          console.log(`🦋 [StreamAlerts] Nouveau post Bluesky ${alert.identifier} → ${alert.guildId}`);
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      alert.lastPostId = feed.items[0].id;
      alert.lastPostAt = feed.items[0].publishedAt || new Date();
      await alert.save().catch(() => {});
    } catch (err) {
      console.error(`[StreamAlerts][Bluesky] ${alert.identifier}:`, err.message);
      alert.lastError = err.message;
      await alert.save().catch(() => {});
    }
  }
}

// ─── Démarrer les boucles ─────────────────────────────────────────────────────
// Anti-chevauchement : chaque plateforme est interrogée en série (une requête à
// la fois, pour ne pas se faire limiter), mais si un passage déborde sur
// l'intervalle suivant, le nouveau est ignoré au lieu de s'empiler.
const overlap = name => console.warn(`[StreamAlerts] ${name} : passage précédent encore en cours — passage ignoré`);

function startStreamAlertScheduler(client) {
  // Twitch — toutes les 2 minutes (le live est sensible au temps réel)
  if (!twitchStarted) {
    twitchStarted = true;
    console.log('🟣 [StreamAlerts] Scheduler Twitch démarré' + (twitch.isConfigured() ? '' : ' (⚠️ non configuré — TWITCH_CLIENT_ID/SECRET manquants)'));
    const runTwitch = serialized(
      () => checkTwitch(client).catch((err) => console.error('[StreamAlerts][Twitch] scheduler:', err.message)),
      { name: 'twitch', onSkip: overlap },
    );
    setTimeout(runTwitch, 15_000);
    setInterval(runTwitch, 2 * 60 * 1000);
  }

  // YouTube — toutes les 5 minutes (API officielle, quota très large avec playlistItems)
  if (!youtubeStarted) {
    youtubeStarted = true;
    console.log('🔴 [StreamAlerts] Scheduler YouTube démarré' + (youtube.isConfigured() ? '' : ' (⚠️ non configuré — YOUTUBE_API_KEY manquant)'));
    const runYoutube = serialized(
      () => checkYoutube(client).catch((err) => console.error('[StreamAlerts][YouTube] scheduler:', err.message)),
      { name: 'youtube', onSkip: overlap },
    );
    setTimeout(runYoutube, 25_000);
    setInterval(runYoutube, 5 * 60 * 1000);
  }

  // RSS / Atom — toutes les 10 minutes, aucune clé API requise
  if (!rssStarted) {
    rssStarted = true;
    console.log('📰 [StreamAlerts] Scheduler RSS démarré');
    const runRss = serialized(
      () => checkRss(client).catch((err) => console.error('[StreamAlerts][RSS] scheduler:', err.message)),
      { name: 'rss', onSkip: overlap },
    );
    setTimeout(runRss, 35_000);
    setInterval(runRss, 10 * 60 * 1000);
  }

  // Bluesky — toutes les 5 minutes, API publique sans compte
  if (!blueskyStarted) {
    blueskyStarted = true;
    console.log('🦋 [StreamAlerts] Scheduler Bluesky démarré');
    const runBluesky = serialized(
      () => checkBluesky(client).catch((err) => console.error('[StreamAlerts][Bluesky] scheduler:', err.message)),
      { name: 'bluesky', onSkip: overlap },
    );
    setTimeout(runBluesky, 45_000);
    setInterval(runBluesky, 5 * 60 * 1000);
  }
}

module.exports = {
  startStreamAlertScheduler,
  canUseAlerts,
  checkTwitch,
  checkYoutube,
  checkRss,
  checkBluesky,
  sendAlert,
  scopedFilter,
};
