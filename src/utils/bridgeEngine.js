'use strict';
// utils/bridgeEngine.js — Le moteur du pont inter-serveurs.
//
// Un serveur relie UN salon à UN canal commun. Tout message écrit dans ce salon
// part vers les autres serveurs du même canal, avec le pseudo et l'avatar de son
// auteur (webhook) : la conversation se lit comme un vrai salon, alors que les
// membres ne partagent aucun serveur.
//
// Ce que le moteur garantit :
//   • aucun ping ne traverse les serveurs (`allowedMentions` vide partout) ;
//   • les filtres et l'anti-spam sont appliqués AVANT tout envoi ;
//   • une suppression est propagée partout (documents BridgeMessage) ;
//   • un webhook refusé par Discord ne perd pas le message : repli en embed,
//     puis en message simple ;
//   • aucune erreur d'un serveur distant n'interrompt les autres.
//
// Le fichier est volontairement séparé de la commande : les décisions (faut-il
// relayer ? quel contenu ?) sont pures, donc testables sans Discord ni MongoDB.

const { EmbedBuilder } = require('discord.js');
const hubs = require('./bridgeHubs');
const { COLORS } = require('./embeds');
const BridgeConfig = require('../models/BridgeConfig');
const BridgeMessage = require('../models/BridgeMessage');

const WEBHOOK_NAME = 'REZO · Pont';
const MAX_CONTENT = 1900;
const MAX_RELAYS = 60;
const MAX_ATTACHMENT_URLS = 4;
// Court : une activation faite dans /setting doit être prise en compte vite.
const CONFIG_TTL_MS = 10_000;
const DUPLICATE_MIN_LENGTH = 30;
const DUPLICATE_WINDOW_MS = 30_000;
const SLOW_WARNING_MS = 5_000;

// Valeurs utilisées quand le serveur n'a encore rien enregistré : le panneau
// affiche ainsi de vrais réglages dès la première ouverture.
const DEFAULTS = {
  enabled: false,
  channelId: null,
  hub: hubs.DEFAULT_HUB,
  webhookId: null,
  showServerName: true,
  relayReplies: true,
  blockBots: true,
  blockLinks: false,
  blockInvites: true,
  blockAttachments: false,
  minLength: 2,
  maxLength: 1200,
  rateLimit: 4,
  rateWindowSeconds: 15,
  blockedGuilds: [],
  totalRelayed: 0,
  totalReceived: 0,
  lastRelayAt: null,
};

const configCache = new Map();
const webhookCache = new Map();
const buckets = new Map();
const lastContent = new Map();

// ─── Petits utilitaires ──────────────────────────────────────────────────────

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Valeur effective d'un réglage : le document, sinon la valeur par défaut. */
function eff(cfg, key) {
  const raw = cfg ? cfg[key] : undefined;
  if (raw === undefined || raw === null) return DEFAULTS[key];
  return raw;
}

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function attachmentsOf(message) {
  const list = message?.attachments;
  if (!list) return [];
  // Collection discord.js, Map ou tableau : on ne dépend que de l'itération.
  const raw = typeof list.values === 'function'
    ? Array.from(list.values())
    : (Array.isArray(list) ? list : []);
  const items = raw.map(attachment => ({
    url: attachment?.url || attachment?.proxyURL || null,
    name: attachment?.name || 'fichier',
  }));
  return items.filter(item => item.url).slice(0, MAX_ATTACHMENT_URLS);
}

async function resolve(query, fallback = null) {
  if (!query) return fallback;
  try {
    if (typeof query.lean === 'function') return await query.lean();
    return await query;
  } catch {
    return fallback;
  }
}

async function asArray(query) {
  const value = await resolve(query, []);
  return Array.isArray(value) ? value : [];
}

// ─── Décisions pures ─────────────────────────────────────────────────────────

/** Le message a-t-il le droit de traverser ? (filtres du serveur d'origine) */
function evaluateMessage(message, cfg = DEFAULTS) {
  if (!message) return { ok: false, reason: 'empty' };
  if (eff(cfg, 'enabled') !== true) return { ok: false, reason: 'disabled' };
  if (message.system) return { ok: false, reason: 'system' };
  if (message.deleted) return { ok: false, reason: 'deleted' };
  if (message.author?.bot && eff(cfg, 'blockBots') !== false) return { ok: false, reason: 'bot' };

  const text = String(message.content || '').trim();
  const attachments = attachmentsOf(message);
  if (!text && !attachments.length) return { ok: false, reason: 'empty' };
  if (text && text.length < clampNumber(eff(cfg, 'minLength'), 1, 200, 2)) {
    return { ok: false, reason: 'too-short' };
  }

  const hasInvite = /(?:discord\.(?:gg|me|com\/invite)\/|discord(?:app)?\.com\/invite\/)/i.test(text);
  const hasLink = /https?:\/\//i.test(text);
  if (eff(cfg, 'blockInvites') !== false && hasInvite) return { ok: false, reason: 'invite' };
  if (eff(cfg, 'blockLinks') === true && hasLink) return { ok: false, reason: 'link' };
  if (eff(cfg, 'blockAttachments') === true && attachments.length) return { ok: false, reason: 'attachment' };

  return { ok: true, text, attachments };
}

