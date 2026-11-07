'use strict';
// utils/aiWeb.js — Recherche web et lecture de pages pour l'IA de REZO.
//
// Aucune clé n'est requise : la recherche passe par l'endpoint HTML public de
// DuckDuckGo, et la page la plus pertinente est lue puis nettoyée. Le résultat
// est injecté dans le prompt comme un bloc de contexte daté, avec ses sources.
//
// Trois garde-fous :
//   • cache court (10 min) : une même question ne relance pas une recherche ;
//   • délai maximal et taille de page bornée : jamais de blocage du chat ;
//   • hôtes privés refusés (SSRF) : l'IA ne peut pas lire le réseau local.

const UA = 'Mozilla/5.0 (compatible; REZO/1.0; +https://discord.com)';
const CACHE_TTL_MS = 10 * 60_000;
const MAX_RESULTS = 4;
const MAX_PAGE_CHARS = 1800;

const cache = new Map(); // query -> { at, value }

// ─── Utilitaires texte ──────────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    const key = code.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16) || 32);
    if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10) || 32);
    return whole;
  });
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unwrapDuckUrl(href) {
  const raw = String(href || '');
  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.toString();
  } catch { return null; }
}

// ─── Faut-il chercher sur le web ? ──────────────────────────────────────────
const FRESH = /(aujourd'?hui|actualit|derni[eè]res?|r[ée]cent|nouveaut|sortie|2025|2026|prix|co[uû]te|m[ée]t[ée]o|score|r[ée]sultat|qui est|combien|quand|o[uù] se trouve|documentation|docs|version|site officiel)/i;

/**
 * Heuristique volontairement stricte : mieux vaut répondre de mémoire que
 * lancer une recherche inutile à chaque message.
 */
function needsWebSearch(text) {
  const q = String(text || '').trim();
  if (q.length < 4) return false;
  if (/https?:\/\/\S+/i.test(q)) return true;
  if (/(?:^|\s)(?:cherche|recherche|search|google|v[ée]rifie sur internet)\b/i.test(q)) return true;
  return FRESH.test(q) && (q.includes('?') || /(?:cherche|recherche|trouve|explique|donne|c'est quoi|qui est|combien)/i.test(q));
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

// ─── Réseau ─────────────────────────────────────────────────────────────────
async function fetchText(url, { fetchImpl = fetch, timeoutMs = 7000, maxChars = 400_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    return raw.slice(0, maxChars);
  } finally { clearTimeout(timer); }
}

async function searchDuckDuckGo(query, { fetchImpl = fetch, timeoutMs = 7000 } = {}) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, { fetchImpl, timeoutMs });
  const results = [];

  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) && snippets.length < MAX_RESULTS) {
    snippets.push(htmlToText(sm[1]).slice(0, 300));
  }

  let m;
  let index = 0;
  while ((m = linkRe.exec(html)) && results.length < MAX_RESULTS) {
    const target = unwrapDuckUrl(m[1]);
    if (!target || !/^https?:/i.test(target)) continue;
    const title = htmlToText(m[2]).slice(0, 160);
    if (!title) continue;
    results.push({ title, url: target, snippet: snippets[index] || '' });
    index += 1;
  }
  return results;
}

async function fetchPage(url, { fetchImpl = fetch, timeoutMs = 7000 } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) return null;

  try {
    const html = await fetchText(parsed.toString(), { fetchImpl, timeoutMs, maxChars: 250_000 });
    const text = htmlToText(html).replace(/\s+/g, ' ').slice(0, MAX_PAGE_CHARS);
    return text.length > 200 ? text : null;
  } catch { return null; }
}

/** Bloc prêt à être injecté dans le prompt (ou null si rien d'exploitable). */
async function buildWebContext(query, options = {}) {
  const key = String(query || '').trim().slice(0, 200);
  if (!key) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value = null;
  try {
    const results = await searchDuckDuckGo(key, options);
    if (results.length) {
      const top = results[0];
      const page = await fetchPage(top.url, options).catch(() => null);

      const lines = [
        `RÉSULTATS WEB RÉCENTS (recherche du ${new Date().toLocaleDateString('fr-FR')}) — appuie-toi dessus, cite les URLs quand c’est utile et ignore ce qui ne répond pas à la question :`,
      ];
      results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title} — ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
      });
      if (page) lines.push(`\nExtrait de ${top.url} :\n${page}`);

      value = { block: lines.join('\n').slice(0, 5200), sources: results.map(r => r.url) };
    }
  } catch { value = null; }

  if (cache.size > 300) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function clearCache() { cache.clear(); }

module.exports = {
  CACHE_TTL_MS,
  needsWebSearch,
  searchDuckDuckGo,
  fetchPage,
  buildWebContext,
  htmlToText,
  unwrapDuckUrl,
  isPrivateHost,
  clearCache,
};
