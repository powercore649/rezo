'use strict';
// utils/radioEngine.js — Moteur radio du bot.
//
// Architecture :
//   /radio ──► catalogue (radioStations) ──► session en mémoire
//                                            │
//                 ffmpeg (flux HTTP → PCM 48 kHz) ──► @discordjs/voice (Opus + UDP)
//                                            │
//                 métadonnées ICY (titre) ──► panneau (embed/select)
//
// Différence avec le module musique : il n’y a ni file, ni recherche, ni
// morceau à récupérer. Une radio, c’est un flux continu qu’on branche et qu’on
// surveille. D’où trois choix :
//   • ffmpeg lit directement l’URL (aucun yt-dlp au milieu) ;
//   • une coupure réseau est reprise automatiquement (3 tentatives, délai
//     croissant) au lieu de couper la radio ;
//   • le titre du morceau vient des métadonnées ICY du flux, avec un cache
//     partagé entre serveurs pour ne pas multiplier les connexions.
//
// Toutes les décisions d’accès (rôle DJ, salon vocal) sont dans ce module,
// pures et testables ; le panneau ne fait que l’affichage.

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus,
  VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType,
} = require('@discordjs/voice');
const { spawn } = require('child_process');

const { AttachmentBuilder } = require('discord.js');

const { RadioConfig, RadioProfile } = require('../models/Radio');
const stations = require('./radioStations');
const panel = require('./radioPanel');
const icy = require('./icyMeta');
const { clampVolume } = require('./musicQueue');
const { renderRadioCard, cardSignature, CARD_NAME, CARD_URL } = require('./radioCard');
const { canvasAvailable } = require('./canvasProbe');
const { createLevelMeter } = require('./audioLevels');

const PANEL_REFRESH_MS = 30 * 1000;   // rafraîchit « connecté depuis »
const TITLE_REFRESH_MS = 15 * 1000;   // interroge le titre en direct

// ── Carte temps réel ────────────────────────────────────────────────────────
// Une image toutes les 1,1 s, sans trou : 5 éditions par fenêtre de 5,5 s, donc
// 4,5 par 5 s, juste sous la limite Discord (5 / 5 s par message).
// Le rythme compte autant que la cadence : une image sautée toutes les cinq
// créait un à-coup visible, d’où le quota calé sur l’intervalle.
const CARD_DEFAULT_MS = 1100;
const CARD_BUCKET_MAX = 5;            // éditions autorisées…
const CARD_BUCKET_WINDOW_MS = 5500;   // …par fenêtre glissante
const NOTICE_TTL_MS = 15 * 1000;      // un message d’action reste affiché

function cardIntervalMs() {
  const raw = Number(process.env.RADIO_CARD_MS);
  if (Number.isFinite(raw) && raw >= 700) return raw;
  return CARD_DEFAULT_MS;
}

function cardsEnabled() {
  return process.env.RADIO_CARD !== '0' && process.env.MEDIA_CARDS !== '0';
}
const ALONE_LEAVE_MS = 45 * 1000;     // plus personne avec le bot
const MAX_MISSED_FRAMES = 3000;       // 60 s de silence tolérées (flux live)
const MAX_FAVORITES = 25;             // taille maximale d'un menu Discord
const MAX_HISTORY = 8;                // titres gardés pour le diagnostic

// Délais avant chaque tentative de reconnexion. Surchargeables pour les tests
// (sinon la suite attendrait 13 secondes pour vérifier la limite).
function reconnectDelays() {
  const raw = String(process.env.RADIO_RECONNECT_DELAYS_MS || '').trim();
  if (raw) {
    const list = raw.split(',').map(Number).filter(value => Number.isFinite(value) && value >= 0);
    if (list.length) return list;
  }
  return [1500, 4000, 8000];
}

/** @type {Map<string, object>} */
const sessions = new Map();

// ── Configuration & profils ────────────────────────────────────────────────
async function getOrCreateConfig(guildId) {
  let cfg = await RadioConfig.findOne({ guildId });
  if (!cfg) cfg = await RadioConfig.create({ guildId });
  return cfg;
}

async function getFavoriteIds(guildId, userId) {
  if (!guildId || !userId) return [];
  const doc = await RadioProfile.findOne({ guildId, userId });
  return (doc?.favorites || []).filter(id => Boolean(stations.getStation(id)));
}

async function favoriteStations(guildId, userId) {
  const ids = await getFavoriteIds(guildId, userId);
  return ids.map(id => stations.getStation(id)).filter(Boolean);
}

/**
 * Ajoute/retire une station des favoris personnels.
 * @returns {Promise<{ok:boolean, reason?:string, favorite?:boolean, station?:object, count?:number}>}
 */
async function toggleFavorite(guildId, userId, stationId) {
  const station = stations.getStation(stationId);
  if (!guildId || !userId) return { ok: false, reason: 'membre' };
  if (!station) return { ok: false, reason: 'station' };

  let doc = await RadioProfile.findOne({ guildId, userId });
  if (!doc) doc = await RadioProfile.create({ guildId, userId, favorites: [] });

  const favorites = Array.isArray(doc.favorites) ? doc.favorites : [];
  const has = favorites.includes(station.id);
  if (!has && favorites.length >= MAX_FAVORITES) {
    return { ok: false, reason: 'full', station, count: favorites.length };
  }
  doc.favorites = has ? favorites.filter(id => id !== station.id) : [...favorites, station.id];
  await doc.save();
  return { ok: true, favorite: !has, station, count: doc.favorites.length };
}

