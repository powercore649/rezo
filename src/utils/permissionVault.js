'use strict';
// utils/permissionVault.js — Orchestration Discord du coffre-fort de permissions.
//
// Deux chemins mènent à la vérification, et ils sont idempotents :
//   1. le journal d'audit (`guildAuditLogEntryCreate`) donne l'auteur exact ;
//   2. `channelUpdate` / `roleUpdate` servent de filet quand l'entrée d'audit
//      n'arrive pas (permission « Voir le journal d'audit » manquante, entrée
//      trop ancienne…), avec résolution de l'auteur via l'audit si possible.
//
// Le récapitulatif au démarrage et toutes les 10 minutes (`reconcileAll`)
// rattrape les modifications faites pendant que le bot était hors ligne.
//
// Règle de sûreté : une modification faite par le propriétaire, le bot ou un
// rôle de confiance devient la nouvelle référence (elle est journalisée mais
// jamais annulée). Toute autre ouverture est refermée en mode `revert`.

const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const PermissionVault = require('../models/PermissionVault');
const E = require('./permissionVaultEngine');
const { COLORS } = require('./embeds');

const MAX_TRUSTED_ROLES = 15;

// ── Configuration ────────────────────────────────────────────────────────────
async function getConfig(guildId) {
  return PermissionVault.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true },
  );
}

function ensureShape(cfg) {
  if (!cfg) return cfg;
  if (!Array.isArray(cfg.protectedChannels)) cfg.protectedChannels = [];
  if (!Array.isArray(cfg.protectedRoles)) cfg.protectedRoles = [];
  if (!Array.isArray(cfg.trustedRoles)) cfg.trustedRoles = [];
  if (!Array.isArray(cfg.incidents)) cfg.incidents = [];
  if (!cfg.stats) cfg.stats = { reverted: 0, alerts: 0, trusted: 0, lastIncidentAt: null };
  return cfg;
}

// ── Résolution Discord (tolérante aux mocks et aux caches vides) ─────────────
async function resolveChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const cached = guild.channels?.cache?.get?.(channelId);
  if (cached) return cached;
  try {
    return (await guild.channels?.fetch?.(channelId)) || null;
  } catch {
    return null;
  }
}

async function resolveRole(guild, roleId) {
  if (!guild || !roleId) return null;
  const cached = guild.roles?.cache?.get?.(roleId);
  if (cached) return cached;
  try {
    return (await guild.roles?.fetch?.(roleId)) || null;
  } catch {
    return null;
  }
}

async function actorRoleIds(guild, userId) {
  if (!guild || !userId) return [];
  try {
    const member = guild.members?.cache?.get?.(userId) || await guild.members?.fetch?.(userId);
    const cache = member?.roles?.cache;
    if (!cache) return [];
    if (typeof cache.keys === 'function') return [...cache.keys()];
    return [...cache.values()].map(r => r?.id).filter(Boolean);
  } catch {
    return [];
  }
}

/** Auteur réel d'un instantané d'overwrites / de rôle, lu dans le journal d'audit. */
async function lastAuditExecutor(guild, kind, targetId, clientId = null) {
  try {
    const type = kind === 'role' ? AuditLogEvent.RoleUpdate : AuditLogEvent.ChannelOverwriteUpdate;
    const logs = await guild.fetchAuditLogs({ type, limit: 10 });
    const list = logs?.entries ? [...logs.entries.values()] : [];
    const hit = list.find(e => {
      if (String(e.targetId ?? e.target?.id ?? '') !== String(targetId)) return false;
      // Ne jamais attribuer une réparation faite par le bot à un humain.
      if (clientId && e.executorId === clientId) return false;
      return true;
    });
    if (!hit?.executorId) return null;
    return { executorId: hit.executorId, roleIds: await actorRoleIds(guild, hit.executorId) };
  } catch {
    return null;
  }
}

/** Lit les overwrites d'un salon sous forme d'instantané sérialisable. */
function readOverwrites(channel) {
  const cache = channel?.permissionOverwrites?.cache;
  if (!cache) return [];
  const list = typeof cache.values === 'function' ? [...cache.values()] : [];
  return E.snapshotOverwrites(list);
}

