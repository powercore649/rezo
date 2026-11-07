'use strict';
// utils/serverBackup.js — Cœur du système de sauvegarde de serveur.
//
// Ce module est PUR : il ne parle ni à la base ni à Discord. Il transforme un
// serveur en instantané sérialisé (snapshotGuild), puis cet instantané en plan
// de restauration ordonné (buildRestorePlan) que utils/backupManager.js exécute.
// Cette séparation permet de tester la fidélité du plan hors-ligne, sans réseau.
//
// Trois principes de fidélité :
//   1. L'ORDRE est reconstruit, jamais deviné : positions d'origine normalisées
//      par groupe. Les catégories et les salons sans catégorie partagent la même
//      séquence de premier niveau (comme sur Discord), les enfants sont numérotés
//      à l'intérieur de leur catégorie.
//   2. Les IDENTIFIANTS changent : tout rôle/salon recréé reçoit un nouvel ID.
//      Les overwrites, `parentId` et les salons système sont donc traduits via
//      des tables de correspondance, jamais réutilisés tels quels.
//   3. Les PERMISSIONS sont copiées bit à bit (BigInt en chaîne), y compris le
//      rôle @everyone dont les droits ne peuvent pas être recréés.
//   4. Les VERROUS sont explicites : un salon fermé sur le serveur d'origine est
//      marqué `locked`, et la restauration le referme même si son overwrite a
//      été écarté (voir utils/channelLock.js).

const { ChannelType, OverwriteType } = require('discord.js');
const channelLock = require('./channelLock');

const BACKUP_SCHEMA_VERSION = 2;

// Types sauvegardables. Les threads (10/11/12) sont volontairement exclus : ils
// naissent de messages et n'ont pas d'existence propre à restaurer.
const TYPE = {
  text:         ChannelType.GuildText,
  voice:        ChannelType.GuildVoice,
  category:     ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage:        ChannelType.GuildStageVoice,
  forum:        ChannelType.GuildForum,
  media:        ChannelType.GuildMedia ?? 16,
};

const SUPPORTED_TYPES = new Set(Object.values(TYPE));
const TEXTUAL_TYPES  = new Set([TYPE.text, TYPE.announcement]);
const VOICE_TYPES    = new Set([TYPE.voice, TYPE.stage]);
const FORUM_TYPES    = new Set([TYPE.forum, TYPE.media]);
const THREAD_TYPES   = new Set([10, 11, 12]);

const TYPE_LABEL = {
  [TYPE.text]:         'texte',
  [TYPE.voice]:        'vocal',
  [TYPE.category]:     'catégorie',
  [TYPE.announcement]: 'annonces',
  [TYPE.stage]:        'conférence',
  [TYPE.forum]:        'forum',
  [TYPE.media]:        'média',
};

const AUTO_ARCHIVE_ALLOWED = new Set([60, 1440, 4320, 10080]);
const AUTO_ARCHIVE_DEFAULT = 1440;

