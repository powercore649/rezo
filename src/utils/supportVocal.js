'use strict';
// utils/supportVocal.js — Support vocal : ticket vocal pour serveurs communautaires.
//
// Principe : un membre clique sur le panneau public → le bot lui crée un salon
// VOCAL privé (membre + rôle staff), publie une carte de demande dans le salon
// des demandes, et le staff peut « rejoindre », « prendre en charge » ou
// « fermer ». Quand plus personne n'est dans le salon, la demande se ferme et
// le salon est supprimé.
//
// Pourquoi séparé de /ticket : /ticket crée un salon TEXTE avec transcript.
// Ici, tout se passe en vocal — c'est ce qu'attendent les serveurs communautaires
// (aide en direct, coaching, permanence). Aucune connexion vocale du bot n'est
// nécessaire : on ne fait que créer/déplacer des salons et lire l'état vocal.
//
// Le module expose :
//   • des helpers PURS (testables hors-ligne) : evaluateOpening, channelName,
//     buildPanelEmbed, buildPanelComponents, buildRequestEmbed,
//     buildRequestComponents, buildInfoEmbed, healthChecks ;
//   • les effets Discord : publishPanel, createRequest, claimRequest,
//     closeRequest, handleTicketButton, handleVoiceUpdate.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { COLORS } = require('./embeds');
const { SupportVocalConfig, SupportVocal } = require('../models/SupportVocal');

const DEFAULTS = {
  nameTemplate: '🎧・support-{user}',
  maxOpenPerUser: 1,
  cooldownSeconds: 120,
};

const STATUS_LABEL = { open: '🟢 Ouverte', closed: '🔴 Fermée' };

// ─── Réglages (bornés : une valeur abîmée en base ne casse rien) ─────────────
function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function settings(cfg = {}) {
  return {
    enabled:         cfg.enabled !== false,
    nameTemplate:    String(cfg.nameTemplate || DEFAULTS.nameTemplate).slice(0, 100),
    maxOpenPerUser:  boundedInt(cfg.maxOpenPerUser, DEFAULTS.maxOpenPerUser, 1, 10),
    cooldownSeconds: boundedInt(cfg.cooldownSeconds, DEFAULTS.cooldownSeconds, 0, 86_400),
    autoCloseEmpty:  cfg.autoCloseEmpty !== false,
    mentionStaff:    cfg.mentionStaff !== false,
  };
}

// ─── Helpers purs ─────────────────────────────────────────────────────────────

/** Nom du salon vocal privé : {user} {tag} {server}. */
function channelName(template, { username = 'membre', tag = '', server = '' } = {}) {
  return String(template || DEFAULTS.nameTemplate)
    .replace(/\{user\}/g, username)
    .replace(/\{tag\}/g, tag || username)
    .replace(/\{server\}/g, server)
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 100) || 'support';
}

/**
 * Peut-on ouvrir une demande maintenant ?
 * Pure : parfaitement testable (limite, cooldown, configuration).
 *
 * @returns {{ok:boolean, reason?:string}}
 */
function evaluateOpening({ cfg, openCount = 0, lastOpenedAt = 0, now = Date.now() } = {}) {
  const s = settings(cfg || {});
  if (!s.enabled) return { ok: false, reason: 'Le support vocal est désactivé sur ce serveur.' };
  if (!cfg?.requestChannelId) {
    return { ok: false, reason: 'Le support vocal n\'est pas encore configuré. Un administrateur peut lancer `/support-vocal setup`.' };
  }
  if (openCount >= s.maxOpenPerUser) {
    return { ok: false, reason: `Vous avez déjà **${openCount}** demande(s) en cours (limite : **${s.maxOpenPerUser}**).` };
  }
  const cooldownMs = s.cooldownSeconds * 1000;
  if (cooldownMs > 0 && lastOpenedAt && now - lastOpenedAt < cooldownMs) {
    const wait = Math.ceil((cooldownMs - (now - lastOpenedAt)) / 1000);
    return { ok: false, reason: `Patientez encore **${wait}s** avant de rouvrir une demande.` };
  }
  return { ok: true };
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
}

