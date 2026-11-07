'use strict';
// utils/mediaTools.js — Outils audio du module musique (l'alternative à Lavalink).
//
// Lavalink est un serveur Java séparé : il faut installer Java 17+, lancer un
// processus, ouvrir un port, configurer des plugins pour Spotify… Notre moteur
// s'appuie directement sur deux binaires autonomes :
//
//   • yt-dlp  — résolution/recherche (YouTube, SoundCloud, Bandcamp, liens
//               directs) et extraction du flux audio ;
//   • ffmpeg  — décodage/transcodage vers le PCM 48 kHz stéréo attendu par
//               Discord (et donc gain de volume, seek, sources mp3/aac…).
//
// Les deux sont téléchargés à la demande dans `bin/` (ignoré par git) : aucun
// Python, aucun Java, aucun serveur tiers. Tout le reste (file d'attente,
// panel, carte) est du code du bot.
//
// Les fonctions pures (assets par plateforme, normalisation d'un morceau,
// traduction des erreurs yt-dlp) sont testables sans réseau.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..', '..');
const BIN_DIR = process.env.MUSIC_BIN_DIR
  ? path.resolve(process.env.MUSIC_BIN_DIR)
  : path.join(ROOT, 'bin');

const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';

// Tailles minimales : un exécutable réel fait des dizaines de Mo. En dessous,
// c'est une page d'erreur HTML, un fichier tronqué ou une archive.
const MIN_BINARY_BYTES = { ytdlp: 2 * 1024 * 1024, ffmpeg: 8 * 1024 * 1024 };

// Signature d'un binaire exécutable (ELF, PE/MZ, Mach-O).
function looksLikeExecutable(buffer, platform = process.platform) {
  if (!buffer || buffer.length < 4) return false;
  if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return true; // ELF
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) return true; // PE (Windows)
  const magic = buffer.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic); // Mach-O
}

/** Le fichier téléchargé est-il un vrai exécutable ? (taille + signature) */
async function inspectBinaryFile(kind, filePath, platform = process.platform) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return { ok: false, reason: 'fichier illisible' }; }
  if (stat.size < (MIN_BINARY_BYTES[kind] || 1024 * 1024)) {
    return { ok: false, reason: `fichier trop petit (${stat.size} octets) — réponse HTML ou téléchargement tronqué` };
  }
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    if (!looksLikeExecutable(head, platform)) {
      return { ok: false, reason: 'ce n’est pas un exécutable (page HTML, archive ou fichier texte)' };
    }
  } finally {
    await handle?.close().catch(() => {});
  }
  return { ok: true, size: stat.size };
}

class MediaToolError extends Error {
  constructor(message, { kind = 'tool', details = null } = {}) {
    super(message);
    this.name = 'MediaToolError';
    this.kind = kind;         // tool | unavailable | network | input | empty
    this.details = details;
  }
}

// ─── Assets par plateforme (pur) ──────────────────────────────────────────────
// yt-dlp publie un exécutable autonome par plateforme. Windows ARM64 n'a pas
// d'asset dédié : l'exécutable x64 tourne sous l'émulation Windows.
function ytdlpAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') {
    // Un VPS ARM (Oracle, Hetzner ARM…) a besoin de l'asset aarch64 : le
    // binaire x86_64 est un ELF valide… qui refuse de démarrer.
    if (arch === 'arm64') return 'yt-dlp_linux_aarch64';
    if (arch === 'arm') return 'yt-dlp_linux_armv7l';
    return 'yt-dlp_linux';
  }
  return null;
}

function ffmpegAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'ffmpeg-win32-x64.gz';
  if (platform === 'darwin') return arch === 'arm64' ? 'ffmpeg-darwin-arm64.gz' : 'ffmpeg-darwin-x64.gz';
  if (platform === 'linux') {
    if (arch === 'arm64') return 'ffmpeg-linux-arm64.gz';
    if (arch === 'arm') return 'ffmpeg-linux-arm.gz';
    return 'ffmpeg-linux-x64.gz';
  }
  return null;
}