/**
 * Anti-spam glissant, par membre et par serveur. Un message identique et long
 * répété coup sur coup ne consomme pas de place : il est simplement ignoré.
 */
function takeSlot(key, cfg = DEFAULTS, now = Date.now(), text = '') {
  const limit = clampNumber(eff(cfg, 'rateLimit'), 1, 20, 4);
  const windowMs = clampNumber(eff(cfg, 'rateWindowSeconds'), 3, 300, 15) * 1000;
  const bucket = (buckets.get(key) || []).filter(stamp => now - stamp < windowMs);

  if (bucket.length >= limit) {
    buckets.set(key, bucket);
    return { ok: false, reason: 'rate', retryAfterMs: Math.max(0, windowMs - (now - bucket[0])) };
  }

  const previous = lastContent.get(key);
  if (text
    && text.length >= DUPLICATE_MIN_LENGTH
    && previous
    && previous.text === text
    && now - previous.at < DUPLICATE_WINDOW_MS) {
    return { ok: false, reason: 'duplicate', retryAfterMs: DUPLICATE_WINDOW_MS - (now - previous.at) };
  }

  bucket.push(now);
  buckets.set(key, bucket);
  if (text) lastContent.set(key, { text, at: now });
  pruneMemory(now);
  return { ok: true, remaining: limit - bucket.length };
}

function pruneMemory(now) {
  if (buckets.size > 4000) {
    for (const [key, stamps] of buckets) {
      if (!stamps.length || now - stamps[stamps.length - 1] > 60 * 60 * 1000) buckets.delete(key);
    }
  }
  if (lastContent.size > 4000) {
    for (const [key, entry] of lastContent) {
      if (now - entry.at > 60 * 60 * 1000) lastContent.delete(key);
    }
  }
}

function resetRate() {
  buckets.clear();
  lastContent.clear();
}

/**
 * Corps du message relayé : la réponse citée (facultative), le texte, les
 * pièces jointes puis, en petit, le nom du serveur d'origine.
 */
function buildRelayContent({ text = '', attachments = [], guildName = '', showServerName = true, replyTo = null, maxLength = DEFAULTS.maxLength } = {}) {
  const limit = clampNumber(maxLength, 50, 1800, DEFAULTS.maxLength);
  const parts = [];
  if (replyTo) parts.push(`-# ↪️ réponse à **${clip(cleanName(replyTo), 60)}**`);
  if (text) parts.push(clip(text, limit));
  const urls = attachments.map(attachment => attachment?.url).filter(Boolean).slice(0, MAX_ATTACHMENT_URLS);
  if (urls.length) parts.push(urls.join('\n'));
  if (showServerName !== false && guildName) parts.push(`-# 🌐 ${cleanName(guildName)}`);
  return clip(parts.join('\n'), MAX_CONTENT);
}

/** Charge utile du webhook : pseudo, avatar et contenu, sans aucun ping. */
function buildRelayPayload({ message, cfg = DEFAULTS, guildName = '', replyTo = null } = {}) {
  const display = message?.member?.displayName || message?.author?.username || message?.author?.tag || 'Membre';
  const avatarURL = typeof message?.author?.displayAvatarURL === 'function'
    ? message.author.displayAvatarURL({ extension: 'png', size: 128 })
    : null;

  return {
    username: clip(cleanName(display) || 'Membre', 80),
    avatarURL,
    content: buildRelayContent({
      text: String(message?.content || '').trim(),
      attachments: attachmentsOf(message),
      guildName,
      showServerName: eff(cfg, 'showServerName') !== false,
      replyTo: eff(cfg, 'relayReplies') !== false ? replyTo : null,
      maxLength: eff(cfg, 'maxLength'),
    }),
    allowedMentions: { parse: [], roles: [], users: [], repliedUser: false },
  };
}

