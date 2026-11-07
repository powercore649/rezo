'use strict';
// commands/news.js — Système d'actualités RSS français — REZO v4

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, ChannelType,
} = require('discord.js');

const { NewsConfig, NewsPosted } = require('../../models/News');
const { SOURCES, fetchSource, fetchAllNews, hashLink, normalizeSubreddit } = require('../../utils/newsFetcher');
const ui = require('../../utils/ui');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ─── Labels des catégories ────────────────────────────────────────────────────
const CATEGORIES = {
  general:  { label: 'Actualités générales', emoji: '🌍', color: 0x1A1A1A },
  gaming:   { label: 'Jeux Vidéo',           emoji: '🎮', color: 0xE8000D },
  tech:     { label: 'Tech & Numérique',     emoji: '💻', color: 0x0066CC },
  esport:   { label: 'Esport',               emoji: '🏆', color: 0xFFD700 },
};

// ─── Helper config ─────────────────────────────────────────────────────────────
async function getConfig(guildId) {
  return NewsConfig.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true }
  );
}

// ─── Construire l'embed d'un article ──────────────────────────────────────────
function buildArticleEmbed(article, config) {
  const embed = new EmbedBuilder()
    .setColor(article.color || COLORS.primary)
    .setAuthor({
      name:    `${article.emoji} ${article.source}`,
      iconURL: article.icon || null,
      url:     article.link || null,
    })
    .setTitle(article.title.slice(0, 256))
    .setURL(article.link || null)
    .setTimestamp(article.date instanceof Date && !isNaN(article.date) ? article.date : new Date());

  if (article.desc) embed.setDescription(article.desc);

  if (config?.showThumbnail && article.image) {
    embed.setThumbnail(article.image);
  }

  const cat = CATEGORIES[article.category] || CATEGORIES.general;
  embed.addFields(
    { name: '📂 Catégorie', value: `${cat.emoji} ${cat.label}`, inline: true },
    { name: '📅 Publié',    value: `<t:${Math.floor((article.date instanceof Date && !isNaN(article.date) ? article.date : new Date()).getTime() / 1000)}:R>`, inline: true },
  );

  const footer = config?.footerText || 'REZO v4 • Actualités';
  embed.setFooter({ text: footer });

  return embed;
}

// ─── Embed de configuration ────────────────────────────────────────────────────
function buildConfigEmbed(config, guild) {
  const ok = v => v ? '🟢' : '🔴';
  const ch = config.channels || {};
  const rl = config.roles    || {};
  const sr = config.sources  || {};

  const channelLines = [
    `🌍 Général : ${ch.general   ? `<#${ch.general}>`   : '*Non défini*'}`,
    `🎮 Gaming  : ${ch.gaming    ? `<#${ch.gaming}>`    : '*Non défini*'}`,
    `💻 Tech    : ${ch.tech      ? `<#${ch.tech}>`      : '*Non défini*'}`,
    `🏆 Esport  : ${ch.esport    ? `<#${ch.esport}>`    : '*Non défini*'}`,
    `📡 Défaut  : ${ch.default   ? `<#${ch.default}>`   : '*Non défini*'}`,
  ].join('\n');

  const sourceLines = Object.entries(SOURCES).map(([key, src]) =>
    `${sr[key] !== false ? '🟢' : '🔴'} ${src.emoji} **${src.name}** *(${src.category})*`
  ).join('\n');

  const rdt = config.reddit || {};
  const redditLine = rdt.enabled
    ? `🟢 ${(rdt.subreddits || []).length} subreddit(s) · catégorie : **${(CATEGORIES[rdt.category] || CATEGORIES.general).label}**`
    : '🔴 Désactivé — `/news reddit`';

  return ui.panelEmbed({
    color: COLORS.info,
    title: '📰 Actualités — configuration',
    subtitle: 'Chaque source publie dans son salon ; Reddit suit exactement le même circuit.',
    thumbnail: guild.iconURL({ dynamic: true }),
    footer: 'Actualités',
    fields: [
      { name: 'Statut',             value: config.enabled ? '🟢 Activé' : '🔴 Désactivé',          inline: true },
      { name: 'Vérification',       value: `Toutes les **${config.interval || 30} min**`,            inline: true },
      { name: 'Thumbnails',         value: config.showThumbnail ? '🟢 Oui' : '🔴 Non',              inline: true },
      { name: '📢 Salons',          value: channelLines,                                             inline: false },
      { name: '📡 Sources actives', value: sourceLines,                                              inline: false },
      { name: '🟠 Reddit',          value: redditLine,                                               inline: false },
    ],
  });
}

