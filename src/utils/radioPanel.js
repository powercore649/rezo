'use strict';
// utils/radioPanel.js — Tout l’affichage de /radio : embeds et composants.
//
// Aucune décision de jeu ni accès réseau ici : les vues reçoivent un état déjà
// calculé (station, volume, favoris, filtrage) et le dessinent. C’est ce qui
// rend le panneau testable sans vocal ni base, et ce qui empêche une retouche
// visuelle de casser la lecture.
//
// Le panneau est PUBLIC (comme celui de la musique) : la station se choisit à
// plusieurs. Les favoris, eux, sont personnels — ils s’ouvrent dans une vue
// éphémère pour ne pas mentir sur « qui a mis quoi en favori ».

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
} = require('discord.js');
const { COLORS } = require('./embeds');
const brand = require('./brand');
const stations = require('./radioStations');

const IDS = {
  toggle: 'rad_toggle',
  volDown: 'rad_voldown',
  volUp: 'rad_volup',
  favorite: 'rad_fav',
  stop: 'rad_stop',

  pick: 'rad_pick',
  genre: 'rad_genre',

  favorites: 'rad_view_fav',
  catalog: 'rad_catalog',
  config: 'rad_config',
  close: 'rad_close',

  // Boîte à outils du panneau : minuteur d’extinction, diagnostic, recherche.
  timer: 'rad_timer',
  timerPick: 'rad_timer_pick',
  timerOff: 'rad_timer_off',
  timerClose: 'rad_timer_close',
  diag: 'rad_diag',
  diagRefresh: 'rad_diag_refresh',
  diagClose: 'rad_diag_close',
  search: 'rad_search',
  searchClose: 'rad_search_close',

  favPick: 'rad_fav_pick',
  favClose: 'rad_fav_close',

  catPrev: 'rad_cat_prev',
  catNext: 'rad_cat_next',
  catClose: 'rad_cat_close',

  cfgEnabled: 'rad_cfg_enabled',
  cfgVolume: 'rad_cfg_volume',
  cfgNowPlaying: 'rad_cfg_nowplaying',
  cfgDjOnly: 'rad_cfg_djonly',
  cfgPlayer: 'rad_cfg_player',
  cfgChannels: 'rad_cfg_channels',
  cfgRole: 'rad_cfg_role',
  cfgTest: 'rad_cfg_test',
  cfgClose: 'rad_cfg_close',
};

const MODALS = {
  volume: 'rad_cfg_vol_modal',
  search: 'rad_search_modal',
};

// Durées du minuteur d’extinction, en minutes. Six choix : on garde la vue
// lisible d’un coup d’œil, sans menu à rallonge.
const TIMER_CHOICES = [
  { minutes: 15, label: '15 minutes', emoji: '🌙' },
  { minutes: 30, label: '30 minutes', emoji: '🌙' },
  { minutes: 45, label: '45 minutes', emoji: '🌗' },
  { minutes: 60, label: '1 heure', emoji: '🌗' },
  { minutes: 90, label: '1 h 30', emoji: '☀️' },
  { minutes: 120, label: '2 heures', emoji: '☀️' },
];

const SELECT_LIMIT = 25;
const CATALOG_PAGE_SIZE = 12;

function clip(text, max = 90) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** « 12 min », « 3 h 42 », « 2 j 4 h » — durée de connexion lisible. */
function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} h ${restMinutes}` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} j ${restHours} h` : `${days} j`;
}

/** Résumé de santé du flux, sur une ligne : c’est le seul indicateur qui
 *  distingue « ça joue » de « ça a décroché puis repris ». */
function flowLabel(flow = null) {
  if (!flow) return '✅ stable';
  if (flow.error) return `⚠️ ${clip(flow.error, 60)}`;
  if (Number(flow.reconnects) > 0) return `🔁 ${Number(flow.reconnects)} reprise(s)`;
  if (Number(flow.dropouts) > 0) return '⏳ reconnexion…';
  return '✅ stable';
}

/** Minutes restantes d’un minuteur, arrondies vers le haut (15 → 15, 0 → 0). */
function timerMinutesLeft(remainingMs = 0) {
  return Math.max(0, Math.ceil((Number(remainingMs) || 0) / 60000));
}

function stationLabel(station) {
  return `${stations.flagOf(station)} ${station.name}`;
}

