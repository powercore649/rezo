// utils/bumpNetwork.js — Réseau de bumps complet v2
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Server = require('../models/Server');
const { COLORS } = require('./embeds');
const { siteUrl } = require('./siteUrl');

const BUMP_COOLDOWN_MS  = 2 * 60 * 60 * 1000; // 2h
const BUMP_COINS_REWARD = 50;

// ─── Calcul streak ────────────────────────────────────────────────────────────
// Clé de jour unique (UTC, comme l'historique du bot). Le calcul de la streak
// vit dans utils/bumpService.js::claimBump — une seule implémentation, pour que
// la commande et les récompenses ne puissent jamais diverger.
function dayKey(date = new Date()) { return new Date(date).toISOString().split('T')[0]; }

// ─── Calcul score de qualité (pour le tri du top serveurs) ───────────────────
function computeScore(server) {
  const streakBonus   = Math.min(server.bumpStreak * 2, 100);
  const weeklyScore   = server.weeklyBumps * 5;
  const voteScore     = (server.totalVotes || 0) * 3;
  const featuredBonus = server.featured && server.featuredUntil && new Date(server.featuredUntil) > new Date() ? 200 : 0;
  return weeklyScore + streakBonus + voteScore + featuredBonus;
}

// ─── Diffusion du bump ────────────────────────────────────────────────────────
async function broadcastBump(client, sourceServer, bumperUser) {
  // Cache d'abord : un bump ne doit pas attendre un aller-retour API inutile
  // quand le serveur source est déjà connu du client.
  const guild = client.guilds.cache.get(sourceServer.guildId)
    || await client.guilds.fetch(sourceServer.guildId).catch(() => null);
  if (!guild) return 0;

  const tags = sourceServer.tags?.length > 0
    ? sourceServer.tags.map(t => `\`${t}\``).join(' ') : '*Aucun*';
  const streakText = sourceServer.bumpStreak >= 3
    ? `\n🔥 **Streak : ${sourceServer.bumpStreak} jours consécutifs !**` : '';
  const isFeatured = sourceServer.featured && sourceServer.featuredUntil &&
    new Date(sourceServer.featuredUntil) > new Date();

  const nextBumpTs = Math.floor((Date.now() + BUMP_COOLDOWN_MS) / 1000);

  const embed = new EmbedBuilder()
    .setColor(isFeatured ? 0xFFD700 : COLORS.primary)
    .setAuthor({
      name: isFeatured ? '⭐ Serveur mis en avant !' : '🚀 Nouveau serveur bumpé !',
      iconURL: client.user.displayAvatarURL(),
    })
    .setTitle(guild.name)
    .setDescription(`${sourceServer.description || '*Pas de description.*'}${streakText}`)
    .setThumbnail(guild.iconURL({ dynamic: true }) || null)
    .addFields(
      { name: '👥 Membres',       value: `**${guild.memberCount.toLocaleString()}**`, inline: true },
      { name: '📊 Total bumps',   value: `**${sourceServer.bumpCount}**`,             inline: true },
      { name: '🏷️ Tags',          value: tags,                                        inline: true },
      { name: '🌐 Langue',        value: sourceServer.language?.toUpperCase() || 'FR', inline: true },
      { name: '📅 Bumps/semaine', value: `**${sourceServer.weeklyBumps}**`,           inline: true },
      { name: '⏰ Prochain bump',  value: `<t:${nextBumpTs}:R>`,                      inline: true },
    )
    .setFooter({ text: `Bumpé par ${bumperUser.tag} • Score: ${computeScore(sourceServer)}`, iconURL: bumperUser.displayAvatarURL() })
    .setTimestamp();

  const buttons = [
    new ButtonBuilder().setLabel('👍 Voter').setStyle(ButtonStyle.Success).setCustomId(`vote_${sourceServer.guildId}`),
  ];
  if (sourceServer.inviteLink) {
    buttons.push(
      new ButtonBuilder().setLabel('🔗 Rejoindre').setStyle(ButtonStyle.Link).setURL(sourceServer.inviteLink),
    );
  }
  buttons.push(
    new ButtonBuilder().setLabel('🌐 Voir sur le site').setStyle(ButtonStyle.Link).setURL(`${siteUrl()}/server/${sourceServer.guildId}`),
  );
  const row = new ActionRowBuilder().addComponents(buttons);

  const targets = await Server.find({
    feedChannelId: { $ne: null },
    guildId:       { $ne: sourceServer.guildId },
    blacklisted:   false,
  }).lean();

  let sent = 0;
  let failed = 0;
  await Promise.allSettled(targets.map(async target => {
    try {
      const targetGuild = client.guilds.cache.get(target.guildId)
        || await client.guilds.fetch(target.guildId).catch(() => null);
      if (!targetGuild) { failed++; return; }

      const channel = targetGuild.channels.cache.get(target.feedChannelId)
        || await targetGuild.channels.fetch(target.feedChannelId).catch(() => null);
      if (!channel?.isTextBased()) { failed++; return; }

      const perms = channel.permissionsFor?.(targetGuild.members.me);
      if (perms && !perms.has(['SendMessages', 'EmbedLinks'])) { failed++; return; }

      await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
      sent++;
    } catch (_) { failed++; }
  }));

  if (failed > 0) {
    console.warn(`⚠️ bump — diffusion : ${sent} envoyé(s), ${failed} salon(s) injoignable(s)`);
  }
  return sent;
}

