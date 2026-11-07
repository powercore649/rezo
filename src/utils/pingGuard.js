'use strict';
// utils/pingGuard.js — Application Discord de la garde anti-ping et des salons.
//
// Trois responsabilités, toutes best-effort (une erreur Discord ne doit jamais
// interrompre messageCreate ni les autres écouteurs) :
//   • handleMessage         — @everyone, @here, mentions en masse : suppression,
//                             sanction graduée, alerte ;
//   • handleChannelCreate   — nom de salon suspect : salon supprimé, auteur
//                             banni, anciens salons reconstruits ;
//   • handleChannelDelete   — instantané du salon supprimé (pour restauration)
//                             et restauration manuelle via /antiping restaurer.
//
// Les décisions pures vivent dans utils/pingGuardEngine.js (testables sans
// Discord ni MongoDB).

const { EmbedBuilder, AuditLogEvent, PermissionsBitField } = require('discord.js');
const { COLORS } = require('./embeds');
const { createBoundedCache } = require('./boundedCache');
const { sendModLog } = require('../commands/moderation/modlog');
const PingGuard = require('../models/PingGuard');
const engine = require('./pingGuardEngine');

// Config par serveur : une lecture base par minute et par serveur au lieu d'une
// par message. `invalidate` est appelé par /antiping après chaque écriture.
const configCache = createBoundedCache({ max: 10_000, ttl: 60_000, name: 'ping-guard-config' });
// Récidives dans la fenêtre de strike (une clé par serveur + membre).
const strikeStore = createBoundedCache({ max: 20_000, ttl: 6 * 3600_000, name: 'ping-guard-strikes' });
// Salons supprimés récemment, prêts à être reconstruits (borné par serveur).
const deletedChannels = createBoundedCache({ max: 5_000, ttl: 60 * 60_000, name: 'ping-guard-deleted' });

const MAX_SNAPSHOTS = 40;
const AUDIT_TOLERANCE_MS = 20_000;

// ─── Configuration ───────────────────────────────────────────────────────────
async function getConfig(guildId) {
  const cached = configCache.get(guildId);
  if (cached) return cached;
  const doc = await PingGuard.findOne({ guildId }).lean().catch(() => null);
  const config = engine.normalizeConfig(doc || {});
  configCache.set(guildId, config);
  return config;
}

function invalidate(guildId) {
  configCache.delete(guildId);
}

// ─── Journalisation ──────────────────────────────────────────────────────────
async function sendAlert(guild, embed) {
  const sent = await sendModLog(guild.client, guild.id, embed).catch(() => null);
  if (sent) return true;
  try {
    const { resolveLogChannel } = require('./antinukeActions');
    const channel = await resolveLogChannel(guild, {});
    if (channel) return channel.send({ embeds: [embed] }).then(() => true).catch(() => false);
  } catch (_) { /* anti-nuke indisponible : alerte simplement non délivrée */ }
  return false;
}

/** Mémorise un événement et incrémente le bon compteur, en une seule écriture. */
function record(guildId, { kind, userId = null, detail = '', counter = null }) {
  const update = {
    $set: { 'stats.lastAt': new Date() },
    $push: { recent: { $each: [{ at: new Date(), kind, userId, detail: String(detail).slice(0, 200) }], $slice: -15 } },
  };
  if (counter) update.$inc = { [`stats.${counter}`]: 1 };
  PingGuard.updateOne({ guildId }, update, { upsert: true }).catch(() => {});
}

// ─── Récidives ───────────────────────────────────────────────────────────────
function registerStrike(guildId, userId, windowMs) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const kept = (strikeStore.get(key) || []).filter(t => now - t < windowMs);
  kept.push(now);
  strikeStore.set(key, kept);
  return kept.length;
}

// ─── Anti-ping ───────────────────────────────────────────────────────────────
/**
 * Traite un message au regard de l'anti-ping.
 * @returns {Promise<boolean>} true si le message a été traité (supprimé)
 */