// ── Permissions (pur, testable) ─────────────────────────────────────────────
/**
 * Qui peut piloter la radio ? Mêmes règles que la musique, réécrites ici pour
 * que le module radio reste autonome (aucune dépendance circulaire).
 * @returns {{ ok:boolean, reason?:'dj'|'voice'|'novoice' }}
 */
function canControl(member, cfg = {}, { botChannelId = null } = {}) {
  if (!member) return { ok: false, reason: 'novoice' };

  const has = permission => Boolean(member.permissions?.has?.(permission));
  if (has('Administrator') || has('ManageGuild') || has('ManageChannels')) return { ok: true };

  if (cfg.djOnly && cfg.djRoleId) {
    const hasRole = Boolean(member.roles?.cache?.has?.(cfg.djRoleId));
    if (!hasRole) return { ok: false, reason: 'dj' };
  }

  if (botChannelId) {
    if (!member.voice?.channelId) return { ok: false, reason: 'novoice' };
    if (member.voice.channelId !== botChannelId) return { ok: false, reason: 'voice' };
  }
  return { ok: true };
}

// ── Session ────────────────────────────────────────────────────────────────
/** État de la carte animée : cadence, doublons évités, message ciblé. */
function freshCardState() {
  return {
    timer: null,
    inFlight: false,
    pending: false,
    signature: null,
    history: [],
    message: null,
  };
}

function emptySession(guildId) {
  return {
    guildId,
    station: null,
    connection: null,
    player: null,
    pipeline: null,
    resource: null,
    client: null,
    textChannelId: null,
    panelChannelId: null,
    panelMessageId: null,

    volume: 70,
    paused: false,
    startedAt: null,
    pausedAt: null,
    pausedMs: 0,
    listeningPublished: 0,

    seq: 0,
    reconnectAttempts: 0,
    reconnecting: false,
    reconnectTimer: null,
    manualStop: false,

    filter: stations.ALL_FILTER,
    nowPlaying: { title: null, at: 0 },
    polling: false,

    requesterId: null,
    tools: null,
    cfg: null,
    lastError: null,
    destroyed: false,
    voiceChannelId: null,

    notice: null,
    card: freshCardState(),
    levelMeter: null,

    // Minuteur d’extinction, historique des titres et santé du flux :
    // trois états que le panneau avancé affiche.
    sleep: { endAt: null, minutes: 0, timer: null },
    history: [],
    dropouts: 0,
    reconnects: 0,

    timers: { refresh: null, title: null, alone: null },
    // Point d'injection pour les tests : remplace ffmpeg par un flux factice.
    pipelineFactory: null,
  };
}

function getSession(guildId) {
  return sessions.get(guildId) || null;
}

async function ensureSession({ guild, textChannel = null, cfg = null, tools = null } = {}) {
  let session = sessions.get(guild.id);
  if (session) {
    if (textChannel) session.textChannelId = textChannel.id;
    if (tools) session.tools = tools;
    if (cfg) session.cfg = cfg;
    return session;
  }

  const config = cfg || await getOrCreateConfig(guild.id);
  session = emptySession(guild.id);
  session.client = guild.client || null;
  session.cfg = config;
  session.volume = clampVolume(config.defaultVolume, 70);
  session.textChannelId = textChannel?.id || null;
  session.tools = tools;
  sessions.set(guild.id, session);
  return session;
}

async function connectToVoice(session, guild, voiceChannel) {
  if (session.connection && session.voiceChannelId === voiceChannel.id) return session.connection;

  if (session.connection) {
    try { session.connection.destroy(); } catch { /* déjà fermée */ }
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  session.connection = connection;
  session.voiceChannelId = voiceChannel.id;

  connection.on('stateChange', (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]).catch(() => destroySession(session, { reason: 'déconnexion vocale' }));
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch (err) {
    throw new Error(`Connexion vocale impossible : ${err.message}`);
  }

  if (session.player) connection.subscribe(session.player);
  return connection;
}

function createPlayerFor(session) {
  if (session.player) return session.player;
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: MAX_MISSED_FRAMES },
  });
  session.player = player;
  session.connection?.subscribe?.(player);

  // Un flux radio ne se « termine » pas : c'est le tuyau ffmpeg qui décide.
  // On garde donc l'erreur pour le diagnostic, sans sauter de station.
  player.on('error', err => {
    session.lastError = err.message;
    console.error('❌ Radio (lecteur):', err.message);
  });
  player.on(AudioPlayerStatus.Idle, () => {
    if (session.destroyed || session.manualStop || !session.station) return;
    // Sécurité si le flux meurt sans événement de fin (très rare) : on laisse
    // les gestionnaires du tuyau faire leur travail, sinon on relance.
    if (!session.reconnecting && Date.now() - (session.startedAt || 0) > 1000) {
      handleStreamLoss(session, session.seq);
    }
  });

  return player;
}

// ── Flux audio ─────────────────────────────────────────────────────────────
/**
 * Arguments ffmpeg pour un flux radio : PCM 48 kHz stéréo sur stdout.
 * `-reconnect*` fait réessayer ffmpeg sur une micro-coupure HTTP ; `-rw_timeout`
 * évite qu'une socket morte bloque le flux pour toujours.
 */
function buildRadioFfmpegArgs(url) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
    '-icy', '1',
    '-user_agent', icy.USER_AGENT,
    '-i', String(url),
    '-vn',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];
}

