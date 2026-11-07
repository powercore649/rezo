// utils/starterPack.js — Starter Pack REZO : structure + panneaux essentiels.
//
// Le pack installe en une fois la base d'un serveur propre : rôles, catégories
// et salons avec permissions, puis publication des panneaux (règlement avec
// bouton d'acceptation, tickets, signalement), activation des avis et de
// l'accueil. C'est le même contenu qui est calculé par l'aperçu et appliqué par
// l'installation : ce que le staff voit est exactement ce qui sera créé.
//
// Trois garanties :
//   • Idempotent — un élément existant (même nom) n'est jamais recréé ni écrasé.
//   • Réversible — tout ce qui est créé est enregistré (StarterPack) et peut
//     être supprimé par la désinstallation, sans toucher au reste du serveur.
//   • Tolérant — un élément en échec n'interrompt pas le reste, il est reporté.
const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { COLORS } = require('./embeds');

const PACK_VERSION = 1;

// ─── Rôles créés par le pack ─────────────────────────────────────────────────
const ROLES = [
  { key: 'member',  name: 'Membre',  color: '#8B1A1A', hoist: false, mentionable: true,  permissions: [] },
  { key: 'staff',   name: 'Staff',   color: '#E67E22', hoist: true,  mentionable: true,  permissions: ['ManageMessages', 'KickMembers', 'ModerateMembers'] },
  { key: 'support', name: 'Support', color: '#1ABC9C', hoist: true,  mentionable: true,  permissions: ['ManageChannels', 'ManageMessages'] },
  { key: 'muted',   name: 'Muet',    color: '#2B2D31', hoist: false, mentionable: false, permissions: [] },
];

// ─── Catégories et salons ────────────────────────────────────────────────────
// kind : 'text' | 'voice'
// readOnly : lecture seule pour @everyone (le staff écrit)
// staffOnly : invisible pour @everyone, visible de Staff et Support
const STRUCTURE = [
  {
    key: 'info', name: '📢・INFORMATIONS',
    channels: [
      { key: 'rules',    name: '📜・règlement', kind: 'text', readOnly: true },
      { key: 'announce', name: '📣・annonces',  kind: 'text', readOnly: true },
    ],
  },
  {
    key: 'community', name: '💬・COMMUNAUTÉ',
    channels: [
      { key: 'general', name: '💬・général',   kind: 'text' },
      { key: 'welcome', name: '👋・bienvenue', kind: 'text', readOnly: true },
      { key: 'voice',   name: '🔊・Général',   kind: 'voice' },
    ],
  },
  {
    key: 'support', name: '🎫・SUPPORT',
    channels: [
      { key: 'tickets', name: '🎫・ouvrir-un-ticket', kind: 'text', readOnly: true },
      { key: 'reviews', name: '⭐・avis',             kind: 'text', readOnly: true },
      { key: 'reports', name: '🚨・signalements',     kind: 'text', readOnly: true },
    ],
  },
  {
    key: 'admin', name: '🔧・ADMINISTRATION', staffOnly: true,
    channels: [
      { key: 'logs',    name: '📋・logs',   kind: 'text',  staffOnly: true },
      { key: 'staffvc', name: '🔊・Staff',  kind: 'voice', staffOnly: true },
    ],
  },
];

// ─── Règlement par défaut ────────────────────────────────────────────────────
const DEFAULT_RULES = [
  'Respectez tout le monde : aucune insulte, discrimination ni harcèlement.',
  'Pas de spam, de flood, ni de publicité non autorisée.',
  'Aucun contenu illégal, choquant ou NSFW.',
  'Respectez les décisions du staff et passez par un ticket en cas de litige.',
  'Utilisez les salons prévus à cet effet et gardez les discussions dans le bon salon.',
  'En restant ici, vous acceptez ces règles.',
];