function binaryFileName(kind, platform = process.platform) {
  const base = kind === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp';
  return platform === 'win32' ? `${base}.exe` : base;
}

function downloadUrl(kind, platform = process.platform, arch = process.arch) {
  // Miroir d'entreprise / proxy : permet de contourner un GitHub bloqué par
  // l'hébergeur (fréquent en container) sans toucher au code.
  const override = kind === 'ytdlp' ? process.env.YTDLP_DOWNLOAD_URL : process.env.FFMPEG_DOWNLOAD_URL;
  if (override) return override;
  if (kind === 'ytdlp') {
    const asset = ytdlpAsset(platform, arch);
    return asset ? `${YTDLP_RELEASE}/${asset}` : null;
  }
  if (kind === 'ffmpeg') {
    const asset = ffmpegAsset(platform, arch);
    return asset ? `${FFMPEG_RELEASE}/${asset}` : null;
  }
  return null;
}

// ─── Erreurs yt-dlp → messages utilisateur (pur) ─────────────────────────────
const YTDLP_ERRORS = [
  { re: /Sign in to confirm|confirm you.?re not a bot|HTTP Error 403/i,
    message: 'YouTube demande une vérification pour cette vidéo. Réessaie avec un autre lien, ou mets à jour yt-dlp (`npm run music:setup`).' },
  { re: /Private video|this video is private/i, message: 'Cette vidéo est privée.' },
  { re: /members.?only|Join this channel/i, message: 'Cette vidéo est réservée aux membres de la chaîne.' },
  { re: /age.?restricted|confirm your age|inappropriate for some users/i,
    message: 'Cette vidéo est réservée aux adultes : YouTube refuse la lecture hors session connectée.' },
  { re: /Video unavailable|has been removed|does not exist|404/i, message: 'Vidéo indisponible (supprimée ou bloquée dans cette région).' },
  { re: /is live|live event will begin|Premieres in/i, message: 'Ce direct n’a pas encore commencé.' },
  { re: /Unsupported URL/i, message: 'Lien non pris en charge : colle un lien YouTube, SoundCloud ou Spotify, ou un titre à rechercher.' },
  { re: /ENOTFOUND|EAI_AGAIN|getaddrinfo|network|timed out|ETIMEDOUT/i,
    message: 'Réseau injoignable : impossible de contacter la source audio.' },
  { re: /playlist does not exist|This playlist is private/i, message: 'Playlist introuvable ou privée.' },
];

function friendlyYtDlpError(stderr = '') {
  const text = String(stderr || '');

  // Le binaire lui-même est en cause (fichier HTML, PE sous Linux, bit
  // d'exécution perdu…) : message actionnable plutôt qu'un « Syntax error ».
  if (/Syntax error|Exec format error|cannot execute binary|ENOEXEC|bad interpreter|Permission denied/i.test(text)) {
    return 'Le binaire yt-dlp est corrompu ou incompatible avec cet hôte. Il sera supprimé et réinstallé automatiquement : relance `/musique` (ou `npm run music:setup`).';
  }

  for (const entry of YTDLP_ERRORS) {
    if (entry.re.test(text)) return entry.message;
  }
  const firstError = text.split('\n').find(line => /ERROR/i.test(line));
  return firstError
    ? `Extraction impossible : ${firstError.replace(/^ERROR:\s*/i, '').slice(0, 180)}`
    : 'Extraction impossible : la source n’a rien renvoyé d’exploitable.';
}

// ─── Détection des entrées (pur) ─────────────────────────────────────────────
function isUrl(value = '') {
  return /^https?:\/\//i.test(String(value).trim());
}

