'use strict';
// utils/antiraidActions.js — Orchestration Discord du système anti-raid.
// Utilisé à la fois par l'event guildMemberAdd (src/events/membres/antiraid.js)
// et par le panneau /antiraid (src/commands/moderation/antiraid.js).
// Toute la logique de décision pure vit dans utils/antiraidEngine.js.

const { EmbedBuilder } = require('discord.js');
const { AntiRaid, AntiRaidHoneypot: Honeypot } = require('../models/AntiRaid');
const { CaptchaConfig } = require('../models/Captcha');
const {
  detectRaid, assessJoin, recordWaveJoin, isWaveRaid, decideResponse,
  quarantineRoles, checkBlacklisted,
} = require('./antiraidEngine');
const { COLORS } = require('./embeds');

const HONEYPOT_MSG = '🚪 Accès direct autorisé — connectez-vous ici !';

// ─── Logs ─────────────────────────────────────────────────────────────────────
async function logAction(client, cfg, embed) {
  if (!cfg?.logChannelId || !client) return;
  try {
    const guild = client.guilds.cache.get(embed.__guildId);
    const channel = guild?.channels.cache.get(cfg.logChannelId);
    if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (_) { /* jamais bloquant */ }
}

function logEmbed(guildId, { color = COLORS.info, title, description }) {
  const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
  if (description) e.setDescription(description);
  e.__guildId = guildId;
  return e;
}

async function getConfig(guildId) {
  let cfg = await AntiRaid.findOne({ guildId });
  if (!cfg) cfg = await AntiRaid.create({ guildId });
  return cfg;
}

// ─── Verrouillage d'urgence (tous les salons) ────────────────────────────────
async function lockAll(guild, enable) {
  let count = 0;
  for (const [, ch] of guild.channels.cache) {
    if (ch.isTextBased() && !ch.isThread()) {
      try {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: enable ? false : null });
        count++;
      } catch (_) {}
    }
  }
  return count;
}

// ─── Rôle de quarantaine (créé à la volée, sous le bot) ──────────────────────
async function ensureQuarantineRole(guild, cfg) {
  if (cfg.quarantineRoleId) {
    const existing = guild.roles.cache.get(cfg.quarantineRoleId);
    if (existing) return existing;
  }
  const me = guild.members.me;
  const role = await guild.roles.create({
    name: '🛡️ En quarantaine',
    color: 0xED4245,
    reason: 'Anti-raid REZO — rôle de quarantaine',
    permissions: [],
  }).catch(() => null);
  if (role) {
    cfg.quarantineRoleId = role.id;
    await cfg.save().catch(() => {});
  }
  return role;
}

// ─── Mise en quarantaine d'un membre ─────────────────────────────────────────
async function quarantineMember(member, cfg) {
  const roleIds = [...member.roles.cache.keys()].filter(id => id !== member.guild.id);
  const { toRemove } = quarantineRoles(roleIds, cfg);
  const removed = [];
  for (const id of toRemove) {
    if (member.roles.cache.get(id)?.managed) continue; // rôles bots/intégrations : non retirable
    await member.roles.remove(id, 'Anti-raid : quarantaine').catch(() => {});
    removed.push(id);
  }
  const qRole = await ensureQuarantineRole(member.guild, cfg);
  if (qRole) await member.roles.add(qRole, 'Anti-raid : quarantaine').catch(() => {});

  const existing = (cfg.quarantined || []).find(q => q.userId === member.id);
  if (existing) {
    existing.roles = removed;
    existing.at = new Date();
  } else {
    cfg.quarantined.push({ userId: member.id, roles: removed, at: new Date() });
  }
  await cfg.save().catch(() => {});
  return removed;
}

// ─── Fin de quarantaine (manuel ou à la fin du raid) ─────────────────────────
async function releaseQuarantine(client, guild, cfg, userId = null) {
  const entries = userId
    ? (cfg.quarantined || []).filter(q => q.userId === userId)
    : [...(cfg.quarantined || [])];
  if (!entries.length) return 0;

  for (const entry of entries) {
    const member = await guild.members.fetch(entry.userId).catch(() => null);
    if (!member) continue;
    if (cfg.quarantineRoleId) await member.roles.remove(cfg.quarantineRoleId, 'Anti-raid : fin de quarantaine').catch(() => {});
    for (const roleId of entry.roles || []) {
      await member.roles.add(roleId, 'Anti-raid : restauration des rôles').catch(() => {});
    }
  }
  cfg.quarantined = userId
    ? (cfg.quarantined || []).filter(q => q.userId !== userId)
    : [];
  await cfg.save().catch(() => {});
  return entries.length;
}

