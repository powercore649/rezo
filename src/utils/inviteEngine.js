'use strict';
// utils/inviteEngine.js — Cœur du système d'invitations.
//
// Une seule source pour :
//   • les statistiques (actives / reparties / fakes) et le rang d'un inviteur ;
//   • le classement paginé ;
//   • les textes et embeds d'arrivée / de départ (placeholders étendus) ;
//   • les récompenses (coins par invitation valide, rôles bonus) ;
//   • les paliers d'invitations et la progression vers le suivant.
//
// Les fonctions pures (renderInviteTemplate, milestoneFor, progressToMilestone,
// eligibleRewardRoles, formatRank, accountAgeDays) sont testables sans base.
const { EmbedBuilder } = require('discord.js');
const InviteUse = require('../models/InviteUse');
const Balance = require('../models/Balance');
const { COLORS } = require('./embeds');

const DEFAULT_JOIN_TITLE = '🎉 Nouveau membre !';
const DEFAULT_LEAVE_TITLE = '📤 Un membre est parti';

const DEFAULT_JOIN_MESSAGE = "{user} a rejoint en utilisant l'invitation de **{inviter}** (`{code}`) — {inviter} totalise maintenant **{totalInvites}** invitation(s).";
const DEFAULT_JOIN_UNKNOWN = "{user} a rejoint le serveur, mais l'invitation utilisée n'a pas pu être déterminée (lien vanity, invitation supprimée, ou ajout via bot).";
const DEFAULT_LEAVE_MESSAGE = "{user} a quitté le serveur (invité à l'origine par **{inviter}** via `{code}`).";

// ─── Fonctions pures ─────────────────────────────────────────────────────────

/**
 * Remplace les placeholders {clé} d'un texte. Les clés inconnues (ou vides)
 * sont laissées telles quelles : aucun texte ne peut « disparaître » par erreur.
 */
function renderInviteTemplate(template, vars = {}) {
  if (!template || !String(template).trim()) return '';
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars[key];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

/** Âge du compte Discord en jours (peut être fractionnaire). */
function accountAgeDays(user, now = Date.now()) {
  const created = Number(user?.createdTimestamp);
  if (!Number.isFinite(created)) return null;
  return Math.max(0, (now - created) / 86_400_000);
}

/** Rang lisible : « #3 » ou « — ». */
function formatRank(rank) {
  return rank ? `#${Number(rank).toLocaleString('fr-FR')}` : '—';
}

/**
 * Palier atteint exactement à ce total d'invitations actives, ou null.
 * Ex. step=5 : 5, 10, 15… sont des paliers ; 7 n'en est pas un.
 */
function milestoneFor(active, step) {
  const total = Number(active) || 0;
  const every = Number(step) || 0;
  if (total <= 0 || every <= 0) return null;
  return total % every === 0 ? total : null;
}

/**
 * Progression vers le prochain palier (null si les paliers sont désactivés).
 * @returns {null | { next: number, current: number, remaining: number, percent: number }}
 */
function progressToMilestone(active, step) {
  const total = Math.max(0, Number(active) || 0);
  const every = Number(step) || 0;
  if (every <= 0) return null;
  const next = Math.ceil((total + 1) / every) * every;
  const current = total % every;
  return {
    next,
    current,
    remaining: next - total,
    percent: Math.round((current / every) * 100),
  };
}

/** Rôles bonus dont le seuil est atteint (triés par seuil croissant). */
function eligibleRewardRoles(rewardRoles = [], active = 0) {
  return [...(rewardRoles || [])]
    .filter((r) => r && r.roleId && Number(r.threshold) > 0 && Number(active) >= Number(r.threshold))
    .sort((a, b) => Number(a.threshold) - Number(b.threshold));
}

/** Couleur hexadécimale valide → entier Discord, sinon repli. */
function resolveColor(hex, fallback = COLORS.success) {
  const clean = String(hex || '').replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return fallback;
  return parseInt(clean, 16);
}

/** Valide une couleur saisie par un administrateur. */
function validateInviteColor(input) {
  const clean = String(input || '').replace(/^#/, '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return { ok: false, error: 'La couleur doit être un code hexadécimal à 6 caractères (ex: 57F287).' };
  }
  return { ok: true, hex: clean.toUpperCase() };
}

/** Variables communes à tous les textes d'invitation. */
function buildInviteVars({
  guild, member, inviterId, inviterTag, code, stats, rank, accountAge, milestone, memberCount, method,
} = {}) {
  return {
    user: member?.id ? `<@${member.id}>` : (member?.user?.tag || 'un membre'),
    username: member?.user?.username || member?.user?.tag || 'membre',
    server: guild?.name || 'le serveur',
    inviter: inviterId ? `<@${inviterId}>` : (inviterTag || 'inconnu'),
    inviterTag: inviterTag || 'Inconnu',
    code: code || 'inconnu',
    totalInvites: Number(stats?.active || 0),
    active: Number(stats?.active || 0),
    joins: Number(stats?.joins || 0),
    leaves: Number(stats?.leaves || 0),
    fakes: Number(stats?.fakes || 0),
    rank: formatRank(rank),
    accountAge: accountAge === null || accountAge === undefined ? 'inconnu' : `${Math.floor(accountAge)} jour(s)`,
    milestone: milestone || '—',
    memberCount: Number(memberCount || guild?.memberCount || 0),
    method: method || 'unknown',
  };
}

// ─── Statistiques et classement (base de données) ────────────────────────────

/**
 * Stats agrégées d'un inviteur : joins (tout), leaves, fakes et actives.
 * Un seul aller-retour base (au lieu de quatre) : la fonction est appelée à
 * chaque arrivée, à chaque départ et à chaque affichage de carte.
 */
async function computeInviteStats(guildId, inviterId) {
  if (!guildId || !inviterId) return { joins: 0, leaves: 0, fakes: 0, active: 0 };

  const [row] = await InviteUse.aggregate([
    { $match: { guildId, inviterId } },
    {
      $group: {
        _id: null,
        joins: { $sum: 1 },
        leaves: { $sum: { $cond: ['$left', 1, 0] } },
        fakes: { $sum: { $cond: ['$fake', 1, 0] } },
        active: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$left', false] }, { $eq: ['$fake', false] }] }, 1, 0],
          },
        },
      },
    },
  ]);

  return {
    joins: row?.joins || 0,
    leaves: row?.leaves || 0,
    fakes: row?.fakes || 0,
    active: row?.active || 0,
  };
}