function hostOf(value = '') {
  try { return new URL(String(value)).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function isSpotifyUrl(value = '') {
  return /(^|\.)spotify\.com$/i.test(hostOf(value));
}

function isPlaylistUrl(value = '') {
  const text = String(value);
  if (!isUrl(text)) return false;
  if (/[?&]list=/.test(text)) return true;
  if (/youtube\.com\/playlist/i.test(text)) return true;
  if (/soundcloud\.com\/[^/]+\/sets\//i.test(text)) return true;
  return false;
}

function detectSource(info = {}) {
  const key = String(info.extractor_key || info.extractor || '').toLowerCase();
  if (key.includes('youtube')) return 'youtube';
  if (key.includes('soundcloud')) return 'soundcloud';
  if (key.includes('spotify')) return 'spotify';
  if (key.includes('bandcamp')) return 'bandcamp';
  const host = hostOf(info.webpage_url || info.original_url || info.url || '');
  if (host.includes('youtu')) return 'youtube';
  if (host.includes('soundcloud')) return 'soundcloud';
  if (host.includes('spotify')) return 'spotify';
  if (host.includes('bandcamp')) return 'bandcamp';
  return 'other';
}

const SOURCE_LABEL = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  bandcamp: 'Bandcamp',
  other: 'Lien direct',
};

function sourceLabel(source) {
  return SOURCE_LABEL[source] || SOURCE_LABEL.other;
}

/**
 * YouTube sert les miniatures en WebP par défaut ; le décodeur canvas n'est pas
 * garanti sur tous les hôtes. On demande l'équivalent JPEG quand il existe.
 */
function preferJpeg(url) {
  const text = String(url || '');
  if (!/ytimg\.com/i.test(text)) return text;
  return text
    .replace('/vi_webp/', '/vi/')
    .replace(/\.webp(\?|$)/i, '.jpg$1');
}

/** Meilleure miniature disponible (on préfère un JPEG : le rendu canvas est plus sûr). */
function bestThumbnail(info = {}) {
  if (info.thumbnail) return preferJpeg(info.thumbnail);
  const list = Array.isArray(info.thumbnails) ? info.thumbnails.filter(t => t && t.url) : [];
  if (!list.length) return null;
  const jpg = [...list].reverse().find(t => /\.jpe?g(\?|$)/i.test(t.url));
  return preferJpeg((jpg || list[list.length - 1]).url);
}

/** Un morceau prêt pour la file : aucune référence à yt-dlp/DB, donc testable. */
function normalizeTrack(info = {}, { requesterId = null, requesterName = null } = {}) {
  const title = String(info.title || info.fulltitle || info.track || 'Sans titre').trim();
  let url = String(info.webpage_url || info.original_url || info.url || '').trim();
  // En mode « flat playlist », yt-dlp ne donne parfois que l'identifiant.
  if (!isUrl(url) && /^[\w-]{11}$/.test(String(info.id || ''))) {
    url = `https://www.youtube.com/watch?v=${info.id}`;
  }
  return {
    id: String(info.id || '').slice(0, 64),
    title: title.slice(0, 160),
    artist: String(info.uploader || info.channel || info.creator || info.artist || 'Artiste inconnu').slice(0, 120),
    duration: Math.max(0, Math.round(Number(info.duration) || 0)),
    url,
    thumbnail: bestThumbnail(info),
    source: detectSource(info),
    live: Boolean(info.is_live || info.live_status === 'is_live'),
    requesterId: requesterId || null,
    requesterName: requesterName || null,
    addedAt: Date.now(),
  };
}

// ─── Exécution des binaires ──────────────────────────────────────────────────
const probeCache = new Map();

const PROBE_TTL = 60 * 1000;

// Un probe lance un vrai processus : on le met en cache une minute. Sans ça,
// chaque `/musique` relançait `ffmpeg -version`, et chaque ouverture des
// réglages relançait les deux binaires.
function probe(cmd, args = ['--version']) {
  const key = `${cmd}::${args.join(' ')}`;
  const hit = probeCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let value = null;
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (res.status === 0) value = String(res.stdout || res.stderr || '').trim().split('\n')[0] || 'ok';
  } catch {
    value = null;
  }
  probeCache.set(key, { value, expires: Date.now() + PROBE_TTL });
  return value;
}

// ffmpeg n'accepte pas `--version` (il sort en erreur) : son drapeau est `-version`.
function versionArgs(kind) {
  return kind === 'ffmpeg' ? ['-version'] : ['--version'];
}

/** Version lisible d'un outil (ffmpeg → « 6.0-essentials_build… »). */
function probeTool(kind, cmd) {
  const output = probe(cmd, versionArgs(kind));
  if (!output) return null;
  if (kind === 'ffmpeg') {
    const match = /ffmpeg version (\S+)/i.exec(output);
    return match ? match[1] : output;
  }
  return output;
}

/**
 * Noms de binaires à chercher dans bin/, pour une plateforme donnée.
 * Un seul nom : tenter `yt-dlp.exe` sous Linux revient à exécuter un PE, et
 * c'est exactement le genre de fichier que provoquait « Syntax error » côté
 * hébergement (binaire Windows ou page HTML déposée dans bin/).
 */
function candidateNames(kind, platform = process.platform) {
  return [binaryFileName(kind, platform)];
}

function candidatePaths(kind, platform = process.platform) {
  return [...new Set(candidateNames(kind, platform))].map(name => path.join(BIN_DIR, name));
}

function isInsideBin(filePath) {
  try {
    const rel = path.relative(path.resolve(BIN_DIR), path.resolve(filePath));
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

function clearProbeCache() {
  probeCache.clear();
}

/**
 * Localise un outil VALIDE. Un fichier présent mais qui ne s'exécute pas n'est
 * jamais retourné : il est signalé dans `broken` pour être réparé.
 */
function locate(kind) {
  const envVar = kind === 'ytdlp' ? 'YTDLP_PATH' : 'FFMPEG_PATH';
  const fromEnv = process.env[envVar];
  const broken = [];

  if (fromEnv && fs.existsSync(fromEnv)) {
    const version = probeTool(kind, fromEnv);
    if (version) return { path: fromEnv, source: 'env', version, broken };
    broken.push({ path: fromEnv, reason: `${envVar} pointe vers un fichier qui ne s’exécute pas` });
  }

  for (const candidate of candidatePaths(kind)) {
    if (!fs.existsSync(candidate)) continue;
    const version = probeTool(kind, candidate);
    if (version) return { path: candidate, source: 'bin', version, broken };
    broken.push({ path: candidate, reason: 'présent mais ne s’exécute pas (corrompu, mauvais OS ou droit d’exécution manquant)' });
  }

  // Déjà installé globalement (winget, brew, apt…) : on le réutilise.
  const cmd = kind === 'ytdlp' ? 'yt-dlp' : 'ffmpeg';
  const version = probeTool(kind, cmd);
  if (version) return { path: cmd, source: 'path', version };
  return { path: null, source: null, broken };
}

async function downloadBinary(kind, { platform = process.platform, arch = process.arch } = {}) {
  const url = downloadUrl(kind, platform, arch);
  if (!url) {
    throw new MediaToolError(`Aucun binaire ${kind} disponible pour ${platform}/${arch}.`, { kind: 'unavailable' });
  }

  const dest = path.join(BIN_DIR, binaryFileName(kind, platform));
  const tmp = `${dest}.part`;
  await fsp.mkdir(BIN_DIR, { recursive: true });

  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    throw new MediaToolError(`Téléchargement impossible (${err.message}).`, { kind: 'network', details: err });
  }
  if (!response.ok || !response.body) {
    throw new MediaToolError(`Téléchargement refusé (HTTP ${response.status}).`, { kind: 'network' });
  }

  const body = Readable.fromWeb(response.body);
  try {
    if (url.endsWith('.gz')) {
      await pipeline(body, zlib.createGunzip(), fs.createWriteStream(tmp));
    } else {
      await pipeline(body, fs.createWriteStream(tmp));
    }

    const check = await inspectBinaryFile(kind, tmp, platform);
    if (!check.ok) {
      await fsp.unlink(tmp).catch(() => {});
      throw new MediaToolError(
        `Téléchargement de ${kind} invalide : ${check.reason}. Vérifie l’accès réseau de l’hébergeur, ou renseigne ${kind === 'ytdlp' ? 'YTDLP_DOWNLOAD_URL' : 'FFMPEG_DOWNLOAD_URL'}.`,
        { kind: 'network' },
      );
    }

    await fsp.rename(tmp, dest);
    if (platform !== 'win32') await fsp.chmod(dest, 0o755);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    if (err instanceof MediaToolError) throw err;
    throw new MediaToolError(`Téléchargement de ${kind} interrompu : ${err.message}`, { kind: 'network', details: err });
  }

  clearProbeCache();
  const version = probeTool(kind, dest);
  if (!version) {
    await fsp.unlink(dest).catch(() => {});
    throw new MediaToolError(
      `${kind} a été téléchargé mais ne peut pas s’exécuter sur cet hôte (droit d’exécution ou dossier monté en noexec).`,
      { kind: 'tool' },
    );
  }
  return dest;
}

const ensureCache = new Map();

async function ensureTool(kind, { download = true } = {}) {
  const found = locate(kind);
  if (found.path) {
    return { path: found.path, version: found.version, source: found.source };
  }

  // Fichier corrompu / déposé depuis un autre OS : on le retire (uniquement
  // dans bin/, jamais un binaire système de l'utilisateur) pour que la
  // réinstallation reparte proprement.
  const brokenHere = (found.broken || []).filter(entry => isInsideBin(entry.path));
  if (!download) {
    return {
      path: null, version: null, source: null,
      error: brokenHere.length ? 'présent mais invalide (corrompu ou non exécutable)' : 'absent',
      broken: found.broken || [],
    };
  }

  for (const entry of brokenHere) {
    await fsp.unlink(entry.path).catch(() => {});
    console.warn(`[musique] ${kind} invalide supprimé : ${entry.path}`);
  }
  if (brokenHere.length) {
    clearProbeCache();
    ensureCache.delete(kind);
  }
  if (ensureCache.has(kind)) {
    const cached = await ensureCache.get(kind).catch(() => null);
    if (cached?.path && fs.existsSync(cached.path)) return cached;
    ensureCache.delete(kind); // résultat périmé : le fichier a disparu entre-temps
  }

  const job = (async () => {
    const dest = await downloadBinary(kind);
    const version = probeTool(kind, dest);
    if (!version) {
      await fsp.unlink(dest).catch(() => {});
      throw new MediaToolError(`${kind} téléchargé mais inutilisable sur cet hôte.`, { kind: 'tool' });
    }
    return { path: dest, version, source: 'downloaded' };
  })();

  ensureCache.set(kind, job);
  try {
    return await job;
  } catch (err) {
    ensureCache.delete(kind); // un échec ne doit pas être définitif (réseau)
    return { path: null, version: null, source: null, error: err.message };
  }
}

/**
 * État des deux binaires. `download:true` les installe au premier usage.
 * @returns {Promise<{ ytdlp:object, ffmpeg:object, ready:boolean }>}
 */
async function ensureMediaTools({ download = true } = {}) {
  const [ytdlp, ffmpeg] = await Promise.all([
    ensureTool('ytdlp', { download }),
    ensureTool('ffmpeg', { download }),
  ]);
  return { ytdlp, ffmpeg, ready: Boolean(ytdlp.path && ffmpeg.path) };
}

async function requireTools() {
  const tools = await ensureMediaTools({ download: true });
  if (!tools.ready) {
    const detail = [tools.ytdlp.error, tools.ffmpeg.error].filter(Boolean).join(' · ');
    throw new MediaToolError(
      `Outils audio indisponibles${detail ? ` — ${detail}` : ''}. Lance \`npm run music:setup\` sur la machine du bot, puis réessaie.`,
      { kind: 'tool' },
    );
  }
  return tools;
}

/** Exécute yt-dlp et rend sa sortie (rejette avec un message lisible sinon). */
function runYtDlp(args, { timeoutMs = 30000, binary = null } = {}) {
  const exe = binary || locate('ytdlp').path;
  if (!exe) return Promise.reject(new MediaToolError('yt-dlp introuvable.', { kind: 'tool' }));

  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args, '--no-progress', '--no-colors', '--no-warnings'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* déjà terminé */ }
      finish(reject, new MediaToolError('La source met trop de temps à répondre (30 s).', { kind: 'network' }));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) { // garde-fou : jamais plus de 32 Mo en RAM
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(reject, new MediaToolError('Réponse trop volumineuse.', { kind: 'unavailable' }));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });

    child.on('error', err => finish(reject, new MediaToolError(`yt-dlp n’a pas pu démarrer : ${err.message}`, { kind: 'tool' })));
    child.on('close', code => {
      if (code === 0) return finish(resolve, { stdout, stderr });
      return finish(reject, new MediaToolError(friendlyYtDlpError(stderr), { kind: 'unavailable', details: stderr }));
    });
  });
}

