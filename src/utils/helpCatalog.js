'use strict';
// utils/helpCatalog.js — Catalogue du centre d'aide, construit depuis le bot réel.
//
// Pourquoi ce module existe : l'ancien panel /help listait des commandes écrites
// à la main. Elles ont fini par mentir (commandes supprimées, renommées, ajoutées
// sans doc). Ici, la source de vérité est `client.commands` — le catalogue réel
// chargé par le noyau — enrichi de la catégorie de fichier (`__category`) et des
// permissions Discord déclarées par la commande. Conséquences :
//   • le nombre de commandes annoncé ne peut pas être faux ;
//   • une commande ajoutée apparaît toute seule dans /help ;
//   • une commande supprimée disparaît toute seule ;
//   • la fiche détaillée connaît les sous-commandes et l'accès requis.
//
// Tout est pur et testable hors-ligne : on ne fait aucune I/O réseau, et la
// construction accepte n'importe quelle Collection { name → module }.

const { PermissionFlagsBits } = require('discord.js');
const brand = require('./brand');

const C = brand.BRAND.colors;

// ── Groupes d'affichage ──────────────────────────────────────────────────────
// L'ordre est éditorial (ce que le membre doit voir en premier), pas alphabétique.
// `folders` dit quels dossiers de src/commands alimentent le groupe : les dossiers
// « moderation » et « securite » sont volontairement réunis — pour l'utilisateur,
// protéger et modérer, c'est le même métier.
const GROUP_META = [
  { id: 'configuration', emoji: '⚙️', label: 'Configuration',       tagline: 'Régler le bot en quelques clics',   color: C.info,    folders: ['configuration'] },
  { id: 'moderation',    emoji: '🛡️', label: 'Modération & Sécurité', tagline: 'Protéger et modérer le serveur',      color: C.primary, folders: ['moderation', 'securite'] },
  { id: 'communaute',    emoji: '🎉', label: 'Communauté',           tagline: 'Animer et faire revenir les membres', color: C.warning, folders: ['communaute'] },
  { id: 'bump-reseau',   emoji: '🚀', label: 'Bump & Réseau',        tagline: 'Gagner en visibilité',               color: C.accent,  folders: ['bump-reseau'] },
  { id: 'economie',      emoji: '💰', label: 'Économie',             tagline: 'Pièces, boutique et récompenses',     color: C.success, folders: ['economie'] },
  { id: 'musique',       emoji: '🎵', label: 'Musique',              tagline: 'Radio et salons vocaux, sans Lavalink', color: C.accent,  folders: ['musique'] },
  { id: 'fun',           emoji: '🎲', label: 'Fun',                  tagline: 'Jeux et détente',                     color: C.accent,  folders: ['fun'] },
  { id: 'xp',            emoji: '🏆', label: 'Niveaux',              tagline: 'XP et cartes de rang',                color: C.success, folders: ['xp'] },
  { id: 'utilitaires',   emoji: '🔧', label: 'Utilitaires',          tagline: 'Les outils du quotidien',             color: C.info,    folders: ['utilitaires'] },
  { id: 'owner',         emoji: '👑', label: 'Propriétaire',         tagline: 'Outils réservés au propriétaire',     color: C.error,   folders: ['owner'] },
];

const FOLDER_TO_GROUP = GROUP_META.reduce((acc, g) => {
  for (const folder of g.folders) acc[folder] = g.id;
  return acc;
}, {});

const GROUP_BY_ID = Object.fromEntries(GROUP_META.map(g => [g.id, g]));

// ── Noms de permissions en français ──────────────────────────────────────────
// Les bits viennent de discord.js (jamais recopiés à la main) ; seuly le libellé
// est traduit ici.
const PERMISSION_FR = {
  Administrator:                     'Administrateur',
  ManageGuild:                       'Gérer le serveur',
  KickMembers:                       'Expulser des membres',
  BanMembers:                        'Bannir des membres',
  ManageChannels:                    'Gérer les salons',
  ManageRoles:                       'Gérer les rôles',
  ViewAuditLog:                      'Voir le journal d’audit',
  ManageMessages:                    'Gérer les messages',
  ModerateMembers:                   'Exclure temporairement des membres',
  ManageWebhooks:                    'Gérer les webhooks',
  ManageGuildExpressions:            'Gérer les expressions',
  ManageEvents:                      'Gérer les événements',
  ManageThreads:                     'Gérer les fils',
  ManageNicknames:                   'Gérer les pseudos',
  EmbedLinks:                        'Intégrer des liens',
  MentionEveryone:                   'Mentionner @everyone',
  CreateInstantInvite:               'Créer une invitation',
  Connect:                           'Se connecter en vocal',
  Speak:                             'Parler en vocal',
  MoveMembers:                       'Déplacer des membres',
  ManageGuildExpressionsLegacy:      'Gérer les emojis et stickers',
  UseExternalEmojis:                 'Utiliser des emojis externes',
  ReadMessageHistory:                'Lire l’historique des messages',
  AddReactions:                      'Ajouter des réactions',
  AttachFiles:                       'Joindre des fichiers',
  SendMessages:                      'Envoyer des messages',
  ViewChannel:                       'Voir les salons',
  PrioritySpeaker:                   'Voix prioritaire',
  RequestToSpeak:                    'Demander à parler',
  Manage_Events:                     'Gérer les événements',
};

