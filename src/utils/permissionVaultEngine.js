'use strict';
// utils/permissionVaultEngine.js — Moteur pur du coffre-fort de permissions.
//
// Problème couvert : l'anti-nuke voit les destructions massives, pas les
// ouvertures silencieuses. Donner à @everyone la permission de voir un salon
// staff, retirer un deny de quarantaine ou ajouter `Gérer les rôles` à un rôle
// subalterne n'efface rien : ça laisse juste une porte ouverte. C'est l'attaque
// la plus discrète, et celle que ce module referme.
//
// Aucune dépendance Discord ni MongoDB ici : tout est testable hors-ligne
// (voir tests/permission-vault-smoke.js). L'orchestration vit dans
// src/utils/permissionVault.js, le panneau dans permissionVaultPanel.js.

const MAX_INCIDENTS = 25;
const MAX_CHANNELS = 25;
const MAX_ROLES = 15;

// ── Permissions Discord (bits) ───────────────────────────────────────────────
// Redéclarés ici pour que le moteur reste pur (aucun require de discord.js).
const PERMISSIONS = {
  CreateInstantInvite: 1n << 0n,
  KickMembers:         1n << 1n,
  BanMembers:          1n << 2n,
  Administrator:       1n << 3n,
  ManageChannels:      1n << 4n,
  ManageGuild:         1n << 5n,
  AddReactions:        1n << 6n,
  ViewAuditLog:        1n << 7n,
  PrioritySpeaker:     1n << 8n,
  Stream:              1n << 9n,
  ViewChannel:         1n << 10n,
  SendMessages:        1n << 11n,
  SendTTSMessages:     1n << 12n,
  ManageMessages:      1n << 13n,
  EmbedLinks:          1n << 14n,
  AttachFiles:         1n << 15n,
  ReadMessageHistory:  1n << 16n,
  MentionEveryone:     1n << 17n,
  UseExternalEmojis:   1n << 18n,
  Connect:             1n << 20n,
  Speak:               1n << 21n,
  MuteMembers:         1n << 22n,
  DeafenMembers:       1n << 23n,
  MoveMembers:         1n << 24n,
  ManageNicknames:     1n << 27n,
  ManageRoles:         1n << 28n,
  ManageWebhooks:      1n << 29n,
  ManageThreads:       1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads:1n << 36n,
  ModerateMembers:     1n << 40n,
};

// Libellés courts pour les alertes et le panneau.
const PERMISSION_LABELS = {
  Administrator:       'Administrateur',
  ManageGuild:         'Gérer le serveur',
  ManageRoles:         'Gérer les rôles',
  ManageChannels:      'Gérer les salons',
  ManageWebhooks:      'Gérer les webhooks',
  ManageMessages:      'Gérer les messages',
  ManageThreads:       'Gérer les fils',
  ManageNicknames:     'Gérer les pseudos',
  BanMembers:          'Bannir des membres',
  KickMembers:         'Expulser des membres',
  ModerateMembers:     'Exclure temporairement',
  MentionEveryone:     '@everyone / @here',
  ViewChannel:         'Voir le salon',
  SendMessages:        'Envoyer des messages',
  ReadMessageHistory:  'Lire l\'historique',
  AttachFiles:         'Joindre des fichiers',
  EmbedLinks:          'Intégrer des liens',
  CreateInstantInvite: 'Créer des invitations',
  ViewAuditLog:        'Voir le journal d\'audit',
  Connect:             'Se connecter en vocal',
  Speak:               'Parler en vocal',
  MoveMembers:         'Déplacer des membres',
  CreatePublicThreads: 'Créer des fils publics',
  CreatePrivateThreads:'Créer des fils privés',
  MuteMembers:         'Rendre muet',
  DeafenMembers:       'Rendre sourd',
};

// Permissions dont l'obtention suffit à considérer qu'un rôle est compromis.
const DANGEROUS_MASK =
  PERMISSIONS.Administrator |
  PERMISSIONS.ManageGuild |
  PERMISSIONS.ManageRoles |
  PERMISSIONS.ManageChannels |
  PERMISSIONS.ManageWebhooks |
  PERMISSIONS.BanMembers |
  PERMISSIONS.KickMembers |
  PERMISSIONS.ModerateMembers |
  PERMISSIONS.MentionEveryone;

