'use strict';
// utils/antiVpnLock.js — Verrouillage TOTAL des salons pendant la vérification.
//
// Objectif : un membre qui n'a pas encore vérifié sa connexion ne voit AUCUN
// salon, sans jamais toucher aux permissions existantes du serveur.
//
// Comment c'est possible sans rien casser :
//   • le bot crée un rôle dédié « 🔒 Non vérifié », sans aucune permission ;
//   • il ajoute UNE entrée d'overwrite pour ce seul rôle sur chaque salon
//     (refus de « Voir les salons »). Les entrées @everyone, rôles et membres
//     déjà présentes ne sont ni modifiées ni supprimées ;
//   • à l'arrivée, le membre reçoit ce rôle et ses autres rôles sont retirés
//     (liste sauvegardée dans la session) : plus aucun rôle ne peut « autoriser »
//     la vue, donc le refus s'applique partout ;
//   • après validation, ses rôles d'origine sont restaurés à l'identique.
//
// Discord calcule les permissions en retirant d'abord les refus de tous les
// rôles, puis en ajoutant les autorisations : c'est pour cela que retirer les
// autres rôles est nécessaire, et qu'un simple rôle « sans permissions » ne
// suffit pas (le @everyone laisse voir les salons publics).
//
// Rien n'est décidé ici sur le verdict : utils/antiVpnFlow.js appelle
// lockMember / releaseMember, et le panneau gère l'infrastructure du serveur.

const { PermissionFlagsBits } = require('discord.js');

const LOCK_ROLE_NAME = '🔒 Non vérifié';
const LOCK_COLOR = 0x95a5a6;
const LOCK_REASON = 'Anti-VPN : accès verrouillé jusqu’à vérification';
const RELEASE_REASON = 'Anti-VPN : vérification terminée';

// Une synchronisation des salons coûte un appel par salon : on ne la refait pas
// à chaque arrivée. Elle est rejouée au démarrage, à l'activation, et au plus
// une fois toutes les dix minutes en secours.
const SYNC_TTL_MS = 10 * 60_000;
const lastSync = new Map();

/** Le verrouillage est-il actif pour ce serveur ? (activé par défaut) */
function isLockEnabled(cfg) {
  return cfg?.verification?.lockAll !== false;
}

function permissionDenied(overwrite) {
  try {
    return Boolean(overwrite?.deny?.has?.(PermissionFlagsBits.ViewChannel));
  } catch {
    return false;
  }
}

/**
 * Récupère (ou crée) le rôle de verrouillage du serveur.
 * @returns {Promise<{role:object|null, created:boolean}>}
 */
async function ensureLockRole(guild, cfg, { logger = console } = {}) {
  if (!guild?.roles?.cache) return { role: null, created: false };

  const storedId = cfg?.verification?.lockRoleId;
  if (storedId) {
    const stored = guild.roles.cache.get(storedId)
      || await guild.roles.fetch?.(storedId).catch(() => null);
    if (stored) return { role: stored, created: false };
  }

  const name = String(cfg?.verification?.lockRoleName || LOCK_ROLE_NAME);
  let role = guild.roles.cache.find?.(r => r.name === name && !r.managed) || null;
  let created = false;

  if (!role) {
    if (typeof guild.roles.create !== 'function') return { role: null, created: false };
    try {
      role = await guild.roles.create({
        name,
        color: LOCK_COLOR,
        hoist: false,
        mentionable: false,
        permissions: [], // aucun pouvoir : c'est un rôle « mur »
        reason: LOCK_REASON,
      });
      created = true;
    } catch (err) {
      logger.error?.(`[anti-vpn] rôle de verrouillage impossible : ${err.message}`);
      return { role: null, created: false };
    }
  }

  if (cfg?.verification) {
    cfg.verification.lockRoleId = role.id;
    try { await cfg.save?.(); } catch { /* document non persistant (tests) */ }
  }
  return { role, created };
}

/**
 * Pose (ou vérifie) le refus « Voir les salons » pour le rôle de verrouillage.
 * Ne touche à aucune autre entrée d'overwrite.
 * @returns {Promise<boolean>} true si un appel a été nécessaire
 */
async function applyChannelLock(channel, roleId, { logger = console } = {}) {
  if (!roleId || !channel) return false;
  if (typeof channel.isThread === 'function' && channel.isThread()) return false;
  const overwrites = channel.permissionOverwrites;
  if (!overwrites?.edit) return false;

  const existing = overwrites.cache?.get?.(roleId);
  if (permissionDenied(existing)) return false;

  try {
    await overwrites.edit(roleId, { ViewChannel: false }, { reason: LOCK_REASON });
    return true;
  } catch (err) {
    logger.warn?.(`[anti-vpn] salon ${channel.id || '?'} non verrouillé : ${err.message}`);
    return false;
  }
}

