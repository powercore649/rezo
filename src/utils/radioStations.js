'use strict';
// utils/radioStations.js — Catalogue des stations de la commande /radio.
//
// Pourquoi un catalogue figé plutôt qu'une recherche sur Internet : une radio
// n'est pas un morceau. Il n'existe ni moteur de recherche public fiable, ni
// API commune — mais il existe des flux HTTP stables. On embarque donc une
// liste courte, choisie à la main, et vérifiée.
//
// Toutes les URLs ci-dessous ont été testées le 2026-10-23 en HTTP GET : code
// 200 et `Content-Type: audio/*` (ou redirection vers un flux valide). Une
// station qui tombe ne casse rien : le panneau affiche l'erreur ffmpeg et
// `/radio config` propose de tester le flux à la demande. Pour en ajouter une,
// il suffit d'une ligne — aucun code à toucher.
//
// Aucune de ces fonctions ne fait d'I/O : le catalogue est filtrable et
// testable hors-ligne.

// ── Genres ──────────────────────────────────────────────────────────────────
// La couleur sert de teinte à l'embed : on reconnaît le genre d'un coup d'œil.
const GENRES = {
  generaliste: { label: 'Généraliste',    emoji: '📻', color: 0x8B1A1A },
  info:        { label: 'Info & Talk',    emoji: '📰', color: 0x5BC0EB },
  culture:     { label: 'Culture',        emoji: '🎭', color: 0xD4AF37 },
  classique:   { label: 'Classique',      emoji: '🎻', color: 0xB08D57 },
  jazz:        { label: 'Jazz & Soul',    emoji: '🎷', color: 0xC08A2E },
  electro:     { label: 'Électro & Dance', emoji: '🎛️', color: 0x9B59B6 },
  chill:       { label: 'Chill & Ambient', emoji: '🌙', color: 0x4A6FA5 },
  rock:        { label: 'Rock & Metal',   emoji: '🎸', color: 0x992D22 },
  rap:         { label: 'Rap & R&B',      emoji: '🎤', color: 0x2C3E50 },
  pop:         { label: 'Pop & Hits',     emoji: '✨', color: 0xE0528C },
  eclectique:  { label: 'Éclectique',     emoji: '🎼', color: 0x1ABC9C },
  monde:       { label: 'Monde',          emoji: '🌍', color: 0x27AE60 },
};

const GENRE_IDS = Object.keys(GENRES);

// Filtre « Tout » du panneau : pas un genre, juste l'absence de filtre.
const ALL_FILTER = 'all';

const FLAGS = { FR: '🇫🇷', GB: '🇬🇧', US: '🇺🇸', CH: '🇨🇭' };

