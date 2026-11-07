'use strict';
// utils/panelV3.js — Socle du panel v3.
//
// Le panel précédent classait le bot en 4 catégories fourre-tout. La v3 le
// range en 9 domaines, chacun avec ses modules réels, son **état live** et ses
// **valeurs actuelles** : un administrateur voit ce qui est actif, ce qui
// manque, et ouvre le vrai panneau du module sans taper une commande.
//
// Ce fichier est volontairement séparé de la commande : toute la logique de
// lecture (modèles → état) et de rendu (état → embeds/composants) est pure ou
// facilement injectable, donc testable sans Discord ni MongoDB.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { COLORS } = require('./embeds');
const ui = require('./ui');

const MAX_OPTIONS = 25;

// ─── Domaines et modules ────────────────────────────────────────────────────
// `direct: true`  → la commande ouvre son propre panneau sans option requise.
// `guide`         → commande à plusieurs sous-commandes : on indique le chemin.
// `special: ...`  → module géré par le panel lui-même (centre de protection).
const SECTIONS = [
  {
    id: 'protection',
    emoji: '🛡️',
    label: 'Protection',
    tagline: 'Arrivées massives, contenu, infrastructure : les 8 protections du serveur.',
    modules: [
      { value: 'protection', label: '🛡️ Centre de protection', description: 'Vue d’ensemble + actions d’urgence', special: 'protection' },
      { value: 'discon', label: '🚨 DISCON', description: 'Niveau de danger : cinq crans, un seul geste', direct: true },
      { value: 'securite', label: '🛡️ Sécurité générale', description: 'Captcha rapide, anti-spam, anti-raid', direct: true },
      { value: 'captcha', label: '🔒 Captcha avancé', description: 'Réglages fins de la vérification', direct: true },
      { value: 'anti-vpn', label: '🛰️ Anti-VPN', description: 'Refuser VPN, proxy et Tor', direct: true, command: 'antivpn' },
      { value: 'honeypot', label: '🍯 Honeypot', description: 'Salon piège anti-bot', direct: true },
      { value: 'antiscam', label: '🚨 Anti-Scam', description: 'Alertes scams et scan d’images', direct: true },
      { value: 'controle-arrivee', label: '🪪 Vigie', description: 'Contrôle du profil des arrivées', direct: true },
      { value: 'anti-nuke', label: '☢️ Sentinel anti-nuke', description: 'Destructions massives et webhooks', direct: true },
      { value: 'antiraid', label: '🚨 Anti-raid', description: 'Raids, quarantaine, fin de raid', direct: true },
      { value: 'audit-securite', label: '🔍 Audit de sécurité', description: 'Score serveur et correctifs', direct: true },
    ],
  },
  {
    id: 'moderation',
    emoji: '⚔️',
    label: 'Modération',
    tagline: 'Sanctions, paliers automatiques, filtres et journal de modération.',
    modules: [
      { value: 'warn', label: '⚠️ Avertissements', description: 'Avertissements, paliers et outils de modération', command: 'mod', guide: '`/mod avertir user:<membre> reason:<texte>` puis `/mod paliers ajouter`' },
      { value: 'modlog', label: '📜 Journal de modération', description: 'Salon et événements loggés', guide: '`/modlog salon salon:#logs`' },
      { value: 'securite', label: '🛡️ Sécurité & sanctions', description: 'Auto-modération, spam, liens, majuscules', direct: true },
      { value: 'signalement', label: '🚩 Signalements', description: 'File de signalements du staff', direct: true },
      { value: 'scam', label: '🎣 Anti-scam manuel', description: 'Vérifier un message ou un lien', direct: true },
      { value: 'kick', label: '👋 Expulsion', description: 'Expulser un membre', guide: '`/mod kick utilisateur raison`' },
    ],
  },
  {
    id: 'tickets',
    emoji: '🎫',
    label: 'Tickets',
    tagline: 'Catégories, panels, rôle staff, journal et transcriptions.',
    modules: [
      { value: 'ticket', label: '🎫 Panels & catégories', description: 'Tout le système de tickets', direct: true },
    ],
  },
  {
    id: 'mp',
    emoji: '📨',
    label: 'MP au bot',
    tagline: 'Le serveur reçoit les messages privés, le staff répond depuis un salon.',
    modules: [
      { value: 'modmail', label: '📬 Modmail', description: 'Boîte de réception du staff', guide: '`/modmail config`' },
      { value: 'demande-mp', label: '💬 Demandes de MP', description: 'Salon qui transforme chaque message en fil', guide: '`/demande-mp config`' },
    ],
  },
  {
    id: 'vocaux',
    emoji: '🔊',
    label: 'Vocaux',
    tagline: 'File d’attente, salons temporaires, radio et musique.',
    modules: [
      { value: 'waitingroom', label: '🎧 Salon d’attente', description: 'File vocale + salons temporaires', direct: true },
      { value: 'radio', label: '📻 Radio', description: 'Stations en direct dans un vocal', direct: true },
      { value: 'musique', label: '🎵 Musique', description: 'Lecture, file et panneau musical', direct: true },
    ],
  },
  {
    id: 'roles',
    emoji: '🎭',
    label: 'Rôles',
    tagline: 'Rôles automatiques, récompenses de niveau et portail d’accès.',
    modules: [
      { value: 'autorole', label: '🎭 Rôles automatiques', description: 'Arrivée, niveau, temps, bumps', guide: '`/autorole`' },
      { value: 'rolemenu', label: '🎛️ Menus de rôles', description: 'Panneau unique : titre, image, pied de page et aperçu en direct', guide: '`/rolemenu editeur`' },
      { value: 'leveling', label: '🏆 Niveaux & récompenses', description: 'XP et rôles de palier', direct: true },
      { value: 'onboarding', label: '🚪 Portail d’accès', description: 'Questions avant l’accès au serveur', direct: true },
    ],
  },
  {
    id: 'logs',
    emoji: '📋',
    label: 'Journaux & stats',
    tagline: 'Ce qui se passe sur le serveur, salons par salons.',
    modules: [
      { value: 'modlog', label: '📜 Journal de modération', description: 'Salon et événements', guide: '`/modlog salon salon:#logs`' },
      { value: 'notifications', label: '🔔 Notifications', description: 'Salons de notifications', guide: '`/notifications config`' },
      { value: 'stats', label: '📊 Statistiques', description: 'Bumps serveur et réseau', guide: '`/stats serveur`' },
      { value: 'recap', label: '📈 Récap hebdomadaire', description: 'Résumé d’activité du serveur', direct: true },
      { value: 'botwatch', label: '🤖 Surveillance de bots', description: 'Alerte quand un bot tombe', direct: true },
      { value: 'leaderboardconfig', label: '🏅 Classements', description: 'Type de classement par défaut', guide: '`/leaderboardconfig`' },
    ],
  },
  {
    id: 'animation',
    emoji: '🎉',
    label: 'Animation',
    tagline: 'Arrivées, départs, boosts, giveaways, avis et événements.',
    modules: [
      { value: 'welcome', label: '👋 Bienvenue', description: 'Message, image, MP et boutons', guide: '`/welcome panel`' },
      { value: 'farewell-set', label: '🚪 Au revoir', description: 'Message et carte de départ', guide: '`/farewell-set panel`' },
      { value: 'boost', label: '💎 Boosts', description: 'Message automatique de boost', direct: true },
      { value: 'anniversaire-config', label: '🎂 Anniversaires', description: 'Annonces et rôle du jour', direct: true },
      { value: 'starboard', label: '⭐ Starboard', description: 'Meilleurs messages du serveur', direct: true },
      // `/avis` exige une sous-commande : `direct` lancerait `noter`. On pointe
      // donc explicitement sur le panel staff (ex-`/avis-panel`).
      { value: 'avis', label: '⭐ Avis & suggestions', description: 'Votes et file de modération', guide: '`/avis panel`' },
      { value: 'giveaway', label: '🎁 Giveaways', description: 'Tirages au sort', guide: '`/giveaway créer`' },
      { value: 'confession', label: '🕯️ Confessions', description: 'Messages anonymes', guide: '`/confession`' },
      { value: 'freegames', label: '🆓 Jeux gratuits', description: 'Annonces de jeux offerts', guide: '`/freegames`' },
      { value: 'tresor', label: '🎁 Trésors', description: 'Coffre à deviner', direct: true },
    ],
  },
  {
    id: 'tools',
    emoji: '🧰',
    label: 'Outils',
    tagline: 'Le reste du bot : préfixe, embeds, sauvegardes, identité, sites.',
    modules: [
      { value: 'starterpack', label: '🚀 Starter Pack', description: 'Structure et panneaux essentiels en un clic', direct: true },
      { value: 'autopilote', label: '🤖 Autopilote', description: 'Score du serveur et configuration auto', direct: true },
      { value: 'shop', label: '🛒 Boutique', description: 'Articles, prix et stock du serveur', direct: true },
      // `/config` a été retiré : ses onze champs sont édités sur place par
      // l'éditeur de champs (`panelConfig`), directement dans le panel.
      { value: 'config', label: '🚀 Config bump', description: 'Description, invitations, salons — modifiable ici', guide: 'Chaque champ (description, invitation, tags, salons) s’édite sur place : `/setting` → Config bump' },
      { value: 'pont', label: '🌐 Pont inter-serveurs', description: 'Chat partagé entre serveurs', direct: true },
      { value: 'prefix', label: '⌨️ Préfixe', description: 'Commandes texte du serveur', guide: '`/prefix config`' },
      { value: 'embed', label: '🧩 Éditeur d’embed', description: 'Composer et publier un embed', direct: true },
      { value: 'custom', label: '🛠️ Commandes personnalisées', description: 'Réponses et commandes du serveur', direct: true },
      { value: 'backup', label: '💾 Sauvegardes', description: 'Sauvegarder et restaurer le serveur', guide: '`/backup creer`' },
      { value: 'branding', label: '🎨 Identité visuelle', description: 'Nom, avatar, couleur du bot', direct: true },
      { value: 'statut', label: '🛰️ Statut du bot', description: 'Surnom, état et carte, par serveur', guide: 'Réglages sur place : `/setting` → Outils → Statut du bot' },
      { value: 'statut-site', label: '🌐 Surveillance de sites', description: 'Disponibilité et pannes', direct: true },
      { value: 'autothread', label: '🧵 Auto-thread', description: 'Threads automatiques', guide: '`/autothread status`' },
      { value: 'forumwelcome', label: '🗂️ Accueil forums', description: 'Message d’accueil des posts', guide: '`/forumwelcome panel`' },
      { value: 'license', label: '🔐 Licence', description: 'Clé et essai gratuit', direct: true },
    ],
  },
];