/** Rang de l'inviteur parmi les invitations actives (1 = meilleur), ou null. */
async function getInviteRank(guildId, inviterId, active = null) {
  const total = active === null ? (await computeInviteStats(guildId, inviterId)).active : Number(active);
  if (!inviterId || total <= 0) return null;

  const better = await InviteUse.aggregate([
    { $match: { guildId, left: false, fake: false, inviterId: { $ne: null } } },
    { $group: { _id: '$inviterId', total: { $sum: 1 } } },
    { $match: { total: { $gt: total } } },
    { $count: 'better' },
  ]);

  return (better?.[0]?.better || 0) + 1;
}

/**
 * Classement paginé des inviteurs (invitations actives uniquement).
 * @returns {{ rows: Array<{ inviterId: string, total: number, tag: string }>,
 *             total: number, totalPages: number, page: number }}
 */
async function getInviteLeaderboard(guildId, page = 1, perPage = 10) {
  const safePerPage = Math.max(1, Math.min(25, Number(perPage) || 10));
  const requested = Math.max(1, Number(page) || 1);

  // Le tri et la pagination se font dans la base ($facet → $count + $skip/$limit).
  // Avant, tout l'agrégat était chargé en mémoire puis découpé en JS : un gros
  // serveur (des milliers de membres invités) transférait l'intégralité du
  // classement pour n'afficher que dix lignes.
  const pipeline = (skip) => [
    { $match: { guildId, left: false, fake: false, inviterId: { $ne: null } } },
    { $group: { _id: '$inviterId', total: { $sum: 1 }, tag: { $first: '$inviterTag' } } },
    { $sort: { total: -1, _id: 1 } },
    {
      $facet: {
        meta: [{ $count: 'total' }],
        rows: [{ $skip: skip }, { $limit: safePerPage }],
      },
    },
  ];

  const run = async (targetPage) => {
    const [out] = await InviteUse.aggregate(pipeline((targetPage - 1) * safePerPage));
    const total = out?.meta?.[0]?.total || 0;
    const rows = (out?.rows || []).map((row) => ({
      inviterId: row._id,
      total: row.total,
      tag: row.tag || 'Inconnu',
    }));
    return { total, rows };
  };

  let data = await run(requested);
  const totalPages = Math.max(1, Math.ceil(data.total / safePerPage));
  let safePage = requested;

  // Page hors limites : une seule requête de rattrapage (cas rare, saisie manuelle).
  if (requested > totalPages) {
    safePage = totalPages;
    data = await run(safePage);
  }

  return { rows: data.rows, total: data.total, totalPages, page: safePage };
}

/** Crédite les coins d'invitation. Ne lève jamais (une récompense ne casse pas un join). */
async function grantInviteCoins(guildId, inviterId, amount) {
  const coins = Math.max(0, Math.floor(Number(amount) || 0));
  if (!guildId || !inviterId || coins === 0) return 0;
  try {
    await Balance.findOneAndUpdate(
      { userId: inviterId, guildId },
      { $inc: { coins } },
      { upsert: true },
    );
    return coins;
  } catch (err) {
    console.error('❌ invitations — coins:', err.message);
    return 0;
  }
}