// ── Guides (documentation éditoriale) ────────────────────────────────────────
// Le contenu reste éditorial — c'est le seul endroit où l'on raconte une
// intention. Les commandes citées sont vérifiées par les tests contre le
// catalogue réel (aucun guide ne peut citer une commande inexistante).
const GUIDES = [
  {
    id: 'demarrage', emoji: '🚀', label: 'Démarrer en 5 minutes',
    title: 'Démarrer en 5 minutes', tagline: 'Les quatre étapes qui changent tout',
    color: C.accent,
    body: [
      '**1. `/setting`** — le hub central : chaque module s’ouvre dans le message et ses réglages s’éditent sur place (interrupteurs, salons, rôles, valeurs), les valeurs actuelles déjà remplies.',
      '**2. `/autopilote`** — le bot note votre serveur et installe ce qu’il peut sans risque.',
      '**3. `/captcha`** — filtrez les arrivées dès la première seconde.',
      '**4. `/bump`** — entrez dans le réseau et gagnez en visibilité.',
      '',
      'Une fois ces quatre étapes faites, le serveur est protégé et animé.',
      'Le reste se règle au besoin : `/help` → menu **Configuration**.',
      '',
      '💡 Astuce : `/help commande:nom` ouvre la fiche exacte d’une commande.',
    ].join('\n'),
  },
  {
    id: 'securite', emoji: '🛡️', label: 'Sécurité', title: 'Sécuriser votre serveur',
    tagline: 'Empiler les couches, pas choisir la meilleure', color: C.primary,
    body: [
      'Chaque protection couvre un angle différent — activez-les ensemble.',
      '',
      '• `/captcha` — vérification humaine à l’arrivée, **non contournable** (bypass réservé aux rôles gérés par Discord).',
      '• `/antiraid` — vagues d’arrivées, comptes neufs, quarantaine.',
      '• `/controle-arrivee` — Vigie : note chaque profil et met en attente ou écarte.',
      '• `/anti-nuke` — Sentinel : bloque la destruction massive (salons, rôles, bans, webhooks) et répare.',
      '• `/audit-securite` — note la sécurité de 0 à 100 et corrige les failles en un clic.',
      '• `/honeypot` — salon et bouton pièges : quiconque clique est un bot.',
      '• `/antiscam` — alertes d’arnaque partagées entre serveurs du réseau.',
      '• `/securite` — anti-spam, anti-liens, anti-caps, filtre de mots, exemptions… et le **coffre-fort de permissions** : il mémorise l’accès attendu des salons/rôles sensibles et **referme** toute ouverture silencieuse (un admin compromis qui donne `@everyone` sur un salon staff, un `Gérer les rôles` glissé à un rôle subalterne) — ce que l’anti-nuke ne voit pas.',
      '• `/mod paliers` — sanctions automatiques par paliers d’avertissements.',
      '• `/modlog` — journal complet : qui a fait quoi, et quand.',
      '',
      '🎯 **Objectif : 0 raid subi.** `/autopilote` vérifie que tout est actif.',
    ].join('\n'),
  },
  {
    id: 'moderation', emoji: '⚖️', label: 'Modération', title: 'Modérer sans stress',
    tagline: 'Des outils clairs, des traces propres', color: C.info,
    body: [
      '• `/mod avertir` puis `/mod paliers` — l’escalade s’applique toute seule.',
      '• `/mod unban` — lever un bannissement, avec raison et trace.',
      '• `/mod lock` · `/mod unlock` — fermer puis rouvrir un salon d’un geste.',
      '• `/mod slowmode` — mode lent réglé en une seconde (`off`, `30s`, `5m`, `2h`).',
      '• `/mod bypass` — vérifier un membre légitime coincé derrière le captcha.',
      '• `/sanctions` — les bannissements **officiels** de Discord, paginés, filtrables et exportables.',
      '• `/sanctions membre:@x` — banni ou non, timeout en cours, historique du journal d’audit.',
      '• `/mod kick` — expulsion immédiate ; la raison est journalisée.',
      '• `/support-vocal` — ticket vocal : le staff rejoint le membre en direct.',
      '• `/modlog` — journalise arrivées, départs et sanctions.',
      '• `/signalement` — les membres alertent le staff discrètement.',
      '• `/modmail` — messagerie privée membre ↔ staff.',
      '• `/ticket` — support traçable, transcripts et satisfaction.',
      '',
      'Tout est journalisé : vous pouvez toujours expliquer une décision.',
      '💡 Un staff formé vaut mieux qu’un panel parfait : commencez par `/mod paliers`.',
    ].join('\n'),
  },
  {
    id: 'communaute', emoji: '🎉', label: 'Communauté', title: 'Faire vivre la communauté',
    tagline: 'Des raisons de revenir chaque jour', color: C.warning,
    body: [
      '• `/giveaway` — concours avec tirage automatique.',
      '• `/poll` — sondages en temps réel.',
      '• `/event` — organiser et suivre des événements.',
      '• `/anniversaire` — annonces automatiques.',
      '• `/avis` — avis et notes /5 sur le serveur.',
      '• `/confession` — confessions anonymes modérées.',
      '• `/tresor` — un coffre à deviner avec des indices progressifs.',
      '• `/invites voir` — carte personnelle + statistiques · `/invites classement` — podium paginé.',
      '• `/invites creer` — invitation suivie (usages limités) · `/invites-config` — carte, coins, paliers.',
      '• `/news` — actualités françaises automatiques · `/news reddit` — subreddits fusionnés au flux.',
      '',
      '💡 Un serveur actif se bump aussi : `/bump` toutes les 2 heures.',
    ].join('\n'),
  },
  {
    id: 'autopilote', emoji: '🤖', label: 'Autopilote', title: 'Laisser le bot se configurer',
    tagline: 'Mesurer, expliquer, installer', color: C.accent,
    body: [
      '`/autopilote` calcule un **score d’efficacité** de votre serveur (0-100 %) :',
      '',
      '• il compare votre configuration à des dizaines de modules répartis en 5 piliers ;',
      '• il liste **ce qui manque** pour atteindre 90 %, trié par impact réel ;',
      '• il **installe automatiquement** ce qui peut l’être sans risque, et laisse',
      '  à l’humain ce qui demande un choix (captcha, tickets, modmail…).',
      '',
      'Le score devient votre checklist : chaque point gagné est un système actif.',
      '💡 `/starterpack` installe la structure de base avant même de lancer l’autopilote.',
    ].join('\n'),
  },
  {
    id: 'tickets', emoji: '🎫', label: 'Tickets', title: 'Support par tickets',
    tagline: 'Un support propre et traçable', color: C.info,
    body: [
      '**Une seule commande** : `/ticket`. Aucune sous-commande à retenir —',
      'elle ouvre le panel qui gère **tout** :',
      '',
      '• **Vue d’ensemble** — état du panel et ce qu’il reste à régler.',
      '• **Personnalisation** — titre, couleur, image, bouton, message d’accueil.',
      '• **Comportement** — MP, mention, cooldown, archivage, transcripts.',
      '• **Catégories** — types de tickets, questions du formulaire, rôle support.',
      '• **Support & stats** — statistiques, liste, blacklist et actions.',
      '',
      'Les membres ouvrent un ticket via le menu du panel posté dans un salon.',
      'Dans un ticket : **claim**, **fermer**, **priorité**, **ajouter/retirer un',
      'membre**, **transcript**. La note ⭐ des tickets fermés alimente la satisfaction.',
      '',
      'Astuce : `/setting` → Support → 🎫 Tickets ouvre exactement le même panel.',
    ].join('\n'),
  },
  {
    id: 'progression', emoji: '🏆', label: 'Niveaux & économie', title: 'Niveaux et économie',
    tagline: 'Deux boucles qui font revenir les membres', color: C.success,
    body: [
      '**Niveaux**',
      '• `/leveling` — activer l’XP, choisir les récompenses de rôle, configurer les cartes.',
      '• `/rank` — carte de rang personnalisée (thème, couleurs, image).',
      '• `/profile voir` — carte de profil avec badges ; `/profile panel` — titre, bio, couleurs, bannière et visibilité ; `/profile badges` — galerie et progression.',
      '',
      '**Économie**',
      '• `/daily` — récompense quotidienne (série de jours bonus).',
      '• `/work` — travailler toutes les heures.',
      '• `/casino` — machine à sous, roulette, blackjack, dés et pile ou face ; profil, classement, jackpot de serveur et configuration admin.',
      '• `/fish` et `/fishshop` — pêche et cannes à acheter.',
      '• `/balance` — consulter son solde, **payer un membre** (bouton 💸, confirmation, historique) et voir ses mouvements.',
      '• `/give` — cadeau direct de pièces avec une raison.',
      '• `/balance` → **💎 Licence** — le propriétaire ou un admin achète une licence pour le serveur avec ses pièces (aucun argent réel).',
      '• `/shop` — boutique du serveur : choisis un article dans le menu, confirme, c\'est payé avec tes pièces (rôle, badge ou avantage livré aussitôt). Un administrateur gère les articles et les prix depuis `/setting` → 🎉 Communauté → 🛒 Boutique (ou les boutons ➕ ✏️ 🗑️ du `/shop`).',
      '',
      '💡 Reliez les deux : une récompense de rôle à un niveau donne un objectif visible.',
    ].join('\n'),
  },
  {
    id: 'licence', emoji: '🔒', label: 'Licence', title: 'Licence & essai gratuit',
    tagline: 'Comprendre le badge 🔒', color: C.accent,
    body: [
      'Les commandes marquées **🔒** utilisent une licence valide pour le serveur.',
      '',
      '• `/license` → **🔑 Activer une clé** — clé `REZO-XXXX-XXXX-XXXX-XXXX`.',
      '• `/license statut` — état de la licence et de l’essai gratuit.',
      '• `/license aide` — tout le système expliqué.',
      '• `/balance` → **💎 Licence** — acheter la licence avec les pièces gagnées sur le serveur.',
      '',
      '💡 Un essai gratuit de 7 jours est réservé au **propriétaire du serveur** : `/license` (une seule fois par personne, serveur d’au moins 5 membres et créé depuis 2 jours).',
      'Le badge du panel est déduit de la source de vérité du bot : il ne peut pas mentir.',
    ].join('\n'),
  },
  {
    id: 'recuperation', emoji: '🔐', label: 'Récupération', title: 'Récupérer son serveur',
    tagline: 'Le filet de sécurité quand tout est perdu', color: C.error,
    body: [
      '• `/setuprescue` — active la protection 2FA et génère une clé de récupération.',
      '• `/claimserver` — récupère les permissions Extra Owner depuis un nouveau compte.',
      '• `/resetrescue` — débloque après plusieurs échecs (urgence).',
      '• `/extraowners` — gère les propriétaires supplémentaires du bot.',
      '',
      '⚠️ Configurez-la **avant** d’en avoir besoin, et conservez la clé hors de Discord.',
    ].join('\n'),
  },
  {
    id: 'recherche', emoji: '🧭', label: 'Trouver une commande', title: 'Trouver la bonne commande',
    tagline: 'Le panel est fait pour ça', color: C.primary,
    body: [
      '• **Menu Catégories** — parcourt les 99 commandes, 10 par page.',
      '• **Menu Guides** — les parcours pas-à-pas (sécurité, tickets, niveaux…).',
      '• **Rechercher** — accepte un nom, un système ou un mot-clé (`bump`, `raid`, `ticket`).',
      '• **`/help commande:nom`** — autocomplétion et fiche détaillée directe.',
      '• **Mes accès** — ne montre que les commandes que **vous** pouvez lancer sur ce serveur.',
      '',
      'Sur une fiche : usage exact, sous-commandes, permissions requises, catégorie et licence.',
      'Le bouton **Accueil** ramène toujours au début, et le panel reste utilisable par son auteur',
      '(ou un membre avec **Gérer le serveur**).',
    ].join('\n'),
  },
];