// ─── Honeypots ────────────────────────────────────────────────────────────────
async function sendHoneypotMessage(client, hp) {
  try {
    const guild = client.guilds.cache.get(hp.guildId);
    if (!guild) return;
    const channel = guild.channels.cache.get(hp.channelId);
    if (!channel?.isTextBased()) return;
    if (hp.messageId) {
      const old = await channel.messages.fetch(hp.messageId).catch(() => null);
      if (old) return; // déjà affiché
    }
    const msg = await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('✅ Accès vérifié')
        .setDescription(HONEYPOT_MSG)
        .setTimestamp()],
    }).catch(() => null);
    if (msg) {
      hp.messageId = msg.id;
      await hp.save().catch(() => {});
    }
  } catch (_) {}
}

async function triggerHoneypot(client, guild, hp, userId) {
  const cfg = await getConfig(guild.id);
  hp.strikes += 1;
  await hp.save().catch(() => {});

  await logAction(client, cfg, logEmbed(guild.id, {
    color: COLORS.error,
    title: '🍯 Honeypot déclenché',
    description: `<@${userId}> a écrit dans le salon-piège <#${hp.channelId}>.\nLe compte est un bot/raid **confirmé** — ban appliqué.`,
  }));

  await guild.members.ban(userId, { reason: 'Anti-raid : honeypot déclenché (bot confirmé)' }).catch(() => {});
  await AntiRaid.updateOne({ guildId: guild.id }, { $inc: { raidCount: 1 } });
}

// ─── Escalade DISCON (le rideau) ─────────────────────────────────────────────
// Un raid doit faire basculer le serveur en mode fermé même si l'admin n'a
// jamais ouvert `/discon`. On retient le cran d'avant le raid pour le rendre
// exactement à la fin : jamais au-dessus d'un cran choisi à la main.
async function raiseDiscon(guild, cfg, actions) {
  const engine = require('./disconEngine');
  const target = engine.clampLevel(cfg.raidResponseLevel ?? 5);
  if (target <= 0) return;

  const state = await engine.getState(guild.id);
  if (!cfg.disconRaised) {
    cfg.disconBeforeRaid = state.level;
    cfg.disconRaised = true;
    await cfg.save().catch(() => {});
  }

  const level = Math.max(target, state.level);
  // Le salon de logs anti-raid reste ouvert : c'est là que le staff suit la riposte.
  const res = await engine.applyLevel(guild, level, {
    byId: null,
    doc: state,
    preserve: [cfg.logChannelId].filter(Boolean),
  });
  actions.push(`DISCON porté au cran ${res.level} (${engine.levelDef(res.level).label})`);
  if (res.skipped.length) {
    actions.push(`DISCON partiel : ${res.skipped.map(s => s.reason).join(', ')}`);
  }
}

async function restoreDiscon(guild, cfg, actions) {
  if (!cfg.disconRaised) return;
  const engine = require('./disconEngine');
  const back = Number.isFinite(cfg.disconBeforeRaid) ? cfg.disconBeforeRaid : 0;
  const res = await engine.applyLevel(guild, back, { byId: null });
  cfg.disconRaised = false;
  cfg.disconBeforeRaid = null;
  actions.push(`DISCON revenu au cran ${res.level} (${engine.levelDef(res.level).label})`);
}

