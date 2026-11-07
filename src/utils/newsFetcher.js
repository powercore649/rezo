'use strict';
// utils/newsFetcher.js — Récupération d'actualités via RSS (sans clé API)

const https = require('https');
const http  = require('http');

// ─── Sources RSS françaises ───────────────────────────────────────────────────
const SOURCES = {
  jeuxvideo: {
    name:     'Jeuxvideo.com',
    emoji:    '🎮',
    category: 'gaming',
    color:    0xE8000D,
    url:      'https://www.jeuxvideo.com/rss/rss.xml',
    icon:     'https://www.jeuxvideo.com/favicon.ico',
  },
  gamekult: {
    name:     'Gamekult',
    emoji:    '🕹️',
    category: 'gaming',
    color:    0x1A1A2E,
    url:      'https://www.gamekult.com/feed.rss',
    icon:     'https://www.gamekult.com/favicon.ico',
  },
  numerama: {
    name:     'Numerama',
    emoji:    '💻',
    category: 'tech',
    color:    0x0066CC,
    url:      'https://www.numerama.com/feed/',
    icon:     'https://www.numerama.com/favicon.ico',
  },
  bfmtech: {
    name:     'BFM Tech',
    emoji:    '📱',
    category: 'tech',
    color:    0x003399,
    url:      'https://www.bfmtv.com/rss/tech/',
    icon:     'https://www.bfmtv.com/favicon.ico',
  },
  lemonde: {
    name:     'Le Monde',
    emoji:    '🌍',
    category: 'general',
    color:    0x1A1A1A,
    url:      'https://www.lemonde.fr/rss/une.xml',
    icon:     'https://www.lemonde.fr/favicon.ico',
  },
  millenium: {
    name:     'Millenium',
    emoji:    '🏆',
    category: 'esport',
    color:    0xFFD700,
    url:      'https://www.millenium.org/news/flux.rss',
    icon:     'https://www.millenium.org/favicon.ico',
  },
};

// ─── Fetch HTTP/HTTPS robuste ─────────────────────────────────────────────────
function fetchText(url, timeoutMs = 10000, redirects = 3) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; REZO/4.0; +https://bumpify.bot)',
        'Accept':          'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
      timeout: timeoutMs,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return fetchText(res.headers.location, timeoutMs, redirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; if (raw.length > 500000) { req.destroy(); reject(new Error('Réponse trop grande')); } });
      res.on('end', () => resolve(raw));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout`)); });
  });
}

// ─── Parser RSS minimal (sans dépendances) ────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  // Extraire tous les <item> ou <entry>
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1] || match[2];

    const get = (tag) => {
      // CDATA
      const cdataRx = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
      const cdataM  = block.match(cdataRx);
      if (cdataM) return cdataM[1].trim();
      // Normal
      const normalRx = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const normalM  = block.match(normalRx);
      if (normalM) return normalM[1].replace(/<[^>]+>/g, '').trim();
      return null;
    };

    const getAttr = (tag, attr) => {
      const rx = new RegExp(`<${tag}[^>]+${attr}="([^"]*)"`, 'i');
      const m  = block.match(rx);
      return m ? m[1] : null;
    };

    const title = get('title');
    if (!title) continue;

    // Lien
    let link = get('link') || getAttr('link', 'href') || '';
    // Nettoyer les liens qui contiennent du HTML
    link = link.replace(/<[^>]+>/g, '').trim();

    // Date
    const rawDate = get('pubDate') || get('published') || get('updated') || get('dc:date');
    const date    = rawDate ? new Date(rawDate) : new Date();

    // Description / résumé
    let desc = get('description') || get('summary') || get('content') || '';
    // Supprimer les balises HTML et limiter
    desc = desc.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (desc.length === 300) desc += '…';

    // Image — chercher dans media:content, enclosure, ou description
    let image = getAttr('media:content', 'url') || getAttr('enclosure', 'url') || null;
    if (!image) {
      const imgRx = /<img[^>]+src="([^"]+)"/i;
      const imgM  = (get('description') || '').match(imgRx);
      if (imgM) image = imgM[1];
    }
    // Filtre images valides
    if (image && !image.match(/^https?:\/\//)) image = null;

    // Catégorie
    const category = get('category');

    items.push({
      title:    decodeHTML(title),
      link:     link || null,
      date,
      desc:     decodeHTML(desc),
      image:    image || null,
      category: category || null,
    });
  }

  return items;
}

// ─── Decode entités HTML basiques ─────────────────────────────────────────────
function decodeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/&apos;/g,  "'")
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .trim();
}

// ─── Hash d'un lien (pour l'anti-doublon) ─────────────────────────────────────
function hashLink(link) {
  let h = 0;
  for (const c of (link || '')) { h = (h << 5) - h + c.charCodeAt(0); h |= 0; }
  return Math.abs(h).toString(36);
}

// ─── Récupérer les articles d'une source ─────────────────────────────────────
async function fetchSource(sourceKey) {
  const src = SOURCES[sourceKey];
  if (!src) return [];

  try {
    const xml   = await fetchText(src.url);
    const items = parseRSS(xml);

    return items.slice(0, 10).map(item => ({
      id:       hashLink(item.link || item.title),
      sourceKey,
      source:   src.name,
      emoji:    src.emoji,
      category: src.category,
      color:    src.color,
      icon:     src.icon,
      title:    item.title,
      link:     item.link,
      desc:     item.desc,
      image:    item.image,
      date:     item.date,
    }));
  } catch (err) {
    console.error(`[News] ${sourceKey}: ${err.message}`);
    return [];
  }
}

