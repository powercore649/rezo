'use strict';
// utils/musicEngine.js — Moteur musique du bot (sans Lavalink).
//
// Architecture :
//   /musique ──► resolveInput (yt-dlp) ──► MusicQueue (mémoire)
//                                          │
//                        createAudioPipeline (yt-dlp → ffmpeg → PCM)
//                                          │
//                              @discordjs/voice (Opus + UDP)
//
// Aucun serveur externe : pas de Lavalink, pas de Java, pas de compte spotify.
// Le prix à payer est assumé : la file vit en mémoire (un redémarrage la vide)
// et les binaires yt-dlp/ffmpeg doivent être présents (installés à la demande
// dans `bin/`, voir utils/mediaTools.js).

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus,
  VoiceConnectionStatus, entersState, NoSubscriberBehavior, StreamType,
} = require('@discordjs/voice');
const { AttachmentBuilder } = require('discord.js');

const MusicConfig = require('../models/Music');
const { MusicQueue, clampVolume, formatTime } = require('./musicQueue');
const {
  requireTools, ensureMediaTools, resolveInput, relatedTracks, createAudioPipeline, extractStreamUrl,
} = require('./mediaTools');
const { renderMusicCard } = require('./musicCard');
const { canvasAvailable } = require('./canvasProbe');
const { playerEmbed, playerComponents, queueEmbed, queueComponents, configEmbed, configComponents } = require('./musicPanel');
const guard = require('./playbackGuard');
const IDLE_DISCONNECT_MS = 2 * 60 * 1000;   // file vide → on libère le vocal
const ALONE_DISCONNECT_MS = 45 * 1000;      // plus personne avec le bot
const REFRESH_MS = 20 * 1000;               // rafraîchissement de la carte
const MAX_CONSECUTIVE_ERRORS = 3;
// @discordjs/voice stoppe le lecteur après `maxMissedFrames` lectures vides.
// À 250 (= 5 s) le moindre hoquet de YouTube faisait sauter le morceau. On
// tolère 60 s de silence : c'est notre propre détection de fin de flux qui
// enchaîne, pas l'underrun. Le garde-fou reste là pour un flux vraiment mort.
const MAX_MISSED_FRAMES = 3000;
// Laisse sortir les derniers paquets PCM déjà bufferisés avant d'enchaîner.
const TRACK_TAIL_MS = 400;

/** @type {Map<string, object>} */
const sessions = new Map();

// ─── Préchargement des morceaux ─────────────────────────────────────────────
// Extraire un flux YouTube coûte 5 à 8 secondes : c'est le seul moment où le
// bot reste muet. On extrait donc l'URL du morceau SUIVANT pendant que le
// courant joue. L'enchaînement tombe alors à ~0,4 s au lieu de ~7 s, et le
// premier morceau démarre pendant que la connexion vocale s'établit.
const streamUrls = new Map();          // clé morceau → { url, expires }
const STREAM_URL_TTL = 25 * 60 * 1000; // une URL CDN reste valide bien plus longtemps
const PREFETCH_WAIT_MS = 2000;

function setStreamUrl(key, url, ttl = STREAM_URL_TTL) {
  if (!key || !url) return;
  // Un bot qui tourne des semaines ne doit pas accumuler les URLs : on purge
  // les entrées expirées, et la plus ancienne si la table est encore pleine.
  if (streamUrls.size >= 300) {
    for (const [k, v] of streamUrls) if (v.expires <= Date.now()) streamUrls.delete(k);
    if (streamUrls.size >= 300) streamUrls.delete(streamUrls.keys().next().value);
  }
  streamUrls.set(key, { url, expires: Date.now() + ttl });
}

function getStreamUrl(key) {
  const hit = key ? streamUrls.get(key) : null;
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    streamUrls.delete(key);
    return null;
  }
  return hit.url;
}

function invalidateStreamUrl(key) {
  if (key) streamUrls.delete(key);
}