// ─── Panneaux publiés par le pack ────────────────────────────────────────────
const POSTS = [
  { key: 'rules',   channel: 'rules',   label: 'Règlement publié (bouton d\'acceptation)' },
  { key: 'tickets', channel: 'tickets', label: 'Panneau de tickets (Support + Aide)' },
  { key: 'reviews', channel: 'reviews', label: 'Salon d\'avis configuré + mode d\'emploi' },
  { key: 'reports', channel: 'reports', label: 'Bouton « Signaler » publié' },
  { key: 'welcome', channel: 'welcome', label: 'Messages d\'accueil activés' },
];

// ─── Recherche d'éléments existants (par nom, insensible à la casse) ──────────
const norm = value => String(value || '').trim().toLowerCase();

function findRole(guild, name) {
  return guild.roles?.cache?.find(r => norm(r.name) === norm(name)) || null;
}

function findCategory(guild, name) {
  return guild.channels?.cache?.find(c => c.type === ChannelType.GuildCategory && norm(c.name) === norm(name)) || null;
}

function findChannel(guild, name, parentId = null) {
  return guild.channels?.cache?.find(c =>
    c.type !== ChannelType.GuildCategory
    && norm(c.name) === norm(name)
    && (!parentId || c.parentId === parentId)) || null;
}

// ─── Permissions des salons ──────────────────────────────────────────────────
/**
 * Construit les surcharges de permissions d'un salon créé par le pack.
 * Le bot reçoit toujours un accès explicite : sans lui, un salon en lecture
 * seule pourrait empêcher la publication des panneaux.
 */
function channelOverwrites(item, ids) {
  const overwrites = [];
  const isVoice = item.kind === 'voice';

  const staffAllow = isVoice
    ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
    : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];

  if (item.staffOnly) {
    overwrites.push({ id: ids.everyone, deny: [PermissionFlagsBits.ViewChannel] });
    for (const roleId of [ids.roles.staff, ids.roles.support]) {
      if (roleId) overwrites.push({ id: roleId, allow: staffAllow });
    }
  } else if (item.readOnly) {
    overwrites.push({
      id: ids.everyone,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: isVoice
        ? [PermissionFlagsBits.Speak]
        : [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
    });
    for (const roleId of [ids.roles.staff, ids.roles.support]) {
      if (roleId) overwrites.push({ id: roleId, allow: staffAllow });
    }
  }

  if (ids.bot) {
    overwrites.push({
      id: ids.bot,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.EmbedLinks],
    });
  }

  return overwrites;
}

// ─── Plan : ce qui existe déjà, ce qui sera créé ─────────────────────────────
function buildPlan(guild, state = null) {
  const roles = ROLES.map(role => ({ ...role, existing: findRole(guild, role.name) }));

  const categories = [];
  const channels = [];
  for (const category of STRUCTURE) {
    const existingCat = findCategory(guild, category.name);
    categories.push({ ...category, existing: existingCat });
    for (const channel of category.channels) {
      channels.push({
        ...channel,
        categoryKey: category.key,
        categoryName: category.name,
        parentId: existingCat?.id || null,
        existing: findChannel(guild, channel.name, existingCat?.id || undefined),
      });
    }
  }

  const donePanels = new Set((state?.created?.panels || []).map(p => p.key));
  const posts = POSTS.map(post => ({ ...post, existing: donePanels.has(post.key) }));

  const all = [...roles, ...categories, ...channels, ...posts];
  return {
    roles, categories, channels, posts,
    toCreate: all.filter(i => !i.existing).length,
    existing: all.filter(i => i.existing).length,
  };
}

// ─── Utilitaires internes ────────────────────────────────────────────────────
async function resolveChannel(guild, channelId) {
  if (!channelId) return null;
  const cached = guild.channels?.cache?.get(channelId);
  if (cached) return cached;
  return guild.channels?.fetch(channelId).catch(() => null) || null;
}

function pushHistory(state, line) {
  if (!state) return;
  if (typeof state.addHistory === 'function') state.addHistory(line);
  else if (Array.isArray(state.history)) state.history.push(String(line).slice(0, 200));
}

