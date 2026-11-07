// utils/redditWatcher.js — Moteur des annonces Reddit
const axios = require('axios');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const RedditWatch = require('../models/RedditWatch');

const REDDIT_ORANGE = 0xFF4500;
const MAX_POSTED_IDS = 100;   // taille du garde-fou anti-doublon en mémoire
const MAX_POSTS_PER_CHECK = 5; // évite de flood un salon si beaucoup de posts d'un coup
const USER_AGENT = 'discord:bumpify-reddit-announcements:1.0 (by /u/bumpify-bot)';

// ─── Authentification OAuth "application-only" (client_credentials) ──────────
// L'API JSON publique non-authentifiée (reddit.com/r/x.json) est de plus en
// plus bloquée par Reddit pour les IP de serveurs/hébergeurs (403 générique,
// même sur des subreddits publics normaux). La méthode officiellement
// supportée par Reddit pour un accès en lecture seule sans compte utilisateur
// est ce flow OAuth "app-only" — c'est ce qu'on utilise ici.
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const clientId     = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET manquants dans le .env');
  }

  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await axios.post(
    'https://www.reddit.com/api/v1/access_token',
    'grant_type=client_credentials',
    {
      auth: { username: clientId, password: clientSecret },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      timeout: 10000,
    },
  );

  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000; // marge de 60s
  return cachedToken;
}

// ─── Récupère les posts d'un subreddit via l'API OAuth officielle de Reddit ───
async function fetchSubredditPosts(subreddit, sort = 'new') {
  const token = await getAccessToken();
  const url = `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}`;
  const res = await axios.get(url, {
    params: { limit: 25, raw_json: 1 },
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
    },
    timeout: 10000,
  });
  const children = res.data?.data?.children;
  if (!Array.isArray(children)) throw new Error(`Réponse Reddit inattendue pour r/${subreddit}`);
  return children.map(c => c.data);
}

// ─── Vérifie qu'un subreddit existe et est accessible (utilisé à l'ajout) ─────
async function checkSubredditExists(subreddit) {
  try {
    const posts = await fetchSubredditPosts(subreddit, 'new');
    return { ok: true, sample: posts[0] || null };
  } catch (err) {
    if (err.message.includes('REDDIT_CLIENT_ID')) {
      return { ok: false, reason: "Identifiants Reddit manquants côté bot (`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` dans le `.env`) — voir la doc pour les obtenir sur reddit.com/prefs/apps." };
    }
    const status = err.response?.status;
    if (status === 401) return { ok: false, reason: "Identifiants Reddit invalides (`REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` incorrects)." };
    if (status === 404) return { ok: false, reason: "Ce subreddit n'existe pas." };
    if (status === 403) return { ok: false, reason: 'Ce subreddit est privé ou a été banni par Reddit.' };
    if (status === 429) return { ok: false, reason: 'Trop de requêtes envoyées à Reddit — réessaie dans quelques minutes.' };
    return { ok: false, reason: `Reddit injoignable (${err.message}).` };
  }
}

// ─── Applique tous les filtres configurés à un post ────────────────────────────
function passesFilters(post, cfg) {
  if (!cfg.nsfwAllowed && post.over_18) return false;
  if ((post.ups || 0) < cfg.minUpvotes) return false;

  if (cfg.mediaOnly) {
    const hasMedia = post.is_video || post.post_hint === 'image' || /\.(jpg|jpeg|png|gif|gifv)$/i.test(post.url || '');
    if (!hasMedia) return false;
  }

  const title = (post.title || '').toLowerCase();

  if (cfg.includeKeywords.length && !cfg.includeKeywords.some(k => title.includes(k.toLowerCase()))) return false;
  if (cfg.excludeKeywords.length && cfg.excludeKeywords.some(k => title.includes(k.toLowerCase()))) return false;

  const flair = (post.link_flair_text || '').toLowerCase();
  if (cfg.excludeFlairs.length && flair && cfg.excludeFlairs.some(f => flair.includes(f.toLowerCase()))) return false;

  return true;
}

// ─── Construit l'embed d'annonce pour un post ──────────────────────────────────
function buildRedditEmbed(post, subreddit) {
  const embed = new EmbedBuilder()
    .setColor(REDDIT_ORANGE)
    .setAuthor({ name: `r/${subreddit}`, iconURL: 'https://www.redditstatic.com/desktop2x/img/favicon/android-icon-192x192.png' })
    .setTitle(post.title.slice(0, 256))
    .setURL(`https://reddit.com${post.permalink}`)
    .addFields(
      { name: '👤 Auteur', value: `u/${post.author}`, inline: true },
      { name: '⬆️ Upvotes', value: `${post.ups ?? 0}`, inline: true },
      { name: '💬 Commentaires', value: `${post.num_comments ?? 0}`, inline: true },
    )
    .setFooter({ text: 'Reddit • REZO' })
    .setTimestamp(post.created_utc ? post.created_utc * 1000 : Date.now());

  if (post.link_flair_text) embed.addFields({ name: '🏷️ Flair', value: post.link_flair_text, inline: true });

  if (post.selftext) {
    embed.setDescription(post.selftext.length > 500 ? `${post.selftext.slice(0, 500)}…` : post.selftext);
  }

  const image = post.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, '&')
    || (/\.(jpg|jpeg|png|gif|gifv)$/i.test(post.url || '') ? post.url : null);
  if (image) embed.setImage(image);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Voir sur Reddit').setStyle(ButtonStyle.Link).setURL(`https://reddit.com${post.permalink}`),
  );

  return { embeds: [embed], components: [row] };
}

// ─── Vérifie et poste les nouveaux posts pour UN suivi ─────────────────────────
async function checkAndPost(client, cfg) {
  if (!cfg.enabled || !cfg.channelId) return 0;

  const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) return 0;

  let posts;
  try {
    posts = await fetchSubredditPosts(cfg.subreddit, cfg.sort);
  } catch (err) {
    console.error(`[Reddit] Erreur fetch r/${cfg.subreddit}:`, err.message);
    return 0;
  }

  const fresh = posts
    .filter(p => p.created_utc > cfg.lastCheckedUTC && !cfg.postedIds.includes(p.id))
    .filter(p => passesFilters(p, cfg))
    .sort((a, b) => a.created_utc - b.created_utc)
    .slice(-MAX_POSTS_PER_CHECK); // les plus récents seulement si trop de retard accumulé

  if (!fresh.length) return 0;

  let posted = 0;
  let maxSeen = cfg.lastCheckedUTC;

  for (const post of fresh) {
    const payload = buildRedditEmbed(post, cfg.subreddit);
    if (cfg.roleId) payload.content = `<@&${cfg.roleId}>`;

    const sent = await channel.send(payload).catch(err => {
      console.error(`[Reddit] Erreur envoi r/${cfg.subreddit}:`, err.message);
      return null;
    });

    if (sent) posted++;
    cfg.postedIds.push(post.id);
    if (post.created_utc > maxSeen) maxSeen = post.created_utc;
  }

  cfg.lastCheckedUTC = maxSeen;
  cfg.postedIds = cfg.postedIds.slice(-MAX_POSTED_IDS);
  cfg.totalPosted += posted;
  await cfg.save().catch(() => {});

  return posted;
}

module.exports = {
  fetchSubredditPosts, checkSubredditExists, passesFilters,
  buildRedditEmbed, checkAndPost,
};
