'use strict';
// utils/aiModeration.js — Actions de modération demandées par l'IA.
//
// L'IA ne sanctionne JAMAIS toute seule : elle propose une action dans sa
// réponse ([[action: {...}]]), et ce module ne l'exécute que si
//   • le serveur a activé les outils de modération (cfg.moderationTools),
//   • la personne qui parle possède la permission Discord correspondante,
//   • la cible n'est ni elle-même, ni un bot, ni plus haut dans la hiérarchie.
//
// Chaque action est journalisée par la raison transmise à Discord.

const { PermissionFlagsBits } = require('discord.js');
const { outranked } = require('./modTools');

const ACTIONS = {
  timeout:  { permission: 'ModerateMembers', label: '⏱️ Temps calme' },
  kick:     { permission: 'KickMembers',     label: '👢 Expulsion' },
  ban:      { permission: 'BanMembers',      label: '🔨 Bannissement' },
  unban:    { permission: 'BanMembers',      label: '♻️ Débannissement' },
};

const MAX_TIMEOUT_MINUTES = 28 * 24;

function canUse(member, type) {
  const rule = ACTIONS[type];
  if (!rule || !member?.permissions) return false;
  return member.permissions.has(PermissionFlagsBits[rule.permission]);
}

function reasonOf(action, actor) {
  const reason = String(action.reason || '').slice(0, 200).trim();
  return `REZO IA${actor ? ` — demandé par ${actor.user?.tag || actor.user?.username || actor.id}` : ''}${reason ? ` : ${reason}` : ''}`.slice(0, 500);
}

async function resolveTarget(guild, id) {
  const userId = String(id || '').replace(/[<@!>]/g, '');
  if (!/^\d{17,20}$/.test(userId)) return null;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) return { member, user: member.user };
  const user = await guild.client.users.fetch(userId).catch(() => null);
  return user ? { member: null, user } : null;
}

/**
 * Exécute au plus deux actions. Renvoie un résumé lisible, ou null si rien
 * n'a été fait (permission manquante, cible invalide, hiérarchie).
 */
async function applyActions(actions, { guild, member } = {}) {
  if (!guild || !member || !Array.isArray(actions) || !actions.length) return null;

  const done = [];
  for (const action of actions.slice(0, 2)) {
    const type = String(action?.type || '').toLowerCase();
    if (!ACTIONS[type] || !canUse(member, type)) continue;

    const target = await resolveTarget(guild, action.user);
    if (!target) continue;
    if (target.user?.id === member.id || target.user?.bot) continue;
    if (target.member && outranked(member, target.member)) continue;

    const reason = reasonOf(action, member);
    try {
      if (type === 'timeout') {
        if (!target.member) continue;
        const minutes = Math.min(MAX_TIMEOUT_MINUTES, Math.max(1, Number(action.minutes) || 10));
        await target.member.timeout(minutes * 60_000, reason);
        done.push(`${ACTIONS.timeout.label} : <@${target.user.id}> pendant ${minutes} min`);
      } else if (type === 'kick') {
        if (!target.member) continue;
        await target.member.kick(reason);
        done.push(`${ACTIONS.kick.label} : <@${target.user.id}>`);
      } else if (type === 'ban') {
        await guild.members.ban(target.user.id, { reason });
        done.push(`${ACTIONS.ban.label} : <@${target.user.id}>`);
      } else if (type === 'unban') {
        await guild.members.unban(target.user.id, reason);
        done.push(`${ACTIONS.unban.label} : <@${target.user.id}>`);
      }
    } catch { /* Discord a refusé : on n'annonce pas une action qui n'a pas eu lieu */ }
  }

  if (!done.length) return null;
  return `🛡️ **Action de modération**\n${done.join('\n')}`;
}

module.exports = { ACTIONS, MAX_TIMEOUT_MINUTES, canUse, applyActions };