function stationOption(station) {
  return {
    label: clip(stationLabel(station), 100),
    description: clip(`${station.tagline} • ${stations.qualityOf(station)}`, 100),
    value: station.id,
  };
}

// ── Lecteur ─────────────────────────────────────────────────────────────────
function playerEmbed({
  station = null, paused = false, volume = 70, connectedFor = 0, nowPlaying = null,
  showNowPlaying = true, guildName = null, notice = null,
  listeners = null, sleepMinutes = 0, flow = null,
} = {}) {
  if (!station) {
    const featured = stations.featuredStations();
    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setAuthor({ name: brand.footer('Radio') })
      .setTitle('📻 Radio — prête à diffuser')
      .setDescription([
        notice || '',
        'Aucune station en lecture.',
        '',
        'Choisis une station dans le menu ci-dessous : je rejoins ton salon vocal et je diffuse le **direct**, sans file d’attente et sans coupure publicitaire de ma part.',
        '',
        '**Stations populaires**',
        featured.map(item => `• ${stationLabel(item)} — *${clip(item.tagline, 46)}*`).join('\n'),
        '',
        `\`${stations.STATIONS.length}\` stations, ${stations.GENRE_IDS.length} genres — le menu **Genre** déroule le reste.`,
      ].filter(Boolean).join('\n').slice(0, 4000))
      .setFooter({ text: brand.footer(`Radio${guildName ? ` • ${guildName}` : ''} • sans Lavalink`) });
    return embed;
  }

  const genre = stations.genreOf(station);
  const lines = [
    notice || '',
    `*${station.tagline}*`,
    '',
    paused ? '⏸️ **En pause** — le direct reprend au clic sur **Reprendre**.' : '🔴 **En direct** — flux continu, aucune file.',
    `\`${stations.qualityOf(station)}\``,
  ];
  if (showNowPlaying) {
    lines.push('');
    lines.push(nowPlaying
      ? `🎵 **${clip(nowPlaying, 180)}**`
      : '🎼 *Titre en direct non fourni par cette station.*');
  }
  if (station.homepage) lines.push('', `[Site de la station](${station.homepage})`);

  const embed = new EmbedBuilder()
    .setColor(genre.color || COLORS.primary)
    .setAuthor({ name: brand.footer('Radio') })
    .setTitle(`${genre.emoji} ${station.name}`)
    .setDescription(lines.filter(Boolean).join('\n').slice(0, 4000))
    .addFields(
      { name: 'Genre', value: `${genre.emoji} ${genre.label}`, inline: true },
      { name: 'Pays', value: stations.flagOf(station), inline: true },
      { name: 'Débit', value: `\`${stations.qualityOf(station)}\``, inline: true },
      { name: 'Volume', value: `🔊 **${Math.round(volume)} %**`, inline: true },
      { name: 'Auditeurs', value: listeners === null || listeners === undefined ? '*non mesuré*' : `🎧 **${listeners}**`, inline: true },
      { name: 'Connecté depuis', value: `⏱️ ${formatUptime(connectedFor)}`, inline: true },
      { name: 'Salon', value: paused ? '⏸️ pause' : '▶️ lecture', inline: true },
      { name: 'Minuteur', value: sleepMinutes > 0 ? `⏰ ${formatUptime(sleepMinutes * 60)}` : '*aucun*', inline: true },
      { name: 'Flux', value: flowLabel(flow), inline: true },
    )
    .setFooter({ text: brand.footer(`Radio${guildName ? ` • ${guildName}` : ''} • sans Lavalink`) });

  return embed;
}

