'use strict';
// utils/disconEngine.js — DISCON : le niveau de danger d'un serveur.
//
// Cinq crans, un seul geste : à mesure que le niveau monte, le serveur se ferme
// tout seul (captcha → mode lent → lecture seule → invitations suspendues →
// salons masqués). Redescendre rouvre exactement ce qui avait été fermé, grâce
// à l'instantané conservé en base.
//
// Deux principes tenus par ce module :
//   • **réversible** — chaque action retient l'état d'avant pour le restaurer ;
//   • **tolérant** — une permission manquante n'annule pas le reste : elle est
//     signalée dans `skipped` et le niveau reste appliqué.
//
// Les métadonnées et les diffs sont purs (testables sans Discord ni Mongo) ;
// seules `applyLevel` / `setLevel` touchent au serveur et à la base.

const Discon = require('../models/Discon');

// ─── Les cinq crans ────────────────────────────────────────────────────────
// `steps` est cumulatif : le niveau N applique toutes les étapes ≤ N.
const LEVELS = [
  {
    level: 0, key: 'normal', label: 'Normal', emoji: '⚪', color: 0x95A5A6,
    summary: 'Aucune restriction : le serveur vit normalement.',
    steps: [],
  },
  {
    level: 1, key: 'guet', label: 'Guet', emoji: '🟢', color: 0x57F287,
    summary: 'Les arrivées passent par le captcha avant d’accéder au serveur.',
    steps: ['captcha'],
  },
  {
    level: 2, key: 'vigilance', label: 'Vigilance', emoji: '🟡', color: 0xFEE75C,
    summary: 'En plus : un mode lent freine toute vague de messages.',
    steps: ['captcha', 'slowmode'],
  },
  {
    level: 3, key: 'alerte', label: 'Alerte', emoji: '🟠', color: 0xE67E22,
    summary: 'En plus : les salons passent en lecture seule.',
    steps: ['captcha', 'slowmode', 'lockdown'],
  },
  {
    level: 4, key: 'danger', label: 'Danger', emoji: '🔴', color: 0xED4245,
    summary: 'En plus : plus aucune invitation ne peut être créée.',
    steps: ['captcha', 'slowmode', 'lockdown', 'invites'],
  },
  {
    level: 5, key: 'verrouillage', label: 'Verrouillage', emoji: '⚫', color: 0x2C2F33,
    summary: 'En plus : les salons sont masqués aux membres — serveur fermé.',
    steps: ['captcha', 'slowmode', 'lockdown', 'invites', 'shield'],
  },
];

const STEPS = {
  captcha:  { id: 'captcha',  label: 'Captcha obligatoire',     emoji: '🔒' },
  slowmode: { id: 'slowmode', label: 'Mode lent 20 s',           emoji: '🐌' },
  lockdown: { id: 'lockdown', label: 'Salons en lecture seule',  emoji: '🔐' },
  invites:  { id: 'invites',  label: 'Invitations suspendues',   emoji: '🚫' },
  shield:   { id: 'shield',   label: 'Salons masqués',           emoji: '🌑' },
};

const SLOWMODE_SECONDS = 20;
const MAX_LEVEL = 5;

function clampLevel(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_LEVEL, Math.max(0, n));
}

function levelDef(level) {
  return LEVELS[clampLevel(level)];
}

/** Étapes réellement appliquées à ce niveau (cumulatif, sans doublon). */
function planFor(level) {
  const def = levelDef(level);
  return [...new Set(def.steps)];
}

/** Différence entre deux niveaux : ce qu'il faut allumer et éteindre. */
function changesBetween(fromLevel, toLevel) {
  const before = new Set(planFor(fromLevel));
  const after = new Set(planFor(toLevel));
  return {
    activate: [...after].filter(step => !before.has(step)),
    deactivate: [...before].filter(step => !after.has(step)),
    order: [...after],
  };
}

/** Barre de cinq crans, pour l'embed. */
function levelBar(level, { filled = '▰', empty = '▱' } = {}) {
  const n = clampLevel(level);
  return `${filled.repeat(n)}${empty.repeat(MAX_LEVEL - n)}`;
}

/** Phrase qui décrit ce que le cran suivant ajoute. */
function nextStepHint(level) {
  const next = clampLevel(level) + 1;
  if (next > MAX_LEVEL) return 'Niveau maximal : le serveur est entièrement fermé.';
  const added = changesBetween(level, next).activate;
  const labels = added.map(id => `${STEPS[id].emoji} ${STEPS[id].label}`).join(', ');
  return `Cran **${next}** — ${levelDef(next).label} : ajoute ${labels}.`;
}

// ─── Accès base ────────────────────────────────────────────────────────────

async function getState(guildId) {
  let doc = await Discon.findOne({ guildId });
  if (!doc) doc = await Discon.create({ guildId });
  return doc;
}

// ─── Application réelle ────────────────────────────────────────────────────

/**
 * Applique un niveau au serveur.
 *
 * @returns {Promise<{level:number, applied:string[], skipped:{step:string, reason:string}[], doc:object}>}
 */