function clearStreamUrlCache() {
  streamUrls.clear();
}

/** Lance (une seule fois) l'extraction du prochain morceau, en arrière-plan. */
function prefetchUpcoming(session) {
  const next = session?.queue?.upcoming?.[0];
  const ytdlpPath = session?.tools?.ytdlp?.path;
  if (!next || !ytdlpPath) return null;

  const key = guard.trackKey(next);
  if (!key || getStreamUrl(key)) return null;
  if (session.prefetch?.key === key) return session.prefetch.promise;

  const promise = extractStreamUrl(next, { ytdlpPath })
    .then(url => {
      if (url) setStreamUrl(key, url);
      return url;
    })
    .catch(() => null);

  session.prefetch = { key, promise };
  return promise;
}

/** URL déjà prête pour ce morceau (ou préchargement en cours qu'on attend un peu). */
async function resolveDirectUrl(session, track) {
  const key = guard.trackKey(track);
  if (!key) return null;

  const cached = getStreamUrl(key);
  if (cached) return cached;

  const pending = session.prefetch;
  if (pending?.key === key) {
    const timeout = new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), PREFETCH_WAIT_MS);
      timer.unref?.();
    });
    const url = await Promise.race([pending.promise, timeout]);
    if (url) return url;
  }
  return null;
}

// ─── Configuration ──────────────────────────────────────────────────────────
async function getOrCreateConfig(guildId) {
  let cfg = await MusicConfig.findOne({ guildId });
  if (!cfg) cfg = await MusicConfig.create({ guildId });
  return cfg;
}

