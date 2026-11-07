'use strict';
// utils/captchaGuards.js — Politique « captcha non contournable ».
//
// Un captcha n'a de valeur que si AUCUN chemin ne permet d'obtenir les accès
// sans le résoudre. Ce module centralise cette politique pour que le panneau
// (/captcha), le flux d'arrivée (guildMemberAdd) et la vérification du modal
// appliquent exactement les mêmes règles — pas de variante selon le chemin.
//
// Invariants garantis ici :
//   1. Un rôle de bypass doit être attribué par Discord lui-même (boost,
//      abonnement, intégration). Tout rôle qu'un bot, un auto-rôle ou un
//      membre peut distribuer à l'arrivée est refusé : sinon le role bypass
//      suffirait à entrer sans vérification.
//   2. @everyone, le rôle « avant » et le rôle « après » ne sont jamais des
//      bypass (ils annuleraient la porte par construction).
//   3. Un membre n'est jamais laissé sans vérification ET sans conséquence :
//      si le rôle « non vérifié » n'est pas configuré, l'expulsion est
//      obligatoire (sinon l'échec laisserait un accès complet).
//
// Le module est pur (aucune dépendance Discord/Mongo) → testable isolément.

// ── Rôle de bypass ───────────────────────────────────────────────────────────

const BYPASS_CODES = {
  everyone:     'Le rôle @everyone est porté par tous les membres : il donnerait un accès direct à tout le monde.',
  roleBefore:   'C\'est le rôle « non vérifié » : l\'utiliser en bypass annulerait la quarantaine.',
  roleAfter:    'C\'est le rôle « vérifié » : l\'utiliser en bypass donnerait l\'accès sans résoudre le captcha.',
  unknown:      'Rôle introuvable sur le serveur : le bypass est refusé (on reste fermé par défaut).',
  unmanaged:    'Seuls les rôles attribués automatiquement par Discord (boost, abonnement, intégration) peuvent servir de bypass : un rôle qu\'un bot ou un auto-rôle peut poser à l\'arrivée contournerait la vérification.',
};

/**
 * @param {object} ctx
 * @param {string} ctx.guildId
 * @param {string|null} ctx.bypassRoleId
 * @param {string|null} [ctx.roleBefore]
 * @param {string|null} [ctx.roleAfter]
 * @param {{ managed?: boolean }|null|undefined} [ctx.role]
 *   `null` = rôle introuvable (refus), `undefined` = non résolu par l'appelant (non vérifié)
 * @returns {null|string} code du problème, null si le bypass est légitime
 */
function bypassProblem({ guildId, bypassRoleId, roleBefore = null, roleAfter = null, role = undefined } = {}) {
  if (!bypassRoleId) return null;
  if (String(bypassRoleId) === String(guildId)) return 'everyone';
  if (bypassRoleId === roleBefore) return 'roleBefore';
  if (bypassRoleId === roleAfter) return 'roleAfter';
  if (role === null) return 'unknown';
  if (role !== undefined && role.managed !== true) return 'unmanaged';
  return null;
}

/**
 * Verdict complet — utilisable aussi quand aucun bypass n'est configuré.
 * @returns {{ ok: boolean, problem: string|null, text: string|null }}
 */
function bypassVerdict(ctx = {}) {
  const problem = bypassProblem(ctx);
  return {
    ok: !problem,
    problem,
    text: problem ? BYPASS_CODES[problem] : null,
  };
}

function bypassText(code) {
  return BYPASS_CODES[code] || 'Bypass refusé.';
}

// ── Conclusion d'un échec / d'un timeout ─────────────────────────────────────
// Le kick n'est facultatif QUE si un rôle « non vérifié » garde le membre hors
// des salons. Sinon, ne pas expulser reviendrait à laisser un accès complet à
// quelqu'un qui n'a jamais prouvé qu'il est humain.
function mustKick(cfg = {}) {
  if (!cfg) return true;
  if (cfg.kickOnFail === false && cfg.roleBefore) return false;
  return true;
}

// ── Diagnostic affiché dans le panneau ──────────────────────────────────────
/**
 * Audite la configuration et renvoie les points qui affaiblissent la porte.
 * @returns {{ problems: string[], bypass: { ok: boolean, problem: string|null, text: string|null } }}
 */
function gateAudit(cfg = {}, { guildId, role = null } = {}) {
  const problems = [];

  if (!cfg.channelId) problems.push('Aucun salon de vérification : le captcha ne peut pas être posé.');
  if (!cfg.roleAfter) problems.push('Aucun rôle « vérifié » : résoudre le captcha ne débloque aucun accès.');

  const bypass = bypassVerdict({
    guildId,
    bypassRoleId: cfg.bypassRoleId,
    roleBefore: cfg.roleBefore,
    roleAfter: cfg.roleAfter,
    role,
  });
  if (!bypass.ok) problems.push(bypass.text);

  if (cfg.roleBefore && cfg.roleAfter && cfg.roleBefore === cfg.roleAfter) {
    problems.push('Le rôle « avant » et le rôle « après » sont identiques.');
  }

  return { problems, bypass };
}

module.exports = {
  BYPASS_CODES,
  bypassProblem,
  bypassVerdict,
  bypassText,
  mustKick,
  gateAudit,
};