/**
 * Applique le refus sur tous les salons du serveur (catégories comprises).
 * Idempotent : un salon déjà verrouillé ne provoque aucun appel réseau.
 */
async function ensureChannelLocks(guild, roleId, { logger = console, concurrency = 4 } = {}) {
  if (!guild?.channels?.cache || !roleId) return { total: 0, changed: 0, failed: 0 };

  const channels = [...guild.channels.cache.values()].filter(ch => {
    if (typeof ch.isThread === 'function' && ch.isThread()) return false;
    return Boolean(ch.permissionOverwrites?.edit);
  });

  let changed = 0;
  let failed = 0;
  const queue = channels.slice();

  const worker = async () => {
    while (queue.length) {
      const channel = queue.shift();
      const before = permissionDenied(channel.permissionOverwrites?.cache?.get?.(roleId));
      const touched = await applyChannelLock(channel, roleId, { logger });
      if (touched) changed++;
      else if (!before && !permissionDenied(channel.permissionOverwrites?.cache?.get?.(roleId))) failed++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return { total: channels.length, changed, failed };
}

/** Synchronisation limitée dans le temps, pour ne pas la refaire à chaque arrivée. */
async function syncChannels(guild, roleId, { force = false, logger = console } = {}) {
  if (!guild?.id || !roleId) return { total: 0, changed: 0, failed: 0 };
  const last = lastSync.get(guild.id) || 0;
  if (!force && Date.now() - last < SYNC_TTL_MS) return { total: 0, changed: 0, failed: 0, skipped: true };
  const result = await ensureChannelLocks(guild, roleId, { logger });
  lastSync.set(guild.id, Date.now());
  return result;
}

/**
 * Verrouille un membre : rôle de verrouillage seul, rôles d'origine sauvegardés.
 * @returns {Promise<{locked:boolean, reason?:string, roleId?:string, removed?:string[], restoredLater?:boolean}>}
 */
async function lockMember(member, cfg, session = null, { logger = console } = {}) {
  if (!isLockEnabled(cfg)) return { locked: false, reason: 'disabled' };
  if (!member?.guild) return { locked: false, reason: 'no_guild' };

  const { role, created } = await ensureLockRole(member.guild, cfg, { logger });
  if (!role) return { locked: false, reason: 'no_role' };

  // Les rôles gérés (bot, boost, intégrations) ne peuvent pas être retirés :
  // on les laisse en place et on les ignore de la sauvegarde.
  const cache = member.roles?.cache;
  const current = [];
  if (cache && typeof cache.values === 'function') {
    for (const r of cache.values()) {
      if (!r?.id || r.id === member.guild.id || r.id === role.id || r.managed) continue;
      current.push(r.id);
    }
  }

  if (created) await ensureChannelLocks(member.guild, role.id, { logger });
  else await syncChannels(member.guild, role.id, { logger });

  // On enregistre AVANT de modifier les rôles : si le bot s'arrête entre les
  // deux, la session permettra de rendre ses rôles au membre.
  if (session) {
    session.lockedRoles = current;
    session.lockApplied = true;
    session.lockedAt = new Date();
    try { await session.save?.(); } catch { /* non persistant (tests) */ }
  }

  let unrestored = [];
  try {
    if (current.length) {
      try {
        await member.roles.remove(current, LOCK_REASON);
      } catch {
        // Un rôle au-dessus du bot bloque l'opération groupée : on réessaie
        // un par un et on note ceux qui restent.
        for (const id of current) {
          try { await member.roles.remove(id, LOCK_REASON); } catch { unrestored.push(id); }
        }
      }
    }
    await member.roles.add(role.id, LOCK_REASON);
  } catch (err) {
    logger.error?.(`[anti-vpn] verrouillage de ${member.id} impossible : ${err.message}`);
    if (session) {
      session.lockApplied = false;
      session.lockedRoles = [];
      try { await session.save?.(); } catch { /* non persistant */ }
    }
    return { locked: false, reason: 'permissions', roleId: role.id };
  }

  if (unrestored.length && unrestored.length === current.length) {
    // Aucun rôle n'a pu être retiré (hiérarchie) : le rôle « mur » ne suffirait
    // pas, un rôle restant pourrait autoriser la vue. On annule proprement.
    try { await member.roles.remove(role.id, RELEASE_REASON); } catch { /* rien */ }
    if (session) {
      session.lockApplied = false;
      session.lockedRoles = [];
      try { await session.save?.(); } catch { /* non persistant */ }
    }
    logger.error?.(`[anti-vpn] ${member.id} : rôles trop hauts pour le bot, verrouillage annulé (place le rôle du bot plus haut)`);
    return { locked: false, reason: 'hierarchy', roleId: role.id };
  }

  if (unrestored.length) {
    logger.warn?.(`[anti-vpn] ${member.id} garde ${unrestored.length} rôle(s) trop haut pour le bot — son accès peut rester partiel`);
  }

  return { locked: true, roleId: role.id, removed: current.length - unrestored.length, unrestored, restoredLater: true };
}

/**
 * Retire le verrouillage et rend au membre ses rôles d'origine.
 * Sans session, seul le rôle de verrouillage est retiré (les autres rôles
 * avaient déjà été retirés à l'arrivée et ne peuvent pas être devinés).
 */
async function releaseMember(member, cfg, session = null, { logger = console } = {}) {
  const roleId = cfg?.verification?.lockRoleId || session?.lockRoleId || null;
  if (!member) return { released: false, restored: 0 };

  const restore = (session?.lockedRoles || []).filter(id => id && id !== roleId);
  if (roleId && member.roles?.cache?.has?.(roleId)) {
    try { await member.roles.remove(roleId, RELEASE_REASON); } catch (err) {
      logger.warn?.(`[anti-vpn] retrait du rôle de verrouillage impossible : ${err.message}`);
    }
  }

  let restored = 0;
  if (restore.length) {
    const guild = member.guild;
    const valid = restore.filter(id => !guild?.roles?.cache || guild.roles.cache.has(id));
    if (valid.length) {
      try {
        await member.roles.add(valid, RELEASE_REASON);
        restored = valid.length;
      } catch {
        for (const id of valid) {
          try { await member.roles.add(id, RELEASE_REASON); restored++; } catch { /* rôle supprimé */ }
        }
      }
    }
  }

  if (session) {
    session.lockApplied = false;
    try { await session.save?.(); } catch { /* non persistant (tests) */ }
  }

  return { released: true, restored };
}

/**
 * Retire complètement le verrouillage d'un serveur : libère les membres qui
 * portent le rôle, puis supprime le rôle (Discord efface avec lui ses entrées
 * d'overwrite). Aucune autre permission n'est modifiée.
 */
async function teardownGuild(guild, cfg, { logger = console } = {}) {
  const roleId = cfg?.verification?.lockRoleId;
  if (!guild || !roleId) return { released: 0, deleted: false };

  let sessions = [];
  try {
    const VPNVerification = require('../models/VPNVerification');
    sessions = await VPNVerification.find({ guildId: guild.id, lockApplied: true }) || [];
  } catch { /* base indisponible : on libère quand même le rôle */ }
  const byUser = new Map((sessions || []).map(s => [s.userId, s]));

  const members = new Map();
  for (const member of guild.members?.cache?.values?.() || []) members.set(member.id, member);
  const role = guild.roles?.cache?.get?.(roleId) || null;
  for (const member of role?.members?.values?.() || []) members.set(member.id, member);

  let released = 0;
  for (const member of members.values()) {
    if (!member?.roles?.cache?.has?.(roleId)) continue;
    await releaseMember(member, cfg, byUser.get(member.id) || null, { logger });
    released++;
  }

  let deleted = false;
  if (role) {
    try {
      await guild.roles.delete(roleId, 'Anti-VPN : verrouillage retiré');
      deleted = true;
    } catch (err) {
      logger.error?.(`[anti-vpn] suppression du rôle de verrouillage impossible : ${err.message}`);
    }
  } else if (guild.roles?.cache && typeof guild.roles.delete === 'function') {
    try { await guild.roles.delete(roleId, 'Anti-VPN : verrouillage retiré'); deleted = true; } catch { /* déjà absent */ }
  }

  if (cfg?.verification) {
    cfg.verification.lockRoleId = null;
    try { await cfg.save?.(); } catch { /* non persistant (tests) */ }
  }
  lastSync.delete(guild.id);

  return { released, deleted };
}

/** Prépare (ou répare) le verrouillage d'un serveur : rôle + tous les salons. */
async function syncGuild(guild, cfg, { logger = console } = {}) {
  if (!isLockEnabled(cfg)) return { role: null, created: false, channels: { total: 0, changed: 0, failed: 0 } };
  const { role, created } = await ensureLockRole(guild, cfg, { logger });
  if (!role) return { role: null, created: false, channels: { total: 0, changed: 0, failed: 0 } };
  const channels = await syncChannels(guild, role.id, { force: true, logger });
  return { role, created, channels };
}

module.exports = {
  LOCK_ROLE_NAME,
  LOCK_REASON,
  RELEASE_REASON,
  isLockEnabled,
  ensureLockRole,
  applyChannelLock,
  ensureChannelLocks,
  syncChannels,
  lockMember,
  releaseMember,
  teardownGuild,
  syncGuild,
};
