'use strict';
// utils/antinukeActions.js — Orchestration Discord de la protection anti-nuke.
//
// Reçoit une entrée du journal d'audit (voir src/events/security/antiNuke.js),
// décide via le moteur pur (src/utils/antinukeEngine.js) puis agit :
//   • sanction de l'auteur (retrait des rôles / quarantaine / ban) ;
//   • réparation de ce qui vient d'être détruit (salon, rôle) ;
//   • alerte dans le salon de logs ;
//   • confinement optionnel du serveur (verrouillage de tous les salons) ;
//   • journalisation de l'incident en base.
//
// Tout est best-effort : une erreur Discord ne doit jamais interrompre le
// traitement des entrées suivantes.

const { AuditLogEvent, ChannelType, PermissionsBitField, EmbedBuilder } = require('discord.js');
const AntiNuke = require('../models/AntiNuke');
const { COLORS } = require('./embeds');
const { lockAll } = require('./antiraidActions');
const {
  ACTIONS, bump, forget, pruneStore, trackerKey, evaluate, isTrusted,
  buildIncident, capIncidents, shouldLog, isEnforced,
  channelRestoreOptions, roleRestoreOptions, describePunishment, effectiveThresholds,
} = require('./antinukeEngine');

// ─── Correspondance journal d'audit → clé du moteur ──────────────────────────
const ACTION_MAP = {
  [AuditLogEvent.ChannelDelete]:  'channelDelete',
  [AuditLogEvent.RoleDelete]:     'roleDelete',
  [AuditLogEvent.MemberBanAdd]:   'ban',
  [AuditLogEvent.MemberKick]:     'kick',
  [AuditLogEvent.WebhookCreate]:  'webhookCreate',
  [AuditLogEvent.BotAdd]:         'botAdd',
  [AuditLogEvent.EmojiDelete]:    'emojiDelete',
  [AuditLogEvent.GuildUpdate]:    'guildUpdate',
};

// Permissions dont l'attribution à un membre est traitée comme une action à
// haut risque (escalade de privilèges : la porte ouverte à la nuke).
const DANGEROUS_PERMISSIONS = [
  PermissionsBitField.Flags.Administrator,
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageWebhooks,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers,
];

// ─── Fenêtre glissante partagée par le processus ─────────────────────────────
const tracker = new Map();

// Purge de sécurité : on ne garde jamais plus de 5 minutes d'historique, quelle
// que soit la fenêtre configurée (le nettoyage ne doit jamais tronquer la
// fenêtre d'un autre serveur, plus longue que celle en cours de traitement).
const PRUNE_WINDOW_MS = 5 * 60_000;

// ─── Configuration ───────────────────────────────────────────────────────────
async function getConfig(guildId) {
  let config = await AntiNuke.findOne({ guildId });
  if (!config) config = await AntiNuke.create({ guildId });
  return config;
}

/** Applique un niveau de sensibilité aux seuils du document (sans sauvegarder). */
function applyLevel(config, level) {
  const { windowSec, thresholds } = effectiveThresholds({ level });
  config.level = level;
  config.windowSec = windowSec;
  config.thresholds = { ...config.thresholds?.toObject?.() ?? config.thresholds, ...thresholds };
  return config;
}

// ─── Résolution de l'auteur ──────────────────────────────────────────────────
async function resolveExecutor(guild, entry) {
  const executorId = entry.executorId || entry.executor?.id || null;
  if (!executorId) return { userId: null, tag: null, roleIds: [] };
  const member = guild.members.cache.get(executorId) || await guild.members.fetch(executorId).catch(() => null);
  const user = member?.user || entry.executor || await guild.client.users.fetch(executorId).catch(() => null);
  return {
    userId: executorId,
    tag: user?.tag || user?.username || executorId,
    roleIds: member ? [...member.roles.cache.keys()] : [],
  };
}

/** Un changement d'attribution de rôles a-t-il donné une permission dangereuse ? */
function addedDangerousRole(guild, entry) {
  const changes = entry.changes || [];
  const added = [];
  for (const change of changes) {
    if (!['$add', 'roles'].includes(change.key)) continue;
    const list = Array.isArray(change.new_value) ? change.new_value : (change.new_value ? [change.new_value] : []);
    for (const item of list) {
      const roleId = typeof item === 'string' ? item : item?.id;
      if (roleId) added.push(roleId);
    }
  }
  if (!added.length) return null;
  for (const roleId of added) {
    const role = guild.roles.cache.get(roleId);
    if (!role || role.managed || role.id === guild.id) continue;
    if (DANGEROUS_PERMISSIONS.some(flag => role.permissions.has(flag))) {
      return { role, permissions: DANGEROUS_PERMISSIONS.filter(flag => role.permissions.has(flag)) };
    }
  }
  return null;
}