// ─── Permissions (pur, testable) ─────────────────────────────────────────────
/**
 * Qui peut piloter la lecture ?
 * @param {GuildMember} member
 * @param {object} cfg      configuration musique du serveur
 * @param {{ botChannelId?: string|null }} ctx
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

// ─── Session ────────────────────────────────────────────────────────────────
function emptySession(guildId) {
  return {
    guildId,
    queue: new MusicQueue({ guildId }),
    connection: null,
    player: null,
    pipeline: null,
    resource: null,
    client: null,
    textChannelId: null,
    panelChannelId: null,
    panelMessageId: null,
    basePosition: 0,
    resumedAt: null,
    seq: 0,                 // identifie la ressource audio en cours
    handledSeq: 0,          // dernière fin déjà traitée (anti double enchaînement)
    retried: new Set(),     // morceaux déjà réessayés (une seule fois)
    lastStartedKey: null,
    playingSince: 0,
    modes: { page: 'player', pageNumber: 1 },
    timers: { refresh: null, idle: null, alone: null },
    consecutiveErrors: 0,
    tools: null,
    busy: false,
    destroyed: false,
    voiceChannelId: null,
    cfg: null,
    lastError: null,
  };
}

function getSession(guildId) {
  return sessions.get(guildId) || null;
}

async function ensureSession({ guild, voiceChannel = null, textChannel = null, cfg = null, tools = null }) {
  let session = sessions.get(guild.id);
  if (session) {
    if (textChannel) session.textChannelId = textChannel.id;
    if (tools) session.tools = tools;
    return session;
  }

  const config = cfg || await getOrCreateConfig(guild.id);
  session = emptySession(guild.id);
  session.client = guild.client || null;
  session.cfg = config;
  session.queue.volume = clampVolume(config.defaultVolume, 70);
  session.queue.autoplay = Boolean(config.autoplay);
  session.queue.maxQueue = config.maxQueue || 100;
  session.textChannelId = textChannel?.id || null;
  session.tools = tools;
  sessions.set(guild.id, session);

  if (voiceChannel) await connectToVoice(session, guild, voiceChannel);
  return session;
}

async function connectToVoice(session, guild, voiceChannel) {
  if (session.connection && session.connection.joinConfig.channelId === voiceChannel.id) return session.connection;

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
      // Discord peut avoir déplacé le bot : on tente de reprendre, sinon on nettoie.
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
  session.connection?.subscribe(player);

  // Filet de sécurité : le flux meurt sans 'end' ni 'error' (très rare). Une
  // seule tentative de reprise, gérée par le même chemin que les autres fins.
  player.on(AudioPlayerStatus.Idle, () => {
    if (session.busy || session.destroyed || !session.current) return;
    if (session.handledSeq === session.seq) return;
    if (Date.now() - (session.playingSince || 0) < 1000) return;
    handleTrackEnd(session, { reason: 'stalled', position: positionOf(session), seq: session.seq }).catch(err => {
      console.error('❌ Musique (enchaînement):', err.message);
    });
  });

  // Une erreur de flux ne saute PLUS le morceau : @discordjs/voice passe en Idle
  // juste après, et c'est handleTrackEnd qui décide (reprise une fois, puis
  // suivant). Avant, les deux chemins appelaient advance() → double saut.
  player.on('error', err => {
    console.error('❌ Musique (lecteur):', err.message);
    session.lastError = err.message;
  });

  return player;
}

// ─── Position / instantané ───────────────────────────────────────────────────
function positionOf(session) {
  if (!session?.queue?.current) return 0;
  if (session.queue.paused || !session.resumedAt) return Math.max(0, session.basePosition);
  return Math.max(0, session.basePosition + (Date.now() - session.resumedAt) / 1000);
}

function snapshotOf(session) {
  if (!session) {
    return {
      current: null, upcoming: [], history: [], loop: 'off', loopLabel: 'Désactivée',
      volume: 70, autoplay: false, paused: false, size: 0, maxQueue: 100,
      progress: { position: 0, duration: 0, percent: 0, elapsed: '0:00', total: '0:00', bar: '' },
    };
  }
  session.queue.position = positionOf(session);
  const snapshot = session.queue.snapshot();
  const track = snapshot.current;
  const requester = track?.requesterId
    ? {
        id: track.requesterId,
        displayName: track.requesterName || 'un membre',
        avatarUrl: null,
      }
    : null;
  return { ...snapshot, requester };
}

// ─── Rendu du panneau ───────────────────────────────────────────────────────
async function buildPanelPayload(session, { page = 'player', pageNumber = 1, notice = null, guild = null } = {}) {
  const snapshot = snapshotOf(session);
  const track = snapshot.current;

  // Avatar du demandeur : récupéré à la volée, jamais bloquant.
  if (track?.requesterId && session?.client) {
    try {
      const user = await session.client.users.fetch(track.requesterId);
      snapshot.requester = {
        id: track.requesterId,
        displayName: track.requesterName || user.username,
        avatarUrl: user.displayAvatarURL({ extension: 'png', size: 128 }),
      };
    } catch { /* avatar facultatif */ }
  }

  const files = [];
  // La carte est un bonus : si le canvas natif crashe sur cet hôte (icudtl.dat),
  // on ne dessine pas du tout (rendre tuerait le process) et le panneau reste
  // entièrement utilisable. La sonde est faite une fois, dans un process enfant.
  if (await canvasAvailable()) {
    try {
      const card = await renderMusicCard({
        track,
        position: snapshot.progress.position,
        volume: snapshot.volume,
        paused: snapshot.paused,
        loop: snapshot.loop,
        queueLength: Math.max(0, snapshot.size - 1),
        autoplay: snapshot.autoplay,
        requester: snapshot.requester,
      });
      files.push(new AttachmentBuilder(card, { name: 'musique.png' }));
    } catch (err) {
      console.warn('⚠️ Musique (carte):', err.message);
    }
  }

  if (page === 'queue') {
    return {
      embeds: [queueEmbed(snapshot, { page: pageNumber, notice })],
      components: queueComponents(snapshot, { page: pageNumber }),
      files,
    };
  }

  return {
    embeds: [playerEmbed(snapshot, { guildName: guild?.name || null, notice })],
    components: playerComponents(snapshot),
    files,
  };
}