// ── Gestion des cibles protégées ─────────────────────────────────────────────
async function protectChannel(cfg, guild, channelId) {
  ensureShape(cfg);
  const channel = await resolveChannel(guild, channelId);
  if (!channel) return { ok: false, reason: 'channel_not_found' };

  const entry = {
    channelId: String(channelId),
    name: channel.name || null,
    overwrites: readOverwrites(channel),
    capturedAt: new Date(),
  };

  cfg.protectedChannels = cfg.protectedChannels.filter(c => c.channelId !== entry.channelId);
  if (cfg.protectedChannels.length >= E.MAX_CHANNELS) {
    return { ok: false, reason: 'limit', limit: E.MAX_CHANNELS };
  }
  cfg.protectedChannels.push(entry);
  await cfg.save();
  return { ok: true, entry };
}

async function unprotectChannel(cfg, channelId) {
  ensureShape(cfg);
  const before = cfg.protectedChannels.length;
  cfg.protectedChannels = cfg.protectedChannels.filter(c => c.channelId !== String(channelId));
  const removed = cfg.protectedChannels.length !== before;
  if (removed) await cfg.save();
  return { ok: removed };
}

async function protectRole(cfg, guild, roleId) {
  ensureShape(cfg);
  // @everyone est refusé AVANT toute résolution : même si le cache le connaît,
  // le verrouiller n'aurait aucun sens (il est porté par tous les membres).
  if (E.isEveryoneRole(guild?.id, roleId)) return { ok: false, reason: 'everyone' };
  const role = await resolveRole(guild, roleId);
  if (!role) return { ok: false, reason: 'role_not_found' };

  const entry = {
    roleId: String(roleId),
    name: role.name || null,
    permissions: E.toBits(role.permissions).toString(),
    capturedAt: new Date(),
  };

  cfg.protectedRoles = cfg.protectedRoles.filter(r => r.roleId !== entry.roleId);
  if (cfg.protectedRoles.length >= E.MAX_ROLES) {
    return { ok: false, reason: 'limit', limit: E.MAX_ROLES };
  }
  cfg.protectedRoles.push(entry);
  await cfg.save();
  return { ok: true, entry };
}

async function unprotectRole(cfg, roleId) {
  ensureShape(cfg);
  const before = cfg.protectedRoles.length;
  cfg.protectedRoles = cfg.protectedRoles.filter(r => r.roleId !== String(roleId));
  const removed = cfg.protectedRoles.length !== before;
  if (removed) await cfg.save();
  return { ok: removed };
}

async function addTrustedRole(cfg, guild, roleId) {
  ensureShape(cfg);
  if (E.isEveryoneRole(guild?.id, roleId)) return { ok: false, reason: 'everyone' };
  const role = await resolveRole(guild, roleId);
  if (!role) return { ok: false, reason: 'role_not_found' };
  if (cfg.trustedRoles.includes(String(roleId))) return { ok: true, duplicate: true };
  if (cfg.trustedRoles.length >= MAX_TRUSTED_ROLES) return { ok: false, reason: 'limit', limit: MAX_TRUSTED_ROLES };
  cfg.trustedRoles.push(String(roleId));
  await cfg.save();
  return { ok: true };
}

async function removeTrustedRole(cfg, roleId) {
  ensureShape(cfg);
  const before = cfg.trustedRoles.length;
  cfg.trustedRoles = cfg.trustedRoles.filter(id => id !== String(roleId));
  const removed = cfg.trustedRoles.length !== before;
  if (removed) await cfg.save();
  return { ok: removed };
}

async function setLogChannel(cfg, channelId) {
  ensureShape(cfg);
  cfg.logChannelId = channelId ? String(channelId) : null;
  await cfg.save();
  return { ok: true };
}

/** Active/désactive en refusant une activation qui ne protégerait rien. */
async function setEnabled(cfg, enabled) {
  ensureShape(cfg);
  if (enabled && cfg.protectedChannels.length === 0 && cfg.protectedRoles.length === 0) {
    return { ok: false, reason: 'no_targets' };
  }
  cfg.enabled = Boolean(enabled);
  await cfg.save();
  return { ok: true };
}

async function setMode(cfg, mode) {
  ensureShape(cfg);
  cfg.mode = mode === 'alert' ? 'alert' : 'revert';
  await cfg.save();
  return { ok: true, mode: cfg.mode };
}