// Anciens identifiants de catégories (panel v2) → domaines v3.
const SECTION_ALIASES = {
  securite: 'protection',
  general: 'tools',
  communaute: 'animation',
  support: 'mp',
};

const SECTION_BY_ID = new Map(SECTIONS.map(section => [section.id, section]));

function sectionById(id) {
  const key = SECTION_ALIASES[id] || id;
  return SECTION_BY_ID.get(key) || null;
}

function moduleByValue(value, sectionId = null) {
  const sections = sectionId ? [sectionById(sectionId)].filter(Boolean) : SECTIONS;
  for (const section of sections) {
    const found = section.modules.find(module => module.value === value);
    if (found) return { ...found, sectionId: section.id };
  }
  return null;
}

function moduleValues() {
  return new Set(SECTIONS.flatMap(section => section.modules.map(module => module.value)));
}

// ─── Index inverse : commande → module ──────────────────────────────────────
// Sert à la console : chaque commande du bot reçoit l'état de son module quand
// elle en a un, et reste lançable même quand elle n'en a pas (une commande
// arrivée après ce fichier n'est jamais orpheline).
const COMMAND_TO_MODULE = (() => {
  const map = new Map();
  for (const section of SECTIONS) {
    for (const module of section.modules) {
      const target = module.direct ? (module.command || module.value) : null;
      if (target && !map.has(target)) map.set(target, module.value);
      for (const cited of guideCommands(module)) {
        if (!map.has(cited)) map.set(cited, module.value);
      }
    }
  }
  return map;
})();

/** Commandes citées dans l'aide d'un module guidé (`/warn config` → warn). */
function guideCommands(module) {
  if (!module?.guide) return [];
  return [...String(module.guide).matchAll(/\/([a-z][a-z0-9-]{1,31})/g)].map(match => match[1]);
}

function moduleForCommand(commandName) {
  const value = COMMAND_TO_MODULE.get(commandName);
  return value ? moduleByValue(value) : null;
}

// ─── Accès aux données ──────────────────────────────────────────────────────

function safe(promise, fallback = null) {
  return Promise.resolve(promise).catch(() => fallback);
}

