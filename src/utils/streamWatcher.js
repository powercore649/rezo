// utils/streamWatcher.js — Surveillance Twitch (live) + YouTube (nouvelles vidéos)
'use strict';
const { EmbedBuilder } = require('discord.js');
const WatchedStreamer = require('../models/WatchedStreamer');
const { sendNotification } = require('./notificationManager');
const { COLORS } = require('../utils/embeds');

// ─── Twitch — jeton d'application (client_credentials), mis en cache ─────────
let twitchToken = null;
let twitchTokenExpiresAt = 0;

async function getTwitchToken() {
  if (twitchToken && Date.now() < twitchTokenExpiresAt - 60_000) return twitchToken;

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
  });
  if (!res.ok) { console.error('[streamWatcher] échec token Twitch:', res.status); return null; }
  const data = await res.json();
  twitchToken = data.access_token;
  twitchTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return twitchToken;
}

// Vérifie l'état live d'un lot de logins Twitch (max 100 par requête, API Helix)
async function fetchTwitchLiveStatus(logins) {
  if (!logins.length) return new Map();
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = await getTwitchToken();
  if (!clientId || !token) return null; // clés absentes — on ne casse rien, juste aucune donnée

  const params = logins.map(l => `user_login=${encodeURIComponent(l)}`).join('&');
  const res = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
    headers: { 'Client-Id': clientId, 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) { console.error('[streamWatcher] échec requête Twitch:', res.status); return null; }
  const data = await res.json();

  const liveMap = new Map(); // login (minuscules) -> { id, title, gameName, thumbnailUrl }
  for (const stream of data.data || []) {
    liveMap.set(stream.user_login.toLowerCase(), {
      id: stream.id,
      title: stream.title,
      gameName: stream.game_name,
      thumbnailUrl: stream.thumbnail_url.replace('{width}', '640').replace('{height}', '360'),
      userName: stream.user_name,
    });
  }
  return liveMap;
}

// ─── YouTube — dernière vidéo publiée sur une chaîne ──────────────────────────
async function fetchLatestYoutubeVideo(channelId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  const url = `https://www.googleapis.com/youtube/v3/search?key=${apiKey}&channelId=${channelId}&part=snippet&order=date&maxResults=1&type=video`;
  const res = await fetch(url);
  if (!res.ok) { console.error('[streamWatcher] échec requête YouTube:', res.status); return null; }
  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return null;

  return {
    videoId: item.id.videoId,
    title: item.snippet.title,
    thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
    channelTitle: item.snippet.channelTitle,
    publishedAt: item.snippet.publishedAt,
  };
}

// ─── Boucle principale — à appeler périodiquement (ex: toutes les 5 minutes) ──
async function pollStreams(client) {
  const stats = { twitchChecked: 0, youtubeChecked: 0, newLive: 0, newVideos: 0, skippedNoApiKey: false };

  // Twitch — un seul appel groupé par lot de 100 logins (indépendant du serveur)
  const twitchDocs = await WatchedStreamer.find({ platform: 'twitch' });
  if (twitchDocs.length) {
    const logins = [...new Set(twitchDocs.map(d => d.identifier.toLowerCase()))];
    for (let i = 0; i < logins.length; i += 100) {
      const batch = logins.slice(i, i + 100);
      const liveMap = await fetchTwitchLiveStatus(batch).catch(err => { console.error('[streamWatcher] Twitch:', err.message); return null; });
      if (liveMap === null) { stats.skippedNoApiKey = true; continue; }
      stats.twitchChecked += batch.length;

      for (const doc of twitchDocs.filter(d => batch.includes(d.identifier.toLowerCase()))) {
        const live = liveMap.get(doc.identifier.toLowerCase());
        const wasLive = doc.isLive;

        if (live && (!wasLive || doc.lastLiveId !== live.id)) {
          // Nouveau live détecté (ou différent du précédent)
          doc.isLive = true;
          doc.lastLiveId = live.id;
          doc.displayName = live.userName;
          await doc.save();
          stats.newLive++;

          const embed = new EmbedBuilder()
            .setColor(0x9146FF)
            .setTitle(`🔴 ${live.userName} est en live sur Twitch !`)
            .setDescription(live.title || '*Pas de titre*')
            .addFields({ name: 'Jeu', value: live.gameName || 'Non spécifié', inline: true })
            .setImage(`${live.thumbnailUrl}?t=${Date.now()}`)
            .setURL(`https://twitch.tv/${doc.identifier}`)
            .setTimestamp();

          sendNotification(client, doc.guildId, 'streams', embed, `${live.userName} est en live !`)
            .catch(err => console.error('notif twitch:', err.message));
        } else if (!live && wasLive) {
          doc.isLive = false;
          doc.lastLiveId = null;
          await doc.save();
        }
      }
    }
  }

  // YouTube — un appel par chaîne (l'API ne permet pas de batcher "dernière vidéo")
  const youtubeDocs = await WatchedStreamer.find({ platform: 'youtube' });
  for (const doc of youtubeDocs) {
    try {
      const video = await fetchLatestYoutubeVideo(doc.identifier);
      if (video === null && !process.env.YOUTUBE_API_KEY) { stats.skippedNoApiKey = true; continue; }
      if (!video) continue;
      stats.youtubeChecked++;

      if (video.videoId !== doc.lastVideoId) {
        const isFirstCheck = doc.lastVideoId === null; // évite de spammer toutes les vidéos passées au tout premier scan
        doc.lastVideoId = video.videoId;
        doc.displayName = video.channelTitle;
        await doc.save();

        if (!isFirstCheck) {
          stats.newVideos++;
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle(`▶️ Nouvelle vidéo de ${video.channelTitle} !`)
            .setDescription(video.title)
            .setImage(video.thumbnailUrl)
            .setURL(`https://www.youtube.com/watch?v=${video.videoId}`)
            .setTimestamp(new Date(video.publishedAt));

          sendNotification(client, doc.guildId, 'streams', embed, `Nouvelle vidéo : ${video.title}`)
            .catch(err => console.error('notif youtube:', err.message));
        }
      }
    } catch (err) {
      console.error(`[streamWatcher] YouTube ${doc.identifier}:`, err.message);
    }
  }

  return stats;
}

module.exports = { pollStreams, fetchTwitchLiveStatus, fetchLatestYoutubeVideo };
