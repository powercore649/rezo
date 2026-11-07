'use strict';
// utils/helpDiagnostics.js — Radiographie du bot, affichée par `/help` → Diagnostic.
//
// Trois questions, et rien d'autre :
//   • le processus va-t-il bien ?   (latence, uptime, mémoire, shards)
//   • la base va-t-elle bien ?      (taille, collections, index, nettoyables)
//   • l'entretien tourne-t-il ?     (dernier passage, documents supprimés)
//
// Chaque mesure est prise « au mieux » : si un shard ne répond pas ou si Mongo
// est injoignable, le diagnostic s'affiche quand même en le disant — un panneau
// de diagnostic qui plante quand quelque chose ne va pas ne sert à rien.

const { EmbedBuilder } = require('discord.js');
const brand = require('./brand');
const { formatBytes } = require('./dbMaintenance');

const C = brand.BRAND.colors;

/** Millisecondes → « 3h 12m ». Volontairement local : le panel ne doit pas
 *  dépendre d'un helper d'une autre vue pour rester testable seul. */
function humanDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function humanDate(value, now = Date.now()) {
  if (!value) return 'jamais';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'date inconnue';
  const diff = now - date.getTime();
  if (diff < 60_000) return 'à l\'instant';
  return `il y a ${humanDuration(diff)}`;
}

/**
 * Rassemble les mesures. Ne lève jamais.
 * @param {object} client              Client Discord (shardé ou non).
 * @param {object} [opts]
 * @param {object} [opts.maintenance]  Module d'entretien (injectable en test).
 * @param {number} [opts.cacheMs]      Cache des statistiques base.
 */
async function gatherDiagnostics(client, { maintenance = require('./dbMaintenance'), cacheMs = 60_000 } = {}) {
  const diag = {
    at: new Date(),
    latency: Number.isFinite(client?.ws?.ping) && client.ws.ping >= 0 ? Math.round(client.ws.ping) : null,
    uptimeMs: Number.isFinite(client?.uptime) ? Date.now() - client.uptime : null,
    guilds: client?.guilds?.cache?.size ?? null,
    users: client?.users?.cache?.size ?? null,
    memory: process.memoryUsage?.().rss ?? null,
    node: process.version,
    shards: null,
    db: null,
    maintenance: null,
    warnings: [],
  };

  // ── Shards ──────────────────────────────────────────────────────────────
  const shard = client?.shard;
  if (shard) {
    const ids = Array.isArray(shard.ids) && shard.ids.length ? shard.ids : [0];
    diag.shards = { sharded: true, ids, count: Number(shard.count) || ids.length, guilds: null, error: null };
    if (typeof shard.fetchClientValues === 'function') {
      try {
        const sizes = await shard.fetchClientValues('guilds.cache.size');
        if (Array.isArray(sizes)) diag.shards.guilds = sizes;
        else diag.warnings.push('les shards n\'ont pas renvoyé leur nombre de serveurs');
      } catch (err) {
        diag.shards.error = err.message;
        diag.warnings.push(`un shard est injoignable (${err.message})`);
      }
    }
  } else {
    diag.shards = { sharded: false, ids: [0], count: 1, guilds: null, error: null };
  }

  // ── Base de données ─────────────────────────────────────────────────────
  try {
    diag.db = await maintenance.collectStats({ cacheMs });
  } catch (err) {
    diag.db = { connected: false, error: err.message };
    diag.warnings.push(`statistiques base indisponibles (${err.message})`);
  }

  // ── Entretien ───────────────────────────────────────────────────────────
  try {
    diag.maintenance = maintenance.getLastRun?.() ?? null;
  } catch { diag.maintenance = null; }

  if (diag.db?.connected === false) diag.warnings.push('MongoDB n\'est pas connecté — les données ne sont pas persistées');
  if (!diag.maintenance) diag.warnings.push('aucun entretien de la base enregistré depuis le démarrage');
  if (diag.db?.prunableTotal > 50_000) {
    diag.warnings.push(`${diag.db.prunableTotal} document(s) nettoyables : l'entretien quotidien va les retirer`);
  }

  return diag;
}