function parseJsonOutput(raw = '') {
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }
}

// ─── Recherche / résolution ──────────────────────────────────────────────────
function buildSearchArgs(query, limit = 8) {
  const wanted = Number(limit);
  const safe = Number.isFinite(wanted) ? Math.max(1, Math.min(25, Math.round(wanted))) : 8;
  return ['-J', '--flat-playlist', '--no-playlist', `ytsearch${safe}:${query}`];
}

function tracksFromEntries(entries = [], requester = {}) {
  return entries
    .filter(entry => entry && (entry.title || entry.id))
    .map(entry => normalizeTrack(entry, requester));
}

async function searchTracks(query, { limit = 8, requesterId = null, requesterName = null, binary = null } = {}) {
  const clean = String(query || '').trim();
  if (!clean) throw new MediaToolError('Recherche vide.', { kind: 'input' });

  const { stdout } = await runYtDlp(buildSearchArgs(clean, limit), { binary });
  const [playlist] = parseJsonOutput(stdout);
  const entries = playlist?.entries || [];
  const tracks = tracksFromEntries(entries, { requesterId, requesterName });
  if (!tracks.length) throw new MediaToolError(`Aucun résultat pour « ${clean.slice(0, 80)} ».`, { kind: 'empty' });
  return tracks;
}

