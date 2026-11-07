'use strict';
// utils/modTools.js — Outils de modération ponctuels.
//
// Chaque outil ici est une ACTION (pas une configuration) : débannir, verrouiller
// un salon, régler le mode lent, débloquer un membre coincé derrière le captcha.
// Ils sont regroupés derrière une seule commande (`/mod`) parce que Discord
// plafonne une application à 100 commandes globales — et que le budget est plein.
//
// Deux principes :
//   1. Aucune définition parallèle. Le verrou d'un salon vient de
//      `utils/channelLock` : ce que cette commande pose, la sauvegarde le
//      comprend et la restauration sait le reposer.
//   2. Tout est vérifiable hors-ligne. Les décisions (durée valide, identifiant
//      valide, plan de bypass) sont des fonctions pures ; les effets Discord
//      sont isolés dans les fonctions `apply*`.

const channelLock = require('./channelLock');

const SLOWMODE_MAX = 21_600; // 6 h — plafond imposé par Discord
const MANAGE_MESSAGES = 'ManageMessages';

// ─── Identifiants ───────────────────────────────────────────────────────────

/**
 * Extrait un identifiant de membre d'une saisie libre.
 * Accepte `123456789012345678`, `<@1234…>` et `<@!1234…>`.
 * @returns {string|null}
 */
function parseUserId(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  const mention = text.match(/^<@!?(\d{17,20})>$/);
  if (mention) return mention[1];
  if (/^\d{17,20}$/.test(text)) return text;
  return null;
}

// ─── Durées ────────────────────────────────────────────────────────────────

/**
 * Lit une durée de mode lent.
 *
 * Accepte : `off`, `0`, `30` (secondes), `45s`, `5m`, `2h`, `1h30m`.
 * @returns {{ ok: boolean, seconds?: number, error?: string }}
 */
function parseSlowmode(raw) {
  if (raw === null || raw === undefined) return { ok: false, error: 'Indique une durée (`off`, `30s`, `5m`, `2h`).' };
  const text = String(raw).trim().toLowerCase();
  if (!text) return { ok: false, error: 'Indique une durée (`off`, `30s`, `5m`, `2h`).' };
  if (['off', 'aucun', 'none', '0', '0s'].includes(text)) return { ok: true, seconds: 0 };

  // Forme composée : 1h30m, 1h30, 2h15
  const composed = text.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/);
  if (composed && (composed[1] || composed[2] || composed[3])) {
    const seconds = Number(composed[1] || 0) * 3600
      + Number(composed[2] || 0) * 60
      + Number(composed[3] || 0);
    return clampSlowmode(seconds);
  }

  // « 1h30 » : les minutes peuvent suivre les heures sans unité (usage courant),
  // la forme stricte ci-dessus exige le « m ».
  const shortForm = text.match(/^(\d+)\s*h\s*(\d{1,2})$/);
  if (shortForm) {
    return clampSlowmode(Number(shortForm[1]) * 3600 + Number(shortForm[2]) * 60);
  }

  // Nombre nu = secondes.
  if (/^\d+$/.test(text)) return clampSlowmode(Number(text));

  return { ok: false, error: 'Format inconnu : utilise `off`, `30s`, `5m`, `2h` ou `1h30m`.' };
}

function clampSlowmode(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, error: 'La durée doit être positive.' };
  if (seconds > SLOWMODE_MAX) {
    return { ok: false, error: `Discord plafonne le mode lent à ${SLOWMODE_MAX / 3600} h.` };
  }
  return { ok: true, seconds: Math.trunc(seconds) };
}

/** « 1 h 30 min », « 45 s », « désactivé ». */
function describeSlowmode(seconds) {
  const value = Number(seconds) || 0;
  if (value <= 0) return 'désactivé';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  const parts = [];
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (secs && !hours) parts.push(`${secs} s`);
  return parts.join(' ');
}

// ─── Débannissement ────────────────────────────────────────────────────────

/**
 * Lève un bannissement.
 *
 * On lit d'abord la liste des bannissements : sans ça, `bans.remove` réussit
 * silencieusement sur un membre qui n'était pas banni et le staff croit avoir
 * agi. Le nom est renvoyé quand Discord le connaît encore.
 *
 * @returns {Promise<{ok:boolean, code?:string, tag?:string, user?:object, error?:Error}>}
 */
async function applyUnban(guild, { userId, reason = null } = {}) {
  const id = parseUserId(userId);
  if (!id) return { ok: false, code: 'bad-id' };
  if (typeof guild?.bans?.fetch !== 'function' || typeof guild?.bans?.remove !== 'function') {
    return { ok: false, code: 'unsupported' };
  }

  let ban = null;
  try {
    ban = await guild.bans.fetch(id);
  } catch {
    return { ok: false, code: 'not-banned' };
  }

  try {
    await guild.bans.remove(id, reason ? String(reason).slice(0, 480) : undefined);
  } catch (error) {
    return { ok: false, code: 'failed', error };
  }

  const user = ban?.user || null;
  return { ok: true, user, tag: user?.tag || user?.username || id };
}

// ─── Verrouillage ──────────────────────────────────────────────────────────

/**
 * Verrouille ou rouvre un salon, avec la définition unique de `channelLock`.
 * @returns {Promise<{ok:boolean, changed?:boolean, already?:boolean, code?:string}>}
 */
async function applyLock(channel, guild, { locked = true, reason = null } = {}) {
  const result = await channelLock.setChannelLock(channel, guild, {
    locked,
    reason: reason || (locked ? 'Salon verrouillé' : 'Salon rouvert'),
  }).catch(() => ({ ok: false, reason: 'failed' }));

  if (!result?.ok) return { ok: false, code: result?.reason || 'failed' };
  return { ok: true, changed: result.changed === true, already: result.changed === false };
}