// ─── Sanction ────────────────────────────────────────────────────────────────
/**
 * Crée (une seule fois) le rôle de quarantaine du serveur et mémorise son ID
 * sur la configuration. Le nom est personnalisable : l'anti-nuke et le contrôle
 * à l'arrivée ont chacun le leur tout en partageant cette mécanique.
 */
async function ensureQuarantineRole(guild, config, options = {}) {
  if (config.quarantineRoleId) {
    const existing = guild.roles.cache.get(config.quarantineRoleId) || await guild.roles.fetch(config.quarantineRoleId).catch(() => null);
    if (existing) return existing;
  }
  const {
    name = '🛡️ Quarantaine Sentinel',
    color = 0xED4245,
    reason = 'Anti-nuke : rôle de quarantaine',
  } = options;
  const me = guild.members.me;
  const botHighest = me?.roles?.highest?.position ?? 1;
  const role = await guild.roles.create({
    name,
    color,
    permissions: [],
    mentionable: false,
    reason,
  }).catch(() => null);
  if (role) {
    // Le rôle doit rester manipulable par le bot : on le place juste sous son
    // rôle le plus haut (sans jamais passer au-dessus).
    if (botHighest > 1) await role.setPosition(Math.max(1, botHighest - 1)).catch(() => {});
    config.quarantineRoleId = role.id;
    await config.save().catch(() => {});
  }
  return role;
}

/**
 * Sanctionne l'auteur d'une tentative de nuke.
 * @returns {Promise<string>} description humaine de la sanction appliquée
 */
async function applyPunishment(guild, config, { userId, reason }) {
  if (!userId || config.punishment === 'none') return describePunishment('none');
  if (userId === guild.ownerId || userId === guild.client.user.id) return 'aucune (auteur protégé)';

  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);

  if (config.punishment === 'ban') {
    const ok = await guild.members.ban(userId, { reason }).then(() => true).catch(() => false);
    return ok ? describePunishment('ban') : 'ban impossible (permissions ou hiérarchie)';
  }

  if (!member) return 'aucune (membre déjà parti)';

  if (config.punishment === 'removeRoles' || config.punishment === 'quarantine') {
    const removable = [...member.roles.cache.values()]
      .filter(role => !role.managed && role.id !== guild.id && role.position < (guild.members.me?.roles?.highest?.position ?? 0));
    for (const role of removable) {
      await member.roles.remove(role, reason).catch(() => {});
    }
    if (config.punishment === 'quarantine') {
      const quarantine = await ensureQuarantineRole(guild, config);
      if (quarantine) await member.roles.add(quarantine, reason).catch(() => {});
      return describePunishment('quarantine');
    }
    return describePunishment('removeRoles');
  }

  return describePunishment(config.punishment);
}

// ─── Réparation ──────────────────────────────────────────────────────────────
/**
 * Reconstruit ce que l'entrée d'audit vient de détruire.
 * `entry.target` porte encore l'état d'avant suppression (salon / rôle).
 * @returns {Promise<string|null>} description, ou null si rien à réparer
 */
async function restoreFromEntry(guild, entry, action) {
  const target = entry.target;
  if (!target) return null;

  if (action === 'channelDelete') {
    if (target.type === ChannelType.GuildCategory) return null; // recréé avec ses enfants si besoin
    const options = channelRestoreOptions({
      name: target.name,
      type: target.type,
      parentId: target.parentId ?? null,
      position: target.rawPosition ?? target.position,
      topic: target.topic ?? null,
      nsfw: target.nsfw ?? false,
      rateLimitPerUser: target.rateLimitPerUser ?? 0,
      bitrate: target.bitrate ?? null,
      userLimit: target.userLimit ?? null,
    });
    const channel = await guild.channels.create(options).catch(() => null);
    if (!channel) return null;

    // Reposer les overwrites d'origine (best-effort : les rôles supprimés depuis
    // ne sont plus résolvables et sont simplement ignorés).
    const overwrites = target.permissionOverwrites?.cache;
    if (overwrites?.size) {
      for (const [, overwrite] of overwrites) {
        await channel.permissionOverwrites.edit(overwrite.id, {
          allow: overwrite.allow.bitfield,
          deny: overwrite.deny.bitfield,
        }).catch(() => {});
      }
    }
    return `salon #${channel.name} reconstruit`;
  }

  if (action === 'roleDelete') {
    const options = roleRestoreOptions({
      name: target.name,
      color: target.color,
      hoist: target.hoist,
      mentionable: target.mentionable,
      permissions: target.permissions?.bitfield ?? null,
      managed: target.managed,
    });
    if (!options) return null;
    const role = await guild.roles.create(options).catch(() => null);
    if (!role) return null;
    if (Number.isFinite(target.position) && target.position > 1) {
      await role.setPosition(Math.max(1, Math.min(target.position, (guild.members.me?.roles?.highest?.position ?? 1)))).catch(() => {});
    }
    return `rôle @${role.name} recréé`;
  }

  return null;
}

