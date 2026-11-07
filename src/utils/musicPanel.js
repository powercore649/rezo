'use strict';
// utils/musicPanel.js — Embeds et boutons du panneau musique.
//
// Le panneau est PUBLIC (contrairement aux panneaux de configuration) : toute
// la table peut voir la file et voter pour passer un morceau. Les restrictions
// (même salon vocal, rôle DJ) sont appliquées dans le moteur, pas ici : ce
// module ne fait que composer l'affichage, ce qui le rend testable seul.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
} = require('discord.js');
const { COLORS } = require('./embeds');
const brand = require('./brand');
const { formatTime, LOOP_LABEL } = require('./musicQueue');
const { sourceLabel } = require('./mediaTools');

const QUEUE_PAGE_SIZE = 10;
const SELECT_PAGE_SIZE = 25;

const LOOP_EMOJI = { off: '➡️', track: '🔂', queue: '🔁' };

function clip(text, max = 60) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function trackLine(track, index, { withRequester = false } = {}) {
  const link = track.url ? `[${clip(track.title, 64)}](${track.url})` : clip(track.title, 64);
  const duration = track.live ? 'LIVE' : formatTime(track.duration);
  const who = withRequester && track.requesterId ? ` — <@${track.requesterId}>` : '';
  return `\`${String(index).padStart(2, '0')}.\` ${link} · *${clip(track.artist, 34)}* · \`${duration}\`${who}`;
}

function playerEmbed(snapshot, { guildName = null, notice = null } = {}) {
  const track = snapshot.current;
  const progress = snapshot.progress || { elapsed: '0:00', total: '0:00', bar: '' };

  if (!track) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setAuthor({ name: brand.footer('Musique') })
      .setTitle('🎧 Rien en lecture')
      .setDescription([
        notice || '',
        'Ajoute un morceau avec `/musique recherche:<titre ou lien>` — le bot rejoint ton salon vocal.',
        '',
        'Sources : **YouTube**, **SoundCloud**, **Spotify** (correspondance), liens directs, playlists.',
      ].filter(Boolean).join('\n'))
      .setFooter({ text: brand.footer('Musique • file vide') });
    return embed;
  }

  const lines = [
    `**[${clip(track.title, 90)}](${track.url})**`,
    `*${clip(track.artist, 80)}*`,
    '',
    `\`${progress.elapsed}\` ${progress.bar} \`${progress.total}\``,
  ];
  if (snapshot.paused) lines.push('', '⏸️ **En pause** — `Reprendre` relance la lecture.');

  const embed = new EmbedBuilder()
    .setColor(snapshot.paused ? COLORS.warning : COLORS.primary)
    .setAuthor({ name: brand.footer('Musique') })
    .setTitle(snapshot.paused ? '⏸️ En pause' : '🎵 En lecture')
    .setDescription(lines.join('\n').slice(0, 3900))
    .addFields(
      { name: 'Demandé par', value: track.requesterId ? `<@${track.requesterId}>` : '*Inconnu*', inline: true },
      { name: 'Source', value: sourceLabel(track.source), inline: true },
      { name: 'File', value: `${Math.max(0, snapshot.size - 1)} morceau(x)`, inline: true },
      { name: 'Boucle', value: `${LOOP_EMOJI[snapshot.loop] || '➡️'} ${LOOP_LABEL[snapshot.loop] || 'Désactivée'}`, inline: true },
      { name: 'Volume', value: `🔊 **${Math.round(snapshot.volume)} %**`, inline: true },
      { name: 'Autoplay', value: snapshot.autoplay ? '✅ activé' : '❌ désactivé', inline: true },
    )
    .setFooter({ text: brand.footer(`Musique${guildName ? ` • ${guildName}` : ''}`) });

  const upcoming = (snapshot.upcoming || []).slice(0, 3);
  if (upcoming.length) {
    embed.addFields({
      name: 'À suivre',
      value: upcoming.map((item, i) => trackLine(item, i + 1, { withRequester: true })).join('\n').slice(0, 1024),
    });
  }
  if (notice) embed.setDescription(`${notice}\n\n${embed.data.description}`.slice(0, 4000));

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