// ─── Réponse automatique quand un raid est confirmé ──────────────────────────
async function applyRaidResponse(client, guild, cfg, summary) {
  const resp = decideResponse(cfg);
  const actions = [];

  cfg.raidActive = true;
  cfg.raidDetectedAt = new Date();
  cfg.raidCount += 1;
  cfg.lastRaidInfo = summary;
  await cfg.save().catch(() => {});

  // 1) Activer le captcha (si configuré et demandé)
  if (resp.verification && cfg.mode !== 'monitor') {
    try {
      const capCfg = await CaptchaConfig.findOne({ guildId: guild.id });
      if (capCfg?.channelId && capCfg.activeOnRaid && !capCfg.enabled) {
        capCfg.enabled = true;
        capCfg.raidAutoActive = true;
        await capCfg.save();
        actions.push('captcha activé automatiquement');
      } else if (capCfg?.channelId && capCfg.enabled) {
        actions.push('captcha déjà actif');
      } else {
        actions.push('captcha non configuré (non activé)');
      }
    } catch (_) {}
  }

  // 2) Suspendre les invitations : les liens déjà envoyés cessent de fonctionner,
  //    ce qui coupe l'arrivée de renforts même sans verrouiller les salons.
  if (resp.blockInvites && cfg.mode !== 'monitor') {
    let blocked = false;
    if (typeof guild.setInvitesDisabled === 'function') {
      blocked = await guild.setInvitesDisabled(true).then(() => true).catch(() => false);
    }
    if (blocked) {
      cfg.invitesBlocked = true;
      await cfg.save().catch(() => {});
      actions.push('invitations suspendues');
    } else {
      actions.push('invitations non suspendues (permission « Gérer le serveur » manquante ?)');
    }
  }

  // 3) Verrouiller le serveur
  if (resp.lockdown) {
    const locked = await lockAll(guild, true);
    cfg.lockdownActive = true;
    await cfg.save().catch(() => {});
    actions.push(`serveur verrouillé (${locked} salons)`);
  }

  // 4) DISCON — le serveur passe au cran d'urgence tout seul : captcha, mode
  //    lent, lecture seule, invitations suspendues et, au dernier cran, rideau
  //    sur les salons. C'est la riposte forte, sans attendre un admin.
  try {
    await raiseDiscon(guild, cfg, actions);
  } catch (err) {
    actions.push(`DISCON non appliqué (${err.message})`);
  }

  // 5) Quarantaine des membres récemment arrivés suspects
  if (cfg.quarantineOnJoin) {
    let q = 0;
    for (const j of cfg.joins || []) {
      const member = await guild.members.fetch(j.userId).catch(() => null);
      if (member && !member.user.bot) {
        await quarantineMember(member, cfg);
        q++;
      }
    }
    if (q) actions.push(`${q} membre(s) mis en quarantaine`);
  }

  await logAction(client, cfg, logEmbed(guild.id, {
    color: COLORS.error,
    title: '🚨 RAID DÉTECTÉ — réponse automatique appliquée',
    description: `${summary}\n\n**Actions :** ${actions.length ? actions.map(a => `• ${a}`).join('\n') : '• aucune (mode monitor)'}\n\nGérez la situation depuis \`/antiraid\` (statut → fin de raid).`,
  }));

  // ── Centre de notifications — abonnés « Raids & sécurité » ────────────
  // Alerte immédiate en MP/mention : un admin qui n'est pas devant le salon de
  // logs doit pouvoir réagir à un raid en cours.
  try {
    const { sendNotification } = require('./notificationManager');
    await sendNotification(
      client,
      guild.id,
      'raids',
      new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle('🚨 Raid détecté !')
        .setDescription(`${summary}\n\n**Actions automatiques :**\n${actions.length ? actions.map(a => `• ${a}`).join('\n') : '• aucune (mode monitor)'}`)
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .setTimestamp(),
      `Raid détecté sur ${guild.name}`,
    );
  } catch (err) { console.error('[anti-raid] notif:', err.message); }

  // Auto-désactivation du verrouillage après N minutes
  if (cfg.autoResolveMin > 0) {
    setTimeout(async () => {
      try {
        const fresh = await AntiRaid.findOne({ guildId: guild.id });
        if (fresh?.disconRaised) {
          const undone = [];
          await restoreDiscon(guild, fresh, undone).catch(() => {});
          await fresh.save().catch(() => {});
        }
        if (fresh?.lockdownActive) {
          await lockAll(guild, false);
          fresh.lockdownActive = false;
          await fresh.save();
          await logAction(client, fresh, logEmbed(guild.id, {
            color: COLORS.success,
            title: '🔓 Verrouillage levé automatiquement',
            description: `Délai de ${fresh.autoResolveMin} min écoulé.`,
          }));
        }
      } catch (_) {}
    }, cfg.autoResolveMin * 60_000);
  }
}

