'use strict';
// utils/socialFetchers.js — Sources sociales SANS clé API.
//
// Couvre :
//   • RSS / Atom : blogs, YouTube (feeds/videos.xml), Reddit (.rss), Mastodon
//     (profil.rss), Substack, etc. — aucune clé, aucune inscription.
//   • Bluesky : API publique (public.api.bsky.app), lecture seule, sans compte.
//
// Les URLs des flux étant fournies par les utilisateurs, on refuse les hôtes
// privés (localhost, 10.x, 192.168.x…) pour éviter les requêtes internes.

const https = require('https');
const http = require('http');
const { URL } = require('url');

const USER_AGENT = 'REZO-DiscordBot/2.1 (+https://discord.com)';
const MAX_BYTES  = 2_000_000;
const MAX_ITEMS  = 25;
const BSKY_PUBLIC = 'https://public.api.bsky.app/xrpc';

// ─── Sécurité réseau ─────────────────────────────────────────────────────────
function isPrivateHost(hostname = '') {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return true;
  return false;
}

// ─── Requête HTTPS avec redirections ────────────────────────────────────────
function fetchText(rawUrl, { timeoutMs = 12_000, maxRedirects = 5, accept = '*/*', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let current = String(rawUrl || '').trim();

    const hop = (n) => {
      let parsed;
      try { parsed = new URL(current); } catch { return reject(new Error('URL invalide')); }
      if (!/^https?:$/.test(parsed.protocol)) return reject(new Error('Seules les URLs http(s) sont acceptées.'));
      if (isPrivateHost(parsed.hostname)) return reject(new Error('Adresse privée refusée.'));

      const transport = parsed.protocol === 'http:' ? http : https;
      const req = transport.get(current, {
        timeout: timeoutMs,
        headers: { 'User-Agent': USER_AGENT, Accept: accept, ...headers },
      }, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;

        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          if (n >= maxRedirects) return reject(new Error('Trop de redirections.'));
          try { current = new URL(location, current).toString(); } catch { return reject(new Error('Redirection invalide.')); }
          return hop(n + 1);
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > MAX_BYTES) {
            req.destroy();
            reject(new Error('Réponse trop volumineuse.'));
          }
        });
        res.on('end', () => {
          if (status >= 400) return reject(new Error(`HTTP ${status}`));
          resolve({ status, body, finalUrl: current, contentType: String(res.headers['content-type'] || '') });
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Délai dépassé.')); });
    };

    hop(0);
  });
}

async function getJson(url, opts) {
  const res = await fetchText(url, { ...opts, accept: 'application/json' });
  try { return JSON.parse(res.body); } catch { throw new Error('Réponse JSON invalide.'); }
}

// ─── Décodage HTML / CDATA ──────────────────────────────────────────────────
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(input = '') {
  return String(input)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+|#39);/gi, (m, name) => (NAMED_ENTITIES[name.toLowerCase()] ?? m));
}

function stripHtml(input = '') {
  const withoutTags = String(input).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags).replace(/\s+/g, ' ').trim();
}

function clip(input, max) {
  const s = String(input ?? '').trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

// ─── Helpers XML ────────────────────────────────────────────────────────────
function tagText(block, ...names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = re.exec(block);
    if (m) {
      const value = decodeEntities(m[1]).trim();
      if (value) return value;
    }
  }
  return '';
}

function attrValue(block, name) {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(block);
  return m ? decodeEntities(m[1]).trim() : null;
}

function firstUrlInHtml(html = '') {
  const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(String(html));
  return m ? decodeEntities(m[1]) : null;
}

// ─── RSS / Atom ─────────────────────────────────────────────────────────────
function normalizeFeedUrl(input = '') {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL du flux manquante.');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(withScheme); } catch { throw new Error('URL du flux invalide.'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Seules les URLs http(s) sont acceptées.');
  if (isPrivateHost(url.hostname)) throw new Error('Adresse privée refusée.');
  return url.toString();
}