const OVERWRITE_TYPE = { role: 0, member: 1 };

// ── Bits ─────────────────────────────────────────────────────────────────────
/**
 * Normalise une valeur de permissions en BigInt.
 * Accepte BigInt, number, chaîne décimale et PermissionsBitField (`.bitfield`).
 */
function toBits(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  if (typeof value === 'string') {
    try { return BigInt(value || '0'); } catch { return 0n; }
  }
  if (typeof value.bitfield !== 'undefined') return toBits(value.bitfield);
  if (typeof value.valueOf === 'function') {
    const v = value.valueOf();
    if (typeof v === 'bigint') return v;
  }
  return 0n;
}

/** Noms des permissions contenues dans un masque (ordre stable). */
function permissionNames(bits) {
  const mask = toBits(bits);
  if (!mask) return [];
  return Object.keys(PERMISSIONS)
    .filter(name => (mask & PERMISSIONS[name]) !== 0n)
    .map(name => PERMISSION_LABELS[name] || name);
}

/** Nombre de permissions distinctes dans un masque (pour les résumés). */
function permissionCount(bits) {
  const mask = toBits(bits);
  return Object.keys(PERMISSIONS).filter(name => (mask & PERMISSIONS[name]) !== 0n).length;
}

function normalizeType(type) {
  if (type === 'role') return OVERWRITE_TYPE.role;
  if (type === 'member') return OVERWRITE_TYPE.member;
  const n = Number(type);
  return n === OVERWRITE_TYPE.member ? OVERWRITE_TYPE.member : OVERWRITE_TYPE.role;
}

// ── Instantanés d'overwrites ─────────────────────────────────────────────────
/** Un overwrite normalisé : `{ id, type, allow, deny }` (allow/deny en BigInt). */
function normalizeOverwrite(o) {
  return {
    id: String(o.id),
    type: normalizeType(o.type),
    allow: toBits(o.allow),
    deny: toBits(o.deny),
  };
}

/**
 * Instantané trié et sérialisable d'une liste d'overwrites.
 * Accepte un tableau ou une Collection discord.js.
 * @returns {Array<{id:string, type:number, allow:string, deny:string}>}
 */
