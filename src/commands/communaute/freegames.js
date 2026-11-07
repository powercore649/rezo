'use strict';
// commands/freegames.js — Jeux gratuits configurables (Epic, GamerPower, FreeToGame)

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const { FreeGamesConfig, PostedGame } = require('../../models/FreeGames');
const {
  fetchAllFreeGames,
  fetchEpicFreeGames,
  fetchGamerPowerGames,
  fetchFreeToPlayGames,
} = require('../../utils/freeGamesFetcher');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ─── Couleurs par source ─────────────────────────────────────────────────────
const SOURCE_COLORS = {
  epic:       0x2D2D2D,
  gamerpower: 0xFF6B35,
  freetogame: 0x00D166,
  steam:      0x1B2838,
};
const SOURCE_NAMES = {
  epic:       '🟣 Epic Games Store',
  gamerpower: '🎮 GamerPower',
  freetogame: '🆓 Free-to-Play',
  steam:      '🔵 Steam',
};

// ─── Construire l'embed d'un jeu ─────────────────────────────────────────────
function buildGameEmbed(game, index, total) {
  const color = SOURCE_COLORS[game.source] || COLORS.primary;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎁 ${game.title}`)
    .setURL(game.url)
    .setAuthor({ name: SOURCE_NAMES[game.source] || game.sourceName })
    .setDescription(game.description || '*Pas de description disponible.*');

  if (game.image) embed.setImage(game.image);

  const fields = [];

  fields.push({ name: '💰 Prix', value: game.price, inline: true });

  if (game.platforms?.length > 0) {
    fields.push({ name: '🖥️ Plateforme', value: game.platforms.join(', ').toUpperCase(), inline: true });
  }

  if (game.genre) {
    fields.push({ name: '🎭 Genre', value: game.genre, inline: true });
  }

  if (game.endDate) {
    const ts = Math.floor(new Date(game.endDate).getTime() / 1000);
    fields.push({ name: '⏰ Disponible jusqu\'au', value: `<t:${ts}:F>\n(<t:${ts}:R>)`, inline: true });
  } else if (!game.isUpcoming) {
    fields.push({ name: '⏰ Disponibilité', value: 'Permanent ♾️', inline: true });
  }

  if (game.isUpcoming && game.startDate) {
    const ts = Math.floor(new Date(game.startDate).getTime() / 1000);
    fields.push({ name: '📅 Disponible', value: `<t:${ts}:F>\n(<t:${ts}:R>)`, inline: true });
  }

  if (fields.length > 0) embed.addFields(fields);

  if (game.isUpcoming) {
    embed.setFooter({ text: `⏳ Prochainement gratuit • ${index}/${total}` });
  } else {
    embed.setFooter({ text: `🎁 Gratuit maintenant • ${index}/${total}` });
  }

  embed.setTimestamp();
  return embed;
}

// ─── Config embed ─────────────────────────────────────────────────────────────
function buildConfigEmbed(config, guild) {
  const ok = v => v ? '🟢' : '🔴';
  return new EmbedBuilder()
    .setColor(config.enabled ? COLORS.success : COLORS.warning)
    .setTitle('🎮 Configuration — Jeux Gratuits')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .addFields(
      { name: 'Statut',          value: config.enabled ? '🟢 Activé' : '🔴 Désactivé',                              inline: true },
      { name: 'Salon',           value: config.channelId ? `<#${config.channelId}>` : '❌ *Non défini*',             inline: true },
      { name: 'Mention',         value: config.roleId ? `<@&${config.roleId}>` : '*Aucune*',                         inline: true },
      { name: `${ok(config.epicEnabled)} Epic Games`,    value: config.epicEnabled ? 'Activé' : 'Désactivé',         inline: true },
      { name: `${ok(config.steamEnabled)} Steam`,        value: config.steamEnabled ? 'Activé' : 'Désactivé',        inline: true },
      { name: `${ok(config.gamerPowerEnabled)} GamerPower`, value: config.gamerPowerEnabled ? 'Activé' : 'Désactivé', inline: true },
      { name: `${ok(config.autoPost)} Auto-post`,        value: config.autoPost ? `Oui — **${config.postTime} UTC**` : 'Non', inline: true },
    )
    .setFooter({ text: 'Utilisez le menu pour configurer chaque option' })
    .setTimestamp();
}

