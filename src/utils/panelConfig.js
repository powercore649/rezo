'use strict';
// utils/panelConfig.js — Moteur de configuration du panel v3.
//
// Le panel v3 servait de lanceur : il ouvrait le panneau de chaque module.
// Ici, on va plus loin — chaque module dont la configuration est un document
// unique du serveur devient **réglable dans le panel lui-même** :
//
//   • les champs sont découverts directement dans le schéma Mongoose, donc un
//     module ajouté plus tard apparaît sans toucher à ce fichier ;
//   • chaque champ reçoit le contrôle adapté : interrupteur, sélecteur de
//     salon, de rôle, menu d'énumération, ou fenêtre de saisie ;
//   • les valeurs actuelles sont affichées et pré-remplies : on ne retape que
//     ce qui change.
//
// Tout est pur ou injectable (lecture via `readDoc`, écriture via
// `applyValue`) : la découverte des champs, le formatage et le rendu se
// testent sans Discord ni MongoDB.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
} = require('discord.js');
const { COLORS } = require('./embeds');

const MAX_OPTIONS = 25;
const PAGE_SIZE = 23; // 23 champs + les boutons de page dans les rangées suivantes
const MAX_ARRAY = 25;

// ─── Registre ──────────────────────────────────────────────────────────────
// Clé = valeur du module dans panelV3. `model` est chargé à la demande : une
// collection absente ne casse jamais le panel.
// `only`   : liste blanche de chemins (par défaut, tout le schéma).
// `ignore` : chemins ou préfixes jamais éditables (compteurs, historique…).
// `labels` : libellés français explicites pour les champs importants.