// ─── Publication des panneaux ────────────────────────────────────────────────
// Chaque publication réutilise le système existant du bot (mêmes boutons, mêmes
// handlers) : aucun panneau « parallèle » qui ne fonctionnerait qu'à moitié.

async function postRules(guild, ctx) {
  const Reglement = require('../models/Reglement');
  const reglementCmd = require('../commands/configuration/reglement');

  let reg = await Reglement.findOne({ guildId: guild.id });
  if (!reg) reg = await Reglement.create({ guildId: guild.id });
  if (!reg.rules?.length) reg.rules = [...DEFAULT_RULES];
  if (!reg.acceptRoleId && ctx.roleIds.member) reg.acceptRoleId = ctx.roleIds.member;
  reg.channelId = ctx.channelIds.rules;

  const channel = await resolveChannel(guild, ctx.channelIds.rules);
  if (!channel?.isTextBased?.()) return null;

  const embed = reglementCmd.buildReglementEmbed(reg, guild);

  const components = reg.acceptRoleId
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('reglement_accept').setLabel(reg.acceptLabel || '✅ J\'accepte le règlement').setStyle(ButtonStyle.Success),
    )]
    : [];

  const previous = reg.messageId ? await channel.messages.fetch(reg.messageId).catch(() => null) : null;
  const msg = previous
    ? await previous.edit({ embeds: [embed], components })
    : await channel.send({ embeds: [embed], components });

  reg.messageId = msg.id;
  reg.publishedUrl = msg.url;
  reg.updatedAt = new Date();
  await reg.save();
  return { channelId: channel.id, messageId: msg.id, url: msg.url };
}

async function postTickets(guild, ctx) {
  const TicketPanel = require('../models/TicketPanel');
  const ticketEngine = require('./ticketEngine');

  let panel = await TicketPanel.findOne({ guildId: guild.id }).catch(() => null);
  if (!panel) {
    panel = await TicketPanel.create({
      guildId: guild.id,
      panelKey: await ticketEngine.nextPanelKey(guild.id),
      name: 'Support',
      channelId: ctx.channelIds.tickets,
      embedTitle: '🎫 Support REZO',
      embedDesc: 'Choisis une catégorie ci-dessous pour ouvrir un ticket. Un membre du staff te répondra dès que possible.',
      embedColor: '8B1A1A',
      buttonLabel: '🎫 Ouvrir un ticket',
      welcomeMessage: 'Merci d\'avoir ouvert un ticket ! Décris ton problème le plus précisément possible.',
      categories: [
        { key: 'support', name: '🎟️ Support général', emoji: '🎟️', description: 'Une question, un problème technique', channelPrefix: 'support', defaultPriority: 'normal', limitPerUser: 3, enabled: true },
        { key: 'report',  name: '🚨 Signaler un membre', emoji: '🚨', description: 'Comportement contraire au règlement', channelPrefix: 'signalement', defaultPriority: 'high', limitPerUser: 3, enabled: true },
      ],
    });
  } else {
    panel.channelId = ctx.channelIds.tickets;
    await panel.save().catch(() => {});
  }

  await resolveChannel(guild, ctx.channelIds.tickets); // garantit la présence dans le cache
  const res = await ticketEngine.postPanel(guild, panel);
  return res ? { channelId: ctx.channelIds.tickets, messageId: res.id, url: res.url } : null;
}

