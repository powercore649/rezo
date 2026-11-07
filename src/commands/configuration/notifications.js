'use strict';
// commands/notifications.js — Panel de notifications configurable en temps réel

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const { NotificationSub, NotificationLog, NotificationConfig, NotificationUserLog } = require('../../models/Notification');
const {
  buildPanelEmbed, buildPanelButtons, updateLivePanel,
  buildUserFeedEmbed, buildUserFeedButtons, updateUserFeed,
} = require('../../utils/notificationManager');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');
const licenseGate = require('../../utils/licenseGate');

// ─── Config embed ─────────────────────────────────────────────────────────────
function buildConfigEmbed(config, guild) {
  const ok = v => v ? '🟢' : '🔴';
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🔔 Configuration — Notifications')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .addFields(
      { name: 'Panel live',          value: config.panelChannelId ? `<#${config.panelChannelId}>` : '❌ *Non défini*',  inline: true },
      { name: 'Logs',                value: config.logChannelId   ? `<#${config.logChannelId}>` : '❌ *Non défini*',    inline: true },
      { name: '\u200b',              value: '\u200b',                                                                   inline: true },
      { name: `${ok(config.freeGamesEnabled)} Jeux gratuits`, value: config.freeGamesEnabled ? 'Activé' : 'Désactivé', inline: true },
      { name: `${ok(config.bumpsEnabled)} Bumps`,             value: config.bumpsEnabled ? 'Activé' : 'Désactivé',     inline: true },
      { name: `${ok(config.giveawaysEnabled)} Giveaways`,     value: config.giveawaysEnabled ? 'Activé' : 'Désactivé', inline: true },
      { name: `${ok(config.eventsEnabled)} Événements`,       value: config.eventsEnabled ? 'Activé' : 'Désactivé',    inline: true },
      { name: `${ok(config.streamsEnabled)} Streams`,         value: config.streamsEnabled ? 'Activé' : 'Désactivé',  inline: true },
      { name: `${ok(config.raidsEnabled)} Raids & sécurité`,  value: config.raidsEnabled   ? 'Activé' : 'Désactivé',  inline: true },
      { name: `${ok(config.membersEnabled)} Nouveaux membres`,value: config.membersEnabled ? 'Activé' : 'Désactivé',  inline: true },
      { name: `${ok(config.newsEnabled)} Actualités`,         value: config.newsEnabled    ? 'Activé' : 'Désactivé',  inline: true },
      { name: `${ok(config.modmailEnabled)} ModMail`,         value: config.modmailEnabled ? 'Activé' : 'Désactivé',  inline: true },
    )
    .setFooter({ text: 'Configurez le panel via le menu ci-dessous' })
    .setTimestamp();
}

function buildConfigComponents(config) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('notif_config_action')
    .setPlaceholder('⚙️ Configurer...')
    .addOptions([
      { label: `${config.freeGamesEnabled ? '🔴 Désactiver' : '🟢 Activer'} jeux gratuits`, value: 'toggle_fg'        },
      { label: `${config.bumpsEnabled     ? '🔴 Désactiver' : '🟢 Activer'} bumps`,          value: 'toggle_bumps'     },
      { label: `${config.giveawaysEnabled ? '🔴 Désactiver' : '🟢 Activer'} giveaways`,      value: 'toggle_giveaways' },
      { label: `${config.eventsEnabled    ? '🔴 Désactiver' : '🟢 Activer'} événements`,     value: 'toggle_events'    },
      { label: `${config.streamsEnabled   ? '🔴 Désactiver' : '🟢 Activer'} streams`,        value: 'toggle_streams'   },
      { label: `${config.raidsEnabled     ? '🔴 Désactiver' : '🟢 Activer'} raids`,          value: 'toggle_raids'     },
      { label: `${config.membersEnabled   ? '🔴 Désactiver' : '🟢 Activer'} membres`,        value: 'toggle_members'   },
      { label: `${config.newsEnabled      ? '🔴 Désactiver' : '🟢 Activer'} actualités`,      value: 'toggle_news'      },
      { label: `${config.modmailEnabled   ? '🔴 Désactiver' : '🟢 Activer'} modmail`,         value: 'toggle_modmail'   },
      { label: '📢 Créer/Actualiser le panel live',                                           value: 'create_panel'     },
      { label: '🗑️ Supprimer le panel live',                                                  value: 'delete_panel'     },
    ]);

  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('notif_set_panel_channel')
        .setPlaceholder('📢 Salon du panel live...')
        .setChannelTypes(ChannelType.GuildText)
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('notif_set_log_channel')
        .setPlaceholder('📋 Salon de logs...')
        .setChannelTypes(ChannelType.GuildText)
    ),
  ];
}