async function handleMessage(message) {
  try {
    if (!message?.guild || !message.member || !message.author || message.author.bot) return false;

    const config = await getConfig(message.guild.id);
    if (!config.enabled) return false;
    if (config.exemptChannels.includes(message.channel?.id)) return false;

    const roleIds = [...(message.member.roles?.cache?.keys?.() || [])];
    if (roleIds.some(id => config.exemptRoles.includes(id))) return false;

    const verdict = engine.analyzeMessage({
      content: message.content,
      roleMentions: message.mentions?.roles?.size || 0,
      userMentions: message.mentions?.users?.size || 0,
      canMentionEveryone: Boolean(message.member.permissions?.has?.(PermissionsBitField.Flags.MentionEveryone)),
    }, config);
    if (!verdict.violation) return false;

    const strike = registerStrike(message.guild.id, message.author.id, config.strikeWindowMin * 60_000);
    const sanction = engine.sanctionForStrike(config, strike);
    const reason = `Anti-ping : ${engine.describeRule(verdict.rule)} (${verdict.count})`;

    await message.delete().catch(() => {});
    const applied = await applySanction(message, config, sanction, reason);

    await sendAlert(message.guild, new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle('🔔 Mention de masse bloquée')
      .setDescription(
        `<@${message.author.id}> — **${engine.describeRule(verdict.rule)}** dans <#${message.channel.id}>.\n`
        + `Message supprimé · sanction : **${engine.describeSanction(applied)}** · récidive **${strike}/${config.strikesBeforeBan}**`,
      )
      .addFields({ name: 'Contenu neutralisé', value: engine.sanitizeMentions(message.content) || '*vide*' })
      .setFooter({ text: `REZO • Anti-ping — ${message.guild.name}` })
      .setTimestamp());

    record(message.guild.id, {
      kind: 'ping', userId: message.author.id, counter: 'pingsBlocked',
      detail: `${verdict.rule} → ${applied} (récidive ${strike})`,
    });
    console.log(`🔔 [anti-ping] ${message.guild.name} : ${verdict.rule} par ${message.author.tag} → ${applied}`);
    return true;
  } catch (err) {
    console.error('[anti-ping] handleMessage:', err.message);
    return false;
  }
}

/** Applique la sanction décidée, en repli sur la suppression si Discord refuse. */
async function applySanction(message, config, sanction, reason) {
  const member = message.member;
  const me = message.guild.members.me;
  if (sanction === 'delete') return 'delete';

  const hierarchyOk = member && me && (message.guild.ownerId === message.author.id
    ? false
    : member.roles.highest.position < me.roles.highest.position);

  if (sanction === 'timeout') {
    if (!hierarchyOk) return 'delete';
    const ok = await member.timeout(config.timeoutMin * 60_000, reason).then(() => true).catch(() => false);
    return ok ? 'timeout' : 'delete';
  }
  if (sanction === 'kick') {
    if (!hierarchyOk) return 'delete';
    const ok = await member.kick(reason).then(() => true).catch(() => false);
    return ok ? 'kick' : 'delete';
  }
  if (sanction === 'ban') {
    const ok = await message.guild.members.ban(message.author.id, { reason, deleteMessageSeconds: 3600 })
      .then(() => true).catch(() => false);
    return ok ? 'ban' : 'delete';
  }
  return 'delete';
}

// ─── Auteur d'une action (journal d'audit) ───────────────────────────────────
async function resolveActor(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 8 });
    const now = Date.now();
    const entry = logs.entries.find(e =>
      e.targetId === targetId
      && e.executorId
      && Math.abs(now - e.createdTimestamp) < AUDIT_TOLERANCE_MS);
    if (!entry) return null;
    return { id: entry.executorId, tag: entry.executor?.tag || entry.executorId };
  } catch (_) {
    // Sans « Voir les journaux d'audit », l'auteur est inconnu : la garde
    // supprime le salon mais ne bannit personne au hasard.
    return null;
  }
}

async function actorIsTrusted(guild, config, actor) {
  let roleIds = [];
  const member = guild.members.cache.get(actor.id) || await guild.members.fetch(actor.id).catch(() => null);
  if (member) roleIds = [...member.roles.cache.keys()];
  return engine.isTrusted({
    userId: actor.id,
    guildOwnerId: guild.ownerId,
    clientId: guild.client?.user?.id,
    roleIds,
  }, config);
}

// ─── Garde des noms de salons ────────────────────────────────────────────────
/**
 * Salon créé : si son nom est un vecteur d'attaque, on le supprime, on bannit
 * son auteur et on reconstruit les salons qu'il venait de supprimer.
 * @returns {Promise<boolean>}
 */
