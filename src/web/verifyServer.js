'use strict';
// web/verifyServer.js — Portail de vérification anti-VPN.
//
// Discord ne transmet jamais l'IP d'un membre aux bots. La seule façon fiable
// d'en obtenir une est de faire ouvrir au membre une page que nous contrôlons :
// c'est ce serveur HTTP. Il écoute sur ANTIVPN_PORT (désactivé par défaut) et
// construit les liens avec ANTIVPN_PUBLIC_URL.
//
// Sécurité :
//   • jeton aléatoire de 32 octets, à usage unique, stocké en base ;
//   • nonce anti-CSRF dans le formulaire ;
//   • limite de débit par IP et taille de corps bornée ;
//   • aucune ressource externe (CSP stricte), aucune clé exposée ;
//   • l'IP n'est lue qu'au POST, et n'est conservée que si le serveur l'a choisi.

const http = require('http');
const { verifySession } = require('../utils/antiVpnFlow');
const VPNVerification = require('../models/VPNVerification');

const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 20;
const MAX_BODY = 10 * 1024;

// Serveur de support affiché en pied de page (lien vers Discord).
const SUPPORT_URL = 'https://discord.gg/S5M9SGTM5Q';

let server = null;
const { createBoundedCache } = require('../utils/boundedCache');
// BORNÉ : le limiteur de débit gardait une entrée par adresse IP, à vie.
const hits = createBoundedCache({ max: 20_000, ttl: 0, name: 'verify-hits' });

function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * IP réelle de la requête.
 * Derrière un reverse proxy, il faut ANTIVPN_TRUST_PROXY=1 pour lire les
 * en-têtes — sinon n'importe qui pourrait falsifier son IP.
 */
function resolveClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const cf = normalizeIp(req.headers['cf-connecting-ip']);
    if (cf) return cf;
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0];
    const first = normalizeIp(forwarded);
    if (first) return first;
    const real = normalizeIp(req.headers['x-real-ip']);
    if (real) return real;
  }
  return normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
}