/** Traduit stderr ffmpeg en message utile (pur). */
function friendlyRadioError(stderr = '') {
  const text = String(stderr || '');
  if (/404|not found/i.test(text)) return 'La station ne répond plus (flux introuvable, 404).';
  if (/403|forbidden/i.test(text)) return 'La station refuse la connexion depuis cet hébergement (403).';
  if (/invalid data|unknown input format|protocol not found/i.test(text)) return 'Flux illisible : format non pris en charge ou protégé.';
  if (/connection refused|timed out|timeout|network is unreachable|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return 'Réseau injoignable : la station ou l’hébergeur ne répond pas.';
  }
  const line = text.split('\n').map(value => value.trim()).filter(Boolean).pop();
  return line ? `Flux interrompu : ${line.slice(0, 160)}` : 'Flux interrompu.';
}

function createRadioPipeline(url, { ffmpegPath } = {}) {
  if (!ffmpegPath) throw new Error('ffmpeg introuvable — lance `npm run music:setup` sur la machine du bot.');

  let stderr = '';
  const child = spawn(ffmpegPath, buildRadioFfmpegArgs(url), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  child.on('error', err => { stderr += `ERROR: ${err.message}`; });
  child.stdout?.on('error', () => { /* tube fermé par le lecteur : normal */ });

  return {
    url,
    stream: child.stdout,
    process: child,
    stderrText: () => stderr.trim(),
    errorText: () => friendlyRadioError(stderr),
    failed: () => /error|invalid|forbidden|not found|4\d\d|5\d\d/i.test(stderr),
    kill: () => { try { child.kill('SIGKILL'); } catch { /* déjà terminé */ } },
  };
}

function killPipeline(session) {
  if (!session?.pipeline) return;
  try { session.pipeline.kill?.(); } catch { /* déjà fermé */ }
  session.pipeline = null;
}

/** Branche la fin/erreur du tuyau ffmpeg sur la reconnexion. */
function attachStreamEnd(session, pipeline, seq) {
  const stream = pipeline?.stream;
  if (!stream?.once) return;
  let fired = false;
  const onEnd = () => {
    if (fired) return;
    fired = true;
    if (session.destroyed || session.manualStop || seq !== session.seq) return;
    handleStreamLoss(session, seq);
  };
  stream.once('end', onEnd);
  stream.once('close', onEnd);
  stream.once('error', onEnd);
}

// ── Lecture ────────────────────────────────────────────────────────────────
async function startStation(session, station) {
  if (!session) throw new Error('Session radio absente.');
  if (!session.connection) throw new Error('Aucune connexion vocale active.');

  const tools = session.tools || await require('./mediaTools').requireTools();
  session.tools = tools;

  const sameStation = Boolean(session.station && station && session.station.id === station.id && session.startedAt);
  session.seq += 1;
  const seq = session.seq;
  killPipeline(session);
  session.manualStop = false;

  const factory = session.pipelineFactory || createRadioPipeline;
  const pipeline = factory(station.url, { ffmpegPath: tools.ffmpeg?.path });
  session.pipeline = pipeline;

  try {
    // Robinet d’analyse : le PCM passe intact vers Discord, mais on en profite
    // pour mesurer le spectre — c’est ce qui fait bouger la carte au rythme de
    // ce qui est réellement diffusé.
    const meter = createLevelMeter({ sampleRate: 48000, channels: 2 });
    const tap = meter.createTap();
    tap.on('error', () => { /* le tuyau s’arrête : la reconnexion s’en charge */ });
    pipeline.stream.pipe(tap);
    session.levelMeter = meter;

    const resource = createAudioResource(tap, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: { station },
    });
    resource.volume?.setVolume(Math.max(0, Math.min(2, session.volume / 100)));

    session.resource = resource;
    session.station = station;
    session.paused = false;
    session.pausedAt = null;
    session.nowPlaying = { title: null, at: 0 };
    if (!sameStation) {
      session.startedAt = Date.now();
      session.pausedMs = 0;
      session.listeningPublished = 0;
    }

    const player = createPlayerFor(session);
    attachStreamEnd(session, pipeline, seq);
    player.play(resource);
  } catch (err) {
    try { pipeline.kill?.(); } catch { /* déjà terminé */ }
    session.pipeline = null;
    throw err;
  }

  startTimers(session);
  recordStationPlay(session, station);
  pollNowPlaying(session).catch(() => {});
  return station;
}

/**
 * Démarre (ou change de) station : rejoint le vocal, coupe la musique si elle
 * occupait la même connexion, puis branche le flux.
 */
/**
 * Le lancement est-il autorisé dans ce salon ?
 * Un serveur peut restreindre la radio à des salons texte (où vit le panneau)
 * ou à des salons vocaux (là où le son sort) : les deux comptent.
 */
function channelAllowed(cfg, { textChannelId = null, voiceChannelId = null } = {}) {
  const allowed = Array.isArray(cfg?.channelIds) ? cfg.channelIds.filter(Boolean) : [];
  if (!allowed.length) return true;
  if (textChannelId && allowed.includes(textChannelId)) return true;
  if (voiceChannelId && allowed.includes(voiceChannelId)) return true;
  return false;
}

