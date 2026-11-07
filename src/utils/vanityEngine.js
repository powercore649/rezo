'use strict';
// utils/vanityEngine.js — Vanity par statut Discord.
//
// LE PRINCIPE : un membre affiche dans son statut personnalisé le texte défini
// par le serveur (ex. « discord.gg/rezo »). Dès que le bot le voit, il :
//   1. vérifie les conditions (âge du compte, ancienneté, rôle requis…) ;
//   2. attribue le rôle configuré ;
//   3. envoie une annonce en embed dans le salon choisi (une seule fois) ;
//   4. journalise l'attribution dans le salon de logs.
//
// Quand le statut disparaît, le rôle est retiré après un délai de grâce (un
// statut qui clignote ne fait pas perdre son rôle) : ce retrait est appliqué par
// la passe périodique (crons/vanity.js), jamais dans le feu de l'événement.
//
// PERFORMANCE : `presenceUpdate` peut tirer des dizaines de fois par seconde.
// La config est donc lue dans le cache borné (utils/guildConfigCache) et un
// membre déjà validé est mémorisé 5 minutes : un statut qui reste affiché ne
// produit aucune écriture en base.
//
// Les fonctions pures (normalizeStatus, matchStatus, checkEligibility,
// renderTemplate, parseColor) sont testables sans Discord ni MongoDB.

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const VanityConfig = require('../models/VanityConfig');
const VanityMember = require('../models/VanityMember');
const configCache = require('./guildConfigCache');
const { createBoundedCache } = require('./boundedCache');
const { COLORS } = require('./embeds');
const brand = require('./brand');

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MAX_STATUSES = 10;

// Config lue en cache : un changement depuis le panneau purge l'entrée
// automatiquement (hooks Mongoose de guildConfigCache).
const readConfig = configCache.registerModel(VanityConfig, { ttl: 30_000 });

// Membre déjà traité récemment : on n'écrit pas en base à chaque presenceUpdate.
const activeCache = createBoundedCache({ max: 100_000, ttl: 5 * MINUTE_MS, name: 'vanity-active' });
// Anti-double-traitement (deux événements simultanés pour le même membre).
const inFlight = new Set();

const INVISIBLE = /[\u200B-\u200D\u2060\uFE0E\uFE0F\u00AD]/g;

// ── Normalisation & correspondance ──────────────────────────────────────────

function normalizeStatus(text, { caseSensitive = false } = {}) {
  if (typeof text !== 'string') return '';
  let out = text
    .replace(INVISIBLE, '')
    .replace(/[\u2018\u2019\u0060\u00B4]/g, "'")   // apostrophes typographiques
    .replace(/\s+/g, ' ')
    .trim();
  if (!caseSensitive) {
    out = out.normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase();
  }
  return out;
}

/** Textes acceptés, un par ligne, dédoublonnés et bornés. */
function splitStatuses(raw) {
  const source = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const out = [];
  for (const entry of source) {
    for (const line of String(entry ?? '').split(/\r?\n/)) {
      const value = line.trim();
      if (!value) continue;
      const key = normalizeStatus(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length >= MAX_STATUSES) return out;
    }
  }
  return out;
}

function statusVariants(config = {}) {
  return splitStatuses(config.requiredStatuses || []);
}

/**
 * Le statut du membre correspond-il à l'un des textes configurés ?
 * @returns {{ variant:string, text:string }|null} la variante qui a matché
 */
function matchStatus(statusText, config = {}) {
  if (!statusText) return null;
  const variants = statusVariants(config);
  if (!variants.length) return null;
  const caseSensitive = Boolean(config.caseSensitive);
  const haystack = normalizeStatus(statusText, { caseSensitive });
  if (!haystack) return null;

  for (const variant of variants) {
    const needle = normalizeStatus(variant, { caseSensitive });
    if (!needle) continue;
    const hit = config.matchMode === 'exact' ? haystack === needle : haystack.includes(needle);
    if (hit) return { variant, text: statusText };
  }
  return null;
}

