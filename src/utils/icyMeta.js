'use strict';
// utils/icyMeta.js — « Qu’est-ce qui passe, là, maintenant ? »
//
// Les radios en ligne diffusent leur musique sans API : elles accrochent un
// bloc de métadonnées dans le flux lui-même (protocole Shoutcast/Icecast).
// C’est ce qui permet aux lecteurs d’afficher le titre du morceau.
//
// Le principe, quand le serveur annonce `icy-metaint: N` :
//   • N octets d’audio,
//   • 1 octet de longueur L (la taille du bloc = L × 16),
//   • le bloc, qui contient `StreamTitle='Artiste - Titre';`.
//
// On ouvre donc une seconde connexion, on lit UN bloc, puis on raccroche : le
// flux joué par ffmpeg n’est jamais dupliqué. Tout est borné par un timeout et
// une taille maximale, et une station sans métadonnées n’est pas une erreur —
// beaucoup de flux AAC n’en exposent simplement pas.
//
// Aucune dépendance : c’est http/https natif, donc testable avec un serveur
// local dans tests/radio-smoke.js.

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_BLOCK_BYTES = 16 * 255; // la longueur ICY tient sur un octet ×16
const METADATA_PROBE_BYTES = 4096;

// Certains serveurs (NRJ, RTL…) renvoient une page d’erreur au user-agent
// « node » ou « ffmpeg » : on se présente comme un lecteur ordinaire.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 REZO-Radio/1.0';

// ── Analyse pure ────────────────────────────────────────────────────────────
/**
 * Extrait StreamTitle d’un bloc de métadonnées.
 * @param {Buffer|string} block
 * @returns {string|null}
 */
function parseStreamTitle(block) {
  const text = Buffer.isBuffer(block) ? block.toString('latin1') : String(block || '');
  // Le titre peut contenir une apostrophe échappée : StreamTitle='L\'amour…';
  const match = /StreamTitle\s*=\s*'((?:[^'\\]|\\.)*)'/i.exec(text);
  if (!match) return null;
  const title = match[1]
    .replace(/\\'/g, '\'')
    .replace(/\\\\/g, '\\')
    .replace(/\s+/g, ' ')
    .trim();
  return title ? title.slice(0, 200) : null;
}

