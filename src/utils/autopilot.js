'use strict';
// utils/autopilot.js — L'autopilote REZO.
//
// Transforme un serveur « à peu près configuré » en serveur configuré à ~90%
// sans que le staff ait à ouvrir 30 commandes. Trois responsabilités :
//
//   1. choisir  les salons/rôles existants qui conviennent (heuristique de nom)
//   2. planifier ce qu'on peut activer SANS risque (aucune action destructive)
//   3. appliquer le plan en base, action par action, avec rapport détaillé
//
// Le plan est une donnée pure ({filter, update, model}) : il se teste sans
// Discord ni MongoDB, et l'écriture est injectable.
//
// Principe de sécurité : l'autopilote n'active QUE des valeurs par défaut
// réversibles. Tout ce qui peut enfermer des membres dehors (captcha,
// quarantaine, onboarding) reste volontairement manuel.

const {
  PermissionFlagsBits, ChannelType,
} = require('discord.js');

const Server                        = require('../models/Server');
const { Welcome, Farewell }        = require('../models/Welcome');
const XPConfig                      = require('../models/XPConfig');
const AutoRole                      = require('../models/AutoRole');
const AutoMod                       = require('../models/AutoMod');
const AntiScamConfig                = require('../models/AntiScamConfig');
const { AntiRaid }                  = require('../models/AntiRaid');
const WarnThresholds                = require('../models/WarnThresholds');
const GuildLogs                     = require('../models/GuildLogs');
const { Config: SignalementConfig } = require('../models/Signalement');
const Starboard                     = require('../models/Starboard');
const CountingGame                  = require('../models/CountingGame');
const BirthdayConfig                = require('../models/BirthdayConfig');
const WeeklyRecap                   = require('../models/WeeklyRecap');
const ReputationConfig              = require('../models/ReputationConfig');
const AutoThread                    = require('../models/AutoThread');
const InviteConfig                  = require('../models/InviteConfig');
const ForumWelcome                  = require('../models/ForumWelcome');
const { NotificationConfig }        = require('../models/Notification');

// Modèle utilisable par le plan (le nom est la clé stockée dans chaque action).
const MODELS = {
  Server, Welcome, Farewell, XPConfig, AutoRole, AutoMod, AntiScamConfig, AntiRaid,
  WarnThresholds, GuildLogs, SignalementConfig, Starboard, CountingGame,
  BirthdayConfig, WeeklyRecap, ReputationConfig, AutoThread, InviteConfig,
  ForumWelcome, NotificationConfig,
};

// ── Heuristiques de nommage (français + anglais) ────────────────────────────
const CHANNEL_HINTS = {
  welcome:   ['bienvenue', 'welcome', 'arrivee', 'accueil', 'join'],
  farewell:  ['depart', 'departs', 'aurevoir', 'goodbye', 'leave', 'adieu'],
  logs:      ['logs', 'log', 'journaux', 'journal', 'modlog', 'modlogs', 'audit', 'logsstaff', 'stafflog'],
  annonces:  ['annonces', 'annonce', 'announcements', 'announcement', 'news', 'actus', 'actualites'],
  general:   ['general', 'generale', 'taverne', 'chat', 'discussions', 'blabla'],
  starboard: ['starboard', 'vedettes', 'bestof', 'etoiles'],
  counting:  ['comptage', 'counting', 'compter', 'count'],
  captcha:   ['captcha', 'verification', 'portail', 'porte', 'arrivee'],
  honeypot:  ['honeypot', 'piege', 'trap'],
  tickets:   ['ticket', 'tickets', 'support', 'assistance'],
  forum:     ['forum', 'forums', 'discussions'],
};

const ROLE_HINTS = {
  member: ['membre', 'membres', 'member', 'members', 'nouveau', 'nouveaux', 'arrivant', 'citoyen', 'communauté'],
};

const TEXT_CHANNEL = ChannelType?.GuildText ?? 0;
const FORUM_CHANNEL = ChannelType?.GuildForum ?? 15;

// Normalise un nom : minuscules, sans accents, sans séparateurs.
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function matchesHint(name, hints) {
  return hintScore(name, hints) > 0;
}

// 2 = correspondance exacte, 1 = le nom contient le mot-clé, 0 = rien.
// Un salon « annonces » l'emporte donc sur un « général » générique.
function hintScore(name, hints) {
  const n = normalize(name);
  if (!n) return 0;
  let best = 0;
  for (const h of hints) {
    if (n === h) return 2;
    if (n.includes(h) || (n.length >= 4 && h.includes(n))) best = Math.max(best, 1);
  }
  return best;
}