function snapshotOverwrites(overwrites = []) {
  const list = Array.isArray(overwrites)
    ? overwrites
    : (overwrites && typeof overwrites.values === 'function' ? [...overwrites.values()] : []);
  return list
    .filter(o => o && o.id)
    .map(normalizeOverwrite)
    .map(o => ({ id: o.id, type: o.type, allow: o.allow.toString(), deny: o.deny.toString() }))
    .sort((a, b) => a.type - b.type || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function indexOverwrites(overwrites = []) {
  const map = new Map();
  for (const o of (overwrites || [])) {
    const n = normalizeOverwrite(o);
    map.set(`${n.type}:${n.id}`, n);
  }
  return map;
}

/**
 * Compare deux instantanés d'overwrites.
 * « Élargissement » = une permission devient accordée là où elle ne l'était pas,
 * ou un refus (deny) disparaît. Retirer une autorisation est un rétrécissement
 * et n'est jamais annulé par le coffre.
 * @returns {{ changes:Array, broadening:Array, isBroadening:boolean, gained:bigint }}
 */
function diffOverwrites(baseline = [], current = []) {
  const base = indexOverwrites(baseline);
  const cur = indexOverwrites(current);
  const keys = new Set([...base.keys(), ...cur.keys()]);
  const changes = [];

  for (const key of keys) {
    const b = base.get(key) || { id: key.split(':')[1], type: Number(key.split(':')[0]), allow: 0n, deny: 0n };
    const c = cur.get(key) || { id: b.id, type: b.type, allow: 0n, deny: 0n };
    const allowAdded  = c.allow & ~b.allow;
    const denyRemoved = b.deny & ~c.deny;
    const allowRemoved = b.allow & ~c.allow;
    const denyAdded    = c.deny & ~b.deny;
    if (allowAdded || denyRemoved || allowRemoved || denyAdded) {
      changes.push({
        id: c.id,
        type: c.type,
        allowAdded,
        denyRemoved,
        allowRemoved,
        denyAdded,
        isBroadening: allowAdded !== 0n || denyRemoved !== 0n,
      });
    }
  }

  const broadening = changes.filter(c => c.isBroadening);
  let gained = 0n;
  for (const c of broadening) gained |= (c.allowAdded | c.denyRemoved);

  return { changes, broadening, isBroadening: broadening.length > 0, gained };
}

/**
 * Liste d'overwrites à réappliquer pour refermer un élargissement.
 * - cible élargie avec baseline : on remet exactement le couple allow/deny d'origine ;
 * - cible nouvelle sans baseline : on supprime l'autorisation, on garde un éventuel deny ;
 * - cible supprimée dont la baseline contenait un deny : on remet le deny seul ;
 * - tout rétrécissement légitime est conservé tel quel.
 */
function restoreOverwrites(baseline = [], current = []) {
  const base = indexOverwrites(baseline);
  const cur = indexOverwrites(current);
  const diff = diffOverwrites(baseline, current);
  const broadenKeys = new Set(diff.broadening.map(c => `${c.type}:${c.id}`));
  const out = [];

  for (const [key, c] of cur) {
    if (!broadenKeys.has(key)) {
      out.push({ id: c.id, type: c.type, allow: c.allow.toString(), deny: c.deny.toString() });
      continue;
    }
    const b = base.get(key);
    if (b) {
      out.push({ id: b.id, type: b.type, allow: b.allow.toString(), deny: b.deny.toString() });
    } else if (c.deny !== 0n) {
      out.push({ id: c.id, type: c.type, allow: '0', deny: c.deny.toString() });
    }
  }

  // Overwrite de baseline entièrement supprimé : ne restaure que les refus,
  // jamais les autorisations (leur perte est un rétrécissement accepté).
  for (const [key, b] of base) {
    if (cur.has(key)) continue;
    if (b.deny !== 0n) {
      out.push({ id: b.id, type: b.type, allow: '0', deny: b.deny.toString() });
    }
  }

  return out;
}

// ── Permissions de rôle ──────────────────────────────────────────────────────
/**
 * Compare les permissions d'un rôle protégé.
 * Toute permission gagnée élargit le rôle et sera refermée.
 * @returns {{ gained:bigint, lost:bigint, dangerousGained:bigint, isBroadening:boolean, names:string[] }}
 */
function diffRolePermissions(baseline = 0n, current = 0n) {
  const b = toBits(baseline);
  const c = toBits(current);
  const gained = c & ~b;
  const lost = b & ~c;
  const dangerousGained = gained & DANGEROUS_MASK;
  return {
    gained,
    lost,
    dangerousGained,
    isBroadening: gained !== 0n,
    names: permissionNames(gained),
    dangerousNames: permissionNames(dangerousGained),
  };
}

// ── Confiance ────────────────────────────────────────────────────────────────
/**
 * L'auteur d'une modification est-il autorisé à élargir un accès ?
 * Propriétaire, bot lui-même et rôles de confiance uniquement.
 * @param {{trustedRoles?:string[]}} cfg
 * @param {{executorId?:string|null, guildOwnerId?:string|null, clientId?:string|null, roleIds?:string[]}} subject
 */
function actorVerdict(cfg = {}, subject = {}) {
  const { executorId, guildOwnerId = null, clientId = null } = subject;
  const roleIds = Array.isArray(subject.roleIds) ? subject.roleIds : [];
  if (!executorId) return { trusted: false, reason: null };
  if (clientId && executorId === clientId) return { trusted: true, reason: 'le bot lui-même' };
  if (guildOwnerId && executorId === guildOwnerId) return { trusted: true, reason: 'propriétaire du serveur' };
  const matched = roleIds.find(id => (cfg?.trustedRoles || []).includes(id));
  if (matched) return { trusted: true, reason: `rôle de confiance <@&${matched}>` };
  return { trusted: false, reason: null };
}

/** @everyone ne peut jamais être un rôle de confiance (il ouvrirait tout). */
function isEveryoneRole(guildId, roleId) {
  return Boolean(guildId && roleId && String(guildId) === String(roleId));
}

// ── Incidents ────────────────────────────────────────────────────────────────
function buildIncident({
  kind = 'channel',
  targetId = null,
  targetName = null,
  executorId = null,
  permissions = [],
  mode = 'alert',
  action = 'alerted',
  source = 'audit',
  detail = null,
  at = new Date(),
} = {}) {
  return { at, kind, targetId, targetName, executorId, permissions, mode, action, source, detail };
}

function capIncidents(incidents = [], limit = MAX_INCIDENTS) {
  const list = Array.isArray(incidents) ? [...incidents] : [];
  return list.length > limit ? list.slice(list.length - limit) : list;
}

function formatIncident(incident = {}) {
  const icon = incident.action === 'reverted' ? '🔒' : incident.action === 'trusted' ? '✅' : '⚠️';
  const label = incident.kind === 'role' ? 'rôle' : 'salon';
  const target = incident.targetName ? `**${incident.targetName}**` : `\`${incident.targetId || '?'}\``;
  const author = incident.executorId ? `<@${incident.executorId}>` : 'auteur inconnu';
  const perms = (incident.permissions || []).slice(0, 4).join(', ') || 'accès élargi';
  const action = incident.action === 'reverted'
    ? 'refermé'
    : incident.action === 'trusted' ? 'autorisé (liste de confiance)' : 'signalé';
  return `${icon} ${label} ${target} — ${perms} par ${author} · ${action}`;
}

// ── Diagnostic du panneau ────────────────────────────────────────────────────
/**
 * Audite la configuration du coffre.
 * @returns {{ problems:string[], warnings:string[], channels:number, roles:number }}
 */
function vaultAudit(cfg = {}, { canManageChannels = true, canManageRoles = true, guildId = null } = {}) {
  const problems = [];
  const warnings = [];
  const channels = Array.isArray(cfg.protectedChannels) ? cfg.protectedChannels.length : 0;
  const roles = Array.isArray(cfg.protectedRoles) ? cfg.protectedRoles.length : 0;

  if (channels === 0 && roles === 0) problems.push('Aucune cible protégée : le coffre ne surveille rien.');
  const everyoneTrusted = (cfg.trustedRoles || []).find(id => isEveryoneRole(guildId, id));
  if (everyoneTrusted) problems.push('@everyone est dans les rôles de confiance : le coffre accepterait toutes les modifications.');

  if (!cfg.enabled) {
    warnings.push('Module désactivé : aucune surveillance active.');
  } else {
    if (!cfg.logChannelId) warnings.push('Aucun salon de logs : les incidents ne seront signalés qu\'en console.');
    if (cfg.mode !== 'revert') warnings.push('Mode « alerte » : les accès élargis sont détectés mais laissés ouverts.');
  }
  if (!canManageChannels) warnings.push('Permission « Gérer les salons » manquante : impossible de refermer un salon.');
  if (!canManageRoles) warnings.push('Permission « Gérer les rôles » manquante : impossible de restaurer un rôle.');
  if ((cfg.trustedRoles || []).length) {
    warnings.push(`${cfg.trustedRoles.length} rôle(s) de confiance : leurs élargissements sont acceptés et deviennent la nouvelle référence.`);
  }

  return { problems, warnings, channels, roles };
}

function describeMode(mode) {
  return mode === 'revert' ? '🔒 Refermer automatiquement' : '⚠️ Alerter seulement';
}

module.exports = {
  MAX_INCIDENTS,
  MAX_CHANNELS,
  MAX_ROLES,
  PERMISSIONS,
  PERMISSION_LABELS,
  DANGEROUS_MASK,
  OVERWRITE_TYPE,
  toBits,
  permissionNames,
  permissionCount,
  normalizeType,
  normalizeOverwrite,
  snapshotOverwrites,
  indexOverwrites,
  diffOverwrites,
  restoreOverwrites,
  diffRolePermissions,
  actorVerdict,
  isEveryoneRole,
  buildIncident,
  capIncidents,
  formatIncident,
  vaultAudit,
  describeMode,
};
