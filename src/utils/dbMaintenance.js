'use strict';
// utils/dbMaintenance.js — Entretien de la base : ce qui vieillit est supprimé,
// ce qui est cherché est indexé, et l'état réel est mesurable.
//
// Pourquoi ce module existe : MongoDB ne grossit pas à cause du bot, il grossit
// à cause des documents que plus personne ne lit — un historique de bump de
// l'an dernier, 300 000 lignes de logs captcha, des conversations IA abandonnées,
// des rappels terminés, des invitations de membres partis. Ces données coûtent
// du disque à chaque sauvegarde, ralentissent les requêtes et finissent par
// coûter de l'argent chez l'hébergeur.
//
// Ici, chaque famille de documents déclare sa DURÉE DE VIE. Le cron quotidien
// (`src/crons/dbMaintenance.js`) applique ces règles ; le panel `/help` →
// Diagnostic montre ce qui est stocké, ce qui est nettoyable et quand le dernier
// passage a eu lieu. Aucune règle ne touche à la configuration d'un serveur :
// seuls les journaux et les états transitoires expirent.
//
// Le module est volontairement découplé de mongoose pour être testable hors
// ligne : `runMaintenance({ models })` accepte n'importe quel objet possédant
// `deleteMany` / `countDocuments`.

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Règles de rétention ──────────────────────────────────────────────────────
// `days` = âge au-delà duquel le document n'a plus d'utilité.
// `filter(now)` peut restreindre la suppression (ex. uniquement les tickets
// fermés) : une ligne encore utile ne doit jamais disparaître.
const RULES = [
  {
    id: 'ai-conversations',
    label: 'Conversations IA',
    collection: 'aiconversations',
    path: '../models/AiConversation',
    days: 30,
    field: 'updatedAt',
    description: 'Historique brut des échanges avec l\'IA (la mémoire longue est conservée séparément).',
  },
  {
    id: 'ai-daily-stats',
    label: 'Statistiques IA journalières',
    collection: 'aidailystats',
    path: '../models/AiDailyStats',
    days: 90,
    dateString: 'date',
    description: 'Compteurs par jour : 90 jours suffisent pour les graphiques du panel.',
  },
  {
    id: 'ai-memory',
    label: 'Mémoires IA',
    collection: 'aimemories',
    path: '../models/AiMemory',
    days: 180,
    field: 'lastSeenAt',
    description: 'Mémoire longue d\'un membre inactif depuis six mois.',
  },
  {
    id: 'bump-history',
    label: 'Historique des bumps',
    collection: 'bumphistories',
    path: '../models/BumpHistory',
    days: 120,
    field: 'createdAt',
    description: 'Chaque bump est journalisé : au-delà de quatre mois, seul le total compte.',
  },
  {
    id: 'captcha-logs',
    label: 'Journaux captcha',
    collection: 'captchallogs',
    path: '../models/Captcha',
    pick: 'CaptchaLog',
    days: 30,
    field: 'date',
    description: 'Traces de vérification (envoi, échec, expulsion) : 30 jours pour les litiges.',
  },
  {
    id: 'captcha-pending',
    label: 'Captchas en attente',
    collection: 'captchapendings',
    path: '../models/Captcha',
    pick: 'CaptchaPending',
    days: 0,
    field: 'expiresAt',
    description: 'Vérifications expirées restées en base après un redémarrage.',
  },
  {
    id: 'honeypot-triggers',
    label: 'Déclenchements honeypot',
    collection: 'honeypottriggers',
    path: '../models/HoneypotTrigger',
    days: 120,
    field: 'triggeredAt',
    description: 'Qui a cliqué sur le piège, quand et quelle sanction a suivi.',
  },
  {
    id: 'invite-uses',
    label: 'Invitations de membres partis',
    collection: 'inviteuses',
    path: '../models/InviteUse',
    days: 180,
    field: 'leftAt',
    extra: { left: true },
    description: 'Entrées des membres qui ont quitté depuis plus de six mois.',
  },
  {
    id: 'modmail-threads',
    label: 'Tickets ModMail fermés',
    collection: 'modmailthreads',
    path: '../models/ModMail',
    pick: 'ModMailThread',
    days: 180,
    field: 'closedAt',
    extra: { status: 'closed' },
    description: 'Conversations closes et leur transcript : archivage hors ligne au-delà de six mois.',
  },
  {
    id: 'reminders',
    label: 'Rappels terminés',
    collection: 'reminders',
    path: '../models/Reminder',
    days: 30,
    field: 'remindAt',
    extra: { done: true },
    description: 'Rappels déjà délivrés, conservés un mois au cas où.',
  },
  {
    id: 'todos',
    label: 'Tâches terminées',
    collection: 'todos',
    path: '../models/Todo',
    days: 90,
    field: 'createdAt',
    extra: { done: true },
    description: 'Todo-list partagée : les tâches cochées depuis trois mois.',
  },
  {
    id: 'giveaways',
    label: 'Giveaways terminés',
    collection: 'giveaways',
    path: '../models/Giveaway',
    days: 60,
    field: 'endAt',
    extra: { ended: true },
    description: 'Concours terminés (avec la liste des participants) : deux mois d\'historique.',
  },
  {
    id: 'advanced-polls',
    label: 'Sondages fermés',
    collection: 'advancedpolls',
    path: '../models/AdvancedPoll',
    days: 60,
    field: 'endsAt',
    extra: { closed: true },
    description: 'Sondages clos avec leurs votes.',
  },
  {
    id: 'transactions',
    label: 'Historique des paiements',
    collection: 'transactions',
    path: '../models/Transaction',
    days: 180,
    field: 'createdAt',
    description: 'Chaque paiement entre membres est journalisé : six mois suffisent pour traiter un litige.',
  },
  {
    id: 'cooldowns',
    label: 'Cooldowns',
    collection: 'cooldowns',
    path: '../models/Cooldowns',
    days: 30,
    field: 'lastUse',
    description: 'Dernière utilisation d\'une commande : inutile après un mois d\'inactivité.',
  },
];