function looksLikeSpotifyTrack(url) {
  return /\/track\//i.test(String(url));
}

/** Spotify : sans clé API, l'oEmbed public donne titre/artiste/pochette ; on joue la correspondance YouTube. */
async function resolveSpotify(url, { requesterId = null, requesterName = null, binary = null } = {}) {
  if (!looksLikeSpotifyTrack(url)) {
    throw new MediaToolError(
      'Spotify : seuls les liens de **piste** sont pris en charge (album/playlist demande une clé API Spotify, que le bot n’a pas).',
      { kind: 'input' },
    );
  }
  let meta = null;
  try {
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
    if (res.ok) meta = await res.json();
  } catch { meta = null; }

  const title = meta?.title || 'Spotify';
  const artist = meta?.author_name || '';
  const [match] = await searchTracks(`${title} ${artist}`.trim(), {
    limit: 1, requesterId, requesterName, binary,
  });
  if (!match) throw new MediaToolError('Aucune correspondance jouable trouvée sur YouTube.', { kind: 'empty' });
  return {
    ...match,
    title: title.replace(/\s*[-–]\s*song.*$/i, '').slice(0, 160) || match.title,
    artist: artist.slice(0, 100) || match.artist,
    thumbnail: meta?.thumbnail_url || match.thumbnail,
    source: 'spotify',
    spotifyUrl: url,
  };
}