function buildConfigComponents(config) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('fg_config_action')
    .setPlaceholder('⚙️ Configurer...')
    .addOptions([
      { label: config.enabled ? '🔴 Désactiver' : '🟢 Activer',            value: 'toggle',            description: 'Activer/désactiver les posts automatiques'   },
      { label: config.epicEnabled ? '🟣 Désactiver Epic' : '🟣 Activer Epic', value: 'toggle_epic',     description: 'Jeux gratuits Epic Games Store'               },
      { label: config.steamEnabled ? '🔵 Désactiver Steam' : '🔵 Activer Steam', value: 'toggle_steam', description: 'Promotions gratuites Steam'                   },
      { label: config.gamerPowerEnabled ? '🎮 Désactiver GamerPower' : '🎮 Activer GamerPower', value: 'toggle_gamerpower', description: 'Giveaways GamerPower'     },
      { label: config.autoPost ? '⏰ Désactiver auto-post' : '⏰ Activer auto-post', value: 'toggle_autopost', description: 'Poster automatiquement chaque jour'   },
    ]);

  return [new ActionRowBuilder().addComponents(menu)];
}

// ─── Poster les jeux dans un salon ───────────────────────────────────────────
async function postFreeGames(client, guildId, channelId, options = {}) {
  const { roleId, epicEnabled = true, steamEnabled = true, gamerPowerEnabled = true, checkDuplicates = true } = options;

  const guild   = client.guilds.cache.get(guildId);
  if (!guild) return { posted: 0, skipped: 0 };
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return { posted: 0, skipped: 0 };

  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has(['SendMessages', 'EmbedLinks'])) return { posted: 0, skipped: 0 };

  // Récupérer les jeux
  const games = await fetchAllFreeGames({ epicEnabled, steamEnabled, gamerPowerEnabled, onlyCurrentlyFree: true });
  if (!games.length) return { posted: 0, skipped: 0 };

  // Filtrer les doublons
  let toPost = games;
  if (checkDuplicates) {
    const alreadyPosted = await PostedGame.find({ guildId }).lean();
    const postedIds     = new Set(alreadyPosted.map(p => `${p.source}_${p.gameId}`));
    toPost = games.filter(g => !postedIds.has(`${g.source}_${g.id}`));
  }

  if (!toPost.length) return { posted: 0, skipped: games.length };

  // Embed d'en-tête
  const headerEmbed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🎮 ${toPost.length} jeu${toPost.length > 1 ? 'x' : ''} gratuit${toPost.length > 1 ? 's' : ''} disponible${toPost.length > 1 ? 's' : ''} !`)
    .setDescription(
      toPost.map((g, i) => `**${i + 1}.** [${g.title}](${g.url}) — ${SOURCE_NAMES[g.source] || g.sourceName}`).join('\n')
    )
    .setFooter({ text: 'REZO • Jeux Gratuits — Mis à jour automatiquement' })
    .setTimestamp();

  const mention = roleId ? `<@&${roleId}> ` : '';
  await channel.send({ content: mention + '🎁 **Nouveaux jeux gratuits !**', embeds: [headerEmbed] });

  // Poster chaque jeu individuellement
  let posted = 0;
  for (let i = 0; i < toPost.length; i++) {
    const game   = toPost[i];
    const embed  = buildGameEmbed(game, i + 1, toPost.length);
    const row    = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('🎮 Récupérer gratuitement')
        .setStyle(ButtonStyle.Link)
        .setURL(game.url),
    );

    await channel.send({ embeds: [embed], components: [row] }).catch(() => {});

    // Marquer comme posté
    await PostedGame.findOneAndUpdate(
      { guildId, gameId: game.id, source: game.source },
      {
        guildId,
        gameId:    game.id,
        source:    game.source,
        postedAt:  new Date(),
        expiresAt: game.endDate || null,
      },
      { upsert: true }
    ).catch(() => {});

    posted++;
    // Petit délai pour éviter le rate-limit Discord
    if (i < toPost.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  return { posted, skipped: games.length - posted };
}

// ─── Clé du jour courant (UTC) ───────────────────────────────────────────────
function todayKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')}`;
}