/** Texte du statut personnalisé d'une présence (ou d'un membre). */
function extractStatusText(source) {
  const activities = source?.activities || source?.presence?.activities || [];
  if (!Array.isArray(activities)) return null;
  for (const activity of activities) {
    const type = activity?.type;
    const isCustom = type === 4 || type === 'CUSTOM' || type === 'Custom';
    if (!isCustom) continue;
    const text = typeof activity.state === 'string' ? activity.state.trim() : '';
    if (text) return text;
  }
  return null;
}

// ── Conditions ──────────────────────────────────────────────────────────────

function checkEligibility(member, config = {}, now = Date.now()) {
  if (!member) return { ok: false, code: 'NO_MEMBER', reason: 'Membre introuvable.' };
  const user = member.user || {};
  const cond = config.conditions || {};

  if (user.bot && cond.ignoreBots !== false) {
    return { ok: false, code: 'BOT', reason: 'Les comptes bots sont ignorés.' };
  }

  const accountAgeDays = Math.floor((now - Number(user.createdTimestamp || now)) / DAY_MS);
  if (cond.minAccountAgeDays > 0 && accountAgeDays < cond.minAccountAgeDays) {
    return {
      ok: false,
      code: 'ACCOUNT_TOO_YOUNG',
      reason: `Compte trop récent : **${accountAgeDays} j** (minimum ${cond.minAccountAgeDays} j).`,
    };
  }

  const memberDays = Math.floor((now - Number(member.joinedTimestamp || now)) / DAY_MS);
  if (cond.minMemberDays > 0 && memberDays < cond.minMemberDays) {
    return {
      ok: false,
      code: 'MEMBER_TOO_RECENT',
      reason: `Ancienneté insuffisante : **${memberDays} j** sur le serveur (minimum ${cond.minMemberDays} j).`,
    };
  }

  if (cond.requiredRoleId && !member.roles?.cache?.has(cond.requiredRoleId)) {
    return { ok: false, code: 'MISSING_ROLE', reason: `Le rôle <@&${cond.requiredRoleId}> est requis avant le vanity.` };
  }

  const forbidden = (cond.forbiddenRoleIds || []).find(id => member.roles?.cache?.has(id));
  if (forbidden) {
    return { ok: false, code: 'FORBIDDEN_ROLE', reason: `Le rôle <@&${forbidden}> exclut du vanity.` };
  }

  return { ok: true, accountAgeDays, memberDays };
}

/** Le rôle peut-il être attribué par le bot à ce membre, maintenant ? */
function checkRole(member, config = {}) {
  const guild = member?.guild;
  const roleId = config.roleId;
  if (!guild || !roleId) return { ok: false, code: 'NO_ROLE', reason: 'Aucun rôle configuré.' };

  const role = guild.roles.cache.get(roleId);
  if (!role) return { ok: false, code: 'ROLE_MISSING', reason: 'Le rôle configuré n’existe plus.' };

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, code: 'NO_PERMISSION', reason: 'Permission **Gérer les rôles** manquante.' };
  }
  if (role.managed) {
    return {
      ok: false,
      code: 'ROLE_MANAGED',
      reason: 'Ce rôle est géré par une intégration (bot) : Discord interdit de l’attribuer à la main. Choisis un rôle normal.',
    };
  }
  if (role.position >= me.roles.highest.position) {
    return {
      ok: false,
      code: 'ROLE_TOO_HIGH',
      reason: `Mon rôle le plus haut (${me.roles.highest.name}) doit être **au-dessus** de <@&${roleId}>.`,
    };
  }
  // Volontairement aucun test sur `member.manageable` : il ne concerne que
  // l’expulsion, le bannissement et le timeout. Attribuer un rôle situé plus
  // bas que le mien reste autorisé même si le membre porte un rôle supérieur —
  // le refuser bloquerait les modérateurs et les administrateurs.
  return { ok: true, role };
}

