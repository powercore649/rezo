'use strict';
// web/antiVpnTunnel.js — Tunnel public gratuit pour le portail anti-VPN.
//
// Le portail doit être joignable depuis Internet pour que le membre puisse
// ouvrir son lien. Sans VPS ni domaine, `cloudflared` crée un tunnel HTTPS
// éphémère (https://<aléatoire>.trycloudflare.com) vers le port local : aucune
// ouverture de box, aucun certificat à gérer, aucun compte.
//
// Le module lance/arrête le processus, extrait l'URL publique, et — si le
// binaire est absent — le télécharge une seule fois dans `tools/` (même
// mécanisme que les autres outils du bot). `ANTIVPN_TUNNEL_DOWNLOAD=0` interdit
// ce téléchargement.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');

let child = null;
let url = null;

const LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i;

/** L'URL ne peut pas être ouverte par un membre (adresse de la machine). */
function isLoopbackUrl(value) {
  return LOOPBACK_RE.test(String(value || '').trim());
}

/** URL d'un tunnel rapide Cloudflare dans la sortie de cloudflared. */
function parseQuickTunnelUrl(output) {
  const match = String(output || '').match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

function isTunnelRequested(value) {
  return ['1', 'true', 'yes', 'on', 'cloudflared', 'auto'].includes(String(value || '').trim().toLowerCase());
}

function isTunnelDisabled(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

// ── Binaire cloudflared ─────────────────────────────────────────────────────
// Nom de l'archive officielle pour la plateforme courante, ou null si le
// téléchargement automatique n'est pas proposé (macOS : brew).
function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'cloudflared-windows-amd64.exe';
  if (platform === 'linux') {
    if (arch === 'arm64') return 'cloudflared-linux-arm64';
    if (arch === 'arm') return 'cloudflared-linux-arm';
    return 'cloudflared-linux-amd64';
  }
  return null;
}

/**
 * Garantit que le binaire est exécutable.
 *
 * Un cloudflared déposé par FTP ou par le gestionnaire de fichiers du serveur
 * arrive en 644 : `spawn` échoue alors avec EACCES alors que le fichier est
 * bien là. On répare le droit au lieu de laisser le tunnel mourir.
 *
 * @returns {string} le même chemin, désormais exécutable
 * @throws {Error} si le système refuse le changement de droits
 */
function ensureExecutable(file, { logger = console } = {}) {
  if (process.platform === 'win32') return file;

  try {
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch { /* droit d'exécution absent : on le pose */ }

  try {
    const mode = fs.statSync(file).mode;
    fs.chmodSync(file, mode | 0o111);
    fs.accessSync(file, fs.constants.X_OK);
  } catch (err) {
    const reason = err?.code === 'EPERM' || err?.code === 'EACCES'
      ? 'le bot n’a pas le droit de modifier ce fichier'
      : (err?.message || 'erreur inconnue');
    throw new Error(
      `cloudflared n’est pas exécutable (${file}) et la correction a échoué : ${reason}. `
      + `Dans le terminal du serveur, lance « chmod +x ${file} » puis redémarre le bot.`,
    );
  }

  logger.info?.(`☁️ cloudflared : droit d’exécution ajouté (${file})`);
  return file;
}

function downloadFile(targetUrl, destination, { redirects = 6, logger = console, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, {
      headers: { 'user-agent': 'REZO-AntiVPN/1.0', accept: 'application/octet-stream' },
    }, res => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, targetUrl).toString();
        return resolve(downloadFile(next, destination, { redirects: redirects - 1, logger, timeoutMs }));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`téléchargement cloudflared : HTTP ${status}`));
      }

      const tmp = `${destination}.part`;
      const out = fs.createWriteStream(tmp);
      let received = 0;
      let nextLog = 10 * 1024 * 1024;
      res.on('data', chunk => {
        received += chunk.length;
        if (received >= nextLog) {
          logger.info?.(`☁️ cloudflared : ${Math.round(received / 1024 / 1024)} Mo téléchargés…`);
          nextLog += 10 * 1024 * 1024;
        }
      });
      res.pipe(out);
      out.on('error', err => {
        try { fs.unlinkSync(tmp); } catch { /* rien */ }
        reject(err);
      });
      out.on('finish', () => out.close(() => {
        try {
          fs.renameSync(tmp, destination);
          resolve(destination);
        } catch (err) {
          try { fs.unlinkSync(tmp); } catch { /* rien */ }
          reject(err);
        }
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('téléchargement cloudflared : délai dépassé')));
  });
}

/**
 * Chemin d'un cloudflared utilisable, en le téléchargeant au besoin.
 * @returns {Promise<string>}
 */
