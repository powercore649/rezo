'use strict';
// utils/guildStatus.js — La carte de statut du bot, propre à chaque serveur.
//
// Discord n'autorise qu'UNE présence par bot : impossible d'afficher « Joue à
// <serveur A> » pour un serveur et autre chose pour le suivant. Ce fichier
// couvre donc ce qui peut réellement varier d'un serveur à l'autre :
//
//   • le surnom du bot dans le serveur (setNickname, natif et par serveur) ;
//   • l'état annoncé (opérationnel, maintenance, incident…) ;
//   • la carte publiée dans un salon : titre, texte, couleur, image, pied ;
//   • les blocs affichés (uptime, latence, membres, modules, licence).
//
// Tout est pur ou injectable : le rendu se teste avec un faux client et un
// faux serveur, et aucune fonction n'écrit en base sans le vouloir.

const { EmbedBuilder } = require('discord.js');
const { footer: brandFooter } = require('./brand');
const GuildStatus = require('../models/GuildStatus');

// Niveaux d'état : un emoji, un libellé et une couleur, comme les crans d'un
// statut public. `auto` n'a pas de couleur propre : il est calculé.
const LEVELS = {
  operationnel: { emoji: '🟢', label: 'Opérationnel', color: 0x57F287 },
  info: { emoji: '🔵', label: 'Information', color: 0x5BC0EB },
  degrade: { emoji: '🟠', label: 'Service dégradé', color: 0xFAA61A },
  maintenance: { emoji: '🟣', label: 'Maintenance', color: 0x9B59B6 },
  incident: { emoji: '🔴', label: 'Incident', color: 0xED4245 },
};

const LEVEL_KEYS = ['auto', ...Object.keys(LEVELS)];

const DEFAULTS = {
  enabled: true,
  level: 'auto',
  label: null,
  statusText: null,
  title: null,
  description: null,
  color: null,
  image: null,
  footerText: null,
  nickname: null,
  channelId: null,
  messageId: null,
  showUptime: true,
  showPing: true,
  showMembers: true,
  showCommands: true,
  showLicense: true,
};

const LICENSE_LABEL = {
  active: '✅ Clé active',
  none: '🆓 Version Community',
  revoked: '⛔ Clé révoquée',
  expired: '⌛ Clé expirée',
  trial: '🎁 Essai gratuit en cours',
};

// ─── Lecture de la configuration ───────────────────────────────────────────

/** Configuration du serveur, toujours complète (jamais `null`). */
async function getConfig(guildId, { timeout = 2500 } = {}) {
  if (!guildId) return { ...DEFAULTS };
  const doc = await withTimeout((async () => {
    let query = GuildStatus.findOne({ guildId });
    if (typeof query.lean === 'function') query = query.lean();
    return await query;
  })(), timeout, null);
  return { ...DEFAULTS, ...(doc || {}) };
}