function playerComponents({ station = null, paused = false, filter = stations.ALL_FILTER, hasSession = false } = {}) {
  const playing = Boolean(station);

  const transport = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.toggle)
      .setEmoji(playing && !paused ? '⏸️' : '▶️')
      .setLabel(playing && !paused ? 'Pause' : 'Reprendre')
      .setStyle(playing && !paused ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(!playing),
    new ButtonBuilder().setCustomId(IDS.volDown).setEmoji('🔉').setLabel('-10 %').setStyle(ButtonStyle.Secondary).setDisabled(!hasSession),
    new ButtonBuilder().setCustomId(IDS.volUp).setEmoji('🔊').setLabel('+10 %').setStyle(ButtonStyle.Secondary).setDisabled(!hasSession),
    new ButtonBuilder()
      .setCustomId(IDS.favorite)
      .setEmoji('⭐')
      .setLabel('Favori')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!playing),
    new ButtonBuilder().setCustomId(IDS.stop).setEmoji('⏹️').setLabel('Arrêter').setStyle(ButtonStyle.Danger).setDisabled(!playing),
  );

  const list = stations.stationsByGenre(filter).slice(0, SELECT_LIMIT);
  const options = list.length
    ? list.map(stationOption)
    : [{ label: 'Aucune station dans ce genre', value: 'none' }];

  const pick = new StringSelectMenuBuilder()
    .setCustomId(IDS.pick)
    .setPlaceholder(`📻 Choisir une station (${list.length})`)
    .addOptions(options);

  const genreOptions = [
    {
      label: 'Toutes les stations',
      description: `${stations.STATIONS.length} stations au catalogue`,
      value: stations.ALL_FILTER,
      emoji: '📚',
      default: filter === stations.ALL_FILTER,
    },
    ...stations.GENRE_IDS.map(id => {
      const genre = stations.GENRES[id];
      return {
        label: genre.label,
        description: `${stations.stationsByGenre(id).length} station(s)`,
        value: id,
        emoji: genre.emoji,
        default: filter === id,
      };
    }),
  ].slice(0, SELECT_LIMIT);

  const genre = new StringSelectMenuBuilder()
    .setCustomId(IDS.genre)
    .setPlaceholder(`🎭 Genre : ${stations.filterLabel(filter)}`)
    .addOptions(genreOptions);

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.favorites).setEmoji('⭐').setLabel('Mes favoris').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.catalog).setEmoji('📋').setLabel('Catalogue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.config).setEmoji('⚙️').setLabel('Réglages').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.close).setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
  );

  // 5e rangée : les outils « avancés ». Minuteur et diagnostic ouvrent des
  // vues éphémères ; la recherche passe par une modale (saisie libre).
  const tools = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.timer)
      .setEmoji('⏰')
      .setLabel('Minuteur')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!playing),
    new ButtonBuilder()
      .setCustomId(IDS.diag)
      .setEmoji('📊')
      .setLabel('Diagnostic')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasSession),
    new ButtonBuilder()
      .setCustomId(IDS.search)
      .setEmoji('🔎')
      .setLabel('Rechercher')
      .setStyle(ButtonStyle.Secondary),
  );

  return [
    transport,
    new ActionRowBuilder().addComponents(pick),
    new ActionRowBuilder().addComponents(genre),
    actions,
    tools,
  ];
}

// ── Favoris (vue éphémère, personnelle) ─────────────────────────────────────
function favoritesEmbed(favoriteStations = [], { notice = null, guildName = null } = {}) {
  const list = favoriteStations.slice(0, SELECT_LIMIT);
  const description = list.length
    ? [
        notice || '',
        'Tes stations épinglées, disponibles en un clic :',
        '',
        list.map((station, index) => `\`${String(index + 1).padStart(2, '0')}.\` ${stationLabel(station)} — *${clip(station.tagline, 48)}*`).join('\n'),
        '',
        '⭐ sur le panneau pour ajouter ou retirer la station en cours.',
      ].filter(Boolean).join('\n')
    : [
        notice || '',
        '**Aucun favori pour le moment.**',
        '',
        'Lance une station, puis clique **⭐ Favori** sur le panneau : elle apparaîtra ici, prête à être relancée.',
      ].filter(Boolean).join('\n');

  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setAuthor({ name: brand.footer('Radio • Favoris') })
    .setTitle(`⭐ Mes stations (${list.length})`)
    .setDescription(description.slice(0, 4000))
    .setFooter({ text: brand.footer(`Radio${guildName ? ` • ${guildName}` : ''} • favoris personnels`) });
}