// ─── Panneau public ──────────────────────────────────────────────────────────
function buildPanelEmbed(cfg) {
  const s = settings(cfg);
  return new EmbedBuilder()
    .setColor(s.enabled ? COLORS.primary : COLORS.warning)
    .setTitle('🎧 Support vocal')
    .setDescription(
      'Besoin d\'une aide **en direct** ? Clique sur le bouton ci-dessous :\n'
      + 'un salon vocal privé est créé pour toi, et l\'équipe de support te rejoint.\n\n'
      + '> Un seul salon par personne, fermé automatiquement quand il se vide.',
    )
    .addFields(
      { name: '⚙️ Statut', value: s.enabled ? '🟢 Disponible' : '🔴 Indisponible', inline: true },
      { name: '👥 Support', value: cfg?.supportRoleId ? `<@&${cfg.supportRoleId}>` : '*Équipe du serveur*', inline: true },
    )
    .setFooter({ text: 'REZO • Support vocal' });
}

function buildPanelComponents(cfg) {
  if (settings(cfg).enabled === false) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('sv_open')
      .setLabel('🎧 Demander un support vocal')
      .setStyle(ButtonStyle.Primary),
  )];
}

// ─── Carte d'une demande ─────────────────────────────────────────────────────
function buildRequestEmbed(ticket, { requester, cfg } = {}) {
  const s = settings(cfg || {});
  const claimed = ticket?.claimedBy ? `<@${ticket.claimedBy}>` : '*Personne*';
  const openedAt = ticket?.createdAt ? Math.floor(new Date(ticket.createdAt).getTime() / 1000) : null;
  return new EmbedBuilder()
    .setColor(ticket?.status === 'closed' ? COLORS.error : (ticket?.claimedBy ? COLORS.success : COLORS.info))
    .setTitle(`🎧 Demande #${String(ticket?.number ?? 0).padStart(4, '0')}`)
    .addFields(
      { name: '👤 Membre', value: `<@${requester?.id || ticket?.userId}>`, inline: true },
      { name: '🎙️ Salon', value: ticket?.voiceChannelId ? `<#${ticket.voiceChannelId}>` : '*Supprimé*', inline: true },
      { name: '📌 Statut', value: STATUS_LABEL[ticket?.status] || ticket?.status || '—', inline: true },
      { name: '✋ Prise en charge', value: claimed, inline: true },
      { name: '⏱️ Ouverte', value: openedAt ? `<t:${openedAt}:R>` : '—', inline: true },
      { name: '🔊 Fermeture auto', value: s.autoCloseEmpty ? '🟢 quand le salon se vide' : '🔴 manuelle', inline: true },
    )
    .setFooter({ text: 'REZO • Support vocal' })
    .setTimestamp();
}