const RULE_BY_ID = Object.fromEntries(RULES.map(rule => [rule.id, rule]));

// ── Aides pures ──────────────────────────────────────────────────────────────
function cutoffDate(days, now = new Date()) {
  return new Date(now.getTime() - Math.max(0, Number(days) || 0) * DAY_MS);
}

function cutoffDay(days, now = new Date()) {
  return cutoffDate(days, now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/** Filtre Mongo d'une règle : les documents strictement plus vieux que la limite. */
function filterFor(rule, now = new Date()) {
  if (rule.dateString) {
    return { [rule.dateString]: { $lt: cutoffDay(rule.days, now) }, ...(rule.extra || {}) };
  }
  return { [rule.field]: { $lt: cutoffDate(rule.days, now) }, ...(rule.extra || {}) };
}

function planFor(rule, now = new Date()) {
  const cutoff = rule.dateString ? cutoffDay(rule.days, now) : cutoffDate(rule.days, now);
  return {
    id: rule.id,
    label: rule.label,
    collection: rule.collection,
    days: rule.days,
    field: rule.dateString || rule.field,
    filter: filterFor(rule, now),
    cutoff,
    description: rule.description,
  };
}

/** Plan complet, calculé sans I/O — c'est lui que la doc et les tests inspectent. */
function retentionPlan(now = new Date(), { only = null } = {}) {
  const selected = only ? new Set(Array.isArray(only) ? only : [only]) : null;
  return RULES
    .filter(rule => !selected || selected.has(rule.id))
    .map(rule => planFor(rule, now));
}

function resolveModel(rule) {
  try {
    const mod = require(rule.path);
    const model = rule.pick ? mod?.[rule.pick] : mod;
    return model && typeof model.deleteMany === 'function' ? model : null;
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 o';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** exp;
  // Entier → pas de décimale inutile (« 3 Go »), sinon une décimale sous 10 (« 5.1 Mo »).
  const short = Number.isInteger(value)
    ? String(value)
    : (value >= 10 ? String(Math.round(value)) : value.toFixed(1));
  return `${short} ${units[exp]}`;
}

// Dernier passage, en mémoire du processus. Volontairement pas persisté : une
// ligne « entretien » en base serait elle-même un document à nettoyer.
let lastRun = null;
function getLastRun() { return lastRun; }
function __resetForTests() { lastRun = null; statsCache = null; }

// ── Exécution ────────────────────────────────────────────────────────────────
/**
 * Applique les règles de rétention.
 * @param {object} opts
 * @param {Date}   [opts.now]       Horloge injectable (tests).
 * @param {boolean}[opts.dryRun]    Compter sans supprimer.
 * @param {string[]|string} [opts.only]  Limiter à certaines règles.
 * @param {object} [opts.models]    Modèles de remplacement (tests) : id → modèle.
 * @param {object} [opts.logger]    Logger noyau (optionnel).
 * @param {boolean}[opts.indexes]   Rejouer `createIndexes()` sur les modèles ciblés.
 * @returns {Promise<{ok:boolean, dryRun:boolean, startedAt:Date, finishedAt:Date, durationMs:number, deleted:number, scanned:number, results:Array, errors:number}>}
 */
async function runMaintenance({
  now = new Date(),
  dryRun = false,
  only = null,
  models = null,
  logger = null,
  indexes = false,
} = {}) {
  const startedAt = new Date();
  const results = [];

  for (const rule of RULES) {
    const plan = planFor(rule, now);
    if (only) {
      const selected = Array.isArray(only) ? only : [only];
      if (!selected.includes(rule.id)) continue;
    }

    const model = (models && models[rule.id]) || resolveModel(rule);
    if (!model) {
      results.push({ ...plan, count: 0, deleted: 0, skipped: 'modèle indisponible' });
      continue;
    }

    try {
      if (indexes && typeof model.createIndexes === 'function') {
        await model.createIndexes();
      }

      if (dryRun || typeof model.deleteMany !== 'function') {
        const count = typeof model.countDocuments === 'function'
          ? await model.countDocuments(plan.filter)
          : 0;
        results.push({ ...plan, count, deleted: 0, dryRun: true });
        continue;
      }

      const res = await model.deleteMany(plan.filter);
      const deleted = Number(res?.deletedCount ?? 0);
      results.push({ ...plan, count: deleted, deleted });
    } catch (err) {
      results.push({ ...plan, count: 0, deleted: 0, error: err.message });
      logger?.warn?.(`entretien base — ${rule.id} : ${err.message}`);
    }
  }

  const finishedAt = new Date();
  const summary = {
    ok: results.every(r => !r.error),
    dryRun,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    deleted: results.reduce((sum, r) => sum + r.deleted, 0),
    scanned: results.reduce((sum, r) => sum + r.count, 0),
    results,
    errors: results.filter(r => r.error).length,
  };

  if (!dryRun) lastRun = summary;
  logger?.info?.(`entretien base : ${summary.deleted} document(s) supprimé(s) en ${summary.durationMs} ms`);
  return summary;
}

// ── Statistiques ─────────────────────────────────────────────────────────────
let statsCache = null;

/**
 * Photographie de la base : taille, collections, documents nettoyables.
 * Ne lève jamais : hors connexion, renvoie `{ connected:false }`.
 * @param {object} opts
 * @param {object} [opts.mongoose] Instance injectable (tests).
 * @param {object} [opts.models]   Modèles de remplacement (tests).
 * @param {number} [opts.cacheMs]  Durée du cache (60 s par défaut).
 */
async function collectStats({ mongoose: mg = require('mongoose'), models = null, cacheMs = 60_000, now = new Date() } = {}) {
  if (statsCache && (Date.now() - statsCache.at) < cacheMs) return statsCache.stats;

  const conn = mg?.connection;
  if (!conn || conn.readyState !== 1 || !conn.db) {
    const stats = { connected: false, readyState: conn?.readyState ?? 0 };
    statsCache = { at: Date.now(), stats };
    return stats;
  }

  let raw = {};
  try { raw = await conn.db.stats(); } catch { raw = {}; }

  const prunable = [];
  for (const rule of RULES) {
    const model = (models && models[rule.id]) || resolveModel(rule);
    if (!model || typeof model.countDocuments !== 'function') continue;
    try {
      const plan = planFor(rule, now);
      const count = await model.countDocuments(plan.filter);
      const total = typeof model.estimatedDocumentCount === 'function'
        ? await model.estimatedDocumentCount()
        : null;
      prunable.push({ id: rule.id, label: rule.label, count, total, days: rule.days });
    } catch { /* une collection absente ne doit pas casser le diagnostic */ }
  }

  const stats = {
    connected: true,
    readyState: conn.readyState,
    database: conn.name || raw.db || null,
    collections: raw.collections ?? null,
    objects: raw.objects ?? null,
    dataSize: raw.dataSize ?? null,
    storageSize: raw.storageSize ?? null,
    indexes: raw.indexes ?? null,
    indexSize: raw.indexSize ?? null,
    prunable,
    prunableTotal: prunable.reduce((sum, p) => sum + (p.count || 0), 0),
    lastRun: getLastRun(),
    at: Date.now(),
  };
  statsCache = { at: Date.now(), stats };
  return stats;
}

module.exports = {
  DAY_MS,
  RULES,
  RULE_BY_ID,
  cutoffDate,
  cutoffDay,
  filterFor,
  planFor,
  retentionPlan,
  resolveModel,
  formatBytes,
  runMaintenance,
  collectStats,
  getLastRun,
  __resetForTests,
};