// ─── Reddit — subreddits fusionnés au flux d'actualités ──────────────────────
// Les posts Reddit passent par le MÊME pipeline que les articles RSS :
// mêmes salons par catégorie, même anti-doublon (NewsPosted) et mêmes
// notifications. Plus de planificateur séparé, plus de double post.
const REDDIT_MAX_SUBS = 5;
const REDDIT_MAX_POSTS_PER_SUB = 5;
const REDDIT_MAX_AGE_MS = 48 * 3600 * 1000; // on ignore les posts trop anciens
const REDDIT_CATEGORIES = ['general', 'gaming', 'tech', 'esport'];
const REDDIT_ICON = 'https://www.redditstatic.com/desktop2x/img/favicon/android-icon-192x192.png';

// Accepte « jeuxvideo », « r/jeuxvideo » ou une URL reddit.com/r/jeuxvideo.
function normalizeSubreddit(input = '') {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*reddit\.com/i, '')
    .replace(/^\/+/, '')
    .replace(/^r\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toLowerCase();
  if (cleaned.length < 2 || cleaned.length > 21) return null;
  return cleaned;
}

function redditImage(post = {}) {
  const preview = post.preview?.images?.[0]?.source?.url;
  if (preview) return String(preview).replace(/&amp;/g, '&');
  if (/\.(jpe?g|png|gif|gifv|webp)$/i.test(post.url || '')) return post.url;
  return null;
}

// Convertit un post Reddit en article du système d'actualités.
function redditPostToArticle(post = {}, subreddit, cfg = {}) {
  const created = new Date((post.created_utc || 0) * 1000);
  const body = String(post.selftext || '').replace(/\s+/g, ' ').trim();

  return {
    id:       `reddit_${post.id}`,
    sourceKey: `reddit:${subreddit}`,
    source:   `r/${subreddit}`,
    emoji:    '🟠',
    category: REDDIT_CATEGORIES.includes(cfg.category) ? cfg.category : 'general',
    color:    0xFF4500,
    icon:     REDDIT_ICON,
    title:    String(post.title || 'Post Reddit').slice(0, 256),
    link:     post.permalink ? `https://www.reddit.com${post.permalink}` : (post.url || null),
    desc:     body.length > 300 ? `${body.slice(0, 300)}…` : body,
    image:    redditImage(post),
    date:     Number.isNaN(created.getTime()) ? new Date() : created,
    reddit:   { author: post.author || null, upvotes: post.ups ?? 0, comments: post.num_comments ?? 0 },
  };
}

// Récupère les posts des subreddits suivis (API OAuth déjà utilisée par le
// module Reddit : REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET).
async function fetchRedditNews(redditCfg = {}) {
  const subs = [...new Set((redditCfg.subreddits || []).map(normalizeSubreddit).filter(Boolean))]
    .slice(0, REDDIT_MAX_SUBS);
  if (!subs.length) return [];

  if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) {
    console.error('[News] Reddit ignoré : REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET manquants dans le .env');
    return [];
  }

  const { fetchSubredditPosts, passesFilters } = require('./redditWatcher');
  const filters = {
    nsfwAllowed:     redditCfg.nsfwAllowed === true,
    minUpvotes:      Number(redditCfg.minUpvotes) || 0,
    // « mediaOnly » est appliqué plus bas avec la même détection d'image que
    // l'article (preview Reddit incluse), pas seulement l'extension de l'URL.
    mediaOnly:       false,
    includeKeywords: Array.isArray(redditCfg.includeKeywords) ? redditCfg.includeKeywords : [],
    excludeKeywords: Array.isArray(redditCfg.excludeKeywords) ? redditCfg.excludeKeywords : [],
    excludeFlairs:   [],
  };
  const mediaOnly = redditCfg.mediaOnly === true;
  const oldest = Date.now() - REDDIT_MAX_AGE_MS;

  const results = await Promise.allSettled(subs.map(async (sub) => {
    const posts = await fetchSubredditPosts(sub, 'new');
    return posts
      .filter(p => passesFilters(p, filters))
      .filter(p => !mediaOnly || redditImage(p))
      .filter(p => (p.created_utc || 0) * 1000 > oldest)
      .sort((a, b) => (b.created_utc || 0) - (a.created_utc || 0))
      .slice(0, REDDIT_MAX_POSTS_PER_SUB)
      .map(p => redditPostToArticle(p, sub, redditCfg));
  }));

  for (const r of results) {
    if (r.status === 'rejected') console.error('[News] Reddit:', r.reason?.message || r.reason);
  }

  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

// ─── Récupérer les articles de toutes les sources activées ───────────────────
async function fetchAllNews(enabledSources = {}, redditCfg = null) {
  const keys = Object.keys(SOURCES).filter(k => enabledSources[k] !== false);

  const [results, redditArticles] = await Promise.all([
    Promise.allSettled(keys.map(k => fetchSource(k))),
    redditCfg?.enabled
      ? fetchRedditNews(redditCfg).catch(err => {
          console.error('[News] Reddit:', err.message);
          return [];
        })
      : Promise.resolve([]),
  ]);

  const articles = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .concat(redditArticles);

  // Trier par date décroissante — RSS et Reddit mélangés dans un seul flux
  articles.sort((a, b) => new Date(b.date) - new Date(a.date));

  return articles;
}

module.exports = {
  SOURCES,
  fetchSource,
  fetchAllNews,
  fetchRedditNews,
  redditPostToArticle,
  normalizeSubreddit,
  hashLink,
};