// ─── Alerte ──────────────────────────────────────────────────────────────────
async function resolveLogChannel(guild, config) {
  const candidates = [config.logChannelId];
  try {
    const AutoMod = require('../models/AutoMod');
    const automod = await AutoMod.findOne({ guildId: guild.id }).lean();
    if (automod?.logChannelId) candidates.push(automod.logChannelId);
  } catch (_) { /* AutoMod indisponible : on s'en passe */ }
  const server = guild.systemChannelId;
  if (server) candidates.push(server);

  for (const id of candidates.filter(Boolean)) {
    const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null);
    if (channel?.isTextBased()) {
      const perms = channel.permissionsFor(guild.members.me);
      if (perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return channel;
    }
  }
  return null;
}

async function sendAlert(guild, config, embed) {
  const channel = await resolveLogChannel(guild, config);
  if (!channel) return false;
  return channel.send({ embeds: [embed] }).then(() => true).catch(() => false);
}

function incidentEmbed(guild, config, { action, count, threshold, executor, punishment, restored }) {
  const meta = ACTIONS[action] || { emoji: '⚠️', label: action, severity: 'moyen' };
  const embed = new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle(`${meta.emoji} Anti-nuke — action destructrice bloquée`)
    .setDescription(`**${meta.label}** ×**${count}** en moins de **${Math.round(effectiveThresholds(config).windowSec)}s** ` +
      `(seuil : ${threshold}).\n\n` +
      `**Auteur :** ${executor.userId ? `<@${executor.userId}> (\`${executor.userId}\`)` : 'inconnu'}\n` +
      `**Sanction :** ${punishment}\n` +
      (restored ? `**Réparation :** ${restored}\n` : '') +
      `\n> Configure et consulte l'historique avec \`/anti-nuke\`.`)
    .setFooter({ text: `REZO • Sentinel — ${guild.name}` })
    .setTimestamp();
  return embed;
}

function sensitiveEmbed(guild, { action, executor }) {
  const meta = ACTIONS[action] || { emoji: '⚠️', label: action };
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle(`${meta.emoji} Action sensible — ${meta.label}`)
    .setDescription(`<@${executor.userId}> a déclenché **${meta.label}**.\nSurveillé par Sentinel : aucune sanction, ceci est un journal.`)
    .setFooter({ text: `REZO • Sentinel — ${guild.name}` })
    .setTimestamp();
}

// ─── Traitement d'une entrée du journal d'audit ──────────────────────────────
/**
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildAuditLogsEntry} entry
 * @returns {Promise<{ action:string, handled:boolean, reason?:string, count?:number, punishment?:string, restored?:string|null }|null>}
 */
async function handleAuditEntry(client, guild, entry) {
  if (!guild || !entry || !entry.action) return null;

  let action = ACTION_MAP[entry.action] || null;
  let roleEscalation = null;

  if (!action && entry.action === AuditLogEvent.MemberRoleUpdate) {
    roleEscalation = addedDangerousRole(guild, entry);
    if (!roleEscalation) return null; // simple attribution de rôle : non surveillée
    action = 'memberRoleUpdate';
  }
  if (!action) return null;

  const config = await getConfig(guild.id);
  if (!config.enabled) return null;

  const executor = await resolveExecutor(guild, entry);
  if (!executor.userId) return null;

  const trust = isTrusted(config, {
    userId: executor.userId,
    roleIds: executor.roleIds,
    guildOwnerId: guild.ownerId,
    clientId: client?.user?.id ?? guild.client.user?.id,
  });
  if (trust.trusted) return { action, handled: false, reason: `confiance (${trust.reason})` };

  const { windowSec } = effectiveThresholds(config);
  const windowMs = windowSec * 1000;
  const now = Date.now();
  const key = trackerKey(guild.id, executor.userId, action);
  const count = bump(tracker, key, now, windowMs);
  pruneStore(tracker, now, PRUNE_WINDOW_MS);

  const verdict = evaluate(config, action, count);

  // Sous le seuil (ou action non sanctionnable) : on journalise seulement les
  // actions sensibles (webhook créé, bot ajouté, salon/rôle supprimé…).
  if (!verdict.exceeded || !isEnforced(action)) {
    if (shouldLog(config, action)) {
      await sendAlert(guild, config, sensitiveEmbed(guild, { action, executor }));
      return { action, handled: true, reason: 'journalisé', count };
    }
    return { action, handled: false, count };
  }

  // ── Seuil franchi : on bloque ─────────────────────────────────────────────
  const reason = `Anti-nuke : ${ACTIONS[action]?.label || action} ×${count}${roleEscalation ? ` (@${roleEscalation.role.name})` : ''}`;
  const punishment = await applyPunishment(guild, config, { userId: executor.userId, reason });

  let restored = null;
  if (action === 'channelDelete' && config.restore?.channels) {
    restored = await restoreFromEntry(guild, entry, 'channelDelete').catch(() => null);
  } else if (action === 'roleDelete' && config.restore?.roles) {
    restored = await restoreFromEntry(guild, entry, 'roleDelete').catch(() => null);
  } else if (roleEscalation) {
    // Escalade de privilèges : le rôle dangereux tout juste accordé est retiré.
    const member = guild.members.cache.get(entry.targetId) || await guild.members.fetch(entry.targetId).catch(() => null);
    if (member) {
      const removed = await member.roles.remove(roleEscalation.role, 'Anti-nuke : permission dangereuse accordée').then(() => true).catch(() => false);
      if (removed) restored = `rôle @${roleEscalation.role.name} retiré à <@${entry.targetId}>`;
    }
  }

  // Confinement optionnel
  if (config.lockdownOnNuke && !config.panicActive) {
    await lockAll(guild, true).catch(() => {});
    config.panicActive = true;
    config.panicSince = new Date();
  }

  forget(tracker, key);

  const incident = buildIncident({
    userId: executor.userId,
    userTag: executor.tag,
    action,
    count,
    threshold: verdict.threshold,
    punishment: config.punishment,
    restored,
  });
  config.incidents = capIncidents([...(config.incidents || []), incident]);
  config.stats.prevented = (config.stats?.prevented || 0) + 1;
  config.stats.lastIncidentAt = new Date();
  await config.save().catch(() => {});

  await sendAlert(guild, config, incidentEmbed(guild, config, {
    action, count, threshold: verdict.threshold, executor, punishment, restored,
  }));

  console.log(`🛡️ [anti-nuke] ${guild.name} : ${action} ×${count} par ${executor.tag} → ${punishment}${restored ? ` (${restored})` : ''}`);
  return { action, handled: true, count, punishment, restored };
}

// ─── Confinement (mode panique) ──────────────────────────────────────────────
async function setPanic(guild, config, enable, { userId = null } = {}) {
  const locked = await lockAll(guild, enable);
  config.panicActive = enable;
  config.panicSince = enable ? new Date() : null;
  await config.save().catch(() => {});
  await sendAlert(guild, config, new EmbedBuilder()
    .setColor(enable ? COLORS.error : COLORS.success)
    .setTitle(enable ? '🚨 Mode panique activé' : '🔓 Mode panique levé')
    .setDescription(enable
      ? `${locked} salon(s) verrouillé(s)${userId ? ` par <@${userId}>` : ''}. Tout le monde est muet sauf le staff.`
      : `${locked} salon(s) déverrouillé(s).`)
    .setTimestamp());
  return locked;
}

/** Lève automatiquement les confinements expirés (appelé par un cron). */
async function releaseExpiredPanic(client) {
  const configs = await AntiNuke.find({ panicActive: true, panicAutoMin: { $gt: 0 } });
  let released = 0;
  for (const config of configs) {
    const since = config.panicSince ? new Date(config.panicSince).getTime() : 0;
    if (!since || Date.now() - since < config.panicAutoMin * 60_000) continue;
    const guild = client.guilds.cache.get(config.guildId) || await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) continue;
    const locked = await lockAll(guild, false).catch(() => 0);
    config.panicActive = false;
    config.panicSince = null;
    await config.save().catch(() => {});
    released++;
    await sendAlert(guild, config, new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('🔓 Confinement levé automatiquement')
      .setDescription(`Délai de ${config.panicAutoMin} min écoulé — ${locked} salon(s) déverrouillé(s).`)
      .setTimestamp()).catch(() => {});
  }
  return released;
}

module.exports = {
  tracker,
  ACTION_MAP,
  getConfig,
  applyLevel,
  resolveExecutor,
  addedDangerousRole,
  ensureQuarantineRole,
  applyPunishment,
  restoreFromEntry,
  resolveLogChannel,
  sendAlert,
  incidentEmbed,
  sensitiveEmbed,
  handleAuditEntry,
  setPanic,
  releaseExpiredPanic,
};