async function resolvePanelChannel(session) {
  const id = session.panelChannelId || session.textChannelId;
  if (!id || !session.client) return null;
  const cached = session.client.channels.cache?.get?.(id);
  if (cached) return cached;
  try { return await session.client.channels.fetch(id); } catch { return null; }
}

/** Envoie ou met à jour LE panneau du serveur (un seul message par serveur). */
async function refreshPanel(session, options = {}) {
  if (!session || session.destroyed) return null;
  const channel = await resolvePanelChannel(session);
  if (!channel?.send) return null;

  session.modes.page = options.page || session.modes.page || 'player';
  session.modes.pageNumber = options.pageNumber || session.modes.pageNumber || 1;

  const payload = await buildPanelPayload(session, {
    page: session.modes.page,
    pageNumber: session.modes.pageNumber,
    notice: options.notice || null,
    guild: channel.guild || null,
  });

  if (session.panelMessageId) {
    try {
      const message = await channel.messages.fetch(session.panelMessageId);
      await message.edit(payload);
      return message;
    } catch { /* message supprimé : on en renvoie un neuf */ }
  }

  try {
    const message = await channel.send(payload);
    session.panelMessageId = message.id;
    session.panelChannelId = channel.id;
    return message;
  } catch (err) {
    console.warn('⚠️ Musique (panneau):', err.message);
    return null;
  }
}

/** Enregistre un panneau envoyé par la commande (réponse à l'interaction). */
function attachPanel(session, message, channelId) {
  if (!session || !message) return;
  session.panelMessageId = message.id;
  session.panelChannelId = channelId || message.channelId || session.textChannelId;
  startRefresh(session);
}

function startRefresh(session) {
  clearTimer(session, 'refresh');
  session.timers.refresh = setInterval(() => {
    if (session.destroyed || !session.current) return;
    refreshPanel(session).catch(() => {});
  }, REFRESH_MS);
  session.timers.refresh.unref?.();
}

function clearTimer(session, key) {
  if (session?.timers?.[key]) {
    clearInterval(session.timers[key]);
    clearTimeout(session.timers[key]);
    session.timers[key] = null;
  }
}

// ─── Lecture ────────────────────────────────────────────────────────────────
async function startCurrent(session) {
  const track = session.queue.current;
  if (!track) return null;

  if (!session.connection) throw new Error('Aucune connexion vocale active.');

  const tools = session.tools || await requireTools();
  session.tools = tools;

  // Nouveau morceau = nouvelle ressource : tout événement tardif de l'ancienne
  // (fin, erreur, close) est ignoré grâce à ce numéro de séquence.
  session.seq += 1;
  const seq = session.seq;
  killPipeline(session);

  // La liste des reprises ne concerne que le morceau courant.
  const key = guard.trackKey(track);
  if (key !== session.lastStartedKey) {
    session.retried.clear();
    session.lastStartedKey = key;
  }

  // Chemin rapide si le morceau a été préchargé (aucun yt-dlp au milieu).
  const directUrl = await resolveDirectUrl(session, track);

  const pipeline = createAudioPipeline(track, {
    ytdlpPath: tools.ytdlp.path,
    ffmpegPath: tools.ffmpeg.path,
    directUrl,
  });
  session.pipeline = pipeline;

  try {
    const resource = createAudioResource(pipeline.stream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: { track, seq },
    });
    resource.volume?.setVolume(Math.max(0, Math.min(2, session.queue.volume / 100)));
    session.resource = resource;

    const player = createPlayerFor(session);
    session.current = track;
    session.basePosition = 0;
    session.resumedAt = Date.now();
    session.playingSince = Date.now();
    session.queue.position = 0;
    session.queue.paused = false;

    // Détection de fin sur NOTRE flux : on enchaîne dès la dernière donnée
    // reçue, au lieu d'attendre l'underrun du lecteur (qui ajoutait 5 s de
    // silence et pouvait couper le morceau sur un simple ralentissement).
    attachStreamEnd(session, pipeline, seq, track);
    player.play(resource);
  } catch (err) {
    // Ne jamais laisser tourner un couple yt-dlp/ffmpeg orphelin.
    try { pipeline.kill(); } catch { /* déjà terminé */ }
    session.pipeline = null;
    throw err;
  }
  clearTimer(session, 'idle');

  recordPlay(session, track);
  startRefresh(session);
  prefetchUpcoming(session); // le suivant sera prêt avant la fin du courant
  return track;
}