// ── Catalogue ───────────────────────────────────────────────────────────────
// Champ par champ : id stable (valeur du menu), nom affiché, accroche courte,
// genre, pays, débit annoncé, codec, URL du flux, site officiel.
const STATIONS = [
  // Généralistes françaises
  { id: 'france-inter', name: 'France Inter', genre: 'generaliste', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'La généraliste de service public', url: 'https://icecast.radiofrance.fr/franceinter-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/franceinter' },
  { id: 'europe-1', name: 'Europe 1', genre: 'generaliste', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Info, talk et grands rendez-vous', url: 'http://stream.europe1.fr/europe1.mp3',
    homepage: 'https://www.europe1.fr' },
  { id: 'france-bleu', name: 'France Bleu', genre: 'generaliste', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Le réseau régional', url: 'https://icecast.radiofrance.fr/fb1071-midfi.mp3',
    homepage: 'https://www.francebleu.fr' },

  // Info
  { id: 'france-info', name: 'France Info', genre: 'info', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'L’info en continu', url: 'https://icecast.radiofrance.fr/franceinfo-midfi.mp3',
    homepage: 'https://www.francetvinfo.fr' },
  { id: 'rmc', name: 'RMC', genre: 'info', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Info et sport en continu', url: 'https://audio.bfmtv.com/rmcradio_128.mp3',
    homepage: 'https://rmc.bfmtv.com' },
  { id: 'bfm-radio', name: 'BFM Radio', genre: 'info', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'L’actualité en direct', url: 'https://audio.bfmtv.com/bfmradio_128.mp3',
    homepage: 'https://www.bfmtv.com/radio' },
  { id: 'bbc-world-service', name: 'BBC World Service', genre: 'info', country: 'GB', bitrate: 128, codec: 'MP3',
    tagline: 'L’info mondiale en anglais', url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service',
    homepage: 'https://www.bbc.co.uk/worldserviceradio' },
  { id: 'npr', name: 'NPR', genre: 'info', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Radio publique américaine', url: 'https://npr-ice.streamguys1.com/live.mp3',
    homepage: 'https://www.npr.org' },

  // Culture & classique
  { id: 'france-culture', name: 'France Culture', genre: 'culture', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Débats, documentaires, idées', url: 'https://icecast.radiofrance.fr/franceculture-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/franceculture' },
  { id: 'france-musique', name: 'France Musique', genre: 'classique', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Le classique pour tous', url: 'https://icecast.radiofrance.fr/francemusique-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/francemusique' },
  { id: 'radio-classique', name: 'Radio Classique', genre: 'classique', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Classique et actualité culturelle', url: 'https://radioclassique.ice.infomaniak.ch/radioclassique-high.mp3',
    homepage: 'https://www.radioclassique.fr' },
  { id: 'swiss-classic', name: 'Radio Swiss Classic', genre: 'classique', country: 'CH', bitrate: 128, codec: 'MP3',
    tagline: 'Classique sans publicité', url: 'http://stream.srg-ssr.ch/m/rsc_de/mp3_128',
    homepage: 'https://www.radioswissclassic.ch' },

  // Jazz & soul
  { id: 'fip-jazz', name: 'FIP Jazz', genre: 'jazz', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Le meilleur du jazz, sans pub', url: 'https://icecast.radiofrance.fr/fipjazz-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-jazz' },
  { id: 'fip-groove', name: 'FIP Groove', genre: 'jazz', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Funk, soul et groove', url: 'https://icecast.radiofrance.fr/fipgroove-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-groove' },
  { id: 'jazz-radio', name: 'Jazz Radio', genre: 'jazz', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Jazz sous toutes ses formes', url: 'https://jazzradio.ice.infomaniak.ch/jazzradio-high.mp3',
    homepage: 'https://www.jazzradio.fr' },
  { id: 'tsf-jazz', name: 'TSF Jazz', genre: 'jazz', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'La radio du jazz à Paris', url: 'https://tsfjazz.ice.infomaniak.ch/tsfjazz-high.mp3',
    homepage: 'https://www.tsfjazz.com' },
  { id: 'swiss-jazz', name: 'Radio Swiss Jazz', genre: 'jazz', country: 'CH', bitrate: 128, codec: 'MP3',
    tagline: 'Jazz, soul et blues', url: 'http://stream.srg-ssr.ch/m/rsj/mp3_128',
    homepage: 'https://www.radioswissjazz.ch' },

  // Électro & dance
  { id: 'fun-radio', name: 'Fun Radio', genre: 'electro', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Dance et électro', url: 'https://icecast.funradio.fr/fun-1-44-128',
    homepage: 'https://www.funradio.fr' },
  { id: 'fip-electro', name: 'FIP Electro', genre: 'electro', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Électro et musiques électroniques', url: 'https://icecast.radiofrance.fr/fipelectro-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-electro' },
  { id: 'soma-beat-blender', name: 'SomaFM Beat Blender', genre: 'electro', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Deep house non-stop', url: 'https://ice1.somafm.com/beatblender-128-mp3',
    homepage: 'https://somafm.com/beatblender/' },

  // Chill & ambient
  { id: 'soma-groove-salad', name: 'SomaFM Groove Salad', genre: 'chill', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Downtempo et ambient', url: 'https://ice1.somafm.com/groovesalad-128-mp3',
    homepage: 'https://somafm.com/groovesalad/' },
  { id: 'soma-drone-zone', name: 'SomaFM Drone Zone', genre: 'chill', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Ambient spatial', url: 'https://ice1.somafm.com/dronezone-128-mp3',
    homepage: 'https://somafm.com/dronezone/' },
  { id: 'soma-lush', name: 'SomaFM Lush', genre: 'chill', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Chill vocal et mélodique', url: 'https://ice1.somafm.com/lush-128-mp3',
    homepage: 'https://somafm.com/lush/' },
  { id: 'soma-deep-space-one', name: 'SomaFM Deep Space One', genre: 'chill', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Ambient profond', url: 'https://ice1.somafm.com/deepspaceone-128-mp3',
    homepage: 'https://somafm.com/deepspaceone/' },
  { id: 'soma-secret-agent', name: 'SomaFM Secret Agent', genre: 'chill', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Lounge d’espion', url: 'https://ice1.somafm.com/secretagent-128-mp3',
    homepage: 'https://somafm.com/secretagent/' },
  { id: 'radio-paradise-mellow', name: 'Radio Paradise Mellow', genre: 'chill', country: 'US', bitrate: 128, codec: 'AAC',
    tagline: 'Éclectique et apaisé', url: 'https://stream.radioparadise.com/mellow-128',
    homepage: 'https://radioparadise.com' },

  // Rock & metal
  { id: 'fip-rock', name: 'FIP Rock', genre: 'rock', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Rock, indie et classiques', url: 'https://icecast.radiofrance.fr/fiprock-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-rock' },
  { id: 'fip-metal', name: 'FIP Metal', genre: 'rock', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Metal et musiques extrêmes', url: 'https://icecast.radiofrance.fr/fipmetal-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-metal' },
  { id: 'oui-fm', name: 'Oui FM', genre: 'rock', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Le rock indépendant', url: 'https://ouifm.ice.infomaniak.ch/ouifm-high.mp3',
    homepage: 'https://www.ouifm.fr' },
  { id: 'kexp', name: 'KEXP', genre: 'rock', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Indie de Seattle', url: 'https://kexp-mp3-128.streamguys1.com/kexp128.mp3',
    homepage: 'https://kexp.org' },

  // Rap & R&B
  { id: 'skyrock', name: 'Skyrock', genre: 'rap', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Rap, R&B et hits urbains', url: 'https://icecast.skyrock.net/s/natio_mp3_128k',
    homepage: 'https://www.skyrock.com' },
  { id: 'mouv', name: 'Mouv’', genre: 'rap', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Rap et cultures urbaines', url: 'https://icecast.radiofrance.fr/mouv-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/mouv' },
  { id: 'fip-hiphop', name: 'FIP Hip-Hop', genre: 'rap', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Hip-hop, rap et soul', url: 'https://icecast.radiofrance.fr/fiphiphop-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-hip-hop' },

  // Pop & hits
  { id: 'nrj', name: 'NRJ', genre: 'pop', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Hit music only', url: 'https://scdn.nrjaudio.fm/adwz2/fr/30001/mp3_128.mp3',
    homepage: 'https://www.nrj.fr' },
  { id: 'fip-pop', name: 'FIP Pop', genre: 'pop', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Pop, folk et indie', url: 'https://icecast.radiofrance.fr/fippop-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-pop' },
  { id: 'swiss-pop', name: 'Radio Swiss Pop', genre: 'pop', country: 'CH', bitrate: 128, codec: 'MP3',
    tagline: 'Pop et rock des hits', url: 'http://stream.srg-ssr.ch/m/rsp/mp3_128',
    homepage: 'https://www.radioswisspop.ch' },

  // Monde
  { id: 'fip-reggae', name: 'FIP Reggae', genre: 'monde', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Reggae, dub et racines', url: 'https://icecast.radiofrance.fr/fipreggae-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-reggae' },
  { id: 'fip-world', name: 'FIP Monde', genre: 'monde', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Musiques du monde', url: 'https://icecast.radiofrance.fr/fipworld-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip/radio-monde' },
  { id: 'rfi-monde', name: 'RFI Monde', genre: 'monde', country: 'FR', bitrate: 64, codec: 'MP3',
    tagline: 'Le monde en français', url: 'https://rfimonde64k.ice.infomaniak.ch/rfimonde-64.mp3',
    homepage: 'https://www.rfi.fr' },

  // Éclectiques
  { id: 'fip', name: 'FIP', genre: 'eclectique', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Jazz, groove et découvertes', url: 'https://icecast.radiofrance.fr/fip-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip' },
  { id: 'fip-nouveautes', name: 'FIP Nouveautés', genre: 'eclectique', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Les sorties du moment', url: 'https://icecast.radiofrance.fr/fipnouveautes-midfi.mp3',
    homepage: 'https://www.radiofrance.fr/fip' },
  { id: 'radio-nova', name: 'Radio Nova', genre: 'eclectique', country: 'FR', bitrate: 128, codec: 'MP3',
    tagline: 'Musiques actuelles et découvertes', url: 'https://novazz.ice.infomaniak.ch/novazz-128.mp3',
    homepage: 'https://www.nova.fr' },
  { id: 'radio-paradise', name: 'Radio Paradise', genre: 'eclectique', country: 'US', bitrate: 128, codec: 'MP3',
    tagline: 'Rock éclectique sans pub', url: 'https://stream.radioparadise.com/mp3-128',
    homepage: 'https://radioparadise.com' },
];

// ── Sélection de départ ─────────────────────────────────────────────────────
// Le menu du panneau ne peut afficher que 25 options : on ouvre sur une
// sélection courte et on laisse le menu de genre dérouler le reste.
const FEATURED_IDS = [
  'france-inter', 'fip', 'france-info', 'france-culture', 'fip-jazz',
  'soma-groove-salad', 'skyrock', 'radio-paradise', 'fun-radio', 'bbc-world-service',
];

const BY_ID = new Map(STATIONS.map(station => [station.id, station]));

// ── Normalisation / recherche (pur) ─────────────────────────────────────────
// Les accents et la casse ne doivent jamais empêcher de trouver « Mouv’ ».
// NFD sépare la lettre de son accent, puis on retire les diacritiques.
function normalizeText(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function genreOf(station) {
  return GENRES[station?.genre] || GENRES.generaliste;
}

function flagOf(station) {
  return FLAGS[station?.country] || '🌍';
}

function qualityOf(station) {
  return `${station?.bitrate || 0} kbps · ${station?.codec || 'MP3'}`;
}

function isKnownGenre(genre) {
  return genre === ALL_FILTER || GENRE_IDS.includes(genre);
}

function getStation(id) {
  return BY_ID.get(String(id || '')) || null;
}

function stationsByGenre(genre = ALL_FILTER) {
  if (!genre || genre === ALL_FILTER || !GENRES[genre]) return [...STATIONS];
  return STATIONS.filter(station => station.genre === genre);
}

function featuredStations() {
  return FEATURED_IDS.map(id => BY_ID.get(id)).filter(Boolean);
}

/**
 * Recherche tolérante pour l'autocomplétion et `/radio station:<nom>`.
 * Classement : identifiant exact, nom exact, nom commençant par la requête,
 * nom contenant la requête, puis genre/accroche. Les résultats sont stables
 * (ordre du catalogue) à score égal.
 */
function searchStations(query, { limit = 25, genre = ALL_FILTER } = {}) {
  const q = normalizeText(query);
  const pool = stationsByGenre(genre);
  if (!q) return pool.slice(0, Math.max(1, limit));

  const scored = [];
  for (const station of pool) {
    const name = normalizeText(station.name);
    const id = normalizeText(station.id);
    const tagline = normalizeText(station.tagline);
    const genreLabel = normalizeText(genreOf(station).label);

    let score = 0;
    if (id === q) score = 100;
    else if (name === q) score = 90;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 70;
    else if (id.includes(q)) score = 60;
    else if (tagline.includes(q)) score = 40;
    else if (genreLabel.includes(q)) score = 30;
    // Requête multi-mots : « fip jazz » doit trouver FIP Jazz même si le nom
    // contient une espace insécable ou un tiret.
    else if (q.split(' ').every(token => name.includes(token) || tagline.includes(token))) score = 25;
    if (score) scored.push({ station, score });
  }

  scored.sort((a, b) => b.score - a.score || a.station.name.localeCompare(b.station.name, 'fr'));
  return scored.slice(0, Math.max(1, limit)).map(entry => entry.station);
}

/** Meilleure correspondance pour une saisie libre, ou null. */
function findStation(query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const direct = getStation(raw);
  if (direct) return direct;
  const [best] = searchStations(raw, { limit: 1 });
  return best || null;
}

function filterLabel(filter) {
  return filter === ALL_FILTER ? 'Toutes les stations' : (GENRES[filter]?.label || 'Toutes les stations');
}

module.exports = {
  GENRES,
  GENRE_IDS,
  ALL_FILTER,
  FLAGS,
  STATIONS,
  FEATURED_IDS,
  normalizeText,
  genreOf,
  flagOf,
  qualityOf,
  isKnownGenre,
  getStation,
  stationsByGenre,
  featuredStations,
  searchStations,
  findStation,
  filterLabel,
};