// ── Journalisation ───────────────────────────────────────────────────────────
function buildAlertEmbed(incident, guildName) {
  const reverted = incident.action === 'reverted';
  const trusted = incident.action === 'trusted';
  const failed = incident.action === 'failed';
  const color = reverted ? COLORS.success : trusted ? COLORS.info : failed ? COLORS.error : COLORS.warning;
  const title = reverted
    ? '🛡️ Coffre-fort — accès élargi refermé'
    : trusted
      ? '✅ Coffre-fort — modification autorisée'
      : failed
        ? '❌ Coffre-fort — réparation impossible'
        : '⚠️ Coffre-fort — accès élargi détecté';

  const action = reverted
    ? 'L\'accès a été remis exactement dans l\'état de référence.'
    : trusted
      ? 'L\'auteur est de confiance : le nouvel accès devient la référence.'
      : failed
        ? 'Le bot n\'a pas pu refermer l\'accès (permissions manquantes ou cible disparue).'
        : 'Mode « alerte » : l\'accès reste ouvert, une vérification manuelle est nécessaire.';

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`> ${action}`)
    .addFields(
      { name: incident.kind === 'role' ? 'Rôle' : 'Salon', value: incident.targetName ? `**${incident.targetName}** (\`${incident.targetId}\`)` : `\`${incident.targetId}\``, inline: true },
      { name: 'Auteur', value: incident.executorId ? `<@${incident.executorId}>` : 'inconnu', inline: true },
      { name: 'Source', value: `\`${incident.source}\``, inline: true },
      { name: 'Accès élargi', value: (incident.permissions || []).slice(0, 10).join(', ').slice(0, 1024) || 'non détaillé', inline: false },
    )
    .setFooter({ text: `REZO • Coffre-fort de permissions · ${guildName || 'serveur'}` })
    .setTimestamp();
}

async function sendAlert(client, guild, cfg, incident) {
  if (!cfg.logChannelId) {
    console.warn(`[coffre-fort] ${E.formatIncident(incident)} (aucun salon de logs configuré)`);
    return false;
  }
  const channel = await resolveChannel(guild, cfg.logChannelId);
  if (!channel || typeof channel.send !== 'function') return false;
  try {
    await channel.send({ embeds: [buildAlertEmbed(incident, guild?.name)] });
    return true;
  } catch {
    return false;
  }
}

async function recordIncident(client, guild, cfg, incident) {
  ensureShape(cfg);
  cfg.incidents = E.capIncidents([...cfg.incidents, incident]);
  cfg.stats.lastIncidentAt = incident.at || new Date();
  if (incident.action === 'reverted') cfg.stats.reverted = (cfg.stats.reverted || 0) + 1;
  else if (incident.action === 'trusted') cfg.stats.trusted = (cfg.stats.trusted || 0) + 1;
  else cfg.stats.alerts = (cfg.stats.alerts || 0) + 1;
  await cfg.save();
  await sendAlert(client, guild, cfg, incident);
  return incident;
}

// ── Vérification d'un salon ──────────────────────────────────────────────────
/**
 * Compare l'accès réel d'un salon protégé à sa référence.
 * @returns {null|object} null si rien n'a bougé (ou cible non protégée)
 */
async function verifyChannel(guild, cfg, channelId, {
  executorId = null, roleIds = null, clientId = null, source = 'event', attribute = true,
} = {}) {
  ensureShape(cfg);
  if (!cfg?.enabled) return null;
  const entry = cfg.protectedChannels.find(c => c.channelId === String(channelId));
  if (!entry) return null;

  const channel = await resolveChannel(guild, channelId);
  if (!channel) return { kind: 'channel', targetId: String(channelId), missing: true };

  const current = readOverwrites(channel);
  const diff = E.diffOverwrites(entry.overwrites, current);
  if (!diff.isBroadening) return null;

  let exec = executorId;
  let roles = roleIds;
  if (attribute && !exec) {
    const found = await lastAuditExecutor(guild, 'channel', channelId, clientId);
    if (found) { exec = found.executorId; roles = found.roleIds; }
  }

  const verdict = E.actorVerdict(cfg, {
    executorId: exec,
    roleIds: roles || [],
    guildOwnerId: guild?.ownerId || null,
    clientId,
  });

  const permissions = E.permissionNames(diff.gained);
  const base = {
    kind: 'channel',
    targetId: String(channelId),
    targetName: entry.name || channel.name || null,
    executorId: exec || null,
    permissions,
    mode: cfg.mode,
    source,
  };

  // Auteur de confiance : sa modification devient la nouvelle référence.
  if (verdict.trusted) {
    entry.overwrites = current;
    entry.capturedAt = new Date();
    return recordIncident(clientFromGuild(guild), guild, cfg, E.buildIncident({
      ...base, action: 'trusted', detail: verdict.reason,
    }));
  }

  if (cfg.mode !== 'revert') {
    return recordIncident(clientFromGuild(guild), guild, cfg, E.buildIncident({ ...base, action: 'alerted' }));
  }

  try {
    const restore = E.restoreOverwrites(entry.overwrites, current);
    await channel.permissionOverwrites.set(
      restore.map(o => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) })),
      'Coffre-fort : accès élargi refermé',
    );
    entry.capturedAt = new Date();
    return recordIncident(clientFromGuild(guild), guild, cfg, E.buildIncident({ ...base, action: 'reverted' }));
  } catch (err) {
    return recordIncident(clientFromGuild(guild), guild, cfg, E.buildIncident({
      ...base, action: 'failed', detail: err.message,
    }));
  }
}