function buildRequestComponents(ticket) {
  if (!ticket || ticket.status === 'closed') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sv_join_${ticket._id || ticket.id}`).setLabel('🔊 Rejoindre').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sv_claim_${ticket._id || ticket.id}`).setLabel('✋ Prendre en charge').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sv_close_${ticket._id || ticket.id}`).setLabel('⛔ Fermer').setStyle(ButtonStyle.Danger),
  )];
}

function requestContent(ticket, cfg) {
  const s = settings(cfg || {});
  const mention = cfg?.supportRoleId && s.mentionStaff ? ` <@&${cfg.supportRoleId}>` : '';
  return `<@${ticket?.userId}>${mention}`;
}

// ─── Vue `/support-vocal info` ───────────────────────────────────────────────
function healthChecks(guild, cfg) {
  const problems = [];
  if (!cfg) return ['Aucune configuration : lance `/support-vocal setup`.'];
  if (!cfg.requestChannelId) problems.push('Aucun **salon des demandes** défini.');
  if (!cfg.panelChannelId) problems.push('Aucun **salon du panneau** défini (le bouton public ne peut pas être publié).');
  if (!cfg.categoryId) problems.push('Aucune **catégorie** : les salons privés seront créés à la racine du serveur.');
  if (!cfg.supportRoleId) problems.push('Aucun **rôle support** : n\'importe qui pourra prendre en charge.');
  if (!cfg.enabled) problems.push('Le système est **désactivé**.');
  if (!guild) return problems;

  for (const [key, label] of [['requestChannelId', 'salon des demandes'], ['panelChannelId', 'salon du panneau'], ['logChannelId', 'salon de logs']]) {
    const id = cfg[key];
    if (!id) continue;
    if (!guild.channels?.cache?.get?.(id)) problems.push(`Le **${label}** configuré n'existe plus.`);
  }
  const me = guild.members?.me;
  const perms = me?.permissions;
  if (perms) {
    if (!perms.has(PermissionFlagsBits.ManageChannels)) problems.push('Permission manquante : **Gérer les salons** (création des vocaux).');
    if (!perms.has(PermissionFlagsBits.MoveMembers)) problems.push('Permission manquante : **Déplacer des membres** (déplacement dans le vocal).');
  }
  return problems;
}