/** Course contre le temps : une base lente ne bloque jamais le panel. */
function withTimeout(promise, ms, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function findOne(Model, filter) {
  try {
    if (!Model || typeof Model.findOne !== 'function') return null;
    const query = Model.findOne(filter);
    return safe(typeof query.lean === 'function' ? query.lean() : query);
  } catch {
    return null;
  }
}

async function findMany(Model, filter, limit = 50) {
  try {
    if (!Model || typeof Model.find !== 'function') return [];
    let query = Model.find(filter);
    if (typeof query.limit === 'function') query = query.limit(limit);
    const rows = await safe(typeof query.lean === 'function' ? query.lean() : query, []);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function count(Model, filter) {
  try {
    if (!Model || typeof Model.countDocuments !== 'function') return 0;
    return Number(await safe(Model.countDocuments(filter), 0)) || 0;
  } catch {
    return 0;
  }
}

/**
 * Lit toutes les configurations en une passe parallèle.
 * Chaque requête est isolée : une collection absente ou une base lente donne
 * simplement `null`, jamais un panel vide ou une erreur.
 */
async function fetchConfigs(guildId, { timeout = 4000 } = {}) {
  const models = {
    Server: require('../models/Server'),
    Welcome: require('../models/Welcome'),
    BoostConfig: require('../models/BoostConfig'),
    Starboard: require('../models/Starboard'),
    WarnThresholds: require('../models/WarnThresholds'),
    GuildLogs: require('../models/GuildLogs'),
    TicketPanel: require('../models/TicketPanel'),
    Ticket: require('../models/Ticket'),
    ModMail: require('../models/ModMail'),
    MpRequestConfig: require('../models/MpRequestConfig'),
    WaitingRoom: require('../models/WaitingRoom'),
    AutoRole: require('../models/AutoRole'),
    BirthdayConfig: require('../models/BirthdayConfig'),
    PrefixConfig: require('../models/PrefixConfig'),
    OnboardingConfig: require('../models/OnboardingConfig'),
    Reglement: require('../models/Reglement'),
    CustomCommand: require('../models/CustomCommand'),
    AutoMod: require('../models/AutoMod'),
    Giveaway: require('../models/Giveaway'),
    WatchedBot: require('../models/WatchedBot'),
    XPConfig: require('../models/XPConfig'),
  };

  const configs = await Promise.race([
    (async () => {
      const [
        server, welcome, farewell, boost, starboard, warnThresholds, logs,
        ticketPanels, openTickets, modmail, openModmail, mpRequest, waitingRoom,
        autoRoles, birthday, prefix, onboarding, reglement, customCommands,
        automod, giveaways, watchedBots, xpConfig,
      ] = await Promise.all([
        findOne(models.Server, { guildId }),
        findOne(models.Welcome.Welcome, { guildId }),
        findOne(models.Welcome.Farewell, { guildId }),
        findOne(models.BoostConfig, { guildId }),
        findOne(models.Starboard, { guildId }),
        findOne(models.WarnThresholds, { guildId }),
        findOne(models.GuildLogs, { guildId }),
        findMany(models.TicketPanel, { guildId }),
        count(models.Ticket, { guildId, status: 'open' }),
        findOne(models.ModMail.ModMailConfig, { guildId }),
        count(models.ModMail.ModMailThread, { guildId, status: 'open' }),
        findOne(models.MpRequestConfig, { guildId }),
        findOne(models.WaitingRoom, { guildId }),
        findMany(models.AutoRole, { guildId }),
        findOne(models.BirthdayConfig, { guildId }),
        findOne(models.PrefixConfig, { guildId }),
        findOne(models.OnboardingConfig, { guildId }),
        findOne(models.Reglement, { guildId }),
        count(models.CustomCommand, { guildId }),
        findOne(models.AutoMod, { guildId }),
        count(models.Giveaway, { guildId, ended: false }),
        findMany(models.WatchedBot, { guildId }),
        findOne(models.XPConfig, { guildId }),
      ]);

      return {
        server, welcome, farewell, boost, starboard, warnThresholds, logs,
        ticketPanels: ticketPanels || [], openTickets, modmail, openModmail,
        mpRequest, waitingRoom, autoRoles: autoRoles || [], birthday, prefix,
        onboarding, reglement, customCommands, automod,
        giveaways, watchedBots: watchedBots || [], xpConfig,
      };
    })(),
    new Promise(resolve => setTimeout(() => resolve(null), timeout)),
  ]);

  return configs || emptyConfigs();
}

function emptyConfigs() {
  return {
    server: null, welcome: null, farewell: null, boost: null, starboard: null,
    warnThresholds: null, logs: null, ticketPanels: [], openTickets: 0,
    modmail: null, openModmail: 0, mpRequest: null, waitingRoom: null,
    autoRoles: [], birthday: null, prefix: null, onboarding: null,
    reglement: null, customCommands: 0, automod: null, giveaways: 0,
    watchedBots: [], xpConfig: null,
  };
}

// ─── Lecture de l'état ──────────────────────────────────────────────────────

function hasChannelCache(guild) {
  const cache = guild?.channels?.cache;
  return Boolean(cache) && typeof cache.size === 'number' && cache.size > 0 && typeof cache.has === 'function';
}

function hasRoleCache(guild) {
  const cache = guild?.roles?.cache;
  return Boolean(cache) && typeof cache.size === 'number' && cache.size > 0 && typeof cache.has === 'function';
}

function channelMissing(guild, id) {
  return Boolean(id) && hasChannelCache(guild) && !guild.channels.cache.has(id);
}

function roleMissing(guild, id) {
  return Boolean(id) && hasRoleCache(guild) && !guild.roles.cache.has(id);
}

function channelLabel(guild, id, fallback = 'non configuré') {
  if (!id) return fallback;
  return channelMissing(guild, id) ? `<#${id}> *(supprimé)*` : `<#${id}>`;
}

function roleLabel(guild, id, fallback = 'non configuré') {
  if (!id) return fallback;
  return roleMissing(guild, id) ? `<@&${id}> *(supprimé)*` : `<@&${id}>`;
}

function issue(level, text, fix) {
  return { level, text, fix };
}

function sectionState({ active = 0, total = 1, lines = [], issues = [], forceOff = false } = {}) {
  const errors = issues.filter(i => i.level === 'error').length;
  let level = 'ok';
  if (forceOff || active === 0) level = 'off';
  else if (errors || issues.length) level = 'partial';
  return { active, total, level, lines, issues, errors };
}

function protectionStatus(protection, guild) {
  const state = protection || { enabled: 0, total: 8, score: 0, grade: 'Non protégé', alerts: [], raid: {} };
  const issues = [];
  if (state.raid?.active) {
    issues.push(issue('error', 'Un raid est en cours : termine-le depuis le Centre de protection.', 'protection'));
  }
  for (const alert of state.alerts || []) issues.push(issue('warn', alert, 'protection'));

  const lines = [
    `${state.enabled}/${state.total} protections actives`,
    `Score **${state.score}/100** — ${state.grade}`,
    state.raid?.lockdown ? '🔒 Serveur verrouillé' : state.raid?.panic ? '🚨 Mode panique actif' : null,
  ].filter(Boolean);

  return sectionState({
    active: state.enabled, total: state.total, lines, issues,
    forceOff: state.enabled === 0,
  });
}

function moderationStatus(configs, guild) {
  const thresholds = configs.warnThresholds?.thresholds || [];
  const automod = configs.automod || {};
  const filters = [automod.spamEnabled, automod.linksEnabled, automod.capsEnabled, automod.raidEnabled]
    .filter(Boolean).length;
  const logChannel = configs.logs?.moderation?.channelId || configs.server?.logChannelId || null;
  const logOn = Boolean(configs.logs?.moderation?.enabled && logChannel) || Boolean(configs.server?.logChannelId);

  const issues = [];
  if (!thresholds.length) {
    issues.push(issue('warn', 'Aucun palier d’avertissement : les warns ne déclenchent rien automatiquement.', 'warn'));
  }
  if (!filters) {
    issues.push(issue('warn', 'Auto-modération inactive : spam, liens et majuscules ne sont pas filtrés.', 'securite'));
  }
  if (!logOn) {
    issues.push(issue('warn', 'Aucun journal de modération : les sanctions ne laissent pas de trace.', 'modlog'));
  }
  if (channelMissing(guild, logChannel)) {
    issues.push(issue('error', 'Le salon de journal de modération n’existe plus.', 'modlog'));
  }

  const active = [thresholds.length > 0, filters > 0, logOn].filter(Boolean).length;
  return sectionState({
    active, total: 3, issues,
    lines: [
      `Paliers : **${thresholds.length}**`,
      `AutoMod : **${filters}/4** filtres`,
      `Journal : ${logOn ? channelLabel(guild, logChannel) : 'non configuré'}`,
    ],
  });
}

function ticketsStatus(configs, guild) {
  const panels = configs.ticketPanels || [];
  const open = Number(configs.openTickets) || 0;
  const transcripts = panels.filter(panel => panel.transcriptChannelId).length;
  const issues = [];

  if (!panels.length) {
    issues.push(issue('error', 'Aucun panel de tickets : les membres ne peuvent pas ouvrir de ticket.', 'ticket'));
  }
  if (panels.length && !transcripts) {
    issues.push(issue('warn', 'Aucune transcription configurée : les tickets fermés ne sont pas archivés.', 'ticket'));
  }
  for (const panel of panels) {
    if (channelMissing(guild, panel.channelId)) {
      issues.push(issue('error', `Le salon du panel « ${panel.name || panel.panelKey} » n’existe plus.`, 'ticket'));
      break;
    }
  }

  return sectionState({
    active: panels.length ? 1 : 0,
    total: 1,
    issues,
    lines: [
      `Panels : **${panels.length}**`,
      `Tickets ouverts : **${open}**`,
      `Transcriptions : **${transcripts}/${panels.length}**`,
    ],
  });
}

function mpStatus(configs, guild) {
  const modmail = configs.modmail || null;
  const request = configs.mpRequest || null;
  const issues = [];

  if (modmail?.enabled && !modmail.categoryId && !modmail.logChannelId) {
    issues.push(issue('error', 'Modmail activé sans catégorie ni salon de réception.', 'modmail'));
  }
  if (modmail?.enabled && channelMissing(guild, modmail.categoryId) && configs.modmail?.categoryId) {
    issues.push(issue('error', 'La catégorie du modmail n’existe plus.', 'modmail'));
  }
  if (request?.enabled && !request.channelId) {
    issues.push(issue('error', 'Demandes de MP activées sans salon d’écoute.', 'demande-mp'));
  }
  if (request?.enabled && channelMissing(guild, request.channelId)) {
    issues.push(issue('error', 'Le salon des demandes de MP n’existe plus.', 'demande-mp'));
  }
  if (!modmail?.enabled && !request?.enabled) {
    issues.push(issue('warn', 'Aucun canal de messages privés : les membres ne peuvent pas écrire au staff.', 'modmail'));
  }

  const active = [Boolean(modmail?.enabled), Boolean(request?.enabled)].filter(Boolean).length;
  return sectionState({
    active, total: 2, issues,
    lines: [
      `Modmail : ${modmail?.enabled ? `🟢 ${channelLabel(guild, modmail.categoryId, 'catégorie non définie')}` : '🔴 désactivé'}`,
      `Demandes de MP : ${request?.enabled ? `🟢 ${channelLabel(guild, request.channelId)}` : '🔴 désactivé'}`,
      `Conversations ouvertes : **${Number(configs.openModmail) || 0}**`,
    ],
  });
}

function voiceStatus(configs, guild) {
  const room = configs.waitingRoom || null;
  const issues = [];
  if (room?.enabled && !room.voiceChannelId) {
    issues.push(issue('error', 'Salon d’attente activé sans salon vocal surveillé.', 'waitingroom'));
  }
  if (room?.enabled && channelMissing(guild, room.voiceChannelId)) {
    issues.push(issue('error', 'Le salon vocal d’attente n’existe plus.', 'waitingroom'));
  }
  if (room?.enabled && !room.staffRoleId) {
    issues.push(issue('warn', 'Aucun rôle staff défini : personne n’est notifié des arrivées en attente.', 'waitingroom'));
  }
  if (room?.enabled && roleMissing(guild, room.staffRoleId) && room.staffRoleId) {
    issues.push(issue('error', 'Le rôle staff du salon d’attente n’existe plus.', 'waitingroom'));
  }
  if (room && !room.enabled) {
    issues.push(issue('warn', 'Le salon d’attente est désactivé.', 'waitingroom'));
  }

  const active = room?.enabled ? 1 : 0;
  return sectionState({
    active, total: 1, issues,
    lines: [
      `Salon d’attente : ${room?.enabled ? `🟢 ${channelLabel(guild, room.voiceChannelId)}` : '🔴 désactivé'}`,
      `Salons temporaires : ${room?.createTempChannel ? '🟢 activés' : '🔴 désactivés'}`,
      `File en cours : **${(room?.queue || []).length}**`,
    ],
  });
}

function rolesStatus(configs, guild) {
  const roles = (configs.autoRoles || []).filter(role => role.enabled !== false);
  const onboarding = configs.onboarding || null;
  const issues = [];

  for (const role of roles) {
    if (roleMissing(guild, role.roleId)) {
      issues.push(issue('error', `Le rôle automatique (${role.type}) n’existe plus.`, 'autorole'));
      break;
    }
  }
  if (onboarding?.enabled && !onboarding.unverifiedRoleId) {
    issues.push(issue('warn', 'Portail d’accès activé sans rôle non-vérifié : l’accès n’est pas restreint.', 'onboarding'));
  }

  const active = [roles.length > 0, Boolean(onboarding?.enabled)].filter(Boolean).length;
  return sectionState({
    active, total: 2, issues,
    lines: [
      `Rôles automatiques : **${roles.length}**`,
      `Portail d’accès : ${onboarding?.enabled ? '🟢 activé' : '🔴 désactivé'}`,
      `Questions d’accès : **${(onboarding?.questions || []).length}**`,
    ],
  });
}

function logsStatus(configs, guild) {
  const logs = configs.logs || {};
  const categories = [
    ['moderation', 'Modération'],
    ['membres', 'Membres'],
    ['messages', 'Messages'],
    ['vocal', 'Vocaux'],
  ];
  const issues = [];
  let enabled = 0;
  const lines = [];

  for (const [key, label] of categories) {
    const entry = logs[key] || {};
    const on = Boolean(entry.enabled && entry.channelId);
    if (on) enabled++;
    if (entry.enabled && !entry.channelId) {
      issues.push(issue('error', `Journal « ${label} » activé sans salon.`, 'modlog'));
    }
    if (entry.enabled && channelMissing(guild, entry.channelId)) {
      issues.push(issue('error', `Le salon du journal « ${label} » a été supprimé.`, 'modlog'));
    }
    lines.push(`${on ? '🟢' : '🔴'} ${label} : ${on ? channelLabel(guild, entry.channelId) : 'non configuré'}`);
  }
  if (!enabled) {
    issues.push(issue('warn', 'Aucun journal actif : départs, sanctions et messages ne sont pas tracés.', 'modlog'));
  }

  return sectionState({
    active: enabled, total: categories.length, issues, lines,
  });
}

function animationStatus(configs, guild) {
  const welcome = configs.welcome || null;
  const farewell = configs.farewell || null;
  const boost = configs.boost || null;
  const birthday = configs.birthday || null;
  const starboard = configs.starboard || null;
  const issues = [];

  if (welcome?.enabled && !welcome.channelId) {
    issues.push(issue('error', 'Bienvenue activée sans salon.', 'welcome'));
  }
  if (welcome?.enabled && channelMissing(guild, welcome.channelId)) {
    issues.push(issue('error', 'Le salon de bienvenue n’existe plus.', 'welcome'));
  }
  if (farewell?.enabled && !farewell.channelId) {
    issues.push(issue('error', 'Au revoir activé sans salon.', 'farewell-set'));
  }
  if (farewell?.enabled && channelMissing(guild, farewell.channelId)) {
    issues.push(issue('error', 'Le salon d’au revoir n’existe plus.', 'farewell-set'));
  }
  if (birthday?.enabled && !birthday.channelId) {
    issues.push(issue('error', 'Anniversaires activés sans salon d’annonce.', 'anniversaire-config'));
  }
  if (starboard?.enabled && !starboard.channelId) {
    issues.push(issue('error', 'Starboard activé sans salon.', 'starboard'));
  }
  if (starboard?.enabled && channelMissing(guild, starboard.channelId)) {
    issues.push(issue('error', 'Le salon du starboard n’existe plus.', 'starboard'));
  }
  if (boost?.enabled && channelMissing(guild, boost.channelId)) {
    issues.push(issue('error', 'Le salon des messages de boost n’existe plus.', 'boost'));
  }

  const flags = [welcome?.enabled, farewell?.enabled, boost?.enabled, birthday?.enabled, starboard?.enabled];
  const active = flags.filter(Boolean).length;
  if (!active) {
    issues.push(issue('warn', 'Aucune animation active : arrivées, départs et boosts sont muets.', 'welcome'));
  }

  return sectionState({
    active, total: flags.length, issues,
    lines: [
      `Bienvenue : ${welcome?.enabled ? `🟢 ${channelLabel(guild, welcome.channelId)}` : '🔴 désactivée'}`,
      `Au revoir : ${farewell?.enabled ? `🟢 ${channelLabel(guild, farewell.channelId)}` : '🔴 désactivé'}`,
      `Boosts : ${boost?.enabled ? '🟢 activés' : '🔴 désactivés'} · Anniversaires : ${birthday?.enabled ? '🟢' : '🔴'} · Starboard : ${starboard?.enabled ? '🟢' : '🔴'}`,
      `Giveaways en cours : **${Number(configs.giveaways) || 0}**`,
    ],
  });
}

function toolsStatus(configs, guild) {
  const prefix = configs.prefix || null;
  const rules = (configs.reglement?.rules || []).length;
  const custom = Number(configs.customCommands) || 0;
  const watched = (configs.watchedBots || []).length;
  const issues = [];

  if (prefix?.enabled && !String(prefix.prefix || '').trim()) {
    issues.push(issue('error', 'Préfixe activé sans préfixe défini.', 'prefix'));
  }
  if (prefix?.enabled && prefix.logChannelId && channelMissing(guild, prefix.logChannelId)) {
    issues.push(issue('warn', 'Le salon de logs du préfixe n’existe plus.', 'prefix'));
  }

  const active = [Boolean(prefix?.enabled), custom > 0, rules > 0, watched > 0].filter(Boolean).length;
  return sectionState({
    active, total: 4, issues,
    lines: [
      `Préfixe : ${prefix?.enabled ? `🟢 \`${prefix.prefix}\`` : '🔴 désactivé'}`,
      `Commandes personnalisées : **${custom}**`,
      `Règlement : **${rules}** règle(s)`,
      `Bots surveillés : **${watched}**`,
    ],
  });
}

/**
 * Construit l'état des 9 domaines à partir des configurations lues.
 * Pur : aucun accès réseau, donc testable avec un objet de configurations.
 */
function buildStatus(configs = emptyConfigs(), { protection = null, guild = null } = {}) {
  const safeConfigs = { ...emptyConfigs(), ...(configs || {}) };
  const sections = {
    protection: protectionStatus(protection, guild),
    moderation: moderationStatus(safeConfigs, guild),
    tickets: ticketsStatus(safeConfigs, guild),
    mp: mpStatus(safeConfigs, guild),
    vocaux: voiceStatus(safeConfigs, guild),
    roles: rolesStatus(safeConfigs, guild),
    logs: logsStatus(safeConfigs, guild),
    animation: animationStatus(safeConfigs, guild),
    tools: toolsStatus(safeConfigs, guild),
  };

  const totals = { ok: 0, partial: 0, off: 0, issues: 0, errors: 0 };
  for (const state of Object.values(sections)) {
    totals[state.level] = (totals[state.level] || 0) + 1;
    totals.issues += state.issues.length;
    totals.errors += state.issues.filter(i => i.level === 'error').length;
  }

  return { sections, totals };
}

// ─── Rendu du panel ────────────────────────────────────────────────────────

const STATE_EMOJI = { ok: '🟢', partial: '🟡', off: '🔴' };
const LEVEL_EMOJI = { ok: '✅', warn: '⚠️', error: '❌' };
const LICENSE_LABEL = {
  active: '🟢 Licence active',
  trial: '🟡 Essai gratuit',
  expired: '🔴 Licence expirée',
  revoked: '🔴 Licence révoquée',
  none: '⚪ Aucune licence (Communauté)',
};

function licenseLine(license) {
  return LICENSE_LABEL[license?.status] || LICENSE_LABEL.none;
}

function clip(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function sectionSummary(state) {
  const issues = state.issues.length;
  return `${STATE_EMOJI[state.level]} **${state.active}/${state.total}** actif(s) · ${issues ? `**${issues}** alerte(s)` : 'aucun défaut'}`;
}

function buildHomeEmbed(status, { guild = null, protection = null, license = null, diagnostic = null, editable = null } = {}) {
  const totals = status?.totals || { ok: 0, partial: 0, off: 0, issues: 0, errors: 0 };
  const scores = protection ? `Protection **${protection.score}/100** (${protection.grade})` : 'Protection non évaluée';
  const health = diagnostic ? `Diagnostic global **${diagnostic.score}/100** — ${diagnostic.grade}` : null;

  const embed = ui.panelEmbed({
    color: totals.errors ? COLORS.warning : COLORS.primary,
    title: '⚙️ Centre de configuration',
    subtitle: '**Tout le bot en 9 domaines** — état réel et valeurs configurées : tu ne retapes que ce qui change.',
    description: [
      `${scores} · ${totals.issues} alerte(s) dont **${totals.errors}** bloquante(s)`,
      health,
      Number.isFinite(editable) ? `⚙️ **${editable}** module(s) réglables ici même, valeurs actuelles déjà remplies` : null,
      '🎛️ **Toutes les commandes** : la console les liste une par une et les lance pour toi — configure en exécutant.',
      'Les modules dont la configuration tient dans un document se règlent sur place ; les autres gardent leur panneau dédié.',
      `${licenseLine(license)} · ${guild ? `**${guild.memberCount ?? '?'}** membres` : 'serveur inconnu'}`,
    ].filter(line => line !== null && line !== undefined).join('\n'),
    footer: '/setting — 🩺 Diagnostic pour tout vérifier d’un coup',
  });

  for (const section of SECTIONS) {
    embed.addFields({
      name: `${section.emoji} ${section.label}`,
      value: sectionSummary(status?.sections?.[section.id] || { level: 'off', active: 0, total: 1, issues: [] }),
      inline: true,
    });
  }

  if (guild?.iconURL) embed.setThumbnail(guild.iconURL({ dynamic: true }) || null);
  return embed;
}

function sectionOptions() {
  return SECTIONS.map(section => new StringSelectMenuOptionBuilder()
    .setLabel(clip(`${section.emoji} ${section.label}`, 100))
    .setValue(section.id)
    .setDescription(clip(section.tagline, 100)));
}

function homeComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('panel_category')
        .setPlaceholder('📂 Choisir un domaine…')
        .addOptions(sectionOptions()),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_console').setLabel('Toutes les commandes').setEmoji('🎛️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_diag').setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('panel_protection').setLabel('Centre de protection').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * Comment ouvrir un module, en une ligne : édition sur place, panneau dédié
 * ou commande à lancer. `editable` est injecté par la commande (elle seule
 * connaît les modules réellement réglables) pour garder ce fichier sans
 * dépendance vers le moteur de configuration.
 */
function openHint(module, editable) {
  if (module.special) return '🛡️ Géré dans ce panel';
  if (editable?.(module.value)) return '⚙️ Réglable **ici même**';
  if (module.direct) return `⚙️ \`/${module.command || module.value}\``;
  if (module.guide) return `📖 ${module.guide}`;
  return '📖 Commande dédiée';
}

function buildSectionEmbed(sectionId, status, { guild = null, editable = null } = {}) {
  const section = sectionById(sectionId);
  if (!section) return buildHomeEmbed(status, { guild });
  const state = status?.sections?.[section.id] || { active: 0, total: 1, lines: [], issues: [], level: 'off' };

  const embed = ui.panelEmbed({
    color: state.level === 'off' ? COLORS.error : (state.issues || []).some(i => i.level === 'error') ? COLORS.warning : COLORS.primary,
    title: `${section.emoji} ${section.label} — ${STATE_EMOJI[state.level]} ${state.active}/${state.total}`,
    subtitle: section.tagline,
    description: clip((state.lines || []).join('\n'), 3900),
    footer: `/setting — ${section.modules.length} module(s) dans ce domaine`,
  });

  const issues = state.issues || [];
  if (issues.length) {
    embed.addFields({
      name: '⚠️ À corriger',
      value: clip(issues.map(entry => `${LEVEL_EMOJI[entry.level]} ${entry.text}`).join('\n'), 1024),
    });
  } else {
    embed.addFields({ name: '✅ État', value: 'Aucun défaut détecté dans ce domaine.', inline: false });
  }

  // Un champ par module : son rôle, et exactement comment l'ouvrir.
  const shown = [];
  for (const module of section.modules) {
    const placed = addField(embed, {
      name: module.label,
      value: [module.description, openHint(module, editable)].join('\n'),
      inline: true,
    });
    if (!placed) break;
    shown.push(module.value);
  }
  if (shown.length < section.modules.length) {
    addField(embed, {
      name: '🧩 Autres modules',
      value: `${section.modules
        .slice(shown.length)
        .map(module => module.label)
        .join(' · ')}\nOuvre-les avec le menu ci-dessous.`,
    });
  }

  return embed;
}

function sectionComponents(sectionId) {
  const section = sectionById(sectionId);
  if (!section) return homeComponents();

  const options = section.modules.slice(0, MAX_OPTIONS).map(module => new StringSelectMenuOptionBuilder()
    .setLabel(clip(module.label, 100))
    .setValue(module.value)
    .setDescription(clip(module.description, 100)));

  const rows = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`panel_module:${section.id}`)
        .setPlaceholder(`🧩 ${section.label} — ouvrir un module…`)
        .addOptions(options),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('panel_diag').setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('panel_protection').setLabel('Protection').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    ),
  ];
  return rows;
}

// ─── Diagnostic ────────────────────────────────────────────────────────────

const CORE_PERMISSIONS = [
  ['ViewChannel', 'Voir les salons'],
  ['SendMessages', 'Envoyer des messages'],
  ['EmbedLinks', 'Intégrer des liens'],
  ['AttachFiles', 'Joindre des fichiers'],
  ['ReadMessageHistory', 'Lire l’historique'],
  ['AddReactions', 'Ajouter des réactions'],
  ['ManageMessages', 'Gérer les messages'],
  ['ManageChannels', 'Gérer les salons'],
  ['ManageRoles', 'Gérer les rôles'],
  ['ModerateMembers', 'Exclure temporairement'],
  ['KickMembers', 'Expulser des membres'],
  ['BanMembers', 'Bannir des membres'],
  ['ViewAuditLog', 'Voir les logs d’audit'],
];

function gradeOf(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Bon';
  if (score >= 55) return 'À corriger';
  if (score >= 30) return 'Fragile';
  return 'Critique';
}

function scoreBar(score, width = 10) {
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * width);
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`;
}

/**
 * Exécute tous les contrôles. `guild` sert uniquement pour les permissions et
 * l’existence des salons/rôles : le reste vient des configurations lues.
 */
function runDiagnostics({ guild = null, configs = emptyConfigs(), status = null, protection = null, license = null } = {}) {
  const built = status || buildStatus(configs, { protection, guild });
  const checks = [];
  const add = (domain, level, text, fix = null) => checks.push({
    id: `check_${checks.length + 1}`, domain, level, text, fix,
  });

  // 1. Permissions du bot.
  const me = guild?.members?.me;
  if (me?.permissions?.has) {
    const missing = CORE_PERMISSIONS.filter(([permission]) => !me.permissions.has(permission));
    if (missing.length) {
      add('global', 'error', `Permissions manquantes au bot : ${missing.map(([, label]) => label).join(', ')}.`, null);
    } else {
      add('global', 'ok', 'Toutes les permissions utiles sont accordées au bot.');
    }
  } else {
    add('global', 'warn', 'Permissions du bot impossibles à vérifier sur ce serveur.', null);
  }

  // 2. Licence.
  const licStatus = license?.status || 'none';
  if (licStatus === 'active' || licStatus === 'trial') {
    add('global', 'ok', licenseLine(license));
  } else {
    add('global', 'warn', 'Aucune licence active : les modules sous licence restent verrouillés.', 'license');
  }

  // 3. Urgence en cours.
  if (protection?.raid?.active) {
    add('protection', 'error', 'RAID EN COURS : le serveur est en mode urgence.', 'protection');
  }

  // 4. Un contrôle par domaine.
  for (const section of SECTIONS) {
    const state = built.sections[section.id];
    const before = checks.length;
    for (const entry of state.issues) add(section.id, entry.level, entry.text, entry.fix);
    if (checks.length === before && state.level === 'off') {
      add(section.id, 'warn', `${section.label} : aucun module actif.`, section.modules[0]?.value || null);
    }
    if (checks.length === before) {
      add(section.id, 'ok', `${section.label} : opérationnel (${state.active}/${state.total}).`);
    }
  }

  const errors = checks.filter(c => c.level === 'error').length;
  const warnings = checks.filter(c => c.level === 'warn').length;
  const score = Math.max(0, Math.min(100, 100 - errors * 10 - warnings * 3));

  const fixes = [];
  const seen = new Set();
  for (const check of checks) {
    if (!check.fix || seen.has(check.fix)) continue;
    seen.add(check.fix);
    const module = moduleByValue(check.fix);
    fixes.push({
      value: check.fix,
      label: module?.label || check.fix,
      text: check.text,
      domain: check.domain,
    });
    if (fixes.length >= MAX_OPTIONS) break;
  }

  return {
    checks,
    fixes,
    errors,
    warnings,
    score,
    grade: gradeOf(score),
    bar: scoreBar(score),
  };
}

function buildDiagnosticEmbed(report, { guild = null } = {}) {
  const reportData = report || { checks: [], fixes: [], errors: 0, warnings: 0, score: 100, grade: 'Excellent', bar: scoreBar(100) };
  const embed = ui.panelEmbed({
    color: reportData.errors ? COLORS.error : reportData.warnings ? COLORS.warning : COLORS.success,
    title: `🩺 Diagnostic — ${reportData.score}/100 · ${reportData.grade}`,
    subtitle: `\`${reportData.bar}\``,
    description: [
      `**${reportData.errors}** erreur(s) bloquante(s) · **${reportData.warnings}** avertissement(s) · ${guild ? `**${guild.memberCount ?? '?'}** membres` : ''}`.trim(),
      '',
      reportData.fixes.length
        ? 'Choisis un problème dans le menu ci-dessous : son module s’ouvre directement.'
        : 'Aucun problème à corriger : le serveur est prêt.',
    ].join('\n'),
    footer: '/setting — diagnostic recalculé à chaque ouverture',
  });

  const domains = ['global', ...SECTIONS.map(section => section.id)];
  for (const domain of domains) {
    const entries = reportData.checks.filter(check => check.domain === domain);
    if (!entries.length) continue;
    const nonOk = entries.filter(check => check.level !== 'ok');
    if (!nonOk.length) continue;
    const section = sectionById(domain);
    embed.addFields({
      name: section ? `${section.emoji} ${section.label}` : '🌐 Général',
      value: clip(nonOk.map(check => `${LEVEL_EMOJI[check.level]} ${check.text}`).join('\n'), 1024),
    });
  }

  if (!embed.data.fields?.length) {
    embed.addFields({ name: '✅ Tout est vert', value: 'Aucun problème détecté sur ce serveur.' });
  }

  return embed;
}