async function postReviews(guild, ctx) {
  const { AvisConfig } = require('../models/Review');

  let cfg = await AvisConfig.findOne({ guildId: guild.id });
  if (!cfg) cfg = await AvisConfig.create({ guildId: guild.id });
  cfg.enabled = true;
  cfg.reviewChannelId = ctx.channelIds.reviews;
  if (ctx.channelIds.logs) cfg.logChannelId = ctx.channelIds.logs;
  await cfg.save();

  const channel = await resolveChannel(guild, ctx.channelIds.reviews);
  if (!channel?.isTextBased?.()) return null;

  const embed = new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle('⭐ Votre avis compte')
    .setDescription(
      'Vous voulez donner votre avis sur le serveur ? Utilisez la commande **`/avis noter`** :\n'
      + 'notez de 1 à 5 étoiles, ajoutez un commentaire (et une capture si vous voulez).\n\n'
      + 'Les avis publiés apparaissent ici même, et le réseau REZO peut les mettre en avant.',
    )
    .setFooter({ text: 'REZO • Avis' });

  const msg = await channel.send({ embeds: [embed] });
  return { channelId: channel.id, messageId: msg.id, url: msg.url };
}

async function postReports(guild, ctx) {
  const { Config } = require('../models/Signalement');

  let cfg = await Config.findOne({ guildId: guild.id });
  if (!cfg) cfg = await Config.create({ guildId: guild.id });
  cfg.enabled = true;
  if (ctx.channelIds.logs) cfg.logChannelId = ctx.channelIds.logs;
  await cfg.save();

  const channel = await resolveChannel(guild, ctx.channelIds.reports);
  if (!channel?.isTextBased?.()) return null;

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🚨 Signaler un problème')
    .setDescription('Un membre enfreint le règlement ? Un message pose problème ?\nUtilisez le bouton ci-dessous pour alerter le staff en 30 secondes.\n\n*Le signalement est confidentiel — n\'abusez pas du système.*');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sig_open_generic').setLabel('Signaler').setEmoji('🚨').setStyle(ButtonStyle.Danger),
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  return { channelId: channel.id, messageId: msg.id, url: msg.url };
}

async function postWelcome(guild, ctx) {
  const { Welcome } = require('../models/Welcome');

  let welcome = await Welcome.findOne({ guildId: guild.id });
  if (!welcome) welcome = await Welcome.create({ guildId: guild.id });
  welcome.enabled = true;
  if (ctx.channelIds.welcome) welcome.channelId = ctx.channelIds.welcome;
  await welcome.save();

  return { channelId: welcome.channelId || null, messageId: null, url: null };
}

const POSTERS = {
  rules: postRules,
  tickets: postTickets,
  reviews: postReviews,
  reports: postReports,
  welcome: postWelcome,
};

// ─── Installation ────────────────────────────────────────────────────────────
/**
 * Installe le pack. Rien n'est jamais supprimé ni renommé : on complète.
 * @param {import('discord.js').Guild} guild
 * @param {object} plan            résultat de buildPlan()
 * @param {{ state?: object, persist?: Function, onProgress?: Function }} [opts]
 */