/**
 * Transforme une saisie libre en morceaux : lien direct, playlist, ou recherche.
 * @returns {Promise<{ kind:'track'|'tracks'|'playlist', tracks:object[] }>}
 */
async function resolveInput(input, { limit = 8, maxTracks = 100, requesterId = null, requesterName = null, binary = null } = {}) {
  const query = String(input || '').trim();
  if (!query) throw new MediaToolError('Indique un titre ou un lien.', { kind: 'input' });
  if (isUrl(query) && isSpotifyUrl(query)) {
    return { kind: 'track', tracks: [await resolveSpotify(query, { requesterId, requesterName, binary })] };
  }

  if (!isUrl(query)) {
    // Une saisie libre = LE meilleur résultat, pas les huit : sinon une simple
    // recherche empile huit versions du même titre dans la file. Pour plusieurs
    // morceaux, on passe une playlist (lien `list=` / `sets/`).
    const tracks = await searchTracks(query, { limit, requesterId, requesterName, binary });
    return { kind: 'track', tracks: tracks.slice(0, 1) };
  }

  const playlist = isPlaylistUrl(query);
  const args = playlist
    ? ['-J', '--flat-playlist', query]
    : ['-J', '--no-playlist', query];

  const { stdout } = await runYtDlp(args, { binary });
  const [info] = parseJsonOutput(stdout);
  if (!info) throw new MediaToolError('Lien illisible.', { kind: 'unavailable' });

  if (Array.isArray(info.entries)) {
    const entries = info.entries.filter(Boolean).slice(0, Math.max(1, maxTracks));
    const tracks = tracksFromEntries(entries, { requesterId, requesterName });
    if (!tracks.length) throw new MediaToolError('Cette playlist est vide ou inaccessible.', { kind: 'empty' });
    return { kind: 'playlist', tracks };
  }

  return { kind: 'track', tracks: [normalizeTrack(info, { requesterId, requesterName })] };
}

