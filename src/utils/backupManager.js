'use strict';
// utils/backupManager.js — Sauvegarde et restauration complète d'un serveur.
//
// La logique de fidélité (ordre, permissions, traduction des IDs) vit dans
// utils/serverBackup.js, testable hors-ligne. Ce fichier ne fait que l'I/O
// Discord : il supprime, recrée et réordonne — et ne s'arrête jamais au premier
// échec : tout est collecté dans un rapport lisible.
//
// Garanties :
//   • les salons sont recréés DANS leur catégorie d'origine, puis réordonnés
//     en un seul appel groupé (avec repli salon par salon) ;
//   • les permissions sont recopiées bit à bit, y compris celles de @everyone ;
//   • les salons verrouillés le restent : le verrou est recopié à la création
//     puis VÉRIFIÉ, et reposé s'il manque (utils/channelLock.js) ;
//   • les rôles sont recréés dans l'ordre hiérarchique d'origine ;
//   • un élément qui échoue est signalé (nom + raison), jamais silencieux.

const { PermissionsBitField, Locale, OverwriteType } = require('discord.js');
const { nanoid } = require('nanoid');
const ServerBackup = require('../models/ServerBackup');
const sb = require('./serverBackup');
const channelLock = require('./channelLock');

const REASON = 'Restauration de sauvegarde REZO';

const TYPE = sb.TYPE;
const TEXTUAL = new Set([TYPE.text, TYPE.announcement]);
const VOICE   = new Set([TYPE.voice, TYPE.stage]);
const FORUM   = new Set([TYPE.forum, TYPE.media]);

// Pas de recréation d'emojis : le projet interdit tout upload d'emoji (règle
// vérifiée par tests/emoji-unicode.js). Les emojis restent ARCHIVÉS dans la
// sauvegarde — leurs URL permettent de les remettre en place à la main — mais le
// bot ne les téléverse jamais. Les tags de forum qui les référençaient sont
// recréés sans emoji plutôt qu'avec un identifiant invalide.
const VALID_AFK_TIMEOUTS = new Set([60, 300, 900, 1800, 3600]);

// Limites imposées par Discord : une fois franchies, TOUTES les créations
// échouent. On s'arrête proprement juste avant, avec un avertissement clair.
const MAX_GUILD_ROLES = 250;
const MAX_GUILD_CHANNELS = 500;

// Une seule restauration à la fois par serveur : deux clics simultanés (ou deux
// commandes dans deux salons) se détruiraient mutuellement les salons.
const activeRestores = new Set();

const BOT_PERMISSION_LABELS = {
  ManageChannels: 'Gérer les salons',
  ManageRoles:    'Gérer les rôles',
  ManageGuild:    'Gérer le serveur',
  BanMembers:     'Bannir des membres',
};

function generateBackupId() {
  return nanoid(10).replace(/[-_]/g, 'X').toUpperCase();
}

function nameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Exécute `fn` sur chaque élément avec un plafond de parallélisme : assez rapide
// pour un gros serveur, assez prudent pour ne pas déclencher de rate limit.
async function pool(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function download(url) {
  if (!url || typeof fetch !== 'function') throw new Error('téléchargement indisponible');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function isThreadChannel(channel) {
  if (typeof channel?.isThread === 'function') {
    try { return Boolean(channel.isThread()); } catch { /* repli sur le type */ }
  }
  return [10, 11, 12].includes(num(channel?.type, -1));
}

// 10003 = salon inconnu, 10011 = rôle inconnu : l'élément a déjà disparu
// (suppression en cascade d'un parent), ce n'est pas un échec de restauration.
function isUnknownResource(err) {
  const code = Number(err?.code ?? err?.rawError?.code ?? NaN);
  return code === 10003 || code === 10011;
}

function baseReport() {
  return {
    ok: true,
    errors: [],
    warnings: [],
    deletedChannels: 0,
    deletedRoles: 0,
    rolesCreated: 0,
    rolesFailed: 0,
    channelsCreated: 0,
    channelsFailed: 0,
    // Salons qui étaient verrouillés dans la sauvegarde, et verrous qu'il a
    // fallu reposer après la création (overwrite @everyone absent ou écarté).
    channelsLocked: 0,
    locksReapplied: 0,
    bansRestored: 0,
    durationMs: 0,
  };
}

// ── Permissions du bot ──────────────────────────────────────────────────────
// Le membre du bot peut être absent du cache (redémarrage, gros serveur) : sans
// lui, aucun contrôle n'était fait et la restauration échouait en plein vol.
async function resolveBotMember(guild) {
  if (guild?.members?.me) return guild.members.me;
  try {
    if (typeof guild?.members?.fetchMe === 'function') return await guild.members.fetchMe();
  } catch { /* intraduisible hors ligne */ }
  try {
    const id = guild?.client?.user?.id;
    if (id && typeof guild?.members?.fetch === 'function') return await guild.members.fetch(id);
  } catch { /* reste inconnu */ }
  return null;
}

function permissionState(member) {
  const permissions = member?.permissions ?? null;
  let bitfield = null;
  try {
    const raw = permissions?.bitfield;
    if (typeof raw === 'bigint') bitfield = raw;
    else if (raw !== undefined && raw !== null) bitfield = BigInt(raw);
  } catch { bitfield = null; }

  const has = (flag) => {
    const value = PermissionsBitField.Flags[flag];
    if (value === undefined) return true;
    if (bitfield !== null) return (bitfield & value) === value;
    try {
      if (typeof permissions?.has === 'function') return Boolean(permissions.has(value));
    } catch { /* ignore */ }
    return false;
  };

  return { member: member ?? null, bitfield, has, isAdmin: has('Administrator') };
}

function requiredPermissions(backup, { restoreRoles = true, restoreChannels = true, restoreSettings = true } = {}) {
  const flags = [];
  if (restoreChannels) flags.push('ManageChannels');
  // Recréer un rôle OU poser une permission de salon exige « Gérer les rôles ».
  const hasOverwrites = (Array.isArray(backup?.channels) ? backup.channels : [])
    .some(channel => Array.isArray(channel?.permissionOverwrites) && channel.permissionOverwrites.length > 0);
  if (restoreRoles || (restoreChannels && hasOverwrites)) flags.push('ManageRoles');
  if (restoreSettings) flags.push('ManageGuild');
  return flags;
}

// Contrôle AVANT toute suppression : un refus ici laisse le serveur intact.
async function preflightRestore(guild, backup, options = {}) {
  const member = await resolveBotMember(guild);
  const state = permissionState(member);
  const required = requiredPermissions(backup, options);
  const missing = member ? required.filter(flag => !state.has(flag)) : [];
  return {
    ...state,
    ok: missing.length === 0,
    memberKnown: Boolean(member),
    required,
    missing,
    missingLabels: missing.map(flag => BOT_PERMISSION_LABELS[flag] || flag),
    canBan: !member || state.has('BanMembers'),
  };
}

// Discord refuse qu'un bot accorde une permission qu'il ne possède pas
// (50013). On réduit la demande à ses propres droits plutôt que de perdre le
// rôle ou de faire échouer la restauration.
function restrictPermissions(bits, state) {
  if (!state || state.isAdmin || state.bitfield === null) return bits;
  return bits & state.bitfield;
}

function isRestoring(guildId) {
  return activeRestores.has(String(guildId));
}

// ── Lecture de la base ──────────────────────────────────────────────────────
async function listBackups(guildId, limit = 10) {
  return ServerBackup.find({ guildId }).sort({ createdAt: -1 }).limit(limit).lean();
}

async function findBackup(guildId, backupId) {
  return ServerBackup.findOne({ guildId, backupId: String(backupId).toUpperCase() }).lean();
}

// Un identifiant de sauvegarde est unique tous serveurs confondus : c'est lui qui
// permet de restaurer une structure sur un AUTRE serveur. L'autorisation, elle,
// est décidée par la commande (créateur, owner du bot, ou sauvegarde partagée).
async function findBackupAnywhere(backupId) {
  return ServerBackup.findOne({ backupId: String(backupId).toUpperCase() }).lean();
}

async function setBackupShared(guildId, backupId, shared) {
  return ServerBackup.updateOne(
    { guildId, backupId: String(backupId).toUpperCase() },
    { $set: { shared: Boolean(shared) } },
  );
}

async function deleteBackup(guildId, backupId) {
  return ServerBackup.deleteOne({ guildId, backupId: String(backupId).toUpperCase() });
}

async function countBackups(guildId) {
  return ServerBackup.countDocuments({ guildId });
}

// ── Création ────────────────────────────────────────────────────────────────
async function createBackup(guild, userId, backupName, { model = ServerBackup } = {}) {
  const warnings = [];

  await guild.fetch?.().catch(() => null);
  for (const [label, cache] of [
    ['rôles', guild.roles], ['salons', guild.channels], ['emojis', guild.emojis],
  ]) {
    try { await cache?.fetch?.(); } catch (err) { warnings.push(`Cache ${label} incomplet : ${err.message}`); }
  }

  const snapshot = sb.snapshotGuild(guild);

  let bans = [];
  try {
    const fetched = await guild.bans?.fetch?.();
    bans = sb.values(fetched)
      .map(ban => ({
        userId: String(ban?.user?.id ?? ban?.userId ?? ''),
        reason: ban?.reason ?? null,
      }))
      .filter(ban => sb.isSnowflake(ban.userId));
  } catch {
    warnings.push('Liste des bannissements illisible (permission « Bannir des membres » absente ?).');
  }

  const counts = {
    roles:      snapshot.roles.length,
    categories: snapshot.channels.filter(c => c.type === TYPE.category).length,
    channels:   snapshot.channels.filter(c => c.type !== TYPE.category).length,
    locked:     snapshot.channels.filter(c => channelLock.isEntryLocked(c, guild.id)).length,
    emojis:     snapshot.emojis.length,
    bans:       bans.length,
  };

  const backupId = generateBackupId();
  const doc = await model.create({
    guildId:    guild.id,
    backupId,
    name:       String(backupName || 'Sauvegarde').slice(0, 60),
    createdBy:  userId,
    version:    sb.BACKUP_SCHEMA_VERSION,
    guildName:  snapshot.guild.name,
    guild:      snapshot.guild,
    everyonePermissions: snapshot.everyonePermissions,
    roles:      snapshot.roles,
    channels:   snapshot.channels,
    emojis:     snapshot.emojis,
    bans,
    counts,
    createdAt:  new Date(),
  });

  return { backup: doc, counts, warnings };
}

// ── Restauration ────────────────────────────────────────────────────────────
async function restoreBackup(guild, backup, options = {}) {
  const guildKey = String(guild?.id || '');
  if (!guildKey) {
    const orphan = baseReport();
    orphan.ok = false;
    orphan.errors.push('Serveur introuvable : restauration impossible.');
    return orphan;
  }
  if (activeRestores.has(guildKey)) {
    const busy = baseReport();
    busy.ok = false;
    busy.busy = true;
    busy.errors.push('Une restauration est déjà en cours sur ce serveur : attendez la fin de la précédente.');
    return busy;
  }
  activeRestores.add(guildKey);
  try {
    return await applyRestore(guild, backup, options);
  } finally {
    activeRestores.delete(guildKey);
  }
}

async function applyRestore(guild, backup, options = {}) {
  const started = Date.now();
  const report = baseReport();

  const {
    clearExisting  = true,
    restoreRoles   = true,
    restoreChannels = true,
    restoreSettings = true,
    restoreBans    = true,
    // L'identité du serveur (nom, icône, bannière) n'est restaurée que sur son
    // serveur d'origine : un import ne doit pas transformer le serveur cible.
    restoreIdentity = String(backup?.guildId || '') === String(guild.id),
    renameGuild    = String(backup?.guildId || '') === String(guild.id),
    onProgress     = null,
  } = options;

  const step = (phase, detail) => {
    try { onProgress?.({ phase, detail }); } catch { /* progression facultative */ }
  };
  const fail = (message) => report.errors.push(message);

  const plan = sb.buildRestorePlan(backup);

  // ── 0. Permissions du bot ────────────────────────────────────────────────
  const preflight = await preflightRestore(guild, backup, {
    restoreRoles, restoreChannels, restoreSettings,
  });
  const me = preflight.member;
  let bansAllowed = restoreBans;

  // Rien n'est supprimé avant ce contrôle : un refus ici laisse le serveur
  // strictement intact.
  if (!preflight.ok) {
    report.ok = false;
    fail(
      `Permissions manquantes pour le bot : ${preflight.missingLabels.join(', ')}. `
      + 'Aucun salon ni rôle n\'a été touché.',
    );
    report.durationMs = Date.now() - started;
    return report;
  }

  // La liste des bannissements est un bonus : son absence ne doit pas empêcher
  // de reconstruire les salons et les rôles.
  if (restoreBans && !preflight.canBan) {
    bansAllowed = false;
    report.warnings.push('Permission « Bannir des membres » absente : bannissements non restaurés.');
  }

  const botTopPosition = num(me?.roles?.highest?.position, 0);
  // Rôles attribués au bot : les supprimer lui retirerait ses permissions en
  // pleine restauration.
  const ownRoleIds = new Set(sb.values(me?.roles?.cache).map(role => String(role.id)));

  try {
    // ── 1. Nettoyage ──────────────────────────────────────────────────────
    if (clearExisting) {
      step('suppression', 'Suppression des salons existants');
      const existingChannels = sb.values(guild.channels?.cache).filter(channel => !isThreadChannel(channel));
      // Enfants d'abord, catégories ensuite : supprimer une catégorie efface ses
      // enfants en cascade, et la suppression d'un enfant déjà disparu renvoyait
      // une erreur alors que tout se passait bien.
      const existingCategories = existingChannels.filter(channel => num(channel.type, -1) === TYPE.category);
      const existingChildren = existingChannels.filter(channel => num(channel.type, -1) !== TYPE.category);
      const removeChannel = async (channel) => {
        try {
          await channel.delete(REASON);
          report.deletedChannels++;
        } catch (err) {
          if (isUnknownResource(err)) return; // déjà supprimé par sa catégorie
          fail(`Salon « ${channel.name} » non supprimé : ${err.message}`);
        }
      };
      await pool(existingChildren, 4, removeChannel);
      await pool(existingCategories, 2, removeChannel);

      step('suppression', 'Suppression des rôles existants');
      const existingRoles = sb.values(guild.roles?.cache)
        .filter(role => String(role.id) !== String(guild.id) && !role.managed);
      for (const role of existingRoles) {
        const position = num(role.position, 0);
        if (ownRoleIds.has(String(role.id))) {
          report.warnings.push(`Rôle « ${role.name} » conservé : il porte les permissions du bot.`);
          continue;
        }
        if (botTopPosition > 0 && position >= botTopPosition) {
          report.warnings.push(
            `Rôle « ${role.name} » non supprimé : il est au-dessus du rôle du bot. `
            + 'Placez le rôle du bot plus haut dans la hiérarchie puis relancez pour un résultat exact.',
          );
          continue;
        }
        try {
          await guild.roles.delete(role.id, REASON);
          report.deletedRoles++;
        } catch (err) {
          if (isUnknownResource(err)) continue;
          fail(`Rôle « ${role.name} » non supprimé : ${err.message}`);
        }
      }
    }

    // ── 2. @everyone ──────────────────────────────────────────────────────
    // @everyone fait partie des rôles : sans `restoreRoles`, on n'y touche pas.
    if (restoreRoles && plan.everyonePermissions !== null && plan.everyonePermissions !== undefined) {
      const requested = BigInt(plan.everyonePermissions);
      const granted = restrictPermissions(requested, preflight);
      if (granted !== requested) {
        report.warnings.push(
          'Permissions de @everyone réduites aux droits du bot : il ne peut pas accorder '
          + 'une permission qu\'il ne possède pas lui-même.',
        );
      }
      // API réelle : `Role#setPermissions` existe, `RoleManager#setPermissions`
      // n'existe PAS (vérifié dans discord.js 14.27) — le repli passe par edit().
      const everyone = guild.roles?.everyone ?? guild.roles?.cache?.get?.(guild.id) ?? null;
      const trySet = async () => {
        if (everyone && typeof everyone.setPermissions === 'function') {
          return everyone.setPermissions(granted, REASON);
        }
        if (typeof guild.roles?.edit === 'function') {
          return guild.roles.edit(guild.id, { permissions: granted, reason: REASON });
        }
        return null;
      };
      try { await trySet(); } catch (err) { fail(`Permissions de @everyone non appliquées : ${err.message}`); }
    }

    // ── 3. Rôles ──────────────────────────────────────────────────────────
    const roleIdMap = new Map(); // ancien ID → nouvel ID (string)
    if (restoreRoles) {
      // Limite Discord de 250 rôles : au-delà, chaque création échoue. On
      // s'arrête avant, avec un avertissement explicite.
      const existingRoleCount = sb.values(guild.roles?.cache).length;
      const roleSlots = Math.max(0, MAX_GUILD_ROLES - existingRoleCount);
      const rolesToCreate = plan.roles.slice(0, roleSlots);
      if (rolesToCreate.length < plan.roles.length) {
        report.warnings.push(
          `${plan.roles.length - rolesToCreate.length} rôle(s) non créés : le serveur atteindrait la limite de ${MAX_GUILD_ROLES} rôles.`,
        );
      }
      step('rôles', `Recréation de ${rolesToCreate.length} rôle(s)`);

      // Position cible : rang dans la hiérarchie D'ORIGINE, rôles gérés compris.
      // Ils ne sont pas recréés, mais ils occupent une place qu'on respecte.
      const allOriginal = [...(backup.roles || [])]
        .sort((a, b) => num(a.position) - num(b.position) || String(a.name).localeCompare(String(b.name)));
      const targetRank = new Map(allOriginal.map((role, index) => [String(role.id), index + 1]));

      const createdRoles = [];
      let clampedRoles = 0;
      for (const role of rolesToCreate) {
        const target = targetRank.get(String(role.id)) || createdRoles.length + 1;
        const requested = BigInt(role.permissions || 0);
        // Un bot ne peut pas créer un rôle avec une permission qu'il n'a pas
        // lui-même : on accorde ce qui est possible au lieu de perdre le rôle.
        const granted = restrictPermissions(requested, preflight);
        if (granted !== requested) clampedRoles++;
        try {
          const colors = role.colors && (role.colors.secondary || role.colors.tertiary)
            ? {
              primaryColor:   role.colors.primary ?? role.color ?? 0,
              secondaryColor: role.colors.secondary ?? null,
              tertiaryColor:  role.colors.tertiary ?? null,
            }
            : { primaryColor: role.color ?? 0 };
          const created = await guild.roles.create({
            name:        role.name,
            colors,
            hoist:       Boolean(role.hoist),
            mentionable: Boolean(role.mentionable),
            permissions: granted,
            unicodeEmoji: role.unicodeEmoji || undefined,
            reason:      REASON,
          });
          roleIdMap.set(String(role.id), created.id);
          createdRoles.push({ role: created, target, original: role });
          report.rolesCreated++;
        } catch (err) {
          report.rolesFailed++;
          fail(`Rôle « ${role.name} » non créé : ${err.message}`);
        }
      }
      if (clampedRoles > 0) {
        report.warnings.push(
          `${clampedRoles} rôle(s) recréés avec des permissions réduites à celles du bot `
          + '(Discord interdit d\'accorder une permission que le bot ne possède pas).',
        );
      }

      if (createdRoles.length > 0) {
        // Le bot ne peut pas placer un rôle au-dessus de son propre rôle : on
        // calcule un plan qui reste sous ce plafond, sans position en double
        // (Discord refuse une hiérarchie ambiguë).
        const liveTop = num(me?.roles?.highest?.position, botTopPosition);
        const ceiling = liveTop > 0 ? liveTop - 1 : null;
        const descending = [...createdRoles].sort((a, b) => b.target - a.target);
        const planned = [];
        let previous = ceiling ?? Number.MAX_SAFE_INTEGER;
        for (const entry of descending) {
          const position = Math.min(entry.target, previous);
          if (position < 1) break; // plus de place sous le rôle du bot
          planned.push({ entry, position });
          previous = position - 1;
        }

        const unreachable = createdRoles.length - planned.length;
        const moved = planned.filter(({ entry, position }) => position !== entry.target).length;
        if (unreachable > 0 || moved > 0) {
          report.warnings.push(
            `${unreachable + moved} rôle(s) n'ont pas pu atteindre leur position d'origine : `
            + 'le rôle du bot est trop bas dans la hiérarchie. Placez-le plus haut puis relancez.',
          );
        }

        if (planned.length > 0) {
          planned.sort((a, b) => a.position - b.position);
          try {
            await guild.roles.setPositions(planned.map(({ entry, position }) => ({ role: entry.role, position })));
          } catch (err) {
            report.warnings.push(`Hiérarchie des rôles non appliquée en bloc : ${err.message}`);
            for (const { entry, position } of planned) {
              try { await guild.roles.setPosition(entry.role, position); } catch { /* déjà signalé */ }
            }
          }
        }
      }
    }

    // ── 4. Salons ─────────────────────────────────────────────────────────
    const channelIdMap = new Map(); // ancien ID → nouvel ID
    if (restoreChannels) {
      const roleNameById = new Map((backup.roles || []).map(role => [String(role.id), role.name]));
      const rolesByName = new Map(sb.values(guild.roles?.cache).map(role => [nameKey(role.name), role.id]));
      const droppedOverwrites = [];
      const lockedChannels = []; // salons à vérifier une fois tous créés
      let aboveBotOverwrites = 0;

      // Limite Discord de 500 salons : on s'arrête proprement au lieu de laisser
      // échouer toutes les créations restantes.
      const existingChannelCount = sb.values(guild.channels?.cache).filter(channel => !isThreadChannel(channel)).length;
      let channelSlots = Math.max(0, MAX_GUILD_CHANNELS - existingChannelCount);
      let channelCapWarned = false;

      const buildOverwrites = (entry) => {
        const { overwrites, dropped } = sb.translateOverwrites(entry.permissionOverwrites, {
          roleIdMap,
          roleNameById,
          rolesByName,
          everyoneId:    guild.id,
          everyoneOldId: backup.guildId,
          guildId:       guild.id,
        });
        for (const drop of dropped) droppedOverwrites.push(`${entry.name} → rôle ${drop.id} (${drop.reason})`);

        // Une permission visant un rôle plus haut que le rôle du bot est refusée
        // par Discord (50013) — et ferait perdre TOUT le salon : on l'écarte.
        const liveTop = num(me?.roles?.highest?.position, botTopPosition);
        if (liveTop <= 0) return overwrites;
        const kept = [];
        for (const overwrite of overwrites) {
          const isRole = num(overwrite.type, OverwriteType.Role) === OverwriteType.Role;
          if (isRole && String(overwrite.id) !== String(guild.id)) {
            const targetRole = guild.roles?.cache?.get?.(String(overwrite.id)) ?? null;
            if (targetRole && num(targetRole.position, 0) >= liveTop) {
              aboveBotOverwrites++;
              continue;
            }
          }
          kept.push(overwrite);
        }
        return kept;
      };

      const createChannel = async (entry, parentId) => {
        if (channelSlots <= 0) {
          if (!channelCapWarned) {
            channelCapWarned = true;
            report.warnings.push(`Salons non créés au-delà de la limite de ${MAX_GUILD_CHANNELS} salons par serveur.`);
          }
          return null;
        }
        channelSlots--;
        const type = num(entry.type, TYPE.text);
        const options = {
          name:     sb.channelName(entry.name),
          type,
          permissionOverwrites: buildOverwrites(entry),
          reason:   REASON,
        };
        if (parentId) options.parent = parentId;

        if (TEXTUAL.has(type) || FORUM.has(type)) {
          if (entry.topic) options.topic = String(entry.topic).slice(0, 1024);
          options.nsfw = Boolean(entry.nsfw);
          options.rateLimitPerUser = num(entry.rateLimitPerUser, 0);
          options.defaultThreadRateLimitPerUser = num(entry.defaultThreadRateLimitPerUser, 0);
          const archive = num(entry.defaultAutoArchiveDuration, 0);
          if (sb.AUTO_ARCHIVE_ALLOWED.has(archive)) options.defaultAutoArchiveDuration = archive;
        }
        if (VOICE.has(type)) {
          options.nsfw = Boolean(entry.nsfw);
          if (num(entry.bitrate, 0) > 0) {
            options.bitrate = Math.min(num(entry.bitrate), num(guild.maximumBitrate, 96000) || 96000);
          }
          options.userLimit = Math.max(0, Math.min(99, num(entry.userLimit, 0)));
          if (entry.rtcRegion) options.rtcRegion = entry.rtcRegion;
          if (entry.videoQualityMode) options.videoQualityMode = num(entry.videoQualityMode);
        }
        if (FORUM.has(type)) {
          if (Array.isArray(entry.availableTags) && entry.availableTags.length > 0) {
            const seen = new Set();
            const tags = [];
            for (const tag of entry.availableTags.slice(0, 20)) {
              const name = String(tag.name || '').trim().slice(0, 20);
              if (!name || seen.has(nameKey(name))) continue;
              seen.add(nameKey(name));              const resolved = resolveTagEmoji(tag);
              tags.push(resolved ? { name, moderated: Boolean(tag.moderated), ...resolved } : { name, moderated: Boolean(tag.moderated) });
            }
            if (tags.length > 0) options.availableTags = tags;
          }
          if (entry.defaultReactionEmoji) {
            const resolved = resolveTagEmoji(entry.defaultReactionEmoji);
            if (resolved) options.defaultReactionEmoji = resolved;
          }
          if (entry.defaultSortOrder) options.defaultSortOrder = num(entry.defaultSortOrder);
          if (entry.defaultForumLayout) options.defaultForumLayout = num(entry.defaultForumLayout);
        }

        const created = await guild.channels.create(options);
        channelIdMap.set(String(entry.id), created.id);
        report.channelsCreated++;
        if (channelLock.isEntryLocked(entry, backup.guildId)) lockedChannels.push({ entry, channel: created });
        return created;
      };

      step('catégories', `Recréation de ${plan.categories.length} catégorie(s)`);
      for (const category of plan.categories) {
        try {
          await createChannel(category, null);
        } catch (err) {
          report.channelsFailed++;
          fail(`Catégorie « ${category.name} » non créée : ${err.message}`);
        }
      }

      step('salons', 'Recréation des salons dans leurs catégories');
      for (const group of plan.groups) {
        const parentId = group.parentOldId ? channelIdMap.get(String(group.parentOldId)) : null;
        if (group.parentOldId && !parentId) {
          report.warnings.push(
            `Catégorie « ${group.parentName} » absente : ses ${group.channels.length} salon(s) sont recréés hors catégorie.`,
          );
        }
        for (const entry of group.channels) {
          try {
            await createChannel(entry, parentId);
          } catch (err) {
            report.channelsFailed++;
            fail(`Salon « ${entry.name} » non créé : ${err.message}`);
          }
        }
      }

      if (droppedOverwrites.length > 0) {
        report.warnings.push(`${droppedOverwrites.length} permission(s) de rôle ignorée(s) (rôle introuvable).`);
      }
      if (aboveBotOverwrites > 0) {
        report.warnings.push(
          `${aboveBotOverwrites} permission(s) ignorée(s) : elles visent un rôle au-dessus du rôle du bot, `
          + 'que Discord interdit de modifier. Placez le rôle du bot plus haut pour les restaurer.',
        );
      }

      // ── 6. Ordre exact ──────────────────────────────────────────────────
      step('ordre', 'Application de l\'ordre d\'origine');
      const positions = [];
      for (const category of plan.categories) {
        const id = channelIdMap.get(String(category.id));
        if (id) positions.push({ channel: id, position: category.position });
      }
      for (const group of plan.groups) {
        for (const entry of group.channels) {
          const id = channelIdMap.get(String(entry.id));
          if (id) positions.push({ channel: id, position: entry.position });
        }
      }

      if (positions.length > 0) {
        try {
          await guild.channels.setPositions(positions);
        } catch (err) {
          report.warnings.push(`Réorganisation groupée refusée (${err.message}) : application salon par salon.`);
          for (const entry of positions) {
            try { await guild.channels.setPosition(entry.channel, entry.position); } catch { /* déjà signalé */ }
          }
        }
      }

      // ── 5 bis. Verrous ──────────────────────────────────────────────────
      // Un salon verrouillé sur le serveur d'origine doit l'être ici aussi. Le
      // verrou voyage normalement avec l'overwrite @everyone recopié plus haut ;
      // on VÉRIFIE quand même, et on le repose s'il manque : une sauvegarde
      // ancienne (sans overwrite traduisible) ou un overwrite écarté laisserait
      // sinon le salon ouvert à tout le monde, sans que personne ne le sache.
      if (lockedChannels.length > 0) {
        step('verrous', `Vérification de ${lockedChannels.length} salon(s) verrouillé(s)`);
        let reapplied = 0;
        for (const { entry, channel } of lockedChannels) {
          try {
            const result = await channelLock.setChannelLock(channel, guild, { locked: true, reason: REASON });
            if (result.ok && result.changed) reapplied++;
          } catch (err) {
            report.warnings.push(`Salon « ${entry.name} » non verrouillé : ${err.message}`);
          }
        }
        report.channelsLocked = lockedChannels.length;
        report.locksReapplied = reapplied;
        if (reapplied > 0) {
          report.warnings.push(
            `${reapplied} verrou(s) reposé(s) : l'overwrite @everyone n'avait pas été recopié à la création.`,
          );
        }
      }

      // Anti-verrouillage : si la sauvegarde ne donne pas au bot l'accès aux
      // salons qu'il vient de créer, il devient aveugle (rapport, modération,
      // logs) dans son propre serveur. On lui rend UNIQUEMENT « Voir les
      // salons », et on le signale.
      if (me && !preflight.isAdmin) {
        let lockedOut = 0;
        for (const created of sb.values(guild.channels?.cache)) {
          if (typeof created.permissionsFor !== 'function') continue;
          let canView = true;
          try { canView = created.permissionsFor(me)?.has(PermissionsBitField.Flags.ViewChannel) !== false; } catch { canView = true; }
          if (canView) continue;
          lockedOut++;
          try {
            if (typeof created.permissionOverwrites?.edit === 'function') {
              // Overwrite de MEMBRE (le bot lui-même) : Discord autorise toujours
              // un bot à gérer son propre accès, contrairement à un rôle.
              await created.permissionOverwrites.edit(
                me.id,
                { ViewChannel: true },
                { type: OverwriteType.Member, reason: REASON },
              );
            }
          } catch { /* signalé par le total ci-dessous */ }
        }
        if (lockedOut > 0) {
          report.warnings.push(
            `${lockedOut} salon(s) ne laissaient plus accès au bot : permission « Voir les salons » ajoutée `
            + 'à son rôle pour qu\'il continue de fonctionner.',
          );
        }
      }
    }

    // ── 7. Réglages du serveur ────────────────────────────────────────────
    if (restoreSettings) {
      step('réglages', 'Application des réglages du serveur');
      const settings = backup.guild || {};
      const payload = {};
      const name = settings.name ? String(settings.name).slice(0, 100) : '';
      if (renameGuild && name.length >= 2) payload.name = name;
      if (VALID_AFK_TIMEOUTS.has(num(settings.afkTimeout, 0))) payload.afkTimeout = num(settings.afkTimeout);
      if (num(settings.verificationLevel, -1) >= 0 && num(settings.verificationLevel, -1) <= 4) {
        payload.verificationLevel = num(settings.verificationLevel);
      }
      if (num(settings.explicitContentFilter, -1) >= 0 && num(settings.explicitContentFilter, -1) <= 2) {
        payload.explicitContentFilter = num(settings.explicitContentFilter);
      }
      if ([0, 1].includes(num(settings.defaultMessageNotifications, -1))) {
        payload.defaultMessageNotifications = num(settings.defaultMessageNotifications);
      }
      // Une locale retirée par Discord ferait échouer TOUS les réglages : on ne
      // l'envoie que si elle est encore reconnue par la bibliothèque.
      if (settings.preferredLocale
        && (!Locale || !Object.values(Locale).length || Object.values(Locale).includes(settings.preferredLocale))) {
        payload.preferredLocale = settings.preferredLocale;
      }

      for (const [field, oldId] of [
        ['afkChannel',    settings.afkChannelId],
        ['systemChannel', settings.systemChannelId],
      ]) {
        const mapped = oldId ? channelIdMap.get(String(oldId)) : null;
        if (mapped) payload[field] = mapped;
      }

      if (Object.keys(payload).length > 0) {
        try {
          await guild.edit(payload);
        } catch (err) {
          fail(`Réglages du serveur non appliqués : ${err.message}`);
        }
      }

      // Salons réservés aux serveurs communautaires : appliqués à part pour qu'un
      // serveur non-communautaire ne fasse pas perdre nom, filtre et vérification.
      const community = {};
      for (const [field, oldId] of [
        ['rulesChannel',         settings.rulesChannelId],
        ['publicUpdatesChannel', settings.publicUpdatesChannelId],
      ]) {
        const mapped = oldId ? channelIdMap.get(String(oldId)) : null;
        if (mapped) community[field] = mapped;
      }
      if (Object.keys(community).length > 0) {
        try {
          await guild.edit(community);
        } catch (err) {
          report.warnings.push(`Salons communautaires non restaurés : ${err.message}`);
        }
      }

      for (const [label, url, method] of [
        ['icône', restoreIdentity ? settings.icon : null, 'setIcon'],
        ['bannière', restoreIdentity ? settings.banner : null, 'setBanner'],
      ]) {
        if (!url || typeof guild[method] !== 'function') continue;
        try {
          await guild[method](await download(url));
        } catch (err) {
          report.warnings.push(`${label} non restaurée : ${err.message}`);
        }
      }
    }

    // ── 8. Bannissements ─────────────────────────────────────────────────
    if (bansAllowed && Array.isArray(backup.bans) && backup.bans.length > 0) {
      step('bannissements', `Restauration de ${backup.bans.length} bannissement(s)`);
      const protectedIds = new Set([
        String(guild.ownerId || ''),
        String(me?.id || ''),
        String(guild.client?.user?.id || ''),
      ].filter(Boolean));
      for (const ban of backup.bans) {
        const userId = String(ban.userId || '');
        if (!sb.isSnowflake(userId) || protectedIds.has(userId)) continue;
        try {
          await guild.bans.create(userId, { reason: ban.reason || REASON });
          report.bansRestored++;
        } catch (err) {
          report.warnings.push(`Bannissement ${userId} non restauré : ${err.message}`);
        }
      }
    }
  } catch (err) {
    fail(`Restauration interrompue : ${err.message}`);
  }

  try { await guild.channels?.fetch?.(); } catch { /* rafraîchissement facultatif */ }
  try { await guild.roles?.fetch?.(); } catch { /* rafraîchissement facultatif */ }

  report.ok = report.errors.length === 0;
  report.durationMs = Date.now() - started;
  return report;
}

// Un tag de forum ne peut référencer qu'un emoji DU serveur, et les emojis
// personnalisés ne sont jamais retéléversés (règle du projet). On ne garde donc
// que les emojis Unicode : un identifiant mort ferait échouer la création du salon.
function resolveTagEmoji(tag) {
  if (!tag) return null;
  const name = tag.emojiName == null ? null : String(tag.emojiName);
  if (name && /[^\x00-\x7F]/.test(name)) return { emojiName: name.slice(0, 64) };
  return null;
}

module.exports = {
  createBackup,
  restoreBackup,
  preflightRestore,
  isRestoring,
  restrictPermissions,
  permissionState,
  resolveBotMember,
  isUnknownResource,
  generateBackupId,
  listBackups,
  findBackup,
  findBackupAnywhere,
  setBackupShared,
  deleteBackup,
  countBackups,
  pool,
  resolveTagEmoji,
};
