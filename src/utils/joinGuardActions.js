'use strict';
// utils/joinGuardActions.js — Orchestration Discord du contrôle à l'arrivée.
//
// Un membre rejoint le serveur → on construit son profil, on le fait juger par
// le moteur pur (utils/joinGuardEngine.js) puis on applique la décision :
// inviter / surveiller (quarantaine) / bloquer (kick, ban, quarantaine ou
// simple journalisation), avec alerte dans le salon de sécurité et journal des
// dernières décisions.
//
// Tout est best-effort : une erreur Discord ne doit jamais empêcher le membre
// d'arriver ou de partir proprement.

const { EmbedBuilder } = require('discord.js');
const JoinGuard = require('../models/JoinGuard');
const { COLORS } = require('./embeds');
const { ensureQuarantineRole, resolveLogChannel } = require('./antinukeActions');
const {
  analyzeJoin, formatDecision, capRecent, effectiveThresholds,
  LEVEL_ICONS, LEVEL_LABELS,
} = require('./joinGuardEngine');
const { planJailRelease, capJail } = require('./joinJail');

// ─── Membres écartés à l'arrivée ─────────────────────────────────────────────
// Discord.js passe la MÊME instance de membre à tous les listeners
// `guildMemberAdd`. On y marque ceux que Vigie vient d'écarter pour que les
// autres modules (bienvenue, autorôles…) ne leur parlent pas pour rien.
const blockedMembers = new WeakSet();

/** Marque un membre écarté par Vigie. */
function markBlocked(member) { if (member) blockedMembers.add(member); }
/** Ce membre a-t-il été écarté par Vigie pendant cette arrivée ? */
function wasBlocked(member) { return Boolean(member) && blockedMembers.has(member); }

// ─── Configuration ───────────────────────────────────────────────────────────
async function getConfig(guildId) {
  let config = await JoinGuard.findOne({ guildId });
  if (!config) config = await JoinGuard.create({ guildId });
  return config;
}

// ─── Profil du membre qui arrive ─────────────────────────────────────────────
/**
 * Construit l'instantané jugé par le moteur (aucun accès Discord : le membre
 * est déjà en cache au moment de l'arrivée).
 */
function buildProfile(member, blacklisted = false) {
  const now = Date.now();
  const created = member?.user?.createdTimestamp;
  return {
    userId: member?.id ?? member?.user?.id ?? null,
    username: member?.user?.username ?? '',
    displayName: member?.nickname ?? member?.displayName ?? member?.user?.globalName ?? '',
    // Un timestamp absent est traité comme un compte ancien : on ne sanctionne
    // jamais un membre sur une donnée manquante.
    accountAgeDays: Number.isFinite(created) ? (now - created) / 86_400_000 : Number.POSITIVE_INFINITY,
    hasAvatar: member?.user?.avatar != null || member?.user?.avatarDecoration != null,
    isBot: Boolean(member?.user?.bot),
    roleIds: member?.roles?.cache ? [...member.roles.cache.keys()] : [],
    blacklisted,
  };
}

/** Le membre figure-t-il sur la liste noire anti-raid (si le partage est actif) ? */
async function isBlacklisted(member, config) {
  if (!config.useAntiRaidBlacklist) return false;
  try {
    const { AntiRaid } = require('../models/AntiRaid');
    const cfg = await AntiRaid.findOne({ guildId: member.guild.id }).lean();
    return Boolean((cfg?.bannedUserIds || []).includes(member.id));
  } catch (_) {
    return false;
  }
}