async function applyLevel(guild, level, { byId = null, doc = null, preserve = [] } = {}) {
  if (!guild) throw new Error('applyLevel : serveur requis');

  const target = clampLevel(level);
  const state = doc || await getState(guild.id);
  const current = clampLevel(state.level);
  const { activate, deactivate } = changesBetween(current, target);

  const applied = [];
  const skipped = [];
  const fail = (step, err) => skipped.push({ step, reason: err?.message || String(err) });

  state.snapshot = state.snapshot || {};

  // ── Extinction (dans l'ordre inverse pour ne jamais masquer un salon avant
  //    de l'avoir rouvert) ──────────────────────────────────────────────────
  for (const step of ['shield', 'invites', 'lockdown', 'slowmode', 'captcha']) {
    if (!deactivate.includes(step)) continue;
    try {
      if (step === 'shield') await setShield(guild, false, state);
      else if (step === 'invites') await setInvites(guild, false, state);
      else if (step === 'lockdown') await setLockdown(guild, false, state, preserve);
      else if (step === 'slowmode') await setSlowmode(guild, 0, state);
      else if (step === 'captcha') await setCaptcha(state, false);
    } catch (err) { fail(step, err); }
  }

  // ── Allumage ─────────────────────────────────────────────────────────────
  for (const step of activate) {
    try {
      if (step === 'captcha') await setCaptcha(state, true);
      else if (step === 'slowmode') await setSlowmode(guild, SLOWMODE_SECONDS, state);
      else if (step === 'lockdown') await setLockdown(guild, true, state, preserve);
      else if (step === 'invites') await setInvites(guild, true, state);
      else if (step === 'shield') await setShield(guild, true, state, preserve);
      applied.push(step);
    } catch (err) { fail(step, err); }
  }

  state.level = target;
  state.byId = byId;
  state.changedAt = new Date();
  state.history = [...(state.history || []), { level: target, byId, at: new Date() }].slice(-Discon.HISTORY_MAX || -25);
  try { await state.save(); } catch (err) { fail('save', err); }

  return { level: target, applied, skipped, doc: state };
}

// ─── Une action par étape ──────────────────────────────────────────────────

async function setCaptcha(state, enable) {
  const { CaptchaConfig } = require('../models/Captcha');
  const cfg = await CaptchaConfig.findOne({ guildId: state.guildId });
  if (!cfg) throw new Error('captcha non configuré (`/captcha`)');

  // On ne capture l'état d'origine qu'une fois : redescendre doit restaurer
  // exactement ce que l'admin avait, pas ce que DISCON a mis.
  state.snapshot = state.snapshot || {};
  if (state.snapshot.captchaEnabled === null || state.snapshot.captchaEnabled === undefined) {
    state.snapshot.captchaEnabled = Boolean(cfg.enabled);
  }
  cfg.enabled = enable ? true : Boolean(state.snapshot.captchaEnabled);
  await cfg.save();
}

async function setSlowmode(guild, seconds, state) {
  let touched = 0;
  for (const [, ch] of guild.channels.cache) {
    if (!ch.isTextBased?.() || ch.isThread?.()) continue;
    if (typeof ch.setRateLimitPerUser !== 'function') continue;
    try {
      await ch.setRateLimitPerUser(seconds, seconds ? 'DISCON — mode lent' : 'DISCON — retour à la normale');
      touched++;
    } catch { /* salon sans permission : on continue */ }
  }
  if (!touched && seconds) throw new Error('aucun salon modifiable (permission *Gérer les salons*)');
  if (state?.snapshot) state.snapshot.slowmode = Boolean(seconds);
}

// `preserve` : salons qu'on ne touche jamais (le journal anti-raid doit rester
// lisible par le staff pendant le rideau, sinon la riposte est invisible).
async function setLockdown(guild, enable, state, preserve = []) {
  const keep = new Set(preserve.filter(Boolean));
  let count = 0;
  for (const [id, ch] of guild.channels.cache) {
    if (keep.has(id)) continue;
    if (!(ch.isTextBased?.() && !ch.isThread?.())) continue;
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: enable ? false : null }, {
        reason: enable ? 'DISCON — lecture seule' : 'DISCON — retour à la normale',
      });
      count++;
    } catch { /* salon protégé : on continue */ }
  }
  if (!count && enable) throw new Error('aucun salon modifiable (permission *Gérer les salons*)');
  if (state?.snapshot) state.snapshot.lockdown = Boolean(enable);
}

// `suspend = true` retire la permission de créer des invitations ; on ne la
// rend que si DISCON l'avait retirée, jamais par-dessus une décision d'admin.
async function setInvites(guild, suspend, state) {
  if (suspend) {
    await guild.roles.everyone.setPermissions(
      guild.roles.everyone.permissions.remove('CreateInstantInvite'),
      'DISCON — invitations suspendues',
    );
    if (state?.snapshot) state.snapshot.invites = true;
    return;
  }
  if (!state?.snapshot?.invites) return; // rien retiré par DISCON : on ne touche à rien
  await guild.roles.everyone.setPermissions(
    guild.roles.everyone.permissions.add('CreateInstantInvite'),
    'DISCON — invitations rétablies',
  );
  state.snapshot.invites = false;
}

async function setShield(guild, enable, state, preserve = []) {
  const keep = new Set(preserve.filter(Boolean));
  let touched = 0;
  for (const [id, ch] of guild.channels.cache) {
    if (keep.has(id)) continue;
    if (!ch.isTextBased?.() || ch.isThread?.() || ch.isCategory?.()) continue;
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: enable ? false : null }, {
        reason: enable ? 'DISCON — salons masqués' : 'DISCON — salons rouverts',
      });
      touched++;
    } catch { /* ignore */ }
  }
  if (!touched && enable) throw new Error('aucun salon modifiable (permission *Gérer les salons*)');
  if (state?.snapshot) state.snapshot.shield = Boolean(enable);
}

module.exports = {
  LEVELS,
  STEPS,
  MAX_LEVEL,
  SLOWMODE_SECONDS,
  clampLevel,
  levelDef,
  planFor,
  changesBetween,
  levelBar,
  nextStepHint,
  getState,
  applyLevel,
};