function buildInfoEmbed(cfg, { guild, openCount = 0, openTickets = [], totalRequests = 0 } = {}) {
  const s = settings(cfg || {});
  const configured = Boolean(cfg?.requestChannelId);
  const problems = healthChecks(guild, cfg);

  const embed = new EmbedBuilder()
    .setColor(!configured ? COLORS.warning : (problems.length ? COLORS.warning : COLORS.success))
    .setTitle('🎧 Support vocal — configuration actuelle')
    .setDescription(
      configured
        ? 'Voici l\'état du support vocal de ce serveur.'
        : '⚠️ **Le support vocal n\'est pas configuré.** Lance `/support-vocal setup` pour choisir les salons et le rôle staff.',
    )
    .addFields(
      { name: '⚙️ Statut', value: s.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '📢 Salon du panneau', value: cfg?.panelChannelId ? `<#${cfg.panelChannelId}>` : '*Non défini*', inline: true },
      { name: '📥 Salon des demandes', value: cfg?.requestChannelId ? `<#${cfg.requestChannelId}>` : '*Non défini*', inline: true },
      { name: '🗂️ Catégorie des vocaux', value: cfg?.categoryId ? `<#${cfg.categoryId}>` : '*Racine du serveur*', inline: true },
      { name: '🛡️ Rôle support', value: cfg?.supportRoleId ? `<@&${cfg.supportRoleId}>` : '*Aucun*', inline: true },
      { name: '📋 Logs', value: cfg?.logChannelId ? `<#${cfg.logChannelId}>` : '*Aucun*', inline: true },
      { name: '🏷️ Nom du salon', value: `\`${s.nameTemplate}\``, inline: true },
      { name: '👥 Limite / membre', value: `**${s.maxOpenPerUser}**`, inline: true },
      { name: '⏱️ Cooldown', value: s.cooldownSeconds ? `**${s.cooldownSeconds}s**` : '*Aucun*', inline: true },
      { name: '🔊 Fermeture auto', value: s.autoCloseEmpty ? '🟢 salon vide' : '🔴 manuelle', inline: true },
      { name: '📣 Mention staff', value: s.mentionStaff ? '🟢 oui' : '🔴 non', inline: true },
      { name: '🧾 Demandes ouvertes', value: `**${openCount}**`, inline: true },
      { name: '✅ Total historique', value: `**${totalRequests || cfg?.totalRequests || 0}**`, inline: true },
    );

  if (openTickets.length) {
    embed.addFields({
      name: '📋 Demandes en cours',
      value: openTickets.slice(0, 8).map(t => {
        const age = formatDuration(Date.now() - new Date(t.createdAt).getTime());
        return `• <@${t.userId}> — <#${t.voiceChannelId}> — ${t.claimedBy ? `pris par <@${t.claimedBy}>` : '*libre*'} — ${age}`;
      }).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  if (problems.length) {
    embed.addFields({ name: '⚠️ À corriger', value: problems.map(p => `• ${p}`).join('\n').slice(0, 1024), inline: false });
  }

  return embed.setFooter({ text: 'REZO • Support vocal' }).setTimestamp();
}

// ─── Accès base ──────────────────────────────────────────────────────────────
async function getConfig(guildId) {
  return SupportVocalConfig.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();
}

async function getOpenTickets(guildId, { userId = null } = {}) {
  const filter = { guildId, status: 'open' };
  if (userId) filter.userId = userId;
  return SupportVocal.find(filter).sort({ createdAt: -1 }).lean().exec().catch(() => []);
}

async function nextNumber(guildId) {
  const doc = await SupportVocalConfig.findOneAndUpdate(
    { guildId },
    { $inc: { ticketCounter: 1 }, $setOnInsert: { guildId } },
    { upsert: true, new: true },
  ).exec();
  return doc?.ticketCounter || 1;
}

// ─── Panneau public (publication / mise à jour) ──────────────────────────────
async function publishPanel(guild, cfg) {
  const channel = guild.channels?.cache?.get?.(cfg.panelChannelId)
    || await guild.channels?.fetch?.(cfg.panelChannelId).catch(() => null);
  if (!channel) return { ok: false, reason: 'Le salon du panneau est introuvable.' };
  if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) {
    return { ok: false, reason: 'Le salon du panneau doit être un salon texte.' };
  }

  const payload = { embeds: [buildPanelEmbed(cfg)], components: buildPanelComponents(cfg) };
  const existing = cfg.panelMessageId
    ? await channel.messages.fetch(cfg.panelMessageId).catch(() => null)
    : null;

  if (existing) {
    await existing.edit(payload).catch(() => {});
    return { ok: true, message: existing, created: false };
  }

  const sent = await channel.send(payload).catch(() => null);
  if (!sent) return { ok: false, reason: 'Impossible de publier le panneau dans ce salon.' };
  if (cfg && typeof cfg.set === 'function') {
    cfg.panelMessageId = sent.id;
    await cfg.save().catch(() => {});
  }
  return { ok: true, message: sent, created: true };
}

// ─── Ouverture d'une demande ─────────────────────────────────────────────────
/**
 * Crée le salon vocal privé + la carte de demande.
 *
 * @returns {Promise<{ok:boolean, reason?:string, ticket?:object, channel?:object}>}
 */
async function createRequest({ guild, member, user, cfg, client, now = Date.now() }) {
  const requester = user || member?.user;
  if (!guild || !requester) return { ok: false, reason: 'Contexte invalide.' };

  const config = cfg || await getConfig(guild.id);
  const open = await getOpenTickets(guild.id, { userId: requester.id });
  const last = open[0] || await SupportVocal.findOne({ guildId: guild.id, userId: requester.id })
    .sort({ createdAt: -1 }).lean().exec().catch(() => null);

  const verdict = evaluateOpening({
    cfg: config,
    openCount: open.length,
    lastOpenedAt: last ? new Date(last.createdAt).getTime() : 0,
    now,
  });
  if (!verdict.ok) return verdict;

  const requestChannel = guild.channels.cache.get(config.requestChannelId)
    || await guild.channels.fetch(config.requestChannelId).catch(() => null);
  if (!requestChannel) return { ok: false, reason: 'Le salon des demandes est introuvable (reconfigure-le via `/support-vocal setup`).' };

  const category = config.categoryId
    ? (guild.channels.cache.get(config.categoryId) || await guild.channels.fetch(config.categoryId).catch(() => null))
    : null;

  const perms = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
    {
      id: requester.id,
      allow: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak, PermissionFlagsBits.Stream,
      ],
    },
  ];
  if (config.supportRoleId) {
    perms.push({
      id: config.supportRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak, PermissionFlagsBits.Stream,
        PermissionFlagsBits.MoveMembers,
      ],
    });
  }

  const name = channelName(config.nameTemplate, {
    username: member?.displayName || requester.username,
    tag: requester.username,
    server: guild.name,
  });

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: category?.type === ChannelType.GuildCategory ? category.id : null,
    permissionOverwrites: perms,
    reason: `Support vocal — demande de ${requester.username}`,
  }).catch(err => {
    console.error('[support-vocal] création du salon:', err.message);
    return null;
  });
  if (!channel) return { ok: false, reason: 'Impossible de créer le salon vocal (permissions « Gérer les salons » ?).' };

  // Déplace le membre dans son salon s'il est déjà en vocal.
  if (member?.voice?.channelId && member.voice.channelId !== channel.id) {
    await member.voice.setChannel(channel, 'Support vocal — salon privé').catch(() => {});
  }

  const number = await nextNumber(guild.id);
  const ticket = await SupportVocal.create({
    guildId: guild.id,
    userId: requester.id,
    number,
    voiceChannelId: channel.id,
    requestChannelId: requestChannel.id,
    status: 'open',
    createdAt: new Date(now),
  });

  const card = await requestChannel.send({
    content: requestContent(ticket, config),
    embeds: [buildRequestEmbed(ticket, { requester, cfg: config })],
    components: buildRequestComponents(ticket),
    allowedMentions: { roles: config.supportRoleId ? [config.supportRoleId] : [] },
  }).catch(() => null);

  if (card) {
    ticket.requestMessageId = card.id;
    await ticket.save().catch(() => {});
  }

  await SupportVocalConfig.updateOne({ guildId: guild.id }, { $inc: { totalRequests: 1 }, $set: { updatedAt: new Date(now) } }).catch(() => {});

  // Accueil dans le salon vocal (message texte du salon, visible par le membre).
  if (config.welcomeMessage) {
    await channel.send({
      content: config.welcomeMessage
        .replace(/\{user\}/g, `<@${requester.id}>`)
        .replace(/\{guild\}/g, guild.name),
    }).catch(() => {});
  }

  await logEvent(client, guild, config, new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('🎧 Support vocal — demande ouverte')
    .addFields(
      { name: '👤 Membre', value: `<@${requester.id}> (\`${requester.id}\`)`, inline: true },
      { name: '🎙️ Salon', value: `<#${channel.id}>`, inline: true },
      { name: '🔢 Numéro', value: `#${String(number).padStart(4, '0')}`, inline: true },
    )
    .setTimestamp(new Date(now)));

  return { ok: true, ticket, channel, number };
}