/** Autoplay : la « mix » YouTube du morceau courant, sans le morceau lui-même. */
async function relatedTracks(track, { limit = 10, requesterId = null, requesterName = null, binary = null } = {}) {
  if (!track?.id) return [];
  try {
    const { stdout } = await runYtDlp(
      ['-J', '--flat-playlist', `https://www.youtube.com/watch?v=${track.id}&list=RD${track.id}`],
      { binary, timeoutMs: 20000 },
    );
    const [info] = parseJsonOutput(stdout);
    const entries = (info?.entries || []).filter(entry => entry?.id !== track.id).slice(0, limit);
    return tracksFromEntries(entries, { requesterId, requesterName });
  } catch {
    return []; // l'autoplay est un bonus : jamais bloquant
  }
}

// ─── Flux audio ─────────────────────────────────────────────────────────────
/**
 * Chaîne de lecture : yt-dlp (flux source) → ffmpeg (PCM 48 kHz stéréo).
 * Le PCM part directement dans @discordjs/voice, qui l'encode en Opus avec
 * opusscript et applique le volume en direct.
 */
/**
 * Arguments yt-dlp pour diffuser l'audio sur stdout.
 * --socket-timeout : sans lui, une connexion YouTube figée bloque le flux
 * indéfiniment (le lecteur croit à un hoquet et finit par sauter le morceau).
 * --retries : une coupure réseau passagère est reprise, pas subie.
 */
function buildStreamArgs(url) {
  return [
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--quiet',
    '--socket-timeout', '15',
    '--retries', '5',
    '--fragment-retries', '5',
    '-o', '-',
    String(url),
  ];
}

/**
 * Arguments ffmpeg : PCM 48 kHz stéréo, exactement ce qu'attend @discordjs/voice.
 * `input` vaut soit le tube de yt-dlp (`pipe:0`), soit une URL CDN directe —
 * dans ce cas on demande à ffmpeg de se reconnecter tout seul : c'est lui qui
 * gère le réseau pendant toute la lecture du morceau.
 */
function buildFfmpegArgs(input = 'pipe:0') {
  const network = /^https?:\/\//i.test(input)
    ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']
    : [];
  return [
    '-hide_banner', '-loglevel', 'error',
    ...network,
    '-i', input,
    '-vn',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];
}

/**
 * Extrait l'URL CDN directe du flux audio (aucun média téléchargé : yt-dlp ne
 * fait que résoudre l'adresse). C'est ce qui permet de précharger le morceau
 * suivant pendant que le courant joue.
 * @returns {Promise<string|null>}
 */
