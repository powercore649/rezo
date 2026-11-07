'use strict';
// utils/notificationManager.js — Système de notifications en temps réel
// Gère l'envoi des notifications et la mise à jour du panel live.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { NotificationSub, NotificationLog, NotificationConfig, NotificationUserLog, NotificationFeed } = require('../models/Notification');
const { COLORS } = require('../utils/embeds');
const ui = require('./ui');

// ─── Construire l'embed du panel live ────────────────────────────────────────
async function buildPanelEmbed(guild, config) {
  // Dernières notifications (5 max)
  const logs = await NotificationLog.find({ guildId: guild.id })
    .sort({ sentAt: -1 })
    .limit(5)
    .lean();

  // Nombre d'abonnés par type
  // Un seul agrégat pour tous les compteurs : le panel est rafraîchi à chaque
  // notification, une requête par type devenait coûteux.
  const [subStats = {}] = await NotificationSub.aggregate([
    { $match: { guildId: guild.id } },
    {
      $group: {
        _id: null,
        total:     { $sum: 1 },
        freeGames: { $sum: { $cond: ['$freeGames', 1, 0] } },
        giveaways: { $sum: { $cond: ['$giveaways', 1, 0] } },
        events:    { $sum: { $cond: ['$events', 1, 0] } },
        streams:   { $sum: { $cond: ['$streams', 1, 0] } },
        bumps:     { $sum: { $cond: ['$bumps', 1, 0] } },
        raids:     { $sum: { $cond: ['$raids', 1, 0] } },
        members:   { $sum: { $cond: ['$members', 1, 0] } },
        news:      { $sum: { $cond: ['$news', 1, 0] } },
        modmail:   { $sum: { $cond: ['$modmail', 1, 0] } },
      },
    },
  ]);

  const totalSubs = subStats.total || 0;
  const countOf = (key) => subStats[key] || 0;

  const lastLogsText = logs.length > 0
    ? logs.map(l => {
        const ts = Math.floor(new Date(l.sentAt).getTime() / 1000);
        return `<t:${ts}:R> — **${l.title}** *(${l.sentTo} notifié(s))*`;
      }).join('\n')
    : '*Aucune notification encore envoyée.*';

  const ok = v => v ? '🟢' : '🔴';

  return ui.panelEmbed({
    color: COLORS.primary,
    title: '🔔 Notifications — temps réel',
    subtitle: 'Ce panneau se met à jour à chaque notification envoyée.',
    thumbnail: guild.iconURL({ dynamic: true }),
    footer: 'Notifications',
    fields: [
      {
        name: '⚙️ Configuration',
        value: [
          `${ok(config.freeGamesEnabled)} Jeux gratuits`,
          `${ok(config.bumpsEnabled)} Bumps`,
          `${ok(config.giveawaysEnabled)} Giveaways`,
          `${ok(config.eventsEnabled)} Événements`,
          `${ok(config.streamsEnabled)} Streams`,
          `${ok(config.raidsEnabled)} Raids & sécurité`,
          `${ok(config.membersEnabled)} Nouveaux membres`,
          `${ok(config.newsEnabled)} Actualités`,
          `${ok(config.modmailEnabled)} ModMail`,
          `📋 Logs: ${config.logChannelId ? `<#${config.logChannelId}>` : '*Non défini*'}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '👥 Abonnés',
        value: [
          `Total: **${totalSubs}**`,
          `🎮 Jeux gratuits: **${countOf('freeGames')}**`,
          `🎉 Giveaways: **${countOf('giveaways')}**`,
          `📅 Événements: **${countOf('events')}**`,
          `📺 Streams: **${countOf('streams')}**`,
          `🚀 Bumps: **${countOf('bumps')}**`,
          `🚨 Raids: **${countOf('raids')}**`,
          `👥 Membres: **${countOf('members')}**`,
          `📰 Actualités: **${countOf('news')}**`,
          `📬 ModMail: **${countOf('modmail')}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📨 Dernières notifications',
        value: lastLogsText,
        inline: false,
      },
    ],
  });
}

// ─── Mettre à jour le panel live ─────────────────────────────────────────────
async function updateLivePanel(client, guildId) {
  try {
    const config = await NotificationConfig.findOne({ guildId });
    if (!config?.panelChannelId || !config?.panelMessageId) return;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const channel = guild.channels.cache.get(config.panelChannelId);
    if (!channel?.isTextBased()) return;

    const embed = await buildPanelEmbed(guild, config);
    const row   = buildPanelButtons();

    const msg = await channel.messages.fetch(config.panelMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
    } else {
      // Message supprimé — en recréer un
      const newMsg = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
      if (newMsg) {
        await NotificationConfig.findOneAndUpdate(
          { guildId },
          { panelMessageId: newMsg.id }
        );
      }
    }
  } catch (err) {
    console.error('updateLivePanel:', err.message);
  }
}

// ─── Boutons du panel ─────────────────────────────────────────────────────────
function buildPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('notif_subscribe')
      .setLabel('🔔 S\'abonner')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('notif_unsubscribe')
      .setLabel('🔕 Se désabonner')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('notif_my_prefs')
      .setLabel('⚙️ Mes préférences')
      .setStyle(ButtonStyle.Secondary),
  );
}

// ─── Fil personnel — embed listant l'historique de notifications d'un membre ──
// Le centre est édité en place : sa description doit donc rester sous la
// limite Discord (4096 caractères), sinon l'édition échoue et plus rien ne
// s'affiche. On borne le nombre de lignes ET la longueur totale, en indiquant
// combien de notifications sont masquées.
const FEED_MAX_LINES = 10;
const FEED_DESCRIPTION_LIMIT = 3800; // marge sous les 4096 de Discord

function feedLine(client, log) {
  const ts = Math.floor(new Date(log.createdAt).getTime() / 1000);
  const dot = log.read ? '⚪' : '🔵';
  const guildName = String(client.guilds.cache.get(log.guildId)?.name || 'Serveur').slice(0, 32);
  const title = String(log.title || 'Notification').slice(0, 80);
  return `${dot} **${title}** *(${guildName})* — <t:${ts}:R>`;
}

async function buildUserFeedEmbed(client, userId) {
  const logs = await NotificationUserLog.find({ userId })
    .sort({ createdAt: -1 })
    .limit(FEED_MAX_LINES + 10)
    .lean();
  const unreadCount = await NotificationUserLog.countDocuments({ userId, read: false });

  const lines = [];
  let hidden = 0;

  for (const log of logs) {
    if (lines.length >= FEED_MAX_LINES) { hidden++; continue; }
    const line = feedLine(client, log);
    if ([...lines, line].join('\n').length > FEED_DESCRIPTION_LIMIT - 200) { hidden++; continue; }
    lines.push(line);
  }

  let description = lines.length ? lines.join('\n') : '*Aucune notification pour le moment.*';
  if (hidden > 0) {
    description += `\n*… et ${hidden} autre(s) notification(s) — voir l’historique complet avec les boutons ci-dessous.*`;
  }

  return ui.panelEmbed({
    color: COLORS.primary,
    title: '📬 Centre de notifications',
    subtitle: 'Toutes vos alertes, tous serveurs confondus.',
    description,
    footer: unreadCount > 0 ? `${unreadCount} non lue(s)` : 'Tout est lu',
  });
}

function buildUserFeedButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('notif_feed_refresh').setLabel('🔄 Actualiser').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('notif_feed_read_all').setLabel('✅ Tout marquer comme lu').setStyle(ButtonStyle.Success),
  );
}

// ─── Fil personnel — envoie ou met à jour le message DM live d'un membre ─────
// opts.createIfMissing: si true, crée le DM même si aucun fil n'existe encore.
// Retourne true si le DM a pu être envoyé/édité, false si les DMs sont fermés.
async function updateUserFeed(client, userId, opts = {}) {
  try {
    let feed = await NotificationFeed.findOne({ userId });
    if (!feed && !opts.createIfMissing) return false;

    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return false;

    const embed = await buildUserFeedEmbed(client, userId);
    const row = buildUserFeedButtons();

    // Centre devenu trop haut (ancien fil construit sans limite, contenu trop
    // long) : impossible à éditer, Discord refuserait la requête. On en
    // renvoie un neuf, l'ancien message restant dans les MP comme archive.
    const descriptionSize = (embed.data?.description || '').length;
    const tooTall = descriptionSize > FEED_DESCRIPTION_LIMIT;

    // Tente d'éditer le message existant
    if (feed?.dmMessageId && !tooTall) {
      try {
        const dm = await user.createDM();
        const msg = await dm.messages.fetch(feed.dmMessageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed], components: [row] });
          await NotificationFeed.updateOne({ userId }, { updatedAt: new Date() });
          return true;
        }
      } catch (_) { /* message supprimé ou inaccessible — on en renvoie un nouveau plus bas */ }
    }

    // Sinon envoie un nouveau message DM et mémorise son ID
    const sent = await user.send({ embeds: [embed], components: [row] }).catch(() => null);
    if (!sent) return false;

    await NotificationFeed.findOneAndUpdate(
      { userId },
      { userId, dmChannelId: sent.channelId, dmMessageId: sent.id, updatedAt: new Date() },
      { upsert: true },
    );
    return true;
  } catch (err) {
    console.error('updateUserFeed:', err.message);
    return false;
  }
}

// ─── Envoyer une notification à tous les abonnés d'un type ───────────────────
const CONFIG_FIELD_BY_TYPE = {
  freeGames: 'freeGamesEnabled',
  bumps:     'bumpsEnabled',
  giveaways: 'giveawaysEnabled',
  events:    'eventsEnabled',
  streams:   'streamsEnabled',
  raids:     'raidsEnabled',
  members:   'membersEnabled',
  news:      'newsEnabled',
  modmail:   'modmailEnabled',
};

async function sendNotification(client, guildId, type, embed, title) {
  try {
    const config = await NotificationConfig.findOne({ guildId });
    const configField = CONFIG_FIELD_BY_TYPE[type];
    if (configField && config && config[configField] === false) return 0; // type désactivé côté serveur

    const subs = await NotificationSub.find({ guildId, [type]: true }).lean();
    const dmSubs      = subs.filter(s => s.via !== 'mention');
    const mentionSubs = subs.filter(s => s.via === 'mention');
    let sent = 0;

    // ── Abonnés « message privé » ───────────────────────────────────────
    for (const sub of dmSubs) {
      const user = await client.users.fetch(sub.userId).catch(() => null);
      if (!user) continue;
      const ok = await user.send({ embeds: [embed] }).then(() => true).catch(() => false);
      if (ok) sent++;
    }

    // ── Abonnés « mention » ──────────────────────────────────────────────
    // Un seul message qui mentionne tout le monde, dans le salon du panel (ou
    // de logs). Avant, ce choix ne recevait jamais rien : la préférence
    // existait dans l'interface mais aucun message n'était envoyé.
    if (mentionSubs.length) {
      const channelId = config?.panelChannelId || config?.logChannelId || null;
      const guild = client.guilds.cache.get(guildId);
      const ch = channelId
        ? (guild?.channels.cache.get(channelId)
          || await guild?.channels.fetch(channelId).catch(() => null)
          || null)
        : null;

      let reached = 0;
      if (ch?.isTextBased?.()) {
        const ids = mentionSubs.map(s => s.userId);
        const ok = await ch.send({
          content: ids.map(id => `<@${id}>`).join(' '),
          embeds: [embed],
          allowedMentions: { users: ids, parse: [] },
        }).then(() => true).catch(() => false);
        if (ok) reached = ids.length;
      }

      // Aucun salon utilisable : repli en MP plutôt que silence complet.
      if (!reached) {
        for (const sub of mentionSubs) {
          const user = await client.users.fetch(sub.userId).catch(() => null);
          if (!user) continue;
          const ok = await user.send({ embeds: [embed] }).then(() => true).catch(() => false);
          if (ok) reached++;
        }
      }
      sent += reached;
    }

    // ── Historique personnel — une seule écriture groupée ────────────────
    if (subs.length) {
      await NotificationUserLog.insertMany(subs.map(sub => ({
        userId: sub.userId,
        guildId,
        type,
        title,
        description: embed?.data?.description || '',
      }))).catch(() => {});
    }

    // ── Centre de notifications en MP ────────────────────────────────────
    // Une seule requête pour savoir qui a déjà un fil, puis :
    //   • abonné « MP »  → le fil est créé s'il n'existe pas encore, sinon édité ;
    //   • abonné « mention » → son fil existant est rafraîchi, mais on n'ouvre
    //     pas de MP (ce serait contredire son choix de ne pas être dérangé).
    // Ainsi le centre de notifications contient toutes les notifications reçues,
    // même si le membre n'a jamais lancé `/notifications mes-notifications`.
    try {
      const feeds = await NotificationFeed.find({ userId: { $in: subs.map(s => s.userId) } }).lean();
      const withFeed = new Set(feeds.map(f => f.userId));

      for (const sub of subs) {
        const autoCreate = sub.via !== 'mention';
        if (!autoCreate && !withFeed.has(sub.userId)) continue;
        await updateUserFeed(client, sub.userId, { createIfMissing: autoCreate }).catch(() => {});
      }
    } catch (_) { /* le fil n'est qu'un confort */ }

    // Logger la notification
    await NotificationLog.create({ guildId, type, title, sentTo: sent });

    // Log dans le salon de logs si configuré
    if (config?.logChannelId) {
      const guild = client.guilds.cache.get(guildId);
      const logCh = guild?.channels.cache.get(config.logChannelId)
        || await guild?.channels.fetch(config.logChannelId).catch(() => null);
      if (logCh?.isTextBased?.()) {
        await logCh.send({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle(`🔔 Notification envoyée — ${title}`)
            .addFields(
              { name: 'Type',      value: type,           inline: true },
              { name: 'Envoyée à', value: `${sent} utilisateur(s)`, inline: true },
            )
            .setTimestamp()],
        }).catch(() => {});
      }
    }

    // Mettre à jour le panel live
    await updateLivePanel(client, guildId);

    return sent;
  } catch (err) {
    console.error('sendNotification:', err.message);
    return 0;
  }
}

module.exports = {
  buildPanelEmbed,
  buildPanelButtons,
  updateLivePanel,
  sendNotification,
  buildUserFeedEmbed,
  buildUserFeedButtons,
  updateUserFeed,
};
