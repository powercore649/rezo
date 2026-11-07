// utils/startupCleanup.js — Nettoyage des références à des salons/rôles qui n'existent plus
// Portée volontairement limitée aux modèles de configuration "simples" (pas de docs
// représentant un objet Discord concret comme un ticket ou un salon modmail créé,
// pour éviter toute suppression destructive sur des données vivantes).

async function cleanupStaleData(client) {
  const stats = { channelsCleared: 0, rolesCleared: 0, docsDeleted: 0, guildsScanned: 0, securityAlerts: 0 };

  for (const guild of client.guilds.cache.values()) {
    stats.guildsScanned++;
    const hasChannel = (id) => !id || guild.channels.cache.has(id);
    const hasRole    = (id) => !id || guild.roles.cache.has(id);

    // ── Honeypot ──────────────────────────────────────────────────────────
    try {
      const Honeypot = require('../models/Honeypot');
      const doc = await Honeypot.findOne({ guildId: guild.id });
      if (doc) {
        let changed = false;
        const before = doc.channelIds.length;
        doc.channelIds = doc.channelIds.filter(id => guild.channels.cache.has(id));
        if (doc.channelIds.length !== before) { stats.channelsCleared += before - doc.channelIds.length; changed = true; }
        if (!hasChannel(doc.logChannelId)) { doc.logChannelId = null; stats.channelsCleared++; changed = true; }
        if (doc.enabled && doc.channelIds.length === 0) { doc.enabled = false; changed = true; }
        if (changed) await doc.save();
      }
    } catch (err) { console.error('[cleanup] Honeypot:', err.message); }

    // ── XPConfig ──────────────────────────────────────────────────────────
    try {
      const XPConfig = require('../models/XPConfig');
      const doc = await XPConfig.findOne({ guildId: guild.id });
      if (doc) {
        let changed = false;

        const beforeExcl = doc.excludedChannels.length;
        doc.excludedChannels = doc.excludedChannels.filter(id => guild.channels.cache.has(id));
        if (doc.excludedChannels.length !== beforeExcl) { stats.channelsCleared += beforeExcl - doc.excludedChannels.length; changed = true; }

        const beforeSilent = doc.silentChannels.length;
        doc.silentChannels = doc.silentChannels.filter(id => guild.channels.cache.has(id));
        if (doc.silentChannels.length !== beforeSilent) { stats.channelsCleared += beforeSilent - doc.silentChannels.length; changed = true; }

        if (!hasChannel(doc.levelUpChannelId)) { doc.levelUpChannelId = null; stats.channelsCleared++; changed = true; }

        const beforeRoles = doc.levelRoles.length;
        doc.levelRoles = doc.levelRoles.filter(lr => guild.roles.cache.has(lr.roleId));
        if (doc.levelRoles.length !== beforeRoles) { stats.rolesCleared += beforeRoles - doc.levelRoles.length; changed = true; }

        for (const id of [...doc.channelMultipliers.keys()]) {
          if (!guild.channels.cache.has(id)) { doc.channelMultipliers.delete(id); stats.channelsCleared++; changed = true; }
        }
        for (const id of [...doc.roleMultipliers.keys()]) {
          if (!guild.roles.cache.has(id)) { doc.roleMultipliers.delete(id); stats.rolesCleared++; changed = true; }
        }

        if (changed) await doc.save();
      }
    } catch (err) { console.error('[cleanup] XPConfig:', err.message); }

    // ── LeaderboardConfig ─────────────────────────────────────────────────
    try {
      const LeaderboardConfig = require('../models/LeaderboardConfig');
      const doc = await LeaderboardConfig.findOne({ guildId: guild.id });
      if (doc && !hasChannel(doc.channelId)) {
        doc.channelId = null; stats.channelsCleared++;
        await doc.save();
      }
    } catch (err) { console.error('[cleanup] LeaderboardConfig:', err.message); }

    // ── GuildLogs (4 catégories) ─────────────────────────────────────────
    try {
      const GuildLogs = require('../models/GuildLogs');
      const doc = await GuildLogs.findOne({ guildId: guild.id });
      if (doc) {
        let changed = false;
        for (const cat of ['moderation', 'membres', 'messages', 'vocal']) {
          if (doc[cat] && !hasChannel(doc[cat].channelId)) {
            doc[cat].channelId = null;
            doc[cat].enabled = false;
            stats.channelsCleared++;
            changed = true;
          }
        }
        if (changed) await doc.save();
      }
    } catch (err) { console.error('[cleanup] GuildLogs:', err.message); }

    // ── BirthdayConfig ────────────────────────────────────────────────────
    try {
      const BirthdayConfig = require('../models/BirthdayConfig');
      const doc = await BirthdayConfig.findOne({ guildId: guild.id });
      if (doc) {
        let changed = false;
        if (!hasChannel(doc.channelId)) { doc.channelId = null; doc.enabled = false; stats.channelsCleared++; changed = true; }
        if (!hasRole(doc.roleId))       { doc.roleId = null;    stats.rolesCleared++;  changed = true; }
        if (!hasRole(doc.pingRoleId))   { doc.pingRoleId = null; stats.rolesCleared++; changed = true; }
        if (changed) await doc.save();
      }
    } catch (err) { console.error('[cleanup] BirthdayConfig:', err.message); }

    // ── CaptchaConfig ─────────────────────────────────────────────────────
    // Un module de sécurité ne se dégrade JAMAIS silencieusement : on nettoie
    // les références mortes (salon/rôles supprimés) mais `enabled` reste tel
    // quel. La porte reste donc fermée (un captcha non délivrable refuse
    // l'accès) et une alerte est émise au lieu d'un abandon discret.
    try {
      const { CaptchaConfig } = require('../models/Captcha');
      const doc = await CaptchaConfig.findOne({ guildId: guild.id });
      if (doc) {
        let changed = false;
        if (!hasChannel(doc.channelId))   { doc.channelId = null;    stats.channelsCleared++; changed = true; }
        if (!hasRole(doc.roleBefore))     { doc.roleBefore = null;   stats.rolesCleared++;    changed = true; }
        if (!hasRole(doc.roleAfter))      { doc.roleAfter = null;    stats.rolesCleared++;    changed = true; }
        if (!hasRole(doc.bypassRoleId))   { doc.bypassRoleId = null; stats.rolesCleared++;    changed = true; }
        if (changed) {
          await doc.save();
          if (doc.enabled) {
            stats.securityAlerts++;
            console.error(`[cleanup] ⛔ Captcha actif mais incomplet sur ${guild.name} (${guild.id}) : les arrivées seront refusées tant que le salon ou le rôle manquant n'est pas reconfiguré.`);
          }
        }
      }
    } catch (err) { console.error('[cleanup] CaptchaConfig:', err.message); }

    // ── PermissionVault (coffre-fort) ─────────────────────────────────────
    // Même règle que le captcha : on oublie les cibles mortes (une référence
    // vers un salon supprimé ne protège rien) mais on n'éteint jamais le
    // module en silence — une alerte est émise et le panneau l'affiche.
    try {
      const PermissionVault = require('../models/PermissionVault');
      const doc = await PermissionVault.findOne({ guildId: guild.id });
      if (doc) {
        let changed = false;
        const beforeCh = doc.protectedChannels.length;
        doc.protectedChannels = doc.protectedChannels.filter(c => guild.channels.cache.has(c.channelId));
        if (doc.protectedChannels.length !== beforeCh) {
          stats.channelsCleared += beforeCh - doc.protectedChannels.length;
          changed = true;
        }
        const beforeRoles = doc.protectedRoles.length;
        doc.protectedRoles = doc.protectedRoles.filter(r => guild.roles.cache.has(r.roleId));
        if (doc.protectedRoles.length !== beforeRoles) {
          stats.rolesCleared += beforeRoles - doc.protectedRoles.length;
          changed = true;
        }
        const beforeTrust = doc.trustedRoles.length;
        doc.trustedRoles = doc.trustedRoles.filter(id => guild.roles.cache.has(id) || id === guild.id);
        if (doc.trustedRoles.length !== beforeTrust) {
          stats.rolesCleared += beforeTrust - doc.trustedRoles.length;
          changed = true;
        }
        if (!hasChannel(doc.logChannelId)) { doc.logChannelId = null; stats.channelsCleared++; changed = true; }
        if (changed) {
          await doc.save();
          if (doc.enabled) {
            stats.securityAlerts++;
            console.error(`[cleanup] ⛔ Coffre-fort actif mais cible(s) disparue(s) sur ${guild.name} (${guild.id}) : vérifie le panneau /securite.`);
          }
        }
      }
    } catch (err) { console.error('[cleanup] PermissionVault:', err.message); }

    // ── AutoRole (doc inutile sans son rôle → suppression) ───────────────
    try {
      const AutoRole = require('../models/AutoRole');
      const docs = await AutoRole.find({ guildId: guild.id });
      const staleIds = docs.filter(d => !guild.roles.cache.has(d.roleId)).map(d => d._id);
      if (staleIds.length) {
        await AutoRole.deleteMany({ _id: { $in: staleIds } });
        stats.docsDeleted += staleIds.length;
      }
    } catch (err) { console.error('[cleanup] AutoRole:', err.message); }

    // ── WaitingRoom (salon d'attente) ──────────────────────────────────────
    try {
      const WaitingRoom = require('../models/WaitingRoom');
      const doc = await WaitingRoom.findOne({ guildId: guild.id });
      if (doc) {
        let changed = false;
        if (!hasChannel(doc.voiceChannelId)) { doc.voiceChannelId = null; doc.enabled = false; stats.channelsCleared++; changed = true; }
        if (!hasChannel(doc.targetChannelId)) { doc.targetChannelId = null; stats.channelsCleared++; changed = true; }
        if (!hasChannel(doc.logChannelId))    { doc.logChannelId = null; stats.channelsCleared++; changed = true; }
        if (!hasChannel(doc.tempCategoryId))  { doc.tempCategoryId = null; stats.channelsCleared++; changed = true; }
        if (!hasRole(doc.staffRoleId))        { doc.staffRoleId = null; stats.rolesCleared++; changed = true; }
        if (!hasRole(doc.waitingRoleId))      { doc.waitingRoleId = null; stats.rolesCleared++; changed = true; }
        // Salons temporaires disparus → on oublie leur identifiant (les orphelins
        // restants sont supprimés par reconcile() au démarrage).
        if (Array.isArray(doc.tempChannelIds) && doc.tempChannelIds.length) {
          const alive = doc.tempChannelIds.filter(id => guild.channels.cache.has(id));
          if (alive.length !== doc.tempChannelIds.length) { doc.tempChannelIds = alive; changed = true; }
        }
        if (changed) { doc.queueMessageId = null; await doc.save(); }
      }
    } catch (err) { console.error('[cleanup] WaitingRoom:', err.message); }

    // ── VoiceConfig (salons exclus) ────────────────────────────────────────
    try {
      const VoiceConfig = require('../models/VoiceConfig');
      const doc = await VoiceConfig.findOne({ guildId: guild.id });
      if (doc) {
        const before = doc.excludedChannels.length;
        doc.excludedChannels = doc.excludedChannels.filter(id => guild.channels.cache.has(id));
        if (doc.excludedChannels.length !== before) {
          stats.channelsCleared += before - doc.excludedChannels.length;
          await doc.save();
        }
      }
    } catch (err) { console.error('[cleanup] VoiceConfig:', err.message); }
  }

  return stats;
}

module.exports = { cleanupStaleData };
