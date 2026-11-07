'use strict';
// commands/musique/musique.js — 🎵 Module musique (alternative à Lavalink).
//
// `/musique recherche:<titre ou lien>` rejoint le vocal de l'auteur, cherche le
// morceau et affiche LE panneau du serveur : carte « en lecture », boutons de
// transport, file d'attente, réglages. Aucune commande séparée à retenir.
//
// Points de conception :
//   • un seul message-panneau par serveur (édité en place, jamais spammé) ;
//   • tout le monde peut ajouter un morceau ; les contrôles peuvent être
//     réservés au rôle DJ (réglages) ;
//   • les erreurs yt-dlp (vidéo privée, blocage YouTube…) sont traduites.

const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags,
  ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');

const engine = require('../../utils/musicEngine');
const radioEngine = require('../../utils/radioEngine');
const { ensureMediaTools, MediaToolError } = require('../../utils/mediaTools');
const { clampVolume } = require('../../utils/musicQueue');
const { COLORS } = require('../../utils/embeds');
const brand = require('../../utils/brand');

const HELP_TEXT = [
  '**`/musique recherche:<titre ou lien>`** — ajoute un morceau (ou une playlist) et rejoint ton salon vocal.',
  '',
  '• **Liens acceptés** : YouTube (vidéo, playlist), SoundCloud (titre, set), Spotify (piste — la correspondance YouTube est jouée), liens directs.',
  '• **File** : jusqu’à 100 morceaux (réglable), boucle morceau/file, mélange, retour arrière, saut direct.',
  '• **Autoplay** : quand la file se vide, le bot enchaîne des morceaux proches du dernier titre.',
  '• **Anti-coupure** : en cas de souci réseau, le morceau est repris une fois avant d’être passé — jamais de saut pour rien.',
  '• **Carte** : pochette, progression, demandeur, volume, boucle et taille de file, rafraîchie toutes les 20 s.',
  '• **Sans Lavalink** : extraction locale par yt-dlp + ffmpeg (installés dans `bin/` par `npm run music:setup`).',
].join('\n');

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setAuthor({ name: brand.footer('Musique') })
    .setTitle('🎧 Musique — mode d’emploi')
    .setDescription(HELP_TEXT.slice(0, 3900))
    .setFooter({ text: brand.footer('Musique • sans Lavalink') });
}

function closedPanel() {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.info)
      .setAuthor({ name: brand.footer('Musique') })
      .setTitle('🎵 Panneau fermé')
      .setDescription('La lecture continue. Rouvre le panneau avec `/musique` (sans option) ou le bouton **File**.')],
    components: [],
  };
}

function controlRefusal(verdict) {
  if (verdict.ok) return null;
  if (verdict.reason === 'dj') return '🛡️ Le contrôle DJ est actif : seuls les membres du rôle DJ (ou les modérateurs) peuvent piloter la lecture.';
  if (verdict.reason === 'voice') return '🔊 Tu dois être dans le **même salon vocal** que le bot pour piloter la lecture.';
  return '🔊 Rejoins d’abord un salon vocal.';
}

function memberVoiceChannel(interaction) {
  return interaction.member?.voice?.channel || null;
}

function botCanSpeak(channel, guild) {
  const me = guild.members.me;
  if (!me) return true;
  const perms = channel.permissionsFor?.(me);
  if (!perms) return true;
  return perms.has(PermissionFlagsBits.Connect) && perms.has(PermissionFlagsBits.Speak);
}