async function start({ guild, member, voiceChannel, textChannel = null, station, volume = null }) {
  if (!guild || !station) throw new Error('Station ou serveur manquant.');
  const cfg = await getOrCreateConfig(guild.id);
  if (!cfg.enabled) throw new Error('La radio est désactivée sur ce serveur (`/radio` → ⚙️ Réglages).');
  if (!channelAllowed(cfg, { textChannelId: textChannel?.id, voiceChannelId: voiceChannel?.id })) {
    const list = cfg.channelIds.map(id => `<#${id}>`).join(', ');
    throw new Error(`La radio est autorisée uniquement dans ${list}.`);
  }

  // Une seule connexion vocale par serveur : la dernière commande lancée prend
  // la main, proprement (le panneau musique repasse en « rien en lecture »).
  const musicEngine = require('./musicEngine');
  const musicSession = musicEngine.getSession(guild.id);
  if (musicSession) await musicEngine.destroySession(musicSession, { reason: 'radio', silent: true });

  const session = await ensureSession({ guild, textChannel, cfg });
  session.cfg = cfg;
  if (member?.id) session.requesterId = member.id;

  try {
    if (!session.connection || session.voiceChannelId !== voiceChannel.id) {
      await connectToVoice(session, guild, voiceChannel);
    }
    if (textChannel?.id) session.textChannelId = textChannel.id;
    session.volume = clampVolume(volume ?? session.volume, cfg.defaultVolume);

    await startStation(session, station);
    recordProfileListen(session, station);
    return { session, station };
  } catch (err) {
    // Un lancement raté sur une session neuve ne doit pas laisser une coquille
    // vide en mémoire (elle réapparaîtrait dans /radio comme un panneau fantôme).
    if (!session.panelMessageId && sessions.get(guild.id) === session) {
      sessions.delete(guild.id);
      session.destroyed = true;
      try { session.connection?.destroy(); } catch { /* déjà fermée */ }
    }
    throw err;
  }
}

async function switchStation(session, station) {
  if (!session || session.destroyed) return null;
  await startStation(session, station);
  await refreshPanel(session, { notice: `📻 **${station.name}** — ${station.tagline}` }).catch(() => {});
  recordProfileListen(session, station);
  return station;
}

function togglePause(session) {
  if (!session?.station || !session.player) return null;
  if (session.paused) {
    session.pausedMs += Math.max(0, Date.now() - (session.pausedAt || Date.now()));
    session.pausedAt = null;
    session.paused = false;
    session.player.unpause();
  } else {
    session.pausedAt = Date.now();
    session.paused = true;
    session.player.pause();
  }
  return session.paused;
}

function setVolume(session, value) {
  if (!session) return 0;
  const volume = clampVolume(value, session.volume);
  session.volume = volume;
  session.resource?.volume?.setVolume(Math.max(0, Math.min(2, volume / 100)));
  return volume;
}

function setFilter(session, filter) {
  if (!session) return stations.ALL_FILTER;
  session.filter = stations.isKnownGenre(filter) ? filter : stations.ALL_FILTER;
  return session.filter;
}

/** Durée réellement écoutée (les pauses ne comptent pas). */
function listeningSeconds(session, now = Date.now()) {
  if (!session?.startedAt) return 0;
  const end = session.paused ? (session.pausedAt || now) : now;
  return Math.max(0, Math.floor((end - session.startedAt - (session.pausedMs || 0)) / 1000));
}

// ── Reconnexion ────────────────────────────────────────────────────────────
function handleStreamLoss(session, seq) {
  if (!session || session.destroyed || session.manualStop) return null;
  if (seq != null && seq !== session.seq) return null;
  if (session.reconnecting) return null;

  const delays = reconnectDelays();
  const attempts = session.reconnectAttempts || 0;
  const error = session.pipeline?.errorText?.() || session.lastError || 'flux interrompu';
  session.lastError = error;
  session.dropouts = (session.dropouts || 0) + 1;

  if (attempts >= delays.length) {
    stop(session, { notice: `❌ Flux interrompu après ${delays.length} tentatives — ${panel.clip(error, 150)}` })
      .catch(err => console.error('❌ Radio (arrêt):', err.message));
    return null;
  }

  session.reconnecting = true;
  session.reconnectAttempts = attempts + 1;
  const attemptNumber = session.reconnectAttempts;
  refreshPanel(session, {
    notice: `🔁 Coupure du flux — reconnexion ${attemptNumber}/${delays.length}…`,
  }).catch(() => {});

  const delay = delays[Math.min(attempts, delays.length - 1)];
  session.reconnectTimer = setTimeout(async () => {
    session.reconnectTimer = null;
    if (session.destroyed || session.manualStop || seq !== session.seq) return;
    session.reconnecting = false;
    try {
      await startStation(session, session.station);
      session.reconnects = (session.reconnects || 0) + 1;
      // Un flux qui tient 30 secondes est considéré comme revenu : le compteur
      // d'échecs repart à zéro, sinon une station qui décroche une fois par
      // heure finirait coupée définitivement au bout de trois coupures.
      const healthySeq = session.seq;
      const healthyTimer = setTimeout(() => {
        if (!session.destroyed && session.seq === healthySeq && session.station) session.reconnectAttempts = 0;
      }, 30000);
      healthyTimer.unref?.();
      await refreshPanel(session, { notice: `✅ Flux rétabli (tentative ${attemptNumber}).` }).catch(() => {});
    } catch (err) {
      session.lastError = err.message;
      console.error('❌ Radio (reconnexion):', err.message);
      handleStreamLoss(session, session.seq);
    }
  }, Math.max(0, delay));
  session.reconnectTimer.unref?.();

  return attemptNumber;
}

