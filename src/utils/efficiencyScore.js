'use strict';
// utils/efficiencyScore.js — Moteur de score d'efficacité d'un serveur.
//
// « Efficace à 90% » = le bot couvre réellement 90% de ce qu'un serveur doit
// avoir (sécurité, accueil, gestion, croissance, automatisation). Ce module
// compare l'état RÉEL d'un serveur à un catalogue de modules pondérés et
// renvoie un pourcentage, une note et des recommandations actionnables.
//
// Entièrement PUR : aucune requête, aucun accès Discord — il reçoit un objet
// `state` déjà collecté (voir utils/efficiencyState.js). C'est ce qui permet de
// le tester exhaustivement et de l'exécuter en quelques microsecondes.

const { GOAL_PERCENT, clampPercent, grade } = require('./brand');

// ── Catégories pondérées ────────────────────────────────────────────────────
// Le poids de catégorie exprime l'importance réelle pour la santé du serveur :
// sans sécurité ni accueil, les autres modules ne servent à rien.
const CATEGORIES = [
  { key: 'securite',       label: 'Sécurité',              emoji: '🛡️', weight: 30, hint: 'Protéger le serveur des raids, scams et spam' },
  { key: 'communaute',     label: 'Accueil & communauté',  emoji: '👋', weight: 25, hint: 'Bien accueillir et faire vivre les membres' },
  { key: 'gestion',        label: 'Gestion & support',     emoji: '🧰', weight: 20, hint: 'Outiller le staff (logs, tickets, signalements)' },
  { key: 'croissance',     label: 'Croissance & annonces', emoji: '📣', weight: 15, hint: 'Faire connaître et grandir le serveur' },
  { key: 'automatisation', label: 'Automatisation',        emoji: '⚙️', weight: 10, hint: 'Ce qui tourne sans intervention du staff' },
];