// ─── Embed des préférences utilisateur ───────────────────────────────────────
function buildPrefsEmbed(sub) {
  const ok = v => v ? '🟢 Activé' : '🔴 Désactivé';
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⚙️ Mes préférences de notification')
    .addFields(
      { name: '🎮 Jeux gratuits', value: ok(sub?.freeGames ?? true),  inline: true },
      { name: '🎉 Giveaways',     value: ok(sub?.giveaways ?? true),  inline: true },
      { name: '📅 Événements',    value: ok(sub?.events    ?? true),  inline: true },
      { name: '🚀 Bumps',         value: ok(sub?.bumps     ?? false), inline: true },
      { name: '📺 Streams',       value: ok(sub?.streams   ?? false), inline: true },
      { name: '🚨 Raids',         value: ok(sub?.raids     ?? true),  inline: true },
      { name: '👥 Membres',       value: ok(sub?.members   ?? false), inline: true },
      { name: '📰 Actualités',    value: ok(sub?.news      ?? false), inline: true },
      { name: '📬 ModMail',       value: ok(sub?.modmail   ?? false), inline: true },
      { name: '📬 Via',           value: sub?.via === 'dm' ? '📩 Message privé' : '💬 Mention', inline: true },
    )
    .setFooter({ text: 'Utilisez les boutons pour modifier vos préférences' });
}