async function install(guild, plan, { state = null, persist = async () => {}, onProgress = null } = {}) {
  const report = {
    createdRoles: [], createdCategories: [], createdChannels: [],
    createdPanels: [], skipped: [], failed: [],
  };
  const roleIds = {};
  const channelIds = {};
  const everyone = guild.roles?.everyone?.id || guild.id;
  const botId = guild.members?.me?.id || null;
  const ids = { everyone, roles: {}, bot: botId };

  const tick = async (label) => {
    if (typeof onProgress === 'function') await onProgress(label).catch(() => {});
  };

  // 1) Rôles
  for (const role of plan.roles) {
    if (role.existing) {
      roleIds[role.key] = role.existing.id;
      report.skipped.push(`Rôle **${role.name}** (déjà présent)`);
      continue;
    }
    try {
      const created = await guild.roles.create({
        name: role.name, color: role.color, hoist: role.hoist,
        mentionable: role.mentionable, permissions: role.permissions,
        reason: 'Starter Pack REZO',
      });
      roleIds[role.key] = created.id;
      report.createdRoles.push({ key: role.key, id: created.id, name: created.name });
      state?.created?.roles?.push({ key: role.key, id: created.id, name: created.name });
      await tick(`Rôle ${role.name}`);
      await persist();
    } catch (err) {
      report.failed.push({ what: `Rôle ${role.name}`, error: err.message });
    }
  }
  ids.roles = roleIds;

  // 2) Catégories
  const categoryIds = {};
  for (const category of plan.categories) {
    if (category.existing) {
      categoryIds[category.key] = category.existing.id;
      report.skipped.push(`Catégorie **${category.name}** (déjà présente)`);
      continue;
    }
    try {
      const created = await guild.channels.create({
        name: category.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: category.staffOnly
          ? [
            { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
            ...[roleIds.staff, roleIds.support].filter(Boolean).map(id => ({
              id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            })),
            ...(botId ? [{ id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }] : []),
          ]
          : undefined,
        reason: 'Starter Pack REZO',
      });
      categoryIds[category.key] = created.id;
      report.createdCategories.push({ key: category.key, id: created.id, name: created.name });
      state?.created?.categories?.push({ key: category.key, id: created.id, name: created.name });
      await tick(`Catégorie ${category.name}`);
      await persist();
    } catch (err) {
      report.failed.push({ what: `Catégorie ${category.name}`, error: err.message });
    }
  }

  // 3) Salons
  for (const channel of plan.channels) {
    const parentId = categoryIds[channel.categoryKey] || channel.parentId || null;
    if (channel.existing) {
      channelIds[channel.key] = channel.existing.id;
      report.skipped.push(`Salon **#${channel.name}** (déjà présent)`);
      continue;
    }
    try {
      const created = await guild.channels.create({
        name: channel.name,
        type: channel.kind === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: parentId || undefined,
        permissionOverwrites: channelOverwrites(channel, ids),
        reason: 'Starter Pack REZO',
      });
      channelIds[channel.key] = created.id;
      report.createdChannels.push({ key: channel.key, id: created.id, name: created.name });
      state?.created?.channels?.push({ key: channel.key, id: created.id, name: created.name, type: channel.kind });
      await tick(`Salon ${channel.name}`);
      await persist();
    } catch (err) {
      report.failed.push({ what: `Salon #${channel.name}`, error: err.message });
    }
  }

  // 4) Panneaux (les clés de salons manquants viennent d'un échec précédent)
  const ctx = { roleIds, channelIds, everyone };
  for (const post of plan.posts) {
    // Idempotence : un panneau déjà publié (mémorisé dans StarterPack) n'est
    // jamais reposté — sinon chaque relance dupliquerait les messages.
    if (post.existing) {
      report.skipped.push(`Panneau **${post.label}** (déjà publié)`);
      continue;
    }
    if (!channelIds[post.channel]) {
      report.failed.push({ what: post.label, error: 'salon indisponible' });
      continue;
    }
    try {
      const res = await POSTERS[post.key](guild, ctx);
      if (!res) {
        report.failed.push({ what: post.label, error: 'envoi impossible (permissions ?)' });
        continue;
      }
      report.createdPanels.push({ key: post.key, ...res });
      const existing = state?.created?.panels?.find(p => p.key === post.key);
      if (existing) {
        existing.channelId = res.channelId; existing.messageId = res.messageId; existing.url = res.url;
      } else {
        state?.created?.panels?.push({ key: post.key, channelId: res.channelId, messageId: res.messageId, url: res.url });
      }
      await tick(post.label);
      await persist();
    } catch (err) {
      report.failed.push({ what: post.label, error: err.message });
    }
  }

  return report;
}

// ─── Désinstallation ─────────────────────────────────────────────────────────
/**
 * Supprime uniquement ce que le pack a créé (salons, catégories, rôles) et
 * remet à l'état antérieur les réglages qu'il a modifiés. Les configurations
 * du staff (règlement, panneau de tickets…) sont conservées.
 */
async function uninstall(guild, state, { onProgress = null } = {}) {
  const report = { removedChannels: [], removedRoles: [], removedMessages: [], failed: [] };
  const created = state?.created || {};
  const tick = async (label) => {
    if (typeof onProgress === 'function') await onProgress(label).catch(() => {});
  };

  // 1) Messages publiés par le pack
  for (const panel of created.panels || []) {
    if (!panel.channelId || !panel.messageId) continue;
    try {
      const channel = await resolveChannel(guild, panel.channelId);
      const msg = channel ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
      if (msg) {
        await msg.delete().catch(() => {});
        report.removedMessages.push(panel.key);
      }
    } catch (err) {
      report.failed.push({ what: `Message ${panel.key}`, error: err.message });
    }
  }

  // 2) Salons, puis catégories, puis rôles (ordre inverse de la création)
  for (const item of [...(created.channels || [])].reverse()) {
    try {
      const channel = await resolveChannel(guild, item.id);
      if (!channel) continue;
      await channel.delete('Starter Pack REZO — désinstallation');
      report.removedChannels.push(item.name || item.id);
      await tick(`Suppression de ${item.name || item.id}`);
    } catch (err) {
      report.failed.push({ what: `Salon ${item.name || item.id}`, error: err.message });
    }
  }
  for (const item of [...(created.categories || [])].reverse()) {
    try {
      const channel = await resolveChannel(guild, item.id);
      if (!channel) continue;
      await channel.delete('Starter Pack REZO — désinstallation');
      report.removedChannels.push(item.name || item.id);
      await tick(`Suppression de ${item.name || item.id}`);
    } catch (err) {
      report.failed.push({ what: `Catégorie ${item.name || item.id}`, error: err.message });
    }
  }
  for (const item of [...(created.roles || [])].reverse()) {
    try {
      const role = guild.roles?.cache?.get(item.id) || await guild.roles?.fetch(item.id).catch(() => null);
      if (!role) continue;
      await role.delete('Starter Pack REZO — désinstallation');
      report.removedRoles.push(item.name || item.id);
      await tick(`Suppression du rôle ${item.name || item.id}`);
    } catch (err) {
      report.failed.push({ what: `Rôle ${item.name || item.id}`, error: err.message });
    }
  }

  // 3) Réglages modifiés par le pack, remis en arrière seulement si la valeur
  //    pointée est bien celle que le pack a installée (sinon on ne touche à rien).
  const createdChannelIds = new Set((created.channels || []).map(c => c.id));
  try {
    const { Welcome } = require('../models/Welcome');
    const welcome = await Welcome.findOne({ guildId: guild.id });
    if (welcome?.enabled && welcome.channelId && createdChannelIds.has(welcome.channelId)) {
      welcome.enabled = false;
      welcome.channelId = null;
      await welcome.save();
    }
  } catch { /* réglage optionnel */ }

  try {
    const { AvisConfig } = require('../models/Review');
    const cfg = await AvisConfig.findOne({ guildId: guild.id });
    if (cfg?.reviewChannelId && createdChannelIds.has(cfg.reviewChannelId)) {
      cfg.reviewChannelId = null;
      await cfg.save();
    }
  } catch { /* réglage optionnel */ }

  return report;
}

// ─── Aperçu et bilans (embeds du panneau) ────────────────────────────────────
function countLine(items) {
  const toCreate = items.filter(i => !i.existing).length;
  const existing = items.length - toCreate;
  return { toCreate, existing };
}

function buildPreviewEmbed(guild, plan, { state = null, note = null } = {}) {
  const roles = countLine(plan.roles);
  const categories = countLine(plan.categories);
  const channels = countLine(plan.channels);
  const posts = countLine(plan.posts);

  const nextRoles = plan.roles.filter(r => !r.existing).map(r => `\`${r.name}\``).join(', ') || '*rien*';
  const nextCategories = plan.categories.filter(c => !c.existing).map(c => `\`${c.name}\``).join(', ') || '*rien*';
  const nextChannels = plan.channels.filter(c => !c.existing).map(c => `\`${c.name}\``).join(', ') || '*rien*';
  const nextPosts = plan.posts.filter(p => !p.existing).map(p => `• ${p.label}`).join('\n') || '*rien*';

  const installedLine = state?.installedAt
    ? `\n**Dernière installation :** <t:${Math.floor(new Date(state.installedAt).getTime() / 1000)}:R>${state.installedBy ? ` par <@${state.installedBy}>` : ''}`
    : '';

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🚀 Starter Pack REZO')
    .setDescription(
      'Le pack installe la base d\'un serveur propre, **sans jamais toucher** à ce qui existe déjà :\n'
      + 'un élément portant le même nom est simplement réutilisé.\n'
      + installedLine
      + (note ? `\n\n${note}` : ''),
    )
    .addFields(
      { name: `🎭 Rôles (${roles.toCreate} à créer)`, value: nextRoles, inline: false },
      { name: `🗂️ Catégories (${categories.toCreate} à créer)`, value: nextCategories, inline: false },
      { name: `💬 Salons (${channels.toCreate} à créer)`, value: nextChannels, inline: false },
      { name: `📌 Panneaux (${posts.toCreate} à publier)`, value: nextPosts, inline: false },
    )
    .setFooter({ text: `REZO • ${plan.toCreate} élément(s) à créer, ${plan.existing} déjà en place` });

  return embed;
}

function buildPreviewComponents({ installed = false, busy = false } = {}) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sp_install').setLabel('Installer').setEmoji('🚀').setStyle(ButtonStyle.Success).setDisabled(busy),
    new ButtonBuilder().setCustomId('sp_status').setLabel('Statut').setEmoji('📋').setStyle(ButtonStyle.Secondary).setDisabled(busy),
    new ButtonBuilder().setCustomId('sp_uninstall').setLabel('Désinstaller').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!installed || busy),
    new ButtonBuilder().setCustomId('sp_close').setLabel('Fermer').setEmoji('❌').setStyle(ButtonStyle.Secondary).setDisabled(busy),
  )];
}

function buildBackComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sp_back').setLabel('Retour à l\'aperçu').setEmoji('🔙').setStyle(ButtonStyle.Secondary),
  )];
}

/** Embed affiché pendant une opération longue (installation / désinstallation). */
function buildBusyEmbed(label) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⏳ Starter Pack en cours…')
    .setDescription(label ? `Étape : **${label}**` : 'Préparation…')
    .setFooter({ text: 'REZO • Starter Pack' });
}

function buildPreviewPayload(guild, plan, opts = {}) {
  return { embeds: [buildPreviewEmbed(guild, plan, opts)], components: buildPreviewComponents(opts) };
}

function buildInstallEmbed(report, { durationMs = null } = {}) {
  const ok = report.failed.length === 0;
  const lines = [];
  if (report.createdRoles.length) lines.push(`🎭 Rôles : ${report.createdRoles.map(r => `\`${r.name}\``).join(', ')}`);
  if (report.createdCategories.length) lines.push(`🗂️ Catégories : ${report.createdCategories.map(c => `\`${c.name}\``).join(', ')}`);
  if (report.createdChannels.length) lines.push(`💬 Salons : ${report.createdChannels.map(c => `\`${c.name}\``).join(', ')}`);
  if (report.createdPanels.length) lines.push(`📌 Panneaux : ${report.createdPanels.map(p => POSTS.find(x => x.key === p.key)?.label || p.key).join(', ')}`);
  if (!lines.length) lines.push('*Rien à créer : tout était déjà en place.*');
  if (report.skipped.length) lines.push(`\n♻️ **Réutilisés** : ${report.skipped.length} élément(s) déjà présent(s).`);
  if (report.failed.length) lines.push(`\n⚠️ **Échecs :**\n${report.failed.map(f => `• ${f.what} — ${f.error}`).join('\n')}`);

  return new EmbedBuilder()
    .setColor(ok ? COLORS.success : COLORS.warning)
    .setTitle(ok ? '✅ Starter Pack installé' : '⚠️ Starter Pack installé partiellement')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `REZO • Starter Pack${durationMs ? ` en ${(durationMs / 1000).toFixed(1)} s` : ''}` });
}

function buildUninstallEmbed(report) {
  const lines = [];
  if (report.removedChannels.length) lines.push(`💬 Salons supprimés : ${report.removedChannels.map(n => `\`${n}\``).join(', ')}`);
  if (report.removedRoles.length) lines.push(`🎭 Rôles supprimés : ${report.removedRoles.map(n => `\`${n}\``).join(', ')}`);
  if (report.removedMessages.length) lines.push(`📌 Messages retirés : ${report.removedMessages.length}`);
  if (!lines.length) lines.push('*Rien à supprimer : le pack ne trouve plus ses éléments.*');
  if (report.failed.length) lines.push(`\n⚠️ **Échecs :**\n${report.failed.map(f => `• ${f.what} — ${f.error}`).join('\n')}`);

  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🗑️ Starter Pack désinstallé')
    .setDescription(`${lines.join('\n')}\n\n*Les réglages du staff (règlement, panneaux, avis) restent enregistrés.*`)
    .setFooter({ text: 'REZO • Starter Pack' });
}

function buildUninstallConfirmPayload(state) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle('🗑️ Désinstaller le Starter Pack ?')
    .setDescription(
      'Seront supprimés **uniquement** les éléments que le pack a créés :\n'
      + `• ${state?.created?.channels?.length || 0} salon(s) et ${state?.created?.categories?.length || 0} catégorie(s)\n`
      + `• ${state?.created?.roles?.length || 0} rôle(s)\n`
      + `• ${state?.created?.panels?.length || 0} message(s) publiés par le pack\n\n`
      + 'Les salons, rôles et messages que **tu** as créés ne sont jamais touchés.',
    )
    .setFooter({ text: 'Cette action est irréversible' });

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sp_uninstall_confirm').setLabel('Confirmer la suppression').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('sp_refresh').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function buildStatusEmbed(guild, state, plan) {
  const created = state?.created || {};
  const fmt = list => (list?.length ? list.map(i => `\`${i.name || i.id}\``).join(', ') : '*aucun*');
  const panels = created.panels || [];

  return new EmbedBuilder()
    .setColor(state?.status === 'installed' ? COLORS.success : COLORS.info)
    .setTitle('📋 Statut du Starter Pack')
    .setDescription(
      (state?.status === 'installed'
        ? `Installé <t:${Math.floor(new Date(state.installedAt).getTime() / 1000)}:R>${state.installedBy ? ` par <@${state.installedBy}>` : ''}.`
        : state?.status === 'removed'
          ? 'Désinstallé. Les réglages du staff sont conservés.'
          : 'Jamais installé sur ce serveur.')
      + `\n\n**Il reste ${plan.toCreate} élément(s) à créer** pour être complet.`
      + (state?.history?.length ? `\n\n**Dernières opérations :**\n${state.history.slice(-5).map(h => `• ${h}`).join('\n')}` : ''),
    )
    .addFields(
      { name: '🎭 Rôles créés', value: fmt(created.roles), inline: false },
      { name: '🗂️ Catégories créées', value: fmt(created.categories), inline: false },
      { name: '💬 Salons créés', value: fmt(created.channels), inline: false },
      {
        name: '📌 Panneaux publiés',
        value: panels.length
          ? panels.map(p => `• ${POSTS.find(x => x.key === p.key)?.label || p.key}${p.url ? ` — [voir](${p.url})` : ''}`).join('\n')
          : '*aucun*',
        inline: false,
      },
    )
    .setFooter({ text: 'REZO • Starter Pack' });
}

module.exports = {
  PACK_VERSION, ROLES, STRUCTURE, POSTS, DEFAULT_RULES,
  buildPlan, channelOverwrites, install, uninstall,
  buildPreviewEmbed, buildPreviewComponents, buildPreviewPayload,
  buildInstallEmbed, buildUninstallEmbed, buildUninstallConfirmPayload, buildStatusEmbed,
  buildBackComponents, buildBusyEmbed,
  findRole, findCategory, findChannel,
};
