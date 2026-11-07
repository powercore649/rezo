#!/usr/bin/env node
// scripts/lavalink-probe.js — Teste une liste de nœuds Lavalink v4 et classe les
// plus fiables (uptime, latence, sources disponibles).
//
// ⚠️ Aucun nœud public gratuit n'est garanti 24h/24 : ce script vérifie l'état
// RÉEL au moment où on en a besoin, et permet de basculer sur un nœud de secours.
//
// Usage :
//   node scripts/lavalink-probe.js                 → teste la liste intégrée
//   node scripts/lavalink-probe.js nodes.json      → teste un fichier [{name,host,port,password,secure}]
//   node scripts/lavalink-probe.js --json          → sortie JSON
//   node scripts/lavalink-probe.js --best          → affiche seulement le meilleur nœud

const DEFAULTS = [
  { name: 'Jirayu (SSL)', host: 'lavalink.jirayu.net', port: 443, password: 'youshallnotpass', secure: true },
  { name: 'Jirayu', host: 'lavalink.jirayu.net', port: 13592, password: 'youshallnotpass', secure: false },
  { name: 'Trinium (SSL)', host: 'lavalink-v4.triniumhost.com', port: 443, password: 'free', secure: true },
  { name: 'Nazha (SSL)', host: 'lavalink.nazha.online', port: 443, password: 'nazhafreelava', secure: true },
  { name: 'Serenetia (SSL)', host: 'lavalinkv4.serenetia.com', port: 443, password: 'https://seretia.link/discord', secure: true },
  { name: 'Serenetia', host: 'lavalinkv4.serenetia.com', port: 80, password: 'https://seretia.link/discord', secure: false },
  { name: 'Millohost (SSL)', host: 'lava-v4.millohost.my.id', port: 443, password: 'https://discord.gg/mjS5J2K3ep', secure: true },
  { name: 'Ajie', host: 'lava-v4.ajieblogs.eu.org', port: 80, password: 'https://dsc.gg/ajidevserver', secure: false },
  { name: 'Kasawa', host: 'lava2.kasawa.pro', port: 2334, password: 'youshallnotpass', secure: false },
  { name: 'HeavenCloud', host: 'free-lava.heavencloud.in', port: 4000, password: 'heavencloud.in', secure: false },
  { name: 'Horizxon 1', host: 'lava1.horizxon.studio', port: 80, password: 'horizxon.studio', secure: false },
  { name: 'Horizxon 2', host: 'lava2.horizxon.studio', port: 80, password: 'horizxon.studio', secure: false },
  { name: 'Vexanode', host: 'omega.vexanode.cloud', port: 2031, password: 'https://discord.vexanode.cloud', secure: false },
  { name: 'Minecuta', host: 'lavav4.minecuta.com', port: 2333, password: 'discord.gg/gKuXdHs', secure: false },
  { name: 'NexCloud', host: 'n3.nexcloud.in', port: 2026, password: 'nexcloud', secure: false },
];

const TIMEOUT = 7000;
// `ytsearch:` n'est pas un sourceManager : c'est un préfixe de recherche du
// sourceManager `youtube`. Un nœud sans `youtube` ne sait pas lire YouTube.
const REQUIRED_SOURCES = ['youtube'];

function baseUrl(node) {
  return `${node.secure ? 'https' : 'http'}://${node.host}:${node.port}`;
}

async function getJson(node, route) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl(node)}${route}`, {
      signal: ctrl.signal,
      headers: { Authorization: node.password },
    });
    const ms = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${text ? ` — ${text.replace(/<[^>]*>/g, '').slice(0, 100)}` : ''}`);
    }
    try {
      return { json: JSON.parse(text), ms };
    } catch {
      throw new Error('réponse non-JSON (proxy/parking de domaine ?)');
    }
  } finally {
    clearTimeout(timer);
  }
}

// Lavalink v4 renvoie `version` sous forme d'objet ({ semver, major… }), pas une chaîne.
function readVersion(info) {
  const v = info && info.version;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return v.semver || `${v.major}.${v.minor}.${v.patch}`;
  return null;
}

