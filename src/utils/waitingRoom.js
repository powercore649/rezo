'use strict';
// utils/waitingRoom.js — Salon vocal d'attente (file d'attente vocale).
//
// Principe : un salon vocal est déclaré « salle d'attente ». Le membre qui le
// rejoint entre dans une file persistée ; un salon texte publie la file, le
// staff est notifié, et n'importe qui peut appeler le suivant depuis le message
// public. Le staff peut aussi déplacer automatiquement la personne appelée vers
// un salon de destination (accueil / support).
//
// Ce module contient :
//   • des helpers purs (testables hors-ligne, voir tests/waitingroom-smoke.js) :
//     isInQueue, queuePosition, formatDuration, uncalledEntry, buildQueueEmbed,
//     buildQueueComponents, buildNotificationContent ;
//   • les effets Discord : addToQueue, removeFromQueue, refreshQueueMessage,
//     notifyArrival, callNext, handleVoiceUpdate, reconcile.
//
// Aucune connexion vocale n'est nécessaire : le bot ne fait que lire l'état
// vocal (intent GuildVoiceStates) et déplacer des membres.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const WaitingRoom = require('../models/WaitingRoom');
const { COLORS } = require('./embeds');

const MAX_QUEUE_STORED = 250; // garde-fou : évite une file pathologique en base

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
async function getConfig(guildId) {
  let cfg = await WaitingRoom.findOne({ guildId });
  if (!cfg) cfg = await WaitingRoom.create({ guildId });
  return cfg;
}