// ─── Auto-post pour tous les serveurs configurés ──────────────────────────────
// Persistance en BDD → survit aux redémarrages du bot.
// Si le bot était éteint à 10h00 UTC, le post se fait dès le redémarrage (catch-up).
async function autoPostFreeGames(client, force = false) {
  try {
    const today   = todayKey();
    const configs = await FreeGamesConfig.find({ enabled: true, autoPost: true, channelId: { $ne: null } });
    let total = 0;

    for (const config of configs) {
      try {
        // Vérifier si le post a déjà été fait aujourd'hui (persisté en BDD)
        if (!force && config.lastAutoPost === today) {
          continue; // Déjà posté aujourd'hui pour ce serveur
        }

        const result = await postFreeGames(client, config.guildId, config.channelId, {
          roleId:            config.roleId,
          epicEnabled:       config.epicEnabled,
          steamEnabled:      config.steamEnabled,
          gamerPowerEnabled: config.gamerPowerEnabled,
          checkDuplicates:   true,
        });

        // Marquer comme posté en BDD (même si 0 nouveaux jeux — évite les tentatives répétées)
        await FreeGamesConfig.findOneAndUpdate(
          { guildId: config.guildId },
          { lastAutoPost: today }
        );

        if (result.posted > 0) {
          console.log(`🎮 FreeGames auto-post: ${result.posted} jeu(x) → ${config.guildId}`);
          total += result.posted;

          // Envoyer une notification aux abonnés
          try {
            const { sendNotification } = require('../../utils/notificationManager');
            const notifEmbed = new (require('discord.js').EmbedBuilder)()
              .setColor(COLORS.primary)
              .setTitle(`🎮 ${result.posted} nouveau(x) jeu(x) gratuit(s) !`)
              .setDescription(`De nouveaux jeux gratuits sont disponibles sur votre serveur !

Utilisez \`/freegames voir\` pour les découvrir.`)
              .setTimestamp();
            await sendNotification(client, config.guildId, 'freeGames', notifEmbed, `${result.posted} jeux gratuits`);
          } catch (err) {
            console.error('FreeGames sendNotification:', err.message);
          }
        }
      } catch (err) {
        console.error(`FreeGames auto-post ${config.guildId}:`, err.message);
      }
    }

    return total;
  } catch (err) {
    console.error('autoPostFreeGames:', err.message);
    return 0;
  }
}

// ─── Catch-up au démarrage ────────────────────────────────────────────────────
// Appelé une fois au boot — si le bot était éteint à l'heure du post,
// il poste dès qu'il redémarre (mais seulement si pas encore fait aujourd'hui).
async function catchUpFreeGames(client) {
  const now = new Date();
  const h   = now.getUTCHours();
  // On poste en catch-up entre 10h00 et 23h59 UTC si pas encore fait aujourd'hui
  if (h >= 10) {
    console.log('🎮 FreeGames — vérification catch-up au démarrage...');
    const total = await autoPostFreeGames(client, false);
    if (total > 0) console.log(`✅ FreeGames catch-up: ${total} jeu(x) posté(s)`);
  }
}

