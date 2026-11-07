'use strict';
// commands/streamalerts.js — Alertes Twitch (live) & YouTube (nouvelles vidéos)
// Panel de configuration avancé : ajout, édition (salon/rôle/message), suppression, test.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const StreamAlert = require('../../models/StreamAlert');
const twitch       = require('../../utils/twitchFetcher');
const youtube      = require('../../utils/youtubeFetcher');
const social       = require('../../utils/socialFetchers');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const {
  renderTemplate,
  appearanceFromAlert,
  parseColor,
  colorToHex,
  STYLE_LABELS,
  DEFAULT_TWITCH_MESSAGE,
  DEFAULT_YOUTUBE_MESSAGE,
  DEFAULT_SOCIAL_MESSAGE,
  buildTwitchLiveEmbed,
  buildYoutubeVideoEmbed,
  buildSocialPostEmbed,
} = require('../../utils/streamAlertEmbeds');

const PLATFORM_LABEL = {
  twitch:  '🟣 Twitch',
  youtube: '🔴 YouTube',
  rss:     '📰 Flux RSS',
  bluesky: '🦋 Bluesky',
};
const PLATFORM_SHORT = { twitch: 'Twitch', youtube: 'YouTube', rss: 'Flux RSS', bluesky: 'Bluesky' };
const PLATFORM_COLORS = {
  twitch:  0x9146FF,
  youtube: 0xFF0000,
  rss:     0xF26522,
  bluesky: 0x1185FE,
};
const EMBED_VARIABLES = {
  twitch:  '`{title}` `{streamer}` `{game}` `{published}`',
  youtube: '`{title}` `{channel}` `{published}`',
  rss:     '`{title}` `{author}` `{published}`',
  bluesky: '`{title}` `{author}` `{published}`',
};

// Les nouveaux réseaux n'ont besoin d'aucune clé API.
const ADD_BUTTONS = [
  { id: 'sa_add_twitch',  label: 'Ajouter un streamer Twitch', emoji: '🟣', style: ButtonStyle.Secondary },
  { id: 'sa_add_youtube', label: 'Ajouter une chaîne YouTube', emoji: '🔴', style: ButtonStyle.Secondary },
  { id: 'sa_add_rss',     label: 'Ajouter un flux RSS',        emoji: '📰', style: ButtonStyle.Secondary },
  { id: 'sa_add_bluesky', label: 'Ajouter un Bluesky',         emoji: '🦋', style: ButtonStyle.Secondary },
];

function profileUrl(alert) {
  if (alert.platform === 'twitch')  return `https://twitch.tv/${alert.identifier}`;
  if (alert.platform === 'youtube') return `https://www.youtube.com/channel/${alert.identifier}`;
  if (alert.platform === 'bluesky') return `https://bsky.app/profile/${alert.identifier}`;
  return alert.identifier; // flux RSS : l'URL elle-même
}

// Réglages éditables par les boutons « templates » du panneau.
const TEMPLATE_SETTINGS = {
  sa_tpl_title: {
    field: 'titleTemplate', label: 'Titre de l\'embed', title: 'Title Template',
    placeholder: 'ex: {title}', maxLength: 200,
  },
  sa_tpl_desc: {
    field: 'descriptionTemplate', label: 'Description de l\'embed', title: 'Description',
    placeholder: 'ex: {channel} · publié {published}', maxLength: 500,
  },
  sa_tpl_button: {
    field: 'buttonLabel', label: 'Libellé du bouton lien', title: 'Button Label',
    placeholder: 'ex: ▶️ Voir la vidéo — vide = défaut, « - » = aucun bouton', maxLength: 80,
  },
  sa_tpl_header: {
    field: 'headerText', label: 'En-tête de l\'embed', title: 'Header Text',
    placeholder: 'ex: {channel} a publié une vidéo !', maxLength: 200,
  },
  sa_tpl_message: {
    field: 'customMessage', label: 'Message au-dessus de l\'embed (vide = défaut)', title: 'Message',
    placeholder: 'ex: 📺 {channel} · {title}', maxLength: 500,
  },
};

// ════════════════════════════════════════════════════════════════════════════
//  EMBEDS & COMPOSANTS — Vue d'ensemble
// ════════════════════════════════════════════════════════════════════════════
const PLATFORM_EMOJI = { twitch: '🟣', youtube: '🔴', rss: '📰', bluesky: '🦋' };