// ─── Prise en charge ─────────────────────────────────────────────────────────
async function claimRequest({ ticket, user }) {
  if (!ticket) return { ok: false, reason: 'Demande introuvable.' };
  if (ticket.status === 'closed') return { ok: false, reason: 'Cette demande est déjà fermée.' };
  if (ticket.claimedBy && ticket.claimedBy !== user.id) {
    return { ok: false, reason: `Déjà prise en charge par <@${ticket.claimedBy}>.` };
  }
  ticket.claimedBy = ticket.claimedBy === user.id ? null : user.id;
  ticket.claimedAt = ticket.claimedBy ? new Date() : null;
  await ticket.save().catch(() => {});
  return { ok: true, released: !ticket.claimedBy, ticket };
}

// ─── Fermeture ───────────────────────────────────────────────────────────────
async function closeRequest({ guild, ticket, client, cfg = null, user = null, reason = null }) {
  if (!ticket) return { ok: false, reason: 'Demande introuvable.' };
  if (ticket.status === 'closed') return { ok: false, reason: 'Cette demande est déjà fermée.' };

  const config = cfg || await getConfig(ticket.guildId || guild?.id).catch(() => null);

  ticket.status = 'closed';
  ticket.closedAt = new Date();
  ticket.closedBy = user?.id || 'system';
  ticket.closeReason = reason || (user ? `Fermée par ${user.username}` : 'Fermeture automatique');
  await ticket.save().catch(() => {});

  if (guild && ticket.voiceChannelId) {
    const voice = guild.channels.cache.get(ticket.voiceChannelId)
      || await guild.channels.fetch(ticket.voiceChannelId).catch(() => null);
    if (voice) await voice.delete('Support vocal — demande fermée').catch(() => {});
  }

  await refreshCard(guild, ticket, config, { requester: user || null }).catch(() => {});

  if (guild) {
    await logEvent(client, guild, config, new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle('🎧 Support vocal — demande fermée')
      .addFields(
        { name: '👤 Membre', value: `<@${ticket.userId}>`, inline: true },
        { name: '🔢 Numéro', value: `#${String(ticket.number).padStart(4, '0')}`, inline: true },
        { name: '📝 Raison', value: ticket.closeReason || '—', inline: false },
      )
      .setTimestamp());
  }

  return { ok: true, ticket };
}