function parseRssFeed(xml = '', { baseUrl = '' } = {}) {
  const src = String(xml || '');
  const isAtom = /<feed[\s>]/i.test(src);
  const head = isAtom
    ? (/<feed[\s>][\s\S]*?<\/feed>/i.exec(src)?.[0] || src)
    : (/<channel[\s>][\s\S]*?<\/channel>/i.exec(src)?.[0] || src);

  const channelTitle = tagText(head, 'title') || (isAtom ? '' : '') || 'Flux';
  const channelDescription = stripHtml(tagText(head, 'description', 'subtitle', 'tagline'));
  const siteUrl = (() => {
    const direct = tagText(head, 'link');
    if (direct && /^https?:/i.test(direct)) return direct;
    const href = attrValue(/<link[^>]*>/i.exec(head)?.[0] || '', 'href');
    return href && /^https?:/i.test(href) ? href : (baseUrl || null);
  })();
  const feedImage = tagText(head, 'url', 'icon', 'logo') || null;

  const itemBlocks = isAtom
    ? [...src.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0])
    : [...src.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);

  const items = itemBlocks.slice(0, MAX_ITEMS).map((block, index) => {
    const rawTitle = stripHtml(tagText(block, 'title'));
    const rawDescription = stripHtml(tagText(block, 'description', 'summary', 'content:encoded', 'content', 'media:description'));
    const rawContent = tagText(block, 'content:encoded', 'content', 'description', 'summary');

    const linkCandidates = [];
    const linkTag = tagText(block, 'link');
    if (linkTag && /^https?:/i.test(linkTag)) linkCandidates.push(linkTag);
    const linkHref = attrValue(/<link[^>]*>/i.exec(block)?.[0] || '', 'href');
    if (linkHref && /^https?:/i.test(linkHref)) linkCandidates.push(linkHref);
    if (!linkCandidates.length && baseUrl) linkCandidates.push(baseUrl);

    const enclosureBlock = /<enclosure[^>]*>/i.exec(block)?.[0] || '';
    const mediaBlock = /<media:(?:content|thumbnail)[^>]*>/i.exec(block)?.[0] || '';
    const image = attrValue(mediaBlock, 'url')
      || firstUrlInHtml(rawContent)
      || (/image/i.test(attrValue(enclosureBlock, 'type') || '') ? attrValue(enclosureBlock, 'url') : null)
      || attrValue(/<itunes:image[^>]*>/i.exec(block)?.[0] || '', 'href')
      || null;

    // Les flux YouTube exposent <yt:videoId> : on l'utilise comme identifiant
    // pour rester compatible avec l'API Data (lastVideoId).
    const rawGuid = tagText(block, 'yt:videoId', 'guid', 'id');
    // Certains flux n'ont pas de <link> : le guid permalien sert alors d'URL.
    if (!linkCandidates.length && /^https?:/i.test(rawGuid)) linkCandidates.push(rawGuid);
    const guid = rawGuid || linkCandidates[0] || `${rawTitle}-${index}`;
    const author = stripHtml(tagText(block, 'dc:creator', 'author', 'name')) || null;
    const dateRaw = tagText(block, 'pubDate', 'published', 'updated', 'dc:date');
    const date = dateRaw ? new Date(dateRaw) : null;

    return {
      id: guid,
      title: clip(rawTitle || stripHtml(rawDescription) || 'Nouvelle publication', 200),
      url: linkCandidates[0] || null,
      description: clip(rawDescription, 300),
      author,
      publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
      image,
    };
  });

  // Les flux sont censés être triés du plus récent au plus ancien ; on sécurise.
  items.sort((a, b) => {
    const ta = a.publishedAt ? a.publishedAt.getTime() : 0;
    const tb = b.publishedAt ? b.publishedAt.getTime() : 0;
    return tb - ta;
  });

  return {
    title: clip(stripHtml(channelTitle) || 'Flux', 100),
    description: clip(channelDescription, 300),
    siteUrl,
    image: feedImage,
    items,
  };
}

async function fetchRssFeed(input, opts = {}) {
  const url = normalizeFeedUrl(input);
  const res = await fetchText(url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' });
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(res.body)) {
    throw new Error('Ce lien ne renvoie pas un flux RSS/Atom valide.');
  }
  const feed = parseRssFeed(res.body, { baseUrl: res.finalUrl || url });
  return { ...feed, url: res.finalUrl || url };
}