// ── Timers ─────────────────────────────────────────────────────────────────
function clearTimer(session, key) {
  if (!session?.timers?.[key]) return;
  clearInterval(session.timers[key]);
  clearTimeout(session.timers[key]);
  session.timers[key] = null;
}

function startTimers(session) {
  clearTimer(session, 'refresh');
  session.timers.refresh = setInterval(() => {
    if (session.destroyed || !session.station) return;
    refreshPanel(session).catch(() => {});
  }, PANEL_REFRESH_MS);
  session.timers.refresh.unref?.();

  clearTimer(session, 'title');
  session.timers.title = setInterval(() => {
    pollNowPlaying(session).catch(() => {});
  }, TITLE_REFRESH_MS);
  session.timers.title.unref?.();
}

/** Interroge les métadonnées ICY et rafraîchit le panneau si le titre change. */
async function pollNowPlaying(session) {
  if (!session?.station || session.destroyed || session.polling) return null;
  if (session.cfg && session.cfg.showNowPlaying === false) return null;

  session.polling = true;
  const seq = session.seq;
  try {
    const info = await icy.cachedIcyTitle(session.station.url, { ttlMs: 12000, timeoutMs: 6000 });
    if (session.destroyed || session.seq !== seq || !session.station) return null;
    const title = info?.ok ? info.title : null;
    if (title && title !== session.nowPlaying.title) {
      session.nowPlaying = { title, at: Date.now() };
      pushTitleHistory(session, title);
      await refreshPanel(session).catch(() => {});
    }
    return title;
  } finally {
    session.polling = false;
  }
}

// ── Statistiques ───────────────────────────────────────────────────────────
function recordStationPlay(session, station) {
  if (!session?.guildId || !station) return;
  RadioConfig.updateOne(
    { guildId: session.guildId },
    {
      $inc: { 'stats.stationPlays': 1 },
      $set: { 'stats.lastPlayedAt': new Date(), 'stats.lastStationId': station.id },
    },
  ).catch(() => { /* statistiques non bloquantes */ });
}

function recordProfileListen(session, station) {
  if (!session?.guildId || !session.requesterId || !station) return;
  RadioProfile.updateOne(
    { guildId: session.guildId, userId: session.requesterId },
    {
      $inc: { listens: 1 },
      $set: { lastStationId: station.id, lastListenedAt: new Date() },
    },
    { upsert: true },
  ).catch(() => { /* non bloquant */ });
}

function recordSessionStats(session, seconds) {
  if (!session?.guildId || !(seconds > 0)) return;
  RadioConfig.updateOne(
    { guildId: session.guildId },
    { $inc: { 'stats.secondsPlayed': seconds } },
  ).catch(() => {});
  if (session.requesterId) {
    RadioProfile.updateOne(
      { guildId: session.guildId, userId: session.requesterId },
      { $inc: { secondsPlayed: seconds }, $set: { lastListenedAt: new Date() } },
      { upsert: true },
    ).catch(() => {});
  }
}

// ── Arrêt ──────────────────────────────────────────────────────────────────
async function stop(session, { notice = null, silent = false } = {}) {
  if (!session || session.destroyed) return null;
  const seconds = listeningSeconds(session);

  clearTimer(session, 'refresh');
  clearTimer(session, 'title');
  clearTimer(session, 'alone');
  clearSleepTimer(session);
  stopCardLoop(session);
  if (session.card) session.card.signature = null;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  session.manualStop = true;
  session.seq += 1;
  killPipeline(session);
  try { session.player?.stop(true); } catch { /* déjà arrêté */ }

  session.station = null;
  session.paused = false;
  session.pausedAt = null;
  session.startedAt = null;
  session.nowPlaying = { title: null, at: 0 };
  session.reconnectAttempts = 0;
  session.levelMeter = null;
  sessions.delete(session.guildId);

  // Un panneau affiché ne doit jamais continuer à annoncer « en direct » quand
  // plus rien ne joue — y compris pour un arrêt silencieux (vocal quitté,
  // salon vidé) : le panneau est le seul endroit où l’état est lisible.
  if (session.panelMessageId || !silent) {
    await refreshPanel(session, {
      notice: notice || '⏹️ Radio arrêtée — le salon vocal a été libéré.',
    }).catch(() => {});
  }

  session.destroyed = true;
  try { session.connection?.destroy(); } catch { /* déjà fermée */ }
  recordSessionStats(session, seconds);
  return seconds;
}

async function destroySession(session, { reason = 'arrêt', silent = true, notice = null } = {}) {
  if (!session || session.destroyed) return;
  await stop(session, { silent, notice });
  if (!silent && reason) console.log(`[radio] session fermée (${reason}) — serveur ${session.guildId}`);
}

// ── Vocal : personne avec le bot ───────────────────────────────────────────
function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState?.guild || oldState?.guild;
  const session = sessions.get(guild?.id);
  if (!session?.connection) return;

  const botId = newState?.client?.user?.id;
  if (newState?.id === botId) {
    if (!newState.channelId) {
      destroySession(session, {
        reason: 'déconnecté du vocal',
        silent: true,
        notice: '👋 J’ai été déconnecté du salon vocal : la radio s’arrête.',
      }).catch(() => {});
    } else {
      session.voiceChannelId = newState.channelId;
    }
    return;
  }

  const botChannelId = session.voiceChannelId || session.connection.joinConfig?.channelId;
  const channel = guild.channels?.cache?.get?.(botChannelId);
  const humans = channel?.members ? channel.members.filter(member => !member.user.bot).size : 0;

  if (humans === 0) {
    clearTimer(session, 'alone');
    session.timers.alone = setTimeout(() => {
      if (session.destroyed) return;
      const check = guild.channels?.cache?.get?.(session.voiceChannelId);
      const stillAlone = !check?.members || check.members.filter(member => !member.user.bot).size === 0;
      if (stillAlone) {
        destroySession(session, {
          reason: 'salon vide',
          silent: true,
          notice: '👋 Plus personne dans le salon vocal : je libère la connexion.',
        }).catch(() => {});
      }
    }, ALONE_LEAVE_MS);
    session.timers.alone.unref?.();
  } else {
    clearTimer(session, 'alone');
  }
}