function buildOverviewEmbed(guild, alerts) {
  const by = (platform) => alerts.filter((a) => a.platform === platform);
  const tw = by('twitch');
  const yt = by('youtube');
  const rss = by('rss');
  const bs = by('bluesky');

  const twStatus = twitch.isConfigured()  ? '🟢 API connectée' : '🔴 Non configurée (Twitch)';
  const ytStatus = youtube.isConfigured() ? '🟢 API connectée' : '🟠 Clé absente — utilisez un flux RSS';

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📡 Panel — Alertes sociales')
    .setDescription(
      'Twitch, YouTube, flux RSS/Atom et Bluesky.\n'
      + '**📰 RSS et 🦋 Bluesky ne demandent aucune clé API.**',
    )
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .addFields(
      { name: '🟣 Twitch',  value: `${twStatus}\n**${tw.length}** suivi(s)`,  inline: true },
      { name: '🔴 YouTube', value: `${ytStatus}\n**${yt.length}** suivi(s)`,  inline: true },
      { name: '📰 Flux RSS', value: `🟢 Sans clé\n**${rss.length}** flux`,      inline: true },
      { name: '🦋 Bluesky',  value: `🟢 Sans clé\n**${bs.length}** profil(s)`,   inline: true },
    );

  const section = (label, list, fmt) => {
    if (!list.length) return;
    embed.addFields({
      name: label,
      value: list.slice(0, 8).map((a) => `${fmt(a)} **${a.displayName || a.identifier}** → <#${a.channelId}>${a.enabled ? '' : ' *(désactivé)*'}`).join('\n').slice(0, 1024),
      inline: false,
    });
  };
  section('🟣 Streamers Twitch', tw, (a) => (a.isLive ? '🔴' : '⚪'));
  section('🔴 Chaînes YouTube', yt, () => '📺');
  section('📰 Flux RSS', rss, () => '📰');
  section('🦋 Profils Bluesky', bs, () => '🦋');

  embed.setFooter({ text: 'REZO • Alertes sociales — Sélectionnez une source ou ajoutez-en une' }).setTimestamp();
  return embed;
}

function buildOverviewComponents(alerts) {
  const rows = [];

  if (alerts.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('sa_manage_select')
      .setPlaceholder('🛠️ Gérer une alerte existante...')
      .addOptions(
        alerts.slice(0, 25).map((a) => ({
          label: `${a.displayName || a.identifier}`.slice(0, 100),
          value: String(a._id),
          description: `${PLATFORM_SHORT[a.platform] || a.platform} • ${a.enabled ? 'Actif' : 'Désactivé'}`.slice(0, 100),
          emoji: PLATFORM_EMOJI[a.platform] || '📡',
        })),
      );
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  rows.push(new ActionRowBuilder().addComponents(
    ...ADD_BUTTONS.map((b) => new ButtonBuilder()
      .setCustomId(b.id)
      .setLabel(b.label)
      .setEmoji(b.emoji)
      .setStyle(b.style)),
    new ButtonBuilder().setCustomId('sa_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Primary),
  ));

  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
//  EMBEDS & COMPOSANTS — Gestion d'une alerte
// ════════════════════════════════════════════════════════════════════════════
function buildManageEmbed(alert) {
  const isTwitch = alert.platform === 'twitch';
  const baseColor = PLATFORM_COLORS[alert.platform] || COLORS.primary;
  const color = parseColor(alert.embedColor, baseColor);
  const hex = colorToHex(color, baseColor);
  const onOff = (v) => (v ? 'On' : 'Off');
  const rel = (date) => (date ? `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>` : '*jamais*');
  const tpl = (value, fallback) => (value ? `\`${String(value).slice(0, 80)}\`` : `*${fallback}*`);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: `${PLATFORM_LABEL[alert.platform] || alert.platform} · Apparence`,
      iconURL: alert.avatarUrl || undefined,
      url: profileUrl(alert),
    })
    .setTitle(`${alert.enabled ? '🔔' : '🔕'} ${(alert.displayName || alert.identifier).slice(0, 70)}`)
    .setDescription(
      `**Post in :** ${alert.channelId ? `<#${alert.channelId}>` : '*non défini*'} · **Ping :** ${alert.roleId ? `<@&${alert.roleId}>` : '*aucun rôle*'}`,
    )
    .addFields(
      { name: 'Style',   value: STYLE_LABELS[alert.embedStyle] || STYLE_LABELS.classic, inline: true },
      { name: 'Couleur', value: `\`${hex}\``,                                           inline: true },
      { name: 'Variables d\'embed', value: EMBED_VARIABLES[alert.platform] || '', inline: false },
      {
        name: 'Réglages',
        value: [
          `Image : **${onOff(alert.showImage)}** · Miniature : **${onOff(alert.showThumbnail)}**`,
          alert.platform === 'youtube'
            ? `Notifications : **${onOff(alert.enabled)}** · Shorts : **${onOff(alert.notifyShorts)}**`
            : `Notifications : **${onOff(alert.enabled)}**`,
        ].join('\n'),
        inline: false,
      },
      {
        name: 'Templates',
        value: [
          `Titre : ${tpl(alert.titleTemplate, 'titre par défaut')}`,
          `En-tête : ${tpl(alert.headerText, 'en-tête par défaut')}`,
          `Description : ${tpl(alert.descriptionTemplate, isTwitch ? 'jeu, viewers, lien' : alert.platform === 'youtube' ? 'description de la vidéo' : 'résumé de la publication')}`,
          `Bouton : ${tpl(alert.buttonLabel, 'libellé par défaut')}`,
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: `Vérifié ${rel(alert.lastCheckedAt)} · Notifié ${rel(alert.lastNotifiedAt)}` });

  if (alert.lastError) embed.addFields({ name: '⚠️ Dernière erreur', value: String(alert.lastError).slice(0, 300), inline: false });

  return embed;
}

function buildManageComponents(alert) {
  const isTwitch = alert.platform === 'twitch';
  const baseColor = PLATFORM_COLORS[alert.platform] || COLORS.primary;
  const hex = colorToHex(parseColor(alert.embedColor, baseColor), baseColor);
  // 1 ─ Salon + couleur
  const rowChannel = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('sa_set_channel_ping')
      .setLabel('Set Channel & Ping')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('sa_color')
      .setLabel(`Color: ${hex}`)
      .setStyle(ButtonStyle.Secondary),
  );

  // 2 ─ Style d'embed
  const rowStyle = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('sa_style')
      .setPlaceholder(STYLE_LABELS[alert.embedStyle] || STYLE_LABELS.classic)
      .addOptions(Object.entries(STYLE_LABELS).map(([value, label]) => ({
        label,
        value,
        default: (alert.embedStyle || 'classic') === value,
        description: value === 'classic' ? 'Embed complet avec image et détails'
          : value === 'compact' ? 'Embed réduit : titre, miniature, bouton'
          : 'Aucun embed — uniquement le message',
      }))),
  );

  // 3 ─ Templates
  const rowTemplates = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sa_tpl_title').setLabel('Title Template').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sa_tpl_desc').setLabel('Description').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sa_tpl_button').setLabel('Button Label').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sa_tpl_header').setLabel('Header Text').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sa_tpl_message').setLabel('Message').setStyle(ButtonStyle.Secondary),
  );

  // 4 ─ Toggles
  const rowToggles = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sa_toggle_image').setLabel(`Image: ${alert.showImage ? 'On' : 'Off'}`).setStyle(alert.showImage ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sa_toggle_thumb').setLabel(`Thumbnail: ${alert.showThumbnail ? 'On' : 'Off'}`).setStyle(alert.showThumbnail ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sa_toggle').setLabel(`Notifications: ${alert.enabled ? 'On' : 'Off'}`).setStyle(alert.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  if (alert.platform === 'youtube') {
    rowToggles.addComponents(
      new ButtonBuilder().setCustomId('sa_toggle_shorts').setLabel(`Shorts: ${alert.notifyShorts ? 'On' : 'Off'}`).setStyle(alert.notifyShorts ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );
  }

  // 5 ─ Navigation
  const rowNav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sa_back').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sa_test').setLabel('Test Preview').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sa_delete').setLabel('Remove').setStyle(ButtonStyle.Danger),
  );

  return [rowChannel, rowStyle, rowTemplates, rowToggles, rowNav];
}