/** Requête des serveurs qui doivent recevoir le message. */
function targetQuery(cfg = DEFAULTS) {
  const hub = hubs.isValidHub(cfg?.hub) ? String(cfg.hub).toLowerCase() : hubs.DEFAULT_HUB;
  const excluded = [String(cfg?.guildId || ''), ...((cfg?.blockedGuilds || []).map(String))];
  return {
    enabled: true,
    hub,
    channelId: { $ne: null },
    guildId: { $nin: excluded },
    blockedGuilds: { $ne: cfg?.guildId || null },
  };
}

// ─── Accès aux données ───────────────────────────────────────────────────────

async function getConfig(guildId, { fresh = false } = {}) {
  const key = String(guildId);
  if (!fresh) {
    const hit = configCache.get(key);
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.doc;
  }
  const doc = await resolve(BridgeConfig.findOne({ guildId: key }), null);
  configCache.set(key, { doc, at: Date.now() });
  return doc;
}

function clearConfigCache(guildId) {
  if (guildId) configCache.delete(String(guildId));
  else configCache.clear();
}

async function updateConfig(guildId, patch) {
  const doc = await BridgeConfig.findOneAndUpdate(
    { guildId: String(guildId) },
    { $set: { ...patch, updatedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch(() => null);
  clearConfigCache(guildId);
  return doc;
}

async function findMapping(filter) {
  return resolve(BridgeMessage.findOne(filter), null);
}

async function resolveChannel(client, guildId, channelId) {
  if (!client || !guildId || !channelId) return null;
  const guild = client.guilds?.cache?.get(guildId)
    || await client.guilds?.fetch?.(guildId).catch?.(() => null)
    || null;
  if (!guild) return null;
  return guild.channels?.cache?.get(channelId)
    || await guild.channels?.fetch?.(channelId).catch?.(() => null)
    || null;
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

async function ensureWebhook(channel) {
  if (!channel) return null;
  const cached = webhookCache.get(channel.id);
  if (cached) return cached;

  const hooks = await Promise.resolve(channel.fetchWebhooks?.()).catch(() => null);
  const existing = hooks && typeof hooks.find === 'function'
    ? hooks.find(hook => hook?.name === WEBHOOK_NAME && hook?.token)
    : null;

  const webhook = existing
    || await Promise.resolve(channel.createWebhook?.({ name: WEBHOOK_NAME, reason: 'Pont inter-serveurs REZO' })).catch(() => null);

  if (webhook) {
    webhookCache.set(channel.id, webhook);
    // Les messages relayés passent par ce webhook : l'anti-spam doit savoir
    // qu'il appartient au bot, sinon un pont actif serait pris pour du spam.
    require('./internalWebhooks').markOwn(webhook.id);
  }
  return webhook || null;
}

async function removeWebhook(client, cfg) {
  if (!client || !cfg?.webhookId) return false;
  try {
    const hook = await client.fetchWebhook(cfg.webhookId, cfg.webhookToken || undefined);
    await hook.delete('Pont inter-serveurs désactivé');
    return true;
  } catch {
    return false;
  }
}

function buildFallbackEmbed(payload) {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({
      name: clip(payload.username || 'Membre', 100),
      iconURL: payload.avatarURL || undefined,
    })
    .setDescription(clip(payload.content || '*Message vide*', 4000));
}

/**
 * Envoi avec trois niveaux de repli : webhook avec pseudo et avatar, webhook
 * sans pseudo (un nom refusé par Discord ne doit pas perdre le message), puis
 * embed classique dans le salon.
 */
async function deliver(channel, payload) {
  const webhook = await ensureWebhook(channel);
  if (webhook) {
    try {
      return { message: await webhook.send({ ...payload, wait: true }), via: 'webhook' };
    } catch {
      webhookCache.delete(channel.id);
      const retry = await ensureWebhook(channel);
      if (retry) {
        try {
          return {
            message: await retry.send({ content: payload.content, allowedMentions: payload.allowedMentions, wait: true }),
            via: 'webhook-noname',
          };
        } catch { /* on tombe sur l'embed */ }
      }
    }
  }
  const message = await Promise.resolve(channel.send?.({
    embeds: [buildFallbackEmbed(payload)],
    allowedMentions: { parse: [] },
  })).catch(() => null);
  return message ? { message, via: 'embed' } : null;
}

// ─── Relier / délier ─────────────────────────────────────────────────────────

async function linkChannel({ client = null, guild = null, channel = null, hub = null, userId = null } = {}) {
  if (!guild || !channel) return { ok: false, error: 'Serveur ou salon introuvable.' };
  if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) {
    return { ok: false, error: 'Choisis un salon textuel : le pont ne peut pas relier un salon vocal.' };
  }
  if (typeof channel.isThread === 'function' && channel.isThread()) {
    return { ok: false, error: 'Relie le salon parent : un fil ne peut pas porter de webhook.' };
  }

  const needed = ['ManageWebhooks', 'ManageMessages', 'SendMessages', 'EmbedLinks'];
  const permissions = channel.permissionsFor?.(guild.members?.me);
  if (permissions && typeof permissions.has === 'function') {
    const missing = needed.filter(permission => !permissions.has(permission));
    if (missing.length) {
      return { ok: false, error: `Permissions manquantes dans <#${channel.id}> : **${missing.join(', ')}**.` };
    }
  }

  const hubId = hubs.isValidHub(hub) ? String(hub).toLowerCase() : hubs.DEFAULT_HUB;
  const previous = await getConfig(guild.id, { fresh: true });
  if (previous?.webhookId && previous.channelId && previous.channelId !== channel.id) {
    await removeWebhook(client, previous);
  }

  const webhook = await ensureWebhook(channel);
  if (!webhook?.id) {
    return { ok: false, error: 'Impossible de créer le webhook du pont dans ce salon (permission « Gérer les webhooks » ?).' };
  }

  const doc = await updateConfig(guild.id, {
    enabled: true,
    channelId: channel.id,
    hub: hubId,
    webhookId: webhook.id,
    webhookToken: webhook.token || null,
    updatedBy: userId || null,
  });
  if (!doc) return { ok: false, error: 'Enregistrement impossible — réessaie dans un instant.' };
  return { ok: true, config: doc, hub: hubId, webhook };
}

async function unlinkChannel(guildId, client = null) {
  const cfg = await getConfig(guildId, { fresh: true });
  if (cfg) await removeWebhook(client, cfg);
  if (cfg?.channelId) webhookCache.delete(cfg.channelId);
  const doc = await updateConfig(guildId, {
    enabled: false,
    channelId: null,
    webhookId: null,
    webhookToken: null,
  });
  return Boolean(doc);
}

/** Départ du bot : plus de webhook traînant sur le serveur. */
async function releaseGuild(guildId, client = null) {
  await unlinkChannel(guildId, client).catch(() => false);
  if (typeof BridgeMessage.deleteMany === 'function') {
    await BridgeMessage.deleteMany({ sourceGuildId: String(guildId) }).catch(() => null);
  }
  return true;
}

// ─── Relais ──────────────────────────────────────────────────────────────────

async function warnSlow(message) {
  const sent = await Promise.resolve(message.channel?.send?.({
    content: '⏳ **Doucement !** Ton message n’est pas parti sur le pont (anti-spam).',
    allowedMentions: { parse: [] },
  })).catch(() => null);
  if (sent?.delete) {
    const timer = setTimeout(() => sent.delete().catch(() => {}), SLOW_WARNING_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return Boolean(sent);
}

async function resolveReplyAuthor(message) {
  const reference = message?.reference?.messageId;
  if (!reference) return null;
  const doc = await findMapping({
    $or: [{ sourceMessageId: reference }, { 'relays.messageId': reference }],
  });
  return doc?.authorName || null;
}

async function relayMessage(message, client, options = {}) {
  const guild = message?.guild;
  const channel = message?.channel;
  if (!guild || !channel) return { relayed: 0, reason: 'no-guild' };

  const cfg = options.config || await getConfig(guild.id);
  if (!cfg || cfg.enabled !== true) return { relayed: 0, reason: 'disabled' };
  if (String(cfg.channelId) !== String(channel.id)) return { relayed: 0, reason: 'other-channel' };

  const verdict = evaluateMessage(message, cfg);
  if (!verdict.ok) return { relayed: 0, reason: verdict.reason };

  const authorId = message.author?.id || 'inconnu';
  const quota = takeSlot(`${guild.id}:${authorId}`, cfg, options.now || Date.now(), verdict.text);
  if (!quota.ok) {
    if (!options.silent) await warnSlow(message).catch(() => {});
    return { relayed: 0, reason: quota.reason, retryAfterMs: quota.retryAfterMs };
  }

  const replyTo = await resolveReplyAuthor(message).catch(() => null);
  const payload = buildRelayPayload({ message, cfg, guildName: guild.name, replyTo });
  const targets = await asArray(BridgeConfig.find(targetQuery({ ...cfg, guildId: guild.id })));

  const relays = [];
  await Promise.all(targets.slice(0, MAX_RELAYS).map(async target => {
    try {
      const targetChannel = await resolveChannel(client, target.guildId, target.channelId);
      if (!targetChannel) return;
      const sent = await deliver(targetChannel, payload);
      if (!sent?.message?.id) return;
      relays.push({
        guildId: String(target.guildId),
        channelId: String(target.channelId),
        messageId: String(sent.message.id),
      });
    } catch { /* un serveur distant ne bloque jamais les autres */ }
  }));

  if (!relays.length) return { relayed: 0, reason: 'no-target' };

  if (typeof BridgeMessage.create === 'function') {
    await BridgeMessage.create({
      hub: cfg.hub,
      sourceGuildId: guild.id,
      sourceGuildName: guild.name,
      sourceChannelId: channel.id,
      sourceMessageId: message.id,
      authorId,
      authorName: message.member?.displayName || message.author?.username || 'Membre',
      content: payload.content,
      relays,
    }).catch(() => null);
  }

  await BridgeConfig.updateOne(
    { guildId: guild.id },
    { $inc: { totalRelayed: 1 }, $set: { lastRelayAt: new Date() } },
  ).catch(() => null);

  const targetIds = [...new Set(relays.map(relay => relay.guildId))];
  await BridgeConfig.updateMany(
    { guildId: { $in: targetIds } },
    { $inc: { totalReceived: 1 } },
  ).catch(() => null);

  return { relayed: relays.length, relays };
}

/**
 * Suppression propagée. Deux cas :
 *   • c'est le message d'origine qui est supprimé → on retire toutes les copies ;
 *   • c'est une copie qui est supprimée (modération locale) → on retire
 *     l'original et les autres copies.
 */
async function handleDeletedMessage(client, message) {
  if (!message?.id) return 0;
  const doc = await findMapping({
    $or: [{ sourceMessageId: message.id }, { 'relays.messageId': message.id }],
  });
  if (!doc) return 0;

  const copies = [];
  if (doc.sourceMessageId !== message.id) {
    copies.push({
      guildId: doc.sourceGuildId,
      channelId: doc.sourceChannelId,
      messageId: doc.sourceMessageId,
    });
  }
  for (const relay of doc.relays || []) {
    if (relay?.messageId && relay.messageId !== message.id) copies.push(relay);
  }

  let removed = 0;
  await Promise.all(copies.slice(0, MAX_RELAYS).map(async copy => {
    const channel = await resolveChannel(client, copy.guildId, copy.channelId);
    if (!channel?.messages?.fetch) return;
    const target = await Promise.resolve(channel.messages.fetch(copy.messageId)).catch(() => null);
    if (!target?.delete) return;
    await Promise.resolve(target.delete()).catch(() => null);
    removed++;
  }));

  if (typeof BridgeMessage.deleteOne === 'function') {
    await BridgeMessage.deleteOne({ _id: doc._id }).catch(() => null);
  }
  return removed;
}

// ─── Statistiques réseau ─────────────────────────────────────────────────────

/** Serveurs actuellement reliés au même canal commun (hors serveur courant). */
async function peerServers(cfg, client = null) {
  const hub = hubs.isValidHub(cfg?.hub) ? String(cfg.hub).toLowerCase() : hubs.DEFAULT_HUB;
  const rows = await asArray(BridgeConfig.find({
    enabled: true,
    hub,
    channelId: { $ne: null },
    guildId: { $ne: String(cfg?.guildId || '') },
  }));
  return rows.slice(0, 25).map(row => ({
    id: String(row.guildId),
    name: client?.guilds?.cache?.get?.(row.guildId)?.name || `Serveur ${String(row.guildId).slice(-4)}`,
  }));
}

async function networkStats() {
  const rows = await asArray(BridgeConfig.find({ enabled: true, channelId: { $ne: null } }));
  const perHub = new Map(hubs.HUBS.map(hub => [hub.id, 0]));
  let relayed = 0;
  let received = 0;
  for (const row of rows) {
    perHub.set(row.hub, (perHub.get(row.hub) || 0) + 1);
    relayed += Number(row.totalRelayed) || 0;
    received += Number(row.totalReceived) || 0;
  }
  return { connected: rows.length, perHub, relayed, received, channels: hubs.HUBS.length };
}

module.exports = {
  WEBHOOK_NAME,
  MAX_CONTENT,
  MAX_RELAYS,
  DEFAULTS,
  evaluateMessage,
  takeSlot,
  resetRate,
  buildRelayContent,
  buildRelayPayload,
  buildFallbackEmbed,
  targetQuery,
  attachmentsOf,
  cleanName,
  getConfig,
  clearConfigCache,
  updateConfig,
  ensureWebhook,
  deliver,
  linkChannel,
  unlinkChannel,
  releaseGuild,
  relayMessage,
  handleDeletedMessage,
  peerServers,
  networkStats,
  resolveChannel,
};