const MODULES = {
  // ── Protection ──
  captcha: { label: '🔒 Captcha', model: () => require('../models/Captcha').CaptchaConfig },
  honeypot: { label: '🍯 Honeypot', model: () => require('../models/Honeypot') },
  antiscam: { label: '🚨 Anti-Scam', model: () => require('../models/AntiScamConfig') },
  'controle-arrivee': { label: '🪪 Vigie', model: () => require('../models/JoinGuard') },
  'anti-nuke': { label: '☢️ Sentinel anti-nuke', model: () => require('../models/AntiNuke') },
  antiraid: { label: '🚨 Anti-raid', model: () => require('../models/AntiRaid').AntiRaid },
  securite: { label: '🛡️ Auto-modération', model: () => require('../models/AutoMod') },

  // ── Modération ──
  modlog: { label: '📜 Journaux', model: () => require('../models/GuildLogs') },
  signalement: { label: '🚩 Signalements', model: () => require('../models/Signalement').Config },

  // ── Tickets / MP ──
  ticket: { label: '🎫 Tickets', model: () => require('../models/Ticket').TicketConfig },
  modmail: { label: '📬 Modmail', model: () => require('../models/ModMail').ModMailConfig },
  'demande-mp': { label: '💬 Demandes de MP', model: () => require('../models/MpRequestConfig') },

  // ── Vocaux ──
  waitingroom: { label: '🎧 Salon d’attente', model: () => require('../models/WaitingRoom') },
  radio: { label: '📻 Radio', model: () => require('../models/Radio').RadioConfig },
  musique: { label: '🎵 Musique', model: () => require('../models/Music') },

  // ── Rôles ──
  leveling: { label: '🏆 Niveaux', model: () => require('../models/XPConfig') },
  onboarding: { label: '🚪 Portail d’accès', model: () => require('../models/OnboardingConfig') },

  // ── Journaux & stats ──
  notifications: { label: '🔔 Notifications', model: () => require('../models/Notification').NotificationConfig },
  recap: { label: '📈 Récap hebdomadaire', model: () => require('../models/WeeklyRecap') },
  leaderboardconfig: { label: '🏅 Classements', model: () => require('../models/LeaderboardConfig') },

  // ── Animation ──
  welcome: {
    label: '👋 Bienvenue',
    model: () => require('../models/Welcome').Welcome,
    labels: { message: 'Message de bienvenue', dmMessage: 'MP de bienvenue', counterTemplate: 'Modèle du compteur' },
  },
  'farewell-set': { label: '🚪 Au revoir', model: () => require('../models/Welcome').Farewell },
  boost: { label: '💎 Boosts', model: () => require('../models/BoostConfig') },
  'anniversaire-config': { label: '🎂 Anniversaires', model: () => require('../models/BirthdayConfig') },
  starboard: { label: '⭐ Starboard', model: () => require('../models/Starboard') },
  avis: { label: '⭐ Avis & suggestions', model: () => require('../models/Review').AvisConfig },
  confession: { label: '🕯️ Confessions', model: () => require('../models/Confession').ConfessionConfig },
  freegames: { label: '🆓 Jeux gratuits', model: () => require('../models/FreeGames').FreeGamesConfig },
  tresor: { label: '🎁 Trésors', model: () => require('../models/Treasure').TreasureConfig },

  // ── Outils ──
  pont: {
    label: '🌐 Pont inter-serveurs',
    model: () => require('../models/BridgeConfig'),
    // Le webhook est interne (identifiant + jeton) et la liste des serveurs
    // ignorés se gère dans le panneau du pont : rien de tout cela ici.
    ignore: ['webhookId', 'webhookToken', 'blockedGuilds'],
    labels: {
      channelId: 'Salon du pont',
      hub: 'Canal commun',
      showServerName: 'Afficher le nom du serveur',
      relayReplies: 'Conserver les réponses citées',
      blockBots: 'Bloquer les bots',
      blockLinks: 'Bloquer les liens',
      blockInvites: 'Bloquer les invitations Discord',
      blockAttachments: 'Bloquer les pièces jointes',
      rateLimit: 'Messages autorisés par fenêtre',
      rateWindowSeconds: 'Fenêtre anti-spam (secondes)',
      minLength: 'Longueur minimale d’un message',
    },
  },
  prefix: { label: '⌨️ Préfixe', model: () => require('../models/PrefixConfig') },
  branding: {
    label: '🎨 Identité visuelle',
    model: () => require('../models/GuildBrand'),
    // Le rôle de couleur du pseudo est créé et supprimé par le bot : l'éditer à
    // la main laisserait un rôle orphelin sur le serveur.
    ignore: ['guildId', 'nicknameRoleId', 'updatedBy', 'updatedAt'],
    labels: {
      enabled: 'Identité activée',
      displayName: 'Nom affiché du bot',
      emoji: 'Emoji signature',
      nickname: 'Surnom du bot sur ce serveur',
      nicknameFont: 'Police du surnom (clé)',
      nicknameEffect: 'Effet du surnom (clé)',
      nicknamePalette: 'Couleur du surnom (clé)',
      nicknameWrap: 'Finition du surnom (clé)',
      avatarUrl: 'Avatar du bot (URL)',
      bannerUrl: 'Bannière du bot (URL)',
      color: 'Couleur du serveur (#RRGGBB)',
      footerText: 'Pied de page des embeds',
      bannerMode: 'Bannière d’embed (off / missing / always)',
      replaceAuthor: 'Remplacer l’auteur des embeds',
      replaceFooter: 'Remplacer le pied de page existant',
      avatarThumbnail: 'Avatar en vignette',
    },
  },
  statut: {
    label: '🛰️ Statut du bot',
    model: () => require('../models/GuildStatus'),
    // Identifiants internes et traces d'écriture : jamais éditables à la main.
    ignore: ['guildId', 'messageId', 'updatedAt', 'updatedBy'],
    labels: {
      level: 'État affiché (auto = santé réelle)',
      label: 'Libellé de l’état',
      statusText: 'Phrase de statut',
      title: 'Titre de la carte',
      description: 'Description de la carte',
      color: 'Couleur de la carte (#RRGGBB)',
      image: 'Image de la carte (URL)',
      footerText: 'Pied de page de la carte',
      nickname: 'Surnom du bot sur ce serveur',
      channelId: 'Salon de publication',
      showUptime: 'Afficher l’uptime',
      showPing: 'Afficher la latence',
      showMembers: 'Afficher les membres',
      showCommands: 'Afficher les modules',
      showLicense: 'Afficher la licence',
    },
    // À chaque enregistrement : surnom appliqué et carte republiée, sans
    // bloquer la réponse au panel (cf. panelConfigFlow).
    after: async interaction => require('./guildStatus').sync(interaction.client, interaction.guild, { card: true }),
  },
  autothread: { label: '🧵 Auto-thread', model: () => require('../models/AutoThread') },
  forumwelcome: { label: '🗂️ Accueil forums', model: () => require('../models/ForumWelcome') },
  'statut-site': { label: '🌐 Surveillance de sites', model: () => require('../models/SiteMonitor') },
  config: {
    label: '🚀 Config bump',
    model: () => require('../models/Server'),
    // Modèle partagé avec le réseau : on n'expose que ce qui concerne le serveur.
    only: [
      'description', 'inviteLink', 'tags', 'language', 'nsfw',
      'bumpChannelId', 'feedChannelId', 'logChannelId', 'bumpRoleId',
      'reminderEnabled', 'inviteLogEnabled', 'inviteLogChannelId',
      'bumpThanksEnabled', 'bumpThanksTitle', 'bumpThanksMessage', 'bumpThanksColor',
      'partnerChannelId', 'partnerSubmitChannelId', 'partnerTitle', 'partnerMessage',
      'botWatchChannelId',
    ],
  },
};

const EDITABLE_VALUES = new Set(Object.keys(MODULES));
const FIELD_CACHE = new Map();

// ─── Libellés ──────────────────────────────────────────────────────────────

