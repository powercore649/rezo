'use strict';
// utils/musicQueue.js — File d'attente du module musique (logique pure).
//
// Aucun Discord, aucun réseau, aucune base : cette classe est testable seule.
// Elle porte les règles qui font la différence entre un lecteur correct et un
// lecteur agréable : boucle morceau/file, retour arrière, mélange, retrait,
// déplacement, limite de file, progression.

const LOOP_MODES = ['off', 'track', 'queue'];
const LOOP_LABEL = { off: 'Désactivée', track: 'Morceau', queue: 'File' };

function clampVolume(value, fallback = 70) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(200, Math.round(n)));
}

function clampMaxQueue(value, fallback = 100) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, n));
}

/** 65 → « 1:05 », 3725 → « 1:02:05 » */
function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function bar(percent, length = 18) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((pct / 100) * length);
  return `${'▰'.repeat(filled)}${'▱'.repeat(Math.max(0, length - filled))}`;
}

function shuffleInPlace(list, rng = Math.random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.max(0, Math.min(0.999999, rng())) * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

class MusicQueue {
  constructor({ guildId = null, volume = 70, loop = 'off', autoplay = false, maxQueue = 100 } = {}) {
    this.guildId = guildId;
    this.tracks = [];        // index 0 = morceau en cours
    this.history = [];       // plus récent en dernier
    this.loop = LOOP_MODES.includes(loop) ? loop : 'off';
    this.volume = clampVolume(volume);
    this.autoplay = Boolean(autoplay);
    this.maxQueue = clampMaxQueue(maxQueue);
    this.startedAt = Date.now();
    this.position = 0;       // secondes écoulées du morceau courant
    this.paused = false;
  }

  get current() { return this.tracks[0] || null; }
  get upcoming() { return this.tracks.slice(1); }
  get size() { return this.tracks.length; }
  get isEmpty() { return this.tracks.length === 0; }

  /** Ajoute des morceaux ; rend ce qui a été accepté et ce qui a débordé. */
  add(tracks = []) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const room = Math.max(0, this.maxQueue - this.tracks.length);
    const accepted = list.slice(0, room);
    this.tracks.push(...accepted);
    return { added: accepted.length, rejected: Math.max(0, list.length - accepted.length), tracks: accepted };
  }

  removeAt(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i <= 0 || i >= this.tracks.length) return null;
    return this.tracks.splice(i, 1)[0] || null;
  }

  move(from, to) {
    const a = Number(from);
    const b = Number(to);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    if (a <= 0 || a >= this.tracks.length || b <= 0 || b >= this.tracks.length || a === b) return false;
    const [item] = this.tracks.splice(a, 1);
    this.tracks.splice(b, 0, item);
    return true;
  }

  /** Mélange la suite, jamais le morceau en cours. */
  shuffle(rng = Math.random) {
    const rest = this.tracks.slice(1);
    shuffleInPlace(rest, rng);
    this.tracks = [this.tracks[0], ...rest].filter(Boolean);
    return rest.length;
  }

  clearUpcoming() {
    const removed = Math.max(0, this.tracks.length - 1);
    this.tracks = this.tracks.slice(0, 1);
    this.position = 0;
    return removed;
  }

  /**
   * Passe au morceau suivant.
   * `manual` = bouton « suivant » : ignore la boucle « morceau » (sinon on ne
   * pourrait jamais quitter un titre en boucle).
   */
  advance({ manual = false } = {}) {
    const playing = this.current;
    if (!playing) return { track: null, ended: true };

    if (!manual && this.loop === 'track') {
      this.position = 0;
      return { track: playing, replay: true, ended: false };
    }

    this.history.push(playing);
    if (this.history.length > 100) this.history.shift();
    this.tracks.shift();

    if (!this.tracks.length && this.loop === 'queue' && this.history.length) {
      // La boucle de file rejoue l'historique dans l'ordre, sans le doubler.
      this.tracks = this.history.splice(0, this.history.length);
    }

    this.position = 0;
    return { track: this.current, replay: false, ended: !this.current };
  }

  /** Revient au morceau précédent ; le courant repart dans la file. */
  back() {
    const previous = this.history.pop();
    if (!previous) return null;
    if (this.current) this.tracks.unshift(this.current);
    this.tracks.unshift(previous);
    this.position = 0;
    return previous;
  }

  setLoop(mode) {
    this.loop = LOOP_MODES.includes(mode) ? mode : 'off';
    return this.loop;
  }

  cycleLoop() {
    const index = LOOP_MODES.indexOf(this.loop);
    return this.setLoop(LOOP_MODES[(index + 1) % LOOP_MODES.length]);
  }

  progress() {
    const track = this.current;
    const duration = Math.max(0, Number(track?.duration) || 0);
    const position = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(this.position) || 0));
    const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
    return {
      position,
      duration,
      percent,
      elapsed: formatTime(position),
      total: duration > 0 ? formatTime(duration) : (track?.live ? 'LIVE' : '--:--'),
      bar: bar(percent),
    };
  }

  snapshot() {
    return {
      guildId: this.guildId,
      current: this.current,
      upcoming: this.upcoming,
      history: [...this.history],
      loop: this.loop,
      loopLabel: LOOP_LABEL[this.loop],
      volume: this.volume,
      autoplay: this.autoplay,
      paused: this.paused,
      size: this.size,
      maxQueue: this.maxQueue,
      progress: this.progress(),
    };
  }
}

module.exports = {
  MusicQueue,
  LOOP_MODES,
  LOOP_LABEL,
  clampVolume,
  clampMaxQueue,
  formatTime,
  bar,
  shuffleInPlace,
};
