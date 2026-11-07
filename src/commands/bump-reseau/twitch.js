'use strict';
// commands/twitch.js — Explorer Twitch directement depuis Discord.
// /twitch top [jeu]   → streams les plus regardés du moment (paginé, curseur Helix)
// /twitch search      → recherche de chaînes par nom (paginé)
// /twitch chaine      → fiche détaillée d'un streamer précis

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const twitch = require('../../utils/twitchFetcher');
const { errorEmbed, infoEmbed, COLORS } = require('../../utils/embeds');

const PAGE_SIZE = 5;
const COLLECTOR_TIMEOUT_MS = 5 * 60 * 1000;
const TWITCH_PURPLE = 0x9146FF;

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? `${str.slice(0, n - 1).trim()}…` : str;
}

function bestThumb(url, w = 440, h = 248) {
  if (!url) return null;
  return url.replace('{width}', String(w)).replace('{height}', String(h));
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('fr-FR');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Rendu — page de streams (top / top par jeu)
// ═══════════════════════════════════════════════════════════════════════════
function buildStreamsEmbed({ heading, items, pageIndex, hasNext }) {
  const embed = new EmbedBuilder().setColor(TWITCH_PURPLE).setTitle(heading).setTimestamp();

  if (!items.length) {
    embed.setDescription(pageIndex === 0
      ? '*Aucun stream en direct trouvé pour le moment.*'
      : '*Plus aucun résultat sur cette page.*');
    return embed;
  }

  const lines = items.map((s, i) => {
    const n = pageIndex * PAGE_SIZE + i + 1;
    return [
      `**${n}.** [${truncate(s.title, 65) || 'Sans titre'}](https://twitch.tv/${s.user_login})`,
      `👤 **${s.user_name}** · 🎮 ${s.game_name || 'Sans catégorie'} · 🔴 ${fmtNum(s.viewer_count)} spectateurs`,
    ].join('\n');
  });

  embed.setDescription(lines.join('\n\n'));
  const thumb = bestThumb(items[0].thumbnail_url);
  if (thumb) embed.setThumbnail(thumb);
  embed.setFooter({ text: `Page ${pageIndex + 1}${hasNext ? '' : ' · dernière page'} · Données Twitch en direct` });
  return embed;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Rendu — page de recherche de chaînes
// ═══════════════════════════════════════════════════════════════════════════
function buildSearchEmbed({ query, items, pageIndex, hasNext }) {
  const embed = new EmbedBuilder()
    .setColor(TWITCH_PURPLE)
    .setTitle(`🔎 Recherche Twitch — "${query}"`)
    .setTimestamp();

  if (!items.length) {
    embed.setDescription(pageIndex === 0 ? '*Aucune chaîne trouvée pour cette recherche.*' : '*Plus aucun résultat sur cette page.*');
    return embed;
  }

  const lines = items.map((c, i) => {
    const n = pageIndex * PAGE_SIZE + i + 1;
    const liveTag = c.is_live ? '🔴 **EN LIVE**' : '⚪ Hors ligne';
    return [
      `**${n}.** [${c.display_name}](https://twitch.tv/${c.broadcaster_login}) — ${liveTag}`,
      `🎮 ${c.game_name || 'Sans catégorie'}${c.is_live ? ` · ${truncate(c.title, 50)}` : ''}`,
    ].join('\n');
  });

  embed.setDescription(lines.join('\n\n'));
  const firstThumb = items.find((c) => c.thumbnail_url)?.thumbnail_url;
  if (firstThumb) embed.setThumbnail(firstThumb);
  embed.setFooter({ text: `Page ${pageIndex + 1}${hasNext ? '' : ' · dernière page'} · Recherche Twitch` });
  return embed;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Composants de pagination génériques
// ═══════════════════════════════════════════════════════════════════════════
function buildPaginationRow({ pageIndex, hasPrev, hasNext, loading = false }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('twpage_prev').setLabel('◀ Précédent').setStyle(ButtonStyle.Secondary).setDisabled(loading || !hasPrev),
    new ButtonBuilder().setCustomId('twpage_refresh').setLabel('🔄 Actualiser').setStyle(ButtonStyle.Secondary).setDisabled(loading),
    new ButtonBuilder().setCustomId('twpage_next').setLabel('Suivant ▶').setStyle(ButtonStyle.Primary).setDisabled(loading || !hasNext),
    new ButtonBuilder().setCustomId('twpage_close').setLabel('✖').setStyle(ButtonStyle.Danger).setDisabled(loading),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Moteur de pagination générique par curseur Helix
//  fetchPage(cursor) doit retourner { items, cursor } (cursor = curseur pour LA PAGE SUIVANTE, ou null)
// ═══════════════════════════════════════════════════════════════════════════
async function runPaginatedPanel(interaction, { fetchPage, renderEmbed }) {
  // cursors[i] = curseur à utiliser pour récupérer la page i (cursors[0] = undefined)
  const cursors = [undefined];
  let pageIndex = 0;
  let currentItems = [];
  let nextCursor = null;

  async function loadPage(index) {
    const { items, cursor } = await fetchPage(cursors[index]);
    currentItems = items;
    nextCursor = cursor;
    if (cursor) cursors[index + 1] = cursor;
    pageIndex = index;
  }

  try {
    await loadPage(0);
  } catch (err) {
    return interaction.editReply({ embeds: [errorEmbed('Erreur Twitch', 'Impossible de contacter l\'API Twitch pour le moment. Réessayez plus tard.')] });
  }

  const message = await interaction.editReply({
    embeds: [renderEmbed({ items: currentItems, pageIndex, hasNext: !!nextCursor })],
    components: [buildPaginationRow({ pageIndex, hasPrev: false, hasNext: !!nextCursor })],
  });

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id,
    time: COLLECTOR_TIMEOUT_MS,
  });

  collector.on('collect', async (i) => {
    const id = i.customId;

    if (id === 'twpage_close') {
      collector.stop('closed');
      return i.update({ components: [] }).catch(() => {});
    }

    // État "chargement" pour éviter les doubles-clics pendant l'appel API
    await i.update({ components: [buildPaginationRow({ pageIndex, hasPrev: pageIndex > 0, hasNext: !!nextCursor, loading: true })] }).catch(() => {});

    try {
      if (id === 'twpage_next' && nextCursor) {
        await loadPage(pageIndex + 1);
      } else if (id === 'twpage_prev' && pageIndex > 0) {
        await loadPage(pageIndex - 1);
      } else if (id === 'twpage_refresh') {
        await loadPage(pageIndex);
      }

      await i.editReply({
        embeds: [renderEmbed({ items: currentItems, pageIndex, hasNext: !!nextCursor })],
        components: [buildPaginationRow({ pageIndex, hasPrev: pageIndex > 0, hasNext: !!nextCursor })],
      });
    } catch (err) {
      await i.editReply({
        embeds: [errorEmbed('Erreur Twitch', 'Une erreur est survenue en récupérant cette page.')],
        components: [buildPaginationRow({ pageIndex, hasPrev: pageIndex > 0, hasNext: !!nextCursor })],
      }).catch(() => {});
    }
  });

  collector.on('end', (_, reason) => {
    if (reason === 'closed') return;
    interaction.editReply({ components: [] }).catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('twitch')
    .setDescription('🟣 Explorer Twitch — streams en direct, recherche, fiche streamer')
    .addSubcommand((sub) => sub
      .setName('top')
      .setDescription('Streams les plus regardés en direct sur Twitch')
      .addStringOption((o) => o.setName('jeu').setDescription('Filtrer par jeu/catégorie (ex: Valorant, Just Chatting...)').setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('search')
      .setDescription('Rechercher une chaîne Twitch par nom')
      .addStringOption((o) => o.setName('nom').setDescription('Nom de la chaîne à rechercher').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('chaine')
      .setDescription('Fiche détaillée d\'un streamer (pseudo Twitch exact)')
      .addStringOption((o) => o.setName('pseudo').setDescription('Pseudo Twitch exact (login)').setRequired(true))),

  async execute(interaction) {
    if (!twitch.isConfigured()) {
      return interaction.reply({
        embeds: [errorEmbed('Twitch non configuré', 'Le bot n\'a pas de `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` configurés. Contactez un administrateur du bot.')],
        ephemeral: true,
      });
    }

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();

    // ── /twitch top [jeu] ──────────────────────────────────────────────────
    if (sub === 'top') {
      const gameName = interaction.options.getString('jeu');
      let gameId = null;
      let heading = '🔥 Top streams Twitch en direct';

      if (gameName) {
        const game = await twitch.getGameByName(gameName).catch(() => null);
        if (!game) {
          return interaction.editReply({ embeds: [errorEmbed('Jeu introuvable', `Aucune catégorie Twitch ne correspond à **${gameName}**.`)] });
        }
        gameId = game.id;
        heading = `🔥 Top streams — 🎮 ${game.name}`;
      }

      return runPaginatedPanel(interaction, {
        fetchPage: (cursor) => gameId
          ? twitch.getStreamsByGameId({ gameId, cursor, first: PAGE_SIZE })
          : twitch.getTopStreams({ cursor, first: PAGE_SIZE }),
        renderEmbed: ({ items, pageIndex, hasNext }) => buildStreamsEmbed({ heading, items, pageIndex, hasNext }),
      });
    }

    // ── /twitch search <nom> ────────────────────────────────────────────────
    if (sub === 'search') {
      const query = interaction.options.getString('nom');

      return runPaginatedPanel(interaction, {
        fetchPage: (cursor) => twitch.searchChannels({ query, cursor, first: PAGE_SIZE }),
        renderEmbed: ({ items, pageIndex, hasNext }) => buildSearchEmbed({ query, items, pageIndex, hasNext }),
      });
    }

    // ── /twitch chaine <pseudo> ─────────────────────────────────────────────
    if (sub === 'chaine') {
      const login = interaction.options.getString('pseudo').trim().toLowerCase();

      const [users, streams] = await Promise.all([
        twitch.getUsersByLogin([login]).catch(() => []),
        twitch.getStreamsByLogin([login]).catch(() => []),
      ]);

      const user = users[0];
      if (!user) {
        return interaction.editReply({ embeds: [errorEmbed('Streamer introuvable', `Aucun compte Twitch trouvé pour \`${login}\`.`)] });
      }

      const liveStream = streams[0] || null;
      const channelInfo = (await twitch.getChannelInfo([user.id]).catch(() => []))[0] || null;

      const embed = new EmbedBuilder()
        .setColor(liveStream ? COLORS.error : TWITCH_PURPLE)
        .setAuthor({ name: user.display_name, iconURL: user.profile_image_url, url: `https://twitch.tv/${user.login}` })
        .setThumbnail(user.profile_image_url)
        .setURL(`https://twitch.tv/${user.login}`)
        .setTimestamp();

      if (liveStream) {
        embed.setTitle('🔴 EN DIRECT');
        embed.setDescription(truncate(liveStream.title, 200) || '*Sans titre*');
        embed.addFields(
          { name: '🎮 Catégorie', value: liveStream.game_name || 'Sans catégorie', inline: true },
          { name: '👁️ Spectateurs', value: fmtNum(liveStream.viewer_count), inline: true },
          { name: '🕒 En live depuis', value: `<t:${Math.floor(new Date(liveStream.started_at).getTime() / 1000)}:R>`, inline: true },
        );
        const img = bestThumb(liveStream.thumbnail_url, 640, 360);
        if (img) embed.setImage(img);
      } else {
        embed.setTitle('⚪ Hors ligne');
        embed.setDescription(user.description ? truncate(user.description, 300) : '*Aucune description.*');
        if (channelInfo?.game_name) {
          embed.addFields({ name: '🎮 Dernière catégorie', value: channelInfo.game_name, inline: true });
        }
        if (channelInfo?.title) {
          embed.addFields({ name: '📝 Dernier titre', value: truncate(channelInfo.title, 150), inline: false });
        }
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Voir sur Twitch').setStyle(ButtonStyle.Link).setURL(`https://twitch.tv/${user.login}`),
      );

      return interaction.editReply({ embeds: [embed], components: [row] });
    }
  },
};