async function ensureCloudflared({ rootDir = path.join(__dirname, '..', '..'), env = process.env, logger = console } = {}) {
  const explicit = String(env.CLOUDFLARED_PATH || '').trim();
  if (explicit) {
    if (fs.existsSync(explicit)) return ensureExecutable(explicit, { logger });
    throw new Error(`CLOUDFLARED_PATH introuvable : ${explicit}`);
  }

  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const local = path.join(rootDir, 'tools', exe);
  if (fs.existsSync(local)) return ensureExecutable(local, { logger });

  if (String(env.ANTIVPN_TUNNEL_DOWNLOAD || '1').toLowerCase() === '0') {
    throw new Error('cloudflared absent et téléchargement automatique désactivé (ANTIVPN_TUNNEL_DOWNLOAD=0).');
  }

  const asset = cloudflaredAsset();
  if (!asset) {
    throw new Error('téléchargement automatique de cloudflared indisponible sur cette plateforme — installe-le (macOS : brew install cloudflared).');
  }

  fs.mkdirSync(path.dirname(local), { recursive: true });
  logger.info?.('☁️ cloudflared absent : téléchargement automatique (une seule fois, ~50 Mo)…');
  await downloadFile(
    `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
    local,
    { logger },
  );
  ensureExecutable(local, { logger });
  logger.info?.(`☁️ cloudflared prêt : ${local}`);
  return local;
}

// ── Tunnel ──────────────────────────────────────────────────────────────────
/**
 * Démarre un tunnel rapide vers http://127.0.0.1:<port>.
 * Résout dès que l'URL publique est connue.
 *
 * @returns {Promise<{url:string, reused?:boolean}>}
 */
function startQuickTunnel({
  port,
  binary = process.env.CLOUDFLARED_PATH || 'cloudflared',
  logger = console,
  spawnImpl = spawn,
  timeoutMs = 60_000,
  onExit = null,
} = {}) {
  if (!port) return Promise.reject(new Error('port du portail manquant pour le tunnel'));
  if (child && url) return Promise.resolve({ url, reused: true });

  // Le binaire a beau être présent, il lui manque parfois le bit exécutable
  // (dépôt FTP en 644) : `spawn` renverrait EACCES. On corrige avant de lancer.
  let binaryPath = binary;
  if (fs.existsSync(binary)) {
    try {
      binaryPath = ensureExecutable(binary, { logger });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  const args = ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];
  logger.info?.(`☁️ Démarrage du tunnel Cloudflare vers 127.0.0.1:${port}…`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    let proc;

    try {
      proc = spawnImpl(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(new Error(`tunnel impossible : ${err.message}`));
    }
    child = proc;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const onData = chunk => {
      output += String(chunk);
      const found = parseQuickTunnelUrl(output);
      if (found && !settled) {
        url = found;
        logger.info?.(`☁️ Tunnel public : ${found}`);
        finish(resolve, { url: found });
      }
    };

    proc.stdout?.on?.('data', onData);
    proc.stderr?.on?.('data', onData);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopQuickTunnel();
      reject(new Error(
        'tunnel Cloudflare : délai dépassé sans URL. Vérifie la connexion Internet (le tunnel ne nécessite ni compte ni domaine).',
      ));
    }, timeoutMs);

    proc.once?.('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child = null;
      reject(new Error(err?.code === 'ENOENT'
        ? 'cloudflared introuvable : laisse le téléchargement automatique activé ou renseigne CLOUDFLARED_PATH (voir ANTIVPN.md).'
        : err?.code === 'EACCES'
          ? `cloudflared présent (${binaryPath}) mais non exécutable : sur le serveur, lance « chmod +x ${binaryPath} » puis redémarre le bot.`
          : `tunnel Cloudflare : ${err.message}`));
    });

    proc.once?.('exit', code => {
      const wasCurrent = child === proc;
      const hadUrl = Boolean(url);
      if (wasCurrent) { child = null; url = null; }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const detail = output.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`cloudflared s'est arrêté (code ${code})${detail ? ` — ${detail}` : ''}`));
        return;
      }
      if (wasCurrent && hadUrl) onExit?.(code);
    });
  });
}

/**
 * Attend que le nom du tunnel soit résolu (propagation DNS des tunnels rapides).
 * @returns {Promise<boolean>} true si le nom répond avant la fin du délai.
 */
async function waitForDns(publicUrl, {
  attempts = 45,
  delayMs = 2_000,
  lookup = dns.promises.lookup,
  logger = console,
} = {}) {
  let host;
  try { host = new URL(publicUrl).hostname; } catch { return false; }
  for (let i = 0; i < attempts; i++) {
    try {
      await lookup(host);
      return true;
    } catch {
      if (i === 0) logger.info?.(`☁️ Propagation DNS du tunnel en cours (${host})…`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/** Arrête le tunnel (appelé à l'arrêt du bot). */
function stopQuickTunnel() {
  const current = child;
  child = null;
  url = null;
  if (!current) return;
  try { current.kill(); } catch { /* déjà terminé */ }
}

function tunnelUrl() { return url; }

module.exports = {
  startQuickTunnel,
  stopQuickTunnel,
  tunnelUrl,
  parseQuickTunnelUrl,
  isTunnelRequested,
  isTunnelDisabled,
  isLoopbackUrl,
  cloudflaredAsset,
  ensureExecutable,
  ensureCloudflared,
  waitForDns,
};