// ════════════════════════════════════════════════════════════════════════════
//  ACTIONS PARTAGÉES (utilisées par la commande ET par les sous-commandes)
// ════════════════════════════════════════════════════════════════════════════

// ─── Ajouter un streamer Twitch en base ───────────────────────────────────────
async function addTwitchAlert({ guildId, login, channelId, roleId = null, customMessage = null, addedBy }) {
  if (!twitch.isConfigured()) {
    throw new Error('Le système Twitch n\'est pas configuré (TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants dans le .env).');
  }
  const users = await twitch.getUsersByLogin([login]);
  const user = users[0];
  if (!user) throw new Error(`Aucun compte Twitch trouvé pour \`${login}\`. Vérifiez l'orthographe.`);

  const alert = await StreamAlert.findOneAndUpdate(
    { guildId, platform: 'twitch', identifier: user.login.toLowerCase() },
    {
      guildId,
      platform:     'twitch',
      identifier:   user.login.toLowerCase(),
      displayName:  user.display_name,
      avatarUrl:    user.profile_image_url,
      channelId,
      roleId,
      customMessage,
      enabled:      true,
      addedBy,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return alert;
}

// ─── Ajouter une chaîne YouTube en base ───────────────────────────────────────
async function addYoutubeAlert({ guildId, input, channelId, roleId = null, customMessage = null, addedBy }) {
  if (!youtube.isConfigured()) {
    throw new Error('Clé `YOUTUBE_API_KEY` absente : ajoutez plutôt le flux RSS de la chaîne (bouton « Ajouter un flux RSS »).');
  }
  const info = await youtube.resolveChannel(input);
  if (!info) throw new Error(`Chaîne YouTube introuvable pour \`${input}\`. Essayez avec l'URL complète ou l'ID (UC...).`);

  // Baseline — on récupère la dernière vidéo pour ne pas spammer l'historique
  let lastVideoId = null;
  try {
    const videos = await youtube.fetchLatestVideos(info.uploadsPlaylistId, 1);
    lastVideoId = videos[0]?.videoId || null;
  } catch (_) { /* pas grave, sera fixé au prochain check */ }

  const alert = await StreamAlert.findOneAndUpdate(
    { guildId, platform: 'youtube', identifier: info.channelId },
    {
      guildId,
      platform:          'youtube',
      identifier:         info.channelId,
      displayName:        info.title,
      avatarUrl:          info.thumbnail,
      uploadsPlaylistId:  info.uploadsPlaylistId,
      lastVideoId,
      channelId,
      roleId,
      customMessage,
      enabled: true,
      addedBy,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return alert;
}

// ─── Ajouter un flux RSS/Atom (aucune clé API) ───────────────────────────────
async function addRssAlert({ guildId, input, channelId, roleId = null, customMessage = null, addedBy }) {
  const feed = await social.fetchRssFeed(input);
  if (!feed.items.length) throw new Error('Ce flux ne contient aucune publication pour le moment.');

  return StreamAlert.findOneAndUpdate(
    { guildId, platform: 'rss', identifier: feed.url },
    {
      guildId,
      platform:      'rss',
      identifier:    feed.url,
      displayName:   feed.title || null,
      avatarUrl:     feed.image || null,
      channelId,
      roleId,
      customMessage,
      enabled:       true,
      addedBy,
      lastPostId:    feed.items[0].id,
      lastPostAt:    feed.items[0].publishedAt || new Date(),
      lastCheckedAt: new Date(),
      lastError:     null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

// ─── Ajouter un profil Bluesky (API publique, sans compte) ───────────────────
async function addBlueskyAlert({ guildId, input, channelId, roleId = null, customMessage = null, addedBy }) {
  const profile = await social.resolveBlueskyProfile(input);
  const feed = await social.fetchBlueskyFeed(profile.handle, { limit: 5 }).catch(() => ({ items: [] }));
  const latest = feed.items[0] || null;

  return StreamAlert.findOneAndUpdate(
    { guildId, platform: 'bluesky', identifier: profile.did },
    {
      guildId,
      platform:      'bluesky',
      identifier:    profile.did,
      displayName:   profile.displayName || profile.handle,
      avatarUrl:     profile.avatar || null,
      channelId,
      roleId,
      customMessage,
      enabled:       true,
      addedBy,
      lastPostId:    latest?.id || null,
      lastPostAt:    latest?.publishedAt || null,
      lastCheckedAt: new Date(),
      lastError:     null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

// ─── Envoyer un post de test pour une alerte donnée ───────────────────────────
async function sendTestAlert(alert, targetChannel) {
  if (alert.platform === 'twitch') {
    let stream = null;
    try {
      const streams = await twitch.getStreamsByLogin([alert.identifier]);
      stream = streams[0] || null;
    } catch (_) {}

    const { embed, row, url } = buildTwitchLiveEmbed({
      login:        alert.identifier,
      displayName:  alert.displayName || alert.identifier,
      avatarUrl:    alert.avatarUrl,
      title:        stream?.title || 'Exemple de titre de stream',
      gameName:     stream?.game_name || 'Just Chatting',
      thumbnailUrl: stream?.thumbnail_url || null,
      viewerCount:  stream?.viewer_count ?? 0,
      startedAt:    stream?.started_at || new Date(),
    }, appearanceFromAlert(alert));

    const mention  = alert.roleId ? `<@&${alert.roleId}> ` : '';
    const template = alert.customMessage?.trim() || DEFAULT_TWITCH_MESSAGE;
    const content  = `🧪 **[TEST]** ${mention}` + renderTemplate(template, {
      streamer: alert.displayName || alert.identifier,
      titre:    stream?.title || 'Exemple de titre de stream',
      jeu:      stream?.game_name || 'Just Chatting',
      lien:     url,
    });

    const payload = { content };
    if (embed) payload.embeds = [embed];
    if (row)   payload.components = [row];
    return targetChannel.send(payload);
  }

  // Flux RSS / Bluesky — aucune clé API
  if (alert.platform === 'rss' || alert.platform === 'bluesky') {
    const isRss = alert.platform === 'rss';
    let item = null;
    try {
      const data = isRss
        ? await social.fetchRssFeed(alert.identifier)
        : await social.fetchBlueskyFeed(alert.identifier, { limit: 1 });
      item = data.items[0] || null;
    } catch (_) { /* aperçu synthétique ci-dessous */ }

    const post = item || {
      title: 'Exemple de publication',
      description: 'Voici à quoi ressemblera la prochaine notification.',
      url: profileUrl(alert),
      author: alert.displayName || null,
      image: alert.avatarUrl || null,
      publishedAt: new Date(),
    };

    const { embed, row, url } = buildSocialPostEmbed({
      channelName:  alert.displayName || alert.identifier,
      author:       post.author,
      authorAvatar: alert.avatarUrl || null,
      title:        post.title,
      url:          post.url || profileUrl(alert),
      description:  post.description,
      image:        post.image,
      publishedAt:  post.publishedAt,
    }, appearanceFromAlert(alert), {
      label: isRss ? 'Flux RSS' : 'Bluesky',
      color: PLATFORM_COLORS[alert.platform],
      buttonLabel: isRss ? '🔗 Lire la publication' : '🦋 Voir le post',
    });

    const mention  = alert.roleId ? `<@&${alert.roleId}> ` : '';
    const template = alert.customMessage?.trim() || DEFAULT_SOCIAL_MESSAGE;
    const content  = `🧪 **[TEST]** ${mention}` + renderTemplate(template, {
      chaine: alert.displayName || alert.identifier,
      titre:  post.title,
      auteur: post.author || '',
      lien:   url,
    });

    const payload = { content };
    if (embed) payload.embeds = [embed];
    if (row)   payload.components = [row];
    return targetChannel.send(payload);
  }

  // YouTube
  const videos = await youtube.fetchLatestVideos(alert.uploadsPlaylistId, 1).catch(() => []);
  const video = videos[0] || { title: 'Exemple de vidéo', url: `https://www.youtube.com/channel/${alert.identifier}`, thumbnail: alert.avatarUrl, description: '', publishedAt: new Date() };

  const { embed, row, url } = buildYoutubeVideoEmbed({
    channelName:      alert.displayName || alert.identifier,
    channelId:        alert.identifier,
    channelThumbnail: alert.avatarUrl,
    title:            video.title,
    url:              video.url,
    thumbnail:        video.thumbnail,
    description:      video.description,
    publishedAt:      video.publishedAt,
  }, appearanceFromAlert(alert));

  const mention  = alert.roleId ? `<@&${alert.roleId}> ` : '';
  const template = alert.customMessage?.trim() || DEFAULT_YOUTUBE_MESSAGE;
  const content  = `🧪 **[TEST]** ${mention}` + renderTemplate(template, {
    chaine: alert.displayName || alert.identifier,
    titre:  video.title,
    lien:   url,
  });

  const payload = { content };
  if (embed) payload.embeds = [embed];
  if (row)   payload.components = [row];
  return targetChannel.send(payload);
}

// ─── Modal : demander l'identifiant + message personnalisé ───────────────────
const ADD_MODAL_CONFIG = {
  twitch: {
    title: '🟣 Ajouter un streamer Twitch',
    label: 'Nom d\'utilisateur Twitch',
    placeholder: 'ex: aliancequatro',
    variables: '{streamer} {titre} {jeu} {lien}',
  },
  youtube: {
    title: '🔴 Ajouter une chaîne YouTube',
    label: 'Lien, @handle ou ID de la chaîne',
    placeholder: 'ex: @NomDeChaine ou https://youtube.com/@NomDeChaine',
    variables: '{chaine} {titre} {lien}',
  },
  rss: {
    title: '📰 Ajouter un flux RSS / Atom',
    label: 'URL du flux (RSS, Atom, YouTube, Reddit…)',
    placeholder: 'ex: reddit.com/r/jeuxvideo/.rss ou youtube.com/feeds/videos.xml?channel_id=UC…',
    variables: '{chaine} {titre} {auteur} {lien}',
  },
  bluesky: {
    title: '🦋 Ajouter un profil Bluesky',
    label: 'Handle Bluesky',
    placeholder: 'ex: @nom.bsky.social',
    variables: '{chaine} {titre} {auteur} {lien}',
  },
};

function buildAddModal(platform) {
  const config = ADD_MODAL_CONFIG[platform];
  if (!config) throw new Error(`Plateforme inconnue : ${platform}`);

  const modal = new ModalBuilder()
    .setCustomId(`sa_modal_add_${platform}`)
    .setTitle(config.title);

  const idInput = new TextInputBuilder()
    .setCustomId('sa_identifier')
    .setLabel(config.label)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(config.placeholder)
    .setRequired(true)
    .setMaxLength(300);

  const msgInput = new TextInputBuilder()
    .setCustomId('sa_custom_message')
    .setLabel('Message personnalisé (optionnel)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(`Placeholders : ${config.variables}`)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(idInput),
    new ActionRowBuilder().addComponents(msgInput),
  );
  return modal;
}

// ─── Demander la sélection d'un salon (followUp éphémère + collector) ────────
async function promptChannelSelect(interaction, label = '📢 Choisissez le salon d\'annonce') {
  const row = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('sa_prompt_channel')
      .setPlaceholder(label)
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  const msg = await interaction.followUp({ content: `**${label}**`, components: [row], ephemeral: true });

  const picked = await msg.awaitMessageComponent({
    filter: (i) => i.user.id === interaction.user.id && i.customId === 'sa_prompt_channel',
    time: 120_000,
  }).catch(() => null);

  if (!picked) { await msg.edit({ content: '⏱️ Temps écoulé — opération annulée.', components: [] }).catch(() => {}); return null; }
  const channelId = picked.values[0];
  await picked.update({ content: `✅ Salon sélectionné : <#${channelId}>`, components: [] }).catch(() => {});
  return channelId;
}

// ─── Demander la sélection d'un rôle (optionnelle, avec bouton "Passer") ─────
async function promptRoleSelect(interaction, label = '🔔 Rôle à mentionner (optionnel)') {
  const rows = [
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('sa_prompt_role').setPlaceholder(label),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('sa_prompt_role_skip').setLabel('Aucun rôle').setStyle(ButtonStyle.Secondary),
    ),
  ];
  const msg = await interaction.followUp({ content: `**${label}**`, components: rows, ephemeral: true });

  const picked = await msg.awaitMessageComponent({
    filter: (i) => i.user.id === interaction.user.id && ['sa_prompt_role', 'sa_prompt_role_skip'].includes(i.customId),
    time: 120_000,
  }).catch(() => null);

  if (!picked) { await msg.edit({ content: '⏱️ Temps écoulé — aucun rôle sélectionné.', components: [] }).catch(() => {}); return null; }

  if (picked.customId === 'sa_prompt_role_skip') {
    await picked.update({ content: '➡️ Aucun rôle sélectionné.', components: [] }).catch(() => {});
    return null;
  }
  const roleId = picked.values[0];
  await picked.update({ content: `✅ Rôle sélectionné : <@&${roleId}>`, components: [] }).catch(() => {});
  return roleId;
}

// ─── Flux complet d'ajout via boutons du panel (modal → salon → rôle) ────────
async function runAddFlow(interaction, platform) {
  const modal = buildAddModal(platform);
  await interaction.showModal(modal);

  const modalSubmit = await interaction.awaitModalSubmit({
    filter: (m) => m.customId === `sa_modal_add_${platform}` && m.user.id === interaction.user.id,
    time: 180_000,
  }).catch(() => null);
  if (!modalSubmit) return null;

  const identifier    = modalSubmit.fields.getTextInputValue('sa_identifier').trim();
  const customMessage = modalSubmit.fields.getTextInputValue('sa_custom_message')?.trim() || null;

  await modalSubmit.deferReply({ ephemeral: true });
  await modalSubmit.editReply({ content: `🔎 Vérification de \`${identifier}\`...` });

  const channelId = await promptChannelSelect(modalSubmit);
  if (!channelId) return null;
  const roleId = await promptRoleSelect(modalSubmit);

  try {
    const common = { guildId: interaction.guild.id, channelId, roleId, customMessage, addedBy: interaction.user.id };
    let alert;
    if (platform === 'twitch')       alert = await addTwitchAlert({ ...common, login: identifier });
    else if (platform === 'youtube') alert = await addYoutubeAlert({ ...common, input: identifier });
    else if (platform === 'rss')     alert = await addRssAlert({ ...common, input: identifier });
    else if (platform === 'bluesky') alert = await addBlueskyAlert({ ...common, input: identifier });
    else throw new Error(`Plateforme inconnue : ${platform}`);

    await modalSubmit.followUp({
      embeds: [successEmbed(
        'Alerte configurée !',
        `${PLATFORM_LABEL[platform]} — **${alert.displayName || alert.identifier}**\nSalon : <#${channelId}>${roleId ? `\nRôle : <@&${roleId}>` : ''}`,
      )],
      ephemeral: true,
    });
    return alert;
  } catch (err) {
    await modalSubmit.followUp({ embeds: [errorEmbed('Erreur', err.message)], ephemeral: true });
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  COMMANDE
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('streamalerts')
    .setDescription('📡 Alertes Twitch, YouTube, RSS et Bluesky — RSS/Bluesky sans clé API')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s
      .setName('panel')
      .setDescription('⚙️ Ouvrir le panel de configuration avancé'))
    .addSubcommand((s) => s
      .setName('ajouter-twitch')
      .setDescription('🟣 Ajouter un streamer Twitch à surveiller')
      .addStringOption((o) => o.setName('pseudo').setDescription('Nom d\'utilisateur Twitch').setRequired(true))
      .addChannelOption((o) => o.setName('salon').setDescription('Salon où poster l\'alerte').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Rôle à mentionner (optionnel)').setRequired(false)))
    .addSubcommand((s) => s
      .setName('ajouter-youtube')
      .setDescription('🔴 Ajouter une chaîne YouTube à surveiller')
      .addStringOption((o) => o.setName('chaine').setDescription('URL, @handle ou ID de la chaîne').setRequired(true))
      .addChannelOption((o) => o.setName('salon').setDescription('Salon où poster l\'alerte').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addRoleOption((o) => o.setName('role').setDescription('Rôle à mentionner (optionnel)').setRequired(false)))
    .addSubcommand((s) => s
      .setName('liste')
      .setDescription('📋 Lister les alertes configurées'))
    .addSubcommand((s) => s
      .setName('supprimer')
      .setDescription('🗑️ Supprimer une alerte')
      .addStringOption((o) => o
        .setName('plateforme')
        .setDescription('Plateforme')
        .setRequired(true)
        .addChoices(
          { name: '🟣 Twitch', value: 'twitch' },
          { name: '🔴 YouTube', value: 'youtube' },
          { name: '📰 Flux RSS', value: 'rss' },
          { name: '🦋 Bluesky', value: 'bluesky' },
        ))
      .addStringOption((o) => o.setName('identifiant').setDescription('Pseudo Twitch ou ID/handle YouTube').setRequired(true))),

  addTwitchAlert,
  addYoutubeAlert,
  addRssAlert,
  addBlueskyAlert,
  sendTestAlert,
  buildOverviewEmbed,
  buildOverviewComponents,
  buildManageEmbed,
  buildManageComponents,

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    // ── /streamalerts liste ─────────────────────────────────────────────────
    if (sub === 'liste') {
      await interaction.deferReply({ ephemeral: true });
      const alerts = await StreamAlert.find({ guildId: interaction.guild.id }).sort({ platform: 1, createdAt: 1 });
      if (!alerts.length) {
        return interaction.editReply({ embeds: [infoEmbed('Aucune alerte', 'Utilisez `/streamalerts panel` pour en ajouter une.')] });
      }
      return interaction.editReply({ embeds: [buildOverviewEmbed(interaction.guild, alerts)] });
    }

    // ── /streamalerts ajouter-twitch ────────────────────────────────────────
    if (sub === 'ajouter-twitch') {
      await interaction.deferReply({ ephemeral: true });
      const login   = interaction.options.getString('pseudo');
      const channel = interaction.options.getChannel('salon');
      const role    = interaction.options.getRole('role');
      try {
        const alert = await addTwitchAlert({ guildId: interaction.guild.id, login, channelId: channel.id, roleId: role?.id || null, addedBy: interaction.user.id });
        return interaction.editReply({ embeds: [successEmbed('Streamer ajouté !', `🟣 **${alert.displayName}** sera annoncé dans <#${channel.id}>.`)] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Erreur', err.message)] });
      }
    }

    // ── /streamalerts ajouter-youtube ───────────────────────────────────────
    if (sub === 'ajouter-youtube') {
      await interaction.deferReply({ ephemeral: true });
      const input   = interaction.options.getString('chaine');
      const channel = interaction.options.getChannel('salon');
      const role    = interaction.options.getRole('role');
      try {
        const alert = await addYoutubeAlert({ guildId: interaction.guild.id, input, channelId: channel.id, roleId: role?.id || null, addedBy: interaction.user.id });
        return interaction.editReply({ embeds: [successEmbed('Chaîne ajoutée !', `🔴 **${alert.displayName}** sera annoncée dans <#${channel.id}>.`)] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Erreur', err.message)] });
      }
    }

    // ── /streamalerts supprimer ─────────────────────────────────────────────
    if (sub === 'supprimer') {
      await interaction.deferReply({ ephemeral: true });
      const platform   = interaction.options.getString('plateforme');
      const identifier = interaction.options.getString('identifiant').trim().toLowerCase().replace(/^@/, '');
      const result = await StreamAlert.findOneAndDelete({ guildId: interaction.guild.id, platform, identifier });
      if (!result) {
        return interaction.editReply({ embeds: [errorEmbed('Introuvable', 'Aucune alerte correspondante. Utilisez `/streamalerts liste` pour voir les identifiants exacts.')] });
      }
      return interaction.editReply({ embeds: [successEmbed('Alerte supprimée', `${PLATFORM_LABEL[platform]} — **${result.displayName || result.identifier}**`)] });
    }

    // ── /streamalerts panel ─────────────────────────────────────────────────
    if (sub === 'panel') {
      await interaction.deferReply({ ephemeral: true });

      let alerts = await StreamAlert.find({ guildId: interaction.guild.id }).sort({ platform: 1, createdAt: 1 });

      const reply = await interaction.editReply({
        embeds:     [buildOverviewEmbed(interaction.guild, alerts)],
        components: buildOverviewComponents(alerts),
      });

      let screen  = 'overview';
      let current = null; // alerte actuellement gérée

      const col = reply.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id,
        time:   15 * 60 * 1000,
      });

      col.on('collect', async (i) => {
        try {
          const id = i.customId;

          // ── Retour au panel principal ─────────────────────────────────
          if (id === 'sa_back' || id === 'sa_refresh') {
            alerts = await StreamAlert.find({ guildId: interaction.guild.id }).sort({ platform: 1, createdAt: 1 });
            screen = 'overview';
            return i.update({ embeds: [buildOverviewEmbed(interaction.guild, alerts)], components: buildOverviewComponents(alerts) });
          }

          // ── Sélection d'une alerte à gérer ────────────────────────────
          if (id === 'sa_manage_select') {
            current = await StreamAlert.findById(i.values[0]);
            if (!current) return i.reply({ embeds: [errorEmbed('Introuvable', 'Cette alerte a été supprimée.')], ephemeral: true });
            screen = 'manage';
            return i.update({ embeds: [buildManageEmbed(current)], components: buildManageComponents(current) });
          }

          // ── Ajouter une source (modal + salon + rôle) ──────────────────
          if (id.startsWith('sa_add_')) {
            const platform = id.slice('sa_add_'.length);
            await runAddFlow(i, platform);
            alerts = await StreamAlert.find({ guildId: interaction.guild.id }).sort({ platform: 1, createdAt: 1 });
            return interaction.editReply({ embeds: [buildOverviewEmbed(interaction.guild, alerts)], components: buildOverviewComponents(alerts) }).catch(() => {});
          }

          const MANAGE_IDS = [
            'sa_set_channel_ping', 'sa_color', 'sa_style',
            'sa_toggle', 'sa_toggle_image', 'sa_toggle_thumb', 'sa_toggle_shorts',
            'sa_tpl_title', 'sa_tpl_desc', 'sa_tpl_button', 'sa_tpl_header', 'sa_tpl_message',
            'sa_test', 'sa_delete',
          ];

          // ── Écrans "gestion d'une alerte" — nécessitent `current` ─────
          if (!current && MANAGE_IDS.includes(id)) {
            return i.reply({ embeds: [errorEmbed('Session expirée', 'Réouvrez le panel avec `/streamalerts panel`.')], ephemeral: true });
          }

          // ── Set Channel & Ping — salon + rôle dans un seul écran ──────
          if (id === 'sa_set_channel_ping') {
            const status = () => `**Set Channel & Ping**\nPost in : ${current.channelId ? `<#${current.channelId}>` : '*non défini*'} · Ping : ${current.roleId ? `<@&${current.roleId}>` : '*aucun rôle*'}`;
            const rows = [
              new ActionRowBuilder().addComponents(
                new ChannelSelectMenuBuilder()
                  .setCustomId('sa_pick_channel')
                  .setPlaceholder('📢 Salon de notification...')
                  .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
              ),
              new ActionRowBuilder().addComponents(
                new RoleSelectMenuBuilder()
                  .setCustomId('sa_pick_role')
                  .setPlaceholder('🔔 Rôle à mentionner (ping)...'),
              ),
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('sa_pick_role_none').setLabel('No ping role').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('sa_pick_done').setLabel('Terminé').setStyle(ButtonStyle.Success),
              ),
            ];

            const prompt = await i.reply({ content: status(), components: rows, ephemeral: true, fetchReply: true });
            const picker = prompt.createMessageComponentCollector({ filter: (x) => x.user.id === i.user.id, time: 120_000 });

            picker.on('collect', async (x) => {
              try {
                if (x.customId === 'sa_pick_done') {
                  await x.update({ content: '✅ Salon et ping enregistrés.', components: [] });
                  return picker.stop();
                }
                if (x.customId === 'sa_pick_channel')     current.channelId = x.values[0];
                if (x.customId === 'sa_pick_role')        current.roleId = x.values[0];
                if (x.customId === 'sa_pick_role_none')   current.roleId = null;
                await current.save();
                await x.update({ content: status(), components: rows });
                await i.message.edit({ embeds: [buildManageEmbed(current)], components: buildManageComponents(current) }).catch(() => {});
              } catch (err) {
                console.error('[StreamAlerts] set channel & ping:', err.message);
              }
            });

            picker.on('end', () => prompt.edit({ components: [] }).catch(() => {}));
            return;
          }

          // ── Style d'embed ──────────────────────────────────────────────
          if (id === 'sa_style') {
            const style = i.values[0];
            if (STYLE_LABELS[style]) {
              current.embedStyle = style;
              await current.save();
            }
            return i.update({ embeds: [buildManageEmbed(current)], components: buildManageComponents(current) });
          }

          // ── Toggles (image, miniature, notifications, shorts) ──────────
          if (['sa_toggle', 'sa_toggle_image', 'sa_toggle_thumb', 'sa_toggle_shorts'].includes(id)) {
            const field = { sa_toggle: 'enabled', sa_toggle_image: 'showImage', sa_toggle_thumb: 'showThumbnail', sa_toggle_shorts: 'notifyShorts' }[id];
            current[field] = !current[field];
            await current.save();
            return i.update({ embeds: [buildManageEmbed(current)], components: buildManageComponents(current) });
          }

          // ── Couleur de l'embed ─────────────────────────────────────────
          if (id === 'sa_color') {
            const baseColor = PLATFORM_COLORS[current.platform] || COLORS.primary;
            const currentHex = colorToHex(parseColor(current.embedColor, baseColor), baseColor);
            const modal = new ModalBuilder().setCustomId('sa_modal_color').setTitle('Couleur de l\'embed');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('val')
                .setLabel('Code hexadécimal (ex: #ff4a4a)')
                .setStyle(TextInputStyle.Short)
                .setValue(currentHex)
                .setRequired(true)
                .setMaxLength(7),
            ));
            await i.showModal(modal);
            const submitted = await i.awaitModalSubmit({
              filter: (m) => m.customId === 'sa_modal_color' && m.user.id === i.user.id,
              time: 180_000,
            }).catch(() => null);
            if (!submitted) return;

            const value = submitted.fields.getTextInputValue('val').trim();
            if (!/^(?:#|0x)?[0-9a-f]{6}$/i.test(value)) {
              return submitted.reply({ embeds: [errorEmbed('Couleur invalide', 'Utilisez un code hex à 6 caractères, ex : `#ff4a4a`.')], ephemeral: true });
            }
            current.embedColor = colorToHex(parseColor(value, baseColor), baseColor);
            await current.save();
            return submitted.update({ embeds: [buildManageEmbed(current)], components: buildManageComponents(current) });
          }

          // ── Templates (titre, description, bouton, en-tête) ───────────
          const templateSetting = TEMPLATE_SETTINGS[id];
          if (templateSetting) {
            const modal = new ModalBuilder().setCustomId(`sa_modal_${id}`).setTitle(templateSetting.title);
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('val')
                .setLabel(templateSetting.label)
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(templateSetting.maxLength)
                .setPlaceholder(templateSetting.placeholder)
                .setValue(String(current[templateSetting.field] || '').slice(0, templateSetting.maxLength)),
            ));
            await i.showModal(modal);
            const submitted = await i.awaitModalSubmit({
              filter: (m) => m.customId === `sa_modal_${id}` && m.user.id === i.user.id,
              time: 180_000,
            }).catch(() => null);
            if (!submitted) return;

            const value = submitted.fields.getTextInputValue('val').trim();
            // « - » retire le bouton ; un champ vide rétablit le libellé par défaut.
            current[templateSetting.field] = templateSetting.field === 'buttonLabel' && value === '-'
              ? ''
              : (value || null);
            await current.save();
            return submitted.update({ embeds: [buildManageEmbed(current)], components: buildManageComponents(current) });
          }

          if (id === 'sa_delete') {
            await StreamAlert.findByIdAndDelete(current._id);
            const deletedName = current.displayName || current.identifier;
            current = null;
            alerts = await StreamAlert.find({ guildId: interaction.guild.id }).sort({ platform: 1, createdAt: 1 });
            screen = 'overview';
            await i.update({ embeds: [buildOverviewEmbed(interaction.guild, alerts)], components: buildOverviewComponents(alerts) });
            return i.followUp({ embeds: [successEmbed('Alerte supprimée', deletedName)], ephemeral: true }).catch(() => {});
          }

          if (id === 'sa_test') {
            await i.deferReply({ ephemeral: true });
            const guild = interaction.guild;
            const channel = guild.channels.cache.get(current.channelId);
            if (!channel?.isTextBased()) {
              return i.editReply({ embeds: [errorEmbed('Erreur', 'Le salon configuré est introuvable ou inaccessible.')] });
            }
            try {
              await sendTestAlert(current, channel);
              return i.editReply({ embeds: [successEmbed('Test envoyé !', `Un message de test a été posté dans <#${current.channelId}>.`)] });
            } catch (err) {
              return i.editReply({ embeds: [errorEmbed('Erreur lors du test', err.message)] });
            }
          }
        } catch (err) {
          console.error('[StreamAlerts] panel:', err);
          const errPayload = { embeds: [errorEmbed('Erreur', 'Une erreur est survenue. Réessayez.')], ephemeral: true };
          if (i.deferred || i.replied) await i.followUp(errPayload).catch(() => {});
          else await i.reply(errPayload).catch(() => {});
        }
      });

      col.on('end', () => {
        interaction.editReply({ components: [] }).catch(() => {});
      });
      return;
    }
  },
};