const GUIDE_BY_ID = Object.fromEntries(GUIDES.map(g => [g.id, g]));

// ── Aides de normalisation ───────────────────────────────────────────────────
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^[/!]/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jsonOf(data) {
  if (!data) return {};
  if (typeof data.toJSON === 'function') {
    try { return data.toJSON(); } catch { /* builder incomplet : repli */ }
  }
  return data;
}

function cleanText(str, max = 200) {
  const text = String(str || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// ── Permissions ──────────────────────────────────────────────────────────────
function toBits(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const bits = BigInt(value);
    return bits > 0n ? bits : 0n;
  } catch {
    return null;
  }
}

function permissionLabels(bits) {
  if (bits === null || bits === undefined) return [];
  const value = typeof bits === 'bigint' ? bits : toBits(bits);
  if (value === null) return [];
  if (value === 0n) return ['Réservé au propriétaire du bot'];
  const labels = [];
  for (const [flag, bit] of Object.entries(PermissionFlagsBits)) {
    if (typeof bit !== 'bigint' || bit === 0n) continue;
    if ((value & bit) === bit) labels.push(PERMISSION_FR[flag] || flag);
  }
  return labels.length ? labels : ['Aucune permission particulière'];
}

// Un membre peut-il réellement lancer cette commande ?
// `default_member_permissions` absent = tout le monde ; 0 = propriétaire/admins.
function canUse(entry, member) {
  const bits = entry?.permissionBits ?? null;
  if (bits === null) return true;
  if (!member?.permissions?.has) return bits === null;
  try {
    // Administrator contourne toutes les permissions Discord : on ne peut pas
    // se contenter de tester le bit demandé.
    if (member.permissions.has('Administrator')) return true;
    if (bits === 0n) return false;
    return member.permissions.has(bits);
  } catch {
    return false;
  }
}

// ── Usage & sous-commandes ───────────────────────────────────────────────────
const OPTION_PLACEHOLDER = {
  3: 'texte', 4: 'nombre', 5: 'oui|non', 6: '@membre', 7: '#salon',
  8: '@rôle', 9: 'membre|rôle', 10: 'nombre', 11: 'fichier',
};

function optionToken(option) {
  const inner = option?.choices?.length
    ? option.choices.map(c => normalize(c.name).replace(/\s+/g, '-')).slice(0, 4).join('|')
    : (OPTION_PLACEHOLDER[option?.type] || 'valeur');
  const label = option?.name || 'option';
  return option?.required ? `<${label}: ${inner}>` : `[${label}: ${inner}]`;
}

function buildUsage(data) {
  const json = jsonOf(data);
  const name = json.name || 'commande';
  const top = Array.isArray(json.options) ? json.options : [];
  if (!top.length) return `/${name}`;
  if (top.every(o => o.type === 1 || o.type === 2)) {
    return top.slice(0, 12).map(o => `/${name} ${o.name}`).join('\n');
  }
  return `/${name} ${top.map(optionToken).join(' ')}`.trim();
}

function listSubcommands(data) {
  const json = jsonOf(data);
  const top = Array.isArray(json.options) ? json.options : [];
  const rows = [];
  for (const option of top) {
    if (option.type === 1) {
      rows.push({ name: option.name, description: cleanText(option.description, 90) });
    } else if (option.type === 2) {
      for (const sub of option.options || []) {
        if (sub.type !== 1) continue;
        rows.push({ name: `${option.name} ${sub.name}`, description: cleanText(sub.description, 90) });
      }
    }
  }
  return rows;
}

// ── Licence (source de vérité unique) ────────────────────────────────────────
let licensedSet = null;
function licensedCommands() {
  if (!licensedSet) {
    try {
      const { LICENSE_REQUIRED_COMMANDS } = require('./licenseGate');
      licensedSet = new Set((LICENSE_REQUIRED_COMMANDS || []).map(s => String(s).toLowerCase()));
    } catch {
      licensedSet = new Set();
    }
  }
  return licensedSet;
}

function isLicensed(name) {
  const base = normalize(name).split(' ')[0];
  return licensedCommands().has(base);
}

// ── Alias de recherche ───────────────────────────────────────────────────────
// Mots que les membres tapent réellement. Chaque alias est filtré sur le
// catalogue : un alias pointant vers une commande supprimée est ignoré.
const COMMAND_ALIASES = {
  bump: ['reseau', 'network', 'visibilite', 'pub'],
  'bump-notif': ['rappel bump', 'notification bump'],
  captcha: ['verification', 'antibot', 'anti bot', 'robot'],
  antiraid: ['raid', 'quarantaine', 'vague'],
  'controle-arrivee': ['arrivee', 'arrivée', 'vigie', 'join', 'nouveau membre'],
  'anti-nuke': ['antinuke', 'nuke', 'sentinel', 'destruction', 'webhook'],
  'audit-securite': ['audit', 'score securite', 'failles'],
  securite: ['spam', 'liens', 'caps', 'mots interdits', 'coffre', 'permissions'],
  honeypot: ['piege', 'piège', 'leurre'],
  warn: ['sanction', 'paliers', 'avertissement', 'warnconfig'],
  kick: ['expulser', 'expulsion'],
  ticket: ['support', 'sav'],
  modmail: ['mp staff', 'message prive'],
  signalement: ['report', 'alerte staff'],
  giveaway: ['concours', 'tirage'],
  poll: ['sondage', 'vote'],
  avis: ['note', 'review'],
  confession: ['anonyme'],
  tresor: ['coffre', 'enigme'],
  musique: ['musique', 'son', 'playlist', 'chanson', 'vocal'],
  radio: ['radio', 'station', 'stations', 'fm', 'direct', 'flux'],
  leveling: ['xp', 'niveaux', 'level'],
  rank: ['carte', 'niveau', 'xp'],
  balance: ['solde', 'argent', 'coins'],
  daily: ['quotidien', 'recompense'],
  work: ['travailler'],
  fish: ['peche', 'pecher'],
  shop: ['boutique'],
  setting: ['config', 'configuration', 'hub', 'panel', 'reglages', 'réglages'],
  config: ['setting', 'panel', 'configuration'],
  license: ['licence', 'cle', 'essai'],
  setuprescue: ['2fa', 'recuperation', 'sauvetage'],
  starterpack: ['installation', 'demarrage'],
  autopilote: ['score', 'efficacite'],
  help: ['aide', 'commandes'],
  botinfo: ['infos bot', 'statistiques', 'uptime', 'version'],
  serverinfo: ['infos serveur'],
  embed: ['embed', 'message personnalise'],
  custom: ['commande personnalisee'],
  prefix: ['prefixe'],
};

const CATEGORY_ALIASES = {
  securite: 'moderation', security: 'moderation', moderation: 'moderation', modération: 'moderation',
  config: 'configuration', configuration: 'configuration', reglages: 'configuration', réglages: 'configuration',
  communaute: 'communaute', community: 'communaute', animation: 'communaute',
  bump: 'bump-reseau', reseau: 'bump-reseau', réseau: 'bump-reseau', network: 'bump-reseau',
  economie: 'economie', economy: 'economie', argent: 'economie', coins: 'economie',
  fun: 'fun', jeux: 'fun', jeu: 'fun',
  musique: 'musique', music: 'musique', radio: 'musique', son: 'musique',
  niveau: 'xp', niveaux: 'xp', xp: 'xp', level: 'xp', levels: 'xp',
  utilitaire: 'utilitaires', utilitaires: 'utilitaires', utility: 'utilitaires',
  owner: 'owner', proprietaire: 'owner', propriétaire: 'owner',
  ticket: 'moderation', tickets: 'moderation', support: 'moderation',
  aide: 'aide',
};

// ── Construction du catalogue ────────────────────────────────────────────────
function categoryOfModule(mod, name) {
  const folder = mod?.__category || mod?.meta?.category || null;
  if (folder) return FOLDER_TO_GROUP[folder] || groupForUnknown(folder);
  // Repli : nom connu des groupes éditoriaux ? sinon utilitaires.
  return 'utilitaires';
}

function groupForUnknown(folder) {
  const id = normalize(folder).replace(/\s+/g, '-');
  return FOLDER_TO_GROUP[id] || 'utilitaires';
}

function entryFromModule(name, mod) {
  const json = jsonOf(mod?.data) || {};
  const commandName = json.name || name;
  const category = categoryOfModule(mod, commandName);
  return {
    name: commandName,
    description: cleanText(json.description || mod?.meta?.description || '', 180),
    category,
    permissionBits: toBits(json.default_member_permissions),
    permissions: permissionLabels(toBits(json.default_member_permissions)),
    options: Array.isArray(json.options) ? json.options : [],
    subcommands: listSubcommands(json),
    usage: buildUsage(json),
    license: isLicensed(commandName),
    aliases: (COMMAND_ALIASES[commandName] || []).map(normalize),
    // Options et cooldown : affichés dans la fiche pour que le membre sache
    // quoi remplir et à quelle fréquence il peut relancer la commande.
    optionNames: listOptions(json).map(o => normalize(o.name)),
    cooldownMs: Number.isFinite(mod?.meta?.cooldown) ? mod.meta.cooldown : null,
    guildOnly: mod?.meta?.guildOnly === true,
  };
}

/** Noms des options de premier niveau (et de leurs sous-options). */
function listOptions(json) {
  const out = [];
  const walk = (options = []) => {
    for (const opt of Array.isArray(options) ? options : []) {
      if (opt?.name) out.push({ name: opt.name, description: opt.description || '', required: opt.required === true });
      if (opt?.options) walk(opt.options);
    }
  };
  walk(json?.options);
  return out;
}

function buildCategories(entries) {
  const byGroup = new Map();
  for (const entry of entries) {
    if (!byGroup.has(entry.category)) byGroup.set(entry.category, []);
    byGroup.get(entry.category).push(entry);
  }
  return GROUP_META
    .filter(meta => byGroup.has(meta.id))
    .map(meta => ({
      ...meta,
      commands: byGroup.get(meta.id).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    }));
}

/**
 * Construit le catalogue du centre d'aide.
 * @param {{commands?: {values?: Function|Iterable, size?: number}}} client
 * @returns {{categories: Array, entries: Array, byName: Map, total: number, guides: Array, source: string}}
 */
function buildCatalog(client) {
  const entries = [];
  const commands = client?.commands;

  if (commands && typeof commands.values === 'function') {
    for (const mod of commands.values()) {
      const name = mod?.data?.name;
      if (!name) continue;
      entries.push(entryFromModule(name, mod));
    }
  }

  // Repli hors-ligne (tests, scripts) : les commandes sont chargées depuis le
  // disque. On ne l'exécute jamais si le noyau a déjà rempli client.commands.
  if (!entries.length) {
    try {
      const path = require('path');
      const registry = require('../core/registry');
      const { commands: loaded } = registry.loadModules(path.join(__dirname, '..', 'commands'));
      for (const entry of loaded) {
        const name = entry.mod?.data?.name;
        if (!name) continue;
        entries.push(entryFromModule(name, { ...entry.mod, __category: entry.category }));
      }
    } catch { /* catalogue vide : le panel affichera un message honnête */ }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const categories = buildCategories(entries);
  const byName = new Map(entries.map(e => [e.name, e]));

  return {
    entries,
    categories,
    byName,
    total: entries.length,
    guides: GUIDES,
    source: commands?.size ? 'client' : 'disque',
  };
}

// ── Recherche ────────────────────────────────────────────────────────────────
// ── Distance d'édition (tolérance aux fautes de frappe) ─────────────────────
// Bornée : au-delà de `max`, on s'arrête immédiatement. Une recherche d'aide
// n'a pas besoin d'une distance exacte, seulement de « est-ce proche ? ».
function editDistance(a, b, max = 2) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[t.length];
}

/** Le nom (ou un alias) ressemble-t-il à la requête à une ou deux lettres près ? */
function looksLike(entry, q, max = 2) {
  const candidates = [normalize(entry.name), ...entry.aliases];
  return candidates.some(candidate => candidate.length >= 3 && editDistance(candidate, q, max) <= max);
}

function scoreEntry(entry, query) {
  const q = normalize(query);
  if (!q) return 0;
  const name = normalize(entry.name);
  if (name === q) return 100;
  if (name.startsWith(q)) return 85;
  if (entry.aliases.includes(q)) return 80;
  if (name.includes(q)) return 70;
  if (entry.aliases.some(a => a.includes(q))) return 55;
  // Faute de frappe sur le nom : « captcha » écrit « captchaa », « bump » → « bumo ».
  if (looksLike(entry, q)) return 50;
  if (normalize(entry.description).includes(q)) return 40;
  if (entry.subcommands.some(s => normalize(s.name).includes(q))) return 30;
  if ((entry.optionNames || []).some(o => o.includes(q))) return 25;
  const group = GROUP_BY_ID[entry.category];
  if (group && (normalize(group.label).includes(q) || normalize(group.tagline).includes(q))) return 15;
  if (normalize(entry.category).includes(q)) return 12;
  return 0;
}

function scoreGuide(guide, query) {
  const q = normalize(query);
  if (!q) return 0;
  if (normalize(guide.label) === q) return 95;
  if (normalize(guide.label).includes(q)) return 60;
  if (normalize(guide.body).includes(q)) return 25;
  if (normalize(guide.tagline).includes(q)) return 20;
  return 0;
}

function searchCatalog(catalog, rawQuery) {
  const query = normalize(rawQuery);
  if (!query) return { commands: [], guides: [], query: '' };

  // Une requête multi-mots doit matcher chaque mot quelque part : « ticket fermer »
  // ne doit pas renvoyer tout ce qui contient « ticket ».
  const tokens = query.split(' ').filter(Boolean);
  const matchesAll = (text) => tokens.every(t => text.includes(t));

  const commands = [];
  for (const entry of catalog.entries) {
    let score = 0;
    if (tokens.length === 1) score = scoreEntry(entry, query);
    else {
      const haystack = [normalize(entry.name), normalize(entry.description), entry.aliases.join(' ')].join(' ');
      score = matchesAll(haystack) ? 50 : 0;
    }
    if (score > 0) commands.push({ entry, score });
  }
  commands.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name, 'fr'));

  const guides = catalog.guides
    .map(guide => ({ guide, score: scoreGuide(guide, query) }))
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score);

  const result = {
    query,
    commands: commands.map(m => m.entry),
    guides: guides.map(m => m.guide),
    suggestions: commands.slice(0, 25).map(m => m.entry.name),
    didYouMean: [],
  };

  // Aucune correspondance : on cherche les noms les plus proches plutôt que de
  // laisser l'utilisateur devant un « aucun résultat » sec.
  if (!result.commands.length) result.didYouMean = closestNames(catalog, query, 3);
  return result;
}

