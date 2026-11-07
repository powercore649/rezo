'use strict';
// utils/bridgePanel.js — Rendu du panneau du pont inter-serveurs.
//
// Tout est pur : on reçoit une configuration et on renvoie un embed + des
// composants. La commande ne fait que brancher les interactions dessus, ce qui
// permet de vérifier les limites Discord (5 rangées, 5 boutons, 25 options,
// 100 caractères par identifiant) sans lancer de bot.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
} = require('discord.js');
const { COLORS } = require('./embeds');
const hubs = require('./bridgeHubs');
const { DEFAULTS } = require('./bridgeEngine');

const IDS = {
  channel: 'pont_channel',
  hub: 'pont_hub',
  toggle: 'pont_toggle',
  filters: 'pont_view_filters',
  blocks: 'pont_view_blocks',
  network: 'pont_view_network',
  antispam: 'pont_antispam',
  block: 'pont_block',
  unblock: 'pont_unblock',
  unlink: 'pont_unlink',
  unlinkConfirm: 'pont_unlink_confirm',
  back: 'pont_back',
  refresh: 'pont_refresh',
};

const TOGGLES = [
  { field: 'showServerName', id: 'pont_toggle_showServerName', label: 'Nom du serveur' },
  { field: 'blockLinks', id: 'pont_toggle_blockLinks', label: 'Liens' },
  { field: 'blockInvites', id: 'pont_toggle_blockInvites', label: 'Invitations' },
  { field: 'blockAttachments', id: 'pont_toggle_blockAttachments', label: 'Pièces jointes' },
  { field: 'blockBots', id: 'pont_toggle_blockBots', label: 'Bots' },
];

// Les trois préréglages d'anti-spam : un menu plutôt qu'un formulaire, parce
// qu'un administrateur veut décider vite, pas saisir quatre nombres.
const ANTISPAM_PRESETS = [
  { id: 'souple', label: 'Souple', description: '6 messages / 20 s', rateLimit: 6, rateWindowSeconds: 20 },
  { id: 'normal', label: 'Normal', description: '4 messages / 15 s', rateLimit: 4, rateWindowSeconds: 15 },
  { id: 'strict', label: 'Strict', description: '2 messages / 10 s', rateLimit: 2, rateWindowSeconds: 10 },
  { id: 'extreme', label: 'Très strict', description: '1 message / 20 s', rateLimit: 1, rateWindowSeconds: 20 },
];

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function value(cfg, key) {
  const raw = cfg ? cfg[key] : undefined;
  return raw === undefined || raw === null ? DEFAULTS[key] : raw;
}

function channelLabel(cfg, guild) {
  const id = cfg?.channelId;
  if (!id) return '*Aucun salon relié*';
  const channel = guild?.channels?.cache?.get?.(id);
  if (channel?.name) return `#${channel.name}`;
  return `<#${id}> *(introuvable)*`;
}

function presetOf(cfg) {
  const limit = Number(value(cfg, 'rateLimit'));
  const window = Number(value(cfg, 'rateWindowSeconds'));
  return ANTISPAM_PRESETS.find(preset => preset.rateLimit === limit && preset.rateWindowSeconds === window) || null;
}

function blockedCount(cfg) {
  return Array.isArray(cfg?.blockedGuilds) ? cfg.blockedGuilds.length : 0;
}

function stateText(cfg) {
  if (value(cfg, 'enabled') === true && cfg?.channelId) return '🟢 **Relié** — les messages circulent.';
  if (cfg?.channelId) return '🟡 **Salon enregistré**, pont en pause.';
  return '🔴 **Non relié** — choisis un salon ci-dessous pour commencer.';
}