function isConfigured(cfg) {
  return Boolean(cfg && cfg.enabled && cfg.voiceChannelId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS PURS
// ═══════════════════════════════════════════════════════════════════════════════
function queueOf(cfg) {
  return Array.isArray(cfg?.queue) ? cfg.queue : [];
}

function isInQueue(cfg, userId) {
  return queueOf(cfg).some(e => e.userId === userId);
}

// Position 1-based, ou null si absent de la file.
function queuePosition(cfg, userId) {
  const i = queueOf(cfg).findIndex(e => e.userId === userId);
  return i === -1 ? null : i + 1;
}

// Première personne non encore appelée (celle à qui c'est le tour).
function nextEntry(cfg, { uncalledOnly = true } = {}) {
  const q = queueOf(cfg);
  return (uncalledOnly ? q.find(e => !e.calledAt) : q[0]) || null;
}

// Entrée de file à qui appartient un salon vocal donné (salon temporaire).
function entryOf(cfg, userId) {
  return queueOf(cfg).find(e => e.userId === userId) || null;
}

function entryByTempChannel(cfg, channelId) {
  if (!channelId) return null;
  return queueOf(cfg).find(e => e.tempChannelId && e.tempChannelId === channelId) || null;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

// Nom du salon temporaire d'un membre ({user} → pseudo).
function buildTempChannelName(cfg, member) {
  const tpl = cfg?.tempChannelName || '⏳・{user}';
  const user = member?.user?.username || member?.id || 'membre';
  return tpl.replace(/\{user\}/g, user).replace(/\{position\}/g, String(queuePosition(cfg, member?.id) ?? '?')).slice(0, 100);
}

function buildNotificationContent(cfg, member) {
  const mention = cfg.staffRoleId ? `<@&${cfg.staffRoleId}> ` : '';
  const template = cfg.notifyMessage || '🎧 {user} vient d\'entrer en attente (position **{position}**).';
  const text = template
    .replace(/\{user\}/g, `<@${member.id}>`)
    .replace(/\{position\}/g, String(queuePosition(cfg, member.id) ?? '?'));
  return `${mention}${text}`.trim();
}

function buildQueueEmbed(cfg, guild) {
  const queue = queueOf(cfg);
  const capacity = cfg.maxQueue > 0 ? ` / ${cfg.maxQueue}` : '';
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🎧 Salon d\'attente — File en cours')
    .setTimestamp();

  if (!queue.length) {
    embed.setDescription('*Personne n\'attend pour le moment.*\nRejoignez le salon vocal d\'attente pour passer en file.');
  } else {
    const lines = queue.slice(0, 20).map((e, i) => {
      const wait = formatDuration(Date.now() - new Date(e.joinedAt).getTime());
      const called = e.calledAt ? ' — 🔔 **appelé**' : '';
      return `**${i + 1}.** <@${e.userId}> — ${wait}${called}`;
    });
    if (queue.length > 20) lines.push(`*… et ${queue.length - 20} autre(s).*`);
    embed.setDescription(lines.join('\n'));
  }

  embed.addFields(
    { name: '👥 En attente', value: `**${queue.length}**${capacity}`, inline: true },
    { name: '✅ Pris en charge', value: `**${cfg.totalServed || 0}**`, inline: true },
    { name: '🎙️ Salon vocal', value: cfg.voiceChannelId ? `<#${cfg.voiceChannelId}>` : '*Non défini*', inline: true },
  );
  if (cfg.targetChannelId) embed.addFields({ name: '➡️ Destination', value: `<#${cfg.targetChannelId}>`, inline: true });
  embed.setFooter({ text: 'REZO • Salon d\'attente' });
  return embed;
}

function buildQueueComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('waitingroom_next').setLabel('Appeler le suivant').setEmoji('🔔').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('waitingroom_refresh').setLabel('Rafraîchir').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCÈS DISQUE / DISCORD
// ═══════════════════════════════════════════════════════════════════════════════
async function addToQueue(cfg, userId) {
  if (isInQueue(cfg, userId)) return false;
  cfg.queue.push({ userId, joinedAt: new Date() });
  if (cfg.queue.length > MAX_QUEUE_STORED) cfg.queue = cfg.queue.slice(-MAX_QUEUE_STORED);
  await cfg.save();
  return true;
}

async function removeFromQueue(cfg, userId, { served = false } = {}) {
  const before = cfg.queue.length;
  cfg.queue = cfg.queue.filter(e => e.userId !== userId);
  if (cfg.queue.length === before) return false;
  if (served) {
    cfg.totalServed = (cfg.totalServed || 0) + 1;
    cfg.lastServedAt = new Date();
  }
  await cfg.save();
  return true;
}

// ── Salon vocal temporaire par membre ───────────────────────────────────────
// Crée le salon d'attente individuel (dans la catégorie configurée, ou celle du
// salon d'attente) et accorde l'accès au membre + au rôle staff.
async function createTempChannel(guild, cfg, member) {
  if (!cfg.createTempChannel) return null;
  const waitChannel = guild.channels.cache.get(cfg.voiceChannelId);
  const parent = cfg.tempCategoryId || waitChannel?.parentId || null;
  try {
    const channel = await guild.channels.create({
      name: buildTempChannelName(cfg, member),
      type: ChannelType.GuildVoice,
      parent: parent || undefined,
      userLimit: 2, // le membre + un membre du staff
      reason: 'Salon d\'attente — salon temporaire',
      permissionOverwrites: [
        { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
        ...(cfg.staffRoleId ? [{ id: cfg.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] }] : []),
      ],
    });
    return channel;
  } catch (err) {
    console.error('[waitingroom] createTempChannel:', err.message);
    return null;
  }
}

// Supprime un salon temporaire (silencieux : il a pu être supprimé à la main).
async function deleteChannelById(guild, channelId) {
  if (!channelId) return false;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;
  try {
    await channel.delete('Salon d\'attente — nettoyage du salon temporaire');
    return true;
  } catch (err) {
    console.error('[waitingroom] deleteTempChannel:', err.message);
    return false;
  }
}

// Mute + sourdine serveur pendant l'attente (le membre ne peut ni parler, ni s'unmute).
async function setWaitingRestrictions(member, on) {
  if (!member?.voice) return;
  const reason = on ? 'Salon d\'attente — mise en attente' : 'Salon d\'attente — appelé';
  await member.voice.setMute(on, reason).catch(() => {});
  await member.voice.setDeaf(on, reason).catch(() => {});
}

// Déplace l'entrant dans son salon temporaire et l'y mute. `entry` est l'entrée
// de file (créée juste avant) : son tempChannelId est persisté.
async function onboardToTemp(guild, cfg, member, entry) {
  if (!cfg.createTempChannel) return null;
  const channel = await createTempChannel(guild, cfg, member);
  if (!channel) return null;

  entry.tempChannelId = channel.id;
  if (!Array.isArray(cfg.tempChannelIds)) cfg.tempChannelIds = [];
  if (!cfg.tempChannelIds.includes(channel.id)) cfg.tempChannelIds.push(channel.id);
  await cfg.save();

  await member.voice?.setChannel(channel.id, 'Salon d\'attente — place en attente').catch(() => {});
  if (cfg.muteWaiting) await setWaitingRestrictions(member, true);
  return channel;
}

// Sortie de la file : suppression du salon temporaire, libération des
// restrictions, retrait du rôle et de l'entrée de file.
async function finalizeDeparture(guild, cfg, member, entry, { served = true } = {}) {
  const tempId = entry?.tempChannelId || null;
  if (tempId) {
    await deleteChannelById(guild, tempId);
    entry.tempChannelId = null;
    if (Array.isArray(cfg.tempChannelIds)) {
      cfg.tempChannelIds = cfg.tempChannelIds.filter(id => id !== tempId);
    }
  }
  if (member) {
    await setWaitingRestrictions(member, false);
    await takeWaitingRole(member, cfg);
  }
  const removed = await removeFromQueue(cfg, member?.id ?? entry?.userId, { served });
  if (removed) await refreshQueueMessage(guild, cfg);
  return removed;
}

function resolveLogChannel(guild, cfg) {
  if (!cfg.logChannelId) return null;
  return guild.channels.cache.get(cfg.logChannelId) || null;
}

// Publie (ou met à jour) le message public de file d'attente dans le salon logs.
async function refreshQueueMessage(guild, cfg) {
  const channel = resolveLogChannel(guild, cfg);
  if (!channel || !channel.isTextBased?.()) return null;

  const payload = { embeds: [buildQueueEmbed(cfg, guild)], components: buildQueueComponents() };

  if (cfg.queueMessageId) {
    try {
      const msg = await channel.messages.fetch(cfg.queueMessageId);
      await msg.edit(payload);
      return msg;
    } catch {
      cfg.queueMessageId = null; // message supprimé → on en repostera un
    }
  }

  try {
    const msg = await channel.send(payload);
    cfg.queueMessageId = msg.id;
    await cfg.save();
    return msg;
  } catch (err) {
    console.error('[waitingroom] refreshQueueMessage:', err.message);
    return null;
  }
}

async function notifyArrival(guild, cfg, member) {
  if (!cfg.notifyStaff) return;
  const channel = resolveLogChannel(guild, cfg);
  if (!channel || !channel.isTextBased?.()) return;
  try {
    await channel.send({
      content: buildNotificationContent(cfg, member),
      allowedMentions: { roles: cfg.staffRoleId ? [cfg.staffRoleId] : [], users: [member.id] },
    });
  } catch (err) {
    console.error('[waitingroom] notifyArrival:', err.message);
  }
}

async function giveWaitingRole(member, cfg) {
  if (!cfg.giveRole || !cfg.waitingRoleId) return;
  const role = member.guild.roles.cache.get(cfg.waitingRoleId);
  if (!role) return;
  await member.roles.add(role, 'Salon d\'attente').catch(() => {});
}

async function takeWaitingRole(member, cfg) {
  if (!cfg.waitingRoleId) return;
  const role = member.guild.roles.cache.get(cfg.waitingRoleId);
  if (!role || !member.roles.cache.has(role.id)) return;
  await member.roles.remove(role, 'Sortie du salon d\'attente').catch(() => {});
}

// Appelle la personne dont c'est le tour : mention dans le salon logs, rôle
// conservé, et déplacement automatique vers le salon de destination s'il est
// configuré. `auto` = déclenché par la libération d'une place.
async function callNext(guild, cfg, { byUser = null, auto = false } = {}) {
  const entry = nextEntry(cfg, { uncalledOnly: true });
  if (!entry) return { ok: false, reason: 'empty' };

  entry.calledAt = new Date();
  await cfg.save();

  const channel = resolveLogChannel(guild, cfg);
  if (channel?.isTextBased?.()) {
    const embed = new EmbedBuilder()
      .setColor(auto ? COLORS.success : COLORS.accent)
      .setTitle(auto ? '🔔 Appel automatique' : '🔔 Appel du suivant')
      .setDescription(`<@${entry.userId}>, c'est ton tour dans le salon d'attente 🎧\nRends-toi disponible, le staff arrive.`)
      .setTimestamp();
    if (byUser) embed.setFooter({ text: `Appelé par ${byUser.tag || byUser.username || byUser.id}` });
    await channel.send({
      content: `<@${entry.userId}>`,
      embeds: [embed],
      allowedMentions: { users: [entry.userId] },
    }).catch(() => {});
  }

  // C'est son tour : on libère le micro/sourdine (il peut parler), et on le
  // déplace vers le salon de destination s'il est configuré.
  const member = await guild.members.fetch(entry.userId).catch(() => null);
  if (member) {
    await setWaitingRestrictions(member, false);
    if (cfg.targetChannelId) {
      const here = member.voice?.channelId;
      const isInWaitOrTemp = here === cfg.voiceChannelId || (entry.tempChannelId && here === entry.tempChannelId);
      if (isInWaitOrTemp) {
        await member.voice.setChannel(cfg.targetChannelId, 'Appelé depuis le salon d\'attente').catch(() => {});
      }
    }
  }

  // Le déplacement déclenche voiceStateUpdate : finalizeDeparture y supprime le
  // salon temporaire et sort le membre de la file.
  await refreshQueueMessage(guild, cfg);
  return { ok: true, userId: entry.userId, position: queuePosition(cfg, entry.userId) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ÉVÉNEMENT VOCAL
// ═══════════════════════════════════════════════════════════════════════════════
async function handleVoiceUpdate(oldState, newState, client) {
  const member = newState.member || oldState.member;
  if (!member || member.user?.bot) return;

  const guild = newState.guild || oldState.guild;
  if (!guild || guild.id !== member.guild?.id) return;

  const oldId = oldState.channelId;
  const newId = newState.channelId;
  if (oldId === newId) return; // ex. changement de mute : pas de changement de salon

  const cfg = await WaitingRoom.findOne({ guildId: guild.id }).catch(() => null);
  if (!isConfigured(cfg)) return;

  const inWaitOld = oldId === cfg.voiceChannelId;
  const inWaitNew = newId === cfg.voiceChannelId;
  const tempOld = entryByTempChannel(cfg, oldId);
  const tempNew = entryByTempChannel(cfg, newId);

  // ── A. Arrivée dans le salon vocal d'attente ─────────────────────────
  if (inWaitNew) {
    if (isInQueue(cfg, member.id)) {
      // Déjà en file (ex. recréation du salon temporaire) : on s'assure qu'il en a un.
      const entry = entryOf(cfg, member.id);
      if (cfg.createTempChannel && entry && !entry.tempChannelId) {
        await onboardToTemp(guild, cfg, member, entry);
      }
      return;
    }

    const added = await addToQueue(cfg, member.id);
    if (!added) return;

    const entry = entryOf(cfg, member.id);
    if (entry) await onboardToTemp(guild, cfg, member, entry);
    await giveWaitingRole(member, cfg);
    await notifyArrival(guild, cfg, member);
    await refreshQueueMessage(guild, cfg);

    if (cfg.maxQueue > 0 && cfg.queue.length > cfg.maxQueue) {
      const channel = resolveLogChannel(guild, cfg);
      channel?.send?.({ content: `⚠️ La file d'attente dépasse la capacité annoncée (**${cfg.queue.length}/${cfg.maxQueue}**).` }).catch(() => {});
    }
    return;
  }

  // ── B. Le membre quitte son salon temporaire ─────────────────────────
  // (déconnexion, déplacement par le staff, ou appel vers la destination).
  if (tempOld && !tempNew) {
    await finalizeDeparture(guild, cfg, member, tempOld, { served: true });
    if (cfg.autoCallNext && nextEntry(cfg, { uncalledOnly: true })) {
      await callNext(guild, cfg, { auto: true }).catch(() => {});
    }
    return;
  }

  // ── C. Sortie directe du salon d'attente (sans salon temporaire) ─────
  if (inWaitOld && !inWaitNew && !tempNew) {
    const removed = await removeFromQueue(cfg, member.id, { served: true });
    await setWaitingRestrictions(member, false);
    await takeWaitingRole(member, cfg);
    if (removed) await refreshQueueMessage(guild, cfg);

    if (cfg.autoCallNext && nextEntry(cfg, { uncalledOnly: true })) {
      await callNext(guild, cfg, { auto: true }).catch(() => {});
    }
    return;
  }

  // ── D. Déplacement interne salon d'attente → salon temporaire : ignoré ─
}

// ═══════════════════════════════════════════════════════════════════════════════
// RÉCONCILIATION AU DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════
// Un redémarrage peut avoir eu lieu pendant que des membres entraient/sortaient :
// on recale la file et les rôles sur la réalité des salons vocaux.
async function reconcile(client) {
  let touched = 0;
  const configs = await WaitingRoom.find({ enabled: true, voiceChannelId: { $ne: null } }).catch(() => []);

  for (const cfg of configs) {
    try {
      const guild = client.guilds.cache.get(cfg.guildId);
      if (!guild) continue;
      const waitChannel = guild.channels.cache.get(cfg.voiceChannelId);
      if (!waitChannel) continue;

      // Présents = dans le salon d'attente OU dans leur salon temporaire.
      const present = new Set();
      for (const m of waitChannel.members.values()) if (!m.user.bot) present.add(m.id);

      const aliveTempIds = new Set();
      for (const entry of cfg.queue) {
        if (!entry.tempChannelId) continue;
        const ch = guild.channels.cache.get(entry.tempChannelId);
        if (ch && ch.members?.has?.(entry.userId)) {
          aliveTempIds.add(entry.tempChannelId);
          present.add(entry.userId);
        } else {
          entry.tempChannelId = null; // salon disparu, ou membre plus dedans
        }
      }

      // Salons temporaires suivis mais devenus orphelins → suppression.
      for (const id of (Array.isArray(cfg.tempChannelIds) ? cfg.tempChannelIds : [])) {
        if (!aliveTempIds.has(id)) await deleteChannelById(guild, id);
      }
      cfg.tempChannelIds = [...aliveTempIds];

      const kept = cfg.queue.filter(e => present.has(e.userId));
      const leftEntries = cfg.queue.filter(e => !present.has(e.userId));

      // Nouveaux présents (arrivés pendant l'arrêt) → onboarding complet.
      for (const id of present) {
        if (kept.some(e => e.userId === id)) continue;
        const entry = { userId: id, joinedAt: new Date(), calledAt: null, tempChannelId: null };
        kept.push(entry);
        const member = await guild.members.fetch(id).catch(() => null);
        if (member) await onboardToTemp(guild, cfg, member, entry);
      }

      const leftIds = leftEntries.map(e => e.userId);
      const changed = kept.length !== cfg.queue.length || leftIds.length > 0;
      cfg.queue = kept;
      await cfg.save();

      for (const e of leftEntries) {
        if (e.tempChannelId) await deleteChannelById(guild, e.tempChannelId);
      }
      for (const id of leftIds) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (member) { await setWaitingRestrictions(member, false); await takeWaitingRole(member, cfg); }
      }
      for (const id of present) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (member) await giveWaitingRole(member, cfg);
      }

      if (changed) { await refreshQueueMessage(guild, cfg); touched++; }
    } catch (err) {
      console.error(`[waitingroom] reconcile ${cfg.guildId}:`, err.message);
    }
  }
  return touched;
}

module.exports = {
  // config
  getConfig,
  isConfigured,
  // helpers purs
  queueOf,
  isInQueue,
  queuePosition,
  nextEntry,
  entryOf,
  entryByTempChannel,
  formatDuration,
  buildTempChannelName,
  buildNotificationContent,
  buildQueueEmbed,
  buildQueueComponents,
  // effets
  addToQueue,
  removeFromQueue,
  createTempChannel,
  deleteChannelById,
  setWaitingRestrictions,
  onboardToTemp,
  finalizeDeparture,
  refreshQueueMessage,
  notifyArrival,
  giveWaitingRole,
  takeWaitingRole,
  callNext,
  handleVoiceUpdate,
  reconcile,
};