function diagnosticComponents(report) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('panel_diag_refresh').setLabel('Recalculer').setEmoji('🔄').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('panel_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
    ),
  ];

  const fixes = (report?.fixes || []).slice(0, MAX_OPTIONS);
  if (fixes.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('panel_diag_issue')
        .setPlaceholder('🔧 Corriger un problème…')
        .addOptions(fixes.map(fix => new StringSelectMenuOptionBuilder()
          .setLabel(clip(`🔧 ${fix.label}`, 100))
          .setValue(clip(fix.value, 100))
          .setDescription(clip(fix.text, 100)))),
    ));
  }

  return rows;
}

// ─── Console : toutes les commandes du bot ─────────────────────────────────
//
// Le panel listait les modules ; la console lit `client.commands` — le bot
// réellement chargé — et présente chaque commande avec son état, son module et
// surtout **comment la lancer**. Une commande ajoutée plus tard apparaît sans
// modifier ce fichier, une commande supprimée disparaît.
//
// « Configurer en exécutant » : la console ne réimplémente aucun réglage. Elle
// lance la vraie commande avec une interaction qui imite un lancement slash
// (sous-commande de configuration choisie, options factices). Le module garde
// donc ses gardes, ses permissions, sa licence et son propre panneau. Quand la
// commande exige des arguments, on ne la lance pas au hasard : on affiche son
// usage exact.