// ── Rendu ───────────────────────────────────────────────────────────────────

function parseColor(value, fallback = COLORS.primary) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return match ? parseInt(match[1], 16) : fallback;
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderTemplate(template, ctx = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) => {
    const value = ctx[String(key).toLowerCase()];
    return value === undefined || value === null ? whole : String(value);
  });
}

function thumbnailFor(kind, member) {
  const value = String(kind || 'user').trim();
  if (!value || value === 'none') return null;
  if (value === 'user') return member.displayAvatarURL?.({ size: 256 }) || null;
  if (value === 'guild') return member.guild?.iconURL?.({ size: 256 }) || null;
  return /^https?:\/\//i.test(value) ? value : null;
}

function buildAnnouncementEmbed({ config, member, matched, holders = null }) {
  const data = config.embed || {};
  const role = config.roleId ? member.guild?.roles?.cache?.get(config.roleId) : null;
  const ctx = {
    user: `<@${member.id}>`,
    mention: `<@${member.id}>`,
    username: member.user?.username || member.id,
    tag: member.user?.tag || member.user?.username || member.id,
    server: member.guild?.name || '',
    role: config.roleId ? `<@&${config.roleId}>` : '',
    rolename: role?.name || '',
    status: matched || '',
    count: holders === null || holders === undefined ? '—' : String(holders),
    date: `<t:${Math.floor(Date.now() / 1000)}:F>`,
  };

  const embed = new EmbedBuilder()
    .setColor(parseColor(data.color, COLORS.primary))
    .setTitle(truncate(renderTemplate(data.title || '💎 Statut validé', ctx), 256))
    .setDescription(truncate(renderTemplate(data.description || '{mention} a validé le vanity.', ctx), 4096))
    .setTimestamp();

  if (data.author) {
    const author = truncate(renderTemplate(data.author, ctx), 256);
    if (author) embed.setAuthor({ name: author });
  }
  const thumb = thumbnailFor(data.thumbnail, member);
  if (thumb) embed.setThumbnail(thumb);
  if (data.image && /^https?:\/\//i.test(String(data.image).trim())) embed.setImage(String(data.image).trim());

  return brand.applyBrand(embed);
}

function buildLogEmbed({ action, member, config, matched = null, reason = null }) {
  const embed = new EmbedBuilder()
    .setColor(action === 'grant' ? COLORS.success : COLORS.warning)
    .setTitle(action === 'grant' ? '💎 Vanity — rôle attribué' : '↩️ Vanity — rôle retiré')
    .addFields(
      { name: 'Membre', value: `${member.user?.tag || member.id} (<@${member.id}>)`, inline: true },
      { name: 'Rôle', value: config.roleId ? `<@&${config.roleId}>` : '*aucun*', inline: true },
    )
    .setTimestamp();

  const avatar = member.displayAvatarURL?.({ size: 128 });
  if (avatar) embed.setThumbnail(avatar);
  if (matched) embed.addFields({ name: 'Statut', value: truncate(matched, 1024), inline: false });
  if (reason) embed.addFields({ name: 'Motif', value: truncate(reason, 1024), inline: false });
  return brand.applyBrand(embed);
}

// ── Envois ──────────────────────────────────────────────────────────────────

async function resolveTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const me = guild.members.me;
  if (!me) return null;
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  const perms = channel.permissionsFor(me);
  if (!perms?.has([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ])) return null;
  return channel;
}

function shouldAnnounce(previous, config, wasActive) {
  const behavior = config.behavior || {};
  if (!previous) return true;
  if (!previous.announcedAt) return true;
  if (behavior.announceOnce !== false) return false;   // une seule annonce à vie
  if (wasActive) return false;
  const days = Number(behavior.reannounceAfterDays) || 0;
  if (days <= 0) return true;
  return Date.now() - new Date(previous.announcedAt).getTime() >= days * DAY_MS;
}