// ─── Application de la décision ──────────────────────────────────────────────
async function applyAction(member, config, verdict) {
  const guild = member.guild;
  const action = verdict.action;
  if (action === 'allow') return 'allow';

  const reason = `Vigie : ${verdict.reasons.map(r => r.label).join(', ')}`;

  if (action === 'log') return 'log';

  if (action === 'quarantine') {
    const role = await ensureQuarantineRole(guild, config, {
      name: '🚪 En attente de vérification',
      color: 0x99AAB5,
      reason: 'Vigie : profil à surveiller',
    });
    if (!role) return 'quarantine (rôle indisponible)';
    await member.roles.add(role, reason).catch(() => {});
    return 'quarantine';
  }

  // Compte trop récent → salle d'attente : le membre n'est pas écarté, il
  // patiente avec le rôle d'attente puis est libéré tout seul dès que son
  // compte atteint l'âge requis (cron crons/joinJail.js).
  if (action === 'jail') {
    const role = await ensureQuarantineRole(guild, config, {
      name: '⏳ Salle d’attente — compte récent',
      color: 0x99AAB5,
      reason: 'Vigie : compte trop récent',
    });
    if (!role) return 'jail (rôle indisponible)';
    await member.roles.add(role, reason).catch(() => {});

    const { releaseAt } = planJailRelease({
      accountCreatedTimestamp: member.user?.createdTimestamp,
      minAccountAgeDays: config.minAccountAgeDays,
    });
    // Le document est sauvegardé par l'appelant (handleMemberJoin) juste après.
    config.jail = capJail([
      ...(config.jail || []).filter(e => e.userId !== member.id),
      { userId: member.id, releaseAt, at: new Date() },
    ]);
    return `jail (jusqu'au ${releaseAt.toISOString().slice(0, 16).replace('T', ' ')})`;
  }

  // Aucune sanction : le membre part directement à la vérification captcha.
  if (action === 'captcha') return 'captcha';

  if (action === 'kick') {
    const ok = await member.kick(reason).then(() => true).catch(() => false);
    if (ok) markBlocked(member);
    return ok ? 'kick' : 'kick (refusé par Discord)';
  }

  if (action === 'ban') {
    const ok = await guild.members.ban(member.id, { reason }).then(() => true).catch(() => false);
    if (ok) markBlocked(member);
    return ok ? 'ban' : 'ban (refusé par Discord)';
  }

  return action;
}

/** Message privé d'explication, envoyé avant la sanction (best-effort). */
async function notifyMember(member, config, verdict) {
  if (!config.dmOnBlock || verdict.level !== 'danger') return false;
  const reasons = verdict.reasons.map(r => `• ${r.label}`).join('\n');
  return member.send({
    embeds: [new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle(`🚪 Accès refusé sur ${member.guild.name}`)
      .setDescription(
        `Ton compte a été jugé à risque à l'arrivée (score **${verdict.score}**).\n\n` +
        `**Motifs :**\n${reasons || '• non précisé'}\n\n` +
        'Si tu penses qu\'il s\'agit d\'une erreur, contacte le staff du serveur : ' +
        'un membre d\'équipe peut lever le contrôle manuellement.',
      )],
  }).then(() => true).catch(() => false);
}

function decisionEmbed(guild, member, verdict, applied) {
  const isBlocked = verdict.level === 'danger';
  const embed = new EmbedBuilder()
    .setColor(isBlocked ? COLORS.error : COLORS.warning)
    .setTitle(`${LEVEL_ICONS[verdict.level] || '•'} Vigie — ${LEVEL_LABELS[verdict.level] || verdict.level}`)
    .setDescription(
      `<@${member.id}> (\`${member.user?.tag || member.id}\`)\n` +
      `**Score :** ${verdict.score} · **Action :** \`${applied}\``,
    )
    .addFields(
      { name: 'Motifs', value: verdict.reasons.length ? verdict.reasons.map(r => `• **${r.label}**${r.details?.length ? ` — ${r.details.join(', ')}` : ''}`).join('\n') : '*aucun*', inline: false },
      { name: 'Compte', value: `Âge : **${Math.floor((Date.now() - (member.user?.createdTimestamp || Date.now())) / 86_400_000)} j** · Avatar : ${buildProfile(member).hasAvatar ? 'oui' : 'non'} · ID : \`${member.id}\``, inline: false },
    )
    .setThumbnail(member.user?.displayAvatarURL?.() || null)
    .setFooter({ text: 'REZO • Vigie — réglages avec /controle-arrivee' })
    .setTimestamp();
  return embed;
}