async function extractStreamUrl(track, { ytdlpPath, timeoutMs = 25000 } = {}) {
  if (!track?.url) return null;
  try {
    const { stdout } = await runYtDlp(
      ['-f', 'bestaudio/best', '--no-playlist', '-g', track.url],
      { binary: ytdlpPath, timeoutMs },
    );
    const url = String(stdout).split('\n').map(l => l.trim()).find(l => /^https?:\/\//i.test(l));
    return url || null;
  } catch {
    // Le préchargement est une optimisation : on repartira sur le tube yt-dlp.
    return null;
  }
}

function createAudioPipeline(track, { ytdlpPath, ffmpegPath, directUrl = null }) {
  if (!ytdlpPath || !ffmpegPath) throw new MediaToolError('Binaires audio indisponibles.', { kind: 'tool' });
  if (!track?.url) throw new MediaToolError('Morceau sans lien jouable.', { kind: 'input' });

  let stderr = '';
  const capture = chunk => { stderr = (stderr + chunk).slice(-3000); };
  const spawnSafe = (cmd, args, stdio) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio });
    child.on('error', err => capture(`ERROR: ${err.message}`));
    return child;
  };

  if (directUrl) {
    // Chemin rapide : ffmpeg lit directement le CDN, plus de yt-dlp au milieu.
    const transcoder = spawnSafe(ffmpegPath, buildFfmpegArgs(directUrl), ['ignore', 'pipe', 'pipe']);
    transcoder.stderr.on('data', capture);
    return {
      stream: transcoder.stdout,
      direct: directUrl,
      process: { downloader: null, transcoder },
      stderrText: () => stderr.trim(),
      errorText: () => friendlyYtDlpError(stderr),
      failed: () => /ERROR|Invalid data|Server returned 4/i.test(stderr),
      kill: () => { try { transcoder.kill('SIGKILL'); } catch { /* ignore */ } },
    };
  }

  const downloader = spawnSafe(ytdlpPath, buildStreamArgs(track.url), ['ignore', 'pipe', 'pipe']);
  const transcoder = spawnSafe(ffmpegPath, buildFfmpegArgs(), ['pipe', 'pipe', 'pipe']);

  downloader.stdout.pipe(transcoder.stdin);
  downloader.stderr.on('data', capture);
  transcoder.stderr.on('data', capture);

  const onClose = () => { try { downloader.kill('SIGKILL'); } catch { /* déjà fini */ } };
  transcoder.stdout.once('close', onClose);

  // Évite un « unhandled error » si ffmpeg meurt avant la fin du pipe.
  downloader.stdout.on('error', () => {});
  transcoder.stdin.on('error', () => {});

  return {
    stream: transcoder.stdout,
    direct: null,
    process: { downloader, transcoder },
    stderrText: () => stderr.trim(),
    errorText: () => friendlyYtDlpError(stderr),
    // Une fin de flux accompagnée d'un vrai message d'erreur (et non d'un
    // simple « Broken pipe », normal quand le lecteur ferme le tube).
    failed: () => /ERROR/i.test(stderr) && !/Broken pipe|unable to write data|Conversion failed/i.test(stderr),
    kill: () => {
      try { downloader.kill('SIGKILL'); } catch { /* ignore */ }
      try { transcoder.kill('SIGKILL'); } catch { /* ignore */ }
    },
  };
}

module.exports = {
  BIN_DIR,
  MediaToolError,
  YTDLP_RELEASE,
  FFMPEG_RELEASE,
  ytdlpAsset,
  ffmpegAsset,
  binaryFileName,
  downloadUrl,
  friendlyYtDlpError,
  isUrl,
  isSpotifyUrl,
  isPlaylistUrl,
  hostOf,
  detectSource,
  sourceLabel,
  SOURCE_LABEL,
  bestThumbnail,
  preferJpeg,
  normalizeTrack,
  candidateNames,
  candidatePaths,
  isInsideBin,
  looksLikeExecutable,
  inspectBinaryFile,
  MIN_BINARY_BYTES,
  locate,
  probe,
  probeTool,
  clearProbeCache,
  PROBE_TTL,
  versionArgs,
  downloadBinary,
  ensureMediaTools,
  requireTools,
  runYtDlp,
  parseJsonOutput,
  buildSearchArgs,
  tracksFromEntries,
  searchTracks,
  resolveSpotify,
  resolveInput,
  relatedTracks,
  buildStreamArgs,
  buildFfmpegArgs,
  extractStreamUrl,
  createAudioPipeline,
};