async function probe(node) {
  try {
    const { json: info, ms } = await getJson(node, '/v4/info');
    const version = readVersion(info);
    if (!version) return { ...node, ok: false, ms, error: 'pas une réponse Lavalink (/v4/info vide)' };

    const isRealLavalink = /lavaplayer/i.test(info.lavaplayer || '') || /lavalink/i.test(info.jvm || '');
    const sources = Array.isArray(info.sourceManagers) ? info.sourceManagers : [];
    const missing = REQUIRED_SOURCES.filter(s => !sources.includes(s));

    // Test réel de résolution : beaucoup de nœuds répondent sur /v4/info mais
    // n'arrivent plus à lire YouTube (blocage IP / clients cassés).
    let search = null;
    if (!missing.length) {
      try {
        const { json: loaded } = await getJson(node, '/v4/loadtracks?identifier=' + encodeURIComponent('ytsearch:lofi hip hop'));
        const type = loaded.loadType;
        const track = (loaded.data && (Array.isArray(loaded.data) ? loaded.data[0] : loaded.data.tracks?.[0])) || null;
        search = {
          type,
          found: Boolean(track && track.encoded),
          detail: loaded.data && loaded.data.message ? String(loaded.data.message).slice(0, 120) : type,
        };
      } catch (err) {
        search = { type: 'ERROR', found: false, detail: err.message };
      }
    }

    let stats = null;
    try {
      stats = (await getJson(node, '/v4/stats')).json;
    } catch { /* stats optionnelles */ }

    const searchOk = missing.length === 0 && search && search.found;

    return {
      ...node,
      ok: Boolean(searchOk),
      ms,
      version,
      search,
      implementation: isRealLavalink ? `Lavalink ${info.lavaplayer || ''}`.trim() : `compatible (${info.lavaplayer || info.jvm || 'inconnu'})`,
      sources,
      plugins: Array.isArray(info.plugins) ? info.plugins.map(p => p && p.name).filter(Boolean) : [],
      players: stats ? stats.players : null,
      playingPlayers: stats ? stats.playingPlayers : null,
      uptime: stats ? stats.uptime : null,
      cpuLoad: stats && stats.cpu ? stats.cpu.lavalinkLoad : null,
      error: missing.length
        ? `source(s) manquante(s) : ${missing.join(', ')}`
        : (search && !search.found ? `YouTube injouable (${search.detail})` : null),
    };
  } catch (err) {
    return { ...node, ok: false, ms: null, error: err.name === 'AbortError' ? 'délai dépassé' : err.message };
  }
}

function humanUptime(ms) {
  if (!ms) return '—';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return d ? `${d}j ${h}h` : `${h}h`;
}

// Score : un nœud qui tourne depuis longtemps et peu chargé est plus « 24/7 » qu'un
// nœud tout juste redémarré, même si ce dernier répond 20 ms plus vite.
function score(r) {
  if (!r.ok) return -1;
  const uptimeDays = (r.uptime || 0) / 86400000;
  const load = r.cpuLoad || 0;
  return uptimeDays * 10 - load * 20 - (r.ms || 0) / 100;
}

(async () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const best = args.includes('--best');
  const file = args.find(a => !a.startsWith('--'));
  let nodes = DEFAULTS;
  if (file) {
    const fs = require('fs');
    nodes = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(nodes)) throw new Error('Le fichier doit contenir un tableau de nœuds.');
  }

  const results = await Promise.all(nodes.map(probe));
  results.sort((a, b) => score(b) - score(a));

  const good = results.filter(r => r.ok);

  if (json) {
    console.log(JSON.stringify(best ? good[0] || null : results, null, 2));
    process.exit(good.length ? 0 : 1);
  }

  if (best) {
    if (!good.length) {
      console.log('Aucun nœud valide.');
      process.exit(1);
    }
    const n = good[0];
    console.log(`${n.secure ? 'https' : 'http'}://${n.host}:${n.port} | ${n.password} | ${n.ms} ms | uptime ${humanUptime(n.uptime)}`);
    process.exit(0);
  }

  console.log('\n🔍 Nœuds Lavalink v4 — test en direct\n');
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${String(r.name).padEnd(18)} ${r.secure ? 'https' : 'http'}://${r.host}:${r.port}`);
    if (r.ok) {
      console.log(`   ${r.ms} ms • ${r.implementation} • ${r.players ?? '?'} joueurs • uptime ${humanUptime(r.uptime)} • charge ${((r.cpuLoad || 0) * 100).toFixed(1)}%`);
      console.log(`   recherche YouTube : ${r.search && r.search.found ? 'OK' : 'KO'} (${r.search ? r.search.type : '—'})`);
      if (r.plugins.length) console.log(`   plugins : ${r.plugins.join(', ')}`);
    } else {
      console.log(`   ${r.error}`);
    }
  }

  console.log(good.length
    ? `\n🏆 Meilleur choix : ${good[0].name} — ${good[0].secure ? 'https' : 'http'}://${good[0].host}:${good[0].port} (${good[0].ms} ms, uptime ${humanUptime(good[0].uptime)})\n`
    : '\n💥 Aucun nœud valide. Réessaie plus tard ou héberge le tien.\n');
  process.exit(good.length ? 0 : 1);
})();