// ─── Menu de configuration ─────────────────────────────────────────────────────
function buildConfigMenu(config) {
  const sr = config.sources || {};
  const options = [
    { label: config.enabled ? '🔴 Désactiver les news' : '🟢 Activer les news', value: 'toggle',     description: 'Activer/désactiver le système' },
    { label: config.showThumbnail ? '🖼️ Masquer thumbnails' : '🖼️ Afficher thumbnails', value: 'toggle_thumb', description: 'Images dans les embeds' },
    ...Object.entries(SOURCES).map(([key, src]) => ({
      label:       `${sr[key] !== false ? '🔴 Désactiver' : '🟢 Activer'} ${src.name}`,
      value:       `toggle_src_${key}`,
      description: `Source : ${src.category}`,
    })),
  ];

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('news_config_action')
      .setPlaceholder('⚙️ Configurer...')
      .addOptions(options.slice(0, 25))
  );
}

// ─── Poster les articles dans le bon salon ─────────────────────────────────────
async function postArticles(client, guildId, articles, config) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return 0;

  const ch = config.channels || {};
  const rl = config.roles    || {};
  let posted = 0;

  for (const article of articles) {
    try {
      // Vérifier si déjà posté
      const exists = await NewsPosted.findOne({ guildId, articleId: article.id });
      if (exists) continue;

      // Trouver le bon salon
      const channelId = ch[article.category] || ch.default;
      if (!channelId) continue;

      const channel = guild.channels.cache.get(channelId);
      if (!channel?.isTextBased()) continue;

      const perms = channel.permissionsFor(guild.members.me);
      if (!perms?.has(['SendMessages', 'EmbedLinks'])) continue;

      const embed   = buildArticleEmbed(article, config);
      const roleId  = rl[article.category] || rl.default;
      const mention = roleId ? `<@&${roleId}>` : null;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🔗 Lire l\'article')
          .setStyle(ButtonStyle.Link)
          .setURL(article.link || 'https://www.google.fr')
      );

      await channel.send({
        content:    mention || undefined,
        embeds:     [embed],
        components: [row],
      });

      // Marquer comme posté
      await NewsPosted.create({ guildId, articleId: article.id, source: article.sourceKey });

      // Centre de notifications — abonnés « Actualités »
      try {
        const { sendNotification } = require('../../utils/notificationManager');
        await sendNotification(client, guildId, 'news', embed, `Nouvel article : ${article.title || 'Actualité'}`);
      } catch (err) { console.error('[News] notif:', err.message); }

      posted++;
      // Rate limit protection
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.error(`[News] Post article ${article.id}:`, err.message);
    }
  }

  return posted;
}

// ─── Auto-post pour tous les serveurs ─────────────────────────────────────────
async function autoPostNews(client) {
  try {
    // En mode shardé, chaque processus ne traite que ses serveurs : sinon un
    // shard qui ne voit pas le serveur avance quand même `lastCheck` sans rien
    // poster, et le vrai shard saute le tour au passage suivant.
    const { guildScope } = require('../../core/sharding');
    const configs = await NewsConfig.find(guildScope(client, { enabled: true }));
    let total = 0;

    for (const config of configs) {
      try {
        // Vérifier l'intervalle
        if (config.lastCheck) {
          const elapsed = Date.now() - new Date(config.lastCheck).getTime();
          if (elapsed < (config.interval || 30) * 60 * 1000) continue;
        }

        // Mettre à jour lastCheck
        await NewsConfig.updateOne({ guildId: config.guildId }, { lastCheck: new Date() });

        // Récupérer les articles
        const articles = await fetchAllNews(config.sources || {}, config.reddit || {});
        if (!articles.length) continue;

        // Poster
        const count = await postArticles(client, config.guildId, articles, config);
        if (count > 0) {
          console.log(`📰 [News] ${count} article(s) posté(s) → ${config.guildId}`);
          total += count;
        }
      } catch (err) {
        console.error(`[News] Guild ${config.guildId}:`, err.message);
      }
    }

    return total;
  } catch (err) {
    console.error('[News] autoPostNews:', err.message);
    return 0;
  }
}