/** Vue pure : construit l'embed depuis les mesures. */
function buildDiagnosticEmbed(diag = {}) {
  const shards = diag.shards || { sharded: false, count: 1, ids: [0] };
  const db = diag.db || { connected: false };

  const processLines = [
    `📡 Latence Gateway : **${diag.latency === null ? '—' : `${diag.latency} ms`}**`,
    `⏱️ En ligne depuis : **${humanDuration(diag.uptimeMs)}**`,
    `🧠 Mémoire du processus : **${diag.memory ? formatBytes(diag.memory) : '—'}**`,
    `🟢 Node ${diag.node || process.version}`,
  ];

  const networkLines = [
    `🌍 Serveurs visibles ici : **${diag.guilds ?? '—'}**`,
    `👥 Membres en cache : **${diag.users ?? '—'}**`,
    shards.sharded
      ? `🧩 Shards : **${shards.count}** · ce processus : **${shards.ids.join(', ')}**`
      : '🧩 Shards : **mode processus unique** (aucun sharding)',
  ];
  if (Array.isArray(shards.guilds)) {
    networkLines.push(`└ Répartition : ${shards.guilds.map((n, i) => `#${i} → ${n}`).join(' · ')}`);
  }

  const dbLines = [];
  if (db.connected) {
    dbLines.push(
      `🗄️ Base **${db.database || '?'}** · **${db.collections ?? '?'}** collections · **${db.objects ?? '?'}** documents`,
      `📦 Données **${db.dataSize === null ? '—' : formatBytes(db.dataSize)}** · stockage **${db.storageSize === null ? '—' : formatBytes(db.storageSize)}**`,
      `🔎 **${db.indexes ?? '?'}** index (${db.indexSize === null ? '—' : formatBytes(db.indexSize)})`,
    );
    if (Array.isArray(db.prunable) && db.prunable.length) {
      const top = [...db.prunable].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5);
      dbLines.push(
        `♻️ Nettoyables maintenant : **${db.prunableTotal ?? top.reduce((s, p) => s + (p.count || 0), 0)}**`,
        ...top.map(p => `└ ${p.label} — **${p.count}** (~${p.total ?? '?'} au total, ${p.days}j de rétention)`),
      );
    }
  } else {
    dbLines.push(
      '⚠️ **MongoDB non connecté** — le bot tourne sans persistance.',
      db.error ? `└ ${db.error}` : '└ Vérifiez `MONGODB_URI` dans `.env`.',
    );
  }

  const run = diag.maintenance;
  const maintenanceLines = run
    ? [
      `🕓 Dernier entretien : **${humanDate(run.finishedAt)}**`,
      `🧹 Documents supprimés : **${run.deleted ?? 0}** · durées de vie appliquées : **${run.results?.length ?? 0}**`,
      `⚙️ Durée du nettoyage : **${run.durationMs ?? 0} ms**${run.errors ? ` · **${run.errors} erreur(s)**` : ''}`,
    ]
    : ['🕓 Aucun entretien depuis le démarrage.', 'Le cron `db-maintenance` passe chaque nuit à **04:00** (shard 0).'];

  const embed = new EmbedBuilder()
    .setColor(diag.warnings?.length ? C.warning : C.success)
    .setAuthor({ name: `${brand.BRAND.name} • Diagnostic` })
    .setTitle('🩺 État du bot, du réseau et de la base')
    .addFields(
      { name: '⚙️ Processus', value: processLines.join('\n').slice(0, 1024), inline: true },
      { name: '🌐 Réseau', value: networkLines.join('\n').slice(0, 1024), inline: true },
      { name: '🗄️ Base de données', value: dbLines.join('\n').slice(0, 1024) },
      { name: '🧽 Entretien', value: maintenanceLines.join('\n').slice(0, 1024) },
    )
    .setFooter({ text: brand.footer(diag.warnings?.length ? `${diag.warnings.length} point(s) d'attention` : 'Tout est nominal') })
    .setTimestamp();

  if (diag.warnings?.length) {
    embed.addFields({
      name: `⚠️ Points d'attention (${diag.warnings.length})`,
      value: diag.warnings.map(w => `• ${w}`).join('\n').slice(0, 1024),
    });
  }
  return embed;
}

module.exports = {
  humanDuration,
  humanDate,
  gatherDiagnostics,
  buildDiagnosticEmbed,
};