function favoritesComponents(favoriteStations = []) {
  const rows = [];
  const list = favoriteStations.slice(0, SELECT_LIMIT);
  if (list.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(IDS.favPick)
        .setPlaceholder('⭐ Lancer un favori…')
        .addOptions(list.map(stationOption)),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.favClose).setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

// ── Catalogue (vue éphémère, paginée) ──────────────────────────────────────
function catalogPageCount(filter = stations.ALL_FILTER) {
  return Math.max(1, Math.ceil(stations.stationsByGenre(filter).length / CATALOG_PAGE_SIZE));
}

function catalogEmbed({ page = 1, filter = stations.ALL_FILTER, notice = null } = {}) {
  const pool = stations.stationsByGenre(filter);
  const pages = Math.max(1, Math.ceil(pool.length / CATALOG_PAGE_SIZE));
  const current = Math.max(1, Math.min(pages, Math.round(Number(page) || 1)));
  const start = (current - 1) * CATALOG_PAGE_SIZE;
  const slice = pool.slice(start, start + CATALOG_PAGE_SIZE);

  const lines = slice.map((station, index) => {
    const number = String(start + index + 1).padStart(2, '0');
    return `\`${number}.\` ${stationLabel(station)} — *${clip(station.tagline, 42)}* · \`${station.bitrate} kbps\``;
  });

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setAuthor({ name: brand.footer('Radio • Catalogue') })
    .setTitle(`📋 ${stations.filterLabel(filter)}`)
    .setDescription([
      notice || '',
      lines.join('\n') || '*Aucune station dans ce genre.*',
    ].filter(Boolean).join('\n').slice(0, 4000))
    .setFooter({ text: brand.footer(`Page ${current}/${pages} • ${pool.length} station(s) • ${stations.STATIONS.length} au total`) });
}

function catalogComponents({ page = 1, filter = stations.ALL_FILTER } = {}) {
  const pages = catalogPageCount(filter);
  const current = Math.max(1, Math.min(pages, Math.round(Number(page) || 1)));
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${IDS.catPrev}:${current}`)
      .setEmoji('◀️')
      .setLabel('Page')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(current <= 1),
    new ButtonBuilder().setCustomId(IDS.catClose).setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${IDS.catNext}:${current}`)
      .setEmoji('▶️')
      .setLabel('Page')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(current >= pages),
  )];
}

// ── Réglages (vue éphémère, administrateurs) ────────────────────────────────
function configEmbed(cfg = {}, { notice = null, guildName = null, stationTest = null } = {}) {
  const channels = (cfg.channelIds || []).length
    ? cfg.channelIds.slice(0, 8).map(id => `<#${id}>`).join(' · ')
    : '*Tous les salons*';

  const fields = [
    { name: 'Interrupteur', value: cfg.enabled ? '✅ activé' : '⛔ désactivé', inline: true },
    { name: 'Volume par défaut', value: `🔊 **${Math.round(cfg.defaultVolume ?? 70)} %**`, inline: true },
    { name: 'Titre en direct', value: cfg.showNowPlaying ? '✅ affiché' : '❌ masqué', inline: true },
    { name: 'Salons autorisés (texte ou vocal)', value: channels, inline: false },
    { name: 'Rôle DJ', value: cfg.djRoleId ? `<@&${cfg.djRoleId}>` : '*Aucun*', inline: true },
    { name: 'Contrôle DJ', value: cfg.djOnly ? '✅ actif' : '❌ inactif', inline: true },
    {
      name: '📊 Écoute',
      value: `${cfg.stats?.stationPlays || 0} lancement(s) · ${formatUptime(cfg.stats?.secondsPlayed || 0)} cumulées`,
      inline: false,
    },
  ];

  if (stationTest) {
    fields.push({
      name: `🔌 Test du flux${stationTest.stationName ? ` — ${clip(stationTest.stationName, 40)}` : ''}`,
      value: stationTest.reachable
        ? `✅ joignable · \`${stationTest.status}\` · ${clip(stationTest.contentType || 'audio', 40)}${stationTest.title ? `\n🎵 ${clip(stationTest.title, 90)}` : ''}`
        : `❌ injoignable (${stationTest.reason || 'aucune réponse'})`,
      inline: false,
    });
  }

  return new EmbedBuilder()
    .setColor(cfg.enabled ? COLORS.primary : COLORS.warning)
    .setAuthor({ name: brand.footer('Radio • Réglages') })
    .setTitle('⚙️ Réglages du module radio')
    .setDescription([
      notice || '',
      'Le panneau public est ouvert à tous ; ces réglages décident **où** et **par qui** la radio peut être pilotée.',
      '',
      `\`${stations.STATIONS.length}\` stations disponibles, sans Lavalink : ffmpeg décode le flux et Discord l’encode en Opus.`,
    ].filter(Boolean).join('\n'))
    .addFields(...fields)
    .setFooter({ text: brand.footer(`Radio${guildName ? ` • ${guildName}` : ''}`) });
}