const CONSOLE_PAGE_SIZE = 10;
const MAX_FIELDS = 25;
const MAX_FIELD_VALUE = 1024;
const EMBED_BUDGET = 5800; // marge sous la limite Discord de 6000 caractères
const ALL_CATEGORY = 'tous';

/** Taille approchée d'un embed, pour ne jamais dépasser la limite Discord. */
function sizeOf(embed) {
  const data = embed?.toJSON ? embed.toJSON() : (embed?.data || embed || {});
  const fields = data.fields || [];
  return (data.title?.length || 0)
    + (data.description?.length || 0)
    + (data.footer?.text?.length || 0)
    + fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
}

/** Ajoute un champ dans les limites Discord ; `false` quand la place manque. */
function addField(embed, { name, value, inline = false }) {
  const fields = embed.data.fields || (embed.data.fields = []);
  if (fields.length >= MAX_FIELDS) return false;
  const clean = clip(value, MAX_FIELD_VALUE);
  const label = clip(name, 256);
  if (sizeOf(embed) + label.length + clean.length > EMBED_BUDGET) return false;
  embed.addFields({ name: label, value: clean, inline });
  return true;
}

// Sous-commandes qui « configurent » plutôt que d'agir : essayées en premier.
const CONFIG_SUBCOMMANDS = [
  'config', 'configuration', 'panel', 'setup', 'settings', 'reglages', 'réglages',
  'parametres', 'paramètres', 'statut', 'status', 'voir', 'afficher', 'liste', 'list',
  'info', 'infos', 'menu', 'stats', 'top',
];