module.exports = {
  HELP_TEXT,
  helpEmbed,

  data: new SlashCommandBuilder()
    .setName('musique')
    .setDescription('🎵 Musique — lecture, file d’attente et carte « en lecture »')
    .addStringOption(option => option
      .setName('recherche')
      .setDescription('Titre à chercher ou lien (YouTube, SoundCloud, Spotify, playlist)')
      .setRequired(false)
      .setMaxLength(400))
    .addIntegerOption(option => option
      .setName('volume')
      .setDescription('Volume de 0 à 200 % (contrôle DJ)')
      .setRequired(false)
      .setMinValue(0)
      .setMaxValue(200)),

  // ── Commande ──────────────────────────────────────────────────────────────
  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ La musique se lance depuis un serveur.', flags: MessageFlags.Ephemeral });
    }

    const query = interaction.options.getString('recherche');
    const volumeOption = interaction.options.getInteger('volume');
    const session = engine.getSession(interaction.guild.id);

    // Réglage de volume seul
    if (volumeOption !== null && volumeOption !== undefined && !query) {
      if (!session) {
        return interaction.reply({ content: '❌ Rien en lecture : lance d’abord un morceau.', flags: MessageFlags.Ephemeral });
      }
      const verdict = engine.canControl(interaction.member, session.cfg || {}, {
        botChannelId: session.voiceChannelId,
      });
      const refusal = controlRefusal(verdict);
      if (refusal) return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });

      const volume = engine.setVolume(session, volumeOption);
      await engine.refreshPanel(session, { notice: `🔊 Volume réglé à **${volume} %**.` });
      return interaction.reply({ content: `🔊 Volume : **${volume} %**.`, flags: MessageFlags.Ephemeral });
    }

    // Panneau seul
    if (!query) {
      if (session) {
        await engine.refreshPanel(session);
        return interaction.reply({ content: '🎵 Panneau mis à jour ci-dessus.', flags: MessageFlags.Ephemeral });
      }
      const payload = await engine.panelPayloadForGuild(interaction.guild, { page: 'player' });
      return interaction.reply({ ...payload, fetchReply: true });
    }

    // Lecture
    const voiceChannel = memberVoiceChannel(interaction);
    if (!voiceChannel) {
      return interaction.reply({
        content: '🔊 Rejoins d’abord un **salon vocal** : le bot s’y connecte pour jouer le morceau.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (voiceChannel.type === ChannelType.GuildStageVoice && !voiceChannel.speakable) {
      return interaction.reply({
        content: '🎙️ Ce salon est une **scène** : donne au bot la permission de parler, puis réessaie.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!botCanSpeak(voiceChannel, interaction.guild)) {
      return interaction.reply({
        content: `🔒 Il me manque **Se connecter** ou **Parler** dans <#${voiceChannel.id}>.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Ne jamais arracher le bot à un salon où il joue déjà : la musique des
    // autres membres s'arrêterait sans prévenir.
    if (session?.voiceChannelId && session.voiceChannelId !== voiceChannel.id && session.queue.current) {
      return interaction.reply({
        content: `🔊 Je joue déjà dans <#${session.voiceChannelId}>. Rejoins ce salon, ou arrête la lecture (bouton **Arrêter**).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Une seule connexion vocale par serveur : lancer la musique coupe la
    // radio si elle diffusait déjà. La dernière commande prend la main.
    const radioSession = radioEngine.getSession(interaction.guild.id);
    if (radioSession) await radioEngine.destroySession(radioSession, { reason: 'musique', silent: true });

    await interaction.deferReply();

    try {
      const result = await engine.play({
        guild: interaction.guild,
        member: interaction.member,
        voiceChannel,
        textChannel: interaction.channel,
        query,
      });

      const { kind, added, rejected, started } = result;
      const bits = [];
      if (kind === 'playlist') bits.push(`📚 Playlist : **${added}** morceau(x) ajouté(s)`);
      else if (added > 1) bits.push(`🔎 **${added}** résultats ajoutés à la file`);
      else bits.push(`🎵 **${result.tracks[0]?.title || query}** ajouté`);

      if (rejected > 0) bits.push(`⚠️ ${rejected} morceau(x) ignoré(s) : file pleine (${result.session.queue.maxQueue})`);
      if (!started && result.session.queue.current) bits.push('▶️ Lecture en cours');

      const notice = bits.join(' • ');

      // Un seul panneau par serveur : s'il existe déjà, on l'édite et on
      // confirme brièvement, au lieu de semer un deuxième message.
      if (result.session.panelMessageId) {
        await engine.refreshPanel(result.session, { notice });
        return interaction.editReply({ content: notice });
      }

      const payload = await engine.buildPanelPayload(result.session, {
        notice,
        guild: interaction.guild,
      });
      const message = await interaction.editReply(payload);
      engine.attachPanel(result.session, message, interaction.channelId);
      return message;
    } catch (err) {
      console.error('❌ Musique (/musique):', err.message);
      const description = err instanceof MediaToolError
        ? `${err.message}\n\nSur la machine du bot : \`npm run music:setup\` puis relance.`
        : err.message;
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.error)
          .setAuthor({ name: brand.footer('Musique') })
          .setTitle('❌ Lecture impossible')
          .setDescription(String(description).slice(0, 3900))
          .setFooter({ text: brand.footer('Musique • vérifie le lien, ou réessaie') })],
        components: [],
      });
    }
  },

  // ── Boutons ───────────────────────────────────────────────────────────────
  async handleButton(interaction) {
    const id = interaction.customId;
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: '❌ Action réservée à un serveur.', flags: MessageFlags.Ephemeral });

    if (id === 'mus_close') {
      return interaction.update(closedPanel());
    }

    if (id === 'mus_help') {
      return interaction.reply({ embeds: [helpEmbed()], flags: MessageFlags.Ephemeral });
    }

    // ── Réglages (éphémère) ────────────────────────────────────────────────
    if (id === 'mus_config') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: '🛡️ Les réglages sont réservés aux membres avec **Gérer le serveur**.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const { payload } = await engine.configPanelForGuild(guild);
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }

    if (id === 'mus_setup') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '🛡️ Action réservée aux administrateurs.', flags: MessageFlags.Ephemeral });
      }
      await interaction.reply({ content: '🧰 Vérification / installation des outils audio…', flags: MessageFlags.Ephemeral });
      const tools = await ensureMediaTools({ download: true });
      const { payload } = await engine.configPanelForGuild(guild, {
        notice: tools.ready
          ? `✅ Outils prêts : yt-dlp \`${tools.ytdlp.version}\`, ffmpeg \`${String(tools.ffmpeg.version).split(' ')[0]}\`.`
          : `❌ Installation incomplète — ${[!tools.ytdlp.path && 'yt-dlp', !tools.ffmpeg.path && 'ffmpeg'].filter(Boolean).join(', ')}. Lance \`npm run music:setup\` sur la machine du bot.`,
      });
      // On met à jour LE message éphémère des réglages (embed + boutons) et on
      // y ajoute le résultat : un second editReply effacerait le panneau.
      return interaction.editReply({
        ...payload,
        content: tools.ready
          ? `✅ Outils audio prêts.\n• yt-dlp : \`${tools.ytdlp.version}\`\n• ffmpeg : \`${String(tools.ffmpeg.version).split(' ')[0]}\``
          : `❌ Outils manquants :\n• yt-dlp : ${tools.ytdlp.path || 'absent'}\n• ffmpeg : ${tools.ffmpeg.path || 'absent'}\n\nLance \`npm run music:setup\` sur la machine du bot.`,
      });
    }

    if (id === 'mus_autoplay' || id === 'mus_announce' || id === 'mus_djonly') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '🛡️ Réglages réservés aux administrateurs.', flags: MessageFlags.Ephemeral });
      }
      const cfg = await engine.getOrCreateConfig(guild.id);
      if (id === 'mus_autoplay') cfg.autoplay = !cfg.autoplay;
      if (id === 'mus_announce') cfg.announce = !cfg.announce;
      if (id === 'mus_djonly') {
        if (!cfg.djRoleId && !cfg.djOnly) {
          return interaction.reply({ content: '🛡️ Choisis d’abord un **rôle DJ** dans le menu ci-dessous.', flags: MessageFlags.Ephemeral });
        }
        cfg.djOnly = !cfg.djOnly;
      }
      await cfg.save();

      const session = engine.getSession(guild.id);
      if (session && id === 'mus_autoplay') session.queue.autoplay = Boolean(cfg.autoplay);

      const { payload } = await engine.configPanelForGuild(guild, {
        notice: id === 'mus_autoplay'
          ? `♾️ Autoplay ${cfg.autoplay ? 'activé' : 'désactivé'}.`
          : id === 'mus_announce'
            ? `📣 Annonce des morceaux ${cfg.announce ? 'activée' : 'désactivée'}.`
            : `🛡️ Contrôle DJ ${cfg.djOnly ? 'activé' : 'désactivé'}.`,
      });
      return interaction.update(payload);
    }

    if (id === 'mus_defvol') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '🛡️ Réglages réservés aux administrateurs.', flags: MessageFlags.Ephemeral });
      }
      const cfg = await engine.getOrCreateConfig(guild.id);
      const modal = new ModalBuilder().setCustomId('mus_defvol_modal').setTitle('Volume par défaut');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('Volume de 0 à 200 (%)')
          .setStyle(TextInputStyle.Short)
          .setValue(String(Math.round(cfg.defaultVolume)))
          .setMaxLength(3)
          .setRequired(true),
      ));
      return interaction.showModal(modal);
    }

    // ── Contrôles de lecture (panneau public) ──────────────────────────────
    const session = engine.getSession(guild.id);
    if (!session) {
      return interaction.reply({
        content: '📭 Aucune session musique active. Lance un morceau avec `/musique recherche:…`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const controlIds = new Set(['mus_toggle', 'mus_skip', 'mus_prev', 'mus_loop', 'mus_shuffle', 'mus_volup', 'mus_voldown', 'mus_stop', 'mus_jump']);
    if (controlIds.has(id)) {
      const verdict = engine.canControl(interaction.member, session.cfg || {}, {
        botChannelId: session.voiceChannelId,
      });
      const refusal = controlRefusal(verdict);
      if (refusal) return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });
    }

    if (!session.queue.current && !['mus_queue', 'mus_player'].includes(id)) {
      return interaction.reply({ content: '📭 Rien en lecture pour le moment.', flags: MessageFlags.Ephemeral });
    }

    // Le panneau peut avoir été ouvert par une commande : on le rattache.
    if (interaction.message) {
      session.panelMessageId = interaction.message.id;
      session.panelChannelId = interaction.channelId;
    }

    await interaction.deferUpdate();

    let notice = null;
    try {
      switch (id) {
        case 'mus_toggle': {
          const paused = await engine.togglePause(session);
          notice = paused ? '⏸️ Lecture en pause.' : '▶️ Lecture reprise.';
          break;
        }
        case 'mus_skip': {
          const track = await engine.skip(session);
          notice = track ? `⏭️ **${track.title}**` : '📭 Plus rien dans la file.';
          break;
        }
        case 'mus_prev': {
          const track = await engine.previous(session);
          notice = track ? `⏮️ **${track.title}**` : '⏮️ Aucun morceau précédent.';
          break;
        }
        case 'mus_loop': {
          const mode = engine.cycleLoop(session);
          notice = mode === 'off' ? '➡️ Boucle désactivée.' : mode === 'track' ? '🔂 Boucle sur le morceau.' : '🔁 Boucle sur la file.';
          break;
        }
        case 'mus_shuffle': {
          const count = engine.shuffle(session);
          notice = count ? `🔀 **${count}** morceau(x) mélangé(s).` : '🔀 Rien à mélanger.';
          break;
        }
        case 'mus_volup':
        case 'mus_voldown': {
          const delta = id === 'mus_volup' ? 10 : -10;
          const volume = engine.setVolume(session, session.queue.volume + delta);
          notice = `🔊 Volume : **${volume} %**.`;
          break;
        }
        case 'mus_stop': {
          await engine.stop(session);
          return;
        }
        case 'mus_queue': {
          session.modes.page = 'queue';
          session.modes.pageNumber = 1;
          break;
        }
        case 'mus_player': {
          session.modes.page = 'player';
          break;
        }
        case 'mus_page_prev':
        case 'mus_page_next': {
          session.modes.page = 'queue';
          session.modes.pageNumber = Math.max(1, (session.modes.pageNumber || 1) + (id === 'mus_page_next' ? 1 : -1));
          break;
        }
        case 'mus_jump': {
          const track = await engine.jumpTo(session, interaction.values?.[0]);
          notice = track ? `⏭️ **${track.title}**` : '⚠️ Saut impossible.';
          break;
        }
        default:
          return interaction.followUp({ content: '❌ Action inconnue.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    } catch (err) {
      console.error('❌ Musique (bouton):', err.message);
      notice = `⚠️ ${err.message}`;
    }

    await engine.refreshPanel(session, { notice });
  },

  // ── Sélecteurs ────────────────────────────────────────────────────────────
  async handleSelect(interaction) {
    const guild = interaction.guild;
    if (!guild) return;

    if (interaction.customId === 'mus_jump') {
      const session = engine.getSession(guild.id);
      if (!session) {
        return interaction.reply({ content: '📭 Aucune session active.', flags: MessageFlags.Ephemeral });
      }
      const verdict = engine.canControl(interaction.member, session.cfg || {}, {
        botChannelId: session.voiceChannelId,
      });
      const refusal = controlRefusal(verdict);
      if (refusal) return interaction.reply({ content: refusal, flags: MessageFlags.Ephemeral });

      await interaction.deferUpdate();
      const track = await engine.jumpTo(session, interaction.values?.[0]);
      return engine.refreshPanel(session, { notice: track ? `⏭️ **${track.title}**` : '⚠️ Saut impossible.' });
    }

    if (interaction.customId === 'mus_dj') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '🛡️ Réglages réservés aux administrateurs.', flags: MessageFlags.Ephemeral });
      }
      const cfg = await engine.getOrCreateConfig(guild.id);
      cfg.djRoleId = interaction.values?.[0] || null;
      if (!cfg.djRoleId) cfg.djOnly = false; // pas de rôle → pas de contrôle
      await cfg.save();

      const { payload } = await engine.configPanelForGuild(guild, {
        notice: cfg.djRoleId ? `🛡️ Rôle DJ : <@&${cfg.djRoleId}>.` : '🛡️ Rôle DJ retiré (contrôle DJ désactivé).',
      });
      return interaction.update(payload);
    }
  },

  // ── Modales ───────────────────────────────────────────────────────────────
  async handleModal(interaction) {
    if (interaction.customId !== 'mus_defvol_modal') return;

    const raw = String(interaction.fields.getTextInputValue('value') || '').trim();
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 200) {
      return interaction.reply({ content: '❌ Volume invalide : indique un nombre entier entre **0** et **200**.', flags: MessageFlags.Ephemeral });
    }
    const cfg = await engine.getOrCreateConfig(interaction.guild.id);
    cfg.defaultVolume = clampVolume(Number(raw));
    await cfg.save();

    const { payload } = await engine.configPanelForGuild(interaction.guild, {
      notice: `🔊 Volume par défaut : **${cfg.defaultVolume} %**.`,
    });
    return interaction.update(payload);
  },
};