function configComponents(cfg = {}) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.cfgEnabled)
      .setEmoji(cfg.enabled ? '✅' : '⛔')
      .setLabel('Activer')
      .setStyle(cfg.enabled ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(IDS.cfgVolume).setEmoji('🔊').setLabel('Volume défaut').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(IDS.cfgNowPlaying)
      .setEmoji('🎵')
      .setLabel('Titre en direct')
      .setStyle(cfg.showNowPlaying ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(IDS.cfgDjOnly)
      .setEmoji('🛡️')
      .setLabel('Contrôle DJ')
      .setStyle(cfg.djOnly ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.cfgPlayer).setEmoji('📻').setLabel('Panneau').setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(IDS.cfgChannels)
      .setPlaceholder('📍 Salons autorisés (vide = partout)')
      .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice])
      .setMinValues(0)
      .setMaxValues(10),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(IDS.cfgRole)
      .setPlaceholder('🛡️ Rôle DJ (optionnel)')
      .setMinValues(0)
      .setMaxValues(1),
  );

  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.cfgTest).setEmoji('🔌').setLabel('Tester le flux').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.cfgClose).setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3, row4];
}

// ── Vue fermée ──────────────────────────────────────────────────────────────
// ── Minuteur d’extinction ───────────────────────────────────────────────────
function timerEmbed({ station = null, remainingMs = 0, notice = null, guildName = null } = {}) {
  const left = timerMinutesLeft(remainingMs);
  const description = [
    notice || '',
    station
      ? 'Une fois la durée écoulée, je coupe le direct et je libère le salon vocal — pratique pour une écoute du soir.'
      : 'Aucune station en diffusion : lance la radio, le minuteur s’arme juste après.',
    '',
    left > 0
      ? `⏰ **Arrêt dans ${formatUptime(left * 60)}**${station ? ` — ${stationLabel(station)}` : ''}.`
      : '*Aucun minuteur actif.*',
    '',
    'Le minuteur suit la session : changer de station ne le remet pas à zéro, arrêter la radio le coupe.',
  ].filter(Boolean).join('\n');

  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setAuthor({ name: brand.footer('Radio • Minuteur') })
    .setTitle('⏰ Minuteur d’extinction')
    .setDescription(description.slice(0, 4000))
    .setFooter({ text: brand.footer(`Radio${guildName ? ` • ${guildName}` : ''} • arrêt automatique`) });
}

function timerComponents({ remainingMs = 0 } = {}) {
  const left = timerMinutesLeft(remainingMs);
  const options = TIMER_CHOICES.map(choice => ({
    label: choice.label,
    value: String(choice.minutes),
    description: `Arrêt automatique de la radio dans ${choice.label}`,
    emoji: choice.emoji,
    default: left > 0 && choice.minutes === left,
  }));

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(IDS.timerPick)
        .setPlaceholder(left > 0 ? `⏰ Arrêt dans ${left} min` : '⏰ Programmer un arrêt')
        .addOptions(options),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.timerOff).setEmoji('⏱️').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setDisabled(left <= 0),
      new ButtonBuilder().setCustomId(IDS.timerClose).setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Diagnostic du flux ─────────────────────────────────────────────────────
