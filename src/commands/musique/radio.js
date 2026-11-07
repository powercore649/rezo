'use strict';
// commands/musique/radio.js — 📻 Module radio.
//
// `/radio` (sans option) ouvre LE panneau du serveur : station en cours, titre
// en direct, transport, sélecteur de station, filtre par genre, favoris.
// `/radio station:<nom>` rejoint le vocal et démarre directement.
// Aucune commande séparée à retenir : tout le reste vit dans les boutons.
//
// Points de conception :
//   • un seul message-panneau par serveur (édité en place, jamais spammé) ;
//   • les vues personnelles (favoris, catalogue, réglages) sont éphémères, pour
//     ne pas transformer un panneau public en journal de tout le monde ;
//   • la dernière commande audio lancée prend la main : lancer la radio coupe
//     la musique, et inversement (une seule connexion vocale par serveur).

const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags, ChannelType,
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const engine = require('../../utils/radioEngine');
const musicEngine = require('../../utils/musicEngine');
const stations = require('../../utils/radioStations');
const panel = require('../../utils/radioPanel');
const { COLORS } = require('../../utils/embeds');
const brand = require('../../utils/brand');

const HELP_TEXT = [
  '**`/radio`** — ouvre le panneau : station en cours, titre en direct, volume, favoris.',
  '**`/radio station:<nom>`** — rejoint ton salon vocal et démarre la station.',
  '**`/radio volume:<0-200>`** — règle le volume de la diffusion en cours.',
  '',
  `• **${stations.STATIONS.length} stations**, ${stations.GENRE_IDS.length} genres : généralistes, info, jazz, classique, électro, chill, rock, rap, pop, monde, culture.`,
  '• **Direct** : aucun morceau à télécharger, ffmpeg lit le flux et Discord l’encode en Opus — pas de Lavalink.',
  '• **Titre en direct** : les métadonnées ICY du flux sont affichées quand la station les fournit.',
  '• **Reconnexion** : une coupure réseau est reprise trois fois (délai croissant) avant d’abandonner.',
  '• **Favoris** : ⭐ épingle une station, la vue **Mes favoris** la relance en un clic.',
  '• **Minuteur** ⏰ : arrête la radio tout seul après 15 min à 2 h ; le compte à rebours suit la session.',
  '• **Diagnostic** 📊 : santé du flux — coupures reprises, dernière erreur, auditeurs, derniers titres.',
  '• **Rechercher** 🔎 : saisie libre dans tout le catalogue, sans passer par les menus.',
  '• **Réglages** (Gérer le serveur) : interrupteur, salons autorisés, rôle DJ, volume par défaut, titre en direct.',
].join('\n');

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setAuthor({ name: brand.footer('Radio') })
    .setTitle('📻 Radio — mode d’emploi')
    .setDescription(HELP_TEXT.slice(0, 3900))
    .setFooter({ text: brand.footer('Radio • direct, sans Lavalink') });
}

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

function clipped(value, max = 60) {
  return panel.clip(value, max);
}

function controlRefusal(verdict) {
  if (verdict.ok) return null;
  if (verdict.reason === 'dj') return '🛡️ Le contrôle DJ est actif : seuls les membres du rôle DJ (ou les modérateurs) peuvent changer de station, couper ou régler le volume.';
  if (verdict.reason === 'voice') return '🔊 Tu dois être dans le **même salon vocal** que le bot pour piloter la radio.';
  return '🔊 Rejoins d’abord un salon vocal.';
}

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
}

function botCanSpeak(channel, guild) {
  const me = guild?.members?.me;
  if (!me) return true;
  const perms = channel.permissionsFor?.(me);
  if (!perms) return true;
  return perms.has(PermissionFlagsBits.Connect) && perms.has(PermissionFlagsBits.Speak);
}

function memberVoiceChannel(interaction) {
  return interaction.member?.voice?.channel || null;
}