// ── Vérification d'un rôle ───────────────────────────────────────────────────
/**
 * Compare les permissions réelles d'un rôle protégé à sa référence.
 * Toute permission gagnée est un élargissement (strict : un rôle du coffre est
 * verrouillé). @returns {null|object}
 */
async function verifyRole(guild, cfg, roleId, {
  executorId = null, roleIds = null, clientId = null, source = 'event', attribute = true,
} = {}) {
  ensureShape(cfg);
  if (!cfg?.enabled) return null;
  const entry = cfg.protectedRoles.find(r => r.roleId === String(roleId));
  if (!entry) return null;

  const role = await resolveRole(guild, roleId);
  if (!role) return { kind: 'role', targetId: String(roleId), missing: true };

  const baseline = E.toBits(entry.permissions);
  const current = E.toBits(role.permissions);
  const diff = E.diffRolePermissions(baseline, current);
  if (!diff.isBroadening) return null;

  let exec = executorId;
  let roles = roleIds;
  if (attribute && !exec) {
    const found = await lastAuditExecutor(guild, 'role', roleId, clientId);
    if (found) { exec = found.executorId; roles = found.roleIds; }
  }

  const verdict = E.actorVerdict(cfg, {
    executorId: exec,
    roleIds: roles || [],
    guildOwnerId: guild?.ownerId || null,
    clientId,
  });

  const base = {
    kind: 'role',
    targetId: String(roleId),
    targetName: entry.name || role.name || null,
    executorId: exec || null,
    permissions: diff.names,
    mode: cfg.mode,
    source,
  };

  if (verdict.trusted) {
    entry.permissions = current.toString();
    entry.capturedAt = new Date();
    return recordIncident(clientFromGuild(guild), guild, cfg, E.buildIncident({
      ...base, action: 'trusted', detail: verdict.reason,
    }));
  }

  if (cfg.mode !== 'revert') {
    return recordIncident(clientFromGuild(guild), guild, cfg, E.buildIncident({ ...base, action: 'alerted' }));
  }

  try {
    await role.setPermissions(baseline, 'Coffre-fort : permissions restaurées');
    entry.capturedAt = new Date();
    return recordIncident(clientFromGuild(guild), guild, cfg, E.buildIncident({ ...base, action: 'reverted' }));
  } catch (err) {
    return recordIncident(clientFromGuild(guild), guild, cfg, E.buildIncident({
      ...base, action: 'failed', detail: err.message,
    }));
  }
}

// `recordIncident` a besoin du client Discord pour envoyer l'alerte. Les
// fonctions de vérification sont aussi appelées hors ligne (tests) : on
// récupère le client via le salon quand il existe, sinon `null` (alerte console).
function clientFromGuild(guild) {
  return guild?.client || null;
}

// ── Bilan complet ────────────────────────────────────────────────────────────
/**
 * Vérifie toutes les cibles protégées d'un serveur.
 * @returns {{ checked:number, drifted:number, reverted:number, missing:number, incidents:object[] }}
 */
async function verifyAll(guild, cfg, { executorId = null, roleIds = null, clientId = null, source = 'manual', attribute = false } = {}) {
  ensureShape(cfg);
  const result = { checked: 0, drifted: 0, reverted: 0, missing: 0, incidents: [] };
  if (!cfg?.enabled) return result;

  for (const entry of [...cfg.protectedChannels]) {
    const r = await verifyChannel(guild, cfg, entry.channelId, { executorId, roleIds, clientId, source, attribute });
    result.checked++;
    if (r?.missing) result.missing++;
    if (r) {
      result.drifted++;
      result.incidents.push(r);
      if (r.action === 'reverted') result.reverted++;
    }
  }
  for (const entry of [...cfg.protectedRoles]) {
    const r = await verifyRole(guild, cfg, entry.roleId, { executorId, roleIds, clientId, source, attribute });
    result.checked++;
    if (r?.missing) result.missing++;
    if (r) {
      result.drifted++;
      result.incidents.push(r);
      if (r.action === 'reverted') result.reverted++;
    }
  }
  return result;
}