async function announceGrant({ member, config, matched, holders, previous }) {
  const channel = await resolveTextChannel(member.guild, config.announceChannelId);
  if (!channel) return null;

  if (config.behavior?.deletePreviousAnnounce
    && previous?.announceChannelId && previous?.announceMessageId) {
    const old = member.guild.channels.cache.get(previous.announceChannelId)
      || await member.guild.channels.fetch(previous.announceChannelId).catch(() => null);
    if (old?.isTextBased?.()) {
      const message = await old.messages.fetch(previous.announceMessageId).catch(() => null);
      if (message) await message.delete().catch(() => {});
    }
  }

  const embed = buildAnnouncementEmbed({ config, member, matched, holders });
  // Aucun ping : la mention s'affiche sans notifier tout le serveur.
  const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  if (!message) return null;

  await VanityMember.updateOne(
    { guildId: member.guild.id, userId: member.id },
    { $set: { announcedAt: new Date(), announceChannelId: channel.id, announceMessageId: message.id } },
  ).catch(() => {});
  return message;
}

// ── Attribution / retrait ───────────────────────────────────────────────────

/**
 * Valide le vanity d'un membre : rôle, suivi en base, annonce et logs.
 * @returns {Promise<{ok:boolean, granted?:boolean, announced?:boolean, code?:string, reason?:string}>}
 */
async function grant(member, config, statusText, { source = 'presence' } = {}) {
  const guild = member?.guild;
  if (!guild) return { ok: false, code: 'NO_GUILD', reason: 'Serveur introuvable.' };

  const eligibility = checkEligibility(member, config);
  if (!eligibility.ok) return eligibility;

  const roleCheck = checkRole(member, config);
  if (!roleCheck.ok) return roleCheck;
  const { role } = roleCheck;

  const match = matchStatus(statusText, config);
  if (!match) return { ok: false, code: 'NO_MATCH', reason: 'Statut non conforme.' };

  const previous = await VanityMember.findOne({ guildId: guild.id, userId: member.id }).lean();
  const wasActive = Boolean(previous?.active) && member.roles.cache.has(role.id);
  const now = new Date();

  let granted = false;
  if (!member.roles.cache.has(role.id)) {
    const added = await member.roles
      .add(role, `Vanity — statut « ${truncate(statusText, 60)} »`)
      .then(() => true)
      .catch(() => false);
    if (!added) return { ok: false, code: 'ADD_FAILED', reason: 'Discord a refusé l’attribution du rôle — vérifie mes permissions et la position du rôle vanity.' };
    granted = true;
  }

  const update = {
    $set: {
      active: true,
      statusText: truncate(statusText, 200),
      matched: match.variant,
      lastSeenAt: now,
      announceChannelId: previous?.announceChannelId ?? null,
      announceMessageId: previous?.announceMessageId ?? null,
    },
    $setOnInsert: { firstGrantedAt: previous?.firstGrantedAt || now },
  };
  if (!wasActive) {
    update.$set.grantedAt = now;
    update.$set.revokedAt = null;
    update.$inc = { grantCount: 1 };
  }

  await VanityMember.findOneAndUpdate(
    { guildId: guild.id, userId: member.id },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).catch(() => null);

  activeCache.set(`${guild.id}:${member.id}`, true);
  if (!wasActive) {
    await VanityConfig.updateOne({ guildId: guild.id }, { $inc: { 'stats.totalGrants': 1 } }).catch(() => {});
  }

  let announced = false;
  if (shouldAnnounce(previous, config, wasActive)) {
    const holders = role.members?.size ?? null;
    const message = await announceGrant({ member, config, matched: match.variant, holders, previous });
    announced = Boolean(message);
    if (announced) {
      await VanityConfig.updateOne({ guildId: guild.id }, { $inc: { 'stats.totalAnnounces': 1 } }).catch(() => {});
    }
    if (config.behavior?.dmMember) {
      const embed = buildAnnouncementEmbed({ config, member, matched: match.variant, holders });
      member.send({ embeds: [embed] }).catch(() => {});
    }
  }

  if (granted || !wasActive) {
    const log = await resolveTextChannel(guild, config.logChannelId);
    if (log) {
      log.send({ embeds: [buildLogEmbed({ action: 'grant', member, config, matched: statusText })] }).catch(() => {});
    }
  }

  return { ok: true, granted, announced, wasActive, source };
}