// ─── Embeds ─────────────────────────────────────────────────────────────────

/**
 * Embed d'arrivée, enrichi (inviteur, code, rang, compte, palier).
 * Le texte vient du modèle InviteConfig et accepte tous les placeholders.
 */
function buildJoinEmbed({
  guild, member, inviterId, inviterTag, code, method, stats, rank,
  isFake = false, cfg = null, accountAge = null, accountCreatedTs = null,
  milestone = null, coins = 0,
} = {}) {
  const createdTs = accountCreatedTs || member?.user?.createdTimestamp || null;
  const template = code
    ? (cfg?.joinMessage || DEFAULT_JOIN_MESSAGE)
    : (cfg?.joinMessageUnknown || DEFAULT_JOIN_UNKNOWN);

  const vars = buildInviteVars({
    guild, member, inviterId, inviterTag, code, stats, rank, accountAge, milestone, method,
  });
  const description = renderInviteTemplate(template, vars);

  const embed = new EmbedBuilder()
    .setColor(isFake ? COLORS.warning : resolveColor(cfg?.embedColor))
    .setAuthor({ name: cfg?.joinTitle || DEFAULT_JOIN_TITLE })
    .setDescription(description || DEFAULT_JOIN_UNKNOWN)
    .setThumbnail(member?.user?.displayAvatarURL?.({ size: 256 }) || null)
    .setFooter({ text: 'REZO • Invitations' })
    .setTimestamp();

  if (inviterId) {
    embed.addFields(
      { name: '🎟️ Invité par', value: `${vars.inviter} (${vars.inviterTag})`, inline: true },
      { name: '🔗 Code', value: `\`${vars.code}\``, inline: true },
      { name: '📊 Invitations actives', value: `**${vars.totalInvites}** · rang ${vars.rank}`, inline: true },
    );
  }

  embed.addFields(
    { name: '👤 Compte créé', value: createdTs ? `<t:${Math.floor(createdTs / 1000)}:R>` : '*Inconnu*', inline: true },
    { name: '📥 Membre n°', value: `**${vars.memberCount}**`, inline: true },
    { name: '🛡️ Statut', value: isFake ? '⚠️ Compte récent (non compté)' : '✅ Invitation valide', inline: true },
  );

  if (milestone) {
    embed.addFields({
      name: '🏆 Palier atteint',
      value: `**${milestone}** invitation(s) active(s)${coins ? ` · 🪙 +${coins} coins pour cette invitation` : ''} — félicitations !`,
    });
  }

  return embed;
}

/** Embed de départ, avec le total à jour de l'inviteur. */
function buildLeaveEmbed({
  guild, member, record, cfg = null, inviterActive = 0, memberDuration = null,
} = {}) {
  const vars = buildInviteVars({
    guild,
    member,
    inviterId: record?.inviterId,
    inviterTag: record?.inviterTag,
    code: record?.code,
    stats: { active: inviterActive },
    memberCount: guild?.memberCount,
  });

  const template = record?.inviterId
    ? (cfg?.leaveMessage || DEFAULT_LEAVE_MESSAGE)
    : (cfg?.leaveMessageUnknown || '{user} a quitté le serveur.');

  const embed = new EmbedBuilder()
    .setColor(COLORS.error)
    .setAuthor({ name: cfg?.leaveTitle || DEFAULT_LEAVE_TITLE })
    .setDescription(renderInviteTemplate(template, vars) || `${vars.user} a quitté le serveur.`)
    .setThumbnail(member?.user?.displayAvatarURL?.({ size: 256 }) || null)
    .setFooter({ text: 'REZO • Invitations' })
    .setTimestamp();

  if (record?.inviterId) {
    embed.addFields(
      { name: '🎟️ Invité par', value: `${vars.inviter} (${vars.inviterTag})`, inline: true },
      { name: '🔗 Code', value: `\`${vars.code}\``, inline: true },
      { name: '📊 Invitations actives de l’inviteur', value: `**${inviterActive}**`, inline: true },
    );
  }

  if (memberDuration !== null) {
    embed.addFields({ name: '⏳ Temps passé sur le serveur', value: memberDuration, inline: true });
  }

  return embed;
}

module.exports = {
  DEFAULT_JOIN_TITLE,
  DEFAULT_LEAVE_TITLE,
  DEFAULT_JOIN_MESSAGE,
  DEFAULT_JOIN_UNKNOWN,
  DEFAULT_LEAVE_MESSAGE,
  renderInviteTemplate,
  accountAgeDays,
  formatRank,
  milestoneFor,
  progressToMilestone,
  eligibleRewardRoles,
  resolveColor,
  validateInviteColor,
  buildInviteVars,
  computeInviteStats,
  getInviteRank,
  getInviteLeaderboard,
  grantInviteCoins,
  buildJoinEmbed,
  buildLeaveEmbed,
};
