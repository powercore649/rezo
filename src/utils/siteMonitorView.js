'use strict';
// utils/siteMonitorView.js — Vues du panel /statut-site.
//
// Rendu PUR : aucune I/O, aucun accès base. La commande ne fait que transmettre
// la configuration ; les tests peuvent donc valider la structure des vues
// (limites Discord : 5 rangées, 5 composants par rangée, 25 options par menu).

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
} = require('discord.js');

const { COLORS } = require('./embeds');
const {
  MAX_SITES, STATUS_META, DEFAULT_MAINTENANCE_KEYWORDS, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES,
  MAX_FAILURE_THRESHOLD, formatResponseMs, formatAgo, availability, statusMeta,
} = require('./siteStatus');
const { siteDisplayName } = require('./siteMonitorEngine');

const INTERVAL_CHOICES = [5, 10, 15, 30, 60, 120];
const THRESHOLD_CHOICES = [1, 2, 3, 4, 5];

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ─── Panel principal ────────────────────────────────────────────────────────
function siteLine(site) {
  const meta = statusMeta(site.status);
  const code = site.statusCode ? ` · ${site.statusCode}` : '';
  const label = site.enabled === false ? ' *(en pause)*' : '';
  return `${meta.emoji} **${truncate(siteDisplayName(site), 60)}** — ${meta.label}${code} · ${formatResponseMs(site.responseMs)} · ${formatAgo(site.lastCheckedAt)}${label}`;
}

function buildPanelEmbed(config, guild) {
  const sites = config.sites || [];
  const online = sites.filter(s => s.status === 'online').length;
  const maintenance = sites.filter(s => s.status === 'maintenance').length;
  const down = sites.filter(s => s.status === 'down').length;

  const embed = new EmbedBuilder()
    .setColor(down ? COLORS.error : maintenance ? COLORS.warning : COLORS.primary)
    .setTitle('🛰️ Surveillance de sites web')
    .setDescription(
      'Le bot vérifie chaque site à intervalle régulier et prévient ici quand un site tombe, passe en maintenance ou revient en ligne.\n'
      + 'Tout se règle depuis ce panel : sites, salon d’alerte, fréquence, seuil d’alerte et mots de maintenance.',
    )
    .addFields(
      { name: 'État', value: config.enabled ? '🟢 Activée' : '🔴 Désactivée', inline: true },
      { name: 'Salon d’alerte', value: config.channelId ? `<#${config.channelId}>` : '*non défini*', inline: true },
      { name: 'Fréquence', value: `toutes les ${config.intervalMinutes} min`, inline: true },
      { name: 'Seuil d’alerte', value: `${config.failureThreshold} échec(s)`, inline: true },
      { name: 'Sites', value: `${sites.length}/${MAX_SITES}`, inline: true },
      { name: 'Bilan', value: `🟢 ${online} · 🟠 ${maintenance} · 🔴 ${down}`, inline: true },
    );

  if (sites.length) {
    embed.addFields({ name: 'Sites surveillés', value: truncate(sites.map(siteLine).join('\n'), 1024), inline: false });
  } else {
    embed.addFields({ name: 'Sites surveillés', value: 'Aucun site pour le moment — utilisez **Ajouter un site**.', inline: false });
  }

  if (guild?.iconURL) embed.setThumbnail(guild.iconURL({ dynamic: true }) || null);
  embed.setFooter({ text: 'REZO • Surveillance de sites' }).setTimestamp();
  return embed;
}

function buildPanelComponents(config) {
  const rows = [];
  const sites = config.sites || [];

  if (sites.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('site_select')
        .setPlaceholder('🔎 Gérer un site surveillé…')
        .addOptions(sites.slice(0, 25).map(site => ({
          label: truncate(siteDisplayName(site), 100),
          value: String(site._id),
          description: truncate(`${statusMeta(site.status).label} · ${site.url}`, 100),
          emoji: statusMeta(site.status).emoji,
        }))),
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('site_add').setLabel('Ajouter un site').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('site_checkall').setLabel('Vérifier maintenant').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('site_settings').setLabel('Réglages').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(config.enabled ? 'site_disable' : 'site_enable')
      .setLabel(config.enabled ? 'Désactiver' : 'Activer')
      .setEmoji(config.enabled ? '⏸️' : '▶️')
      .setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Secondary),
  ));

  return rows;
}

// ─── Réglages ───────────────────────────────────────────────────────────────
function buildSettingsEmbed(config) {
  const keywords = config.maintenanceKeywords?.length ? config.maintenanceKeywords : DEFAULT_MAINTENANCE_KEYWORDS;
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('⚙️ Réglages de la surveillance')
    .addFields(
      { name: 'Salon d’alerte', value: config.channelId ? `<#${config.channelId}>` : '*non défini*', inline: true },
      { name: 'Fréquence', value: `toutes les ${config.intervalMinutes} min`, inline: true },
      { name: 'Seuil d’alerte', value: `${config.failureThreshold} échec(s) consécutif(s)`, inline: true },
      { name: 'Mots de maintenance', value: truncate(keywords.map(k => `\`${k}\``).join(', '), 1024), inline: false },
      {
        name: 'Message d’alerte',
        value: config.alertMessage ? truncate(`\`\`\`${config.alertMessage}\`\`\``, 1024)
          : '*par défaut* — placeholders : `{site}` `{url}` `{statut}` `{code}` `{temps}` `{durée}`',
        inline: false,
      },
    )
    .setFooter({ text: 'Ces réglages s’appliquent à tous les sites du serveur' });
}