async function revoke(member, config, record = null, reason = 'statut retiré') {
  const guild = member?.guild;
  if (!guild || !config?.roleId) return { ok: false, code: 'NO_ROLE' };

  if (member.roles.cache.has(config.roleId)) {
    const ok = await member.roles
      .remove(config.roleId, `Vanity — ${reason}`)
      .then(() => true)
      .catch(() => false);
    if (!ok) return { ok: false, code: 'REMOVE_FAILED', reason: 'Discord a refusé le retrait du rôle.' };
  }

  await VanityMember.updateOne(
    { guildId: guild.id, userId: member.id },
    { $set: { active: false, revokedAt: new Date() } },
  ).catch(() => {});
  activeCache.delete(`${guild.id}:${member.id}`);
  await VanityConfig.updateOne({ guildId: guild.id }, { $inc: { 'stats.totalRevokes': 1 } }).catch(() => {});

  const log = await resolveTextChannel(guild, config.logChannelId);
  if (log) {
    log.send({
      embeds: [buildLogEmbed({ action: 'revoke', member, config, matched: record?.statusText, reason })],
    }).catch(() => {});
  }
  return { ok: true };
}

// ── Événement : changement de statut ────────────────────────────────────────

/**
 * Retrait immédiat quand le statut a disparu ET que le délai de grâce est
 * écoulé. Appelé par `presenceUpdate` : sans lui, un membre gardait son rôle
 * jusqu'à 10 minutes après avoir retiré le statut (attente de la passe).
 * Le délai de grâce reste respecté — un statut qui clignote ne fait rien perdre.
 */
async function maybeRevokeNow(member, config) {
  const guild = member?.guild;
  if (!guild || !config?.roleId) return null;
  if (config.behavior?.removeOnLost === false) return null;
  if (!member.roles?.cache?.has(config.roleId)) return null;

  const record = await VanityMember.findOne({ guildId: guild.id, userId: member.id }).lean();
  if (!record?.active) return null;

  const graceMs = Math.max(0, Number(config.behavior?.graceMinutes) || 0) * MINUTE_MS;
  const lastSeen = new Date(record.lastSeenAt || record.grantedAt || 0).getTime();
  if (Number.isFinite(lastSeen) && Date.now() - lastSeen < graceMs) return null;

  const outcome = await revoke(member, config, record, 'statut retiré');
  return outcome?.ok ? { ok: true, revoked: true, wasActive: true } : outcome;
}

async function handlePresenceUpdate(oldPresence, newPresence) {
  const guild = newPresence?.guild;
  if (!guild) return null;

  const member = newPresence.member || guild.members.cache.get(newPresence.userId);
  if (!member || member.user?.bot) return null;

  const config = await readConfig({ guildId: guild.id });
  if (!config?.enabled || !config.roleId) return null;
  if (!statusVariants(config).length) return null;

  // Déjà validé il y a moins de 5 minutes : aucune écriture, aucun envoi.
  const key = `${guild.id}:${member.id}`;
  if (activeCache.get(key) && member.roles.cache.has(config.roleId)) return null;

  const statusText = extractStatusText(newPresence);
  if (!statusText || !matchStatus(statusText, config)) {
    // Le statut a disparu : si le délai de grâce est déjà écoulé, le rôle part
    // tout de suite (sinon la passe périodique s'en charge à échéance).
    return maybeRevokeNow(member, config);
  }

  if (inFlight.has(key)) return null;
  inFlight.add(key);
  try {
    return await grant(member, config, statusText, { source: 'presence' });
  } finally {
    inFlight.delete(key);
  }
}