function buildPrefsComponents(sub) {
  const mk = (id, label, active) => new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(active ? ButtonStyle.Success : ButtonStyle.Secondary);

  // 5 boutons maximum par ligne (limite Discord) : 11 boutons → 3 lignes.
  return [
    new ActionRowBuilder().addComponents(
      mk('notif_pref_fg',       '🎮 Jeux gratuits', sub?.freeGames ?? true),
      mk('notif_pref_gw',       '🎉 Giveaways',     sub?.giveaways ?? true),
      mk('notif_pref_ev',       '📅 Événements',    sub?.events    ?? true),
      mk('notif_pref_bump',     '🚀 Bumps',         sub?.bumps     ?? false),
      mk('notif_pref_st',       '📺 Streams',       sub?.streams   ?? false),
    ),
    new ActionRowBuilder().addComponents(
      mk('notif_pref_raid',     '🚨 Raids',         sub?.raids     ?? true),
      mk('notif_pref_mem',      '👥 Membres',       sub?.members   ?? false),
      mk('notif_pref_news',     '📰 Actualités',    sub?.news      ?? false),
      mk('notif_pref_mm',       '📬 ModMail',       sub?.modmail   ?? false),
      new ButtonBuilder()
        .setCustomId('notif_pref_via')
        .setLabel(sub?.via === 'dm' ? '📩 Via DM' : '💬 Via Mention')
        .setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('notif_unsub_all')
        .setLabel('🔕 Tout désactiver')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ─── Préférences : traitement unique des boutons ─────────────────────────────
// Ces boutons étaient traités deux fois : par un collecteur local (dans
// /notifications preferences et « Mes préférences ») ET par handleButton via
// interactionCreate. Le second acquittement échouait (« Interaction has already
// been acknowledged ») et le clic restait sans effet. Tout passe désormais ici.
const PREF_FIELDS = {
  notif_pref_fg:   'freeGames',
  notif_pref_gw:   'giveaways',
  notif_pref_ev:   'events',
  notif_pref_bump: 'bumps',
  notif_pref_st:   'streams',
  notif_pref_raid: 'raids',
  notif_pref_mem:  'members',
  notif_pref_news: 'news',
  notif_pref_mm:   'modmail',
};

const PREF_BUTTON_IDS = [...Object.keys(PREF_FIELDS), 'notif_pref_via', 'notif_unsub_all'];

async function applyPrefButton(interaction, client) {
  const guildId = interaction.guildId;
  let sub = await NotificationSub.findOne({ userId: interaction.user.id, guildId });
  if (!sub) sub = await NotificationSub.create({ userId: interaction.user.id, guildId });

  const update = {};
  const field = PREF_FIELDS[interaction.customId];
  if (field) update[field] = !sub[field];

  if (interaction.customId === 'notif_pref_via') {
    update.via = sub.via === 'dm' ? 'mention' : 'dm';
    // Basculer en « mention » sans aucun salon où écrire ne servirait à rien.
    if (update.via === 'mention') {
      const cfg = await NotificationConfig.findOne({ guildId }).lean().catch(() => null);
      if (!cfg?.panelChannelId && !cfg?.logChannelId) {
        return interaction.reply({
          embeds: [errorEmbed(
            'Aucun salon de mention',
            'Définis d’abord le salon du panel live (ou de logs) dans `/notifications config` : les notifications « mention » y seront publiées. Changement annulé.',
          )],
          ephemeral: true,
        }).catch(() => {});
      }
    }
  }

  if (interaction.customId === 'notif_unsub_all') {
    update.freeGames = false;
    update.giveaways = false;
    update.events    = false;
    update.bumps     = false;
    update.streams   = false;
    update.raids     = false;
    update.members   = false;
    update.news      = false;
    update.modmail   = false;
  }

  const updated = await NotificationSub.findOneAndUpdate(
    { userId: interaction.user.id, guildId },
    { $set: update },
    { new: true },
  );

  // Les compteurs d’abonnés du panel changent avec ces bascules.
  await updateLivePanel(client, guildId).catch(() => {});

  // `update()` rafraîchit le message cliqué, éphémère compris : que le clic
  // vienne de la commande ou du panel, la même logique s’applique.
  return interaction.update({
    embeds: [buildPrefsEmbed(updated)],
    components: buildPrefsComponents(updated),
  }).catch(() => {});
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('notifications')
    .setDescription('🔔 Gérer les notifications du serveur')
    .addSubcommand(s => s
      .setName('config')
      .setDescription('⚙️ Configurer le panel de notifications (Admin)')
)
    .addSubcommand(s => s
      .setName('abonner')
      .setDescription('🔔 S\'abonner aux notifications'))
    .addSubcommand(s => s
      .setName('desabonner')
      .setDescription('🔕 Se désabonner de toutes les notifications'))
    .addSubcommand(s => s
      .setName('preferences')
      .setDescription('⚙️ Gérer mes préférences de notification'))
    .addSubcommand(s => s
      .setName('liste')
      .setDescription('📋 Voir les dernières notifications envoyées'))
    .addSubcommand(s => s
      .setName('mes-notifications')
      .setDescription('📡 Voir mes notifications en temps réel')
),

  async execute(interaction, client) {
    const sub   = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // ── /notifications config ─────────────────────────────────────────────
    if (sub === 'config') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Vous avez besoin de la permission **Gérer le serveur**.')], ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });

      let config = await NotificationConfig.findOneAndUpdate(
        { guildId: guild.id },
        { $setOnInsert: { guildId: guild.id } },
        { upsert: true, new: true }
      );

      const reply = await interaction.editReply({
        embeds:     [buildConfigEmbed(config, guild)],
        components: buildConfigComponents(config),
        fetchReply: true,
      });

      const col = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time:   10 * 60 * 1000,
      });

      col.on('collect', async i => {
        const cid = i.customId;

        // ── Salon panel ───────────────────────────────────────────────────
        if (cid === 'notif_set_panel_channel') {
          await i.deferUpdate();
          config = await NotificationConfig.findOneAndUpdate(
            { guildId: guild.id },
            { panelChannelId: i.values[0], panelMessageId: null },
            { new: true }
          );
          await i.editReply({ embeds: [buildConfigEmbed(config, guild)], components: buildConfigComponents(config) });
          return;
        }

        // ── Salon logs ────────────────────────────────────────────────────
        if (cid === 'notif_set_log_channel') {
          await i.deferUpdate();
          config = await NotificationConfig.findOneAndUpdate(
            { guildId: guild.id },
            { logChannelId: i.values[0] },
            { new: true }
          );
          await i.editReply({ embeds: [buildConfigEmbed(config, guild)], components: buildConfigComponents(config) });
          return;
        }

        // ── Actions menu ──────────────────────────────────────────────────
        if (cid === 'notif_config_action') {
          const action = i.values[0];
          const update = {};

          if (action === 'toggle_fg')        update.freeGamesEnabled = !config.freeGamesEnabled;
          if (action === 'toggle_bumps')     update.bumpsEnabled     = !config.bumpsEnabled;
          if (action === 'toggle_giveaways') update.giveawaysEnabled = !config.giveawaysEnabled;
          if (action === 'toggle_events')    update.eventsEnabled    = !config.eventsEnabled;
          if (action === 'toggle_streams')   update.streamsEnabled   = !config.streamsEnabled;
          if (action === 'toggle_raids')     update.raidsEnabled     = !config.raidsEnabled;
          if (action === 'toggle_members')   update.membersEnabled   = !config.membersEnabled;
          if (action === 'toggle_news')      update.newsEnabled      = !config.newsEnabled;
          if (action === 'toggle_modmail')   update.modmailEnabled   = !config.modmailEnabled;

          if (action === 'create_panel') {
            await i.deferUpdate();
            if (!config.panelChannelId) {
              await i.followUp({ content: '❌ Définissez d\'abord un salon pour le panel.', ephemeral: true });
              return;
            }
            const ch = guild.channels.cache.get(config.panelChannelId);
            if (!ch) { await i.followUp({ content: '❌ Salon introuvable.', ephemeral: true }); return; }

            const panelEmbed = await buildPanelEmbed(guild, config);
            const panelRow   = buildPanelButtons();

            // Réutiliser le panel existant au lieu d’en poster un deuxième :
            // plusieurs clics sur « Créer/Actualiser » empilaient les panels.
            let msg = config.panelMessageId
              ? await ch.messages.fetch(config.panelMessageId).catch(() => null)
              : null;
            const reused = Boolean(msg);
            if (msg) {
              await msg.edit({ embeds: [panelEmbed], components: [panelRow] }).catch(() => { msg = null; });
            }
            if (!msg) {
              msg = await ch.send({ embeds: [panelEmbed], components: [panelRow] }).catch(() => null);
            }

            if (msg) {
              config = await NotificationConfig.findOneAndUpdate(
                { guildId: guild.id },
                { panelMessageId: msg.id },
                { new: true }
              );
              await i.followUp({
                content: `✅ Panel ${reused ? 'actualisé' : 'créé'} dans <#${ch.id}> !`,
                ephemeral: true,
              });
            }
            await i.editReply({ embeds: [buildConfigEmbed(config, guild)], components: buildConfigComponents(config) });
            return;
          }

          if (action === 'delete_panel') {
            await i.deferUpdate();
            if (config.panelChannelId && config.panelMessageId) {
              const ch = guild.channels.cache.get(config.panelChannelId);
              if (ch) {
                const msg = await ch.messages.fetch(config.panelMessageId).catch(() => null);
                await msg?.delete().catch(() => {});
              }
            }
            config = await NotificationConfig.findOneAndUpdate(
              { guildId: guild.id },
              { panelMessageId: null },
              { new: true }
            );
            await i.editReply({ embeds: [buildConfigEmbed(config, guild)], components: buildConfigComponents(config) });
            return;
          }

          // Toggles
          if (Object.keys(update).length > 0) {
            await i.deferUpdate();
            config = await NotificationConfig.findOneAndUpdate(
              { guildId: guild.id },
              { $set: update },
              { new: true }
            );
            // Le panel live reflète immédiatement le type désactivé.
            await updateLivePanel(client, guild.id).catch(() => {});
            await i.editReply({ embeds: [buildConfigEmbed(config, guild)], components: buildConfigComponents(config) });
          }
          return;
        }
      });

      col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

    // ── /notifications abonner ────────────────────────────────────────────
    if (sub === 'abonner') {
      await interaction.deferReply({ ephemeral: true });

      const existing = await NotificationSub.findOne({ userId: interaction.user.id, guildId: guild.id });
      if (existing) {
        return interaction.editReply({ embeds: [errorEmbed('Déjà abonné', 'Vous êtes déjà abonné aux notifications de ce serveur.\nUtilisez `/notifications preferences` pour les modifier.')] });
      }

      await NotificationSub.create({ userId: interaction.user.id, guildId: guild.id });
      await updateLivePanel(client, guild.id);

      return interaction.editReply({
        embeds: [successEmbed('🔔 Abonnement activé !', 'Vous recevrez les notifications par DM.\nUtilisez `/notifications preferences` pour personnaliser ce que vous recevez.')],
      });
    }

    // ── /notifications desabonner ─────────────────────────────────────────
    if (sub === 'desabonner') {
      await interaction.deferReply({ ephemeral: true });
      const deleted = await NotificationSub.findOneAndDelete({ userId: interaction.user.id, guildId: guild.id });
      await updateLivePanel(client, guild.id);

      if (!deleted) return interaction.editReply({ embeds: [errorEmbed('Non abonné', 'Vous n\'étiez pas abonné aux notifications de ce serveur.')] });
      return interaction.editReply({ embeds: [successEmbed('🔕 Désabonnement effectué', 'Vous ne recevrez plus de notifications de ce serveur.')] });
    }

    // ── /notifications preferences ────────────────────────────────────────
    if (sub === 'preferences') {
      await interaction.deferReply({ ephemeral: true });

      let sub_ = await NotificationSub.findOne({ userId: interaction.user.id, guildId: guild.id });
      if (!sub_) {
        sub_ = await NotificationSub.create({ userId: interaction.user.id, guildId: guild.id });
      }

      // Les boutons sont traités par handleButton (interactionCreate) : un
      // collecteur ici acquitterait le même clic une seconde fois.
      await interaction.editReply({
        embeds:     [buildPrefsEmbed(sub_)],
        components: buildPrefsComponents(sub_),
      });
      return;
    }

    // ── /notifications liste ──────────────────────────────────────────────
    if (sub === 'liste') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Vous avez besoin de la permission **Gérer le serveur**.')], ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });

      const logs = await NotificationLog.find({ guildId: guild.id })
        .sort({ sentAt: -1 })
        .limit(10)
        .lean();

      if (!logs.length) {
        return interaction.editReply({ embeds: [errorEmbed('Aucune notification', 'Aucune notification n\'a encore été envoyée sur ce serveur.')] });
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('📋 Dernières notifications')
        .setDescription(logs.map((l, i) => {
          const ts = Math.floor(new Date(l.sentAt).getTime() / 1000);
          return `**${i + 1}.** <t:${ts}:R> — \`${l.type}\` **${l.title}** *(${l.sentTo} envoyée(s))*`;
        }).join('\n'))
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /notifications mes-notifications ───────────────────────────────────
    if (sub === 'mes-notifications') {
      await interaction.deferReply({ ephemeral: true });

      // Active (ou réactive) le fil DM en temps réel : chaque future notification
      // éditera ce même message automatiquement, sans que l'utilisateur ait à
      // relancer la commande.
      const feed = await updateUserFeed(client, interaction.user.id, { createIfMissing: true });

      const embed = await buildUserFeedEmbed(client, interaction.user.id);
      const row   = buildUserFeedButtons();

      const dmStatus = feed
        ? '📩 Un fil live a été (ré)activé dans vos messages privés — il se met à jour tout seul à chaque nouvelle notification.'
        : '⚠️ Impossible d\'ouvrir vos DMs (probablement fermés). Voici tout de même votre historique ci-dessous ; activez vos DMs pour le suivi en temps réel.';

      // Boutons traités par handleButton : pas de collecteur concurrent.
      await interaction.editReply({
        content:    dmStatus,
        embeds:     [embed],
        components: [row],
      });
      return;
    }
  },

  // ── Handler boutons publics (panel live) ─────────────────────────────────
  async handleButton(interaction, client) {
    const id = interaction.customId;

    // ── Fil personnel — boutons du DM live ──────────────────────────────
    // Traités avant le contrôle de licence : ils vivent en message privé, sans
    // serveur (interaction.guildId vaut null).
    if (id === 'notif_feed_refresh') {
      const embed = await buildUserFeedEmbed(client, interaction.user.id);
      await interaction.update({ embeds: [embed], components: [buildUserFeedButtons()] }).catch(() => {});
      return;
    }
    if (id === 'notif_feed_read_all') {
      await NotificationUserLog.updateMany({ userId: interaction.user.id, read: false }, { $set: { read: true } });
      const embed = await buildUserFeedEmbed(client, interaction.user.id);
      await interaction.update({ embeds: [embed], components: [buildUserFeedButtons()] }).catch(() => {});
      await updateUserFeed(client, interaction.user.id).catch(() => {}); // synchronise aussi le fil DM
      return;
    }

    // Panneau persistant : la licence est revérifiée à chaque clic.
    if (!(await licenseGate.guardComponent(interaction, 'notifications'))) return;

    const guild = interaction.guild;
    if (!guild) return;

    // ── S'abonner depuis le panel ─────────────────────────────────────────
    if (id === 'notif_subscribe') {
      const existing = await NotificationSub.findOne({ userId: interaction.user.id, guildId: guild.id });
      if (existing) {
        return interaction.reply({
          embeds: [new EmbedBuilder().setColor(COLORS.warning).setDescription('🔔 Vous êtes déjà abonné ! Utilisez `/notifications preferences` pour modifier vos préférences.')],
          ephemeral: true,
        });
      }
      await NotificationSub.create({ userId: interaction.user.id, guildId: guild.id });
      await updateLivePanel(client, guild.id);
      return interaction.reply({
        embeds: [successEmbed('🔔 Abonnement activé !', 'Vous recevrez les notifications par DM.\nUtilisez `/notifications preferences` pour les personnaliser.')],
        ephemeral: true,
      });
    }

    // ── Se désabonner depuis le panel ─────────────────────────────────────
    if (id === 'notif_unsubscribe') {
      const deleted = await NotificationSub.findOneAndDelete({ userId: interaction.user.id, guildId: guild.id });
      await updateLivePanel(client, guild.id);
      if (!deleted) {
        return interaction.reply({ embeds: [errorEmbed('Non abonné', 'Vous n\'étiez pas abonné.')], ephemeral: true });
      }
      return interaction.reply({ embeds: [successEmbed('🔕 Désabonné', 'Vous ne recevrez plus de notifications.')], ephemeral: true });
    }

    // ── Préférences depuis le panel ───────────────────────────────────────
    if (id === 'notif_my_prefs') {
      let sub = await NotificationSub.findOne({ userId: interaction.user.id, guildId: guild.id });
      if (!sub) sub = await NotificationSub.create({ userId: interaction.user.id, guildId: guild.id });

      // Boutons gérés par applyPrefButton : aucun collecteur ici.
      await interaction.reply({
        embeds:     [buildPrefsEmbed(sub)],
        components: buildPrefsComponents(sub),
        ephemeral:  true,
      }).catch(() => {});
      return;
    }

    // ── Préférences (commandes ET panel) — un seul point de traitement ────
    if (PREF_BUTTON_IDS.includes(id)) {
      return applyPrefButton(interaction, client);
    }
  },
};