// Libellés exacts, partagés par plusieurs modules : évite « Journal salon »
// là où « Salon de logs » est la formulation attendue.
const COMMON_LABELS = {
  enabled: 'Activé', channelid: 'Salon', channelids: 'Salons', categoryid: 'Catégorie',
  roleid: 'Rôle', logchannelid: 'Salon de logs', staffroleid: 'Rôle staff',
  supportroleid: 'Rôle support', pingroleid: 'Rôle à mentionner',
  boosterroleid: 'Rôle de boost', bypassroleid: 'Rôle exempté',
  quarantineroleid: 'Rôle de quarantaine', reviewchannelid: 'Salon de vérification',
  announcechannelid: 'Salon d’annonce', logchannel: 'Salon de logs',
  message: 'Message', dmmessage: 'Message privé', prefix: 'Préfixe',
  threshold: 'Seuil', timeout: 'Délai', cooldownseconds: 'Cooldown (secondes)',
  defaultvolume: 'Volume par défaut', djroleid: 'Rôle DJ', djonly: 'Réservé aux DJ',

  // Listes de salons et de rôles
  exemptchannels: 'Salons exemptés', exemptroles: 'Rôles exemptés',
  excludedchannels: 'Salons exclus', silentchannels: 'Salons silencieux',
  includechannels: 'Salons inclus', ignoredchannelids: 'Salons ignorés',
  ignoredroleids: 'Rôles ignorés', trustedroles: 'Rôles de confiance',
  whitelistedroleids: 'Rôles autorisés', rolesallowed: 'Rôles autorisés',
  tempchannelids: 'Salons temporaires', tempcategoryid: 'Catégorie des salons temporaires',
  voicechannelid: 'Salon vocal', targetchannelid: 'Salon de destination',
  reviewscore: 'Score de vérification',

  // Captcha
  rolebefore: 'Rôle avant vérification', roleafter: 'Rôle après vérification',
  kickonfail: 'Expulser en cas d’échec', imagestylemode: 'Vérification par image',
  casesensitive: 'Sensible à la casse', dmonkick: 'MP en cas d’expulsion',
  activeonraid: 'Actif pendant un raid', raidautoactive: 'Activation auto en raid',
  reportdoubtful: 'Signaler les cas douteux', codelength: 'Longueur du code',
  maxregenerations: 'Régénérations max', attempts: 'Tentatives autorisées',
  security: 'Type de code', imagedistortionlevel: 'Difficulté de l’image',
  imagemode: 'Vérification par image',

  // Modèles, cartes et affichage
  renderstyle: 'Style d’affichage', embedtitle: 'Titre de l’embed',
  embedcolor: 'Couleur de l’embed', backgroundurl: 'Image d’arrière-plan',
  imagetext: 'Texte de l’image', imagesubtitle: 'Sous-titre de l’image',
  accentcolor: 'Couleur d’accent', textcolor: 'Couleur du texte',
  footertext: 'Pied de page', counterchannelid: 'Salon du compteur',
  countertemplate: 'Modèle du compteur', counterenabled: 'Compteur activé',
  showfooter: 'Afficher le pied de page', dmenabled: 'MP activé', dmembed: 'MP en embed',
  levelupmessagetemplate: 'Message de passage de niveau', cardcolor: 'Couleur de la carte',
  bgstyle: 'Style de fond', barstyle: 'Style de barre', avatarshape: 'Forme de l’avatar',
  bgcolor: 'Couleur de fond', bgimage: 'Image de fond', bgdim: 'Assombrissement',

  // Niveaux, trésors et réglages numériques
  xpmultiplier: 'Multiplicateur d’XP', coinsmultiplier: 'Multiplicateur de pièces',
  legendaryroleid: 'Rôle légendaire', minaccountagedays: 'Âge minimum du compte (jours)',
  blockscore: 'Score de blocage', actionblock: 'Action si bloqué',
  actionreview: 'Action si douteux', dmonblock: 'MP en cas de blocage',
  useantiraidblacklist: 'Utiliser la liste noire anti-raid',
  spamthreshold: 'Seuil de spam', spamwindow: 'Fenêtre anti-spam (ms)',
  spammuteduration: 'Durée du mute (min)', raidthreshold: 'Seuil de raid',
  raidwindow: 'Fenêtre de raid (ms)', capsthreshold: 'Seuil de majuscules (%)',
  capsminlength: 'Longueur minimale', joinswindowsec: 'Fenêtre d’arrivées (s)',
  suspicionthreshold: 'Seuil de suspicion', autoresolvemin: 'Résolution auto (min)',
  quarantinedurationmin: 'Quarantaine (min)', waveperiodmin: 'Période des vagues (min)',
  wavethreshold: 'Seuil de vague', windowsec: 'Fenêtre (secondes)',
  panicautomin: 'Désactivation auto du panique (min)',

  // Vocaux et rôles
  waitingroleid: 'Rôle d’attente', createtempchannel: 'Créer des salons temporaires',
  mutewaiting: 'Muet en attente', notifystaff: 'Notifier le staff',
  giverole: 'Donner un rôle', autocallnext: 'Appeler le suivant automatiquement',
  tempchannelname: 'Nom des salons temporaires', maxqueue: 'File maximale',
  notifymessage: 'Message de notification', selfstarenabled: 'Autoriser l’auto-étoile',
  botmessagesenabled: 'Prendre les messages de bots', nsfwchannelsenabled: 'Salons NSFW',
  deleteonsourcedelete: 'Supprimer avec la source', restartcycle: 'Cycle de redémarrage',
  levelupchannelid: 'Salon des passages de niveau', announcelevelup: 'Annoncer les passages',
  usecardonlevelup: 'Carte animée au passage de niveau', bannedkick: 'Expulser les comptes bannis',
  bannedban: 'Bannir les comptes bannis', blockinvites: 'Bloquer les invitations',
  imagestyle: 'Style de l’image', raidminaccountage: 'Âge minimum du compte en raid (jours)',
  raidautodisablemin: 'Désactivation auto du raid (min)', raidautoaction: 'Action auto en raid',
  spamaction: 'Action anti-spam', linksaction: 'Action anti-liens', raidaction: 'Action anti-raid',
  raidautotrigger: 'Déclencher le mode raid automatiquement',
};

