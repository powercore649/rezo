'use strict';
// utils/securityAudit.js — Moteur pur de l'audit de sécurité d'un serveur.
//
// Reçoit un instantané de faits (permissions, modules activés, sauvegardes…) et
// rend un rapport : score /100, note, et la liste des points vérifiés avec un
// conseil et, quand c'est possible, un correctif applicable en un clic.
//
// Aucune dépendance Discord ni MongoDB : 100 % testable hors-ligne
// (voir tests/antinuke-smoke.js). La collecte des faits vit dans
// src/commands/securite/audit-securite.js.

// Poids de chaque gravité dans le score.
const SEVERITY_WEIGHT = { critique: 25, eleve: 15, moyen: 8, faible: 4 };
const SEVERITY_ORDER = ['critique', 'eleve', 'moyen', 'faible'];
const SEVERITY_LABELS = { critique: '🔴 Critique', eleve: '🟠 Élevé', moyen: '🟡 Moyen', faible: '⚪ Faible' };

const GRADE_THRESHOLDS = [
  { min: 90, grade: 'Excellent', emoji: '🏆', advice: 'Ce serveur est très bien protégé.' },
  { min: 75, grade: 'Bon',       emoji: '✅', advice: 'Bonne base — quelques réglages à finir.' },
  { min: 55, grade: 'Correct',   emoji: '🟡', advice: 'Des failles exploitables subsistent.' },
  { min: 30, grade: 'Fragile',   emoji: '🟠', advice: 'Le serveur est exposé : agissez rapidement.' },
  { min: 0,  grade: 'Critique',  emoji: '🔴', advice: 'Le serveur est une cible facile, à corriger d\'urgence.' },
];

// ─── Fabrique de vérification ────────────────────────────────────────────────
function check(id, { label, severity, ok, advice, fix = null, details = null }) {
  return { id, label, severity, ok: Boolean(ok), advice, fix, details };
}

/**
 * Construit le rapport complet.
 * @param {Object} facts — instantané normalisé du serveur
 * @returns {{ score:number, grade:string, emoji:string, advice:string, checks:Array, passed:number, failed:number, total:number, maxScore:number, gained:number }}
 */
