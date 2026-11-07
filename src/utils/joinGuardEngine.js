'use strict';
// utils/joinGuardEngine.js — Logique métier pure du contrôle à l'arrivée (Vigie).
//
// Aucune dépendance Discord ni MongoDB : tout est testable hors-ligne
// (voir tests/join-guard-smoke.js). L'orchestration Discord vit dans
// src/utils/joinGuardActions.js, la configuration dans src/models/JoinGuard.js
// et le branchement dans src/events/membres/antijoin.js.

const MAX_RECENT = 25;

// ─── Motifs ──────────────────────────────────────────────────────────────────
// Caractères invisibles / de contrôle utilisés pour tromper l'œil humain
// (largeur nulle, espaces invisibles, inversion d'écriture…).
const INVISIBLE_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;
// Diacritiques empilés (zalgo) : accents combinants en surnombre.
const COMBINING_RE = /[\u0300-\u036F\u0483-\u0489\u1AB0-\u1AFF\u20D0-\u20FF]/g;
// Invitations Discord glissées dans un pseudo (« discord.gg », « discord com »,
// « invite.gg »…). Volontairement tolérant sur les séparateurs : les faux
// comptes les utilisent pour contourner les filtres textuels.
const INVITE_RE = /(discord\s*[.,]?\s*(gg|me|io|com)|dsc\.gg|invite\.gg|gift\.gg|discordapp)/i;
// Mentions de masse déguisées dans un pseudo.
const MASS_MENTION_RE = /@\s*(everyone|here)\b/i;

// Vocabulaire d'arnaque classique des faux comptes de raid.
const SCAM_WORDS = [
  'nitro', 'freenitro', 'freegift', 'gift', 'steam', 'robux', 'vbucks', 'crash',
  'cheat', 'hack', 'crypto', 'bitcoin', 'airdrop', 'casino', 'bet', 'porn',
  'nsfw', 'onlyfans', 'sextape', 'leak', 'giveaway', 'drop', 'gratuit',
];
// Vocabulaire d'usurpation : un membre qui se fait passer pour l'équipe.
const IMPERSONATION_WORDS = [
  'admin', 'administrateur', 'administrator', 'moderateur', 'moderator', 'modo',
  'staff', 'owner', 'fondateur', 'founder', 'support', 'official', 'officiel',
  'manager', 'root', 'hoster', 'helper',
];
// Substitutions usuelles utilisées pour contourner les filtres.
const HOMOGLYPHS = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '|': 'l', '!': 'i' };

const CHECKS = ['accountAge', 'noAvatar', 'inviteLink', 'scamWords', 'impersonation', 'invisible', 'repeatedChars'];

const LABELS = {
  trusted:      'membre de confiance (jamais contrôlé)',
  bot:          'compte bot',
  blacklist:    'utilisateur sur la liste noire',
  accountAge:   'compte créé récemment',
  noAvatar:     'aucun avatar (avatar par défaut)',
  inviteLink:   'invitation Discord dans le pseudo',
  scamWords:    'vocabulaire d\'arnaque dans le pseudo',
  impersonation:'usurpation de l\'équipe (admin, modo, staff…)',
  invisible:    'caractères invisibles ou empilés dans le pseudo',
  repeatedChars:'caractères répétés en masse (pseudo de bot)',
  massMention:  'mention de masse déguisée dans le pseudo',
};

// Points par motif déclenché (le total devient le score du profil).
const POINTS = {
  accountAge: 30, noAvatar: 15, inviteLink: 40, scamWords: 35, impersonation: 25,
  invisible: 20, repeatedChars: 15, massMention: 20, blacklist: 100,
};
const SEVERITY = {
  blacklist: 'critique', inviteLink: 'critique', scamWords: 'critique',
  accountAge: 'eleve', impersonation: 'eleve', invisible: 'eleve',
  noAvatar: 'moyen', repeatedChars: 'moyen', massMention: 'eleve',
};

const DEFAULT_THRESHOLDS = { blockScore: 40, reviewScore: 20, minAccountAgeDays: 7 };