// ─── Commande slash ───────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('news')
    .setDescription('📰 Système d\'actualités françaises automatiques')
    .addSubcommand(s => s
      .setName('config')
      .setDescription('⚙️ Configurer le système de news'))
    .addSubcommand(s => s
      .setName('activer')
      .setDescription('🟢 Activer les actualités'))
    .addSubcommand(s => s
      .setName('desactiver')
      .setDescription('🔴 Désactiver les actualités'))
    .addSubcommand(s => s
      .setName('tester')
      .setDescription('🧪 Tester en postant les dernières actualités maintenant'))
    .addSubcommand(s => s
      .setName('dernieres')
      .setDescription('📋 Voir les dernières actualités disponibles')
      .addStringOption(o => o
        .setName('source')
        .setDescription('Source à consulter')
        .addChoices(...Object.entries(SOURCES).map(([k, s]) => ({ name: `${s.emoji} ${s.name}`, value: k })))
      ))
    .addSubcommand(s => s
      .setName('reddit')
      .setDescription('🟠 Gérer les subreddits Reddit publiés avec les actualités')),

  autoPostNews,

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    // ── Guard permission ─────────────────────────────────────────────────
    if (['config','activer','desactiver','tester','reddit'].includes(sub)) {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Vous avez besoin de **Gérer le serveur**.')], ephemeral: true });
      }
    }

    const guild = interaction.guild;

    // ── /news dernieres ───────────────────────────────────────────────────
    if (sub === 'dernieres') {
      await interaction.deferReply({ ephemeral: true });
      const config    = await getConfig(guild.id);
      const sourceKey = interaction.options.getString('source');
      const articles  = sourceKey
        ? await fetchSource(sourceKey)
        : await fetchAllNews(config.sources || {}, config.reddit || {});

      if (!articles.length) {
        return interaction.editReply({ embeds: [errorEmbed('Aucun article', 'Impossible de récupérer les actualités. Réessayez.')] });
      }
      let page      = 0;
      const total   = Math.min(articles.length, 10);

      const navRow = () => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('news_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('news_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
        new ButtonBuilder().setLabel('🔗 Lire').setStyle(ButtonStyle.Link).setURL(articles[page].link || 'https://www.google.fr'),
      );

      const reply = await interaction.editReply({
        embeds:     [buildArticleEmbed(articles[0], config)],
        components: [navRow()],
        fetchReply: true,
      });

      const col = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id && ['news_prev','news_next'].includes(i.customId),
        time: 3 * 60 * 1000,
      });

      col.on('collect', async i => {
        if (i.customId === 'news_prev') page = Math.max(0, page - 1);
        else page = Math.min(total - 1, page + 1);
        await i.update({ embeds: [buildArticleEmbed(articles[page], config)], components: [navRow()] });
      });
      col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

    // ── /news activer ─────────────────────────────────────────────────────
    if (sub === 'activer') {
      await interaction.deferReply({ ephemeral: true });
      const config = await getConfig(guild.id);
      const hasChannel = Object.values(config.channels || {}).some(Boolean);
      if (!hasChannel) {
        return interaction.editReply({ embeds: [errorEmbed('Configuration incomplète', 'Définissez au moins un salon via `/news config` avant d\'activer.')] });
      }
      await NewsConfig.updateOne({ guildId: guild.id }, { enabled: true });
      return interaction.editReply({ embeds: [successEmbed('✅ Actualités activées !', `Les news seront postées automatiquement toutes les **${config.interval} minutes**.`)] });
    }

    // ── /news desactiver ──────────────────────────────────────────────────
    if (sub === 'desactiver') {
      await interaction.deferReply({ ephemeral: true });
      await NewsConfig.updateOne({ guildId: guild.id }, { enabled: false });
      return interaction.editReply({ embeds: [successEmbed('🔴 Actualités désactivées', 'Les posts automatiques sont suspendus.')] });
    }

    // ── /news tester ──────────────────────────────────────────────────────
    if (sub === 'tester') {
      await interaction.deferReply({ ephemeral: true });
      const config = await getConfig(guild.id);
      const hasChannel = Object.values(config.channels || {}).some(Boolean);
      if (!hasChannel) {
        return interaction.editReply({ embeds: [errorEmbed('Aucun salon configuré', 'Configurez d\'abord via `/news config`.')] });
      }

      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🔄 Récupération en cours...').setDescription('Téléchargement des dernières actualités...')] });

      // Reset lastCheck pour forcer le post
      await NewsConfig.updateOne({ guildId: guild.id }, { lastCheck: null });

      const articles = await fetchAllNews(config.sources || {}, config.reddit || {});
      if (!articles.length) {
        return interaction.editReply({ embeds: [errorEmbed('Aucun article', 'Impossible de récupérer les articles. Vérifiez votre connexion.')] });
      }

      const count = await postArticles(client, guild.id, articles, config);
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(count > 0 ? COLORS.success : COLORS.warning)
          .setTitle(count > 0 ? `✅ ${count} article(s) posté(s) !` : '⚠️ Aucun nouvel article')
          .setDescription(count > 0
            ? `Les actualités ont été postées dans les salons configurés.`
            : `Tous les articles récents ont déjà été postés. (Anti-doublon actif)`)
          .setTimestamp()],
      });
    }

    // ── /news reddit ──────────────────────────────────────────────────────
    // Les subreddits suivis alimentent le MÊME flux que les articles RSS :
    // salon par catégorie, anti-doublon et notifications inclus.
    if (sub === 'reddit') {
      await interaction.deferReply({ ephemeral: true });
      let config = await getConfig(guild.id);

      // Anciens suivis Reddit (l'ancien planificateur a été retiré) : proposés
      // à l'import pour ne rien perdre de l'existant.
      let legacySubs = [];
      try {
        const RedditWatch = require('../../models/RedditWatch');
        const legacy = await RedditWatch.find({ guildId: guild.id, enabled: true }).lean();
        legacySubs = legacy.map(w => normalizeSubreddit(w.subreddit)).filter(Boolean);
      } catch (_) { legacySubs = []; }

      const subs = () => config.reddit?.subreddits || [];
      const importable = () => [...new Set(legacySubs.filter(s => !subs().includes(s)))].slice(0, 5);
      const categoryLabel = () => (CATEGORIES[config.reddit?.category] || CATEGORIES.general).label;
      const credentialsOk = () => Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);

      const buildEmbed = () => ui.panelEmbed({
        color: 0xFF4500,
        title: '🟠 Reddit — fusionné aux actualités',
        subtitle: 'Mêmes salons, même anti-doublon et mêmes notifications que les articles RSS.',
        footer: 'Actualités · Reddit',
        fields: [
          { name: 'Statut',       value: config.reddit?.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
          { name: 'Identifiants', value: credentialsOk() ? '🟢 OK' : '🔴 Manquants',              inline: true },
          { name: 'Catégorie',    value: categoryLabel(),                                        inline: true },
          {
            name: 'Subreddits suivis',
            value: subs().length ? subs().map(s => `• r/${s}`).join('\n').slice(0, 1024) : '*Aucun — ajoutez-en un ci-dessous.*',
            inline: false,
          },
        ],
      });

      const buildComponents = () => {
        const rows = [];
        const buttons = [
          new ButtonBuilder()
            .setCustomId('news_reddit_toggle')
            .setLabel(config.reddit?.enabled ? 'Désactiver' : 'Activer')
            .setStyle(config.reddit?.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('news_reddit_add')
            .setLabel('Ajouter un subreddit')
            .setStyle(ButtonStyle.Primary),
        ];
        if (importable().length && subs().length < 5) {
          buttons.push(new ButtonBuilder()
            .setCustomId('news_reddit_import')
            .setLabel(`Importer ${importable().length} suivi(s) existant(s)`)
            .setStyle(ButtonStyle.Secondary));
        }
        rows.push(new ActionRowBuilder().addComponents(buttons));

        if (subs().length) {
          rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('news_reddit_remove')
              .setPlaceholder('🗑️ Retirer un subreddit...')
              .addOptions(subs().slice(0, 25).map(s => ({ label: `r/${s}`, value: s }))),
          ));
        }

        rows.push(new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('news_reddit_category')
            .setPlaceholder('📂 Catégorie de destination...')
            .addOptions(Object.entries(CATEGORIES).map(([value, c]) => ({
              label: `${c.emoji} ${c.label}`,
              value,
              default: (config.reddit?.category || 'general') === value,
            }))),
        ));

        return rows;
      };

      const reply = await interaction.editReply({
        embeds: buildEmbed(), components: buildComponents(), fetchReply: true,
      });

      const refresh = () => interaction.editReply({ embeds: [buildEmbed()], components: buildComponents() }).catch(() => {});

      const col = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time: 10 * 60 * 1000,
      });

      col.on('collect', async i => {
        try {
          // ── Activer / désactiver la source Reddit ──────────────────────
          if (i.customId === 'news_reddit_toggle') {
            await i.deferUpdate();
            const enabled = !config.reddit?.enabled;

            if (enabled && !subs().length) {
              return i.followUp({ embeds: [errorEmbed('Aucun subreddit', 'Ajoutez au moins un subreddit avant d\'activer Reddit.')], ephemeral: true });
            }
            if (enabled && !credentialsOk()) {
              return i.followUp({ embeds: [errorEmbed('Identifiants manquants', 'Ajoutez `REDDIT_CLIENT_ID` et `REDDIT_CLIENT_SECRET` dans le `.env` du bot, puis redémarrez.')], ephemeral: true });
            }

            await NewsConfig.updateOne({ guildId: guild.id }, { $set: { 'reddit.enabled': enabled } });
            config = await getConfig(guild.id);
            return i.editReply({ embeds: [buildEmbed()], components: buildComponents() });
          }

          // ── Ajouter un subreddit (modal + vérification) ────────────────
          if (i.customId === 'news_reddit_add') {
            const modal = new ModalBuilder().setCustomId('news_reddit_modal').setTitle('Ajouter un subreddit');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('name')
                .setLabel('Subreddit')
                .setPlaceholder('ex: jeuxvideo, r/jeuxvideo ou reddit.com/r/jeuxvideo')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(120),
            ));
            await i.showModal(modal);
            const submitted = await i.awaitModalSubmit({
              filter: m => m.customId === 'news_reddit_modal' && m.user.id === i.user.id,
              time: 120_000,
            }).catch(() => null);
            if (!submitted) return;

            await submitted.deferReply({ ephemeral: true });
            const sub = normalizeSubreddit(submitted.fields.getTextInputValue('name'));
            if (!sub) {
              return submitted.editReply({ embeds: [errorEmbed('Nom invalide', 'Exemple : `jeuxvideo`, `r/jeuxvideo` ou `https://reddit.com/r/jeuxvideo`.')] });
            }
            if (subs().includes(sub)) {
              return submitted.editReply({ embeds: [errorEmbed('Déjà suivi', `r/${sub} figure déjà dans la liste.`)] });
            }
            if (subs().length >= 5) {
              return submitted.editReply({ embeds: [errorEmbed('Limite atteinte', 'Cinq subreddits maximum par serveur.')] });
            }

            const { checkSubredditExists } = require('../../utils/redditWatcher');
            const check = await checkSubredditExists(sub).catch(err => ({ ok: false, reason: err.message }));
            if (!check.ok) {
              return submitted.editReply({ embeds: [errorEmbed('Subreddit inaccessible', check.reason)] });
            }

            await NewsConfig.updateOne({ guildId: guild.id }, { $push: { 'reddit.subreddits': sub } });
            config = await getConfig(guild.id);
            await submitted.editReply({ embeds: [successEmbed('Subreddit ajouté', `r/${sub} sera publié avec les actualités (catégorie **${categoryLabel()}**).`)] });
            return refresh();
          }

          // ── Importer les anciens suivis Reddit ─────────────────────────
          if (i.customId === 'news_reddit_import') {
            await i.deferUpdate();
            const merged = [...new Set([...subs(), ...importable()])].slice(0, 5);
            await NewsConfig.updateOne({ guildId: guild.id }, { $set: { 'reddit.subreddits': merged } });
            config = await getConfig(guild.id);
            return i.editReply({ embeds: [buildEmbed()], components: buildComponents() });
          }

          // ── Retirer un subreddit ───────────────────────────────────────
          if (i.customId === 'news_reddit_remove') {
            await i.deferUpdate();
            await NewsConfig.updateOne({ guildId: guild.id }, { $pull: { 'reddit.subreddits': i.values[0] } });
            config = await getConfig(guild.id);
            return i.editReply({ embeds: [buildEmbed()], components: buildComponents() });
          }

          // ── Catégorie de destination (salon + libellé) ─────────────────
          if (i.customId === 'news_reddit_category') {
            await i.deferUpdate();
            await NewsConfig.updateOne({ guildId: guild.id }, { $set: { 'reddit.category': i.values[0] } });
            config = await getConfig(guild.id);
            return i.editReply({ embeds: [buildEmbed()], components: buildComponents() });
          }
        } catch (err) {
          console.error('[News] panel reddit:', err.message);
          const payload = { embeds: [errorEmbed('Erreur', 'Action impossible pour le moment.')], ephemeral: true };
          if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
          else await i.reply(payload).catch(() => {});
        }
      });

      col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

    // ── /news config ──────────────────────────────────────────────────────
    if (sub === 'config') {
      await interaction.deferReply({ ephemeral: true });
      let config = await getConfig(guild.id);

      const buildComponents = () => [
        buildConfigMenu(config),
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('news_ch_general')
            .setPlaceholder('🌍 Salon — Actualités générales')
            .setChannelTypes(ChannelType.GuildText)
        ),
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('news_ch_gaming')
            .setPlaceholder('🎮 Salon — Jeux Vidéo')
            .setChannelTypes(ChannelType.GuildText)
        ),
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('news_ch_tech')
            .setPlaceholder('💻 Salon — Tech')
            .setChannelTypes(ChannelType.GuildText)
        ),
        new ActionRowBuilder().addComponents(
          new ChannelSelectMenuBuilder()
            .setCustomId('news_ch_default')
            .setPlaceholder('📡 Salon par défaut (toutes catégories)')
            .setChannelTypes(ChannelType.GuildText)
        ),
      ];

      const reply = await interaction.editReply({
        embeds:     [buildConfigEmbed(config, guild)],
        components: buildComponents(),
        fetchReply: true,
      });

      const col = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time:   10 * 60 * 1000,
      });

      col.on('collect', async i => {
        await i.deferUpdate();
        const cid = i.customId;
        const update = {};

        // Salons
        if (cid === 'news_ch_general') update['channels.general'] = i.values[0];
        if (cid === 'news_ch_gaming')  update['channels.gaming']  = i.values[0];
        if (cid === 'news_ch_tech')    update['channels.tech']    = i.values[0];
        if (cid === 'news_ch_default') update['channels.default'] = i.values[0];

        // Actions menu
        if (cid === 'news_config_action') {
          const action = i.values[0];
          if (action === 'toggle')       update.enabled      = !config.enabled;
          if (action === 'toggle_thumb') update.showThumbnail = !config.showThumbnail;
          if (action.startsWith('toggle_src_')) {
            const key = action.replace('toggle_src_', '');
            update[`sources.${key}`] = config.sources?.[key] === false ? true : false;
          }
        }

        if (Object.keys(update).length) {
          await NewsConfig.updateOne({ guildId: guild.id }, { $set: update });
          config = await getConfig(guild.id);
        }

        await i.editReply({ embeds: [buildConfigEmbed(config, guild)], components: buildComponents() });
      });

      col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }
  },
};