// ─── Pipeline : un membre rejoint le serveur ─────────────────────────────────
/**
 * @param {import('discord.js').GuildMember} member
 * @param {import('discord.js').Client} client
 * @returns {Promise<{ handled:boolean, level?:string, score?:number, action?:string }>}
 */
async function handleMemberJoin(member, client) {
  if (!member?.guild) return { handled: false };
  const config = await getConfig(member.guild.id);
  if (!config.enabled) return { handled: false };

  const blacklisted = await isBlacklisted(member, config);
  const profile = buildProfile(member, blacklisted);
  const verdict = analyzeJoin(profile, config, {
    guildOwnerId: member.guild.ownerId,
    clientId: client?.user?.id ?? member.guild.client?.user?.id ?? null,
  });

  // Confiance : on ne journalise même pas, le membre n'est pas concerné.
  if (verdict.trusted) return { handled: false, level: 'safe', score: 0, action: 'allow' };

  if (verdict.action === 'allow') {
    config.stats.allowed = (config.stats?.allowed || 0) + 1;
    config.stats.lastDecisionAt = new Date();
    await config.save().catch(() => {});
    return { handled: false, level: verdict.level, score: verdict.score, action: 'allow' };
  }

  await notifyMember(member, config, verdict);
  const applied = await applyAction(member, config, verdict);

  config.recent = capRecent([...(config.recent || []), {
    at: new Date(),
    userId: member.id,
    userTag: member.user?.tag || member.id,
    level: verdict.level,
    score: verdict.score,
    action: applied,
    reasons: verdict.reasons.map(r => r.label),
  }]);
  if (verdict.level === 'danger') config.stats.blocked = (config.stats?.blocked || 0) + 1;
  else config.stats.reviewed = (config.stats?.reviewed || 0) + 1;
  config.stats.lastDecisionAt = new Date();
  await config.save().catch(() => {});

  const channel = await resolveLogChannel(member.guild, config);
  if (channel) await channel.send({ embeds: [decisionEmbed(member.guild, member, verdict, applied)] }).catch(() => {});

  console.log(`🚪 [vigie] ${member.guild.name} : ${member.user?.tag || member.id} → ${applied} (score ${verdict.score})`);
  return { handled: true, level: verdict.level, score: verdict.score, action: applied };
}

// ─── Levée des quarantaines ──────────────────────────────────────────────────
/**
 * Retire le rôle de quarantaine de tous les membres qui le portent.
 * @returns {Promise<number>} nombre de membres libérés
 */
async function releaseQuarantined(guild, config) {
  const roleId = config.quarantineRoleId;
  if (!roleId) return 0;
  if (guild.memberCount <= 1000 && guild.members.cache.size < guild.memberCount) {
    await guild.members.fetch().catch(() => null);
  }
  let released = 0;
  for (const [, member] of guild.members.cache) {
    if (!member.roles.cache.has(roleId)) continue;
    await member.roles.remove(roleId, 'Vigie : fin de quarantaine').catch(() => {});
    released++;
  }
  return released;
}

/** Nombre de membres actuellement en quarantaine. */
function countQuarantined(guild, config) {
  if (!config.quarantineRoleId) return 0;
  let count = 0;
  for (const [, member] of guild.members.cache) {
    if (member.roles.cache.has(config.quarantineRoleId)) count++;
  }
  return count;
}

module.exports = {
  getConfig,
  markBlocked,
  wasBlocked,
  buildProfile,
  isBlacklisted,
  applyAction,
  notifyMember,
  decisionEmbed,
  handleMemberJoin,
  releaseQuarantined,
  countQuarantined,
  formatDecision,
  effectiveThresholds,
  ensureQuarantineRole,
  resolveLogChannel,
};
