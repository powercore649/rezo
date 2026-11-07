'use strict';
// utils/siteStatus.js — Vérification d'un site web : en ligne, en maintenance ou hors ligne.
//
// Le module est volontairement PUR côté décision (classifyResult) et isolé côté
// réseau (checkSite accepte un fetchImpl), pour être testable sans Internet.
//
// Trois états seulement, celui que l'administrateur veut connaître :
//   • online      — le site répond normalement (2xx/3xx) ;
//   • maintenance — le site répond 503, ou sa page annonce une maintenance ;
//   • down        — erreur réseau, délai dépassé, ou autre code d'erreur.
//
// Sécurité : les URLs sont validées AVANT tout appel. Les adresses privées
// (localhost, 10.x, 192.168.x, ::1…) sont refusées par défaut, pour qu'une
// commande Discord ne puisse pas sonder le réseau interne de l'hôte.

const { siteUrl } = require('./siteUrl');

const DEFAULT_MAINTENANCE_KEYWORDS = [
  'maintenance',
  'maintenance en cours',
  'maintenance planifiée',
  'site en maintenance',
  'en maintenance',
  'temporairement indisponible',
  'service indisponible',
  'reviendra bientôt',
  'be right back',
];

// Un 503 est le signal standard de maintenance (« Service Unavailable »).
const MAINTENANCE_STATUS_CODES = [503];

const STATUS_META = {
  online:      { emoji: '🟢', label: 'En ligne',   color: 0x2ECC71 },
  maintenance: { emoji: '🟠', label: 'Maintenance', color: 0xE67E22 },
  down:        { emoji: '🔴', label: 'Hors ligne',  color: 0xE74C3C },
  unknown:     { emoji: '⚪', label: 'Jamais vérifié', color: 0x95A5A6 },
};

const MAX_SITES               = 10;
const MIN_INTERVAL_MINUTES    = 5;
const MAX_INTERVAL_MINUTES    = 120;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_FAILURE_THRESHOLD = 2;
const MAX_FAILURE_THRESHOLD   = 5;
const REQUEST_TIMEOUT_MS      = 10_000;
const BODY_LIMIT_BYTES        = 64 * 1024;
const MAX_REDIRECTS           = 3;
const MAX_CHECKS_PER_RUN      = 40;
const USER_AGENT              = `REZO-Uptime/1.0 (+${siteUrl()})`;

// ─── Normalisation ──────────────────────────────────────────────────────────
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function isIpv4(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;             // 0.0.0.0/8, 10/8, loopback
  if (a === 169 && b === 254) return true;                       // link-local (métadonnées cloud)
  if (a === 172 && b >= 16 && b <= 31) return true;              // 172.16/12
  if (a === 192 && b === 168) return true;                       // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT 100.64/10
  if (a >= 224) return true;                                     // multicast / réservé
  return false;
}

/** Adresse manifestement interne : le bot ne doit jamais la sonder. */
function isPrivateHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (isIpv4(host)) return isPrivateIpv4(host);
  // IPv6 : loopback, lien-local (fe80::/10), unique-local (fc00::/7), IPv4 mappée privée
  if (host === '::' || host === '::1') return true;
  if (/^fe[89ab]/.test(host)) return true;
  if (/^f[cd]/.test(host)) return true;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/**
 * Valide une URL de site. Un schéma absent est complété par https://.
 * @returns {{ok:boolean,url?:string,host?:string,error?:string}}
 */
function validateSiteUrl(raw, { allowPrivate = false } = {}) {
  const input = String(raw || '').trim();
  if (!input) return { ok: false, error: 'URL vide.' };
  if (input.length > 300) return { ok: false, error: 'URL trop longue (300 caractères maximum).' };

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'URL invalide — exemple : https://exemple.com/statut' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Seuls http:// et https:// sont acceptés.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Une URL contenant un identifiant ou un mot de passe est refusée.' };
  }
  if (!parsed.hostname) return { ok: false, error: 'URL sans nom d’hôte.' };
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    return { ok: false, error: 'Adresse interne refusée : seuls les sites publics sont surveillés.' };
  }

  return { ok: true, url: parsed.toString(), host: normalizeHost(parsed.hostname) };
}

// ─── Classification ─────────────────────────────────────────────────────────
function matchesMaintenanceKeyword(body, keywords) {
  if (!body) return false;
  const text = normalizeText(body);
  return (keywords || DEFAULT_MAINTENANCE_KEYWORDS)
    .map(normalizeText)
    .filter(Boolean)
    .some(keyword => text.includes(keyword));
}

/**
 * Décide l'état d'un site à partir de la réponse HTTP.
 * @param {{statusCode:number|null, body?:string, keywords?:string[]}} probe
 * @returns {'online'|'maintenance'|'down'}
 */