// ─── Commande ────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('freegames')
    .setDescription('🎮 Jeux gratuits du moment — Epic, Steam, GamerPower')
    .setDefaultMemberPermissions(null) // tout le monde peut voir, restriction par sous-commande
    .addSubcommand(s => s
      .setName('voir')
      .setDescription('🎁 Voir les jeux gratuits disponibles maintenant')
      .addStringOption(o => o
        .setName('source')
        .setDescription('Source à consulter')
        .addChoices(
          { name: '🌍 Toutes les sources', value: 'all'        },
          { name: '🟣 Epic Games',         value: 'epic'       },
          { name: '🎮 GamerPower',         value: 'gamerpower' },
          { name: '🆓 Free-to-Play',       value: 'f2p'        },
        )))
    .addSubcommand(s => s
      .setName('poster')
      .setDescription('📢 Poster manuellement les jeux gratuits dans le salon configuré'))
    .addSubcommand(s => s
      .setName('config')
      .setDescription('⚙️ Configurer le système de jeux gratuits'))
    .addSubcommand(s => s
      .setName('epic')
      .setDescription('🟣 Voir les jeux Epic Games (gratuits + à venir)')),

  autoPostFreeGames,
  catchUpFreeGames,
  postFreeGames,

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();

    // ── /freegames voir ───────────────────────────────────────────────────
    if (sub === 'voir') {
      await interaction.deferReply();
      const source = interaction.options.getString('source') || 'all';

      let games = [];
      if (source === 'all')       games = await fetchAllFreeGames({ epicEnabled: true, gamerPowerEnabled: true });
      else if (source === 'epic') games = (await fetchEpicFreeGames()).filter(g => g.isFree);
      else if (source === 'gamerpower') games = await fetchGamerPowerGames();
      else if (source === 'f2p') games = await fetchFreeToPlayGames(8);

      if (!games.length) {
        return interaction.editReply({ embeds: [errorEmbed('Aucun jeu gratuit', 'Aucun jeu gratuit trouvé pour le moment. Réessayez plus tard !')] });
      }

      // Affichage paginé
      let page = 0;
      const buildPageComponents = (p, total) => {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('fg_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
          new ButtonBuilder().setCustomId('fg_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= total - 1),
          new ButtonBuilder().setLabel('🎮 Récupérer').setStyle(ButtonStyle.Link).setURL(games[p].url),
        );
        return [row];
      };

      const reply = await interaction.editReply({
        embeds:     [buildGameEmbed(games[0], 1, games.length)],
        components: buildPageComponents(0, games.length),
        fetchReply: true,
      });

      const col = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id && ['fg_prev','fg_next'].includes(i.customId),
        time:   5 * 60 * 1000,
      });

      col.on('collect', async i => {
        if (i.customId === 'fg_prev') page = Math.max(0, page - 1);
        else page = Math.min(games.length - 1, page + 1);
        await i.update({
          embeds:     [buildGameEmbed(games[page], page + 1, games.length)],
          components: buildPageComponents(page, games.length),
        });
      });
      col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }

    // ── /freegames epic ───────────────────────────────────────────────────
    if (sub === 'epic') {
      await interaction.deferReply();
      const games = await fetchEpicFreeGames();

      if (!games.length) {
        return interaction.editReply({ embeds: [errorEmbed('Epic Games', 'Impossible de récupérer les jeux Epic pour le moment.')] });
      }

      const free     = games.filter(g => g.isFree);
      const upcoming = games.filter(g => g.isUpcoming);

      const embeds = [];

      if (free.length > 0) {
        const freeEmbed = new EmbedBuilder()
          .setColor(0x2D2D2D)
          .setTitle('🟣 Epic Games — Gratuits cette semaine')
          .setDescription(free.map(g => {
            const endTs = g.endDate ? `<t:${Math.floor(new Date(g.endDate).getTime() / 1000)}:R>` : 'N/A';
            return `🎁 **[${g.title}](${g.url})**\n> ${g.price} • Expire ${endTs}`;
          }).join('\n\n'))
          .setThumbnail('https://upload.wikimedia.org/wikipedia/commons/thumb/3/31/Epic_Games_logo.svg/200px-Epic_Games_logo.svg.png')
          .setTimestamp();
        if (free[0]?.image) freeEmbed.setImage(free[0].image);
        embeds.push(freeEmbed);
      }

      if (upcoming.length > 0) {
        const upEmbed = new EmbedBuilder()
          .setColor(0x888888)
          .setTitle('⏳ Epic Games — Prochainement gratuits')
          .setDescription(upcoming.map(g => {
            const startTs = g.startDate ? `<t:${Math.floor(new Date(g.startDate).getTime() / 1000)}:R>` : 'N/A';
            return `🔜 **${g.title}**\n> Disponible ${startTs}`;
          }).join('\n\n'))
          .setTimestamp();
        embeds.push(upEmbed);
      }

      if (!embeds.length) {
        return interaction.editReply({ embeds: [errorEmbed('Epic Games', 'Aucune promo trouvée cette semaine.')] });
      }

      const rows = free.map(g => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`🎮 ${g.title.slice(0, 40)}`).setStyle(ButtonStyle.Link).setURL(g.url)
      )).slice(0, 5);

      return interaction.editReply({ embeds, components: rows });
    }

    // ── /freegames poster ─────────────────────────────────────────────────
    if (sub === 'poster') {
      await interaction.deferReply({ ephemeral: true });
      const config = await FreeGamesConfig.findOne({ guildId: interaction.guild.id });
      if (!config?.channelId) {
        return interaction.editReply({ embeds: [errorEmbed('Non configuré', 'Configurez d\'abord un salon avec `/freegames config`.')] });
      }

      const result = await postFreeGames(client, interaction.guild.id, config.channelId, {
        roleId:            config.roleId,
        epicEnabled:       config.epicEnabled,
        steamEnabled:      config.steamEnabled,
        gamerPowerEnabled: config.gamerPowerEnabled,
        checkDuplicates:   false, // Force le post même si déjà posté
      });

      return interaction.editReply({
        embeds: [successEmbed(
          '✅ Jeux postés !',
          `**${result.posted}** jeu(x) posté(s) dans <#${config.channelId}>.`
        )],
      });
    }

    // ── /freegames config ─────────────────────────────────────────────────
    if (sub === 'config') {
      await interaction.deferReply({ ephemeral: true });

      let config = await FreeGamesConfig.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { $setOnInsert: { guildId: interaction.guild.id } },
        { upsert: true, new: true }
      );

      const reply = await interaction.editReply({
        embeds:     [buildConfigEmbed(config, interaction.guild)],
        components: [
          ...buildConfigComponents(config),
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId('fg_set_channel')
              .setPlaceholder('📢 Salon de publication...')
              .setChannelTypes(ChannelType.GuildText)
          ),
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
              .setCustomId('fg_set_role')
              .setPlaceholder('🔔 Rôle à mentionner (optionnel)...')
          ),
        ],
        fetchReply: true,
      });

      const col = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time:   10 * 60 * 1000,
      });

      col.on('collect', async i => {
        const cid = i.customId;

        if (cid === 'fg_set_channel') {
          await i.deferUpdate();
          config = await FreeGamesConfig.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { channelId: i.values[0] },
            { new: true }
          );
          await i.editReply({ embeds: [buildConfigEmbed(config, interaction.guild)], components: i.message.components });
          return;
        }

        if (cid === 'fg_set_role') {
          await i.deferUpdate();
          config = await FreeGamesConfig.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { roleId: i.values[0] },
            { new: true }
          );
          await i.editReply({ embeds: [buildConfigEmbed(config, interaction.guild)], components: i.message.components });
          return;
        }

        if (cid === 'fg_config_action') {
          await i.deferUpdate();
          const action = i.values[0];
          const update = {};

          if (action === 'toggle')           update.enabled        = !config.enabled;
          if (action === 'toggle_epic')      update.epicEnabled    = !config.epicEnabled;
          if (action === 'toggle_steam')     update.steamEnabled   = !config.steamEnabled;
          if (action === 'toggle_gamerpower') update.gamerPowerEnabled = !config.gamerPowerEnabled;
          if (action === 'toggle_autopost')  update.autoPost       = !config.autoPost;

          config = await FreeGamesConfig.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $set: update },
            { new: true }
          );
          await i.editReply({
            embeds:     [buildConfigEmbed(config, interaction.guild)],
            components: [
              ...buildConfigComponents(config),
              ...i.message.components.slice(1), // Garder channel et role selects
            ],
          });
          return;
        }
      });

      col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
      return;
    }
  },
};