function rateLimited(ip, now = Date.now()) {
  if (!ip) return false;
  const entry = hits.get(ip);
  if (!entry || now >= entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX;
}

function clearRateLimit() { hits.clear(); }

// ── Pages ───────────────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #14101a; color: #f2eef7; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 24px;
  }
  main {
    width: 100%; max-width: 460px; background: #1d1726; border: 1px solid #342a44;
    border-radius: 18px; padding: 32px 28px; box-shadow: 0 18px 50px rgba(0,0,0,.45);
  }
  .badge { font-size: 34px; line-height: 1; }
  h1 { font-size: 21px; margin: 14px 0 10px; }
  p { margin: 0 0 18px; color: #c9bfd8; }
  button {
    width: 100%; padding: 14px 18px; font-size: 16px; font-weight: 600;
    color: #fff; background: #7b2d3b; border: 0; border-radius: 12px; cursor: pointer;
  }
  button:hover { background: #8f3546; }
  .hint { margin-top: 18px; font-size: 13px; color: #8f84a3; }
  .ok { color: #6ee7a8; }
  .bad { color: #ff8b9a; }
  footer { margin-top: 22px; font-size: 12px; color: #6f6484; text-align: center; }
  footer .support { display: inline-block; margin-top: 8px; color: #b9a7e0; text-decoration: none; }
  footer .support:hover { color: #d9cdf0; text-decoration: underline; }
  .help-link { color: #b9a7e0; }
`;

function buildPage({ title, message, emoji = '🛰️', form = null, tone = '' }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} — Vérification</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <div class="badge">${escapeHtml(emoji)}</div>
  <h1>${escapeHtml(title)}</h1>
  <p class="${tone}">${message}</p>
  ${form || ''}
  <p class="hint">Cette page ne fait que vérifier votre connexion. Aucun mot de passe ni code Discord ne vous sera demandé.</p>
  <footer>REZO • Protection contre les VPN, proxys et Tor<br>
    <a class="support" href="${escapeHtml(SUPPORT_URL)}" target="_blank" rel="noopener noreferrer">💬 Besoin d’aide ? Rejoindre le serveur de support</a>
  </footer>
</main>
</body>
</html>`;
}

function send(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function resultPage(res, result) {
  switch (result.state) {
    case 'passed':
      return send(res, 200, buildPage({
        title: 'Connexion vérifiée',
        emoji: '✅',
        tone: 'ok',
        message: 'Votre connexion a été validée. Vous pouvez retourner sur Discord et fermer cet onglet.',
      }));
    case 'blocked':
      return send(res, 403, buildPage({
        title: 'Connexion refusée',
        emoji: '⛔',
        tone: 'bad',
        message: 'Un VPN, un proxy ou Tor a été détecté sur votre connexion. Si vous pensez qu’il s’agit d’une erreur, <a class="help-link" href="' + escapeHtml(SUPPORT_URL) + '" target="_blank" rel="noopener noreferrer">contactez le support</a>.',
      }));
    default:
      return send(res, 400, buildPage({
        title: 'Vérification impossible',
        emoji: '⚠️',
        message: 'La vérification n’a pas pu aboutir. Réessayez, ou demandez un nouveau lien au staff.',
      }));
  }
}

// ── Routage ─────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body_too_large'));
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
  const params = new URLSearchParams(body || '');
  return {
    nonce: params.get('nonce') || '',
    token: params.get('token') || '',
  };
}

async function handleRequest(req, res, { client, env, logger = console }) {
  const url = new URL(req.url || '/', 'http://localhost');
  const trustProxy = String(env.ANTIVPN_TRUST_PROXY || '') === '1';

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  const match = url.pathname.match(/^\/verify\/([A-Za-z0-9_-]{16,128})$/);
  if (!match) return send(res, 404, buildPage({ title: 'Page introuvable', emoji: '🔎', message: 'Ce lien n’existe pas.' }));

  const token = match[1];
  const ip = resolveClientIp(req, { trustProxy });

  if (req.method === 'GET') {
    const session = await VPNVerification.findOne({ token }).lean().catch(() => null);
    if (!session) return send(res, 404, buildPage({ title: 'Lien invalide', emoji: '🔎', message: 'Ce lien de vérification n’existe pas ou a été remplacé.' }));
    if (session.state === 'passed') {
      return send(200, buildPage({ title: 'Déjà vérifié', emoji: '✅', tone: 'ok', message: 'Votre connexion a déjà été validée. Vous pouvez retourner sur Discord.' }));
    }
    if (session.state === 'blocked') {
      return send(403, buildPage({ title: 'Connexion refusée', emoji: '⛔', tone: 'bad', message: 'Cette vérification a déjà été refusée. Contactez le staff du serveur.' }));
    }
    if (session.state !== 'pending' || new Date(session.expiresAt).getTime() <= Date.now()) {
      return send(410, buildPage({ title: 'Lien expiré', emoji: '⌛', message: 'Ce lien a expiré. Demandez au staff de vous renvoyer une vérification.' }));
    }

    const form = `<form method="post" action="/verify/${escapeHtml(token)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <input type="hidden" name="nonce" value="${escapeHtml(session.nonce || '')}">
      <button type="submit">Vérifier ma connexion</button>
    </form>`;

    return send(res, 200, buildPage({
      title: 'Vérification de connexion',
      emoji: '🛰️',
      message: 'Un dernier clic : nous allons vérifier que votre connexion n’utilise pas de VPN, de proxy ou Tor.',
      form,
    }));
  }

  if (req.method !== 'POST') return send(res, 405, buildPage({ title: 'Méthode refusée', emoji: '⚠️', message: 'Utilisez le bouton de la page.' }));

  if (rateLimited(ip)) {
    return send(res, 429, buildPage({ title: 'Trop de tentatives', emoji: '⏳', message: 'Trop de vérifications depuis cette connexion. Réessayez dans quelques minutes.' }));
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 413, buildPage({ title: 'Requête trop lourde', emoji: '⚠️', message: 'Réessayez depuis le lien reçu.' }));
  }

  const form = parseForm(body);
  if (form.token && form.token !== token) {
    return send(res, 400, buildPage({ title: 'Lien incohérent', emoji: '⚠️', message: 'Rouvrez le lien reçu sur Discord.' }));
  }

  const session = await VPNVerification.findOne({ token }).lean().catch(() => null);
  if (!session) return send(res, 404, buildPage({ title: 'Lien invalide', emoji: '🔎', message: 'Ce lien de vérification n’existe plus.' }));
  if (session.nonce && form.nonce !== session.nonce) {
    return send(res, 400, buildPage({ title: 'Formulaire invalide', emoji: '⚠️', message: 'Rouvrez le lien reçu sur Discord et réessayez.' }));
  }

  const result = await verifySession(token, { client, ip, env }).catch(err => {
    logger.error?.('anti-vpn verify:', err.message);
    return { ok: false, error: 'server' };
  });

  if (result.ok) return resultPage(res, result);

  if (result.error === 'bad_ip') {
    return send(res, 400, buildPage({
      title: 'Adresse non vérifiable',
      emoji: '⚠️',
      message: 'Cette page doit être ouverte depuis votre navigateur personnel, sur le réseau que vous utilisez pour Discord.',
    }));
  }
  if (result.error === 'expired') {
    return send(res, 410, buildPage({ title: 'Lien expiré', emoji: '⌛', message: 'Le délai de vérification est dépassé. Demandez un nouveau lien au staff.' }));
  }
  if (result.error === 'already') {
    return resultPage(res, { state: result.state });
  }

  return send(res, 400, buildPage({ title: 'Vérification impossible', emoji: '⚠️', message: 'Réessayez dans un instant, ou contactez le staff du serveur.' }));
}

// ── Démarrage ───────────────────────────────────────────────────────────────
/**
 * Démarre le portail si ANTIVPN_PORT (ou une URL publique) est configuré.
 * Idempotent : un seul écouteur par processus.
 */
async function startVerifyServer({ client, env = process.env, logger = console } = {}) {
  if (server) return server;
  const port = Number(env.ANTIVPN_PORT || (env.ANTIVPN_PUBLIC_URL ? 3199 : 0));
  if (!port) return null;
  // Derrière un reverse proxy, ANTIVPN_HOST=127.0.0.1 évite d'exposer le
  // portail directement (et de contourner TLS). Par défaut : toutes les
  // interfaces, pour un déploiement autonome.
  const host = String(env.ANTIVPN_HOST || '0.0.0.0').trim() || '0.0.0.0';

  server = http.createServer((req, res) => {
    handleRequest(req, res, { client, env, logger }).catch(err => {
      logger.error?.('anti-vpn portal:', err.stack || err.message);
      if (!res.headersSent) send(res, 500, buildPage({ title: 'Erreur', emoji: '⚠️', message: 'Erreur interne. Réessayez plus tard.' }));
      else res.end();
    });
  });

  await new Promise(resolve => {
    const onError = err => {
      logger.error?.(`anti-vpn portal: écoute impossible sur le port ${port} (${err.code || err.message})`);
      server = null;
      resolve();
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      logger.info?.(`🛰️ Portail anti-VPN à l'écoute sur ${host}:${port}`);
      resolve();
    });
  });

  return server;
}

function stopVerifyServer() {
  if (!server) return null;
  const current = server;
  server = null;
  return new Promise(resolve => current.close(() => resolve(true)));
}

module.exports = {
  SUPPORT_URL,
  startVerifyServer,
  stopVerifyServer,
  resolveClientIp,
  rateLimited,
  clearRateLimit,
  buildPage,
  STYLES,
  RATE_MAX,
  RATE_WINDOW_MS,
};