const WORD_LABELS = {
  enabled: 'activé', active: 'actif', channel: 'salon', channels: 'salons',
  category: 'catégorie', role: 'rôle', roles: 'rôles', user: 'utilisateur',
  users: 'utilisateurs', staff: 'staff', log: 'journal', logs: 'journaux',
  message: 'message', messages: 'messages', welcome: 'bienvenue', bye: 'départ',
  title: 'titre', description: 'description', color: 'couleur', image: 'image',
  url: 'URL', emoji: 'emoji', prefix: 'préfixe', text: 'texte', content: 'contenu',
  min: 'minimum', max: 'maximum', minutes: 'minutes', minute: 'minute',
  seconds: 'secondes', second: 'seconde', hours: 'heures', days: 'jours',
  duration: 'durée', delay: 'délai', interval: 'intervalle', volume: 'volume',
  cooldown: 'cooldown', timeout: 'expiration', name: 'nom', template: 'modèle',
  threshold: 'seuil', thresholds: 'seuils', action: 'action', mode: 'mode',
  level: 'niveau', levelup: 'passage de niveau', xp: 'XP', coins: 'pièces',
  reward: 'récompense', rewards: 'récompenses', stock: 'stock', price: 'prix',
  footer: 'pied de page', footerText: 'pied de page',
  background: 'arrière-plan', accent: 'accent', banner: 'bannière',
  style: 'style', size: 'taille', type: 'type', schedule: 'planification',
  timezone: 'fuseau horaire', language: 'langue', tags: 'étiquettes',
  invite: 'invitation', link: 'lien', links: 'liens', whitelist: 'liste blanche',
  blacklist: 'liste noire', exempt: 'exempté', ignored: 'ignoré', excluded: 'exclu',
  mention: 'mention', mentions: 'mentions', ping: 'ping', dm: 'MP',
  anonymous: 'anonyme', moderation: 'modération', membres: 'membres',
  vocal: 'vocaux', announce: 'annonce', announceChannel: 'salon d’annonce',
  logChannel: 'salon de logs', staffRole: 'rôle staff', supportRole: 'rôle support',
  categoryId: 'catégorie', channelId: 'salon', roleId: 'rôle',
  botId: 'bot', server: 'serveur', game: 'jeu', games: 'jeux', bet: 'mise',
  jackpot: 'jackpot', pot: 'cagnotte', streak: 'série', lives: 'vies',
  question: 'question', answer: 'réponse', key: 'clé', value: 'valeur',
  code: 'code', token: 'jeton', secret: 'secret', webhook: 'webhook',
  priority: 'priorité', status: 'statut', version: 'version', icon: 'icône',
  avatar: 'avatar', nickname: 'pseudo', display: 'affichage', show: 'afficher',
  enabledOnJoin: 'activation à l’arrivée', report: 'signalement',
  review: 'vérification', trusted: 'de confiance', silent: 'silencieux',
  quarantine: 'quarantaine', lockdown: 'confinement', nuke: 'nuke', use: 'utiliser',
  card: 'carte', hint: 'indice', legendary: 'légendaire', lifetime: 'durée de vie',
  clue: 'indice', wrong: 'erreur', guess: 'tentative', rank: 'rang',
  window: 'fenêtre', caps: 'majuscules', delete: 'suppression', punishment: 'sanction',
  journal: 'journal', sensitive: 'sensible', ban: 'bannissement', kick: 'expulsion',
  join: 'arrivée', joins: 'arrivées', leave: 'départ', wave: 'vague',
  suspicion: 'suspicion', resolved: 'résolu', on: 'sur', of: 'de', per: 'par',
  allowed: 'autorisés', trigger: 'déclencheur', auto: 'auto', score: 'score',
  before: 'avant', after: 'après', fail: 'échec', case: 'casse', doubtful: 'douteux',
  distortion: 'distorsion', length: 'longueur', regenerations: 'régénérations',
  account: 'compte', age: 'âge', block: 'blocage', whitelisted: 'autorisés',
  new: 'nouveaux', accounts: 'comptes', banned: 'bannis', no: 'sans',
  suspect: 'suspect', period: 'période', resolve: 'résolution',
  disable: 'désactivation', voice: 'vocal', target: 'cible', temp: 'temporaire',
  waiting: 'attente', create: 'créer', mute: 'mute', notify: 'notifier',
  give: 'donner', call: 'appeler', next: 'suivant', queue: 'file', bg: 'fond',
  bar: 'barre', shape: 'forme', subtitle: 'sous-titre', dim: 'assombrissement',
  common: 'commun', rare: 'rare', multiplier: 'multiplicateur',

  // Sous-objets des protections et des cartes
  checks: 'contrôles', accountage: 'âge du compte', noavatar: 'sans avatar',
  invitelink: 'lien d’invitation', scamwords: 'mots de scam', impersonation: 'usurpation',
  invisible: 'statut invisible', repeatedchars: 'caractères répétés',
  restore: 'restauration', response: 'réponse', detection: 'détection',
  sanction: 'sanction', verification: 'vérification', types: 'types',
  rankcard: 'carte de rang', levelupcard: 'carte de niveau', sections: 'sections',
  odds: 'probabilités', confirmdm: 'confirmation en MP', mentionstaff: 'mention du staff',
};

