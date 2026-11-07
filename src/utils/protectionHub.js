'use strict';
// utils/protectionHub.js — Centre de protection : vue unifiée de toutes les
// protections du serveur.
//
// Le bot possède huit protections indépendantes, chacune avec son panneau :
// captcha, Vigie (profil à l'arrivée), anti-raid, honeypot, auto-modération,
// anti-scam, Sentinel (anti-nuke) et surveillance de bots. Savoir « suis-je
// protégé ? » demandait jusqu'ici d'ouvrir huit commandes et de recouper les
// réglages à la main.
//
// Ce module rassemble cet état en un seul écran : pour chaque protection, son
// état réel (activée, mais aussi *utilisable*), les incohérences de
// configuration qui la rendent inopérante, et un score de couverture.
//
// Deux couches, volontairement séparées :
//   • buildState()  — pur, reçoit un instantané de configuration, ne touche à
//                     rien (testable hors-ligne, voir tests/protection-hub-smoke.js) ;
//   • collectProtectionConfig() — la seule partie qui lit la base.
//
// Les alertes ne sont pas des « conseils de plus » : chacune décrit un cas où
// une protection activée ne peut pas faire son travail (captcha sans salon,
// anti-raid en mode surveillance, Sentinel sans sanction…).

const {
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { COLORS } = require('./embeds');
const { scoreBar } = require('./securityAudit');

// ─── Familles et protections ────────────────────────────────────────────────
const FAMILIES = [
  { key: 'arrivees', label: '🚪 Arrivées' },
  { key: 'contenu',  label: '💬 Contenu' },
  { key: 'infra',    label: '🏗️ Infrastructure' },
];

// `command` = panneau de configuration à ouvrir depuis le Centre de protection.
// `critical` = sans elle, le serveur est exposé (pèse sur la note).
const SYSTEM_LIST = [
  { key: 'captcha',   family: 'arrivees', emoji: '🔒', label: 'Captcha',              command: 'captcha',           critical: true },
  { key: 'joinguard', family: 'arrivees', emoji: '🪪', label: 'Vigie (profil)',       command: 'controle-arrivee',  critical: false },
  { key: 'antiraid',  family: 'arrivees', emoji: '🚨', label: 'Anti-raid',            command: 'antiraid',          critical: true },
  { key: 'honeypot',  family: 'arrivees', emoji: '🍯', label: 'Honeypot',             command: 'honeypot',          critical: false },
  { key: 'automod',   family: 'contenu',  emoji: '🧹', label: 'Auto-modération',      command: 'securite',          critical: false },
  { key: 'antiscam',  family: 'contenu',  emoji: '🎯', label: 'Anti-scam',            command: 'antiscam',          critical: false },
  { key: 'antinuke',  family: 'infra',    emoji: '☢️', label: 'Sentinel anti-nuke',   command: 'anti-nuke',         critical: true },
  { key: 'botwatch',  family: 'infra',    emoji: '🤖', label: 'Surveillance de bots', command: 'botwatch',          critical: false },
];

// Permissions que le bot lui-même doit posséder pour appliquer les protections.
const NEEDED_PERMISSIONS = [
  ['ManageChannels',  'Gérer les salons',        'verrouiller le serveur en cas de raid'],
  ['ManageRoles',     'Gérer les rôles',         'isoler un membre suspect'],
  ['BanMembers',      'Bannir des membres',      'écarter un raider'],
  ['ModerateMembers', 'Exclure temporairement',  'mettre un spammeur en sourdine'],
];

const GRADE_SCALE = [
  { min: 90, label: 'Bien protégé',  advice: 'Toutes les protections essentielles sont en place.' },
  { min: 70, label: 'Protégé',       advice: 'Bonne couverture — quelques protections à ajouter.' },
  { min: 45, label: 'Partiel',       advice: 'Des angles morts subsistent : à combler rapidement.' },
  { min: 15, label: 'Fragile',       advice: 'Le serveur est largement ouvert.' },
  { min: 0,  label: 'Non protégé',   advice: 'Aucune barrière sérieuse : un raid passerait sans résistance.' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────
function cut(text, max = 100) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function channel(id) { return id ? `<#${id}>` : null; }

// Les descriptions de menu Discord n'interprètent pas les mentions : « <#123> »
// s'afficherait littéralement. On les remplace par un texte lisible.
function plain(text, max = 100) {
  return cut(String(text ?? '')
    .replace(/<#[^>]+>/g, 'un salon')
    .replace(/<@&[^>]+>/g, 'un rôle')
    .replace(/\*\*/g, ''), max);
}

// Nombre de filtres réellement actifs dans l'auto-modération (panneau /securite).
function automodFilters(automod, advanced) {
  const list = [];
  if (automod?.spamEnabled)  list.push('spam');
  if (automod?.raidEnabled)  list.push('raid');
  if (automod?.linksEnabled) list.push('liens');
  if (automod?.capsEnabled)  list.push('majuscules');
  if (advanced?.antiSpam?.enabled)        list.push('spam avancé');
  if (advanced?.antiMassMention?.enabled) list.push('mentions massives');
  const words = advanced?.wordFilter;
  if (words && ((words.low?.length || 0) + (words.medium?.length || 0) + (words.high?.length || 0)) > 0) {
    list.push('mots interdits');
  }
  return list;
}

// ─── État (pur) ─────────────────────────────────────────────────────────────
/**
 * Construit l'état complet du Centre de protection.
 * @param {object} configs — instantané : { antiraid, antinuke, joinguard, captcha,
 *   automod, advanced, honeypot, antiscam, watchedBots }
 * @param {object|null} guild — serveur Discord (facultatif : permissions, niveau de vérification)
 */
function buildState(configs = {}, guild = null) {
  const c = configs || {};
  const systems = [];
  const add = (key, enabled, detail, warnings = []) => {
    const def = SYSTEM_LIST.find(s => s.key === key);
    systems.push({
      ...def,
      enabled: Boolean(enabled),
      detail,
      warnings: warnings.filter(Boolean),
    });
  };

  // ── Captcha ──────────────────────────────────────────────────────────────
  {
    const cfg = c.captcha || {};
    const warnings = [];
    if (cfg.enabled && !cfg.channelId) warnings.push('Captcha activé sans salon de vérification : personne ne peut le résoudre.');
    if (cfg.enabled && !cfg.roleAfter) warnings.push('Captcha activé sans rôle « vérifié » : réussir le captcha ne débloque aucun accès.');
    add('captcha', cfg.enabled,
      cfg.enabled
        ? `salon ${channel(cfg.channelId) || 'manquant'} · ${cfg.codeLength || 6} caractères · ${cfg.attempts || 3} essais`
        : 'aucune vérification humaine à l\'arrivée',
      warnings);
  }

  // ── Vigie (profil à l'arrivée) ───────────────────────────────────────────
  {
    const cfg = c.joinguard || {};
    const warnings = [];
    const blocksRole = cfg.actionBlock === 'quarantine' || cfg.actionReview === 'quarantine';
    if (cfg.enabled && blocksRole && !cfg.quarantineRoleId) {
      warnings.push('Vigie met des membres en attente sans rôle d\'attente : ils gardent tous leurs accès.');
    }
    if (cfg.enabled && !cfg.reviewChannelId && !cfg.logChannelId) {
      warnings.push('Vigie n\'a aucun salon de rapport : ses décisions passent inaperçues.');
    }
    const jail = (cfg.jail || []).length;
    add('joinguard', cfg.enabled,
      cfg.enabled
        ? `blocage ≥ ${cfg.blockScore ?? 40} · compte min. ${cfg.minAccountAgeDays ?? 7} j · réponse « ${cfg.actionBlock || 'kick'} »${jail ? ` · ${jail} en salle d'attente` : ''}`
        : 'les profils ne sont pas analysés à l\'arrivée',
      warnings);
  }

  // ── Anti-raid ────────────────────────────────────────────────────────────
  {
    const cfg = c.antiraid || {};
    const warnings = [];
    if (cfg.enabled && cfg.mode === 'monitor') warnings.push('Anti-raid en mode **surveillance** : il détecte mais n\'agit jamais.');
    if (cfg.enabled && cfg.detectionEnabled === false) warnings.push('Anti-raid activé mais détection désactivée : il ne verra aucun raid.');
    add('antiraid', cfg.enabled,
      cfg.enabled
        ? `mode ${cfg.mode || 'normal'} · ${cfg.joinsThreshold ?? 10} arrivées / ${cfg.joinsWindowSec ?? 30} s`
        : 'aucune détection d\'arrivées massives',
      warnings);
  }

  // ── Honeypot ─────────────────────────────────────────────────────────────
  {
    const cfg = c.honeypot || {};
    const channels = cfg.channelIds || [];
    const warnings = [];
    if (cfg.enabled && channels.length === 0) warnings.push('Honeypot activé sans salon piège : il n\'attrapera personne.');
    add('honeypot', cfg.enabled,
      cfg.enabled
        ? `${channels.length} salon(s) piège · sanction « ${cfg.action || 'mute'} »`
        : 'aucun salon piège',
      warnings);
  }

  // ── Auto-modération ──────────────────────────────────────────────────────
  {
    const cfg = c.automod || {};
    const filters = automodFilters(cfg, c.advanced || {});
    const warnings = [];
    if (filters.length && !cfg.logChannelId && !c.advanced?.logChannelId) {
      warnings.push('Auto-modération sans salon de journalisation : les sanctions ne laissent aucune trace.');
    }
    add('automod', filters.length > 0,
      filters.length ? filters.join(' · ') : 'aucun filtre de message actif',
      warnings);
  }

  // ── Anti-scam ────────────────────────────────────────────────────────────
  {
    const cfg = c.antiscam || {};
    const warnings = [];
    if (cfg.enabled && cfg.action === 'none') warnings.push('Anti-scam en observation seule : il signale mais ne sanctionne pas.');
    if (cfg.enabled && !cfg.logChannelId) warnings.push('Anti-scam sans salon d\'alerte : les détections ne préviennent personne.');
    add('antiscam', cfg.enabled,
      cfg.enabled
        ? `seuil ${cfg.threshold ?? 60}/100 · ${cfg.totalDetected || 0} détection(s)`
        : 'les images et messages ne sont pas analysés',
      warnings);
  }

  // ── Sentinel (anti-nuke) ─────────────────────────────────────────────────
  {
    const cfg = c.antinuke || {};
    const warnings = [];
    if (cfg.enabled && cfg.punishment === 'none') warnings.push('Sentinel journalise les nukes mais ne sanctionne pas l\'auteur.');
    if (cfg.enabled && !cfg.logChannelId) warnings.push('Sentinel sans salon d\'alerte : une attaque passerait inaperçue.');
    add('antinuke', cfg.enabled,
      cfg.enabled
        ? `niveau ${cfg.level || 'normal'} · sanction « ${cfg.punishment || 'quarantine'} » · ${cfg.stats?.prevented || 0} nuke(s) bloquée(s)`
        : 'aucune surveillance des actions destructrices',
      warnings);
  }

  // ── Surveillance de bots ─────────────────────────────────────────────────
  {
    const count = Number(c.watchedBots || 0);
    add('botwatch', count > 0,
      count > 0 ? `${count} bot(s) surveillé(s) (statut + maintenance)` : 'aucun bot surveillé',
      []);
  }

  // ── Hygiène du serveur (ne compte pas dans la couverture) ────────────────
  const hygiene = [];
  const anyEnabled = systems.some(s => s.enabled);

  if (!anyEnabled) {
    hygiene.push('**Aucune protection active** : le serveur accepterait un raid sans réagir.');
  }

  if (guild) {
    const me = guild.members?.me;
    if (me?.permissions?.has && anyEnabled) {
      const missing = NEEDED_PERMISSIONS.filter(([flag]) => {
        try { return !me.permissions.has(flag); } catch { return false; }
      });
      if (missing.length) {
        hygiene.push(`Le bot n'a pas ${missing.map(([, label]) => `**${label}**`).join(', ')} : il ne pourra pas ${missing.map(([, , why]) => why).join(' ni ')}.`);
      }
    }
    if (typeof guild.verificationLevel === 'number' && guild.verificationLevel < 2) {
      hygiene.push('Niveau de vérification du serveur sous **Moyen** : Discord laisse entrer les comptes les plus neufs sans filtre.');
    }
  }

  // ── Score & alertes ──────────────────────────────────────────────────────
  const enabledList = systems.filter(s => s.enabled);
  const score = Math.round((enabledList.length / systems.length) * 100);
  const grade = GRADE_SCALE.find(g => score >= g.min) || GRADE_SCALE[GRADE_SCALE.length - 1];
  const systemAlerts = systems.flatMap(s => s.warnings.map(w => `${s.emoji} ${w}`));

  const antiraid = c.antiraid || {};
  const antinuke = c.antinuke || {};

  return {
    systems,
    families: FAMILIES,
    enabled: enabledList.length,
    total: systems.length,
    score,
    grade: grade.label,
    advice: grade.advice,
    alerts: [...systemAlerts, ...hygiene],
    criticalDown: systems.filter(s => s.critical && !s.enabled).map(s => s.label),
    raid: {
      active: Boolean(antiraid.raidActive),
      lockdown: Boolean(antiraid.lockdownActive),
      panic: Boolean(antinuke.panicActive),
      quarantined: (antiraid.quarantined || []).length,
    },
  };
}

function systemByKey(key) {
  return SYSTEM_LIST.find(s => s.key === key) || null;
}

// ─── Collecte (seule partie qui lit la base) ────────────────────────────────
async function collectProtectionConfig(guildId) {
  const safe = p => Promise.resolve(p).catch(() => null);
  const AntiNuke = require('../models/AntiNuke');
  const { AntiRaid } = require('../models/AntiRaid');
  const JoinGuard = require('../models/JoinGuard');
  const { CaptchaConfig } = require('../models/Captcha');
  const AutoMod = require('../models/AutoMod');
  const AutoModAdvanced = require('../models/AutoModAdvanced');
  const Honeypot = require('../models/Honeypot');
  const AntiScamConfig = require('../models/AntiScamConfig');
  const WatchedBot = require('../models/WatchedBot');

  const [antiraid, antinuke, joinguard, captcha, automod, advanced, honeypot, antiscam, watchedBots] = await Promise.all([
    safe(AntiRaid.findOne({ guildId }).lean()),
    safe(AntiNuke.findOne({ guildId }).lean()),
    safe(JoinGuard.findOne({ guildId }).lean()),
    safe(CaptchaConfig.findOne({ guildId }).lean()),
    safe(AutoMod.findOne({ guildId }).lean()),
    safe(AutoModAdvanced.findOne({ guildId }).lean()),
    safe(Honeypot.findOne({ guildId }).lean()),
    safe(AntiScamConfig.findOne({ guildId }).lean()),
    safe(WatchedBot.countDocuments({ guildId })),
  ]);

  return {
    antiraid, antinuke, joinguard, captcha, automod, advanced, honeypot, antiscam,
    watchedBots: watchedBots || 0,
  };
}

// ─── Rendu ─────────────────────────────────────────────────────────────────
function buildEmbed(state, guild = null) {
  const color = state.raid.active || state.raid.panic
    ? COLORS.error
    : state.score >= 70 ? COLORS.success : state.score >= 45 ? COLORS.warning : COLORS.error;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🛡️ Centre de protection')
    .setDescription(
      `\`${scoreBar(state.score)}\` **${state.score}/100** — ${state.grade}\n` +
      `> ${state.advice}\n` +
      `> **${state.enabled}/${state.total}** protections actives` +
      (state.alerts.length ? ` · **${state.alerts.length}** point(s) à corriger` : ' · aucun défaut détecté'),
    );

  if (guild?.iconURL) {
    const icon = guild.iconURL({ dynamic: true });
    if (icon) embed.setThumbnail(icon);
  }

  if (state.raid.active || state.raid.lockdown || state.raid.panic) {
    const flags = [
      state.raid.active ? '🚨 **RAID EN COURS**' : null,
      state.raid.lockdown ? '🔒 serveur verrouillé' : null,
      state.raid.panic ? '🚨 mode panique' : null,
    ].filter(Boolean);
    embed.addFields({
      name: '⚠️ État d\'urgence',
      value: `${flags.join(' · ')}${state.raid.quarantined ? `\n🚪 ${state.raid.quarantined} membre(s) en quarantaine` : ''}`,
      inline: false,
    });
  }

  for (const family of FAMILIES) {
    const rows = state.systems
      .filter(s => s.family === family.key)
      .map(s => `${s.enabled ? '🟢' : '🔴'} ${s.emoji} **${s.label}** — ${s.detail}`);
    embed.addFields({ name: family.label, value: cut(rows.join('\n'), 1024), inline: false });
  }

  embed.addFields({
    name: state.alerts.length ? '⚠️ À corriger' : '✅ Rien à signaler',
    value: state.alerts.length
      ? cut(state.alerts.slice(0, 6).map(a => `• ${a}`).join('\n'), 1024)
      : 'Chaque protection activée est réellement opérationnelle.',
    inline: false,
  });

  return embed.setFooter({ text: 'REZO • Centre de protection — clique une protection pour la régler' }).setTimestamp();
}

function buildComponents(state) {
  const systemRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('panel_protection_system')
      .setPlaceholder('🛡️ Régler une protection…')
      .addOptions(state.systems.map(s => ({
        label: cut(`${s.enabled ? '🟢' : '🔴'} ${s.label}`, 100),
        value: s.key,
        description: plain(s.detail, 100),
      }))),
  );

  const actions = [
    new ButtonBuilder().setCustomId('panel_protection_refresh').setLabel('Rafraîchir').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_protection_audit').setLabel('Audit complet').setEmoji('🔍').setStyle(ButtonStyle.Primary),
  ];
  if (state.raid.lockdown || state.raid.panic) {
    actions.unshift(new ButtonBuilder().setCustomId('panel_protection_unlock').setLabel('Déverrouiller').setEmoji('🔓').setStyle(ButtonStyle.Success));
  }
  if (state.raid.active) {
    actions.unshift(new ButtonBuilder().setCustomId('panel_protection_endraid').setLabel('Fin de raid').setEmoji('⏹️').setStyle(ButtonStyle.Danger));
  }

  const actionRow = new ActionRowBuilder().addComponents(...actions.slice(0, 5));
  const homeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel_home').setLabel('Accueil du panel').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  );

  return [systemRow, actionRow, homeRow];
}

module.exports = {
  FAMILIES,
  SYSTEM_LIST,
  NEEDED_PERMISSIONS,
  GRADE_SCALE,
  cut,
  plain,
  automodFilters,
  buildState,
  systemByKey,
  collectProtectionConfig,
  buildEmbed,
  buildComponents,
};