// ─── Fin de raid (manuel) ────────────────────────────────────────────────────
async function endRaid(client, guild, cfg) {
  const actions = [];

  // 0) DISCON d'abord : il rouvre ce qu'il a lui-même fermé (rideau compris),
  //    avant que les verrouillages hérités ne soient levés.
  try {
    await restoreDiscon(guild, cfg, actions);
  } catch (err) {
    actions.push(`DISCON non rétabli (${err.message})`);
  }

  if (cfg.lockdownActive) {
    const unlocked = await lockAll(guild, false);
    cfg.lockdownActive = false;
    actions.push(`serveur déverrouillé (${unlocked} salons)`);
  }
  if (cfg.invitesBlocked) {
    const restored = typeof guild.setInvitesDisabled === 'function'
      ? await guild.setInvitesDisabled(false).then(() => true).catch(() => false)
      : false;
    cfg.invitesBlocked = false;
    actions.push(restored ? 'invitations réactivées' : 'invitations à réactiver manuellement');
  }
  if (cfg.quarantineOnJoin) {
    const released = await releaseQuarantine(client, guild, cfg);
    if (released) actions.push(`${released} membre(s) sortis de quarantaine (rôles restaurés)`);
  }
  // Captcha activé automatiquement → on le désactive
  try {
    const capCfg = await CaptchaConfig.findOne({ guildId: guild.id });
    if (capCfg?.raidAutoActive) {
      capCfg.enabled = false;
      capCfg.raidAutoActive = false;
      await capCfg.save();
      actions.push('captcha auto désactivé');
    }
  } catch (_) {}

  cfg.raidActive = false;
  cfg.joins = [];
  cfg.waveState = null;
  await cfg.save().catch(() => {});

  await logAction(client, cfg, logEmbed(guild.id, {
    color: COLORS.success,
    title: '✅ Fin du raid',
    description: actions.length ? actions.map(a => `• ${a}`).join('\n') : '• aucune action à annuler',
  }));
  return actions;
}

// ─── Reprise après redémarrage ──────────────────────────────────────────────
// Les minuteurs de levée automatique vivent en mémoire : un redémarrage pendant
// un raid les perdrait, et le rideau resterait baissé indéfiniment. Au démarrage,
// on rend donc son état à chaque serveur concerné.
async function recoverRaidState(client, { now = Date.now() } = {}) {
  const out = { restored: 0, rearmed: 0, awaiting: 0, skipped: 0 };
  const docs = await AntiRaid.find({
    $or: [{ disconRaised: true }, { lockdownActive: true }, { invitesBlocked: true }, { raidActive: true }],
  }).catch(() => []);

  for (const cfg of docs) {
    const guild = client.guilds.cache.get(cfg.guildId);
    if (!guild) { out.skipped++; continue; }

    const elapsedMin = cfg.raidDetectedAt
      ? (now - new Date(cfg.raidDetectedAt).getTime()) / 60_000
      : Infinity;

    if (cfg.autoResolveMin > 0 && elapsedMin >= cfg.autoResolveMin) {
      await endRaid(client, guild, cfg).catch(() => {});
      out.restored++;
    } else if (cfg.autoResolveMin > 0) {
      const remaining = Math.max(1_000, (cfg.autoResolveMin - elapsedMin) * 60_000);
      const timer = setTimeout(() => { endRaid(client, guild, cfg).catch(() => {}); }, remaining);
      if (typeof timer?.unref === 'function') timer.unref();
      out.rearmed++;
    } else {
      // Levée manuelle : on laisse l'état en place, un admin doit conclure.
      out.awaiting++;
    }
  }

  return out;
}