// ── Panneau ────────────────────────────────────────────────────────────────
// ── Minuteur d’extinction ──────────────────────────────────────────────────
/**
 * Programme l’arrêt de la radio dans `minutes`. Un seul minuteur par session :
 * en armer un nouveau remplace l’ancien. Il vit dans la session, donc un
 * changement de station ne le remet pas à zéro, mais l’arrêt le coupe.
 */
function setSleepTimer(session, minutes) {
  if (!session || session.destroyed) return null;
  clearSleepTimer(session);
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return null;

  const delay = value * 60 * 1000;
  const sleep = { endAt: Date.now() + delay, minutes: value, timer: null };
  sleep.timer = setTimeout(() => {
    sleep.timer = null;
    if (session.destroyed) return;
    stop(session, { notice: '⏰ Minuteur terminé — radio arrêtée, salon vocal libéré.' })
      .catch(err => console.error('❌ Radio (minuteur):', err.message));
  }, delay);
  sleep.timer.unref?.();
  session.sleep = sleep;
  return sleep;
}

function clearSleepTimer(session) {
  const sleep = session?.sleep;
  // On répond « vrai » seulement s’il y avait réellement quelque chose à
  // couper : sans ça, le bouton Annuler annoncerait une annulation fantôme.
  const had = Boolean(sleep && (sleep.timer || Number(sleep.endAt) > 0));
  if (sleep?.timer) clearTimeout(sleep.timer);
  if (session) session.sleep = { endAt: null, minutes: 0, timer: null };
  return had;
}

function sleepRemainingMs(session, now = Date.now()) {
  const endAt = Number(session?.sleep?.endAt) || 0;
  return Math.max(0, endAt - now);
}

function sleepRemainingMinutes(session, now = Date.now()) {
  return Math.ceil(sleepRemainingMs(session, now) / 60000);
}

// ── Auditeurs, historique, diagnostic ──────────────────────────────────────
/**
 * Liste des membres d’un salon, que `members` soit une Collection Discord
 * (`.values()`), un tableau ou une simple Map : le calcul reste le même et
 * testable sans client réel.
 */
function memberListOf(members) {
  if (!members) return null;
  if (Array.isArray(members)) return members;
  if (typeof members.values === 'function') return Array.from(members.values());
  return [];
}

/** Combien de personnes (hors bots) sont dans le salon vocal du bot. */
function listenerCount(session) {
  const channelId = session?.voiceChannelId || session?.connection?.joinConfig?.channelId;
  if (!channelId) return null;
  const client = session?.client;
  const guild = client?.guilds?.cache?.get?.(session.guildId);
  const channel = guild?.channels?.cache?.get?.(channelId)
    || client?.channels?.cache?.get?.(channelId);
  const members = memberListOf(channel?.members);
  if (!members) return null;
  return members.filter(member => !member.user?.bot).length;
}

/** Historique borné des titres relevés, du plus récent au plus ancien. */
function pushTitleHistory(session, title) {
  const value = String(title || '').trim();
  if (!session || !value) return [];
  const list = Array.isArray(session.history) ? session.history : [];
  if (list[0]?.title === value) return list;
  session.history = [{ title: value, at: Date.now() }, ...list].slice(0, MAX_HISTORY);
  return session.history;
}

/** Tout ce qu’affiche la vue 📊 Diagnostic, en un objet pur (testable). */
function diagnosticsOf(session) {
  if (!session) return null;
  const remaining = sleepRemainingMs(session);
  return {
    station: session.station || null,
    voiceChannelId: session.voiceChannelId || null,
    listeners: listenerCount(session),
    elapsed: listeningSeconds(session),
    paused: Boolean(session.paused),
    volume: session.volume ?? 70,
    reconnects: session.reconnects || 0,
    dropouts: session.dropouts || 0,
    reconnectAttempts: session.reconnectAttempts || 0,
    lastError: session.lastError || null,
    nowPlaying: session.nowPlaying?.title || null,
    sleepMinutes: remaining > 0 ? Math.ceil(remaining / 60000) : 0,
    history: Array.isArray(session.history) ? session.history.slice(0, MAX_HISTORY) : [],
  };
}

function snapshotOf(session) {
  const station = session?.station || null;
  return {
    station,
    stationId: station?.id || null,
    paused: Boolean(session?.paused),
    volume: session?.volume ?? 70,
    connectedFor: listeningSeconds(session),
    nowPlaying: session?.nowPlaying?.title || null,
    showNowPlaying: session?.cfg?.showNowPlaying !== false,
    filter: session?.filter || stations.ALL_FILTER,
    hasSession: Boolean(session),
    listeners: listenerCount(session),
    sleepMinutes: sleepRemainingMinutes(session),
    flow: {
      reconnects: session?.reconnects || 0,
      dropouts: session?.dropouts || 0,
      error: session?.lastError || null,
    },
  };
}