function requiredArguments(options) {
  return (options || []).filter(option => option.required && option.type >= 3);
}

/** Sous-commandes d'une commande, y compris celles rangées dans un groupe. */
function subcommandCandidates(options) {
  const candidates = [];
  for (const option of options || []) {
    if (option.type === 1) {
      candidates.push({ group: null, sub: option });
    } else if (option.type === 2) {
      for (const sub of option.options || []) {
        if (sub.type === 1) candidates.push({ group: option.name, sub });
      }
    }
  }
  return candidates;
}

/** La première sous-commande lançable sans argument, en préférant « config ». */
function firstUsableSubcommand(options) {
  const usable = subcommandCandidates(options)
    .filter(candidate => requiredArguments(candidate.sub.options).length === 0);
  if (!usable.length) return null;
  const rank = name => {
    const index = CONFIG_SUBCOMMANDS.indexOf(name);
    return index === -1 ? CONFIG_SUBCOMMANDS.length : index;
  };
  return usable
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => rank(a.candidate.sub.name) - rank(b.candidate.sub.name) || a.index - b.index)[0]
    .candidate;
}

/** Usage lisible d'une commande : `/warn config ajouter · /warn ajouter <utilisateur>`. */
function usageOf(json) {
  const name = json?.name || '';
  const parts = [`/${name}`];
  for (const option of json?.options || []) {
    if (option.type === 1) parts.push(`/${name} ${option.name}`);
    else if (option.type === 2) {
      for (const sub of option.options || []) {
        if (sub.type === 1) parts.push(`/${name} ${option.name} ${sub.name}`);
      }
    } else parts.push(`/${name} <${option.name}>${option.required ? '' : ' ?'}`);
  }
  return clip(parts.join(' · '), 900);
}