function unknownStationEmbed(query) {
  const suggestions = stations.searchStations(query, { limit: 3 });
  const lines = [
    `Aucune station ne correspond à **${clipped(query, 60)}**.`,
    '',
    suggestions.length
      ? `Peut-être : ${suggestions.map(station => `\`${station.id}\``).join(' · ')}`
      : 'Ouvre le panneau avec `/radio` puis **📋 Catalogue** pour parcourir les stations.',
    '',
    '💡 L’autocomplétion de l’option `station` propose les noms et identifiants.',
  ];
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setAuthor({ name: brand.footer('Radio') })
    .setTitle('📻 Station introuvable')
    .setDescription(lines.join('\n'))
    .setFooter({ text: brand.footer('Radio • catalogue') });
}

async function catalogPayload(page = 1, filter = stations.ALL_FILTER) {
  return {
    embeds: [panel.catalogEmbed({ page, filter })],
    components: panel.catalogComponents({ page, filter }),
  };
}

async function favoritesPayload(guildId, userId, { notice = null, guildName = null } = {}) {
  const list = await engine.favoriteStations(guildId, userId);
  return {
    embeds: [panel.favoritesEmbed(list, { notice, guildName })],
    components: panel.favoritesComponents(list),
  };
}

async function configPayload(guild, { notice = null, stationTest = null } = {}) {
  const { payload } = await engine.configPanelForGuild(guild, { notice, stationTest });
  return payload;
}

async function timerPayload(session, { notice = null, guildName = null } = {}) {
  const remainingMs = engine.sleepRemainingMs(session);
  return {
    embeds: [panel.timerEmbed({ station: session?.station || null, remainingMs, notice, guildName })],
    components: panel.timerComponents({ remainingMs }),
  };
}

function diagnosticPayload(session, { notice = null, guildName = null } = {}) {
  return {
    embeds: [panel.diagnosticEmbed({ diag: engine.diagnosticsOf(session), notice, guildName })],
    components: panel.diagnosticComponents(),
  };
}

function searchPayload(query, results) {
  return {
    embeds: [panel.searchEmbed(query, results)],
    components: panel.searchComponents(results),
  };
}

/**
 * Le panneau public ne doit jamais être « adopté » depuis une vue éphémère :
 * sinon la carte temps réel éditerait la réponse privée d’un membre.
 */
function isEphemeralMessage(interaction) {
  const flags = interaction?.message?.flags;
  if (flags === null || flags === undefined) return false;
  if (typeof flags.has === 'function') return Boolean(flags.has(MessageFlags.Ephemeral));
  return Boolean(Number(flags.bitfield ?? flags) & MessageFlags.Ephemeral);
}

module.exports = {
  HELP_TEXT,
  helpEmbed,

  data: new SlashCommandBuilder()
    .setName('radio')
    .setDescription('📻 Radio — écoute une station en direct dans un salon vocal')
    .addStringOption(option => option
      .setName('station')
      .setDescription('Station à écouter (nom ou identifiant)')
      .setRequired(false)
      .setAutocomplete(true)
      .setMaxLength(80))
    .addIntegerOption(option => option
      .setName('volume')
      .setDescription('Volume de 0 à 200 % (contrôle DJ)')
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(200)),

  // ── Autocomplétion ────────────────────────────────────────────────────────
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const query = String(focused?.value || '');
    const results = stations.searchStations(query, { limit: 25 });
    const choices = results.map(station => ({
      name: `${stations.flagOf(station)} ${station.name} — ${stations.genreOf(station).label}`.slice(0, 100),
      value: station.id,
    }));
    await interaction.respond(choices).catch(() => {});
  },

  // ── Commande ──────────────────────────────────────────────────────────────
  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply(ephemeral({ content: '❌ La radio se lance depuis un serveur.' }));
    }

    const guild = interaction.guild;
    const stationQuery = interaction.options.getString('station');
    const volumeOption = interaction.options.getInteger('volume');

    // Volume seul
    if (volumeOption !== null && volumeOption !== undefined && !stationQuery) {
      const session = engine.getSession(guild.id);
      if (!session?.station) {
        return interaction.reply(ephemeral({ content: '❌ Rien en diffusion : lance d’abord une station avec `/radio station:…`.' }));
      }
      const verdict = engine.canControl(interaction.member, session.cfg || {}, {
        botChannelId: session.voiceChannelId,
      });
      const refusal = controlRefusal(verdict);
      if (refusal) return interaction.reply(ephemeral({ content: refusal }));

      const volume = engine.setVolume(session, volumeOption);
      await engine.refreshPanel(session, { notice: `🔊 Volume réglé à **${volume} %**.` });
      return interaction.reply(ephemeral({ content: `🔊 Volume : **${volume} %**.` }));
    }

    // Panneau seul
    if (!stationQuery) {
      const session = engine.getSession(guild.id);
      if (session) {
        const refreshed = await engine.refreshPanel(session, { force: true });
        if (refreshed) return interaction.reply(ephemeral({ content: '📻 Panneau mis à jour ci-dessus.' }));
        // Panneau introuvable (salon supprimé, bot sans permission) : on en
        // renvoie un ici plutôt que d'afficher un faux « rien en lecture ».
        // On l'attache, sinon la carte temps réel ne saurait pas où s'éditer.
        const message = await interaction.reply(await engine.buildPanelPayload(session, { guild }));
        engine.attachPanel(session, message, interaction.channelId);
        return message;
      }
      const payload = await engine.panelPayloadForGuild(guild);
      return interaction.reply(payload);
    }

    // Station demandée
    const station = stations.findStation(stationQuery);
    if (!station) {
      return interaction.reply(ephemeral({ embeds: [unknownStationEmbed(stationQuery)] }));
    }

    const voiceChannel = memberVoiceChannel(interaction);
    if (!voiceChannel) {
      return interaction.reply(ephemeral({
        content: '🔊 Rejoins d’abord un **salon vocal** : le bot s’y connecte pour diffuser la station.',
      }));
    }
    if (voiceChannel.type === ChannelType.GuildStageVoice && !voiceChannel.speakable) {
      return interaction.reply(ephemeral({
        content: '🎙️ Ce salon est une **scène** : donne au bot la permission de parler, puis réessaie.',
      }));
    }
    if (!botCanSpeak(voiceChannel, guild)) {
      return interaction.reply(ephemeral({
        content: `🔒 Il me manque **Se connecter** ou **Parler** dans <#${voiceChannel.id}>.`,
      }));
    }

    // Ne jamais arracher le bot à un autre salon : les auditeurs perdraient le
    // direct sans prévenir. Même règle pour la musique.
    const session = engine.getSession(guild.id);
    if (session?.station && session.voiceChannelId && session.voiceChannelId !== voiceChannel.id) {
      return interaction.reply(ephemeral({
        content: `📻 Je diffuse déjà dans <#${session.voiceChannelId}>. Rejoins ce salon, ou arrête la radio (bouton **Arrêter**).`,
      }));
    }
    const musicSession = musicEngine.getSession(guild.id);
    if (!session?.station && musicSession?.voiceChannelId && musicSession.voiceChannelId !== voiceChannel.id && musicSession.queue?.current) {
      return interaction.reply(ephemeral({
        content: `🎵 La musique joue déjà dans <#${musicSession.voiceChannelId}>. Rejoins ce salon, ou arrête-la avec le bouton **Arrêter** du panneau musique.`,
      }));
    }

    await interaction.deferReply();

    try {
      const result = await engine.start({
        guild,
        member: interaction.member,
        voiceChannel,
        textChannel: interaction.channel,
        station,
      });

      const notice = `📻 **${station.name}** — ${station.tagline}`;
      const active = result.session;

      // Un panneau existe déjà : on l'édite et on ne laisse qu'une confirmation
      // courte là où la commande a été tapée.
      if (active.panelMessageId) {
        await engine.refreshPanel(active, { notice });
        return interaction.editReply({ content: notice });
      }

      const payload = await engine.buildPanelPayload(active, { guild, notice });
      const message = await interaction.editReply(payload);
      engine.attachPanel(active, message, interaction.channelId);
      return message;
    } catch (err) {
      console.error('❌ Radio (/radio):', err.message);
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.error)
          .setAuthor({ name: brand.footer('Radio') })
          .setTitle('❌ Diffusion impossible')
          .setDescription(String(err.message || 'Erreur inconnue.').slice(0, 3900))
          .setFooter({ text: brand.footer('Radio • vérifie la station, ou réessaie') })],
        components: [],
      });
    }
  },

  // ── Boutons ───────────────────────────────────────────────────────────────
  async handleButton(interaction) {
    const id = interaction.customId;
    const guild = interaction.guild;
    if (!guild) return interaction.reply(ephemeral({ content: '❌ Action réservée à un serveur.' }));

    // Vues éphémères
    if (id === panel.IDS.close) {
      // Sans ce détachement, la carte temps réel (une image par seconde)
      // réécrivait ce message juste après la fermeture : le panneau se
      // « rouvrait » sans boutons. Ici il reste fermé, et `/radio` en reposte un.
      engine.detachPanel(engine.getSession(guild.id));
      return interaction.update(panel.closedPayload());
    }
    if (id === panel.IDS.catalog) {
      return interaction.reply(ephemeral(await catalogPayload(1, stations.ALL_FILTER)));
    }
    if (id === panel.IDS.catClose) {
      return interaction.update(panel.closedPayload({ title: '📋 Catalogue fermé' }));
    }
    if (id.startsWith(`${panel.IDS.catPrev}:`) || id.startsWith(`${panel.IDS.catNext}:`)) {
      const [prefix, rawPage] = id.split(':');
      const page = Number(rawPage) || 1;
      const next = prefix === panel.IDS.catNext ? page + 1 : page - 1;
      return interaction.update(await catalogPayload(next, stations.ALL_FILTER));
    }
    // Boîte à outils du panneau : minuteur, diagnostic, recherche.
    if (id === panel.IDS.search) {
      const modal = new ModalBuilder().setCustomId(panel.MODALS.search).setTitle('Rechercher une station');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('query')
          .setLabel('Nom, genre, pays ou accroche')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('jazz, france, ambient, nova…')
          .setMaxLength(80)
          .setRequired(false),
      ));
      return interaction.showModal(modal);
    }
    if (id === panel.IDS.searchClose || id === panel.IDS.timerClose || id === panel.IDS.diagClose) {
      const titles = {
        [panel.IDS.searchClose]: '🔎 Recherche fermée',
        [panel.IDS.timerClose]: '⏰ Minuteur fermé',
        [panel.IDS.diagClose]: '📊 Diagnostic fermé',
      };
      return interaction.update(panel.closedPayload({ title: titles[id] }));
    }
    if (id === panel.IDS.timer) {
      const session = engine.getSession(guild.id);
      if (!session?.station) {
        return interaction.reply(ephemeral({ content: '📭 Aucune station en diffusion : lance la radio, puis programme son arrêt.' }));
      }
      const verdict = engine.canControl(interaction.member, session.cfg || {}, {
        botChannelId: session.voiceChannelId,
      });
      const refusal = controlRefusal(verdict);
      if (refusal) return interaction.reply(ephemeral({ content: refusal }));
      return interaction.reply(ephemeral(await timerPayload(session, { guildName: guild.name })));
    }
    if (id === panel.IDS.timerOff) {
      const session = engine.getSession(guild.id);
      if (!session) {
        return interaction.reply(ephemeral({ content: '📭 Aucune diffusion en cours.' }));
      }
      const had = engine.clearSleepTimer(session);
      await engine.refreshPanel(session, { notice: had ? '⏱️ Minuteur annulé.' : null }).catch(() => {});
      return interaction.update(await timerPayload(session, {
        guildName: guild.name,
        notice: had ? '⏱️ Minuteur annulé : la radio continue.' : null,
      }));
    }
    if (id === panel.IDS.diag || id === panel.IDS.diagRefresh) {
      const session = engine.getSession(guild.id);
      if (!session) {
        return interaction.reply(ephemeral({ content: '📊 Aucune diffusion à diagnostiquer. Lance une station avec `/radio`.' }));
      }
      const payload = diagnosticPayload(session, { guildName: guild.name });
      return id === panel.IDS.diag
        ? interaction.reply(ephemeral(payload))
        : interaction.update(payload);
    }

    if (id === panel.IDS.favorites) {
      return interaction.reply(ephemeral(await favoritesPayload(guild.id, interaction.user.id, { guildName: guild.name })));
    }
    if (id === panel.IDS.favClose) {
      return interaction.update(panel.closedPayload({ title: '⭐ Favoris fermés' }));
    }
    if (id === panel.IDS.favorite) {
      const session = engine.getSession(guild.id);
      if (!session?.station) {
        return interaction.reply(ephemeral({ content: '📭 Aucune station en cours : lance-en une, puis épingle-la.' }));
      }
      let result;
      try {
        result = await engine.toggleFavorite(guild.id, interaction.user.id, session.station.id);
      } catch (err) {
        console.error('❌ Radio (favori):', err.message);
        return interaction.reply(ephemeral({ content: '⚠️ Favoris indisponibles pour le moment : réessaie dans un instant.' }));
      }
      if (!result.ok) {
        if (result.reason === 'full') {
          return interaction.reply(ephemeral({
            content: `⭐ Tes favoris sont pleins (**${engine.MAX_FAVORITES}**). Retire une station avant d’en ajouter une autre.`,
          }));
        }
        return interaction.reply(ephemeral({ content: '⚠️ Favori impossible pour le moment.' }));
      }
      return interaction.reply(ephemeral({
        content: result.favorite
          ? `⭐ **${result.station.name}** ajoutée à tes favoris (**${result.count}**).`
          : `☆ **${result.station.name}** retirée de tes favoris (**${result.count}**).`,
      }));
    }

    // Réglages (éphémères, administrateurs)
    if (id === panel.IDS.config) {
      if (!isAdmin(interaction)) {
        return interaction.reply(ephemeral({ content: '🛡️ Les réglages sont réservés aux membres avec **Gérer le serveur**.' }));
      }
      const payload = await configPayload(guild);
      return interaction.reply(ephemeral(payload));
    }
    if (id === panel.IDS.cfgClose) {
      return interaction.update(panel.closedPayload({ title: '⚙️ Réglages fermés' }));
    }
    if (id.startsWith('rad_cfg_')) {
      return module.exports.handleConfigButton(interaction);
    }

    // Transport (panneau public)
    const session = engine.getSession(guild.id);
    if (!session?.station) {
      return interaction.reply(ephemeral({ content: '📭 Aucune station en diffusion. Choisis-en une dans le panneau avec `/radio`.' }));
    }
    const verdict = engine.canControl(interaction.member, session.cfg || {}, {
      botChannelId: session.voiceChannelId,
    });
    const refusal = controlRefusal(verdict);
    if (refusal) return interaction.reply(ephemeral({ content: refusal }));

    await interaction.deferUpdate();

    let notice = null;
    try {
      switch (id) {
        case panel.IDS.toggle: {
          const paused = engine.togglePause(session);
          notice = paused ? '⏸️ Direct en pause.' : '▶️ Direct repris.';
          break;
        }
        case panel.IDS.volUp:
        case panel.IDS.volDown: {
          const delta = id === panel.IDS.volUp ? 10 : -10;
          const volume = engine.setVolume(session, session.volume + delta);
          notice = `🔊 Volume : **${volume} %**.`;
          break;
        }
        case panel.IDS.stop: {
          await engine.stop(session);
          return;
        }
        default:
          return interaction.followUp(ephemeral({ content: '❌ Action inconnue.' })).catch(() => {});
      }
    } catch (err) {
      console.error('❌ Radio (bouton):', err.message);
      notice = `⚠️ ${err.message}`;
    }

    await engine.refreshPanel(session, { notice });
  },

  // ── Réglages : boutons ────────────────────────────────────────────────────
  async handleConfigButton(interaction) {
    if (!isAdmin(interaction)) {
      return interaction.reply(ephemeral({ content: '🛡️ Réglages réservés aux administrateurs.' }));
    }

    const guild = interaction.guild;
    const id = interaction.customId;
    const cfg = await engine.getOrCreateConfig(guild.id);
    const session = engine.getSession(guild.id);

    if (id === panel.IDS.cfgVolume) {
      const modal = new ModalBuilder().setCustomId(panel.MODALS.volume).setTitle('Volume par défaut de la radio');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('Volume de 0 à 200 (%)')
          .setStyle(TextInputStyle.Short)
          .setValue(String(Math.round(cfg.defaultVolume ?? 70)))
          .setMaxLength(3)
          .setRequired(true),
      ));
      return interaction.showModal(modal);
    }

    if (id === panel.IDS.cfgTest) {
      await interaction.deferUpdate();
      const target = session?.station || stations.featuredStations()[0];
      let stationTest;
      try {
        const icy = require('../../utils/icyMeta');
        stationTest = { ...(await icy.probeStream(target.url)), stationName: target.name };
      } catch (err) {
        stationTest = { reachable: false, reason: err.message, stationName: target.name };
      }
      const payload = await configPayload(guild, {
        notice: stationTest.reachable
          ? `🔌 **${target.name}** répond : le flux est diffusable.`
          : `🔌 **${target.name}** ne répond pas — ${stationTest.reason || 'aucune réponse'}.`,
        stationTest,
      });
      return interaction.editReply(payload);
    }

    let notice = null;
    if (id === panel.IDS.cfgEnabled) {
      cfg.enabled = !cfg.enabled;
      notice = cfg.enabled ? '✅ Radio activée.' : '⛔ Radio désactivée : plus aucun lancement possible.';
      if (!cfg.enabled && session) await engine.stop(session, { notice: '⛔ La radio a été désactivée par un administrateur.' });
    } else if (id === panel.IDS.cfgNowPlaying) {
      cfg.showNowPlaying = !cfg.showNowPlaying;
      if (session) session.cfg.showNowPlaying = cfg.showNowPlaying;
      notice = cfg.showNowPlaying ? '🎵 Titre en direct affiché.' : '🎵 Titre en direct masqué.';
    } else if (id === panel.IDS.cfgDjOnly) {
      if (!cfg.djRoleId && !cfg.djOnly) {
        return interaction.reply(ephemeral({ content: '🛡️ Choisis d’abord un **rôle DJ** dans le menu ci-dessous.' }));
      }
      cfg.djOnly = !cfg.djOnly;
      if (session) session.cfg.djOnly = cfg.djOnly;
      notice = cfg.djOnly ? '🛡️ Contrôle DJ activé.' : '🛡️ Contrôle DJ désactivé.';
    } else if (id === panel.IDS.cfgPlayer) {
      let updated = null;
      if (session) updated = await engine.refreshPanel(session, { force: true }).catch(() => null);
      return interaction.reply(ephemeral({
        content: updated
          ? '📻 Le panneau public a été mis à jour.'
          : '📻 Ouvre le panneau public avec `/radio`.',
      }));
    } else {
      return interaction.reply(ephemeral({ content: '❌ Réglage inconnu.' })).catch(() => {});
    }

    await cfg.save();
    return interaction.update(await configPayload(guild, { notice }));
  },

  // ── Menus ────────────────────────────────────────────────────────────────
  async handleSelect(interaction) {
    const guild = interaction.guild;
    if (!guild) return;

    // Réglages : salons autorisés et rôle DJ
    if (interaction.customId === panel.IDS.cfgChannels || interaction.customId === panel.IDS.cfgRole) {
      if (!isAdmin(interaction)) {
        return interaction.reply(ephemeral({ content: '🛡️ Réglages réservés aux administrateurs.' }));
      }
      const cfg = await engine.getOrCreateConfig(guild.id);
      let notice;
      if (interaction.customId === panel.IDS.cfgChannels) {
        cfg.channelIds = (interaction.values || []).filter(Boolean).slice(0, 25);
        notice = cfg.channelIds.length
          ? `📍 Radio autorisée dans ${cfg.channelIds.map(channelId => `<#${channelId}>`).join(' · ')}.`
          : '📍 Radio autorisée dans **tous les salons**.';
      } else {
        cfg.djRoleId = interaction.values?.[0] || null;
        if (!cfg.djRoleId) cfg.djOnly = false;
        notice = cfg.djRoleId
          ? `🛡️ Rôle DJ : <@&${cfg.djRoleId}>.`
          : '🛡️ Rôle DJ retiré (contrôle DJ désactivé).';
      }
      await cfg.save();
      return interaction.update(await configPayload(guild, { notice }));
    }

    // Minuteur : durée choisie dans la vue ⏰
    if (interaction.customId === panel.IDS.timerPick) {
      const session = engine.getSession(guild.id);
      if (!session?.station) {
        return interaction.reply(ephemeral({ content: '📭 Aucune diffusion : le minuteur ne peut pas être armé.' }));
      }
      const verdict = engine.canControl(interaction.member, session.cfg || {}, {
        botChannelId: session.voiceChannelId,
      });
      const refusal = controlRefusal(verdict);
      if (refusal) return interaction.reply(ephemeral({ content: refusal }));

      const minutes = Number(interaction.values?.[0]);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return interaction.reply(ephemeral({ content: '⏰ Durée invalide : choisis une durée dans le menu.' }));
      }
      engine.setSleepTimer(session, minutes);
      await engine.refreshPanel(session, {
        notice: `⏰ Arrêt programmé dans ${panel.formatUptime(minutes * 60)}.`,
      }).catch(() => {});
      return interaction.update(await timerPayload(session, {
        guildName: guild.name,
        notice: `⏰ La radio s’arrêtera dans **${panel.formatUptime(minutes * 60)}**.`,
      }));
    }

    // Favoris : lancer la station choisie
    if (interaction.customId === panel.IDS.favPick) {
      const station = stations.getStation(interaction.values?.[0]);
      if (!station) {
        return interaction.reply(ephemeral({ content: '⚠️ Cette station n’existe plus dans le catalogue.' }));
      }
      const voiceChannel = memberVoiceChannel(interaction);
      if (!voiceChannel) {
        return interaction.reply(ephemeral({ content: '🔊 Rejoins un salon vocal pour lancer ce favori.' }));
      }
      await interaction.deferUpdate();
      try {
        await engine.start({
          guild,
          member: interaction.member,
          voiceChannel,
          textChannel: interaction.channel,
          station,
        });
        const refreshed = await favoritesPayload(guild.id, interaction.user.id, {
          notice: `▶️ **${station.name}** est en direct dans <#${voiceChannel.id}>.`,
          guildName: guild.name,
        });
        return interaction.editReply(refreshed);
      } catch (err) {
        console.error('❌ Radio (favori):', err.message);
        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.error)
            .setTitle('❌ Diffusion impossible')
            .setDescription(String(err.message).slice(0, 3900))],
          components: [],
        });
      }
    }

    // Filtre par genre (vue publique, accessible à tous)
    if (interaction.customId === panel.IDS.genre) {
      const requested = interaction.values?.[0];
      const session = engine.getSession(guild.id);
      const filter = session
        ? engine.setFilter(session, requested)
        : (stations.isKnownGenre(requested) ? requested : stations.ALL_FILTER);
      if (session) {
        if (interaction.message && !isEphemeralMessage(interaction)) {
          session.panelMessageId = interaction.message.id;
          session.panelChannelId = interaction.channelId;
        }
        return interaction.update(await engine.buildPanelPayload(session, {
          guild,
          notice: `🎭 Genre : **${stations.filterLabel(filter)}**.`,
        }));
      }
      return interaction.update(await engine.panelPayloadForGuild(guild, { filter }));
    }

    // Choix d'une station dans le panneau public
    if (interaction.customId === panel.IDS.pick) {
      const station = stations.getStation(interaction.values?.[0]);
      if (!station) {
        return interaction.reply(ephemeral({ content: '⚠️ Station inconnue : le catalogue a peut-être changé.' }));
      }
      const session = engine.getSession(guild.id);
      if (session) {
        const verdict = engine.canControl(interaction.member, session.cfg || {}, {
          botChannelId: session.voiceChannelId,
        });
        const refusal = controlRefusal(verdict);
        if (refusal) return interaction.reply(ephemeral({ content: refusal }));
        if (interaction.message && !isEphemeralMessage(interaction)) {
          session.panelMessageId = interaction.message.id;
          session.panelChannelId = interaction.channelId;
        }
        await interaction.deferUpdate();
        await engine.switchStation(session, station);
        return;
      }

      // Aucune session : on démarre depuis le salon vocal de l'auteur.
      const voiceChannel = memberVoiceChannel(interaction);
      if (!voiceChannel) {
        return interaction.reply(ephemeral({ content: '🔊 Rejoins un salon vocal pour lancer la radio.' }));
      }
      await interaction.deferUpdate();
      try {
        const { session: active } = await engine.start({
          guild,
          member: interaction.member,
          voiceChannel,
          textChannel: interaction.channel,
          station,
        });
        const payload = await engine.buildPanelPayload(active, {
          guild,
          notice: `📻 **${station.name}** — ${station.tagline}`,
        });
        // Résultat de recherche (message éphémère) : on confirme, on ne
        // transforme pas une réponse privée en second panneau public.
        if (interaction.message && !isEphemeralMessage(interaction)) {
          active.panelMessageId = interaction.message.id;
          active.panelChannelId = interaction.channelId;
          return interaction.editReply(payload);
        }
        return interaction.editReply({
          content: `📻 **${station.name}** est en direct dans <#${voiceChannel.id}>. Ouvre le panneau avec \`/radio\`.`,
          embeds: [],
          components: [],
        });
      } catch (err) {
        console.error('❌ Radio (menu):', err.message);
        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.error)
            .setTitle('❌ Diffusion impossible')
            .setDescription(String(err.message).slice(0, 3900))],
          components: [],
        });
      }
    }
  },

  // ── Modales ───────────────────────────────────────────────────────────────
  async handleModal(interaction) {
    // Recherche de station : la modale autorise une saisie libre, que les
    // menus Discord ne permettent pas.
    if (interaction.customId === panel.MODALS.search) {
      const raw = String(interaction.fields.getTextInputValue('query') || '').trim();
      const results = raw ? stations.searchStations(raw, { limit: 25 }) : stations.featuredStations();
      return interaction.reply(ephemeral(searchPayload(raw, results)));
    }

    if (interaction.customId !== panel.MODALS.volume) return;
    if (!isAdmin(interaction)) {
      return interaction.reply(ephemeral({ content: '🛡️ Réglages réservés aux administrateurs.' }));
    }

    const raw = String(interaction.fields.getTextInputValue('value') || '').trim();
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 200) {
      return interaction.reply(ephemeral({ content: '❌ Volume invalide : indique un nombre entier entre **0** et **200**.' }));
    }

    const cfg = await engine.getOrCreateConfig(interaction.guild.id);
    cfg.defaultVolume = Number(raw);
    await cfg.save();

    const session = engine.getSession(interaction.guild.id);
    if (session) {
      session.cfg.defaultVolume = cfg.defaultVolume;
      engine.setVolume(session, cfg.defaultVolume);
    }

    return interaction.update(await configPayload(interaction.guild, {
      notice: `🔊 Volume par défaut : **${cfg.defaultVolume} %**.`,
    }));
  },
};