function playerComponents(snapshot) {
  const hasTrack = Boolean(snapshot.current);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mus_toggle')
      .setEmoji(hasTrack && !snapshot.paused ? '⏸️' : '▶️')
      .setLabel(hasTrack && !snapshot.paused ? 'Pause' : 'Lecture')
      .setStyle(hasTrack && !snapshot.paused ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(!hasTrack),
    new ButtonBuilder()
      .setCustomId('mus_prev')
      .setEmoji('⏮️')
      .setLabel('Précédent')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!snapshot.history?.length),
    new ButtonBuilder()
      .setCustomId('mus_skip')
      .setEmoji('⏭️')
      .setLabel('Passer')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasTrack),
    new ButtonBuilder()
      .setCustomId('mus_loop')
      .setEmoji(LOOP_EMOJI[snapshot.loop] || '➡️')
      .setLabel('Boucle')
      .setStyle(snapshot.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('mus_shuffle')
      .setEmoji('🔀')
      .setLabel('Mélanger')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled((snapshot.upcoming?.length || 0) < 2),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mus_voldown').setEmoji('🔉').setLabel('-10 %').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mus_volup').setEmoji('🔊').setLabel('+10 %').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mus_queue').setEmoji('📜').setLabel('File').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mus_stop').setEmoji('⏹️').setLabel('Arrêter').setStyle(ButtonStyle.Danger).setDisabled(!hasTrack),
    new ButtonBuilder().setCustomId('mus_config').setEmoji('⚙️').setLabel('Réglages').setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

function queueEmbed(snapshot, { page = 1, notice = null } = {}) {
  const upcoming = snapshot.upcoming || [];
  const pages = Math.max(1, Math.ceil(upcoming.length / QUEUE_PAGE_SIZE));
  const current = Math.max(1, Math.min(pages, Math.round(Number(page) || 1)));
  const slice = upcoming.slice((current - 1) * QUEUE_PAGE_SIZE, current * QUEUE_PAGE_SIZE);

  const lines = [];
  if (snapshot.current) lines.push(`**En lecture**\n${trackLine(snapshot.current, 0)}`);
  lines.push('');
  lines.push(slice.length ? slice.map((track, i) => trackLine(track, (current - 1) * QUEUE_PAGE_SIZE + i + 1, { withRequester: true })).join('\n') : '*Aucun morceau en attente.*');

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setAuthor({ name: brand.footer('Musique • File d’attente') })
    .setTitle('📜 File d’attente')
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({
      text: brand.footer(`Page ${current}/${pages} • ${upcoming.length} morceau(x) • Boucle ${LOOP_LABEL[snapshot.loop] || 'off'}`),
    });

  if (notice) embed.setDescription(`${notice}\n\n${embed.data.description}`.slice(0, 4000));
  return embed;
}

function queueComponents(snapshot, { page = 1 } = {}) {
  const upcoming = snapshot.upcoming || [];
  const pages = Math.max(1, Math.ceil(upcoming.length / QUEUE_PAGE_SIZE));
  const current = Math.max(1, Math.min(pages, Math.round(Number(page) || 1)));
  const start = (current - 1) * QUEUE_PAGE_SIZE;
  const slice = upcoming.slice(start, start + SELECT_PAGE_SIZE);

  const rows = [];

  if (slice.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('mus_jump')
      .setPlaceholder('Sauter directement à un morceau…')
      .addOptions(slice.map((track, i) => ({
        label: clip(track.title, 90),
        description: clip(`${track.artist} • ${track.live ? 'LIVE' : formatTime(track.duration)}`, 90),
        value: String(start + i + 1),
      })));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mus_page_prev').setEmoji('◀️').setLabel('Page').setStyle(ButtonStyle.Secondary).setDisabled(current <= 1),
    new ButtonBuilder().setCustomId('mus_player').setEmoji('🎵').setLabel('Lecteur').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mus_page_next').setEmoji('▶️').setLabel('Page').setStyle(ButtonStyle.Secondary).setDisabled(current >= pages),
    new ButtonBuilder().setCustomId('mus_stop').setEmoji('⏹️').setLabel('Arrêter').setStyle(ButtonStyle.Danger).setDisabled(!snapshot.current),
  ));

  return rows;
}