function killPipeline(session) {
  if (!session?.pipeline) return;
  try { session.pipeline.kill(); } catch { /* déjà fermé */ }
  session.pipeline = null;
}

/** Branche la fin/erreur du flux audio sur la décision de fin de morceau. */
function attachStreamEnd(session, pipeline, seq, track) {
  let fired = false;
  const finish = reason => {
    if (fired) return;
    fired = true;
    // Un ancien flux libéré pendant un skip ne doit rien déclencher.
    if (session.destroyed || seq !== session.seq) return;
    const position = positionOf(session);
    const delay = reason === 'ended' ? TRACK_TAIL_MS : 0;
    const timer = setTimeout(() => {
      if (session.destroyed || seq !== session.seq) return;
      handleTrackEnd(session, { reason, position, track, seq }).catch(err => {
        console.error('❌ Musique (fin de morceau):', err.message);
      });
    }, delay);
    timer.unref?.();
  };

  pipeline.stream.once('end', () => finish('ended'));
  pipeline.stream.once('error', () => finish('error'));
  pipeline.stream.once('close', () => finish(pipeline.failed?.() ? 'error' : 'ended'));
}

/**
 * Fin d'un morceau : enchaîner, ou réessayer une fois avant d'abandonner.
 * C'est LE point qui évite de vider la file sur un incident passager.
 */
async function handleTrackEnd(session, { reason = 'ended', position = null, track = null, seq = null } = {}) {
  if (!session || session.destroyed) return null;
  // Événement tardif d'un flux déjà remplacé (skip, retour, nouveau morceau).
  if (seq != null && seq !== session.seq) return null;
  const currentSeq = seq == null ? session.seq : seq;
  if (session.handledSeq === currentSeq) return null;
  session.handledSeq = currentSeq;

  const target = track || session.queue.current;
  if (!target) return null;

  const played = position == null ? positionOf(session) : position;
  const key = guard.trackKey(target);
  const alreadyRetried = key ? session.retried.has(key) : false;
  const decision = guard.decideTrackEnd(target, { position: played, reason, retried: alreadyRetried });    if (decision === 'retry') {
      if (key) session.retried.add(key);
      // Une URL directe qui vient d'échouer (expirée, 403) n'est pas réessayée :
      // la reprise repasse par le tube yt-dlp, plus lent mais très tolérant.
      invalidateStreamUrl(key);
      if (session.prefetch?.key === key) session.prefetch = null;
    try {
      await startCurrent(session);
      session.consecutiveErrors = 0;
      session.lastError = null;
      await refreshPanel(session, { notice: `🔁 Coupure sur **${target.title}** — je reprends le morceau.` }).catch(() => {});
      return target;
    } catch (err) {
      session.lastError = err.message;
      console.error('❌ Musique (reprise):', err.message);
      session.queue.tracks.shift();
    }
  }

  const normalEnd = reason === 'ended' && !guard.isPrematureEnd(played, target);
  const notice = normalEnd ? null : guard.skipNotice(target, { reason, retried: alreadyRetried });
  return advance(session, { manual: false, notice });
}