/**
 * Décide comment lancer une commande depuis le panel.
 *   run   → on peut l'exécuter telle quelle (sous-commande de config choisie) ;
 *   guide → elle réclame des arguments : on affiche son usage au lieu d'agir.
 */
function planForCommand(json) {
  const name = json?.name || '';
  const options = json?.options || [];
  const required = requiredArguments(options);

  if (required.length) {
    return {
      mode: 'guide', name, reason: 'arguments',
      required: required.map(option => option.name),
      usage: usageOf(json),
    };
  }
  if (!options.length) return { mode: 'run', name, group: null, subcommand: null, usage: `/${name}` };

  const candidate = firstUsableSubcommand(options);
  if (candidate) {
    return {
      mode: 'run', name, group: candidate.group, subcommand: candidate.sub.name,
      usage: `/${name} ${candidate.group ? `${candidate.group} ` : ''}${candidate.sub.name}`,
    };
  }
  if (subcommandCandidates(options).length) {
    return { mode: 'guide', name, reason: 'subcommand', usage: usageOf(json) };
  }
  return { mode: 'run', name, group: null, subcommand: null, usage: `/${name}` };
}

/**
 * Interaction d'exécution : la commande reçoit un lancement slash crédible
 * (sous-commande choisie, aucun autre argument) tout en gardant le vrai
 * contexte Discord (guilde, membre, message, réponses).
 */