/** Réécrit la carte publique d'une demande (statut, claim, boutons). */
async function refreshCard(guild, ticket, cfg, { requester = null } = {}) {
  if (!guild || !ticket?.requestChannelId || !ticket?.requestMessageId) return false;
  const channel = guild.channels.cache.get(ticket.requestChannelId)
    || await guild.channels.fetch(ticket.requestChannelId).catch(() => null);
  if (!channel) return false;
  const message = await channel.messages.fetch(ticket.requestMessageId).catch(() => null);
  if (!message) return false;
  const embed = buildRequestEmbed(ticket, { requester, cfg });
  if (ticket.status === 'closed') {
    embed.setDescription('Cette demande est fermée. Un nouveau besoin ? Utilise le panneau.');
  }
  await message.edit({ embeds: [embed], components: buildRequestComponents(ticket) }).catch(() => {});
  return true;
}

async function logEvent(client, guild, cfg, embed) {
  try {
    const channel = cfg?.logChannelId && guild?.channels?.cache?.get?.(cfg.logChannelId);
    if (channel?.isTextBased?.()) {
      await channel.send({ embeds: [embed] }).catch(() => {});
      return true;
    }
    const { sendModLog } = require('../commands/moderation/modlog');
    await sendModLog(client, guild.id, embed).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ─── Boutons publics (sv_open / sv_join_* / sv_claim_* / sv_close_*) ─────────
async function handleTicketButton(interaction, client) {
  const id = interaction.customId;
  if (!interaction.inGuild?.() && !interaction.guild) return;

  const guild = interaction.guild;
  const cfg = await getConfig(guild.id);

  if (id === 'sv_open') {
    await interaction.deferReply({ ephemeral: true });
    const member = interaction.member;
    const result = await createRequest({ guild, member, user: interaction.user, cfg, client });
    if (!result.ok) {
      return interaction.editReply({ content: `❌ ${result.reason}` }).catch(() => {});
    }
    return interaction.editReply({
      content: `✅ Ta demande est ouverte : <#${result.channel.id}>. Un membre du support va te rejoindre.`,
    }).catch(() => {});
  }

  const match = id.match(/^sv_(join|claim|close)_(.+)$/);
  if (!match) return;
  const [, action, ticketId] = match;

  const ticket = await SupportVocal.findById(ticketId).exec().catch(() => null);
  if (!ticket) {
    return interaction.reply({ content: '❌ Demande introuvable.', ephemeral: true }).catch(() => {});
  }
  if (ticket.status === 'closed' && action !== 'close') {
    return interaction.reply({ content: '❌ Cette demande est déjà fermée.', ephemeral: true }).catch(() => {});
  }

  const isStaff = Boolean(
    interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
    || interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)
    || (cfg.supportRoleId && interaction.member?.roles?.cache?.has?.(cfg.supportRoleId)),
  );

  if (action === 'claim') {
    if (!isStaff) return interaction.reply({ content: '❌ Réservé au staff support.', ephemeral: true }).catch(() => {});
    const result = await claimRequest({ ticket, user: interaction.user });
    if (!result.ok) return interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true }).catch(() => {});
    await refreshCard(guild, ticket, cfg);
    return interaction.reply({
      content: result.released
        ? '↩️ Prise en charge libérée.'
        : `✋ <@${interaction.user.id}> prend en charge cette demande.`,
    }).catch(() => {});
  }

  if (action === 'join') {
    if (!isStaff) return interaction.reply({ content: '❌ Réservé au staff support.', ephemeral: true }).catch(() => {});
    const voice = guild.channels.cache.get(ticket.voiceChannelId);
    if (!voice) return interaction.reply({ content: '❌ Le salon vocal a été supprimé.', ephemeral: true }).catch(() => {});
    if (interaction.member?.voice?.setChannel) {
      await interaction.member.voice.setChannel(voice, 'Support vocal — staff').catch(() => {});
    }
    return interaction.reply({ content: `🔊 Rejoint <#${voice.id}>.`, ephemeral: true }).catch(() => {});
  }

  if (action === 'close') {
    const isOwner = interaction.user.id === ticket.userId;
    if (!isStaff && !isOwner) {
      return interaction.reply({ content: '❌ Seul le membre concerné ou le staff peut fermer la demande.', ephemeral: true }).catch(() => {});
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await closeRequest({ guild, ticket, client, cfg, user: interaction.user, reason: 'Fermée depuis la carte' });
    if (!result.ok) return interaction.editReply({ content: `❌ ${result.reason}` }).catch(() => {});
    return interaction.editReply({ content: '⛔ Demande fermée et salon supprimé.' }).catch(() => {});
  }
}