function classifyResult({ statusCode = null, body = '', keywords = DEFAULT_MAINTENANCE_KEYWORDS } = {}) {
  if (matchesMaintenanceKeyword(body, keywords)) return 'maintenance';
  if (statusCode === null) return 'down';
  if (MAINTENANCE_STATUS_CODES.includes(statusCode)) return 'maintenance';
  if (statusCode >= 200 && statusCode < 400) return 'online';
  return 'down';
}

// ─── Appel réseau ───────────────────────────────────────────────────────────
/** Lit au maximum `limit` octets du corps : une page de 50 Mo ne doit pas être chargée. */
async function readCappedBody(res, limit = BODY_LIMIT_BYTES) {
  const stream = res?.body;
  if (!stream || typeof stream.getReader !== 'function') return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.length > limit - total ? value.subarray(0, limit - total) : value;
      text += decoder.decode(chunk, { stream: true });
      total += chunk.length;
    }
    text += decoder.decode();
  } catch {
    // Corps interrompu : on garde ce qui a été lu, la classification s'en contente.
  } finally {
    try { await reader.cancel(); } catch { /* déjà fermé */ }
  }
  return text;
}

function redirectTarget(location, base) {
  try {
    const next = new URL(String(location || ''), base);
    return next.toString();
  } catch {
    return null;
  }
}

/**
 * Vérifie un site et renvoie son état.
 * @param {{url:string, maintenanceKeywords?:string[]}} site
 * @param {{fetchImpl?:Function, keywords?:string[], timeoutMs?:number, allowPrivate?:boolean, maxRedirects?:number}} [options]
 * @returns {Promise<{status:string,statusCode:number|null,responseMs:number|null,error:string|null,finalUrl:string,checkedAt:Date}>}
 */
async function checkSite(site, {
  fetchImpl = fetch,
  keywords = DEFAULT_MAINTENANCE_KEYWORDS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  allowPrivate = false,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  const checkedAt = new Date();
  const effectiveKeywords = site?.maintenanceKeywords?.length ? site.maintenanceKeywords : keywords;

  let current = String(site?.url || '');
  const started = Date.now();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validation = validateSiteUrl(current, { allowPrivate });
    if (!validation.ok) {
      return { status: 'down', statusCode: null, responseMs: null, error: validation.error, finalUrl: current, checkedAt };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetchImpl(validation.url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.5' },
      });
    } catch (err) {
      const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      return {
        status: 'down',
        statusCode: null,
        responseMs: Date.now() - started,
        error: aborted ? `Aucune réponse en ${Math.round(timeoutMs / 1000)} s.` : (err?.message || 'Erreur réseau.'),
        finalUrl: validation.url,
        checkedAt,
      };
    } finally {
      clearTimeout(timer);
    }

    const statusCode = Number(res?.status) || 0;
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      const next = redirectTarget(res.headers?.get?.('location'), validation.url);
      if (!next) {
        return { status: 'down', statusCode, responseMs: Date.now() - started, error: 'Redirection sans destination.', finalUrl: validation.url, checkedAt };
      }
      current = next;
      continue;
    }

    const body = await readCappedBody(res);
    const status = classifyResult({ statusCode, body, keywords: effectiveKeywords });
    return {
      status,
      statusCode,
      responseMs: Date.now() - started,
      error: status === 'down' && statusCode >= 400 ? `Réponse HTTP ${statusCode}.` : null,
      finalUrl: validation.url,
      checkedAt,
    };
  }

  return {
    status: 'down',
    statusCode: null,
    responseMs: Date.now() - started,
    error: `Trop de redirections (${maxRedirects} maximum).`,
    finalUrl: current,
    checkedAt,
  };
}

// ─── Affichage ──────────────────────────────────────────────────────────────
function formatResponseMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2).replace('.', ',')} s`;
}

function formatAgo(date, now = new Date()) {
  if (!date) return 'jamais';
  const seconds = Math.max(0, Math.round((new Date(now).getTime() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function formatDuration(from, to = new Date()) {
  if (!from) return '—';
  const seconds = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

/** Disponibilité observée depuis l'ajout du site (en ligne / vérifications). */
function availability(site) {
  const checks = Number(site?.checks || 0);
  if (!checks) return null;
  return Math.round((Number(site.upChecks || 0) / checks) * 1000) / 10;
}

function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.unknown;
}

module.exports = {
  DEFAULT_MAINTENANCE_KEYWORDS,
  MAINTENANCE_STATUS_CODES,
  STATUS_META,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_FAILURE_THRESHOLD,
  MAX_FAILURE_THRESHOLD,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MAX_SITES,
  MAX_CHECKS_PER_RUN,
  REQUEST_TIMEOUT_MS,
  BODY_LIMIT_BYTES,
  USER_AGENT,
  normalizeText,
  isPrivateHost,
  validateSiteUrl,
  classifyResult,
  readCappedBody,
  checkSite,
  formatResponseMs,
  formatAgo,
  formatDuration,
  availability,
  statusMeta,
};