// Le bot peut-il écrire ici ? En cas d'info manquante on est permissif : mieux
// vaut proposer un salon que d'abandonner silencieusement.
function canWrite(channel, me) {
  if (!me || typeof channel.permissionsFor !== 'function') return true;
  try {
    const perms = channel.permissionsFor(me);
    if (!perms || typeof perms.has !== 'function') return true;
    return perms.has(PermissionFlagsBits.SendMessages);
  } catch { return true; }
}

// ── Sélection des salons et rôles existants ─────────────────────────────────
function pickTextChannels(guild, me = null) {
  const text = [];
  const forums = [];
  const all = guild?.channels?.cache;
  if (all) {
    for (const ch of (typeof all.values === 'function' ? all.values() : all)) {
      if (ch?.type === FORUM_CHANNEL || ch?.type === 'GuildForum') { forums.push(ch); continue; }
      if (ch?.type !== TEXT_CHANNEL && ch?.type !== 'GuildText') continue;
      if (!canWrite(ch, me)) continue;
      text.push(ch);
    }
  }
  // Tri par position : on privilégie les salons hauts dans la liste.
  text.sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0));

  const picks = {};
  for (const [key, hints] of Object.entries(CHANNEL_HINTS)) {
    let best = null; let bestScore = 0;
    for (const ch of text) {
      const score = hintScore(ch.name, hints);
      if (score > bestScore) { best = ch; bestScore = score; if (score === 2) break; }
    }
    if (best) picks[key] = best.id;
  }
  // Salon forum (accueil automatique des posts) — jamais créé, seulement utilisé.
  let bestForum = null; let bestForumScore = 0;
  for (const ch of forums) {
    const score = hintScore(ch.name, CHANNEL_HINTS.forum);
    if (score > bestForumScore) { bestForum = ch; bestForumScore = score; }
  }
  if (bestForum) picks.forum = bestForum.id;
  else if (forums[0]) picks.forum = forums[0].id;

  // Replis : un salon d'annonces universel, sinon le salon principal.
  if (!picks.annonces) picks.annonces = picks.general || null;
  if (!picks.general)   picks.general  = picks.annonces || null;
  // Le salon système de Discord est le meilleur candidat par défaut
  // pour les messages de bienvenue / départ.
  const sys = guild?.systemChannelId;
  if (sys && text.some(ch => ch.id === sys)) {
    if (!picks.welcome) picks.welcome = sys;
    if (!picks.farewell) picks.farewell = sys;
  } else if (text[0]) {
    if (!picks.welcome) picks.welcome = text[0].id;
  }
  return picks;
}

function pickRole(guild, kind = 'member') {
  const hints = ROLE_HINTS[kind] || [];
  const roles = guild?.roles?.cache;
  if (!roles) return null;
  for (const r of (typeof roles.values === 'function' ? roles.values() : roles)) {
    if (!r || r.managed) continue;
    if (matchesHint(r.name, hints)) return r.id;
  }
  return null;
}

// ── Plan d'automatisation ───────────────────────────────────────────────────
// `pickable`: { channelKey: name } — les salons qu'on sait créer si absents.
const CHANNEL_PICKABLE = {
  welcome:   { name: 'bienvenue', label: 'Salon de bienvenue' },
  logs:      { name: 'logs',      label: 'Salon des logs (privé)', private: true },
  annonces:  { name: 'annonces',  label: 'Salon des annonces' },
  counting:  { name: 'comptage',  label: 'Salon de comptage' },
  starboard: { name: 'starboard', label: 'Salon starboard' },
};