// ── Petits utilitaires tolérants ─────────────────────────────────────────────
function values(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return [...collection];
  if (typeof collection.values === 'function') return [...collection.values()];
  if (typeof collection.map === 'function') return collection.map(v => v);
  return [];
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bitfieldToString(value) {
  try {
    return BigInt(value ?? 0).toString();
  } catch {
    return '0';
  }
}

function safeString(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return typeof max === 'number' ? s.slice(0, max) : s;
}

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{15,21}$/.test(value);
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function channelName(name) {
  const s = String(name ?? '').trim();
  return (s || 'salon').slice(0, 100);
}

// ── Sérialisation ────────────────────────────────────────────────────────────
function serializeOverwrites(channel) {
  const raw = channel?.permissionOverwrites?.cache ?? channel?.permissionOverwrites ?? [];
  return values(raw)
    .filter(o => o && o.id)
    .map(o => ({
      id:    String(o.id),
      type:  toInt(o.type, OverwriteType.Role),
      allow: bitfieldToString(o.allow?.bitfield ?? o.allow),
      deny:  bitfieldToString(o.deny?.bitfield ?? o.deny),
    }));
}

function serializeRole(role) {
  const colors = role?.colors || {};
  const primary = toInt(colors.primaryColor ?? role?.color ?? role?.colors?.primary_color, 0);
  return {
    id:          String(role.id),
    name:        safeString(role.name, 100) || 'role',
    color:       primary,
    colors: {
      primary:   primary,
      secondary: colors.secondaryColor ?? null,
      tertiary:  colors.tertiaryColor ?? null,
    },
    hoist:       Boolean(role.hoist),
    position:    toInt(role.position, 0),
    permissions: bitfieldToString(role.permissions?.bitfield ?? role.permissions),
    mentionable: Boolean(role.mentionable),
    managed:     Boolean(role.managed),
    unicodeEmoji: role.unicodeEmoji ?? null,
  };
}

function serializeTag(tag) {
  return {
    name:      safeString(tag?.name, 20) || 'tag',
    moderated: Boolean(tag?.moderated),
    // L'emoji d'un tag ne survit pas à une restauration si l'emoji change d'ID :
    // on garde son NOM, résolu au moment de la recréation (voir backupManager).
    emojiName: tag?.emojiName ?? tag?.emoji_name ?? tag?.emoji?.name ?? null,
    emojiId:   tag?.emojiId ?? tag?.emoji_id ?? tag?.emoji?.id ?? null,
  };
}

function serializeChannel(channel, guildId = null) {
  const type = toInt(channel.type, TYPE.text);
  const data = {
    id:                   String(channel.id),
    name:                 channelName(channel.name),
    type,
    position:             toInt(channel.rawPosition ?? channel.position, 0),
    parentId:             channel.parentId ? String(channel.parentId) : null,
    permissionOverwrites: serializeOverwrites(channel),
    // Verrou d'écriture (ou de connexion vocale) porté par @everyone.
    locked:               channelLock.isLocked(channel, guildId ?? channel?.guild?.id),
  };

  if (TEXTUAL_TYPES.has(type) || FORUM_TYPES.has(type)) {
    data.topic    = safeString(channel.topic, 1024);
    data.nsfw     = Boolean(channel.nsfw);
    data.rateLimitPerUser = Math.max(0, Math.min(21600, toInt(channel.rateLimitPerUser, 0)));
    data.defaultAutoArchiveDuration = toInt(channel.defaultAutoArchiveDuration, 0) || null;
    data.defaultThreadRateLimitPerUser = Math.max(0, Math.min(21600, toInt(channel.defaultThreadRateLimitPerUser, 0)));
  }

  if (VOICE_TYPES.has(type)) {
    data.bitrate          = toInt(channel.bitrate, 0) || null;
    data.userLimit        = Math.max(0, Math.min(99, toInt(channel.userLimit, 0)));
    data.rtcRegion        = channel.rtcRegion ?? null;
    data.videoQualityMode = channel.videoQualityMode ?? null;
    data.nsfw             = Boolean(channel.nsfw);
  }

  if (FORUM_TYPES.has(type)) {
    data.availableTags       = values(channel.availableTags).map(serializeTag);
    data.defaultReactionEmoji = channel.defaultReactionEmoji
      ? {
        emojiId:   channel.defaultReactionEmoji.emojiId ?? channel.defaultReactionEmoji.id ?? null,
        emojiName: channel.defaultReactionEmoji.emojiName ?? channel.defaultReactionEmoji.name ?? null,
      }
      : null;
    data.defaultSortOrder  = channel.defaultSortOrder ?? null;
    data.defaultForumLayout = channel.defaultForumLayout ?? null;
  }

  return data;
}

function serializeEmoji(emoji) {
  return {
    id:       String(emoji.id),
    name:     safeString(emoji.name, 32) || 'emoji',
    animated: Boolean(emoji.animated),
    url:      typeof emoji.imageURL === 'function' ? emoji.imageURL({ size: 128, extension: 'png' }) : null,
  };
}

// ── Instantané complet ───────────────────────────────────────────────────────
// `guild` doit avoir ses caches chargés (voir createBackup, qui await les fetch).
function snapshotGuild(guild) {
  const roles    = values(guild?.roles?.cache);
  const everyone = roles.find(r => r.id === guild?.id) || guild?.roles?.everyone || null;

  const roleEntries = roles
    .filter(r => r && String(r.id) !== String(guild?.id))
    .map(serializeRole)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  const channels = values(guild?.channels?.cache)
    .filter(ch => ch && !THREAD_TYPES.has(toInt(ch.type, -1)) && SUPPORTED_TYPES.has(toInt(ch.type, -1)))
    .map(ch => serializeChannel(ch, guild?.id))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  const emojis = values(guild?.emojis?.cache)
    .filter(e => e && !e.managed)
    .map(serializeEmoji);

  return {
    guild: {
      name:                        safeString(guild?.name, 100),
      icon:                        typeof guild?.iconURL === 'function' ? guild.iconURL({ extension: 'png', size: 256 }) : guild?.icon ?? null,
      banner:                      typeof guild?.bannerURL === 'function' ? guild.bannerURL({ extension: 'png', size: 1024 }) : null,
      description:                 guild?.description ?? null,
      verificationLevel:           toInt(guild?.verificationLevel, 0),
      explicitContentFilter:       toInt(guild?.explicitContentFilter, 0),
      defaultMessageNotifications: toInt(guild?.defaultMessageNotifications, 0),
      afkTimeout:                  toInt(guild?.afkTimeout, 300),
      afkChannelId:                guild?.afkChannelId ?? null,
      systemChannelId:             guild?.systemChannelId ?? null,
      rulesChannelId:              guild?.rulesChannelId ?? null,
      publicUpdatesChannelId:      guild?.publicUpdatesChannelId ?? null,
      preferredLocale:             guild?.preferredLocale ?? 'en-US',
    },
    everyonePermissions: bitfieldToString(everyone?.permissions?.bitfield ?? everyone?.permissions ?? 0),
    roles:    roleEntries,
    channels,
    emojis,
  };
}

// ── Plan de restauration ─────────────────────────────────────────────────────
function normalizeOrder(list) {
  return [...list]
    .sort((a, b) => (toInt(a.position, 0) - toInt(b.position, 0))
      || String(a.name).localeCompare(String(b.name))
      || String(a.id).localeCompare(String(b.id)))
    .map((entry, index) => ({ ...entry, position: index }));
}

// Construit l'ordre exact de recréation :
//   • premier niveau  → catégories ET salons sans catégorie, dans l'ordre d'origine ;
//   • second niveau   → enfants de chaque catégorie, numérotés 0..n-1 dans la catégorie.
// Les positions d'origine servent de clé de tri, jamais de valeur finale : deux
// salons peuvent partager une position après une manipulation manuelle.
function buildRestorePlan(backup) {
  const allChannels = Array.isArray(backup?.channels) ? backup.channels : [];
  const byType = c => toInt(c.type, TYPE.text);
  const isCategory = c => byType(c) === TYPE.category;
  const knownCategories = new Set(allChannels.filter(isCategory).map(c => String(c.id)));

  const orphanParentIds = [];
  const topLevel = [];
  const childrenByParent = new Map();

  for (const channel of allChannels) {
    const parentId = channel.parentId ? String(channel.parentId) : null;
    if (isCategory(channel) || !parentId) {
      topLevel.push(channel);
      continue;
    }
    if (!knownCategories.has(parentId)) {
      // La catégorie d'origine n'est pas dans la sauvegarde : le salon remonte au
      // premier niveau plutôt que d'être perdu (et la perte est signalée).
      if (!orphanParentIds.includes(parentId)) orphanParentIds.push(parentId);
      topLevel.push(channel);
      continue;
    }
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(channel);
  }

  const orderedTop = normalizeOrder(topLevel);
  const categories  = orderedTop
    .filter(isCategory)
    .map(c => ({ ...c, position: orderedTop.findIndex(x => String(x.id) === String(c.id)) }));
  const uncategorized = orderedTop
    .filter(c => !isCategory(c))
    .map(c => ({ ...c, position: orderedTop.findIndex(x => String(x.id) === String(c.id)) }));

  const groups = categories
    .map(category => ({
      parentOldId: String(category.id),
      parentName:  category.name,
      channels:    normalizeOrder(childrenByParent.get(String(category.id)) || []),
    }))
    .filter(group => group.channels.length > 0);

  if (uncategorized.length > 0) {
    // Positions conservées telles quelles : elles proviennent de l'ordre de
    // premier niveau partagé avec les catégories — les renuméroter ici
    // casserait l'alternance catégorie / salon sans catégorie.
    groups.push({ parentOldId: null, parentName: null, channels: uncategorized });
  }

  const allRoles = Array.isArray(backup?.roles) ? backup.roles : [];
  const roles = allRoles
    .filter(r => !r.managed)
    .sort((a, b) => toInt(a.position, 0) - toInt(b.position, 0) || String(a.name).localeCompare(String(b.name)));

  return {
    everyonePermissions: backup?.everyonePermissions ?? null,
    roles,
    managedRoles: allRoles.filter(r => r.managed),
    categories,
    groups,
    orphanParentIds,
    counts: {
      roles:      roles.length,
      categories: categories.length,
      channels:   allChannels.filter(c => !isCategory(c)).length,
    },
  };
}

// ── Traduction des overwrites (les IDs changent, les droits non) ─────────────
// roleIdMap         : ancien ID de rôle  → nouveau rôle (recréé)
// roleNameById      : ancien ID → nom (pour retrouver un rôle géré par nom)
// rolesByName       : nom normalisé → rôle existant dans le serveur cible
// everyoneId        : ID de @everyone dans le serveur CIBLE (== son guildId)
// everyoneOldId     : ID de @everyone dans la sauvegarde (== son guildId d'origine)
//                     Les deux diffèrent dès qu'on restaure sur un autre serveur :
//                     confondre les deux ferait perdre les droits de @everyone.
function translateOverwrites(overwrites, {
  roleIdMap = new Map(),
  roleNameById = new Map(),
  rolesByName = new Map(),
  everyoneId,
  everyoneOldId,
  guildId,
} = {}) {
  const merged = new Map();
  const dropped = [];
  const everyone = String(everyoneId || guildId || '');
  const everyoneOld = String(everyoneOldId || '');

  for (const overwrite of Array.isArray(overwrites) ? overwrites : []) {
    if (!overwrite || !overwrite.id) continue;
    const type = toInt(overwrite.type, OverwriteType.Role);
    let targetId = null;

    if (type === OverwriteType.Role) {
      const oldId = String(overwrite.id);
      if (oldId === everyone || (everyoneOld && oldId === everyoneOld) || oldId === String(guildId)) {
        targetId = everyone;
      } else {
        const mapped = roleIdMap.get(oldId);
        if (mapped) targetId = typeof mapped === 'string' ? mapped : mapped.id;
        else {
          // Rôle non recréé (rôle de bot, intégration, ou échec de création) :
          // on le retrouve par son nom dans le serveur cible.
          const name = roleNameById.get(oldId);
          if (name) targetId = rolesByName.get(normalizeName(name)) ?? null;
        }
      }
      if (!targetId) {
        dropped.push({ id: oldId, type, reason: 'rôle introuvable dans le serveur cible' });
        continue;
      }
    } else if (type === OverwriteType.Member) {
      if (!isSnowflake(String(overwrite.id))) {
        dropped.push({ id: overwrite.id, type, reason: 'identifiant de membre invalide' });
        continue;
      }
      // Un overwrite de membre reste valide même si la personne a quitté le
      // serveur : Discord l'accepte et l'appliquera si elle revient.
      targetId = String(overwrite.id);
    } else {
      continue;
    }

    let allow;
    let deny;
    try {
      allow = BigInt(overwrite.allow ?? 0);
      deny  = BigInt(overwrite.deny ?? 0);
    } catch {
      dropped.push({ id: overwrite.id, type, reason: 'bitfield illisible' });
      continue;
    }

    const key = `${type}:${targetId}`;
    const existing = merged.get(key);
    if (existing) {
      // Deux rôles d'origine fusionnent (ex. rôle géré rapatrié par nom) : on
      // additionne les droits sans jamais en perdre.
      existing.allow |= allow;
      existing.deny  |= deny;
    } else {
      merged.set(key, { id: targetId, type, allow, deny });
    }
  }

  const overwritesOut = [...merged.values()].map(o => ({
    id:    o.id,
    type:  o.type,
    allow: (o.allow & ~o.deny).toString(),
    deny:  o.deny.toString(),
  }));

  return { overwrites: overwritesOut, dropped };
}

// ── Contrôles avant restauration ────────────────────────────────────────────
// Ne bloque jamais : renvoie la liste de ce qui ne pourra pas être restauré à
// l'identique, pour que l'utilisateur le voie AVANT de lancer l'opération.
function inspectBackup(backup) {
  const warnings = [];
  const plan = buildRestorePlan(backup);
  const channels = Array.isArray(backup?.channels) ? backup.channels : [];
  const roles = Array.isArray(backup?.roles) ? backup.roles : [];
  const roleNameById = new Map(roles.map(r => [String(r.id), r.name]));
  const managedRoles = plan.managedRoles;

  if (!channels.length && !roles.length) {
    warnings.push('La sauvegarde ne contient ni rôle ni salon : rien à restaurer.');
  }

  const unknownTypes = channels.filter(c => !SUPPORTED_TYPES.has(toInt(c.type, -1)));
  if (unknownTypes.length > 0) {
    warnings.push(`${unknownTypes.length} salon(s) de type non pris en charge seront ignorés.`);
  }

  if (plan.orphanParentIds.length > 0) {
    warnings.push(
      `${plan.orphanParentIds.length} salon(s) référencent une catégorie absente de la sauvegarde : `
      + 'ils seront recréés hors catégorie.',
    );
  }

  if (managedRoles.length > 0) {
    warnings.push(
      `${managedRoles.length} rôle(s) géré(s) par une intégration (bot) ne peuvent pas être recréés : `
      + 'leurs permissions de salon seront reportées sur le rôle du même nom s\'il existe.',
    );
  }

  const referenced = new Set();
  for (const channel of channels) {
    for (const o of channel.permissionOverwrites || []) {
      if (toInt(o.type, 0) === OverwriteType.Role && String(o.id) !== String(backup?.guildId)) referenced.add(String(o.id));
    }
  }
  const restorableIds = new Set(roles.filter(r => !r.managed).map(r => String(r.id)));
  const missing = [...referenced].filter(id => !restorableIds.has(id) && !roleNameById.has(id));
  if (missing.length > 0) {
    warnings.push(`${missing.length} rôle(s) référencé(s) dans les permissions n'existent plus dans la sauvegarde.`);
  }

  const emojiCount = Array.isArray(backup?.emojis) ? backup.emojis.length : 0;
  if (emojiCount > 0) {
    warnings.push(
      `${emojiCount} emoji(s) archivé(s) : le bot ne les retéléverse pas (aucun upload d'emoji). `
      + 'Leurs images restent accessibles depuis la sauvegarde pour les remettre à la main.',
    );
  }

  return {
    plan,
    warnings,
    stats: {
      roles:      plan.roles.length,
      managed:    managedRoles.length,
      categories: plan.categories.length,
      channels:   channels.filter(c => toInt(c.type, TYPE.text) !== TYPE.category).length,
      locked:     channels.filter(c => channelLock.isEntryLocked(c, backup?.guildId)).length,
      emojis:     emojiCount,
      bans:       Array.isArray(backup?.bans) ? backup.bans.length : 0,
    },
  };
}

// ── Résumé lisible (embeds) ─────────────────────────────────────────────────
function countByType(channels) {
  const counts = new Map();
  for (const channel of Array.isArray(channels) ? channels : []) {
    const type = toInt(channel.type, TYPE.text);
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
}

function describeChannels(channels) {
  const counts = countByType(channels);
  const labels = [];
  for (const [type, count] of counts) {
    if (type === TYPE.category) labels.push(`📁 ${count} catégorie(s)`);
  }
  for (const [type, count] of counts) {
    if (type !== TYPE.category) labels.push(`💬 ${count} ${TYPE_LABEL[type] || 'salon'}(s)`);
  }
  return labels.join(' · ') || 'aucun salon';
}

module.exports = {
  BACKUP_SCHEMA_VERSION,
  TYPE,
  SUPPORTED_TYPES,
  TYPE_LABEL,
  AUTO_ARCHIVE_ALLOWED,
  AUTO_ARCHIVE_DEFAULT,
  values,
  bitfieldToString,
  isSnowflake,
  serializeOverwrites,
  serializeRole,
  serializeChannel,
  serializeEmoji,
  snapshotGuild,
  buildRestorePlan,
  normalizeOrder,
  translateOverwrites,
  inspectBackup,
  describeChannels,
  countByType,
  channelName,
};