function buildSettingsComponents(config) {
  const channelRow = new ChannelSelectMenuBuilder()
    .setCustomId('site_channel')
    .setPlaceholder('📢 Salon des alertes…')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (config.channelId) channelRow.setDefaultChannels([config.channelId]);

  const intervalRow = new StringSelectMenuBuilder()
    .setCustomId('site_interval')
    .setPlaceholder('⏱️ Fréquence de vérification…')
    .addOptions(INTERVAL_CHOICES.map(minutes => ({
      label: `Toutes les ${minutes} min`,
      value: String(minutes),
      default: config.intervalMinutes === minutes,
    })));

  const thresholdRow = new StringSelectMenuBuilder()
    .setCustomId('site_threshold')
    .setPlaceholder('🎚️ Échecs avant alerte…')
    .addOptions(THRESHOLD_CHOICES.map(value => ({
      label: value === 1 ? '1 échec (alerte immédiate)' : `${value} échecs consécutifs`,
      value: String(value),
      default: config.failureThreshold === value,
    })));

  return [
    new ActionRowBuilder().addComponents(channelRow),
    new ActionRowBuilder().addComponents(intervalRow),
    new ActionRowBuilder().addComponents(thresholdRow),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('site_settings_keywords').setLabel('Mots de maintenance').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('site_settings_message').setLabel('Message d’alerte').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('site_back').setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Fiche d'un site ────────────────────────────────────────────────────────
function buildSiteEmbed(config, site) {
  const meta = statusMeta(site.status);
  const declared = site.maintenanceKeywords?.length ? site.maintenanceKeywords : null;
  const keywords = declared || (config.maintenanceKeywords?.length ? config.maintenanceKeywords : DEFAULT_MAINTENANCE_KEYWORDS);

  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${truncate(siteDisplayName(site), 200)}`)
    .addFields(
      { name: 'URL', value: truncate(site.url, 1024), inline: false },
      { name: 'État', value: meta.label, inline: true },
      { name: 'Code HTTP', value: site.statusCode ? `\`${site.statusCode}\`` : '*aucun*', inline: true },
      { name: 'Temps de réponse', value: formatResponseMs(site.responseMs), inline: true },
      { name: 'Dernière vérification', value: formatAgo(site.lastCheckedAt), inline: true },
      { name: 'État depuis', value: site.since ? formatAgo(site.since) : '—', inline: true },
      { name: 'Échecs consécutifs', value: `${site.failures || 0}`, inline: true },
      {
        name: 'Disponibilité observée',
        value: availability(site) === null ? '—' : `${availability(site)} % (${site.upChecks || 0}/${site.checks || 0})`,
        inline: true,
      },
      { name: 'Surveillance', value: site.enabled === false ? '⏸️ En pause' : '🟢 Active', inline: true },
      {
        name: 'Mots de maintenance',
        value: truncate(`${declared ? '' : '*(hérités du serveur)* '}${keywords.map(k => `\`${k}\``).join(', ')}`, 1024),
        inline: false,
      },
    );

  if (site.error) embed.addFields({ name: 'Dernier détail', value: truncate(site.error, 300), inline: false });
  embed.setFooter({ text: 'REZO • Surveillance de sites' }).setTimestamp();
  return embed;
}

function buildSiteComponents(site) {
  const id = String(site._id);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`site_check:${id}`).setLabel('Vérifier').setEmoji('🔄').setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`site_pause:${id}`)
        .setLabel(site.enabled === false ? 'Reprendre' : 'Mettre en pause')
        .setEmoji(site.enabled === false ? '▶️' : '⏸️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`site_sitekeywords:${id}`).setLabel('Mots de maintenance').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`site_delete:${id}`).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('site_back').setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildConfirmEmbed(site) {
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🗑️ Supprimer ce site ?')
    .setDescription(`**${truncate(siteDisplayName(site), 200)}**\n${truncate(site.url, 300)}\n\nLa surveillance et les statistiques de ce site seront perdues.`);
}

function buildConfirmComponents(site) {
  const id = String(site._id);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`site_delete_yes:${id}`).setLabel('Supprimer').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`site_open:${id}`).setLabel('Annuler').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

module.exports = {
  INTERVAL_CHOICES,
  THRESHOLD_CHOICES,
  STATUS_META,
  buildPanelEmbed,
  buildPanelComponents,
  buildSettingsEmbed,
  buildSettingsComponents,
  buildSiteEmbed,
  buildSiteComponents,
  buildConfirmEmbed,
  buildConfirmComponents,
};