function recordPlay(session, track) {
  if (!session.cfg?.guildId) return;
  MusicConfig.updateOne(
    { guildId: session.cfg.guildId },
    {
      $inc: { 'stats.tracksPlayed': 1 },
      $set: { 'stats.lastPlayedAt': new Date() },
    },
  ).catch(() => { /* statistiques non bloquantes */ });
}

/**
 * Enchaîne sur le morceau suivant, avec autoplay si la file se vide.
 * Les morceaux qui échouent sont retirés un par un : une vidéo cassée ne doit
 * jamais bloquer toute la file (comportement classique des bots Lavalink).
 */
async function advance(session, { manual = false, notice = null } = {}) {
  if (session.busy || session.destroyed) return null;
  session.busy = true;

  try {
    for (let attempt = 0; attempt <= MAX_CONSECUTIVE_ERRORS; attempt += 1) {
      const finished = session.queue.current;
      const result = session.queue.advance({ manual: manual || attempt > 0 });
      let track = result.track;

      if (!track && session.queue.autoplay && finished) {
        const related = await relatedTracks(finished, {
          limit: 10,
          requesterId: finished.requesterId,
          requesterName: finished.requesterName,
          binary: session.tools?.ytdlp?.path || null,
        });
        if (related.length) {
          session.queue.add(related);
          track = session.queue.current;
        }
      }

      if (!track) {
        // Un flux qui meurt sans un mot (blocage YouTube, lien cassé) doit
        // laisser une trace lisible dans le panneau, pas un simple « fini ».
        const stderr = session.pipeline?.stderrText?.() || '';
        if (finished && /ERROR/i.test(stderr) && !/Broken pipe|unable to write data/i.test(stderr)) {
          session.lastError = session.pipeline.errorText();
        }
        await finishQueue(session);
        return null;
      }

      try {
        await startCurrent(session);
        session.consecutiveErrors = 0;
        await refreshPanel(session, { notice });
        return track;
      } catch (err) {
        session.consecutiveErrors += 1;
        console.error('❌ Musique (lecture):', err.message);
        session.lastError = err.message;
        session.queue.tracks.shift();
        await refreshPanel(session, { notice: `⚠️ Lecture impossible : ${err.message}` }).catch(() => {});
        if (!session.queue.current) {
          await finishQueue(session);
          return null;
        }
      }
    }

    await finishQueue(session);
    return null;
  } finally {
    session.busy = false;
  }
}

async function finishQueue(session) {
  const error = session.lastError;
  session.lastError = null;
  session.current = null;
  session.queue.paused = false;
  session.basePosition = 0;
  session.resumedAt = null;
  clearTimer(session, 'refresh');
  await refreshPanel(session, {
    notice: error || '📭 File terminée. Ajoute un morceau avec `/musique`.',
  }).catch(() => {});
  scheduleIdleDisconnect(session);
}

function scheduleIdleDisconnect(session) {
  clearTimer(session, 'idle');
  session.timers.idle = setTimeout(() => {
    if (session.destroyed) return;
    if (session.queue.current) return;
    destroySession(session, { reason: 'inactivité', silent: true }).catch(() => {});
  }, IDLE_DISCONNECT_MS);
  session.timers.idle.unref?.();
}

// ─── API publique du moteur ────────────────────────────────────────────────
/**
 * Ajoute une recherche/lien et démarre si nécessaire.
 * @returns {Promise<{ session:object, kind:string, tracks:object[], started:boolean, rejected:number }>}
 */
