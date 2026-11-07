'use strict';
// web/storeServer.js — Le site REZO : un vrai serveur HTTP.
//
// Rien n'est pré-généré : chaque page est rendue à la requête, à partir des
// offres (`utils/licensePlans`), du catalogue de commandes réellement chargé
// depuis `src/commands`, et de l'état des commandes en base.
//
// Routes :
//   GET  /                          accueil
//   GET  /tarifs                    offres + FAQ
//   GET  /packs                     les packs tout compris
//   GET  /devis                     formulaire de devis (Pack REZO.net)
//   POST /devis                     enregistre la demande (MP à l'owner par le bot)
//   GET  /commandes                 explorateur de commandes (recherche, domaines)
//   GET  /faq                       questions fréquentes (recherche locale)
//   GET  /guide                     activation d'une clé, pas à pas
//   GET  /nouveautes                journal des fonctionnalités livrées
//   GET  /api/faq  /api/packs       données publiques en JSON
//   GET  /verifier?cle=…            état d'une clé
//   GET  /statut                    état du bot et du site (aussi `/api/statut`)
//   GET  /sitemap.xml               plan du site (robots.txt y renvoie)
//   POST /acheter                   crée la commande puis redirige vers Stripe
//   GET  /commande/:token           suivi + clé
//   GET  /commande/:token/cle.txt   clé en texte brut
//   POST /stripe/webhook            confirmation signée (idempotente)
//   POST /admin/orders/:token/encaisse   validation manuelle (jeton admin)
//   GET  /api/plans  /api/commandes/:token  /health
//
// Sécurité : aucune donnée client n'est renvoyée brute (échappement systématique
// dans storePages), corps borné, débit limité, CSP stricte, webhook vérifié par
// signature, jeton admin comparé à temps constant.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('../utils/licenseStore');
const pages = require('../utils/storePages');
const mailer = require('../utils/storeMailer');
const { publicPlans, publicTiers, publicPacks, resolvePlan } = require('../utils/licensePlans');
const { validateQuote } = require('../utils/quoteRequest');
const quoteStore = require('../utils/quoteStore');
const { createBoundedCache } = require('../utils/boundedCache');
const { SUPPORT_INVITE, FAQ_GROUPS, CHANGELOG } = require('../utils/storeContent');
const { siteUrl } = require('../utils/siteUrl');

const MAX_BODY = 16 * 1024;

// Une seule liste : le sitemap et le routage ne peuvent pas diverger.
const SITEMAP_PATHS = ['/', '/commandes', '/tarifs', '/packs', '/devis', '/faq', '/guide', '/nouveautes', '/beta', '/verifier', '/statut'];
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 25;

const DOMAINS = {
  'bump-reseau':   { label: 'Réseau',        emoji: '🌐' },
  'communaute':    { label: 'Communauté',    emoji: '💬' },
  'configuration': { label: 'Configuration', emoji: '⚙️' },
  'economie':      { label: 'Économie',      emoji: '💰' },
  'fun':           { label: 'Fun',           emoji: '🎲' },
  'moderation':    { label: 'Modération',    emoji: '⚔️' },
  'musique':       { label: 'Musique',       emoji: '🎵' },
  'owner':         { label: 'Propriétaire',  emoji: '👑' },
  'securite':      { label: 'Sécurité',      emoji: '🛡️' },
  'utilitaires':   { label: 'Outils',        emoji: '🧰' },
  'xp':            { label: 'Niveaux',       emoji: '🏆' },
};

// Retours affichés sur la page d'administration après une action.
const ADMIN_MESSAGES = {
  encaisse: 'Commande approuvée, clé émise.',
  envoye: 'Clé envoyée par e-mail au client.',
  refuse: 'Commande refusée — le client ne recevra pas de clé.',
  mailoff: 'Clé émise. Envoi d’e-mails non configuré : ajoute RESEND_API_KEY et STORE_MAIL_FROM.',
  mailko: 'Clé émise, mais l’e-mail n’a pas pu partir. La clé reste visible sur la page client ; tu peux réessayer l’envoi.',
  sansemail: 'Clé émise. Cette commande n’a pas d’adresse e-mail : transmets la clé depuis la page client.',
  erreur: 'Action impossible : la commande a peut-être déjà changé d’état.',
};

const limits = createBoundedCache({ max: 20_000, ttl: 0, name: 'store-hits' });