/**
 * Noms de commandes les plus proches d'une requête (faute de frappe, requête
 * partielle, mot d'une description). Renvoie des noms, pas des entrées.
 */
function closestNames(catalog, query, limit = 3) {
  const q = normalize(query);
  if (!q || !catalog?.entries?.length) return [];
  const words = q.split(' ').filter(t => t.length > 3);

  const scored = catalog.entries.map(entry => {
    const candidates = [normalize(entry.name), ...entry.aliases];
    const distance = Math.min(...candidates.map(c => editDistance(c, q, 4)));
    const near = distance <= 3;
    const prefix = candidates.some(c => c.startsWith(q.slice(0, Math.max(3, Math.floor(q.length / 2)))));
    const description = normalize(entry.description);
    const wordHit = words.length > 0 && words.every(t => description.includes(t));

    // Sans la moindre preuve (nom proche, préfixe, mot de la description), on
    // préfère ne rien proposer : mieux vaut « aucun résultat » qu'un faux ami.
    if (!near && !prefix && !wordHit) return { name: entry.name, score: 0 };
    return {
      name: entry.name,
      score: (4 - Math.min(3, distance)) * 10 + (prefix ? 30 : 0) + (wordHit ? 20 : 0),
    };
  });

  return scored
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr'))
    .slice(0, limit)
    .map(m => m.name);
}