async function handleChannelCreate(channel) {
  try {
    const guild = channel?.guild;
    if (!guild) return false;

    const config = await getConfig(guild.id);
    const guard = config.channelGuard;
    if (!config.enabled || !guard.enabled) return false;

    const verdict = engine.channelNameVerdict(channel.name, guard.keywords);
    if (!verdict.suspicious) return false;

    const actor = await resolveActor(guild, AuditLogEvent.ChannelCreate, channel.id);
    if (actor && await actorIsTrusted(guild, config, actor)) {
      console.log(`[salons] ${guild.name} : nom suspect (${verdict.detail}) mais auteur de confiance — ignoré`);
      return false;
    }

    if (guard.deleteChannel) {
      await channel.delete('REZO — nom de salon suspect').catch(() => {});
    }

    let banned = false;
    if (guard.banAuthor && actor?.id && actor.id !== guild.ownerId) {
      banned = await guild.members.ban(actor.id, {
        reason: `REZO — salon au nom suspect (${verdict.detail})`,
        deleteMessageSeconds: 3600,
      }).then(() => true).catch(() => false);
    }

    let restore = { restored: 0, names: [] };
    if (banned && guard.restoreDeleted) {
      restore = await restoreRecent(guild, {
        actorId: actor.id,
        minutes: guard.restoreWindowMin,
      }).catch(() => ({ restored: 0, names: [] }));
    }

    await sendAlert(guild, new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle('🧨 Salon au nom suspect')
      .setDescription(
        `**${engine.sanitizeMentions(channel.name, 100)}** (${verdict.detail})\n`
        + (guard.deleteChannel ? 'Salon supprimé.\n' : '')
        + (banned ? `Auteur **${actor.tag}** banni.\n` : actor ? `Auteur identifié : **${actor.tag}** (ban non appliqué).\n` : 'Auteur non identifié (journal d\'audit indisponible).\n')
        + (restore.restored ? `♻️ **${restore.restored}** salon(s) restauré(s).` : ''),
      )
      .setFooter({ text: `REZO • Garde des salons — ${guild.name}` })
      .setTimestamp());

    record(guild.id, {
      kind: 'channel', userId: actor?.id || null, counter: 'channelsBlocked',
      detail: `${verdict.detail} → ${banned ? 'salon supprimé + ban' : 'salon supprimé'}`,
    });
    console.log(`🧨 [salons] ${guild.name} : ${verdict.detail} → salon supprimé${banned ? ' + auteur banni' : ''}`);
    return true;
  } catch (err) {
    console.error('[salons] handleChannelCreate:', err.message);
    return false;
  }
}

/**
 * Salon supprimé : on garde un instantané pour pouvoir le reconstruire si la
 * suppression fait partie d'une attaque (ban de l'auteur, ou /antiping restaurer).
 */
async function handleChannelDelete(channel) {
  try {
    const guild = channel?.guild;
    if (!guild) return;

    const config = await getConfig(guild.id).catch(() => null);
    if (!config?.enabled || !config?.channelGuard?.restoreDeleted) return;

    const snapshot = engine.channelSnapshot(channel);
    if (!snapshot) return;

    const actor = await resolveActor(guild, AuditLogEvent.ChannelDelete, channel.id);
    const bucket = deletedChannels.get(guild.id) || [];
    bucket.push({ at: Date.now(), actorId: actor?.id || null, snapshot });
    deletedChannels.set(guild.id, bucket.slice(-MAX_SNAPSHOTS));
  } catch (err) {
    console.error('[salons] handleChannelDelete:', err.message);
  }
}

/**
 * Reconstruit les salons supprimés récemment, éventuellement par un seul auteur.
 * @param {import('discord.js').Guild} guild
 * @param {{actorId?:string|null, minutes?:number, limit?:number}} options
 * @returns {Promise<{restored:number, names:string[]}>}
 */
async function restoreRecent(guild, { actorId = null, minutes = 15, limit = 10 } = {}) {
  const bucket = deletedChannels.get(guild.id) || [];
  const since = Date.now() - Math.max(1, minutes) * 60_000;
  const candidates = bucket
    .filter(entry => entry.at >= since && (!actorId || entry.actorId === actorId))
    .slice(-Math.max(1, Math.min(limit, MAX_SNAPSHOTS)));

  const names = [];
  const kept = [];
  for (const entry of bucket) {
    if (!candidates.includes(entry)) { kept.push(entry); continue; }
    const existing = guild.channels.cache.get(entry.snapshot.id);
    if (existing) continue; // déjà restauré entre-temps

    const options = engine.restoreOptionsFromSnapshot(entry.snapshot);
    if (!options) continue;
    const created = await guild.channels.create(options).catch(() => null);
    if (!created) { kept.push(entry); continue; }

    // Les overwrites d'un salon supprimé référencent parfois des rôles eux
    // aussi supprimés : Discord les ignore, la restauration reste utile.
    names.push(created.name);
  }

  deletedChannels.set(guild.id, kept.slice(-MAX_SNAPSHOTS));
  if (names.length) {
    record(guild.id, { kind: 'restore', counter: 'restores', detail: `${names.length} salon(s) : ${names.join(', ')}` });
  }
  return { restored: names.length, names };
}

module.exports = {
  getConfig,
  invalidate,
  registerStrike,
  handleMessage,
  applySanction,
  resolveActor,
  handleChannelCreate,
  handleChannelDelete,
  restoreRecent,
  deletedChannels,
  configCache,
};