function diagnosticEmbed({ diag = null, notice = null, guildName = null } = {}) {
  const data = diag || {};
  const station = data.station || null;
  const history = Array.isArray(data.history) ? data.history.slice(0, 8) : [];
  const listeners = data.listeners;
  const sleepMinutes = Number(data.sleepMinutes) || 0;

  const fields = [
    { name: '📻 Station', value: station ? `${stationLabel(station)}\n\`${stations.qualityOf(station)}\`` : '*Aucune diffusion*', inline: true },
    { name: '🔊 Sortie', value: `${Math.round(Number(data.volume ?? 70))} % · ${data.paused ? '⏸️ pause' : '▶️ direct'}`, inline: true },
    { name: '⏱️ Écoute', value: formatUptime(data.elapsed || 0), inline: true },
    { name: '🎧 Auditeurs', value: listeners === null || listeners === undefined ? '*non mesuré*' : `**${listeners}**`, inline: true },
    { name: '📍 Salon', value: data.voiceChannelId ? `<#${data.voiceChannelId}>` : '*aucun*', inline: true },
    { name: '⏰ Minuteur', value: sleepMinutes > 0 ? `arrêt dans ${formatUptime(sleepMinutes * 60)}` : '*aucun*', inline: true },
    { name: '🔁 Robustesse', value: `${Number(data.reconnects) || 0} coupure(s) reprise(s) · ${Number(data.dropouts) || 0} perte(s) de flux`, inline: false },
    { name: '🩺 Dernière erreur', value: data.lastError ? `\`${clip(data.lastError, 200)}\`` : '*aucune*', inline: false },
    {
      name: '🕘 Derniers titres',
      value: history.length
        ? history.map((entry, index) => `\`${String(index + 1).padStart(2, '0')}.\` ${clip(entry.title || entry, 70)}`).join('\n')
        : '*aucun titre relevé*',
      inline: false,
    },
  ];

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setAuthor({ name: brand.footer('Radio • Diagnostic') })
    .setTitle('📊 Diagnostic du direct')
    .setDescription([
      notice || '',
      'Tout ce que le moteur sait du flux en cours : état, robustesse et derniers titres relevés.',
    ].filter(Boolean).join('\n'))
    .addFields(...fields)
    .setFooter({ text: brand.footer(`Radio${guildName ? ` • ${guildName}` : ''} • diagnostic éphémère`) });
}

function diagnosticComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.diagRefresh).setEmoji('🔄').setLabel('Rafraîchir').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.diagClose).setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
  )];
}

// ── Recherche de station ───────────────────────────────────────────────────
function searchEmbed(query = '', results = []) {
  const list = results.slice(0, SELECT_LIMIT);
  const description = list.length
    ? [
        `**${list.length}** station(s) pour « **${clip(query, 60) || 'sélection'}** » :`,
        '',
        list.map((station, index) => `\`${String(index + 1).padStart(2, '0')}.\` ${stationLabel(station)} — *${clip(station.tagline, 42)}*`).join('\n'),
        '',
        'Choisis la station dans le menu : elle démarre dans ton salon vocal, ou remplace le direct en cours.',
      ].join('\n')
    : [
        `Aucune station ne correspond à « **${clip(query, 60)}** ».`,
        '',
        'Essaie un genre (*jazz*, *info*, *chill*…), un pays ou une partie du nom — accents et apostrophes sont ignorés.',
      ].join('\n');

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setAuthor({ name: brand.footer('Radio • Recherche') })
    .setTitle(`🔎 ${clip(query, 60) || 'Catalogue'}`)
    .setDescription(description.slice(0, 4000))
    .setFooter({ text: brand.footer(`Radio • ${stations.STATIONS.length} stations au catalogue`) });
}

/** Le menu réutilise `rad_pick` : une station choisie ici se lance exactement
 *  comme depuis le panneau. Le message, lui, reste éphémère. */
function searchComponents(results = []) {
  const rows = [];
  const list = results.slice(0, SELECT_LIMIT);
  if (list.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(IDS.pick)
        .setPlaceholder('📻 Lancer une station…')
        .addOptions(list.map(stationOption)),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.searchClose).setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

// ── Vue fermée ─────────────────────────────────────────────────────────────
function closedPayload({ title = '📻 Panneau fermé' } = {}) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.info)
      .setAuthor({ name: brand.footer('Radio') })
      .setTitle(title)
      .setDescription('La diffusion continue. Rouvre le panneau avec `/radio` (sans option).')],
    components: [],
  };
}

module.exports = {
  IDS,
  MODALS,
  TIMER_CHOICES,
  SELECT_LIMIT,
  CATALOG_PAGE_SIZE,
  clip,
  formatUptime,
  flowLabel,
  timerMinutesLeft,
  stationLabel,
  stationOption,
  playerEmbed,
  playerComponents,
  timerEmbed,
  timerComponents,
  diagnosticEmbed,
  diagnosticComponents,
  searchEmbed,
  searchComponents,
  favoritesEmbed,
  favoritesComponents,
  catalogPageCount,
  catalogEmbed,
  catalogComponents,
  configEmbed,
  configComponents,
  closedPayload,
};