function buildAuditReport(facts = {}) {
  const {
    guildName = 'ce serveur',
    verificationLevel = 0,
    mfaLevel = 0,
    explicitContentFilter = 0,
    defaultMessageNotifications = 0,
    everyoneDangerousPerms = [],
    adminRoles = [],
    adminMembers = [],
    adminBots = [],
    dangerousRoleCount = 0,
    modules = {},
    backupAgeDays = null,
    webhookCount = 0,
  } = facts;

  const neverJoined = adminMembers.length === 0;

  const checks = [
    check('verification', {
      label: 'Niveau de vérification du serveur',
      severity: 'critique',
      ok: verificationLevel >= 2,
      advice: verificationLevel >= 2
        ? `Niveau ${verificationLevel} : les comptes fraîchement créés ne peuvent pas écrire tout de suite.`
        : 'Règle le niveau de vérification sur **Moyen** ou plus : les comptes tout neufs et non vérifiés sont filtrés avant de pouvoir nuire.',
      fix: verificationLevel >= 2 ? null : { type: 'verification', value: 2, label: 'Passer au niveau Moyen' },
    }),

    check('mfa', {
      label: 'Double authentification du staff',
      severity: 'eleve',
      ok: mfaLevel >= 1,
      advice: mfaLevel >= 1
        ? 'Les actions de modération exigent la 2FA : un mot de passe volé ne suffit plus.'
        : 'Exige la **2FA** pour les actions de modération : c\'est la meilleure protection contre le détournement d\'un compte admin.',
      fix: mfaLevel >= 1 ? null : { type: 'mfa', value: 1, label: 'Exiger la 2FA' },
    }),

    check('contentscan', {
      label: 'Filtre de contenu explicite',
      severity: 'moyen',
      ok: explicitContentFilter >= 2,
      advice: explicitContentFilter >= 2
        ? 'Filtre actif sur **tous les membres**.'
        : 'Active le filtre pour **tous les membres** : il coupe les médias à caractère explicite avant même le premier signalement.',
      fix: explicitContentFilter >= 2 ? null : { type: 'content_filter', value: 2, label: 'Filtrer pour tous' },
    }),

    check('everyone', {
      label: 'Permissions du rôle @everyone',
      severity: 'critique',
      ok: everyoneDangerousPerms.length === 0,
      advice: everyoneDangerousPerms.length === 0
        ? '@everyone n\'a aucune permission dangereuse.'
        : `@everyone possède **${everyoneDangerousPerms.join(', ')}** : n\'importe qui peut détruire ou contourner le serveur. Retirez ces permissions du rôle @everyone.`,
    }),

    check('admin_bots', {
      label: 'Bots avec la permission Administrateur',
      severity: 'critique',
      ok: adminBots.length === 0,
      advice: adminBots.length === 0
        ? 'Aucun bot ne dispose de l\'Administrateur.'
        : `**${adminBots.length} bot(s)** ont l'Administrateur (${adminBots.join(', ')}) : un bot compromis ou une mise à jour malveillante suffirait. Ne gardez l'Administrateur que sur les bots indispensables.`,
    }),

    check('admin_roles', {
      label: 'Rôles disposant de l\'Administrateur',
      severity: 'eleve',
      ok: adminRoles.length <= 2,
      advice: adminRoles.length <= 2
        ? `${adminRoles.length} rôle(s) administrateur(s) : hiérarchie saine.`
        : `**${adminRoles.length} rôles** ont l'Administrateur (${adminRoles.join(', ')}) : multipliez les risques sans raison. Deux rôles suffisent en général (toi + un adjoint).`,
    }),

    check('dangerous_roles', {
      label: 'Rôles avec permissions sensibles',
      severity: 'moyen',
      ok: dangerousRoleCount <= 3,
      advice: dangerousRoleCount <= 3
        ? `${dangerousRoleCount} rôle(s) avec permissions sensibles (gestion des rôles/salons/webhooks) : acceptable.`
        : `**${dangerousRoleCount} rôles** peuvent gérer les rôles, salons ou webhooks — chacun est une porte vers la destruction du serveur. Réservez ces permissions au staff de confiance.`,
    }),

    check('admin_members', {
      label: 'Membres ayant l\'Administrateur',
      severity: 'eleve',
      ok: adminMembers.length <= 5,
      advice: neverJoined
        ? `Liste indisponible (le serveur est peut-être trop grand, ou le cache n'est pas prêt).`
        : adminMembers.length <= 5
          ? `**${adminMembers.length} membre(s)** administrateur(s) — vérifie que chacun est légitime.`
          : `**${adminMembers.length} membres** ont l'Administrateur : vérifie cette liste un par un, un compte oublié est un compte à risque.`,
      details: neverJoined ? null : adminMembers.slice(0, 10),
    }),

    check('antinuke', {
      label: 'Protection anti-nuke activée',
      severity: 'critique',
      ok: Boolean(modules.antiNuke),
      advice: modules.antiNuke
        ? 'Sentinel surveille les suppressions massives de salons/rôles et les sanctions automatiquement.'
        : 'Active **`/anti-nuke`** : sans lui, un compte admin compromis efface le serveur en quelques secondes.',
    }),

    check('antiraid', {
      label: 'Protection anti-raid activée',
      severity: 'eleve',
      ok: Boolean(modules.antiraid),
      advice: modules.antiraid
        ? 'Les arrivées massives déclenchent une réponse automatique.'
        : 'Active **`/antiraid`** : une vague de faux comptes peut inonder le serveur en quelques minutes.',
    }),

    check('captcha', {
      label: 'Vérification à l\'arrivée',
      severity: 'eleve',
      ok: Boolean(modules.captcha),
      advice: modules.captcha
        ? 'Les nouveaux membres doivent prouver qu\'ils sont humains avant d\'accéder au serveur.'
        : 'Configure **`/captcha`** : c\'est la barrière la plus efficace contre les bots auto-rejoints.',
    }),

    check('automod', {
      label: 'Auto-modération (spam, liens, majuscules…)',
      severity: 'moyen',
      ok: Boolean(modules.automod),
      advice: modules.automod
        ? 'L\'auto-modération filtre le spam et les liens non autorisés.'
        : 'Configure **`/securite`** : anti-spam, anti-liens et filtres sont regroupés dans un seul panneau.',
    }),

    check('honeypot', {
      label: 'Piège à bots (honeypot)',
      severity: 'faible',
      ok: Boolean(modules.honeypot),
      advice: modules.honeypot
        ? 'Un salon piège arrête les bots avant qu\'ils n\'agissent.'
        : 'Ajoute un **`/honeypot`** : un salon invisible où le premier clic trahit un bot.',
    }),

    check('log_channel', {
      label: 'Salon de journaux de sécurité',
      severity: 'moyen',
      ok: Boolean(modules.logChannel),
      advice: modules.logChannel
        ? 'Les alertes de sécurité arrivent dans un salon dédié.'
        : 'Définis un salon de logs (dans `/securite` ou `/anti-nuke`) : sans journal, les attaques passent inaperçues.',
    }),

    check('webhooks', {
      label: 'Webhooks du serveur',
      severity: 'moyen',
      ok: webhookCount <= 10,
      advice: webhookCount <= 10
        ? `${webhookCount} webhook(s) — sous contrôle.`
        : `**${webhookCount} webhooks** existent : un webhook détourné permet de poster sous une identité de confiance. Supprime ceux qui ne servent plus.`,
    }),

    check('backup', {
      label: 'Sauvegarde récente du serveur',
      severity: 'moyen',
      ok: backupAgeDays !== null && backupAgeDays <= 30,
      advice: backupAgeDays === null
        ? 'Aucune sauvegarde enregistrée : après une attaque, il n\'y a rien à restaurer.'
        : (backupAgeDays <= 30
          ? `Dernière sauvegarde il y a ${backupAgeDays} jour(s) — à jour.`
          : `Dernière sauvegarde il y a **${backupAgeDays} jours** : relance une sauvegarde régulièrement.`),
    }),

    check('notifications', {
      label: 'Notifications par défaut',
      severity: 'faible',
      ok: defaultMessageNotifications === 1,
      advice: defaultMessageNotifications === 1
        ? 'Le serveur ne notifie que sur mention : pas de bruit inutile.'
        : 'Règle les notifications sur **« Mentions uniquement »** : les messages de masse ne noient plus les alertes du staff.',
      fix: defaultMessageNotifications === 1 ? null : { type: 'notifications', value: 1, label: 'Mentions uniquement' },
    }),
  ];

  let gained = 0;
  let maxScore = 0;
  for (const item of checks) {
    const weight = SEVERITY_WEIGHT[item.severity] || 5;
    maxScore += weight;
    if (item.ok) gained += weight;
  }
  const score = maxScore === 0 ? 0 : Math.round((gained / maxScore) * 100);
  const grade = GRADE_THRESHOLDS.find(g => score >= g.min) || GRADE_THRESHOLDS[GRADE_THRESHOLDS.length - 1];

  const failed = checks.filter(c => !c.ok);
  const sorted = [...checks].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.ok ? 'faible' : a.severity) - SEVERITY_ORDER.indexOf(b.ok ? 'faible' : b.severity),
  );

  return {
    guildName,
    score,
    grade: grade.grade,
    emoji: grade.emoji,
    advice: grade.advice,
    checks: sorted,
    failed,
    passed: checks.length - failed.length,
    total: checks.length,
    gained,
    maxScore,
  };
}

/** Barre de progression textuelle (0-100). */
function scoreBar(score, length = 12) {
  const filled = Math.max(0, Math.min(length, Math.round((score / 100) * length)));
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

/** Étiquette lisible d'une gravité. */
function severityLabel(severity) { return SEVERITY_LABELS[severity] || severity; }

/** Les correctifs applicables en un clic, tels que proposés par le rapport. */
function availableFixes(report) {
  return (report?.checks || []).filter(c => !c.ok && c.fix).map(c => c.fix);
}

module.exports = {
  SEVERITY_WEIGHT,
  SEVERITY_ORDER,
  SEVERITY_LABELS,
  GRADE_THRESHOLDS,
  buildAuditReport,
  scoreBar,
  severityLabel,
  availableFixes,
};