function withTimeout(promise, ms, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ─── État affiché ──────────────────────────────────────────────────────────

/**
 * Niveau réellement annoncé.
 * Un niveau explicite (`warning`, `maintenance`…) est respecté tel quel.
 * `auto` se déduit de la santé mesurable du bot — jamais d'un chiffre inventé.
 */
function resolveLevel(config = {}, metrics = {}) {
  const declared = LEVELS[config.level] ? config.level : 'auto';
  if (declared !== 'auto') return declared;

  const status = Number(metrics.wsStatus);
  const ping = Number(metrics.ping);
  if (Number.isFinite(status) && status !== 0) return 'incident';
  if (Number.isFinite(ping) && ping >= 900) return 'incident';
  if (Number.isFinite(ping) && ping >= 450) return 'degrade';
  return 'operationnel';
}

function levelMeta(level) {
  return LEVELS[level] || LEVELS.operationnel;
}

function metricsOf(client) {
  return {
    ping: client?.ws?.ping,
    wsStatus: client?.ws?.status,
  };
}

// ─── Formatage ─────────────────────────────────────────────────────────────

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** « 3j 4h », « 12 min », « 8 s ». */
function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}j ${hours % 24}h`;
}

/** « #8B1A1A » ou « 8B1A1A » → entier Discord, sinon `null`. */
function parseColor(input) {
  const raw = String(input ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return Number.parseInt(raw, 16);
}

/** Une URL d'image utilisable : http(s) uniquement, jamais `javascript:`. */
function safeImageUrl(input) {
  const raw = String(input ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(raw)) return null;
  return clip(raw, 2048);
}

function licenseLabel(status, license = null) {
  if (license?.tier && LICENSE_LABEL[license.tier]) return LICENSE_LABEL[license.tier];
  return LICENSE_LABEL[status] || LICENSE_LABEL.none;
}

// ─── Rendu de la carte ─────────────────────────────────────────────────────

/**
 * Construit la carte de statut du serveur.
 * `options.license` évite une lecture supplémentaire quand l'appelant l'a déjà.
 * Le rendu ne lève jamais : une donnée absente disparaît au lieu de s'afficher
 * « undefined ».
 */
function buildStatusEmbed(client, guild, config = {}, { by = null, admin = false, license = null } = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const level = resolveLevel(cfg, metricsOf(client));
  const meta = levelMeta(level);

  const title = clip(cfg.title || `🛰️ Statut — ${guild?.name || 'ce serveur'}`, 256);
  const headline = `${meta.emoji} **${cfg.label || meta.label}**`;
  const description = clip([
    headline,
    cfg.statusText ? String(cfg.statusText) : null,
    cfg.description ? String(cfg.description) : null,
  ].filter(Boolean).join('\n\n'), 4096);

  const embed = new EmbedBuilder()
    .setColor(parseColor(cfg.color) ?? meta.color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: brandFooter(by ? `${cfg.footerText || 'Statut du serveur'} • demandé par ${by}` : (cfg.footerText || 'Statut du serveur')) })
    .setTimestamp();

  const fields = [];

  if (cfg.showUptime || cfg.showPing) {
    const lines = [];
    if (cfg.showUptime) lines.push(`**En ligne depuis :** ${humanDuration(client?.uptime)}`);
    if (cfg.showPing) {
      lines.push(`**Latence :** ${Number.isFinite(client?.ws?.ping) ? `${client.ws.ping} ms` : '—'}`);
    }
    fields.push({ name: '🤖 Bot', value: lines.join('\n'), inline: true });
  }

  if (cfg.showMembers) {
    fields.push({
      name: '🏰 Serveur',
      value: [
        `**Membres :** ${Number(guild?.memberCount || 0).toLocaleString('fr-FR')}`,
        `**Boosts :** ${Number(guild?.premiumSubscriptionCount || 0).toLocaleString('fr-FR')}`,
      ].join('\n'),
      inline: true,
    });
  }

  if (cfg.showCommands) {
    fields.push({
      name: '🧩 Modules',
      value: [
        `**Commandes :** ${client?.commands?.size ?? 0}`,
        `**Shards :** ${client?.shard?.count ?? 1}`,
      ].join('\n'),
      inline: true,
    });
  }

  if (cfg.showLicense) {
    // Licence illisible (base momentanément indisponible) : on écrit « — »
    // plutôt que d'annoncer « Community » à un serveur qui a payé.
    fields.push({
      name: '🔐 Licence',
      value: license ? licenseLabel(license.status, license.license) : '—',
      inline: true,
    });
  }

  if (admin) {
    fields.push({
      name: '⚙️ Personnaliser',
      value: '`/setting` → **Outils** → **Statut du bot** : surnom du bot ici, état, couleurs et salon de publication.',
      inline: false,
    });
  }

  if (fields.length) embed.addFields(fields.slice(0, 25));

  const image = safeImageUrl(cfg.image);
  if (image) embed.setImage(image);

  return embed;
}

// ─── Surnom du bot, par serveur ────────────────────────────────────────────

/**
 * Applique le surnom configuré au membre-bot de CE serveur.
 * Un surnom vide retire le surnom personnalisé (retour au nom global).
 */
async function applyNickname(guild, config = {}) {
  const me = guild?.members?.me;
  if (!me || typeof me.setNickname !== 'function') {
    return { ok: false, error: 'Le bot n’est pas résolu sur ce serveur.' };
  }
  const desired = config.nickname ? clip(String(config.nickname), 32) : null;
  if ((me.nickname || null) === desired) return { ok: true, changed: false };

  try {
    await me.setNickname(desired);
    return { ok: true, changed: true };
  } catch {
    return { ok: false, error: 'Surnom refusé par Discord — il faut la permission « Gérer les pseudos ».' };
  }
}

// ─── Publication de la carte ───────────────────────────────────────────────

async function resolveChannel(client, guild, channelId) {
  if (!channelId) return null;
  const cached = guild?.channels?.cache?.get?.(channelId);
  if (cached) return cached;
  return client?.channels?.fetch ? await client.channels.fetch(channelId).catch(() => null) : null;
}

/**
 * Licence du serveur, bornée dans le temps : elle n'est qu'un bloc décoratif
 * de la carte, elle ne doit jamais retarder une publication ni un aperçu.
 * Une licence illisible vaut « inconnue », jamais une affirmation fausse.
 */
async function readLicense(guildId, { timeout = 800 } = {}) {
  if (!guildId) return null;
  try {
    const gate = require('./licenseGate');
    return await withTimeout(gate.getLicenseStatus(guildId), timeout, null);
  } catch {
    return null;
  }
}

/**
 * Publie la carte dans le salon configuré : édite le message existant s'il est
 * retrouvé, sinon en envoie un neuf et mémorise son identifiant.
 */
async function publish(client, guild, config = {}) {
  if (!guild?.id) return { ok: false, error: 'Serveur inconnu.' };
  if (!config.channelId) return { ok: false, error: 'Aucun salon de publication choisi.' };

  const channel = await resolveChannel(client, guild, config.channelId);
  if (!channel) return { ok: false, error: 'Salon de publication introuvable (supprimé ou sans accès).' };
  if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) {
    return { ok: false, error: 'Ce salon n’accepte pas de messages.' };
  }

  const license = await readLicense(guild.id);
  const embed = buildStatusEmbed(client, guild, config, { license });

  if (config.messageId) {
    const existing = await channel.messages?.fetch?.(config.messageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [embed] }).catch(() => null);
      return { ok: true, mode: 'edit', url: existing.url || null };
    }
  }

  try {
    const sent = await channel.send({ embeds: [embed] });
    await GuildStatus.updateOne({ guildId: guild.id }, { $set: { messageId: sent.id, updatedAt: new Date() } }).catch(() => {});
    return { ok: true, mode: 'send', url: sent.url || null };
  } catch (err) {
    return { ok: false, error: `Envoi impossible : ${err.message}` };
  }
}

/**
 * Après un enregistrement dans le panel : surnom + carte, sans jamais bloquer
 * la réponse à l'administrateur (les erreurs sont rendues, pas lancées).
 */
async function sync(client, guild, { nickname = true, card = true } = {}) {
  if (!guild?.id) return { ok: false, error: 'Serveur inconnu.' };
  const config = await getConfig(guild.id);
  if (config.enabled === false) return { ok: true, skipped: true };

  const result = { ok: true, nickname: null, card: null };
  if (nickname) result.nickname = await applyNickname(guild, config);
  if (card && config.channelId) result.card = await publish(client, guild, config);
  return result;
}

module.exports = {
  LEVELS,
  LEVEL_KEYS,
  DEFAULTS,
  LICENSE_LABEL,
  getConfig,
  resolveLevel,
  levelMeta,
  metricsOf,
  buildStatusEmbed,
  applyNickname,
  publish,
  sync,
  parseColor,
  safeImageUrl,
  humanDuration,
  licenseLabel,
  readLicense,
};
