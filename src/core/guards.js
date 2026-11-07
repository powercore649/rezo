'use strict';
// core/guards.js — Garde-fous réutilisables pour les commandes v2.
//
// Un « guard » est un petit objet { name, check(ctx) } où ctx = { interaction,
// client, command, meta }. check() renvoie { ok:true } ou { ok:false, message,
// code }. runGuards() exécute les guards dans l'ordre et s'arrête au premier
// échec. Cela centralise permissions, réservation owner, licence et cooldowns
// au lieu de les répéter dans chaque commande.

const { PermissionFlagsBits } = require('discord.js');

const PERM_NAMES = Object.fromEntries(
  Object.entries(PermissionFlagsBits).map(([name, bit]) => [String(bit), name]),
);
function permName(bit) { return PERM_NAMES[String(bit)] || `permission#${bit}`; }

function ok() { return { ok: true }; }
function fail(message, code = 'GUARD') { return { ok: false, message, code }; }

// ── Guildes ─────────────────────────────────────────────────────────────────
function guildOnly() {
  return {
    name: 'guildOnly',
    check: ({ interaction }) =>
      (interaction?.guildId || interaction?.inGuild?.()) ? ok() : fail('Cette commande s\'utilise uniquement sur un serveur.', 'GUILD_ONLY'),
  };
}

// ── Permissions ─────────────────────────────────────────────────────────────
function normalizePerms(perms) {
  if (Array.isArray(perms)) return perms;
  if (typeof perms === 'bigint' || typeof perms === 'number') return [perms];
  return [];
}

function requireUserPermissions(perms) {
  const list = normalizePerms(perms);
  return {
    name: 'userPermissions',
    check: ({ interaction }) => {
      const permsOf = interaction?.memberPermissions ?? interaction?.member?.permissions;
      if (!permsOf?.has) return fail('Impossible de vérifier tes permissions.', 'NO_PERMS');
      const missing = list.filter(p => !permsOf.has(p));
      return missing.length ? fail(`Il te manque : ${missing.map(permName).join(', ')}.`, 'USER_PERMS') : ok();
    },
  };
}

function requireBotPermissions(perms) {
  const list = normalizePerms(perms);
  return {
    name: 'botPermissions',
    check: ({ interaction }) => {
      const permsOf = interaction?.appPermissions
        ?? interaction?.guild?.members?.me?.permissions
        ?? interaction?.channel?.permissionsFor?.(interaction.client?.user);
      if (!permsOf?.has) return ok(); // non vérifiable → on laisse la commande décider
      const missing = list.filter(p => !permsOf.has(p));
      return missing.length ? fail(`Il me manque : ${missing.map(permName).join(', ')}.`, 'BOT_PERMS') : ok();
    },
  };
}

// ── Réservé aux owners du bot ───────────────────────────────────────────────
function parseOwnerIds(raw = process.env.OWNER_IDS) {
  return String(raw || '').split(/[\s,]+/).filter(Boolean);
}
function ownerOnly(ids = parseOwnerIds()) {
  return {
    name: 'ownerOnly',
    check: ({ interaction }) =>
      ids.includes(interaction?.user?.id) ? ok() : fail('Commande réservée aux owners du bot.', 'OWNER_ONLY'),
  };
}

// ── Cooldown (par utilisateur ou par serveur) ───────────────────────────────
// Chaque appel à cooldown() crée son propre registre isolé.
function cooldown(ms, { scope = 'user' } = {}) {
  const buckets = new Map();
  const guard = {
    name: 'cooldown',
    check: ({ interaction, command }) => {
      const id = scope === 'guild' ? interaction?.guildId : interaction?.user?.id;
      const key = `${command}:${scope}:${id}`;
      const now = Date.now();
      const until = buckets.get(key) ?? 0;
      if (now < until) {
        const secs = Math.ceil((until - now) / 1000);
        return fail(`Doucement ! Réessaie dans ${secs} s.`, 'COOLDOWN');
      }
      buckets.set(key, now + ms);
      return ok();
    },
  };
  guard.reset = () => buckets.clear();
  return guard;
}

// ── Licence (délégué à utils/licenseGate) ───────────────────────────────────
function licenseRequired({ feature = null } = {}) {
  return {
    name: 'license',
    check: async ({ interaction, command }) => {
      const guildId = interaction?.guildId;
      if (!guildId) return ok();
      const { checkAccess, isLicenseRequired } = require('../utils/licenseGate');
      const name = feature || command;
      if (!isLicenseRequired(name)) return ok();
      const access = await checkAccess(guildId, name);
      return access.ok
        ? ok()
        : fail('🔒 Licence requise pour cette commande. Active-la avec `/license activer`.', 'LICENSE');
    },
  };
}

// ── Exécution ───────────────────────────────────────────────────────────────
async function runGuards(guards, ctx) {
  for (const guard of guards) {
    // eslint-disable-next-line no-await-in-loop
    const res = await guard.check(ctx);
    if (res && res.ok === false) return { ...res, guard: guard.name };
  }
  return ok();
}

// Construit les guards standards à partir des métadonnées d'une commande v2.
function guardsFromMeta(meta = {}, data = {}) {
  const guards = [];
  if (meta.guildOnly) guards.push(guildOnly());
  if (meta.ownerOnly) guards.push(ownerOnly());

  if (meta.permissions) guards.push(requireUserPermissions(meta.permissions));
  if (meta.botPermissions) guards.push(requireBotPermissions(meta.botPermissions));

  if (meta.license) {
    guards.push(licenseRequired({ feature: typeof meta.license === 'string' ? meta.license : data.name }));
  }
  if (meta.cooldown) {
    const ms = typeof meta.cooldown === 'number' ? meta.cooldown : 3000;
    guards.push(cooldown(ms, { scope: meta.cooldownScope || 'user' }));
  }
  return guards;
}

module.exports = {
  ok,
  fail,
  runGuards,
  guardsFromMeta,
  guildOnly,
  requireUserPermissions,
  requireBotPermissions,
  ownerOnly,
  parseOwnerIds,
  cooldown,
  licenseRequired,
  permName,
};