function rateLimited(key, { now = Date.now(), max = RATE_MAX } = {}) {
  if (!key) return false;
  const entry = limits.get(key);
  if (!entry || now >= entry.resetAt) {
    limits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

function clearRateLimits() { limits.clear(); }

// ── Catalogue de commandes ───────────────────────────────────────────────────
// Chargé une fois par processus : lire 100 fichiers à chaque page serait
// absurde. Une modification du code nécessite un redémarrage (comme le bot).
let catalogCache = null;

function loadCommandCatalog() {
  if (catalogCache) return catalogCache;

  const commandsDir = path.join(__dirname, '..', 'commands');
  const out = [];
  let failed = [];

  try {
    const { loadModules } = require('../core/registry');
    const loaded = loadModules(commandsDir);
    failed = loaded.failed || [];
    for (const entry of loaded.commands) {
      const json = entry.mod.data?.toJSON ? entry.mod.data.toJSON() : entry.mod.data;
      if (!json?.name) continue;
      const meta = DOMAINS[entry.category] || { label: entry.category || 'Autres', emoji: '•' };
      out.push({
        name: json.name,
        description: json.description || '',
        group: entry.category,
        groupLabel: meta.label,
        emoji: meta.emoji,
        subcommands: (json.options || [])
          .filter(o => o.type === 1 || o.type === 2)
          .map(o => o.name)
          .slice(0, 25),
      });
    }
  } catch (err) {
    failed.push({ file: 'registry', error: err.message });
  }

  out.sort((a, b) => a.groupLabel.localeCompare(b.groupLabel, 'fr') || a.name.localeCompare(b.name, 'fr'));
  catalogCache = { commands: out, failed };
  return catalogCache;
}

function resetCatalogCache() { catalogCache = null; }

function domainList(commands) {
  const seen = new Map();
  for (const c of commands) {
    if (!seen.has(c.group)) seen.set(c.group, { id: c.group, label: c.groupLabel, emoji: c.emoji });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

function searchCommands(commands, { q = '', domain = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return commands.filter(c => {
    if (domain && c.group !== domain) return false;
    if (!needle) return true;
    const haystack = [c.name, c.description, c.groupLabel, ...(c.subcommands || [])]
      .join(' ').toLowerCase();
    return haystack.includes(needle);
  });
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function securityHeaders(res, extra = {}) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "connect-src 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

function sendHtml(res, status, html, extra = {}) {
  securityHeaders(res, extra);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extra = {}) {
  securityHeaders(res, extra);
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(text);
}

function sendJson(res, status, payload) {
  sendText(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) {
        reject(new Error('trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(String(body || ''))) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

function clientIp(req, env) {
  if (env.STORE_TRUST_PROXY === '1') {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return String(req.socket?.remoteAddress || '').trim() || 'inconnue';
}

/**
 * Port explicite d'une URL publique (`http://hote:24667` → 24667).
 * Permet de n'écrire qu'une seule variable quand l'hébergeur impose son port.
 */
function portFromPublicUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/** Origine absolue du site (pour les URL de retour Stripe). */
function originOf(req, env) {
  const configured = store.publicBaseUrl(env);
  if (configured) return configured;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (!host) return '';
  const proto = env.STORE_TRUST_PROXY === '1'
    ? (String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https')
    : 'http';
  return `${proto}://${host}`;
}

/**
 * La requête est-elle réellement en HTTPS ?
 *
 * Le drapeau `Secure` d'un cookie doit suivre le transport RÉEL, jamais l'URL
 * configurée : un site servi en `http://hote:port` avec `STORE_PUBLIC_URL` en
 * `https://` posait un cookie que le navigateur refuse de stocker. Le panneau
 * admin redemandait alors le jeton en boucle, comme si le mot de passe était
 * faux, alors que la connexion avait réussi.
 */
function isSecureRequest(req, env) {
  if (req.socket?.encrypted) return true;
  if (env.STORE_TRUST_PROXY === '1') {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }
  return false;
}

function tokenEq(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  return bufA.length === bufB.length && bufA.length > 0 && crypto.timingSafeEqual(bufA, bufB);
}

/** Jeton admin : en-tête `Authorization: Bearer …`, `x-admin-token`, ou cookie de session. */
const ADMIN_COOKIE = 'rezo_admin';

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch { return rest.join('='); }
    }
  }
  return '';
}

function adminAuthorized(req, env) {
  const expected = String(env.STORE_ADMIN_TOKEN || '').trim();
  if (!expected) return false;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const header = String(req.headers['x-admin-token'] || '').trim();
  const cookie = readCookie(req, ADMIN_COOKIE).trim();
  return tokenEq(bearer, expected) || tokenEq(header, expected) || tokenEq(cookie, expected);
}

/** Pourquoi une requête admin est refusée (`null` = autorisée). */
function adminBlockReason(req, env, ip) {
  if (!String(env.STORE_ADMIN_TOKEN || '').trim()) return 'disabled';
  if (!adminAuthorized(req, env)) return 'unauthorized';
  if (rateLimited(`admin:${ip}`, { max: 60 })) return 'rate';
  return null;
}

/** Une action de la page d'administration arrive en formulaire, pas en JSON. */
function isFormPost(req) {
  return String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded');
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers }).end();
}

/**
 * Envoie la clé au client par e-mail et mémorise l'envoi.
 * Ne lève jamais : l'appelant décide quoi afficher.
 */
async function deliverKeyEmail(order, key, { env = process.env, logger = console, baseUrl = '' } = {}) {
  if (!order?.email) return { ok: false, reason: 'sans-email' };
  if (!mailer.mailConfigured(env)) return { ok: false, reason: 'sans-config' };

  const plan = resolvePlan(order.plan);
  const result = await mailer.sendLicenseEmail({
    to: order.email,
    key,
    plan: plan ? `REZO ${plan.label}` : `REZO ${String(order.plan || '').toUpperCase()}`,
    tierLabel: plan?.kindLabel || '',
    seats: plan?.maxGuilds || 1,
    graceDays: plan?.graceDays || 0,
    amountCents: order.amountCents,
    currency: order.currency,
    orderUrl: baseUrl ? `${baseUrl.replace(/\/+$/, '')}/commande/${order.token}` : '',
    env,
  }).catch(err => ({ ok: false, error: err?.message || 'envoi impossible' }));

  if (!result.ok) {
    // Cas de loin le plus fréquent : un expéditeur sur un domaine non vérifié.
    const message = String(result.error || '');
    const hint = /domain is not verified/i.test(message)
      ? ' → STORE_MAIL_FROM doit être un domaine vérifié chez Resend, ou « onboarding@resend.dev » pour tester (envoi limité à ta propre adresse).'
      : /sender|not verified|invalid.*email/i.test(message)
        ? ' → chez Brevo, l’adresse expéditrice doit être validée une fois : brevo.com → Senders, Domain & IPs → Add a sender, puis clique le lien reçu par e-mail.'
        : '';
    logger.warn?.(`site: e-mail non envoyé pour ${String(order.token).slice(0, 10)}… — ${result.error || 'erreur'}${hint}`);
    return { ok: false, reason: 'echec', error: result.error };
  }
  await store.markEmailSent(order.token).catch(() => {});
  logger.info?.(`site: clé envoyée à ${order.email}`);
  return { ok: true, id: result.id };
}

// ── État du service ──────────────────────────────────────────────────────────
/**
 * Photo de l'état réel, pour `/statut` et `/api/statut`.
 * Aucun secret : seulement des compteurs et deux booléens « configuré ».
 * Le site peut tourner sans bot (`npm run site`) : `online` vaut alors false
 * et la page le dit explicitement au lieu de simuler une panne.
 */
function systemInfo({ client = null, env = process.env } = {}) {
  const online = Boolean(client?.isReady?.());
  const memory = process.memoryUsage();

  let members = null;
  if (client?.guilds?.cache?.size) {
    let total = 0;
    let known = false;
    for (const guild of client.guilds.cache.values()) {
      if (Number.isFinite(guild?.memberCount)) { total += guild.memberCount; known = true; }
    }
    if (known) members = total;
  }

  let commands = null;
  try { commands = loadCommandCatalog().commands.length; } catch { /* catalogue indisponible */ }

  return {
    online,
    version: require('../../package.json').version,
    ping: Number.isFinite(client?.ws?.ping) ? Math.max(0, Math.round(client.ws.ping)) : null,
    guilds: client?.guilds?.cache?.size ?? null,
    members,
    commands,
    modules: Object.keys(DOMAINS).length,
    uptimeMs: online && Number.isFinite(client?.uptime) ? client.uptime : Math.round(process.uptime() * 1000),
    memoryBytes: memory.rss,
    services: { stripe: store.stripeConfigured(env), mail: mailer.mailConfigured(env) },
    siteUrl: siteUrl(env),
    checkedAt: new Date().toISOString(),
  };
}

// ── Routage ──────────────────────────────────────────────────────────────────
const TOKEN_RE = /^[a-f0-9]{64}$/;

function xmlEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function parseRoute(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  return { url, parts, method: String(req.method || 'GET').toUpperCase() };
}

async function handleRequest(req, res, { client = null, env = process.env, logger = console } = {}) {
  const { url, parts, method } = parseRoute(req);
  const ip = clientIp(req, env);
  const stripeReady = store.stripeConfigured(env);

  // ── Statique minimal (aucune ressource externe) ──
  if (method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  if (method === 'GET' && url.pathname === '/robots.txt') {
    return sendText(res, 200, `User-agent: *\nAllow: /\nSitemap: ${siteUrl(env)}/sitemap.xml\n`);
  }
  if (method === 'GET' && url.pathname === '/sitemap.xml') {
    const paths = SITEMAP_PATHS;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      paths.map(p => `  <url><loc>${xmlEsc(`${siteUrl(env)}${p}`)}</loc></url>`).join('\n')
    }\n</urlset>\n`;
    return sendText(res, 200, xml, 'application/xml; charset=utf-8');
  }
  if (method === 'GET' && (url.pathname === '/statut' || url.pathname === '/api/statut')) {
    const info = systemInfo({ client, env });
    if (url.pathname === '/api/statut') return sendJson(res, 200, { ok: true, ...info });
    return sendHtml(res, 200, pages.statusPage({ info }));
  }
  if (method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, version: require('../../package.json').version });
  }

  // ── API ──
  if (method === 'GET' && url.pathname === '/api/plans') {
    return sendJson(res, 200, { plans: publicPlans(), tiers: publicTiers(), currency: 'EUR' });
  }
  // Données déjà publiques sur les pages : les exposer en JSON évite qu'un
  // outil tiers (bot, widget) analyse du HTML pour les récupérer.
  if (method === 'GET' && url.pathname === '/api/packs') {
    return sendJson(res, 200, { packs: publicPacks(), currency: 'EUR' });
  }
  if (method === 'GET' && url.pathname === '/api/faq') {
    return sendJson(res, 200, { groups: FAQ_GROUPS });
  }
  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'commandes' && parts[2]) {
    const order = await store.findOrder(parts[2]).catch(() => null);
    if (!order) return sendJson(res, 404, { ok: false, error: 'inconnue' });
    return sendJson(res, 200, {
      ok: true,
      status: order.status,
      plan: order.plan,
      // La clé n'est exposée qu'une fois la commande payée.
      key: order.status === 'paid' ? order.key : null,
    });
  }

  // ── Accueil / pages ──
  if (method === 'GET' && url.pathname === '/') {
    const { commands } = loadCommandCatalog();
    return sendHtml(res, 200, pages.homePage({
      plans: publicPlans(),
      tiers: publicTiers(),
      stats: {
        guilds: client?.guilds?.cache?.size ?? null,
        commands: commands.length,
        modules: Object.keys(DOMAINS).length,
        status: client ? 'En ligne' : 'Disponible',
      },
    }));
  }

  if (method === 'GET' && url.pathname === '/tarifs') {
    return sendHtml(res, 200, pages.pricingPage({ plans: publicPlans(), tiers: publicTiers() }));
  }

  // Les packs sont des bundles : même tunnel d'achat que les offres, mais une
  // page à part pour ne pas mélanger licence nue et prestations.
  if (method === 'GET' && url.pathname === '/packs') {
    return sendHtml(res, 200, pages.packsPage({ packs: publicPacks() }));
  }

  if (method === 'GET' && url.pathname === '/faq') {
    return sendHtml(res, 200, pages.faqPage({ groups: FAQ_GROUPS }));
  }

  if (method === 'GET' && url.pathname === '/guide') {
    return sendHtml(res, 200, pages.guidePage({}));
  }

  if (method === 'GET' && url.pathname === '/nouveautes') {
    return sendHtml(res, 200, pages.changelogPage({ entries: CHANGELOG }));
  }

  // ── Devis (Pack REZO.net) ──
  // La demande est enregistrée : le bot la relève et l'envoie en MP au
  // propriétaire, qui approuve ou refuse. Aucune clé n'existe avant son accord.
  if (method === 'GET' && url.pathname === '/devis') {
    return sendHtml(res, 200, pages.quotePage({
      pack: publicPacks().find(p => p.quote) || null,
      mailReady: mailer.mailConfigured(env),
      sent: url.searchParams.get('envoye') === '1',
    }));
  }

  if (method === 'POST' && url.pathname === '/devis') {
    if (rateLimited(`quote:${ip}`, { max: 5 })) {
      return sendHtml(res, 429, pages.errorPage({
        status: 429,
        title: 'Trop de demandes',
        message: 'Trop de demandes de devis depuis cette connexion. Réessaie dans une minute.',
      }));
    }

    let form;
    try {
      form = parseForm(await readBody(req, 32 * 1024));
    } catch {
      return sendHtml(res, 413, pages.errorPage({
        status: 413, title: 'Formulaire trop lourd', message: 'Réduis le texte du message et réessaie.',
      }));
    }

    const check = validateQuote(form);
    if (!check.ok) {
      return sendHtml(res, 400, pages.quotePage({
        pack: publicPacks().find(p => p.quote) || null,
        values: form,
        errors: check.errors,
        mailReady: mailer.mailConfigured(env),
      }));
    }

    const stored = await quoteStore.createRequest(check.values)
      .catch(err => ({ ok: false, error: err?.message || 'enregistrement impossible' }));

    if (stored.ok) {
      logger.info?.('site: demande de devis enregistrée — le bot l’envoie en MP à l’owner.');
      return redirect(res, '/devis?envoye=1');
    }

    // Base indisponible : la demande ne doit pas être perdue pour autant. On la
    // fait partir par e-mail si un fournisseur est configuré.
    logger.warn?.(`site: demande non enregistrée (${stored.error}) — repli e-mail.`);
    const delivered = await mailer.sendQuoteEmail({
      fields: check.values,
      env,
      sentAt: new Date(),
      siteUrl: siteUrl(env),
    }).catch(err => ({ ok: false, error: err?.message || 'envoi impossible' }));

    if (!delivered.ok) {
      logger.error?.(`site: demande de devis non transmise — ${delivered.error}`);
      return sendHtml(res, 502, pages.quotePage({
        pack: publicPacks().find(p => p.quote) || null,
        values: form,
        errors: {
          global: 'La demande n’a pas pu être enregistrée. Réessaie dans un instant ou écris directement au support.',
        },
      }));
    }

    logger.info?.(`site: demande de devis envoyée par e-mail à ${delivered.to}`);
    return redirect(res, '/devis?envoye=1');
  }

  if (method === 'GET' && url.pathname === '/commandes') {
    const { commands } = loadCommandCatalog();
    const q = url.searchParams.get('q') || '';
    const domain = url.searchParams.get('domaine') || '';
    const found = searchCommands(commands, { q, domain });
    return sendHtml(res, 200, pages.commandsPage({
      commands: found,
      domains: domainList(commands),
      domain,
      query: q,
    }));
  }

  if (method === 'GET' && url.pathname === '/verifier') {
    const key = (url.searchParams.get('cle') || '').trim();
    let result = null;
    if (key && !rateLimited(`verify:${ip}`)) {
      result = await store.inspectKey(key).catch(() => ({ ok: false, error: 'inconnue' }));
    }
    return sendHtml(res, 200, pages.verifyPage({ key, result }));
  }

  // ── Achat ──
  if (method === 'POST' && url.pathname === '/acheter') {
    if (rateLimited(`buy:${ip}`)) {
      return sendHtml(res, 429, pages.errorPage({
        status: 429,
        title: 'Trop de demandes',
        message: 'Trop de commandes depuis cette connexion. Réessaie dans une minute.',
      }));
    }

    let form;
    try {
      form = parseForm(await readBody(req));
    } catch {
      return sendHtml(res, 413, pages.errorPage({
        status: 413, title: 'Requête trop lourde', message: 'Réessaie depuis la page des offres.',
      }));
    }

    const plan = resolvePlan(String(form.plan || ''));
    if (!plan) {
      return sendHtml(res, 400, pages.errorPage({
        status: 400, title: 'Offre inconnue', message: 'Choisis une offre sur la page des tarifs.',
      }));
    }
    // Les packs sur devis ne s'achètent pas en ligne : on le dit, plutôt que
    // de créer une commande à 0 €.
    if (plan.quote) {
      return sendHtml(res, 400, pages.errorPage({
        status: 400,
        title: 'Offre sur devis',
        message: 'Ce pack est chiffré avec le support : demande un devis depuis la page des packs, aucun paiement en ligne n’est possible.',
      }));
    }

    const created = await store.createOrder({
      planId: plan.id,
      email: form.email || null,
      provider: stripeReady ? 'stripe' : 'manual',
    });
    if (!created.ok) {
      logger.error?.(`site: création de commande impossible — ${created.error}`);
      return sendHtml(res, 500, pages.errorPage({
        status: 500, title: 'Commande impossible', message: 'La commande n’a pas pu être enregistrée. Réessaie dans un instant.',
      }));
    }

    const order = created.order;
    if (!stripeReady) {
      res.writeHead(303, { Location: `/commande/${order.token}` });
      res.end();
      return;
    }

    const session = await store.createCheckoutSession({
      order, plan, origin: originOf(req, env), secretKey: env.STRIPE_SECRET_KEY,
    });

    if (session.ok) {
      res.writeHead(303, { Location: session.url });
      res.end();
      return;
    }

    logger.error?.(`site: session Stripe impossible — ${session.error}`);
    // Repli honnête : la commande existe, le client garde son lien de suivi.
    return sendHtml(res, 200, pages.checkoutPage({
      order: { ...order, checkoutUrl: `/commande/${order.token}` },
      plan,
      stripe: false,
    }));
  }

  // ── Suivi de commande ──
  if (method === 'GET' && parts[0] === 'commande' && parts[1]) {
    const token = parts[1];
    if (!TOKEN_RE.test(token)) {
      return sendHtml(res, 404, pages.errorPage({ status: 404, title: 'Commande introuvable', message: 'Ce lien de suivi n’est pas valide.' }));
    }

    let order = await store.findOrder(token).catch(() => null);
    if (!order) {
      return sendHtml(res, 404, pages.errorPage({
        status: 404, title: 'Commande introuvable', message: 'Cette commande n’existe pas. Garde le lien reçu après l’achat.',
      }));
    }

    // Retour de Stripe : on confirme directement auprès de Stripe au lieu
    // d'attendre le webhook (qui peut arriver quelques secondes plus tard).
    const sessionId = url.searchParams.get('session');
    if (order.status === 'pending' && sessionId && stripeReady && !rateLimited(`confirm:${ip}`)) {
      const confirmed = await store.confirmFromSession({
        token, sessionId, secretKey: env.STRIPE_SECRET_KEY,
      }).catch(err => ({ ok: false, error: err.message }));
      if (confirmed.ok) {
        order = (await store.findOrder(token).catch(() => null)) || order;
      } else {
        logger.warn?.(`site: confirmation de session impossible — ${confirmed.error}`);
      }
    }

    if (parts[2] === 'cle.txt') {
      if (order.status !== 'paid' || !order.key) {
        return sendText(res, 409, 'La clé n’est pas encore disponible : la commande n’est pas payée.\n');
      }
      const plan = resolvePlan(order.plan);
      return sendText(
        res, 200,
        [
          `REZO — licence ${order.plan}`,
          `Clé : ${order.key}`,
          `Offre : ${plan?.label || order.plan}${plan?.days ? ` (${plan.days} jours)` : ' (illimitée)'}`,
          `Palier : ${plan?.kindLabel || plan?.kind || 'standard'}`,
          `Serveurs couverts : ${plan?.maxGuilds || 1}`,
          `Grâce après expiration : ${plan?.graceDays || 0} jour(s)`,
          `Référence : ${order.token}`,
          '',
          'Activation : sur ton serveur, tape /license puis clique « Activer une clé ».',
          plan?.maxGuilds > 1 ? `Répète l’activation sur les ${plan.maxGuilds} serveurs couverts.` : '',
          `Support : ${SUPPORT_INVITE}`,
          '',
        ].join('\n'),
        'text/plain; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="rezo-licence-${order.plan}.txt"` },
      );
    }

    const justPaid = url.searchParams.get('paiement') === 'ok';
    return sendHtml(res, 200, pages.orderPage({ order, key: order.key, justPaid }));
  }

  // ── Webhook Stripe ──
  if (method === 'POST' && url.pathname === '/stripe/webhook') {
    const secret = String(env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!secret) {
      logger.warn?.('site: webhook Stripe reçu mais STRIPE_WEBHOOK_SECRET est vide.');
      return sendJson(res, 503, { ok: false, error: 'webhook non configuré' });
    }

    let raw;
    try {
      raw = await readBody(req, 64 * 1024);
    } catch {
      return sendJson(res, 413, { ok: false, error: 'corps trop volumineux' });
    }

    const signature = req.headers['stripe-signature'];
    if (!store.verifyStripeSignature({ payload: raw, header: signature, secret })) {
      logger.warn?.('site: signature Stripe invalide — requête refusée.');
      return sendJson(res, 400, { ok: false, error: 'signature invalide' });
    }

    let event;
    try { event = JSON.parse(raw); } catch { return sendJson(res, 400, { ok: false, error: 'JSON invalide' }); }

    const token = store.orderTokenFromEvent(event);
    const type = String(event?.type || '');

    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      const object = event.data?.object || {};
      if (object.payment_status && object.payment_status !== 'paid' && object.payment_status !== 'no_payment_required') {
        return sendJson(res, 200, { ok: true, ignored: 'paiement non confirmé' });
      }
      if (!token) return sendJson(res, 200, { ok: true, ignored: 'jeton absent' });

      const result = await store.fulfilOrder(token, {
        providerRef: object.id || null,
        providerEventId: event.id || null,
      }).catch(err => ({ ok: false, error: err.message }));

      if (!result.ok) {
        logger.error?.(`site: encaissement impossible pour ${String(token).slice(0, 10)}… — ${result.error}`);
        // 500 : Stripe réessaiera ; la commande est restée « en attente ».
        return sendJson(res, 500, { ok: false, error: result.error });
      }
      logger.info?.(`site: licence ${result.order?.plan || ''} délivrée (commande ${String(token).slice(0, 10)}…)`);
      return sendJson(res, 200, { ok: true });
    }

    if (type === 'checkout.session.expired') {
      if (token) await store.cancelOrder(token).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 200, { ok: true, ignored: type || 'inconnu' });
  }

  // ── Administration : page des commandes ──
  if (url.pathname === '/admin' && (method === 'GET' || method === 'POST')) {
    const expected = String(env.STORE_ADMIN_TOKEN || '').trim();
    if (!expected) {
      return sendHtml(res, 503, pages.errorPage({
        status: 503,
        title: 'Administration désactivée',
        message: 'STORE_ADMIN_TOKEN n’est pas configuré sur ce site.',
      }));
    }

    // Connexion : le jeton devient un cookie HttpOnly, jamais une URL.
    if (method === 'POST') {
      if (rateLimited(`adminlogin:${ip}`, { max: 8 })) {
        return sendHtml(res, 429, pages.adminLoginPage({ error: 'Trop de tentatives. Réessaie dans une minute.' }));
      }
      let body = '';
      try { body = await readBody(req, 4096); } catch { body = ''; }
      const { jeton } = parseForm(body);
      if (!tokenEq(String(jeton || '').trim(), expected)) {
        logger.warn?.(`site: tentative d’accès admin refusée (${ip})`);
        return sendHtml(res, 401, pages.adminLoginPage({ error: 'Jeton incorrect.' }));
      }
      // `Secure` seulement si la requête est vraiment en HTTPS (voir plus haut).
      const secure = isSecureRequest(req, env) ? '; Secure' : '';
      return redirect(res, '/admin', {
        'Set-Cookie': `${ADMIN_COOKIE}=${encodeURIComponent(expected)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`,
      });
    }

    if (!adminAuthorized(req, env)) return sendHtml(res, 200, pages.adminLoginPage({}));
    if (rateLimited(`admin:${ip}`, { max: 60 })) {
      return sendHtml(res, 429, pages.errorPage({
        status: 429, title: 'Trop de requêtes', message: 'Patiente une minute avant de recharger.',
      }));
    }

    const filter = String(url.searchParams.get('etat') || '').trim();
    const orders = await store.listOrders({ status: filter || null, limit: 60 }).catch(() => []);
    const message = ADMIN_MESSAGES[String(url.searchParams.get('msg') || '')] || null;
    return sendHtml(res, 200, pages.adminPage({
      orders,
      message,
      filter,
      mail: { configured: mailer.mailConfigured(env) },
    }));
  }

  // ── Validation manuelle (sans Stripe) ──
  if (method === 'POST' && parts[0] === 'admin' && parts[1] === 'orders' && parts[2] && parts[3] === 'encaisse') {
    const blocked = adminBlockReason(req, env, ip);
    if (blocked) {
      return sendJson(res, blocked === 'disabled' ? 503 : blocked === 'rate' ? 429 : 401, { ok: false, error: blocked });
    }

    const result = await store.fulfilOrder(parts[2], { providerRef: 'manual' })
      .catch(err => ({ ok: false, error: err.message }));

    if (!result.ok) {
      if (isFormPost(req)) return redirect(res, '/admin?msg=erreur');
      return sendJson(res, 400, { ok: false, error: result.error });
    }
    logger.info?.(`site: commande ${parts[2].slice(0, 10)}… encaissée manuellement.`);

    // La clé part au client dans la foulée quand une adresse est connue.
    const sent = await deliverKeyEmail(result.order, result.key, {
      env, logger, baseUrl: store.publicBaseUrl(env) || originOf(req, env),
    });

    if (isFormPost(req)) {
      const msg = sent.ok ? 'envoye'
        : sent.reason === 'sans-email' ? 'sansemail'
          : sent.reason === 'sans-config' ? 'mailoff' : 'mailko';
      return redirect(res, `/admin?msg=${msg}`);
    }
    return sendJson(res, 200, {
      ok: true, key: result.key, already: Boolean(result.already),
      email: sent.ok ? { sent: true } : { sent: false, reason: sent.reason, error: sent.error },
    });
  }

  // ── Administration : refuser une commande ──
  if (method === 'POST' && parts[0] === 'admin' && parts[1] === 'orders' && parts[2] && parts[3] === 'refuser') {
    const blocked = adminBlockReason(req, env, ip);
    if (blocked) return sendJson(res, blocked === 'disabled' ? 503 : blocked === 'rate' ? 429 : 401, { ok: false, error: blocked });

    const result = await store.cancelOrder(parts[2], { reason: 'cancelled' })
      .catch(err => ({ ok: false, error: err.message }));
    if (!result.ok) {
      if (isFormPost(req)) return redirect(res, '/admin?msg=erreur');
      return sendJson(res, 400, { ok: false, error: result.error });
    }
    logger.info?.(`site: commande ${parts[2].slice(0, 10)}… refusée.`);
    if (isFormPost(req)) return redirect(res, '/admin?msg=refuse');
    return sendJson(res, 200, { ok: true });
  }

  // ── Administration : (re)envoyer la clé par e-mail ──
  if (method === 'POST' && parts[0] === 'admin' && parts[1] === 'orders' && parts[2] && parts[3] === 'email') {
    const blocked = adminBlockReason(req, env, ip);
    if (blocked) return sendJson(res, blocked === 'disabled' ? 503 : blocked === 'rate' ? 429 : 401, { ok: false, error: blocked });

    const order = await store.findOrder(parts[2]).catch(() => null);
    if (!order) {
      if (isFormPost(req)) return redirect(res, '/admin?msg=erreur');
      return sendJson(res, 404, { ok: false, error: 'commande inconnue' });
    }
    if (order.status !== 'paid' || !order.key) {
      if (isFormPost(req)) return redirect(res, '/admin?msg=erreur');
      return sendJson(res, 400, { ok: false, error: 'clé non émise pour cette commande' });
    }

    const sent = await deliverKeyEmail(order, order.key, {
      env, logger, baseUrl: store.publicBaseUrl(env) || originOf(req, env),
    });
    if (isFormPost(req)) {
      const msg = sent.ok ? 'envoye'
        : sent.reason === 'sans-email' ? 'sansemail'
          : sent.reason === 'sans-config' ? 'mailoff' : 'mailko';
      return redirect(res, `/admin?msg=${msg}`);
    }
    return sent.ok
      ? sendJson(res, 200, { ok: true, id: sent.id })
      : sendJson(res, 400, { ok: false, error: sent.error || sent.reason });
  }

  // ── 404 ──
  return sendHtml(res, 404, pages.errorPage({}));
}

// ── Démarrage ────────────────────────────────────────────────────────────────
let server = null;

/**
 * Démarre le site si `STORE_PORT` (ou `STORE_PUBLIC_URL`) est configuré.
 * Idempotent : un seul écouteur par processus.
 */
async function startStoreServer({ client = null, env = process.env, logger = console } = {}) {
  if (server) return server;

  const port = Number(
    env.STORE_PORT
    || portFromPublicUrl(env.STORE_PUBLIC_URL)
    || (env.STORE_PUBLIC_URL ? 3200 : 0),
  );
  if (!port) return null;
  const host = String(env.STORE_HOST || '0.0.0.0').trim() || '0.0.0.0';

  server = http.createServer((req, res) => {
    handleRequest(req, res, { client, env, logger }).catch(err => {
      logger.error?.(`site: ${err?.stack || err?.message || err}`);
      if (!res.headersSent) {
        sendHtml(res, 500, pages.errorPage({
          status: 500, title: 'Erreur interne', message: 'Le site a rencontré un problème. Réessaie dans un instant.',
        }));
      } else {
        res.end();
      }
    });
  });

  await new Promise(resolve => {
    const onError = err => {
      logger.error?.(`site: écoute impossible sur ${host}:${port} (${err.code || err.message})`);
      server = null;
      resolve();
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const publicUrl = store.publicBaseUrl(env);
      logger.info?.(`🌐 Site REZO à l'écoute sur ${host}:${port}${publicUrl ? ` — URL publique ${publicUrl}` : ''}`);
      if (!publicUrl) {
        logger.info?.('site: STORE_PUBLIC_URL vide — les liens de retour utilisent l’en-tête Host de la requête.');
      } else if (!/^https:\/\//i.test(publicUrl) && store.stripeConfigured(env)) {
        logger.warn?.('site: STRIPE_SECRET_KEY est configurée mais STORE_PUBLIC_URL est en http — en mode live, Stripe attend une URL de retour HTTPS.');
      }
      if (!store.stripeConfigured(env)) {
        logger.info?.('site: sans STRIPE_SECRET_KEY, les commandes passent par une validation manuelle.');
      }
      resolve();
    });
  });

  return server;
}

function stopStoreServer() {
  if (!server) return Promise.resolve(false);
  const current = server;
  server = null;
  return new Promise(resolve => current.close(() => resolve(true)));
}

/** Connexion Mongo minimale pour faire tourner le site seul (`npm run site`). */
async function connectDatabase(uri, { logger = console } = {}) {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!uri) throw new Error('MONGODB_URI manquant');
  await mongoose.connect(uri, {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL || 20),
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_MS || 10_000),
  });
  logger.info?.('site: base connectée');
  return mongoose;
}

module.exports = {
  DOMAINS,
  MAX_BODY,
  SITEMAP_PATHS,
  RATE_MAX,
  RATE_WINDOW_MS,
  handleRequest,
  parseRoute,
  parseForm,
  readBody,
  originOf,
  isSecureRequest,
  portFromPublicUrl,
  clientIp,
  rateLimited,
  clearRateLimits,
  systemInfo,
  adminAuthorized,
  adminBlockReason,
  ADMIN_COOKIE,
  ADMIN_MESSAGES,
  readCookie,
  deliverKeyEmail,
  loadCommandCatalog,
  resetCatalogCache,
  domainList,
  searchCommands,
  startStoreServer,
  stopStoreServer,
  connectDatabase,
};