function configEmbed(cfg, { tools = null, notice = null, guild = null } = {}) {
  const ready = Boolean(tools?.ready);
  const toolLine = [
    `**yt-dlp** — ${tools?.ytdlp?.version ? `\`${tools.ytdlp.version}\`` : '❌ absent'}`,
    `**ffmpeg** — ${tools?.ffmpeg?.version ? `\`${String(tools.ffmpeg.version).split(' ')[0]}\`` : '❌ absent'}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(ready ? COLORS.primary : COLORS.warning)
    .setAuthor({ name: brand.footer('Musique • Réglages') })
    .setTitle('⚙️ Réglages du module musique')
    .setDescription([
      notice || '',
      ready
        ? '✅ Moteur audio prêt (aucun serveur Lavalink : extraction locale yt-dlp + ffmpeg).'
        : '⚠️ Outils audio incomplets : la lecture échouera. Utilise **Installer les outils** ci-dessous.',
      '',
      '**Contrôle DJ** — quand il est actif, seuls le rôle DJ et les modérateurs peuvent passer, arrêter, relancer ou changer le volume. Tout le monde peut ajouter des morceaux.',
    ].filter(Boolean).join('\n'))
    .addFields(
      { name: 'Rôle DJ', value: cfg.djRoleId ? `<@&${cfg.djRoleId}>` : '*Aucun*', inline: true },
      { name: 'Contrôle DJ', value: cfg.djOnly ? '✅ actif' : '❌ inactif', inline: true },
      { name: 'Volume par défaut', value: `**${Math.round(cfg.defaultVolume)} %**`, inline: true },
      { name: 'Autoplay', value: cfg.autoplay ? '✅ activé' : '❌ désactivé', inline: true },
      { name: 'Annonce des morceaux', value: cfg.announce ? '✅ carte publiée' : '❌ silencieux', inline: true },
      { name: 'File maximale', value: `${cfg.maxQueue} morceaux`, inline: true },
      { name: '🧰 Outils audio', value: toolLine },
    )
    .setFooter({ text: brand.footer('Musique • alternative à Lavalink') });

  if (guild?.iconURL) {
    const icon = guild.iconURL({ size: 128 });
    if (icon) embed.setThumbnail(icon);
  }
  return embed;
}

function configComponents(cfg, { ready = true } = {}) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mus_autoplay')
      .setEmoji(cfg.autoplay ? '✅' : '❌')
      .setLabel('Autoplay')
      .setStyle(cfg.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mus_announce')
      .setEmoji(cfg.announce ? '📣' : '🔇')
      .setLabel('Annonce')
      .setStyle(cfg.announce ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mus_djonly')
      .setEmoji('🛡️')
      .setLabel('Contrôle DJ')
      .setStyle(cfg.djOnly ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('mus_defvol').setEmoji('🔊').setLabel('Volume défaut').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('mus_dj')
      .setPlaceholder('🛡️ Choisir le rôle DJ (optionnel)')
      .setMinValues(0)
      .setMaxValues(1),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mus_setup')
      .setEmoji('🧰')
      .setLabel(ready ? 'Revérifier les outils' : 'Installer les outils')
      .setStyle(ready ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mus_player').setEmoji('🎵').setLabel('Lecteur').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mus_close').setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3];
}

module.exports = {
  QUEUE_PAGE_SIZE,
  playerEmbed,
  playerComponents,
  queueEmbed,
  queueComponents,
  configEmbed,
  configComponents,
  trackLine,
  clip,
};