// ── Passe périodique (rattrapage + retrait) ─────────────────────────────────

async function sweepGuild(guild, configOverride = null) {
  const config = configOverride || await readConfig({ guildId: guild.id });
  const result = { enabled: Boolean(config?.enabled), checked: 0, granted: 0, revoked: 0, skipped: 0 };
  if (!config?.enabled || !config.roleId) return result;

  // 1) Attribution : toute présence en cache qui affiche le statut.
  for (const presence of guild.presences.cache.values()) {
    const member = presence.member || guild.members.cache.get(presence.userId);
    if (!member || member.user?.bot) continue;
    result.checked++;
    const statusText = extractStatusText(presence);
    if (!statusText || !matchStatus(statusText, config)) continue;
    const outcome = await grant(member, config, statusText, { source: 'sweep' });
    if (outcome?.granted) result.granted++;
    else if (outcome && outcome.ok === false) result.skipped++;
  }

  // 2) Retrait : les porteurs du rôle qui n'affichent plus le statut, après le
  //    délai de grâce écoulé depuis la dernière fois où il a été vu.
  if (config.behavior?.removeOnLost !== false) {
    const graceMs = Math.max(0, Number(config.behavior?.graceMinutes) || 0) * MINUTE_MS;
    const now = Date.now();
    const holders = guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(config.roleId));

    for (const member of holders.values()) {
      const statusText = extractStatusText(member.presence);
      if (statusText && matchStatus(statusText, config)) continue;

      const record = await VanityMember.findOne({ guildId: guild.id, userId: member.id }).lean();
      if (!record?.active) continue;

      const lastSeen = new Date(record.lastSeenAt || record.grantedAt || 0).getTime();
      if (Number.isFinite(lastSeen) && now - lastSeen < graceMs) continue;

      const outcome = await revoke(member, config, record, 'statut retiré');
      if (outcome.ok) result.revoked++;
    }
  }

  await VanityConfig.updateOne(
    { guildId: guild.id },
    { $set: { 'stats.lastSweepAt': new Date() } },
  ).catch(() => {});

  return result;
}

async function sweepAll(client, { concurrency = 4 } = {}) {
  const guilds = [...client.guilds.cache.values()];
  const totals = { guilds: 0, checked: 0, granted: 0, revoked: 0, skipped: 0 };
  for (let i = 0; i < guilds.length; i += concurrency) {
    const batch = guilds.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(guild =>
      sweepGuild(guild).catch(err => {
        console.error(`[vanity] passe ${guild.name} (${guild.id}) :`, err.message);
        return null;
      })));
    for (const result of results) {
      if (!result?.enabled) continue;
      totals.guilds++;
      totals.checked += result.checked;
      totals.granted += result.granted;
      totals.revoked += result.revoked;
      totals.skipped += result.skipped;
    }
  }
  return totals;
}

// ── Contrôle à la demande (panneau) ─────────────────────────────────────────

function inspectMember(member, config) {
  const statusText = extractStatusText(member.presence);
  const match = statusText ? matchStatus(statusText, config) : null;
  return {
    statusText,
    matched: match?.variant || null,
    eligibility: checkEligibility(member, config),
    role: checkRole(member, config),
    hasRole: Boolean(config.roleId && member.roles.cache.has(config.roleId)),
  };
}

async function getConfig(guildId) {
  return readConfig({ guildId });
}

module.exports = {
  DAY_MS,
  MAX_STATUSES,
  normalizeStatus,
  splitStatuses,
  statusVariants,
  matchStatus,
  extractStatusText,
  checkEligibility,
  checkRole,
  parseColor,
  truncate,
  renderTemplate,
  buildAnnouncementEmbed,
  buildLogEmbed,
  shouldAnnounce,
  grant,
  revoke,
  handlePresenceUpdate,
  maybeRevokeNow,
  sweepGuild,
  sweepAll,
  inspectMember,
  getConfig,
};