// ─── Pipeline principal : un membre rejoint le serveur ───────────────────────
async function joinAction(member, client) {
  const guild = member.guild;
  const cfg = await getConfig(guild.id);
  if (!cfg.enabled) return { skipped: true };
  if (member.user.bot) return { skipped: true }; // les bots ne passent pas par la protection arrivées

  const now = Date.now();

  // 0) Anti-liste : raider connu qui revient
  const banned = checkBlacklisted(cfg, member.id);
  if (banned.action === 'ban') {
    await member.ban({ reason: 'Anti-raid : utilisateur sur la liste anti-raid' }).catch(() => {});
    await logAction(client, cfg, logEmbed(guild.id, { color: COLORS.error, title: '⛔ Anti-liste — ban automatique', description: `<@${member.id}> (\`${member.id}\`) était sur la liste anti-raid.` }));
    return { action: 'banned' };
  }
  if (banned.action === 'kick') {
    await member.kick('Anti-raid : utilisateur sur la liste anti-raid').catch(() => {});
    await logAction(client, cfg, logEmbed(guild.id, { color: COLORS.error, title: '⛔ Anti-liste — kick automatique', description: `<@${member.id}> (\`${member.id}\`) était sur la liste anti-raid.` }));
    return { action: 'kicked' };
  }

  // 1) Enregistrement de l'arrivée (fenêtre glissante, max 500 entrées)
  cfg.joins = cfg.joins || [];
  cfg.joins.push({ userId: member.id, accountAgeDays: (now - member.user.createdTimestamp) / 86_400_000, joinedAt: now });
  if (cfg.joins.length > 500) cfg.joins = cfg.joins.slice(-500);

  // 2) Détection de masse
  const det = detectRaid(cfg, cfg.joins, now);

  // 3) Wave raids
  let waveCount = 0;
  if (cfg.waveEnabled) {
    waveCount = recordWaveJoin(cfg, cfg.wavePeriodMin, now);
  }

  await cfg.save().catch(() => {});

  // 4) Raid confirmé ?
  const wave = cfg.waveEnabled && isWaveRaid(waveCount, cfg.waveThreshold);
  if (det.raid || wave) {
    if (!cfg.raidActive) {
      const summary = det.raid
        ? `**${det.joins} arrivées en ${cfg.joinsWindowSec}s** (seuil : ${det.threshold}).`
        : `**${waveCount} arrivées en ${cfg.wavePeriodMin} min** (seuil wave : ${cfg.waveThreshold}).`;
      await applyRaidResponse(client, guild, cfg, summary);
      return { action: 'raid_started', joins: det.joins };
    }
    return { action: 'raid_ongoing', joins: det.joins };
  }

  // 5) Pas de raid : heuristiques sur CE membre
  const assess = assessJoin(cfg, member);
  if (assess.suspect) {
    const suspects = (cfg.joins || []).filter(j => j.accountAgeDays < (cfg.minAccountAgeDays || 99999)).length;
    if (cfg.mode !== 'monitor' && suspects >= (cfg.suspicionThreshold || 6)) {
      const summary = `**${suspects} comptes suspects** en fenêtre courte (comptes récents/avatars par défaut).`;
      await applyRaidResponse(client, guild, cfg, summary);
      return { action: 'raid_started', joins: suspects };
    }
    // Quarantaine individuelle des comptes trop récents (hors monitor)
    if (cfg.quarantineOnJoin && cfg.mode !== 'monitor' && assess.reasons.some(r => r.includes('compte'))) {
      await quarantineMember(member, cfg);
      await logAction(client, cfg, logEmbed(guild.id, {
        color: COLORS.warning,
        title: '🛡️ Compte suspect mis en quarantaine',
        description: `<@${member.id}> (\`${member.id}\`)\nRaisons : ${assess.reasons.join(' · ')}`,
      }));
      return { action: 'quarantined', reasons: assess.reasons };
    }
  }

  return { action: 'ok', joins: det.joins };
}

// ─── Départ d'un membre : restauration pour la quarantaine ───────────────────
async function memberLeftAction(guildId, userId) {
  const cfg = await AntiRaid.findOne({ guildId });
  if (!cfg) return;
  const entry = (cfg.quarantined || []).find(q => q.userId === userId);
  if (entry) {
    cfg.quarantined = cfg.quarantined.filter(q => q.userId !== userId);
    await cfg.save().catch(() => {});
  }
  const jIdx = (cfg.joins || []).findIndex(j => j.userId === userId);
  if (jIdx !== -1) {
    cfg.joins.splice(jIdx, 1);
    await cfg.save().catch(() => {});
  }
}

module.exports = {
  getConfig, logAction, logEmbed,
  lockAll, ensureQuarantineRole, quarantineMember, releaseQuarantine,
  sendHoneypotMessage, triggerHoneypot,
  applyRaidResponse, endRaid, recoverRaidState,
  joinAction, memberLeftAction,
  HONEYPOT_MSG,
};