/**
 * Un message d’action (volume, pause, station) ne doit pas disparaître à la
 * première image suivante : on le garde quelques secondes côté session.
 */
function resolveNotice(session, notice) {
  if (!session) return notice || null;
  if (notice) session.notice = { text: String(notice), until: Date.now() + NOTICE_TTL_MS };
  const current = session.notice;
  if (!current) return null;
  if (current.until <= Date.now()) {
    session.notice = null;
    return null;
  }
  return current.text;
}

/** Instantané réduit à ce que dessine la carte. */
function cardSnapshotOf(session) {
  // Les niveaux réels ne sont transmis qu’une fois quelques blocs analysés :
  // au tout début (ou sans PCM), la carte retombe sur son onde d’attente
  // plutôt que d’afficher des barres à zéro.
  const meter = session?.levelMeter;
  const live = meter && typeof meter.frames === 'function' && meter.frames() > 2;

  return {
    station: session?.station || null,
    title: session?.nowPlaying?.title || null,
    paused: Boolean(session?.paused),
    volume: session?.volume ?? 70,
    elapsed: listeningSeconds(session),
    showNowPlaying: session?.cfg?.showNowPlaying !== false,
    levels: live ? Array.from(meter.levels()) : null,
  };
}

/** Rendu de la carte, ou null si l’hôte ne sait pas dessiner. */
async function renderCardBuffer(session) {
  if (!cardsEnabled()) return null;
  if (!(await canvasAvailable())) return null;
  try {
    return await renderRadioCard(cardSnapshotOf(session));
  } catch (err) {
    console.warn('⚠️ Radio (carte):', err.message);
    return null;
  }
}

async function buildPanelPayload(session, { guild = null, notice = null } = {}) {
  const snapshot = snapshotOf(session);
  const embed = panel.playerEmbed({
    ...snapshot,
    guildName: guild?.name || null,
    notice: resolveNotice(session, notice),
  });

  const files = [];
  const card = await renderCardBuffer(session);
  if (card) {
    embed.setImage(CARD_URL);
    files.push(new AttachmentBuilder(card, { name: CARD_NAME }));
  }

  // Un panneau déjà posté repart en boucle même si personne ne le touche :
  // c’est ce qui rend l’image vivante entre deux interactions.
  if (session?.station && session.panelMessageId) startCardLoop(session);

  return {
    embeds: [embed],
    components: panel.playerComponents({
      station: snapshot.station,
      paused: snapshot.paused,
      filter: snapshot.filter,
      hasSession: Boolean(session),
    }),
    files,
  };
}

async function resolvePanelChannel(session) {
  const id = session.panelChannelId || session.textChannelId;
  if (!id || !session.client) return null;
  const cached = session.client.channels?.cache?.get?.(id);
  if (cached) return cached;
  try { return await session.client.channels.fetch(id); } catch { return null; }
}

/**
 * Met à jour LE panneau du serveur. Ne crée jamais de doublon : hors `force`,
 * un panneau supprimé n'est pas recréé par les rafraîchissements automatiques
 * (sinon un salon où le message a été effacé se remplirait toutes les 30 s).
 */
async function refreshPanel(session, { notice = null, force = false } = {}) {
  if (!session || session.destroyed) return null;
  if (!session.panelMessageId && !force) return null;

  const channel = await resolvePanelChannel(session);
  if (!channel?.send) return null;

  const payload = await buildPanelPayload(session, { guild: channel.guild || null, notice });

  if (session.panelMessageId) {
    try {
      const message = await channel.messages.fetch(session.panelMessageId);
      await message.edit(payload);
      if (session.card) session.card.message = message;
      return message;
    } catch { /* message supprimé : recréé seulement sur action explicite */ }
  }
  if (!force) return null;

  try {
    const message = await channel.send(payload);
    attachPanel(session, message, channel.id);
    return message;
  } catch (err) {
    console.warn('⚠️ Radio (panneau):', err.message);
    return null;
  }
}

/**
 * Referme le panneau : la carte cesse d’être éditée et le message est oublié,
 * pour que le prochain `/radio` en reposte un neuf au lieu d’éditer un message
 * que l’utilisateur a fermé.
 */
function detachPanel(session) {
  if (!session) return;
  stopCardLoop(session);
  session.panelMessageId = null;
  session.panelChannelId = null;
  if (session.card) {
    session.card.message = null;
    session.card.signature = null;
    session.card.history = [];
  }
}

function attachPanel(session, message, channelId) {
  if (!session || !message) return;
  session.panelMessageId = message.id;
  session.panelChannelId = channelId || message.channelId || session.textChannelId;
  if (!session.card) session.card = freshCardState();
  session.card.message = message;
  startCardLoop(session);
}

// ── Carte temps réel ────────────────────────────────────────────────────────
// Une édition par image, jamais deux en vol : si une image met du temps, les
// suivantes sont fusionnées en une seule (`pending`), ce qui évite la file de
// requêtes qui rend les panneaux « en retard » sur le direct.
function cardState(session) {
  if (!session.card) session.card = freshCardState();
  return session.card;
}

function cardBudget(session, now = Date.now()) {
  const state = cardState(session);
  state.history = state.history.filter(at => now - at < CARD_BUCKET_WINDOW_MS);
  if (state.history.length >= CARD_BUCKET_MAX) return false;
  state.history.push(now);
  return true;
}