/** `icy-metaint` annoncé par le serveur (0 = pas de métadonnées). */
function metaintFrom(headers = {}) {
  const raw = headers['icy-metaint'] ?? headers['Icy-Metaint'];
  const value = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function headerText(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ? String(raw).slice(0, 200) : null;
}

// ── Lecture réseau ──────────────────────────────────────────────────────────
/**
 * Ouvre le flux, lit le premier bloc de métadonnées, raccroche.
 * Ne rejette jamais : renvoie un objet décrivant ce qui s’est passé.
 *
 * @returns {Promise<{ok:boolean, reason?:string, status?:number, url?:string,
 *   contentType?:string, icy?:boolean, metaint?:number, stationName?:string,
 *   title?:string|null}>}
 */
function fetchIcyTitle(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let request = null;

    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { request?.destroy(); } catch { /* déjà fermé */ }
      finish({ ok: false, reason: 'timeout', url });
    }, Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timer.unref?.();

    const connect = (target, redirects) => {
      let parsed;
      try { parsed = new URL(target); } catch { return finish({ ok: false, reason: 'url_invalide', url: target }); }
      const client = parsed.protocol === 'https:' ? https : http;

      request = client.get(parsed, {
        headers: {
          'Icy-MetaData': '1',
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        },
      }, response => {
        const status = response.statusCode || 0;

        if (status >= 300 && status < 400 && response.headers.location && redirects < maxRedirects) {
          response.destroy();
          let next;
          try { next = new URL(response.headers.location, target).toString(); } catch { next = null; }
          if (!next) return finish({ ok: false, reason: 'redirect_invalide', status, url: target });
          return connect(next, redirects + 1);
        }

        if (status !== 200) {
          response.destroy();
          return finish({ ok: false, reason: `http_${status}`, status, url: target });
        }

        const metaint = metaintFrom(response.headers);
        const info = {
          ok: true,
          status,
          url: target,
          contentType: String(response.headers['content-type'] || ''),
          stationName: headerText(response.headers['icy-name']),
          icy: metaint > 0,
          metaint,
          title: null,
        };

        // Pas de métadonnées (fréquent en AAC) : on confirme juste que le flux
        // coule, puis on rend la main sans attendre.
        if (!metaint) {
          let seen = 0;
          response.on('data', chunk => {
            seen += chunk.length;
            if (seen >= METADATA_PROBE_BYTES) {
              response.destroy();
              finish(info);
            }
          });
          response.on('end', () => finish(info));
          response.on('error', () => finish(info));
          return;
        }

        let phase = 'audio';
        let audioLeft = metaint;
        let blockLeft = 0;
        let blockSeen = 0;
        let block = null;

        response.on('data', chunk => {
          let index = 0;
          while (index < chunk.length && !settled) {
            if (phase === 'audio') {
              const take = Math.min(audioLeft, chunk.length - index);
              audioLeft -= take;
              index += take;
              if (audioLeft === 0) phase = 'length';
            } else if (phase === 'length') {
              blockLeft = chunk[index] * 16; // longueur annoncée en mots de 16 octets
              index += 1;
              if (blockLeft === 0) {
                // Bloc vide : le titre n’a pas changé. On arrête là, inutile de
                // consommer un second bloc juste pour confirmer.
                response.destroy();
                finish(info);
              } else if (blockLeft > MAX_BLOCK_BYTES) {
                response.destroy();
                finish({ ...info, ok: false, reason: 'bloc_invalide' });
              } else {
                phase = 'block';
                block = Buffer.allocUnsafe(blockLeft);
                blockSeen = 0;
              }
            } else {
              const take = Math.min(blockLeft - blockSeen, chunk.length - index);
              chunk.copy(block, blockSeen, index, index + take);
              blockSeen += take;
              index += take;
              if (blockSeen >= blockLeft) {
                info.title = parseStreamTitle(block);
                response.destroy();
                finish(info);
              }
            }
          }
        });

        response.on('end', () => finish(info));
        response.on('error', () => finish(info));
      });

      request.on('error', err => finish({ ok: false, reason: err.code || err.message, url: target }));
      request.setTimeout(Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), () => {
        try { request?.destroy(); } catch { /* déjà fermé */ }
        finish({ ok: false, reason: 'timeout', url: target });
      });
    };

    connect(url, 0);
  });
}

// ── Cache ───────────────────────────────────────────────────────────────────
// Plusieurs serveurs peuvent écouter la même station : inutile d’ouvrir une
// connexion par guilde toutes les 25 secondes.
const titleCache = new Map();
const DEFAULT_CACHE_MS = 20000;

/**
 * Titre en direct avec cache mémoire court.
 * @param {string} url
 * @param {{ ttlMs?: number, timeoutMs?: number }} options
 */
async function cachedIcyTitle(url, { ttlMs = DEFAULT_CACHE_MS, timeoutMs } = {}) {
  const key = String(url || '');
  if (!key) return null;
  const hit = titleCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = await fetchIcyTitle(key, { timeoutMs });
  titleCache.set(key, { value, expires: Date.now() + Math.max(0, ttlMs) });
  // Le cache ne doit pas grossir indéfiniment sur un bot qui tourne des jours.
  if (titleCache.size > 100) {
    const now = Date.now();
    for (const [k, entry] of titleCache) if (entry.expires <= now) titleCache.delete(k);
    while (titleCache.size > 100) titleCache.delete(titleCache.keys().next().value);
  }
  return value;
}

function clearTitleCache() {
  titleCache.clear();
}

/** Vérification « ce flux répond-il ? » pour le panneau de réglages. */
async function probeStream(url, { timeoutMs = 6000 } = {}) {
  const info = await fetchIcyTitle(url, { timeoutMs });
  const audio = /^audio\//i.test(info.contentType || '') || info.icy === true;
  return {
    ...info,
    reachable: Boolean(info.ok && audio),
  };
}

module.exports = {
  USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  METADATA_PROBE_BYTES,
  parseStreamTitle,
  metaintFrom,
  fetchIcyTitle,
  cachedIcyTitle,
  clearTitleCache,
  probeStream,
};