// ─── Rappels automatiques ─────────────────────────────────────────────────────
async function sendBumpReminders(client) {
  const BumpNotifConfig = require('../models/BumpNotifConfig');
  const { renderTemplate, resolveNotifChannelId } = require('./bumpNotifEngine');

  try {
    // Le champ éligible n'est PAS bumpChannelId (qui restreint juste la commande
    // /bump à un salon précis, souvent jamais configuré) — la disponibilité d'un
    // salon de notification réel est vérifiée plus bas via resolveNotifChannelId()
    // (notifConfig.notifChannelId en priorité, avec repli sur bumpChannelId).
    const servers = await Server.find({
      lastBump:        { $ne: null },
      reminderEnabled: true,
      reminderSent:    false,
    });

    for (const server of servers) {
      try {
        const elapsed = Date.now() - new Date(server.lastBump).getTime();
        if (elapsed < BUMP_COOLDOWN_MS) continue;

        const guild = client.guilds.cache.get(server.guildId)
          || await client.guilds.fetch(server.guildId).catch(() => null);
        if (!guild) continue;

        const notifConfig = await BumpNotifConfig.findOne({ guildId: server.guildId });
        const channelId = resolveNotifChannelId(notifConfig, server);
        if (!channelId) continue;

        const channel = guild.channels.cache.get(channelId)
          || await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) continue;
        const perms = guild.members.me ? channel.permissionsFor(guild.members.me) : null;
        if (perms && !perms.has(['SendMessages', 'EmbedLinks'])) continue;

        const showStreak = notifConfig?.showStreakBonus ?? true;
        const showTotal  = notifConfig?.showTotalBumps ?? true;
        const silent     = notifConfig?.silentPing ?? false;
        const colorHex   = notifConfig?.embedColor || 'FEE75C';
        const autoDeleteMin = notifConfig?.autoDeleteMinutes || 0;

        const streakBonus = showStreak && server.bumpStreak >= 7
          ? `\n🔥 Tu es sur une **streak de ${server.bumpStreak} jours** ! Ne la brise pas !` : '';
        const coinsText = `\n💰 Tu gagneras **${BUMP_COINS_REWARD} coins** en bumpant maintenant !`;

        const mainMessage = renderTemplate(notifConfig?.customMessage, {
          serveur: guild.name, streak: server.bumpStreak, coins: BUMP_COINS_REWARD, total: server.bumpCount,
        });

        const embed = new EmbedBuilder()
          .setColor(parseInt(colorHex, 16) || 0xFEE75C)
          .setTitle('⏰ Cooldown terminé — Bumpez !')
          .setDescription(mainMessage + streakBonus + coinsText)
          .setThumbnail(guild.iconURL({ dynamic: true }))
          .setFooter({ text: 'REZO • Rappel automatique' })
          .setTimestamp();

        const fields = [];
        if (showTotal) fields.push({ name: '📊 Total bumps', value: `${server.bumpCount}`, inline: true });
        if (showStreak) fields.push({ name: '🔥 Streak actuel', value: `${server.bumpStreak} jour(s)`, inline: true });
        if (fields.length) embed.addFields(...fields);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('🚀 Bumper maintenant').setStyle(ButtonStyle.Primary).setCustomId('bump_reminder_click'),
        );

        // Marque le rappel comme envoyé de façon atomique : deux exécutions
        // simultanées du cron ne peuvent pas envoyer deux fois le même rappel.
        const claimed = await Server.findOneAndUpdate(
          { guildId: server.guildId, reminderSent: false },
          { $set: { reminderSent: true } },
          { new: true },
        );
        if (!claimed) continue;

        try {
          const content = (!silent && server.bumpRoleId) ? `<@&${server.bumpRoleId}>` : null;
          const sentMsg = await channel.send({ content, embeds: [embed], components: [row] });

          if (autoDeleteMin > 0) {
            setTimeout(() => sentMsg.delete().catch(() => {}), autoDeleteMin * 60 * 1000);
          }
        } catch (err) {
          // Échec d'envoi : on rend le rappel éligible pour le prochain passage.
          await Server.updateOne({ guildId: server.guildId }, { $set: { reminderSent: false } }).catch(() => {});
          throw err;
        }
      } catch (err) {
        console.error(`❌ Rappel ${server.guildId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ sendBumpReminders:', err.message);
  }
}

// ─── Reset hebdomadaire / mensuel ─────────────────────────────────────────────
async function resetWeeklyBumps() {
  await Server.updateMany({}, { $set: { weeklyBumps: 0 } });
  await require('../models/User').updateMany({}, { $set: { weeklyBumps: 0 } });
  console.log('✅ Reset bumps hebdomadaires');
}
async function resetMonthlyBumps() {
  await Server.updateMany({}, { $set: { monthlyBumps: 0 } });
  await require('../models/User').updateMany({}, { $set: { monthlyBumps: 0 } });
  console.log('✅ Reset bumps mensuels');
}

// ─── Reset quotidien des votes (toutes les 24h) ───────────────────────────────
async function resetDailyVotes() {
  try {
    const Vote = require('../models/Vote');
    await Vote.deleteMany({ createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
    console.log('✅ Reset votes quotidiens');
  } catch(err) { console.error('resetDailyVotes:', err.message); }
}

module.exports = {
  broadcastBump,
  sendBumpReminders,
  resetWeeklyBumps,
  resetMonthlyBumps,
  resetDailyVotes,
  dayKey,
  computeScore,
  BUMP_COOLDOWN_MS,
  BUMP_COINS_REWARD,
};