// ── Helpers d'inspection d'un document Mongoose (lean) ──────────────────────
// Beaucoup de configurations sont imbriquées (ex. ServerProtection.antiRaid),
// ces deux helpers évitent d'écrire une condition par sous-champ.
function anyEnabled(value, depth = 4, seen = new Set()) {
  if (!value || depth < 0 || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(v => anyEnabled(v, depth - 1, seen));
  for (const [k, v] of Object.entries(value)) {
    if (k === '_id' || k === '__v') continue;
    if (k === 'enabled' || k === 'active') { if (v === true) return true; continue; }
    if (anyEnabled(v, depth - 1, seen)) return true;
  }
  return false;
}

function anyChannel(value, depth = 4, seen = new Set()) {
  if (!value || depth < 0 || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(v => anyChannel(v, depth - 1, seen));
  for (const [k, v] of Object.entries(value)) {
    if (k === '_id' || k === '__v') continue;
    if (/Id$/.test(k) && typeof v === 'string' && v.length > 0
        && !/^(guildId|userId|networkId|zoneId|messageId|lastMessageId|lastUserId|backupId)$/.test(k)) {
      return true;
    }
    if (anyChannel(v, depth - 1, seen)) return true;
  }
  return false;
}

const on  = v => v === true;
const set = v => v !== null && v !== undefined && v !== '' && (!Array.isArray(v) || v.length > 0);

// ── Catalogue des modules ───────────────────────────────────────────────────
// auto: true  → l'autopilote sait l'activer seul avec des valeurs sûres
// auto: false → demande un choix humain (salon, rôle, compte externe…)
// fix         → commande/panneau à utiliser pour le faire à la main
const MODULES = [
  // ── Sécurité ──────────────────────────────────────────────────────────────
  { key: 'antiRaid', label: 'Anti-raid', category: 'securite', weight: 2, auto: true,
    fix: '/antiraid', hint: 'Détection et neutralisation des raids',
    check: s => on(s.antiRaid?.enabled) },
  { key: 'captcha', label: 'Captcha', category: 'securite', weight: 2, auto: false,
    fix: '/captcha', hint: 'Vérification humaine à l\'arrivée (salon + rôle requis)',
    check: s => on(s.captcha?.enabled) && set(s.captcha?.channelId) },
  { key: 'automod', label: 'Auto-modération', category: 'securite', weight: 2, auto: true,
    fix: '/securite', hint: 'Anti-spam, anti-liens, anti-caps automatique',
    check: s => !!s.automod && (on(s.automod.spamEnabled) || on(s.automod.raidEnabled)
      || on(s.automod.linksEnabled) || on(s.automod.capsEnabled)) },
  { key: 'antiscam', label: 'Anti-scam', category: 'securite', weight: 2, auto: true,
    fix: '/antiscam', hint: 'Détection des arnaques et liens dangereux',
    check: s => on(s.antiScam?.enabled) },
  { key: 'warnPaliers', label: 'Paliers d\'avertissement', category: 'securite', weight: 1, auto: true,
    fix: '/mod paliers ajouter', hint: 'Sanctions automatiques par nombre de warns',
    check: s => Array.isArray(s.warnThresholds?.thresholds) && s.warnThresholds.thresholds.length > 0 },
  { key: 'honeypot', label: 'Honeypot', category: 'securite', weight: 1, auto: false,
    fix: '/honeypot', hint: 'Salon piège : tout bot qui y écrit est banni',
    check: s => on(s.honeypot?.enabled) },
  { key: 'automodAdvanced', label: 'Auto-modération avancée', category: 'securite', weight: 1, auto: false,
    fix: '/securite', hint: 'Règles fines (mentions, majuscules, seuils)',
    check: s => anyEnabled(s.automodAdvanced) },
  { key: 'protection', label: 'Protection serveur', category: 'securite', weight: 1, auto: false,
    fix: '/securite', hint: 'Anti-bot, anti-permissions dangereuses, quarantaine',
    check: s => anyEnabled(s.protection) },

  // ── Accueil & communauté ─────────────────────────────────────────────────
  { key: 'welcome', label: 'Message de bienvenue', category: 'communaute', weight: 2, auto: true,
    fix: '/welcome', hint: 'Accueillir chaque nouveau membre',
    check: s => on(s.welcome?.enabled) && set(s.welcome?.channelId) },
  { key: 'xp', label: 'Niveaux & XP', category: 'communaute', weight: 2, auto: true,
    fix: '/leveling', hint: 'Récompenser l\'activité des membres',
    check: s => on(s.xp?.enabled) },
  { key: 'onboarding', label: 'Portail d\'accès', category: 'communaute', weight: 2, auto: false,
    fix: '/onboarding', hint: 'Questions obligatoires avant l\'accès au serveur',
    check: s => on(s.onboarding?.enabled) },
  { key: 'farewell', label: 'Message de départ', category: 'communaute', weight: 1, auto: true,
    fix: '/farewell-set', hint: 'Suivre les départs de membres',
    check: s => on(s.farewell?.enabled) && set(s.farewell?.channelId) },
  { key: 'autorole', label: 'Autorôle', category: 'communaute', weight: 1, auto: true,
    fix: '/autorole', hint: 'Attribuer un rôle automatiquement à l\'arrivée',
    check: s => on(s.autorole?.enabled) && set(s.autorole?.roleId) },
  { key: 'anniversaire', label: 'Anniversaires', category: 'communaute', weight: 1, auto: true,
    fix: '/anniversaire-config', hint: 'Souhaiter les anniversaires automatiquement',
    check: s => on(s.birthday?.enabled) && set(s.birthday?.channelId) },
  { key: 'starboard', label: 'Starboard', category: 'communaute', weight: 1, auto: true,
    fix: '/starboard', hint: 'Mettre en avant les meilleurs messages',
    check: s => on(s.starboard?.enabled) && set(s.starboard?.channelId) },
  { key: 'counting', label: 'Jeu de comptage', category: 'communaute', weight: 1, auto: true,
    fix: '/counting-panel', hint: 'Animation collective permanente',
    check: s => on(s.counting?.enabled) && set(s.counting?.channelId) },
  { key: 'reputation', label: 'Réputation', category: 'communaute', weight: 1, auto: true,
    fix: '/setting', hint: 'Les membres se recommandent entre eux',
    check: s => on(s.reputation?.enabled) },
  { key: 'boost', label: 'Remerciement boosts', category: 'communaute', weight: 1, auto: false,
    fix: '/boost', hint: 'Annoncer et remercier les boosts du serveur',
    check: s => on(s.boost?.enabled) },

  // ── Gestion & support ────────────────────────────────────────────────────
  { key: 'logs', label: 'Logs serveur', category: 'gestion', weight: 2, auto: true,
    fix: null, hint: 'Journal des arrivées, départs et suppressions',
    check: s => !!s.logs && ['moderation', 'membres', 'messages', 'vocal']
      .some(k => on(s.logs[k]?.enabled) && set(s.logs[k]?.channelId)) },
  { key: 'tickets', label: 'Tickets', category: 'gestion', weight: 2, auto: false,
    fix: '/ticket', hint: 'Support privé entre membres et staff',
    check: s => on(s.tickets?.enabled) },
  { key: 'modmail', label: 'Modmail', category: 'gestion', weight: 1, auto: false,
    fix: '/modmail', hint: 'Boîte de réception style e-mail pour le staff',
    check: s => on(s.modmail?.enabled) },
  { key: 'signalement', label: 'Signalements', category: 'gestion', weight: 1, auto: true,
    fix: '/signalement', hint: 'Les membres alertent le staff discrètement',
    check: s => on(s.signalement?.enabled) && set(s.signalement?.logChannelId) },
  { key: 'reglement', label: 'Règlement', category: 'gestion', weight: 1, auto: false,
    fix: '/reglement', hint: 'Règles publiées et acceptables en un clic',
    check: s => set(s.reglement?.channelId) },
  { key: 'faq', label: 'FAQ', category: 'gestion', weight: 1, auto: false,
    fix: '/faq', hint: 'Réponses rapides aux questions récurrentes',
    check: s => Number(s.faqCount) > 0 },
  { key: 'mpRequest', label: 'Demandes de MP', category: 'gestion', weight: 1, auto: false,
    fix: '/demande-mp', hint: 'Ouvrir un fil privé avec la modération',
    check: s => on(s.mpRequest?.enabled) && set(s.mpRequest?.channelId) },
  { key: 'voice', label: 'Salons vocaux', category: 'gestion', weight: 1, auto: false,
    fix: '/setting', hint: 'Salons vocaux temporaires automatiques',
    check: s => anyEnabled(s.voice) },
  { key: 'prefix', label: 'Commandes préfixe', category: 'gestion', weight: 1, auto: false,
    fix: '/prefix', hint: 'Utiliser le bot sans slash-command',
    check: s => on(s.prefix?.enabled) },

  // ── Croissance & annonces ────────────────────────────────────────────────
  { key: 'bump', label: 'Réseau de bump', category: 'croissance', weight: 2, auto: false,
    fix: '/setting', hint: 'Faire découvrir le serveur via les bumps',
    check: s => set(s.server?.bumpChannelId) && on(s.server?.reminderEnabled) },
  { key: 'partenariats', label: 'Partenariats', category: 'croissance', weight: 1, auto: true,
    fix: '/partenariat-config', hint: 'Annoncer automatiquement les partenariats',
    check: s => set(s.server?.partnerChannelId) },
  { key: 'notifications', label: 'Notifications auto', category: 'croissance', weight: 1, auto: true,
    fix: '/notifications', hint: 'Jeux gratuits, giveaways, nouveautés',
    check: s => anyChannel(s.notif) },
  { key: 'autoMessage', label: 'Messages automatiques', category: 'croissance', weight: 1, auto: false,
    fix: '/setting', hint: 'Annonces récurrentes programmées',
    check: s => Number(s.autoMessageCount) > 0 },
  { key: 'youtube', label: 'Alertes YouTube', category: 'croissance', weight: 1, auto: false,
    fix: '/youtube-sub', hint: 'Prévenir quand une chaîne publie / passe un palier',
    check: s => on(s.youtube?.enabled) && set(s.youtube?.channelId) },
  { key: 'stream', label: 'Alertes stream', category: 'croissance', weight: 1, auto: false,
    fix: '/streamalerts', hint: 'Annoncer les lives Twitch et YouTube',
    check: s => on(s.stream?.enabled) },
  { key: 'reddit', label: 'Annonces Reddit', category: 'croissance', weight: 1, auto: false,
    fix: '/reddit-annonce', hint: 'Republier automatiquement un subreddit',
    check: s => on(s.reddit?.enabled) },
  { key: 'recap', label: 'Récap hebdomadaire', category: 'croissance', weight: 1, auto: true,
    fix: '/recap', hint: 'Résumé d\'activité publié chaque semaine',
    check: s => on(s.recap?.enabled) && set(s.recap?.channelId) },
  { key: 'shop', label: 'Boutique', category: 'croissance', weight: 1, auto: false,
    fix: '/shop', hint: 'Dépenser les coins gagnés dans le serveur',
    check: s => Number(s.shopCount) > 0 },

  // ── Automatisation ───────────────────────────────────────────────────────
  { key: 'autothread', label: 'Threads automatiques', category: 'automatisation', weight: 1, auto: true,
    fix: '/autothread', hint: 'Créer un fil sous chaque message d\'un salon',
    check: s => on(s.autothread?.enabled) },
  { key: 'forumWelcome', label: 'Accueil des forums', category: 'automatisation', weight: 1, auto: true,
    fix: '/forumwelcome', hint: 'Message d\'accueil automatique sur les posts forum',
    check: s => on(s.forumWelcome?.enabled) && set(s.forumWelcome?.forumChannelId) },
  { key: 'invites', label: 'Suivi des invitations', category: 'automatisation', weight: 1, auto: true,
    fix: '/invites-config', hint: 'Savoir qui a invité qui',
    check: s => on(s.invites?.enabled) },
  { key: 'botwatch', label: 'Surveillance de bots', category: 'automatisation', weight: 1, auto: false,
    fix: '/botwatch', hint: 'Être alerté quand un bot est ajouté ou change',
    check: s => Number(s.watchedBotCount) > 0 },
  { key: 'backup', label: 'Sauvegardes', category: 'automatisation', weight: 1, auto: false,
    fix: '/setting', hint: 'Sauvegarder rôles et salons du serveur',
    check: s => Number(s.backupCount) > 0 },
  { key: 'rescue', label: 'Récupération de serveur', category: 'automatisation', weight: 1, auto: false,
    fix: '/setuprescue', hint: 'Reprendre le contrôle du serveur en cas de piratage',
    check: s => on(s.rescue?.enabled) },
  { key: 'ai', label: 'Assistant IA', category: 'automatisation', weight: 1, auto: false,
    fix: '/ia', hint: 'IA intégrée au serveur',
    check: s => on(s.ai?.enabled) },
];

const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

function modulesByCategory(categoryKey) {
  return MODULES.filter(m => m.category === categoryKey);
}

// ── Calcul du score ─────────────────────────────────────────────────────────
function computeScore(state = {}) {
  const modules = MODULES.map(m => {
    let ok = false;
    try { ok = !!m.check(state); } catch { ok = false; }
    return {
      key: m.key, label: m.label, category: m.category, weight: m.weight,
      auto: m.auto, fix: m.fix, hint: m.hint, ok,
    };
  });

  const categories = CATEGORIES.map(c => {
    const mine   = modules.filter(m => m.category === c.key);
    const total  = mine.reduce((a, m) => a + m.weight, 0);
    const earned = mine.reduce((a, m) => a + (m.ok ? m.weight : 0), 0);
    return {
      key: c.key, label: c.label, emoji: c.emoji, weight: c.weight, hint: c.hint,
      total, earned, enabled: mine.filter(m => m.ok).length, count: mine.length,
      missing: mine.filter(m => !m.ok).length,
      percent: total ? clampPercent((earned / total) * 100) : 0,
      modules: mine,
    };
  });

  const totalWeight  = modules.reduce((a, m) => a + m.weight, 0);
  const earnedWeight = modules.reduce((a, m) => a + (m.ok ? m.weight : 0), 0);
  const percent      = totalWeight ? clampPercent((earnedWeight / totalWeight) * 100) : 0;

  // Recommandations : les manques les plus lourds d'abord (poids catégorie × module)
  const missing = modules
    .filter(m => !m.ok)
    .sort((a, b) => (CATEGORY_BY_KEY[b.category].weight * b.weight)
                  - (CATEGORY_BY_KEY[a.category].weight * a.weight)
                  || a.label.localeCompare(b.label));

  const gradeInfo = grade(percent);

  return {
    guildId: state.guildId || null,
    percent,
    goal: GOAL_PERCENT,
    reached: percent >= GOAL_PERCENT,
    grade: gradeInfo,
    totalWeight,
    earnedWeight,
    activeCount: modules.filter(m => m.ok).length,
    moduleCount: modules.length,
    modules,
    categories,
    missing,
    recommendations: missing.slice(0, 8),
    autoFixable: missing.filter(m => m.auto),
    manualFixable: missing.filter(m => !m.auto),
    // Ce que l'autopilote pourrait encore gagner, en points de pourcentage.
    autoGain: totalWeight
      ? clampPercent((missing.filter(m => m.auto).reduce((a, m) => a + m.weight, 0) / totalWeight) * 100)
      : 0,
  };
}

// Distance restante jusqu'à l'objectif (0 si atteint).
function gapToGoal(percent) {
  return Math.max(0, GOAL_PERCENT - clampPercent(percent));
}

module.exports = {
  CATEGORIES,
  MODULES,
  CATEGORY_BY_KEY,
  GOAL_PERCENT,
  modulesByCategory,
  computeScore,
  gapToGoal,
  anyEnabled,
  anyChannel,
};