/**
 * Commandes liées à une autre : même catégorie, mots de description partagés,
 * nom proche. Sert au champ « Voir aussi » des fiches — c'est ce qui transforme
 * une fiche isolée en parcours de découverte.
 */
function relatedEntries(catalog, name, limit = 4, { fallback = true } = {}) {
  const key = normalize(name);
  const entry = catalog?.byName?.get(key);
  if (!entry) return [];

  const words = new Set(normalize(entry.description).split(' ').filter(isSignificantWord));
  const scored = catalog.entries
    .filter(other => other.name !== entry.name)
    .map(other => {
      const shared = normalize(other.description).split(' ').filter(w => isSignificantWord(w) && words.has(w));
      let score = Math.min(18, shared.length * 6);
      // Nom proche : seulement une vraie ressemblance (« captcha-logs » pour
      // « captcha »), pas « n'importe quel nom à moins de six lettres près ».
      const otherName = normalize(other.name);
      const distance = editDistance(otherName, key, 3);
      if (distance <= 2 || otherName.startsWith(key) || key.startsWith(otherName)) score += 8;
      if (other.aliases.some(alias => entry.aliases.includes(alias))) score += 8;
      // La catégorie commune n'est qu'un bonus : sinon les 37 commandes de
      // configuration seraient toutes « liées » les unes aux autres.
      if (score > 0 && other.category === entry.category) score += 4;
      return { entry: other, score };
    })
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name, 'fr'));

  if (scored.length) return scored.slice(0, limit).map(m => m.entry);

  // Aucune affinité détectée (descriptions très différentes) : on montre au
  // moins les voisines de la même catégorie, plutôt qu'un champ vide.
  if (!fallback) return [];
  return catalog.entries
    .filter(other => other.name !== entry.name && other.category === entry.category)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
    .slice(0, Math.min(limit, 3));
}