function executionInteraction(interaction, plan = {}) {
  const nothing = () => null;
  const options = new Proxy({
    getSubcommand: () => plan.subcommand || null,
    getSubcommandGroup: () => plan.group || null,
    getFocused: () => '',
    data: [],
    resolved: {},
  }, {
    // Tout getter d'option inconnu renvoie null : la commande voit un lancement
    // sans argument, jamais une erreur « getString is not a function ».
    get: (target, prop) => {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'inspect' || prop === 'toJSON') return undefined;
      return nothing;
    },
  });

  return new Proxy(interaction, {
    get(target, prop, receiver) {
      if (prop === 'options') return options;
      if (prop === 'isChatInputCommand' || prop === 'isCommand') return () => true;
      if (prop === 'panelExecution') return true;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Toutes les commandes chargées, avec leur module et leur plan de lancement. */
function buildCommandIndex(client, { status = null, isLocked = null } = {}) {
  const rows = [];
  for (const command of client?.commands?.values?.() || []) {
    const json = typeof command.data?.toJSON === 'function'
      ? command.data.toJSON()
      : (command.data || command.data?.toJSON?.() || {});
    const name = json.name || command.data?.name;
    if (!name) continue;

    const module = moduleForCommand(name);
    const sectionId = module?.sectionId || null;
    rows.push({
      name,
      description: String(json.description || command.data?.description || ''),
      category: command.__category || command.meta?.category || 'autres',
      moduleValue: module?.value || null,
      moduleLabel: module?.label || null,
      sectionId,
      level: sectionId ? (status?.sections?.[sectionId]?.level || 'off') : null,
      locked: Boolean(isLocked?.(name)),
      plan: planForCommand(json),
    });
  }
  return rows.sort((a, b) => (a.category === b.category
    ? a.name.localeCompare(b.name)
    : a.category.localeCompare(b.category)));
}

function consoleCategories(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.category, (counts.get(row.category) || 0) + 1);
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** Page courante de la console (sélection pure, partagée par l'embed et les menus). */
function consolePage(client, { status = null, isLocked = null, category = ALL_CATEGORY, page = 0 } = {}) {
  const rows = buildCommandIndex(client, { status, isLocked });
  const categories = consoleCategories(rows);
  const active = category === ALL_CATEGORY || categories.some(entry => entry.category === category)
    ? category
    : ALL_CATEGORY;
  const filtered = active === ALL_CATEGORY ? rows : rows.filter(row => row.category === active);
  const pages = Math.max(1, Math.ceil(filtered.length / CONSOLE_PAGE_SIZE));
  const index = Math.min(Math.max(0, Number(page) || 0), pages - 1);

  return {
    rows,
    categories,
    category: active,
    page: index,
    pages,
    total: filtered.length,
    entries: filtered.slice(index * CONSOLE_PAGE_SIZE, (index + 1) * CONSOLE_PAGE_SIZE),
  };
}

const CONSOLE_STATE = { ok: '🟢', partial: '🟡', off: '🔴' };

function consoleStateEmoji(row) {
  if (row.locked) return '🔒';
  if (!row.sectionId) return '⚪';
  return CONSOLE_STATE[row.level] || '⚪';
}

function buildConsoleEmbed(client, opts = {}) {
  const view = consolePage(client, opts);
  const runnable = view.entries.filter(row => row.plan.mode === 'run').length;

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🎛️ Console — toutes les commandes')
    .setDescription([
      '**Chaque commande du bot, son état, son lancement.** Choisis-en une dans le menu pour la **lancer pour de vrai** : elle ouvre son propre panneau, avec ses permissions et sa licence.',
      view.category === ALL_CATEGORY
        ? `🗂️ Toutes les catégories · **${view.total}** commande(s)`
        : `🗂️ Catégorie **${view.category}** · **${view.total}** commande(s)`,
      '🟢 module configuré · 🟡 partiel · 🔴 inactif · ⚪ commande directe · 🔒 licence requise',
      `Sur cette page : **${runnable}/${view.entries.length}** lançable(s) sans argument.`,
    ].join('\n'))
    .setFooter({ text: `REZO • Console — page ${view.page + 1}/${view.pages}` });

  for (const row of view.entries) {
    const details = [
      clip(row.description, 140) || '*pas de description*',
      row.moduleLabel ? `🧩 ${row.moduleLabel}` : null,
      row.plan.mode === 'run' ? `▶️ \`${row.plan.usage}\`` : `📖 \`${row.plan.usage}\``,
    ].filter(Boolean);
    if (!addField(embed, { name: `${consoleStateEmoji(row)} /${row.name}`, value: details.join('\n') })) break;
  }

  if (!view.entries.length) {
    embed.addFields({ name: 'Aucune commande', value: 'Cette catégorie ne contient aucune commande.' });
  }
  return embed;
}

function consoleComponents(client, opts = {}) {
  const view = consolePage(client, opts);
  const rows = [];

  const categoryOptions = [
    new StringSelectMenuOptionBuilder()
      .setLabel('🗂️ Toutes les catégories')
      .setValue(ALL_CATEGORY)
      .setDescription(clip(`${view.rows.length} commande(s) — le bot complet`, 100))
      .setDefault(view.category === ALL_CATEGORY),
    ...view.categories.slice(0, MAX_OPTIONS - 1).map(entry => new StringSelectMenuOptionBuilder()
      .setLabel(clip(entry.category, 100))
      .setValue(clip(entry.category, 100))
      .setDescription(clip(`${entry.count} commande(s)`, 100))
      .setDefault(entry.category === view.category)),
  ];

  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('panel_console_cat')
      .setPlaceholder('🗂️ Filtrer par catégorie…')
      .addOptions(categoryOptions),
  ));

  if (view.entries.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`panel_console_run:${view.category}:${view.page}`)
        .setPlaceholder('▶️ Lancer une commande de cette page…')
        .addOptions(view.entries.slice(0, MAX_OPTIONS).map(row => new StringSelectMenuOptionBuilder()
          .setLabel(clip(`/${row.name}`, 100))
          .setValue(clip(row.name, 100))
          .setDescription(clip(row.plan.mode === 'run'
            ? `▶️ ${row.plan.usage}`
            : `📖 usage : ${row.plan.usage}`, 100)))),
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_console_page:${view.category}:${view.page - 1}`)
      .setLabel('Précédent').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
      .setDisabled(view.page === 0),
    new ButtonBuilder()
      .setCustomId(`panel_console_page:${view.category}:${view.page + 1}`)
      .setLabel('Suivant').setEmoji('▶️').setStyle(ButtonStyle.Secondary)
      .setDisabled(view.page >= view.pages - 1),
    new ButtonBuilder().setCustomId('panel_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  ));

  return rows;
}

module.exports = {
  SECTIONS,
  SECTION_ALIASES,
  SECTION_BY_ID,
  MAX_OPTIONS,
  sectionById,
  moduleByValue,
  moduleValues,
  safe,
  withTimeout,
  fetchConfigs,
  emptyConfigs,
  hasChannelCache,
  hasRoleCache,
  channelMissing,
  roleMissing,
  channelLabel,
  roleLabel,
  buildStatus,
  STATE_EMOJI,
  LEVEL_EMOJI,
  CORE_PERMISSIONS,
  gradeOf,
  scoreBar,
  licenseLine,
  buildHomeEmbed,
  homeComponents,
  openHint,
  sectionOptions,
  buildSectionEmbed,
  sectionComponents,
  runDiagnostics,
  buildDiagnosticEmbed,
  diagnosticComponents,
  // Console
  CONSOLE_PAGE_SIZE,
  ALL_CATEGORY,
  CONFIG_SUBCOMMANDS,
  MAX_FIELDS,
  MAX_FIELD_VALUE,
  EMBED_BUDGET,
  sizeOf,
  addField,
  moduleForCommand,
  guideCommands,
  requiredArguments,
  subcommandCandidates,
  firstUsableSubcommand,
  usageOf,
  planForCommand,
  executionInteraction,
  buildCommandIndex,
  consoleCategories,
  consolePage,
  consoleStateEmoji,
  buildConsoleEmbed,
  consoleComponents,
};