// Construit le plan à partir de l'état collecté et des salons/rôles choisis.
function buildPlan(state = {}, picks = {}) {
  const guildId = state.guildId || picks.guildId || null;
  const steps = [];
  const blocked = [];

  const need = (moduleKey, label, channelKey, keys) => {
    const chosen = keys.map(k => picks[k]).find(Boolean);
    if (!chosen) {
      blocked.push({
        moduleKey, label, channelKey,
        reason: `Aucun salon « ${CHANNEL_PICKABLE[channelKey]?.name || channelKey} » trouvé`,
        createName: CHANNEL_PICKABLE[channelKey]?.name || null,
      });
      return null;
    }
    return chosen;
  };

  const add = (moduleKey, label, model, update, filter = { guildId }) => {
    steps.push({ moduleKey, label, model, filter, update: { $set: update }, upsert: true });
  };

  // ── Accueil ───────────────────────────────────────────────────────────────
  if (!(state.welcome?.enabled && state.welcome?.channelId)) {
    const ch = need('welcome', 'Message de bienvenue', 'welcome', ['welcome']);
    if (ch) add('welcome', 'Activer le message de bienvenue', 'Welcome', {
      guildId, channelId: ch, enabled: true,
    });
  }
  if (!(state.farewell?.enabled && state.farewell?.channelId)) {
    const ch = need('farewell', 'Message de départ', 'welcome', ['farewell', 'welcome']);
    if (ch) add('farewell', 'Activer le message de départ', 'Farewell', {
      guildId, channelId: ch, enabled: true,
    });
  }
  if (!state.xp?.enabled) {
    add('xp', 'Activer les niveaux & XP', 'XPConfig', { guildId, enabled: true, announceLevelUp: true });
  }
  if (!(state.autorole?.enabled && state.autorole?.roleId)) {
    const roleId = picks.memberRole || null;
    if (roleId) add('autorole', 'Activer l\'autorôle', 'AutoRole', { guildId, roleId, enabled: true });
    else blocked.push({ moduleKey: 'autorole', label: 'Autorôle', reason: 'Aucun rôle « membre » trouvé', createName: null });
  }

  // ── Sécurité ──────────────────────────────────────────────────────────────
  if (!(state.automod && (state.automod.spamEnabled || state.automod.raidEnabled
      || state.automod.linksEnabled || state.automod.capsEnabled))) {
    add('automod', 'Activer l\'auto-modération', 'AutoMod', {
      guildId, spamEnabled: true, linksEnabled: true, capsEnabled: true,
    });
  }
  if (!state.antiScam?.enabled) {
    add('antiscam', 'Activer l\'anti-scam', 'AntiScamConfig', {
      guildId, enabled: true, logChannelId: picks.logs || null,
    });
  }
  if (!state.antiRaid?.enabled) {
    add('antiRaid', 'Armer l\'anti-raid', 'AntiRaid', { guildId, enabled: true });
  }
  if (!(Array.isArray(state.warnThresholds?.thresholds) && state.warnThresholds.thresholds.length)) {
    add('warnPaliers', 'Installer les paliers d\'avertissement', 'WarnThresholds', {
      guildId,
      thresholds: [
        { count: 3, action: 'mute', duration: 60 },
        { count: 5, action: 'kick',   duration: 0 },
        { count: 8, action: 'ban',    duration: 0 },
      ],
    });
  }

  // ── Gestion ───────────────────────────────────────────────────────────────
  const logsConfigured = !!state.logs && ['moderation', 'membres', 'messages', 'vocal']
    .some(k => state.logs[k]?.enabled && state.logs[k]?.channelId);
  if (!logsConfigured) {
    const ch = need('logs', 'Logs serveur', 'logs', ['logs']);
    if (ch) add('logs', 'Activer les logs serveur', 'GuildLogs', {
      guildId,
      moderation: { enabled: true, channelId: ch },
      messages:   { enabled: true, channelId: ch },
      membres:    { enabled: true, channelId: ch },
    });
  }
  if (!(state.signalement?.enabled && state.signalement?.logChannelId)) {
    const ch = need('signalement', 'Signalements', 'logs', ['logs']);
    if (ch) add('signalement', 'Activer les signalements', 'SignalementConfig', {
      guildId, enabled: true, logChannelId: ch,
    });
  }

  // ── Communauté ────────────────────────────────────────────────────────────
  if (!(state.starboard?.enabled && state.starboard?.channelId)) {
    const ch = need('starboard', 'Starboard', 'starboard', ['starboard']);
    if (ch) add('starboard', 'Activer le starboard', 'Starboard', { guildId, channelId: ch, enabled: true });
  }
  if (!(state.counting?.enabled && state.counting?.channelId)) {
    const ch = need('counting', 'Jeu de comptage', 'counting', ['counting']);
    if (ch) add('counting', 'Lancer le jeu de comptage', 'CountingGame', {
      guildId, channelId: ch, enabled: true, resetOnFail: true, deleteWrongMessages: true,
    });
  }
  if (!(state.birthday?.enabled && state.birthday?.channelId)) {
    const ch = need('anniversaire', 'Anniversaires', 'annonces', ['annonces', 'welcome']);
    if (ch) add('anniversaire', 'Activer les anniversaires', 'BirthdayConfig', { guildId, channelId: ch, enabled: true });
  }
  if (!(state.recap?.enabled && state.recap?.channelId)) {
    const ch = need('recap', 'Récap hebdomadaire', 'annonces', ['annonces']);
    if (ch) add('recap', 'Activer le récap hebdomadaire', 'WeeklyRecap', { guildId, channelId: ch, enabled: true });
  }
  if (!state.reputation?.enabled) {
    add('reputation', 'Activer la réputation', 'ReputationConfig', { guildId, enabled: true });
  }

  // ── Automatisation ────────────────────────────────────────────────────────
  if (!state.autothread?.enabled) {
    add('autothread', 'Activer les threads automatiques', 'AutoThread', { guildId, enabled: true });
  }
  if (!state.invites?.enabled) {
    add('invites', 'Activer le suivi des invitations', 'InviteConfig', { guildId, enabled: true });
  }
  if (!(state.forumWelcome?.enabled && state.forumWelcome?.forumChannelId)) {
    const ch = picks.forum;
    if (ch) add('forumWelcome', 'Activer l\'accueil des forums', 'ForumWelcome', { guildId, forumChannelId: ch, enabled: true });
    else blocked.push({ moduleKey: 'forumWelcome', label: 'Accueil des forums', reason: 'Aucun salon forum sur le serveur', createName: null });
  }

  // ── Croissance (salon d'annonces disponible) ──────────────────────────────
  if (!state.server?.partnerChannelId) {
    const ch = need('partenariats', 'Partenariats', 'annonces', ['annonces', 'general']);
    if (ch) add('partenariats', 'Activer les annonces de partenariat', 'Server', { guildId, partnerChannelId: ch });
  }
  if (!state.notif || (!state.notif.panelChannelId && !state.notif.logChannelId)) {
    const ch = need('notifications', 'Notifications automatiques', 'annonces', ['annonces', 'general']);
    if (ch) add('notifications', 'Activer les notifications automatiques', 'NotificationConfig', { guildId, logChannelId: ch });
  }

  return { guildId, steps, blocked };
}