// Mots trop génériques pour rapprocher deux commandes.
const STOPWORDS = new Set([
  'commande', 'commandes', 'serveur', 'serveurs', 'salon', 'salons', 'membre', 'membres',
  'système', 'systeme', 'permet', 'configurer', 'configuration', 'gérer', 'gerer', 'affiche',
  'ouvre', 'panel', 'options', 'option', 'discord', 'rezo', 'module', 'modules', 'action',
  'paramètres', 'parametres', 'dernière', 'derniere', 'toutes', 'tous', 'avec', 'pour',
]);

function isSignificantWord(word) {
  return word.length > 4 && !STOPWORDS.has(word);
}

function resolveCategoryAlias(catalog, rawQuery) {
  const key = normalize(rawQuery);
  const id = CATEGORY_ALIASES[key];
  if (!id && key === 'aide') return null;
  const target = id || (GROUP_BY_ID[key] ? key : null);
  if (!target) return null;
  return catalog.categories.find(c => c.id === target) || null;
}

// ── Divers ───────────────────────────────────────────────────────────────────
function formatUptime(ms = 0) {
  const s = Math.floor(Number(ms) / 1000) || 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function accessibleCount(catalog, member) {
  return catalog.entries.filter(entry => canUse(entry, member)).length;
}

module.exports = {
  GROUP_META,
  GROUP_BY_ID,
  GUIDES,
  GUIDE_BY_ID,
  COMMAND_ALIASES,
  CATEGORY_ALIASES,
  PERMISSION_FR,
  buildCatalog,
  entryFromModule,
  buildCategories,
  normalize,
  cleanText,
  toBits,
  permissionLabels,
  canUse,
  buildUsage,
  listSubcommands,
  isLicensed,
  licensedCommands,
  searchCatalog,
  scoreEntry,
  scoreGuide,
  editDistance,
  looksLike,
  closestNames,
  relatedEntries,
  listOptions,
  resolveCategoryAlias,
  formatUptime,
  accessibleCount,
  jsonOf,
};