function buildPanelEmbed(cfg, { guild = null, note = null } = {}) {
  const hub = hubs.hubById(value(cfg, 'hub')) || hubs.HUBS[0];
  const preset = presetOf(cfg);
  const last = cfg?.lastRelayAt ? Math.floor(new Date(cfg.lastRelayAt).getTime() / 1000) : null;

  const fields = [
    { name: '📌 Salon local', value: channelLabel(cfg, guild), inline: true },
    { name: '🌍 Canal commun', value: hubs.hubLabel(hub.id), inline: true },
    { name: '🚦 État', value: value(cfg, 'enabled') ? '🟢 Actif' : '🔴 En pause', inline: true },
    { name: '🏷️ Nom du serveur', value: value(cfg, 'showServerName') ? '🟢 affiché sous le message' : '🔴 masqué', inline: true },
    { name: '🔗 Liens', value: value(cfg, 'blockLinks') ? '🔴 bloqués' : '🟢 autorisés', inline: true },
    { name: '📨 Invitations Discord', value: value(cfg, 'blockInvites') ? '🟢 bloquées' : '🔴 autorisées', inline: true },
    { name: '📎 Pièces jointes', value: value(cfg, 'blockAttachments') ? '🔴 bloquées' : '🟢 autorisées', inline: true },
    { name: '🤖 Bots', value: value(cfg, 'blockBots') ? '🔴 bloqués' : '🟢 relayés', inline: true },
    { name: '↩️ Réponses citées', value: value(cfg, 'relayReplies') ? '🟢 conservées' : '🔴 ignorées', inline: true },
    {
      name: '⏱️ Anti-spam',
      value: `${value(cfg, 'rateLimit')} message(s) / ${value(cfg, 'rateWindowSeconds')} s${preset ? ` · \`${preset.label}\`` : ''}`,
      inline: true,
    },
    { name: '🚫 Serveurs ignorés', value: `${blockedCount(cfg)}`, inline: true },
    {
      name: '📊 Statistiques',
      value: `**${Number(cfg?.totalRelayed) || 0}** relayé(s) · **${Number(cfg?.totalReceived) || 0}** reçu(s)`,
      inline: true,
    },
    { name: '🕓 Dernier relais', value: last ? `<t:${last}:R>` : '*Jamais*', inline: true },
    {
      name: 'ℹ️ Comment ça marche',
      value: [
        `Écris dans ${cfg?.channelId ? `<#${cfg.channelId}>` : 'ton salon'} : ton message part sur **tous les serveurs** du canal ${hubs.hubLabel(hub.id)}.`,
        'Les réponses arrivent ici avec le pseudo et l’avatar de leur auteur.',
        'Supprimer un message ici le supprime partout : la modération est partagée.',
      ].join('\n'),
      inline: false,
    },
  ];

  return new EmbedBuilder()
    .setColor(value(cfg, 'enabled') ? hubs.hubColor(hub.id) : COLORS.warning)
    .setTitle(clip('🌐 Pont inter-serveurs', 256))
    .setDescription(clip([
      note ? `${note}\n` : null,
      stateText(cfg),
      hub.topic,
    ].filter(line => line !== null).join('\n'), 4000))
    .addFields(fields.map(field => ({ ...field, value: clip(field.value, 1024) })))
    .setFooter({ text: 'REZO • Pont inter-serveurs — chaque choix s’enregistre immédiatement' });
}

function channelRow(cfg) {
  return new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(IDS.channel)
      .setPlaceholder(clip(`📌 Salon à relier… ${cfg?.channelId ? '' : '(obligatoire)'}`, 150))
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1)
      .setMaxValues(1),
  );
}

function hubRow(cfg) {
  const current = value(cfg, 'hub');
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(IDS.hub)
      .setPlaceholder('🌍 Choisir le canal commun')
      .addOptions(hubs.HUBS.slice(0, 25).map(hub => new StringSelectMenuOptionBuilder()
        .setLabel(clip(`${hub.emoji} ${hub.label}`, 100))
        .setValue(hub.id)
        .setDescription(clip(hub.topic, 100))
        .setDefault(hub.id === current))),
  );
}

function actionRows(cfg) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.toggle)
        .setLabel(value(cfg, 'enabled') ? 'Mettre en pause' : 'Activer le pont')
        .setEmoji(value(cfg, 'enabled') ? '⏸️' : '▶️')
        .setStyle(value(cfg, 'enabled') ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(!cfg?.channelId),
      new ButtonBuilder().setCustomId(IDS.filters).setLabel('Filtres').setEmoji('🎛️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(IDS.blocks).setLabel('Serveurs ignorés').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.unlink).setLabel('Délier').setEmoji('🔌').setStyle(ButtonStyle.Danger).setDisabled(!cfg?.channelId),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.antispam).setLabel('Anti-spam').setEmoji('⏱️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.network).setLabel('Le réseau').setEmoji('🌐').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(IDS.refresh).setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Écran des filtres ───────────────────────────────────────────────────────

function buildFiltersEmbed(cfg) {
  const lines = TOGGLES.map(toggle => {
    const on = Boolean(value(cfg, toggle.field));
    const effect = toggle.field === 'showServerName'
      ? (on ? 'le nom du serveur est ajouté sous chaque message' : 'aucune mention du serveur d’origine')
      : (on ? 'bloqué' : 'autorisé');
    return `**${toggle.label}** · ${on ? '🟢' : '🔴'} ${effect}`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.info || COLORS.primary)
    .setTitle('🎛️ Filtres du pont')
    .setDescription([
      'Ce qui sort de **ce** serveur est filtré ici. Clique sur un filtre pour l’inverser.',
      '',
      lines.join('\n'),
      '',
      '💡 Les invitations Discord sont bloquées par défaut : un pont n’est pas une machine à pub.',
    ].join('\n'))
    .setFooter({ text: 'REZO • Pont inter-serveurs — enregistré immédiatement' });
}

function filtersRows(cfg) {
  return [
    new ActionRowBuilder().addComponents(...TOGGLES.map(toggle => new ButtonBuilder()
      .setCustomId(toggle.id)
      .setLabel(clip(toggle.label, 80))
      .setEmoji(value(cfg, toggle.field) ? '🟢' : '🔴')
      .setStyle(value(cfg, toggle.field) ? ButtonStyle.Success : ButtonStyle.Secondary))),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.back).setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Écran des serveurs ignorés ──────────────────────────────────────────────

function buildBlocksEmbed(cfg, { peers = [], resolveName = null } = {}) {
  const blocked = Array.isArray(cfg?.blockedGuilds) ? cfg.blockedGuilds : [];
  const list = blocked.length
    ? blocked.slice(0, 20).map(id => `• ${resolveName ? resolveName(id) : `\`${id}\``}`).join('\n')
    : '*Aucun serveur ignoré.*';

  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🚫 Serveurs ignorés')
    .setDescription([
      'Ignorer un serveur coupe le pont dans les deux sens : tu ne reçois plus ses messages et il ne reçoit plus les tiens.',
      '',
      `**Ignorés (${blocked.length})**`,
      list,
      '',
      peers.length
        ? `${peers.length} autre(s) serveur(s) partagent le même canal commun en ce moment.`
        : 'Aucun autre serveur n’est connecté à ce canal pour l’instant.',
    ].join('\n'))
    .setFooter({ text: 'REZO • Pont inter-serveurs' });
}

function blocksRows(cfg, { peers = [], resolveName = null } = {}) {
  const rows = [];
  const blocked = Array.isArray(cfg?.blockedGuilds) ? cfg.blockedGuilds : [];

  if (peers.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(IDS.block)
        .setPlaceholder('🚫 Ignorer un serveur connecté…')
        .addOptions(peers.slice(0, 25).map(peer => new StringSelectMenuOptionBuilder()
          .setLabel(clip(peer.name || peer.id, 100))
          .setValue(String(peer.id))
          .setDescription('Ses messages ne seront plus relayés'))),
    ));
  }

  if (blocked.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(IDS.unblock)
        .setPlaceholder('✅ Réautoriser un serveur…')
        .addOptions(blocked.slice(0, 25).map(id => new StringSelectMenuOptionBuilder()
          .setLabel(clip(resolveName ? resolveName(id) : String(id), 100))
          .setValue(String(id))
          .setDescription('Relancer le pont avec ce serveur'))),
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.back).setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

// ─── Écran anti-spam ────────────────────────────────────────────────────────

function antispamRows(cfg) {
  const preset = presetOf(cfg);
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(IDS.antispam)
        .setPlaceholder('⏱️ Choisir un rythme')
        .addOptions(ANTISPAM_PRESETS.map(entry => new StringSelectMenuOptionBuilder()
          .setLabel(clip(entry.label, 100))
          .setValue(entry.id)
          .setDescription(clip(entry.description, 100))
          .setDefault(Boolean(preset && preset.id === entry.id)))),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.back).setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Confirmation de déliaison ──────────────────────────────────────────────

function confirmRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.unlinkConfirm).setLabel('Confirmer la déliaison').setEmoji('🔌').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(IDS.back).setLabel('Annuler').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Écran réseau ───────────────────────────────────────────────────────────

function buildNetworkEmbed(network = {}, { guild = null } = {}) {
  const perHub = network.perHub || new Map();
  const lines = hubs.HUBS.map(hub => {
    const count = Number(perHub.get?.(hub.id) ?? perHub[hub.id] ?? 0);
    return `${hub.emoji} **${hub.label}** · ${count} serveur(s)`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.accent || COLORS.primary)
    .setTitle('🌐 Le réseau du pont')
    .setDescription([
      'Chaque canal commun relie tous les serveurs qui y branchent un salon.',
      'Un message écrit ici apparaît chez les autres, avec le pseudo et l’avatar de son auteur.',
      '',
      lines.join('\n'),
      '',
      `👥 **${Number(network.connected) || 0}** serveur(s) relié(s) · 📨 **${Number(network.relayed) || 0}** message(s) relayé(s) · 📥 **${Number(network.received) || 0}** reçu(s)`,
      '',
      '🔒 Aucun ping ne traverse les serveurs, et chaque serveur garde ses propres filtres.',
      guild ? `Ce serveur est sur ${hubs.hubLabel(value(network.cfg, 'hub'))}.` : null,
    ].filter(line => line !== null).join('\n'))
    .setFooter({ text: 'REZO • Pont inter-serveurs' });
}

function networkRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.back).setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Assemblage ─────────────────────────────────────────────────────────────

/**
 * Vue complète du panneau.
 * `view` : panel | filters | antispam | blocks | confirm | network
 */
function render(cfg, { guild = null, note = null, view = 'panel', peers = [], resolveName = null, network = null } = {}) {
  if (view === 'filters') return { embeds: [buildFiltersEmbed(cfg)], components: filtersRows(cfg) };
  if (view === 'antispam') {
    return {
      embeds: [buildPanelEmbed(cfg, { guild, note: note || '⏱️ **Anti-spam** — choisis un rythme.' })],
      components: antispamRows(cfg),
    };
  }
  if (view === 'blocks') {
    return {
      embeds: [buildBlocksEmbed(cfg, { peers, resolveName })],
      components: blocksRows(cfg, { peers, resolveName }),
    };
  }
  if (view === 'confirm') {
    return {
      embeds: [buildPanelEmbed(cfg, {
        guild,
        note: note || '⚠️ **Délier ce salon ?** Le webhook est supprimé et les messages ne circulent plus. Les réglages sont conservés.',
      })],
      components: confirmRows(),
    };
  }
  if (view === 'network') {
    return {
      embeds: [buildNetworkEmbed({ ...(network || {}), cfg }, { guild })],
      components: networkRows(),
    };
  }
  return { embeds: [buildPanelEmbed(cfg, { guild, note })], components: [channelRow(cfg), hubRow(cfg), ...actionRows(cfg)] };
}

function toggleFieldOf(customId) {
  const found = TOGGLES.find(toggle => toggle.id === customId);
  return found ? found.field : null;
}

function presetById(id) {
  return ANTISPAM_PRESETS.find(preset => preset.id === id) || null;
}

module.exports = {
  IDS,
  TOGGLES,
  ANTISPAM_PRESETS,
  buildPanelEmbed,
  buildFiltersEmbed,
  buildBlocksEmbed,
  buildNetworkEmbed,
  channelRow,
  hubRow,
  actionRows,
  filtersRows,
  blocksRows,
  antispamRows,
  confirmRows,
  networkRows,
  render,
  toggleFieldOf,
  presetById,
  presetOf,
  stateText,
  channelLabel,
};