// ─── Sélection des nouveautés (flux triés du plus récent au plus ancien) ─────
// Renvoie au plus `max` éléments publiés après `lastId`, du plus ancien au plus
// récent (ordre d'envoi). Si `lastId` a disparu du flux, on renvoie le dernier.
function pickNewItems(items = [], lastId = null, max = 3) {
  if (!Array.isArray(items) || !items.length) return [];
  const idx = items.findIndex((item) => item.id === lastId);
  const fresh = idx === -1 ? [items[0]] : items.slice(0, idx).reverse();
  return fresh.slice(0, max);
}

// ─── Bluesky (API publique, sans compte) ────────────────────────────────────
function normalizeBlueskyHandle(input = '') {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Handle Bluesky manquant.');
  if (/^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(raw)) return raw;

  const fromUrl = raw.match(/bsky\.app\/profile\/([^/?#]+)/i);
  const handle = (fromUrl ? fromUrl[1] : raw.replace(/^@/, '')).trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(handle)) {
    throw new Error(`Handle Bluesky invalide : ${raw}. Exemple : @nom.bsky.social`);
  }
  return handle;
}

function parseBlueskyFeed(json = {}, { handle = '' } = {}) {
  const posts = Array.isArray(json.feed) ? json.feed : [];
  const items = [];

  for (const entry of posts) {
    if (entry?.reason) continue; // repost / épinglage : on ne notifie que les posts de l'auteur
    const post = entry?.post;
    const record = post?.record;
    if (!post?.uri || !record) continue;

    const image = post.embed?.images?.[0]?.thumb
      || post.embed?.external?.thumb
      || post.embed?.thumbnail
      || null;
    const text = String(record.text || '').trim();
    const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || '';
    const rkey = String(post.uri).split('/').pop();
    const authorHandle = post.author?.handle || handle;
    const published = record.createdAt || post.indexedAt;

    items.push({
      id: post.uri,
      title: clip(firstLine || (image ? 'Nouvelle image' : 'Nouveau post Bluesky'), 200),
      description: clip(text.replace(/\s+/g, ' '), 300),
      url: authorHandle && rkey ? `https://bsky.app/profile/${authorHandle}/post/${rkey}` : null,
      author: post.author?.displayName || authorHandle || null,
      authorHandle,
      avatar: post.author?.avatar || null,
      publishedAt: published && !Number.isNaN(new Date(published).getTime()) ? new Date(published) : null,
      image,
    });
  }

  items.sort((a, b) => (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0));
  return { items: items.slice(0, MAX_ITEMS) };
}

async function resolveBlueskyProfile(input) {
  const actor = normalizeBlueskyHandle(input);
  const data = await getJson(`${BSKY_PUBLIC}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`);
  if (!data?.did) throw new Error(`Profil Bluesky introuvable : ${actor}`);
  return {
    did: data.did,
    handle: data.handle || actor,
    displayName: data.displayName || data.handle || actor,
    avatar: data.avatar || null,
    description: data.description || null,
  };
}

async function fetchBlueskyFeed(input, { limit = 10 } = {}) {
  const actor = normalizeBlueskyHandle(input);
  const data = await getJson(
    `${BSKY_PUBLIC}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=${Math.min(Math.max(limit, 1), 50)}&filter=posts_no_replies`,
  );
  const profile = data?.feed?.find((e) => e?.post?.author)?.post.author || null;
  const parsed = parseBlueskyFeed(data, { handle: profile?.handle || actor });
  return {
    handle: profile?.handle || actor,
    displayName: profile?.displayName || null,
    avatar: profile?.avatar || null,
    items: parsed.items,
  };
}

module.exports = {
  fetchText,
  isPrivateHost,
  normalizeFeedUrl,
  parseRssFeed,
  fetchRssFeed,
  pickNewItems,
  decodeEntities,
  stripHtml,
  normalizeBlueskyHandle,
  parseBlueskyFeed,
  resolveBlueskyProfile,
  fetchBlueskyFeed,
  USER_AGENT,
  MAX_ITEMS,
};