const READONLY_SEGMENTS = new Set([
  'guildid', 'panelmessageid', 'panelkey', 'guildname', 'guildicon',
  'lasterror', 'updatedby', 'createdby', 'installedby', 'removedby',
  'grantedby', 'startedby', 'closedby', 'claimedby', 'handledby', 'addedby',
  'secret', 'token', 'nonce', 'version', 'number', 'count', 'views', 'uses',
  'strikes', 'purchases', 'opened',
]);

const READONLY_PATTERNS = [
  /^stats$/i, /^statistics$/i, /^snapshot$/i, /^history$/i, /^incidents$/i,
  /^last[A-Z]/, /^total$/, /^total[A-Z]/, /(At|By|Since|Until)$/,
  /(Count|Counter)$/, /([a-z]Active|Blocked|Locked)$/,
];

// Un salon ou une catégorie : `channelId`, `exemptChannels`, `logChannelId`…
// mais pas `channelPrefix` ni `tempChannelName`, qui sont du texte.
const CHANNEL_SEGMENT = /((channel|category)ids?|(channel|category)s?)$/i;
const ROLE_SEGMENT = /^roles?[a-z]*$|role(ids?|s)?$/i;

function capitalize(text) {
  const value = String(text || '');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function labelFor(path, entry = {}) {
  const labels = entry.labels || {};
  const parts = String(path).split('.');
  const seg = parts[parts.length - 1];
  const parentPath = parts.slice(0, -1).join('.');
  const prefix = parentPath ? goalPrefix(parentPath, entry) : '';

  const key = seg.toLowerCase();
  const known = labels[path] || labels[seg] || COMMON_LABELS[key] || WORD_LABELS[key];
  if (known) {
    const base = capitalize(known);
    return prefix ? `${prefix} · ${base}` : base;
  }

  const words = seg
    .replace(/Ids$/, 's')
    .replace(/Id$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean);
  const translated = words.map(word => WORD_LABELS[word.toLowerCase()] || word);
  const base = capitalize(translated.join(' '));
  return prefix ? `${prefix} · ${base}` : base;
}

function goalPrefix(parentPath, entry) {
  const parts = parentPath.split('.');
  const seg = parts[parts.length - 1].toLowerCase();
  return capitalize(WORD_LABELS[seg] || seg);
}

// ─── Découverte des champs ─────────────────────────────────────────────────

function subSchemaOf(def) {
  if (!def) return null;
  if (def.schema && def.schema.paths) return def.schema;
  if (def.$type && def.$type.schema && def.$type.schema.paths) return def.$type.schema;
  const instance = def.instance;
  if ((instance === 'Embedded' || instance === 'Subdocument') && def.schema) return def.schema;
  return null;
}

function arrayElementInstance(def) {
  const caster = def.caster || def.$embeddedSchemaType;
  return caster?.instance || null;
}

function isIgnored(path, entry) {
  if (Array.isArray(entry.only) && entry.only.length && !entry.only.includes(path)) return true;
  if (Array.isArray(entry.ignore)) {
    for (const prefix of entry.ignore) {
      if (path === prefix || path.startsWith(`${prefix}.`)) return true;
    }
  }
  const parts = path.split('.');
  const seg = parts[parts.length - 1];
  if (READONLY_SEGMENTS.has(seg.toLowerCase())) return true;
  if (READONLY_PATTERNS.some(pattern => pattern.test(seg))) return true;
  if (path.includes('$*')) return true;
  if (parts[0].toLowerCase() === 'stats' || parts[0].toLowerCase() === 'statistics') return true;
  if (/Ids?$/.test(seg) && !CHANNEL_SEGMENT.test(seg) && !ROLE_SEGMENT.test(seg)) return true;
  return false;
}

function channelTypesFor(path) {
  if (/categor/i.test(path)) return [ChannelType.GuildCategory];
  if (/voice|vocal/i.test(path)) return [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
  if (/forum/i.test(path)) return [ChannelType.GuildForum, ChannelType.GuildMedia];
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice,
  ];
}

function fieldOf(path, def, entry) {
  const seg = path.split('.').pop();
  const type = def.instance;
  const label = labelFor(path, entry);

  if (type === 'Boolean') return { path, label, type: 'bool' };
  if (type === 'Number') {
    const min = typeof def.options?.min === 'number' ? def.options.min : null;
    const max = typeof def.options?.max === 'number' ? def.options.max : null;
    return { path, label, type: 'number', min, max };
  }
  if (type === 'String') {
    const enumValues = Array.isArray(def.enumValues) ? def.enumValues.filter(Boolean) : [];
    if (enumValues.length) return { path, label, type: 'enum', enumValues };
    if (ROLE_SEGMENT.test(seg)) return { path, label, type: 'role' };
    if (CHANNEL_SEGMENT.test(seg)) {
      return { path, label, type: 'channel', channelTypes: channelTypesFor(path) };
    }
    const long = /(message|description|content|prompt|template|rules|welcome|footer|bio|quote)/i.test(seg);
    return { path, label, type: long ? 'longtext' : 'text' };
  }
  return null;
}

function arrayFieldOf(path, def, entry) {
  if (arrayElementInstance(def) !== 'String') return null;
  const seg = path.split('.').pop();
  const label = labelFor(path, entry);
  if (CHANNEL_SEGMENT.test(seg)) return { path, label, type: 'channels', channelTypes: channelTypesFor(path) };
  if (ROLE_SEGMENT.test(seg)) return { path, label, type: 'roles' };
  return null;
}

function weightOf(field) {
  if (field.path === 'enabled') return 0;
  if (field.type === 'channels' || field.type === 'channel') return 1;
  if (field.type === 'roles' || field.type === 'role') return 2;
  if (field.type === 'bool') return 3;
  if (field.type === 'enum') return 4;
  return 5;
}

function walkSchema(schema, prefix, out, entry, depth) {
  if (!schema || depth > 3) return;
  for (const [name, def] of Object.entries(schema.paths || {})) {
    if (['_id', '__v', 'createdAt', 'updatedAt'].includes(name)) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (def.instance === 'Array') {
      if (isIgnored(path, entry)) continue;
      const field = arrayFieldOf(path, def, entry);
      if (field) out.push(field);
      continue;
    }
    const child = subSchemaOf(def);
    if (child) {
      walkSchema(child, path, out, entry, depth + 1);
      continue;
    }
    if (isIgnored(path, entry)) continue;
    const field = fieldOf(path, def, entry);
    if (field) out.push(field);
  }
}

function collectFields(schema, entry) {
  const out = [];
  walkSchema(schema, '', out, entry, 0);
  const seen = new Set();
  const unique = out.filter(field => {
    if (seen.has(field.path)) return false;
    seen.add(field.path);
    return true;
  });
  return unique.sort((a, b) => weightOf(a) - weightOf(b));
}

// ─── API ───────────────────────────────────────────────────────────────────

function isEditable(value) {
  return EDITABLE_VALUES.has(value);
}

function moduleOf(value) {
  const entry = MODULES[value];
  return entry ? { value, ...entry } : null;
}

function modelFor(entry) {
  if (!entry) return null;
  try {
    const model = entry.model();
    return model && model.schema && typeof model.findOneAndUpdate === 'function' ? model : null;
  } catch {
    return null;
  }
}

/** Décrit un module : modèle, champs éditables et leurs types. */
function describe(value) {
  if (!EDITABLE_VALUES.has(value)) return null;
  if (FIELD_CACHE.has(value)) return FIELD_CACHE.get(value);

  const entry = moduleOf(value);
  const model = modelFor(entry);
  const fields = model ? collectFields(model.schema, entry) : [];
  const result = { value, label: entry.label, model, fields };
  FIELD_CACHE.set(value, result);
  return result;
}

function fieldByPath(value, path) {
  const desc = describe(value);
  return desc?.fields.find(field => field.path === path) || null;
}

function docValue(doc, path) {
  if (doc === null || doc === undefined) return undefined;
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  let current = raw;
  for (const part of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/** Course contre le temps : une base lente ne fige jamais le panel. */
function withTimeout(promise, ms, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Lecture du document de configuration du serveur. */
async function readDoc(value, guildId, { timeout = 2500 } = {}) {
  const desc = describe(value);
  if (!desc?.model) return null;
  return withTimeout((async () => {
    let query = desc.model.findOne({ guildId });
    if (typeof query.lean === 'function') query = query.lean();
    return await query;
  })(), timeout, null);
}

function castValue(field, input) {
  switch (field.type) {
    case 'bool':
      if (typeof input === 'boolean') return input;
      return /^(1|true|on|oui|yes|actif|activé)$/i.test(String(input).trim());
    case 'number': {
      const raw = typeof input === 'number' ? input : Number(String(input).replace(',', '.').trim());
      if (!Number.isFinite(raw)) throw new Error('Ce réglage attend un nombre.');
      let next = raw;
      if (typeof field.min === 'number') next = Math.max(field.min, next);
      if (typeof field.max === 'number') next = Math.min(field.max, next);
      return next;
    }
    case 'enum': {
      const value = String(input);
      if (!field.enumValues.includes(value)) throw new Error('Valeur non autorisée pour ce réglage.');
      return value;
    }
    case 'channel':
    case 'role':
      return input ? String(input) : null;
    case 'channels':
    case 'roles':
      return Array.from(new Set((Array.isArray(input) ? input : [input]).filter(Boolean).map(String))).slice(0, MAX_ARRAY);
    default: {
      const text = String(input ?? '').trim();
      return text ? text.slice(0, 2000) : null;
    }
  }
}

/** Enregistre un réglage. Crée le document du serveur s'il n'existe pas. */
async function applyValue(value, guildId, path, input) {
  const desc = describe(value);
  const field = fieldByPath(value, path);
  if (!desc?.model) return { ok: false, error: 'Module indisponible sur cette installation.' };
  if (!field) return { ok: false, error: 'Ce réglage n’existe pas dans ce module.' };

  let casted;
  try {
    casted = castValue(field, input);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const update = casted === null && field.type !== 'channels' && field.type !== 'roles'
    ? { $unset: { [path]: 1 } }
    : { $set: { [path]: casted } };

  const doc = await withTimeout((async () => desc.model.findOneAndUpdate(
    { guildId },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true, lean: true },
  ))(), 5000, null).catch(() => null);

  if (!doc) return { ok: false, error: 'Enregistrement impossible — réessaie dans un instant.' };
  return { ok: true, doc, field, value: casted };
}

// ─── Rendu ─────────────────────────────────────────────────────────────────

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Un salon ou un rôle est affiché par son nom quand on l'a sous la main :
// « #général » se lit mieux que « <#1234…> », et un salon supprimé se voit.
function channelText(id, guild) {
  const cache = guild?.channels?.cache;
  if (cache?.get) {
    const channel = cache.get(id);
    if (channel?.name) return `#${channel.name}`;
    if (typeof cache.size === 'number' && cache.size > 0) return `<#${id}> *(supprimé)*`;
  }
  return `<#${id}>`;
}

function roleText(id, guild) {
  const cache = guild?.roles?.cache;
  if (cache?.get) {
    const role = cache.get(id);
    if (role?.name) return `@${role.name}`;
    if (typeof cache.size === 'number' && cache.size > 0) return `<@&${id}> *(supprimé)*`;
  }
  return `<@&${id}>`;
}

function formatFieldValue(field, value, guild = null) {
  if (value === undefined || value === null || value === '') return '—';
  switch (field.type) {
    case 'bool':
      return value ? '🟢 Oui' : '🔴 Non';
    case 'channel':
      return channelText(value, guild);
    case 'role':
      return roleText(value, guild);
    case 'channels':
      return Array.isArray(value) && value.length
        ? `${value.slice(0, 4).map(id => channelText(id, guild)).join(' ')}${value.length > 4 ? ` +${value.length - 4}` : ''}`
        : '—';
    case 'roles':
      return Array.isArray(value) && value.length
        ? `${value.slice(0, 4).map(id => roleText(id, guild)).join(' ')}${value.length > 4 ? ` +${value.length - 4}` : ''}`
        : '—';
    case 'number':
      return `\`${value}\``;
    case 'enum':
      return `\`${value}\``;
    default:
      return `\`${clip(String(value).replace(/\n/g, ' '), 40)}\``;
  }
}

function pagesOf(fields) {
  return Math.max(1, Math.ceil((fields?.length || 0) / PAGE_SIZE));
}

function buildEditorEmbed(value, doc, { page = 0, note = null, guild = null } = {}) {
  const desc = describe(value);
  const fields = desc?.fields || [];
  const pages = pagesOf(fields);
  const currentPage = Math.min(Math.max(0, page), pages - 1);
  const enabled = docValue(doc, 'enabled');

  const status = enabled === undefined
    ? '⚙️ Ce module n’a pas d’interrupteur général.'
    : enabled ? '🟢 Module **activé**.' : '🔴 Module **désactivé** — active-le pour qu’il agisse.';

  const list = fields.length
    ? fields.map(field => `**${field.label}** · ${formatFieldValue(field, docValue(doc, field.path), guild)}`)
    : ['`Ce module n’expose aucun réglage simple : passe par son panneau dédié.`'];

  const embed = new EmbedBuilder()
    .setColor(doc?.enabled === false ? COLORS.warning : COLORS.primary)
    .setTitle(clip(`⚙️ ${desc?.label || value} — configuration`, 256))
    .setDescription(clip([
      note ? `${note}\n` : null,
      status,
      '',
      list.join('\n'),
    ].filter(line => line !== null).join('\n'), 4000))
    .setFooter({ text: `REZO • /setting — ${fields.length} réglage(s) · page ${currentPage + 1}/${pages} — tout s’enregistre immédiatement` });

  return embed;
}

function editorComponents(value, doc, page = 0, { hasPanel = false, guild = null } = {}) {
  const desc = describe(value);
  const fields = desc?.fields || [];
  const pages = pagesOf(fields);
  const currentPage = Math.min(Math.max(0, page), pages - 1);
  const slice = fields.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const rows = [];

  if (slice.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`cfg_field:${value}:${currentPage}`)
        .setPlaceholder('✏️ Modifier un réglage…')
        .addOptions(slice.map(field => new StringSelectMenuOptionBuilder()
          .setLabel(clip(field.label, 100))
          .setValue(clip(field.path, 100))
          .setDescription(clip(formatFieldValue(field, docValue(doc, field.path), guild).replace(/[*`]/g, ''), 100)))),
    ));
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`cfg_page:${value}:${currentPage - 1}`)
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`cfg_page:${value}:${currentPage + 1}`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= pages - 1),
  ];
  if (hasPanel) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`cfg_panel:${value}`)
      .setLabel('Panneau dédié')
      .setEmoji('🧩')
      .setStyle(ButtonStyle.Secondary));
  }
  buttons.push(
    new ButtonBuilder().setCustomId('panel_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel_diag').setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Success),
  );

  rows.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 5)));
  return rows;
}

function buildPickerEmbed(value, field, doc, { note = null, guild = null } = {}) {
  const desc = describe(value);
  const current = docValue(doc, field.path);
  return new EmbedBuilder()
    .setColor(COLORS.info || COLORS.primary)
    .setTitle(clip(`✏️ ${field.label}`, 256))
    .setDescription(clip([
      note ? `${note}\n` : null,
      `Module **${desc?.label || value}**`,
      `Valeur actuelle : ${formatFieldValue(field, current, guild)}`,
      '',
      field.type === 'enum'
        ? 'Choisis la nouvelle valeur ci-dessous.'
        : field.type === 'channels' || field.type === 'roles'
          ? 'Sélectionne une ou plusieurs entrées (aucune sélection = liste vide).'
          : 'Choisis la nouvelle valeur ci-dessous.',
    ].filter(line => line !== null).join('\n'), 4000))
    .setFooter({ text: 'REZO • /setting — enregistré dès la sélection' });
}

function pickerComponents(value, field, doc) {
  const current = docValue(doc, field.path);
  const customId = `cfg_pick:${value}:${field.path}`;
  let row;

  if (field.type === 'channels') {
    row = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(clip(field.label, 150))
        .setMinValues(0)
        .setMaxValues(MAX_ARRAY)
        .setChannelTypes(...(field.channelTypes || channelTypesFor(field.path))),
    );
  } else if (field.type === 'channel') {
    row = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(clip(field.label, 150))
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(...(field.channelTypes || channelTypesFor(field.path))),
    );
  } else if (field.type === 'roles' || field.type === 'role') {
    row = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(clip(field.label, 150))
        .setMinValues(field.type === 'roles' ? 0 : 1)
        .setMaxValues(field.type === 'roles' ? MAX_ARRAY : 1),
    );
  } else {
    const options = (field.enumValues || []).slice(0, MAX_OPTIONS).map(option => new StringSelectMenuOptionBuilder()
      .setLabel(clip(option, 100))
      .setValue(clip(option, 100))
      .setDefault(option === current));
    row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(clip(field.label, 150))
        .addOptions(options),
    );
  }

  return [
    row,
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg_back:${value}`).setLabel('Annuler').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

module.exports = {
  MODULES,
  EDITABLE_VALUES,
  MAX_OPTIONS,
  PAGE_SIZE,
  MAX_ARRAY,
  WORD_LABELS,
  isEditable,
  moduleOf,
  describe,
  fieldByPath,
  docValue,
  withTimeout,
  readDoc,
  castValue,
  applyValue,
  labelFor,
  formatFieldValue,
  channelText,
  roleText,
  pagesOf,
  buildEditorEmbed,
  editorComponents,
  buildPickerEmbed,
  pickerComponents,
  channelTypesFor,
};