async function play({ guild, member, voiceChannel, textChannel, query }) {
  const cfg = await getOrCreateConfig(guild.id);
  const tools = await requireTools();

  const session = await ensureSession({ guild, textChannel, cfg, tools });

  // La connexion vocale et la résolution du morceau sont indépendantes : on les
  // lance ensemble. Sur une IP lente, yt-dlp met plusieurs secondes à répondre
  // et le bot n'a aucune raison d'attendre d'être dans le salon pour commencer.
  const connecting = (!session.connection && voiceChannel)
    ? connectToVoice(session, guild, voiceChannel)
    : Promise.resolve(session.connection || null);

  const [resolved] = await Promise.all([
    resolveInput(query, {
      limit: 8,
      maxTracks: cfg.maxQueue || 100,
      requesterId: member.id,
      requesterName: member.displayName || member.user?.username || null,
      binary: tools.ytdlp.path,
    }),
    connecting,
  ]);

  session.cfg = cfg;
  session.queue.volume = clampVolume(session.queue.volume, cfg.defaultVolume);
  session.queue.autoplay = Boolean(cfg.autoplay);
  session.queue.maxQueue = cfg.maxQueue || 100;

  const wasIdle = !session.queue.current;
  const { added, rejected } = session.queue.add(resolved.tracks);

  let started = false;
  if (wasIdle && added > 0) {
    await startCurrent(session);
    started = true;
  } else if (added > 0) {
    // Un morceau joue déjà : on prépare le suivant pendant ce temps.
    prefetchUpcoming(session);
  }

  return { session, kind: resolved.kind, tracks: resolved.tracks, added, rejected, started };
}

async function togglePause(session) {
  if (!session?.player || !session.queue.current) return null;
  if (session.queue.paused) {
    session.basePosition = positionOf(session);
    session.resumedAt = Date.now();
    session.queue.paused = false;
    session.player.unpause();
  } else {
    session.basePosition = positionOf(session);
    session.resumedAt = null;
    session.queue.paused = true;
    session.player.pause();
  }
  return session.queue.paused;
}

async function skip(session) {
  if (!session?.queue.current) return null;
  return advance(session, { manual: true });
}

async function previous(session) {
  if (!session) return null;
  const track = session.queue.back();
  if (!track) return null;
  await startCurrent(session);
  await refreshPanel(session);
  return track;
}

function setVolume(session, value) {
  if (!session) return 0;
  const volume = clampVolume(value, session.queue.volume);
  session.queue.volume = volume;
  session.resource?.volume?.setVolume(Math.max(0, Math.min(2, volume / 100)));
  return volume;
}

function cycleLoop(session) {
  if (!session) return 'off';
  return session.queue.cycleLoop();
}

function shuffle(session) {
  if (!session) return 0;
  return session.queue.shuffle();
}

async function jumpTo(session, index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i <= 0 || i >= session.queue.tracks.length) return null;
  session.queue.history.push(...session.queue.tracks.slice(0, i));
  session.queue.tracks.splice(0, i);
  await startCurrent(session);
  await refreshPanel(session);
  return session.queue.current;
}

async function stop(session, { silent = false } = {}) {
  if (!session) return;
  session.queue.tracks = [];
  session.queue.history = [];
  session.queue.paused = false;
  session.current = null;
  session.basePosition = 0;
  session.resumedAt = null;

  clearTimer(session, 'refresh');
  clearTimer(session, 'idle');
  clearTimer(session, 'alone');

  session.seq += 1; // neutralise les événements du flux en cours
  killPipeline(session);
  try { session.player?.stop(true); } catch { /* déjà arrêté */ }

  if (!silent) await refreshPanel(session, { notice: '⏹️ Lecture arrêtée — la file a été vidée.' }).catch(() => {});
  sessions.delete(session.guildId);
  try { session.connection?.destroy(); } catch { /* déjà fermée */ }
  session.destroyed = true;
}

async function destroySession(session, { reason = 'arrêt', silent = false } = {}) {
  if (!session || session.destroyed) return;
  clearTimer(session, 'refresh');
  clearTimer(session, 'idle');
  clearTimer(session, 'alone');
  session.seq += 1;
  killPipeline(session);
  session.destroyed = true;
  sessions.delete(session.guildId);
  try { session.player?.stop(true); } catch { /* ignore */ }
  try { session.connection?.destroy(); } catch { /* ignore */ }
  if (!silent && reason) console.log(`[musique] session fermée (${reason}) — serveur ${session.guildId}`);
}