// Salons à créer pour débloquer les modules bloqués.
function missingChannels(plan) {
  const byName = new Map();
  for (const b of plan.blocked) {
    if (!b.createName) continue;
    if (!byName.has(b.createName)) byName.set(b.createName, { name: b.createName, unlocks: [] });
    byName.get(b.createName).unlocks.push(b.label);
  }
  return [...byName.values()];
}

// ── Application ─────────────────────────────────────────────────────────────
// Écrivain par défaut : upsert Mongoose. `write` est injectable pour les tests.
async function defaultWrite(step) {
  const Model = MODELS[step.model];
  if (!Model) throw new Error(`Modèle inconnu: ${step.model}`);
  return Model.findOneAndUpdate(step.filter, step.update, {
    upsert: true, new: true, setDefaultsOnInsert: true,
  });
}

async function applyPlan(plan, { write = defaultWrite } = {}) {
  const applied = [];
  const failed = [];
  for (const step of plan.steps || []) {
    try {
      await write(step);
      applied.push({ key: step.moduleKey, label: step.label });
    } catch (err) {
      failed.push({ key: step.moduleKey, label: step.label, error: err.message });
    }
  }
  return { applied, failed, blocked: plan.blocked || [] };
}

// Crée les salons standards manquants. Uniquement ceux explicitement demandés.
async function createMissingChannels(guild, channels) {
  const created = [];
  const failed = [];
  for (const spec of channels || []) {
    try {
      // Itération générique : fonctionne avec une Collection discord.js comme
      // avec une simple Map (tests hors-ligne).
      const cache  = guild.channels.cache;
      const values = typeof cache?.values === 'function' ? [...cache.values()] : [];
      const already = values.find(c => normalize(c?.name) === normalize(spec.name));
      if (already) { created.push({ name: spec.name, id: already.id, existed: true }); continue; }
      const opts = { name: spec.name, type: TEXT_CHANNEL, reason: 'REZO Autopilote — configuration initiale' };
      if (spec.private) {
        opts.permissionOverwrites = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
      }
      const ch = await guild.channels.create(opts);
      created.push({ name: spec.name, id: ch.id, existed: false });
    } catch (err) {
      failed.push({ name: spec.name, error: err.message });
    }
  }
  return { created, failed };
}

module.exports = {
  MODELS,
  CHANNEL_HINTS,
  CHANNEL_PICKABLE,
  normalize,
  matchesHint,
  hintScore,
  pickTextChannels,
  pickRole,
  buildPlan,
  missingChannels,
  applyPlan,
  defaultWrite,
  createMissingChannels,
};