// ─── Mode lent ─────────────────────────────────────────────────────────────

/**
 * Applique le mode lent d'un salon.
 * @returns {Promise<{ok:boolean, seconds:number, previous:number, changed:boolean, code?:string}>}
 */
async function applySlowmode(channel, { seconds, reason = null } = {}) {
  const previous = Number(channel?.rateLimitPerUser) || 0;
  if (typeof channel?.setRateLimitPerUser !== 'function') {
    return { ok: false, code: 'unsupported', seconds: previous, previous, changed: false };
  }
  if (previous === seconds) {
    return { ok: true, seconds, previous, changed: false };
  }
  try {
    await channel.setRateLimitPerUser(seconds, reason ? String(reason).slice(0, 480) : undefined);
  } catch (error) {
    return { ok: false, code: 'failed', seconds: previous, previous, changed: false, error };
  }
  return { ok: true, seconds, previous, changed: true };
}

// ─── Bypass captcha ────────────────────────────────────────────────────────

/**
 * Plan de déblocage captcha — pur, testable sans Discord.
 *
 * Un membre légitime peut rester coincé (image illisible, handicap visuel,
 * mobile cassé). Le staff le fait alors passer sans résoudre le captcha : on
 * retire le rôle « non vérifié », on pose le rôle « vérifié », et le document
 * d'attente est supprimé pour que l'expiration ne l'expulse pas plus tard.
 *
 * @returns {{ ok: boolean, code?: string, remove?: string|null, add?: string|null }}
 */
function bypassPlan(cfg, memberRoleIds = []) {
  if (!cfg || cfg.enabled !== true) return { ok: false, code: 'captcha-off' };
  if (!cfg.roleAfter) return { ok: false, code: 'no-role-after' };
  const roles = Array.isArray(memberRoleIds) ? memberRoleIds : [...(memberRoleIds || [])];
  if (roles.includes(cfg.roleAfter)) return { ok: false, code: 'already-verified' };
  return {
    ok: true,
    add: cfg.roleAfter,
    remove: cfg.roleBefore && cfg.roleBefore !== cfg.roleAfter ? cfg.roleBefore : null,
  };
}

/**
 * Applique le plan ci-dessus sur un membre réel.
 * @returns {Promise<{ok:boolean, code?:string, added?:string, removed?:string}>}
 */
async function applyCaptchaBypass(member, { moderatorId = null, reason = null } = {}) {
  const guildId = member?.guild?.id;
  if (!guildId || !member?.roles?.cache) return { ok: false, code: 'unsupported' };

  const { CaptchaConfig, CaptchaPending, CaptchaLog } = require('../models/Captcha');
  const cfg = await CaptchaConfig.findOne({ guildId }).lean().catch(() => null);
  const plan = bypassPlan(cfg, member.roles.cache.keys ? [...member.roles.cache.keys()] : []);
  if (!plan.ok) return plan;

  const audit = `Bypass captcha${moderatorId ? ` par ${moderatorId}` : ''}${reason ? ` — ${reason}` : ''}`.slice(0, 480);

  try {
    if (plan.remove) await member.roles.remove(plan.remove, audit).catch(() => {});
    await member.roles.add(plan.add, audit);
  } catch (error) {
    return { ok: false, code: 'failed', error };
  }

  // L'attente doit disparaître : sinon le balayage d'expiration expulserait un
  // membre que le staff vient précisément d'autoriser.
  await CaptchaPending.deleteOne({ userId: member.id, guildId }).catch(() => {});
  await CaptchaLog.create({
    guildId,
    userId: member.id,
    action: 'bypassed',
    detail: audit,
  }).catch(() => {});

  return { ok: true, added: plan.add, removed: plan.remove };
}

// ─── Aides de présentation ─────────────────────────────────────────────────

/** Refus homogène quand le bot ne peut pas agir sur une cible plus haute. */
function outranked(moderator, target) {
  const modPos = moderator?.roles?.highest?.position;
  const targetPos = target?.roles?.highest?.position;
  if (typeof modPos !== 'number' || typeof targetPos !== 'number') return false;
  return targetPos >= modPos;
}

const BYPASS_ERRORS = {
  'captcha-off': 'Le captcha est désactivé sur ce serveur : il n’y a rien à contourner.',
  'no-role-after': 'Aucun rôle « vérifié » n’est configuré : le bypass ne donnerait aucun accès.',
  'already-verified': 'Ce membre est déjà vérifié.',
  'bad-id': 'Identifiant invalide : donne un identifiant Discord (17-20 chiffres) ou une mention.',
  'not-banned': 'Cet utilisateur n’est pas banni de ce serveur.',
  unsupported: 'Action impossible sur ce serveur (salon ou membre non modifiable).',
  failed: 'Discord a refusé l’action — vérifie mes permissions et la position des rôles.',
  thread: 'Un fil de discussion n’a pas de permissions propres : verrouille le salon parent.',
  nobody: 'Aucun membre trouvé.',
};

function errorText(code) {
  return BYPASS_ERRORS[code] || 'Action impossible.';
}

module.exports = {
  SLOWMODE_MAX,
  MANAGE_MESSAGES,
  parseUserId,
  parseSlowmode,
  clampSlowmode,
  describeSlowmode,
  applyUnban,
  applyLock,
  applySlowmode,
  bypassPlan,
  applyCaptchaBypass,
  outranked,
  errorText,
};