function escapeRegex(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Retire les caractères invisibles (et les remplace par rien). */
function stripInvisible(text) { return String(text ?? '').replace(INVISIBLE_RE, ''); }

/** Le pseudo contient-il des caractères invisibles ? */
function hasInvisible(text) {
  const raw = String(text ?? '');
  INVISIBLE_RE.lastIndex = 0;
  return INVISIBLE_RE.test(raw);
}

/**
 * Normalise un pseudo pour l'analyse : minuscules, sans accents, sans
 * caractères invisibles, homoglyphes ramenés à la lettre d'origine.
 */
function foldName(text) {
  const base = stripInvisible(String(text ?? ''))
    .normalize('NFKD')
    .replace(COMBINING_RE, '')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  return base.replace(/[0-9@$|!]/g, ch => HOMOGLYPHS[ch] ?? ch);
}

/** Découpe un pseudo en mots (séparateurs : tout ce qui n'est pas alphanumérique). */
function tokens(text) {
  return foldName(text).split(/[^a-z]+/).filter(Boolean);
}

/** Nombre de diacritiques combinants (zalgo) dans le pseudo. */
function countCombining(text) {
  const raw = String(text ?? '');
  COMBINING_RE.lastIndex = 0;
  return (raw.match(COMBINING_RE) || []).length;
}

/** Le pseudo contient-il une suite de `run` fois le même caractère ? */
function hasRepeatedChars(text, run = 6) {
  const folded = stripInvisible(String(text ?? '')).toLowerCase();
  return new RegExp(`(.)\\1{${Math.max(2, run) - 1},}`).test(folded);
}

/**
 * Mots d'une liste trouvés dans le pseudo.
 * La comparaison se fait par mot (un pseudo « free_nitro_x » contient « nitro »),
 * et les mots listés dans `exceptions` sont ignorés.
 * @param {string} text
 * @param {string[]} words
 * @param {string[]} [exceptions]
 * @returns {string[]} mots trouvés
 */
function findWords(text, words = [], exceptions = []) {
  if (!words.length) return [];
  const folded = foldName(text);
  const tokensList = tokens(text);
  const allowed = new Set(exceptions.map(w => foldName(w)));
  const found = [];
  for (const word of words) {
    const needle = foldName(word);
    if (!needle) continue;
    if (allowed.has(needle)) continue;
    const inToken = tokensList.some(t => t.includes(needle) && !allowed.has(t));
    if (inToken || folded.includes(needle)) found.push(String(word));
  }
  return found;
}

/** Invitation Discord présente dans un texte ? */
function hasInvite(text) { return INVITE_RE.test(stripInvisible(String(text ?? ''))); }

/** Mention de masse déguisée (@everyone / @here) ? */
function hasMassMention(text) { return MASS_MENTION_RE.test(stripInvisible(String(text ?? ''))); }

/** Le membre est-il hors contrôle (propriétaire, bot, listes de confiance) ? */
function isTrustedSubject(config = {}, subject = {}) {
  const { userId, roleIds = [], guildOwnerId = null, clientId = null, isBot = false } = subject;
  if (isBot) return { trusted: true, reason: 'bot' };
  if (!userId) return { trusted: false, reason: null };
  if (clientId && userId === clientId) return { trusted: true, reason: 'trusted' };
  if (guildOwnerId && userId === guildOwnerId) return { trusted: true, reason: 'trusted' };
  if ((config.trustedUsers || []).includes(userId)) return { trusted: true, reason: 'trusted' };
  const trustedRoles = config.trustedRoles || [];
  const matched = (roleIds || []).find(id => trustedRoles.includes(id));
  return matched ? { trusted: true, reason: 'trusted' } : { trusted: false, reason: null };
}

/** Seuils effectifs (valeurs par défaut si la config est incomplète). */
function effectiveThresholds(config = {}) {
  const num = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
  return {
    blockScore: num(config.blockScore, DEFAULT_THRESHOLDS.blockScore),
    reviewScore: num(config.reviewScore, DEFAULT_THRESHOLDS.reviewScore),
    minAccountAgeDays: num(config.minAccountAgeDays, DEFAULT_THRESHOLDS.minAccountAgeDays),
  };
}

/** Action à appliquer selon le niveau du profil. */
function decideAction(config = {}, level = 'safe') {
  if (level === 'danger') return config.actionBlock || 'log';
  if (level === 'suspect') return config.actionReview || 'log';
  return 'allow';
}

/**
 * Analyse un profil qui vient de rejoindre le serveur.
 *
 * @param {{ userId?:string, username?:string, displayName?:string, accountAgeDays?:number,
 *           hasAvatar?:boolean, isBot?:boolean, roleIds?:string[], blacklisted?:boolean }} profile
 * @param {Object} config — configuration JoinGuard du serveur
 * @param {{ guildOwnerId?:string|null, clientId?:string|null }} [ctx]
 * @returns {{ level:'safe'|'suspect'|'danger', score:number, action:string,
 *             reasons:Array<{code:string,label:string,severity:string,points:number,details?:string[]}>,
 *             trusted:boolean }}
 */
function analyzeJoin(profile = {}, config = {}, ctx = {}) {
  const trust = isTrustedSubject(config, {
    userId: profile.userId,
    roleIds: profile.roleIds,
    guildOwnerId: ctx.guildOwnerId,
    clientId: ctx.clientId,
    isBot: profile.isBot,
  });

  if (trust.trusted) {
    return { level: 'safe', score: 0, action: 'allow', trusted: true, reasons: [] };
  }

  const checks = config.checks || {};
  const { blockScore, reviewScore, minAccountAgeDays } = effectiveThresholds(config);
  const enabled = (name) => checks[name] !== false;
  const reasons = [];
  const add = (code, details) => reasons.push({
    code,
    label: LABELS[code] || code,
    severity: SEVERITY[code] || 'moyen',
    points: POINTS[code] || 0,
    ...(details?.length ? { details } : {}),
  });

  // Liste noire : décision immédiate, aucun cumul de score.
  if (profile.blacklisted) {
    add('blacklist');
    return { level: 'danger', score: POINTS.blacklist, action: decideAction(config, 'danger'), trusted: false, reasons };
  }

  const username = profile.username ?? '';
  const displayName = profile.displayName ?? '';
  const label = `${username} ${displayName}`.trim();

  if (enabled('accountAge') && minAccountAgeDays > 0) {
    const age = Number(profile.accountAgeDays);
    if (Number.isFinite(age) && age < minAccountAgeDays) add('accountAge');
  }
  if (enabled('noAvatar') && profile.hasAvatar === false) add('noAvatar');
  if (enabled('inviteLink') && (hasInvite(username) || hasInvite(displayName))) add('inviteLink');
  if (enabled('impersonation')) {
    const matches = findWords(label, IMPERSONATION_WORDS, config.allowedWords);
    if (matches.length) add('impersonation', matches);
  }
  if (enabled('scamWords')) {
    const matches = findWords(label, [...SCAM_WORDS, ...(config.blockedWords || [])], config.allowedWords);
    if (matches.length) add('scamWords', matches);
  }
  if (enabled('invisible')) {
    const combining = countCombining(label);
    if (hasInvisible(username) || hasInvisible(displayName)) add('invisible', ['caractères de largeur nulle']);
    else if (combining >= 6) add('invisible', [`${combining} diacritiques empilés`]);
  }
  if (enabled('repeatedChars') && (hasRepeatedChars(username) || hasRepeatedChars(displayName))) add('repeatedChars');
  if (hasMassMention(label)) add('massMention');

  const score = reasons.reduce((sum, r) => sum + r.points, 0);

  // `jail` et `captcha` sont des réponses *à l'âge du compte* : quand le serveur
  // en choisit une, un compte trop récent suffit à la déclencher (sinon un
  // compte de 2 jours resterait « à surveiller » et n'irait jamais en salle
  // d'attente). Les autres actions gardent la règle du score : on ne change
  // jamais le comportement d'un serveur configuré avec `kick`/`ban`/`log`.
  const agePolicy = ['jail', 'captcha'].includes(config.actionBlock);
  const ageDecisive = agePolicy && reasons.some(r => r.code === 'accountAge');
  const level = ageDecisive ? 'danger'
    : (score >= blockScore ? 'danger' : (score >= reviewScore ? 'suspect' : 'safe'));
  return { level, score, action: decideAction(config, level), trusted: false, reasons };
}

const LEVEL_ICONS = { safe: '✅', suspect: '🟡', danger: '⛔' };
const LEVEL_LABELS = { safe: 'Profil normal', suspect: 'Profil à surveiller', danger: 'Profil dangereux' };

/** Ligne lisible d'une décision (pour les embeds). */
function formatDecision(decision = {}) {
  const when = decision.at ? `<t:${Math.floor(new Date(decision.at).getTime() / 1000)}:R>` : '';
  const who = decision.userId ? `<@${decision.userId}> (\`${decision.userTag || decision.userId}\`)` : 'inconnu';
  const reasons = (decision.reasons || []).join(' · ') || 'aucun motif';
  return `${LEVEL_ICONS[decision.level] || '•'} ${who} — score **${decision.score ?? 0}** → \`${decision.action || 'allow'}\` ${when}\n    └ ${reasons}`;
}

/** Ajoute une décision en gardant les MAX_RECENT plus récentes. */
function capRecent(list = [], limit = MAX_RECENT) {
  const items = Array.isArray(list) ? [...list] : [];
  return items.length > limit ? items.slice(items.length - limit) : items;
}

module.exports = {
  MAX_RECENT,
  CHECKS,
  LABELS,
  POINTS,
  SEVERITY,
  LEVEL_ICONS,
  LEVEL_LABELS,
  DEFAULT_THRESHOLDS,
  SCAM_WORDS,
  IMPERSONATION_WORDS,
  HOMOGLYPHS,
  escapeRegex,
  stripInvisible,
  hasInvisible,
  foldName,
  tokens,
  countCombining,
  hasRepeatedChars,
  findWords,
  hasInvite,
  hasMassMention,
  isTrustedSubject,
  effectiveThresholds,
  decideAction,
  analyzeJoin,
  formatDecision,
  capRecent,
};