// ─── Fermeture automatique quand le salon vocal se vide ──────────────────────
async function handleVoiceUpdate(oldState, newState, client) {
  try {
    const channelId = oldState?.channelId;
    if (!channelId || !oldState?.guild) return;
    // Mute/sourdine ou changement d'état sans quitter le salon : rien à faire.
    if (newState?.channelId === channelId) return;

    // Pré-filtre GRATUIT : si le salon n'est pas vide après ce départ, aucune
    // demande ne peut se fermer. Sans lui, chaque déplacement vocal du serveur
    // (très fréquent sur une grosse communauté) coûterait une requête MongoDB.
    const liveChannel = oldState.channel;
    if (liveChannel?.members?.filter) {
      const remaining = liveChannel.members.filter(m => m.id !== (oldState.member?.id || oldState.id));
      if (remaining.size > 0) return;
    }

    const guild = oldState.guild;

    const ticket = await SupportVocal.findOne({
      guildId: guild.id, voiceChannelId: channelId, status: 'open',
    }).exec().catch(() => null);
    if (!ticket) return;

    const cfg = await getConfig(guild.id).catch(() => null);
    if (cfg && cfg.autoCloseEmpty === false) return;

    const channel = guild.channels.cache.get(channelId)
      || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      await closeRequest({ guild, ticket, client, cfg, reason: 'Salon supprimé' });
      return;
    }
    const humans = channel.members?.filter?.(m => !m.user?.bot)?.size ?? 0;
    if (humans > 0) return;
    await closeRequest({ guild, ticket, client, cfg, reason: 'Salon vide' });
  } catch (err) {
    console.error('[support-vocal] voiceStateUpdate:', err.message);
  }
}

// ─── Configuration : formulaire du panneau ──────────────────────────────────
module.exports = {
  DEFAULTS,
  settings,
  channelName,
  evaluateOpening,
  formatDuration,
  buildPanelEmbed,
  buildPanelComponents,
  buildRequestEmbed,
  buildRequestComponents,
  buildInfoEmbed,
  healthChecks,
  requestContent,
  getConfig,
  getOpenTickets,
  nextNumber,
  publishPanel,
  createRequest,
  claimRequest,
  closeRequest,
  refreshCard,
  handleTicketButton,
  handleVoiceUpdate,
  __testables: { SupportVocal, SupportVocalConfig, STATUS_LABEL },
};