async function panelMessageOf(session) {
  const state = cardState(session);
  if (state.message?.edit) return state.message;
  const channel = await resolvePanelChannel(session);
  if (!channel?.messages || !session.panelMessageId) return null;
  try {
    const message = await channel.messages.fetch(session.panelMessageId);
    state.message = message;
    return message;
  } catch {
    return null;
  }
}

/**
 * Envoie une image. On n’envoie que l’embed et le fichier : les composants
 * restent ceux du dernier rafraîchissement complet, donc les boutons ne
 * clignotent pas à chaque image.
 */
async function pushCard(session) {
  const message = await panelMessageOf(session);
  if (!message?.edit) return null;

  const channel = await resolvePanelChannel(session);
  const payload = await buildPanelPayload(session, { guild: channel?.guild || null });
  if (!payload.files.length) return null;

  try {
    const edited = await message.edit({ embeds: payload.embeds, files: payload.files });
    cardState(session).message = edited;
    return edited;
  } catch (err) {
    session.lastError = err.message;
    // Message supprimé (10008) ou permissions perdues (50001/50013) : la boucle
    // s’arrête au lieu de marteler l’API. Une erreur passagère, elle, ne doit
    // pas figer la carte pour le reste de la session.
    const fatal = err.code === 10008 || err.code === 50001 || err.code === 50013
      || /unknown message|missing (access|permissions)/i.test(err.message || '');
    if (fatal) stopCardLoop(session);
    return null;
  }
}

/**
 * Une image si nécessaire. `force` sert aux actions (changement de station,
 * volume, pause) : elles doivent apparaître immédiatement, pas au tick suivant.
 */
async function scheduleCard(session, { force = false } = {}) {
  if (!session || session.destroyed || !session.station) return null;
  if (!session.panelMessageId || !cardsEnabled()) return null;

  const state = cardState(session);
  if (state.inFlight) {
    state.pending = true;
    return null;
  }

  const signature = cardSignature(cardSnapshotOf(session));
  // Signature identique = image identique (pause, silence, morceau tenu) :
  // inutile d’envoyer un octet de plus.
  if (!force && signature === state.signature) return null;
  if (!cardBudget(session)) return null;

  state.inFlight = true;
  try {
    const message = await pushCard(session);
    if (message) state.signature = signature;
    return message;
  } finally {
    state.inFlight = false;
    if (state.pending) {
      state.pending = false;
      if (state.timer) {
        const timer = setTimeout(() => scheduleCard(session, { force: true }).catch(() => {}), 80);
        timer.unref?.();
      }
    }
  }
}

function startCardLoop(session) {
  if (!session || session.destroyed || !session.station) return null;
  if (!session.panelMessageId || !cardsEnabled()) return null;
  const state = cardState(session);
  if (state.timer) return state.timer;

  state.timer = setInterval(() => {
    if (session.destroyed || !session.station) {
      stopCardLoop(session);
      return;
    }
    scheduleCard(session).catch(() => {});
  }, cardIntervalMs());
  state.timer.unref?.();
  return state.timer;
}

function stopCardLoop(session) {
  if (!session?.card?.timer) return;
  clearInterval(session.card.timer);
  session.card.timer = null;
}

async function panelPayloadForGuild(guild, { notice = null, filter = null } = {}) {
  const cfg = await getOrCreateConfig(guild.id);
  const ghost = emptySession(guild.id);
  ghost.cfg = cfg;
  ghost.volume = clampVolume(cfg.defaultVolume, 70);
  if (filter) ghost.filter = stations.isKnownGenre(filter) ? filter : stations.ALL_FILTER;
  return buildPanelPayload(ghost, { guild, notice });
}

async function configPanelForGuild(guild, { notice = null, stationTest = null } = {}) {
  const cfg = await getOrCreateConfig(guild.id);
  return {
    cfg,
    payload: {
      embeds: [panel.configEmbed(cfg, { notice, guildName: guild?.name || null, stationTest })],
      components: panel.configComponents(cfg),
    },
  };
}

module.exports = {
  // sessions
  sessions,
  getSession,
  ensureSession,
  emptySession,
  getOrCreateConfig,
  canControl,
  channelAllowed,
  // lecture
  start,
  switchStation,
  startStation,
  togglePause,
  setVolume,
  setFilter,
  setSleepTimer,
  clearSleepTimer,
  sleepRemainingMs,
  sleepRemainingMinutes,
  listenerCount,
  memberListOf,
  pushTitleHistory,
  diagnosticsOf,
  stop,
  destroySession,
  handleStreamLoss,
  handleVoiceStateUpdate,
  listeningSeconds,
  // flux
  buildRadioFfmpegArgs,
  createRadioPipeline,
  friendlyRadioError,
  reconnectDelays,
  // favoris
  toggleFavorite,
  getFavoriteIds,
  favoriteStations,
  MAX_FAVORITES,
  MAX_HISTORY,
  // affichage
  snapshotOf,
  cardSnapshotOf,
  buildPanelPayload,
  panelPayloadForGuild,
  refreshPanel,
  attachPanel,
  detachPanel,
  configPanelForGuild,
  // carte temps réel
  scheduleCard,
  startCardLoop,
  stopCardLoop,
  cardIntervalMs,
  cardsEnabled,
  // alive tests / statistiques
  pollNowPlaying,
  recordSessionStats,
  PANEL_REFRESH_MS,
  TITLE_REFRESH_MS,
  ALONE_LEAVE_MS,
  MAX_MISSED_FRAMES,
};