// ── Branchements Discord ─────────────────────────────────────────────────────
const MONITORED = new Set([
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.ChannelOverwriteDelete,
  AuditLogEvent.ChannelUpdate,
  AuditLogEvent.RoleUpdate,
]);

/** Entrée du journal d'audit : la voie principale (auteur exact). */
async function handleAuditEntry(client, guild, entry) {
  if (!guild || !entry || !MONITORED.has(entry.action)) return null;
  const clientId = client?.user?.id || null;
  if (clientId && entry.executorId === clientId) return null; // nos propres réparations

  const cfg = await PermissionVault.findOne({ guildId: guild.id });
  if (!cfg?.enabled) return null;
  ensureShape(cfg);

  const targetId = entry.targetId || entry.target?.id || entry.extra?.id;
  if (!targetId) return null;

  const options = {
    executorId: entry.executorId || null,
    roleIds: await actorRoleIds(guild, entry.executorId),
    clientId,
    source: 'audit',
    attribute: false,
  };

  if (entry.action === AuditLogEvent.RoleUpdate) {
    return verifyRole(guild, cfg, targetId, options);
  }
  return verifyChannel(guild, cfg, targetId, options);
}

/** Filet `channelUpdate` : même vérification, auteur résolu via l'audit. */
async function handleChannelUpdate(client, newChannel, oldChannel = null) {
  const guild = newChannel?.guild;
  if (!guild) return null;
  const cfg = await PermissionVault.findOne({ guildId: guild.id });
  if (!cfg?.enabled) return null;
  ensureShape(cfg);
  if (!cfg.protectedChannels.some(c => c.channelId === newChannel.id)) return null;
  return verifyChannel(guild, cfg, newChannel.id, {
    clientId: client?.user?.id || null,
    source: 'channelUpdate',
    attribute: true,
  });
}

/** Filet `roleUpdate` : même vérification, auteur résolu via l'audit. */
async function handleRoleUpdate(client, newRole) {
  const guild = newRole?.guild;
  if (!guild) return null;
  const cfg = await PermissionVault.findOne({ guildId: guild.id });
  if (!cfg?.enabled) return null;
  ensureShape(cfg);
  if (!cfg.protectedRoles.some(r => r.roleId === newRole.id)) return null;
  return verifyRole(guild, cfg, newRole.id, {
    clientId: client?.user?.id || null,
    source: 'roleUpdate',
    attribute: true,
  });
}

/** Rattrapage : serveurs dont le coffre est actif, ou un seul serveur ciblé. */
async function reconcileAll(client, { guildId = null } = {}) {
  const query = { enabled: true };
  if (guildId) query.guildId = String(guildId);
  const configs = await PermissionVault.find(query);

  const totals = { guilds: 0, checked: 0, drifted: 0, reverted: 0, missing: 0 };
  for (const cfg of configs) {
    const guild = client?.guilds?.cache?.get?.(cfg.guildId);
    if (!guild) continue;
    ensureShape(cfg);
    totals.guilds++;
    const r = await verifyAll(guild, cfg, {
      clientId: client?.user?.id || null,
      source: 'reconcile',
      attribute: true,
    });
    totals.checked += r.checked;
    totals.drifted += r.drifted;
    totals.reverted += r.reverted;
    totals.missing += r.missing;
  }
  return totals;
}

module.exports = {
  MAX_TRUSTED_ROLES,
  getConfig,
  ensureShape,
  resolveChannel,
  resolveRole,
  actorRoleIds,
  lastAuditExecutor,
  readOverwrites,
  protectChannel,
  unprotectChannel,
  protectRole,
  unprotectRole,
  addTrustedRole,
  removeTrustedRole,
  setLogChannel,
  setEnabled,
  setMode,
  buildAlertEmbed,
  sendAlert,
  recordIncident,
  verifyChannel,
  verifyRole,
  verifyAll,
  handleAuditEntry,
  handleChannelUpdate,
  handleRoleUpdate,
  reconcileAll,
};