// ─── Vocal : personne avec le bot ──────────────────────────────────────────
function handleVoiceStateUpdate(oldState, newState) {
  const guild = newState.guild || oldState.guild;
  const session = sessions.get(guild?.id);
  if (!session?.connection) return;

  // Le bot a été déplacé ou déconnecté manuellement.
  const botId = newState.client?.user?.id;
  if (newState.id === botId) {
    if (!newState.channelId) {
      destroySession(session, { reason: 'déconnecté du vocal', silent: true }).catch(() => {});
    } else {
      session.voiceChannelId = newState.channelId;
    }
    return;
  }

  const botChannelId = session.voiceChannelId || session.connection.joinConfig.channelId;
  const channel = guild.channels.cache.get(botChannelId);
  const humans = channel?.members ? channel.members.filter(member => !member.user.bot).size : 0;

  if (humans === 0) {
    clearTimer(session, 'alone');
    session.timers.alone = setTimeout(() => {
      if (session.destroyed) return;
      const check = guild.channels.cache.get(session.voiceChannelId);
      const stillAlone = !check?.members || check.members.filter(member => !member.user.bot).size === 0;
      if (stillAlone) {
        refreshPanel(session, { notice: '👋 Plus personne dans le salon vocal : je libère la connexion.' }).catch(() => {});
        destroySession(session, { reason: 'salon vide', silent: true }).catch(() => {});
      }
    }, ALONE_DISCONNECT_MS);
    session.timers.alone.unref?.();
  } else {
    clearTimer(session, 'alone');
  }
}

// ─── Réglages ──────────────────────────────────────────────────────────────
async function panelPayloadForGuild(guild, { page = 'player', pageNumber = 1, notice = null } = {}) {
  const session = sessions.get(guild.id);
  if (!session) {
    const cfg = await getOrCreateConfig(guild.id);
    const ghost = emptySession(guild.id);
    ghost.queue.volume = clampVolume(cfg.defaultVolume, 70);
    ghost.queue.autoplay = Boolean(cfg.autoplay);
    return buildPanelPayload(ghost, { page, pageNumber, notice, guild });
  }
  return buildPanelPayload(session, { page, pageNumber, notice, guild });
}

async function configPanelForGuild(guild, { notice = null } = {}) {
  const cfg = await getOrCreateConfig(guild.id);
  const tools = await ensureMediaTools({ download: false });
  return {
    cfg,
    tools,
    payload: {
      embeds: [configEmbed(cfg, { tools, notice, guild })],
      components: configComponents(cfg, { ready: tools.ready }),
    },
  };
}

function formatDuration(seconds) {
  return formatTime(seconds);
}

module.exports = {
  // session
  sessions,
  getSession,
  ensureSession,
  getOrCreateConfig,
  canControl,
  // lecture
  play,
  togglePause,
  skip,
  previous,
  setVolume,
  cycleLoop,
  shuffle,
  jumpTo,
  stop,
  destroySession,
  handleVoiceStateUpdate,
  // affichage
  buildPanelPayload,
  panelPayloadForGuild,
  refreshPanel,
  attachPanel,
  configPanelForGuild,
  // utilitaires testables
  startCurrent,
  setStreamUrl,
  getStreamUrl,
  invalidateStreamUrl,
  clearStreamUrlCache,
  prefetchUpcoming,
  STREAM_URL_TTL,
  PREFETCH_WAIT_MS,
  handleTrackEnd,
  positionOf,
  snapshotOf,
  formatDuration,
  IDLE_DISCONNECT_MS,
  ALONE_DISCONNECT_MS,
  REFRESH_MS,
  MAX_MISSED_FRAMES,
  TRACK_TAIL_MS,
};
