'use strict';
// commands/utilitaires/botinfo.js — 🤖 Panneau d'identité technique du bot.
//
// Restauré depuis l'archive du projet, puis passé au format « panneau » : le
// routeur d'interactions attend déjà les identifiants `bi_*` (sélecteur de vue,
// rafraîchissement, fermeture) — inutile de laisser du code mort dans
// interactionCreate.js.
//
// Trois vues, un seul message :
//   • Identité   — nom, ID, création, propriétaires ;
//   • Statistiques — serveurs, membres, salons, uptime, latence, commandes ;
//   • Technique  — machine, mémoire, versions, shards ;
//   • Statut du serveur — la carte de statut du bot vue par CE serveur (surnom,
//     état et apparence réglés dans `/setting` → Outils → Statut du bot).
//     Discord n'autorise qu'une présence par bot : ce qui est réellement propre
//     au serveur, c'est cette carte et le surnom, pas la ligne « Joue à … ».
//
// Aucune donnée sensible : uniquement ce que Discord expose déjà publiquement.
// Tout est lu en défensif (`?.`) pour que le panneau reste lisible même avec un
// client partiel (tests, démarrage en cours).

const os = require('os');
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, MessageFlags,
} = require('discord.js');
const { version } = require('../../../package.json');
const { COLORS } = require('../../utils/embeds');
const brand = require('../../utils/brand');
const { siteUrl } = require('../../utils/siteUrl');
const { shardInfo } = require('../../core/sharding');
const guildStatus = require('../../utils/guildStatus');

// Liens publics — les mêmes que /help, pour ne pas afficher deux adresses
// différentes selon la commande.
// Adresse définie une seule fois pour tout le bot (SITE_URL dans le .env).
const SITE_URL = siteUrl();
const SUPPORT_URL = 'https://discord.gg/ts5mh326ew';

// L'hébergeur n'est pas détectable par code (Node ne le sait pas) : c'est un
// libellé d'affichage, ajustable dans le .env sans toucher au code.
const HOSTING_LABEL = process.env.HOSTING_LABEL || 'Zyntra Cloud';

const VIEWS = {
  identite: { emoji: '🤖', label: 'Identité', title: 'Identité du bot', description: 'Nom, ID, création, propriétaires' },
  stats: { emoji: '📊', label: 'Statistiques', title: 'Statistiques', description: 'Serveurs, membres, uptime, latence' },
  technique: { emoji: '💻', label: 'Technique', title: 'Informations techniques', description: 'Machine, mémoire, versions, shards' },
  statut: { emoji: '🛰️', label: 'Statut du serveur', title: 'Statut du bot sur ce serveur', description: 'État annoncé, carte live et personnalisation' },
};

const DEFAULT_VIEW = 'identite';
const SELECT_ID = 'bi_select';

function ownerIds() {
  return (process.env.OWNER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
}

function formatDate(date) {
  if (!date) return '*Inconnue*';
  return date.toLocaleString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatRelative(date) {
  if (!date) return '*Inconnue*';
  const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return 'à l’instant';
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours} heure${hours > 1 ? 's' : ''}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days} jour${days > 1 ? 's' : ''}`;
  const months = Math.floor(days / 30);
  return `il y a ${months} mois`;
}

/** Durée lisible : « 3j 4h », « 12 min », « 8 s ». */
function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}j ${hours % 24}h`;
}

function megabytes(bytes) {
  return `${Math.round((bytes || 0) / 1024 / 1024)} Mo`;
}

function totals(client) {
  const guilds = client?.guilds?.cache;
  const sum = (pick) => (typeof guilds?.reduce === 'function' ? guilds.reduce((n, g) => n + (pick(g) || 0), 0) : 0);
  return {
    guilds: guilds?.size ?? 0,
    members: sum(guild => guild.memberCount),
    roles: sum(guild => guild.roles?.cache?.size),
    boosts: sum(guild => guild.premiumSubscriptionCount),
    channels: client?.channels?.cache?.size ?? 0,
  };
}

function inviteUrl(client) {
  return `https://discord.com/api/oauth2/authorize?client_id=${client?.user?.id || ''}&permissions=8&scope=bot%20applications.commands`;
}

// ── Rendu d'une vue (pur : testable avec un faux client) ─────────────────────
function buildView(view, client, { by = null, guild = null, cfg = null, license = null, admin = false } = {}) {
  const key = VIEWS[view] ? view : DEFAULT_VIEW;
  const meta = VIEWS[key];

  // La carte de statut est rendue par le même moteur que la publication :
  // l'aperçu ici ne peut donc pas différer de ce qui part dans le salon.
  if (key === 'statut') {
    return guildStatus.buildStatusEmbed(client, guild, cfg, { by, admin, license });
  }
  const user = client?.user;
  const shards = shardInfo(client);
  const counts = totals(client);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: brand.footer('Bot info'), iconURL: user?.displayAvatarURL?.() })
    .setTitle(`${meta.emoji} ${meta.title}`)
    .setFooter({ text: brand.footer(by ? `Demandé par ${by}` : 'Panneau d’identité technique') })
    .setTimestamp();

  if (key === 'identite') {
    const owners = ownerIds();
    embed
      .setThumbnail(user?.displayAvatarURL?.({ size: 256 }) || null)
      .addFields(
        {
          name: '🤖 Identité',
          value: [
            `**Nom :** ${user?.username || '*Inconnu*'}`,
            `**ID :** \`${user?.id || '—'}\``,
            `**Créé le :** ${formatDate(user?.createdAt)} (${formatRelative(user?.createdAt)})`,
          ].join('\n'),
        },
        {
          name: '🔷 Développeur',
          value: owners.length
            ? owners.map(id => `<@${id}>`).join(' ')
            : '*Non configuré (`OWNER_IDS` absent du .env)*',
        },
        {
          name: '🛰️ Présence',
          value: [
            `**Serveurs :** ${counts.guilds.toLocaleString('fr-FR')}`,
            `**Shards :** ${shards.count}${shards.sharded ? ` (celui-ci : ${shards.ids.join(', ')})` : ' *(processus unique)*'}`,
          ].join('\n'),
        },
      );
    return embed;
  }

  if (key === 'stats') {
    embed.addFields(
      {
        name: '📊 Audience',
        value: [
          `**Serveurs :** ${counts.guilds.toLocaleString('fr-FR')}`,
          `**Membres :** ${counts.members.toLocaleString('fr-FR')}`,
          `**Salons :** ${counts.channels.toLocaleString('fr-FR')}`,
          `**Rôles :** ${counts.roles.toLocaleString('fr-FR')}`,
          `**Boosts :** ${counts.boosts.toLocaleString('fr-FR')}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '⚡ Activité',
        value: [
          `**En ligne depuis :** ${formatUptime(client?.uptime)}`,
          `**Démarré le :** ${formatDate(client?.readyAt || (client?.uptime ? new Date(Date.now() - client.uptime) : null))}`,
          `**Ping API :** ${Number.isFinite(client?.ws?.ping) ? `${client.ws.ping} ms` : '—'}`,
          `**Commandes chargées :** ${client?.commands?.size ?? 0}`,
        ].join('\n'),
        inline: true,
      },
    );
    return embed;
  }

  const memory = process.memoryUsage();
  const cpu = os.cpus?.()?.[0]?.model?.replace(/\s+/g, ' ').trim() || 'Inconnu';
  embed.addFields(
    {
      name: '💻 Machine',
      value: [
        `**Hébergeur :** ${HOSTING_LABEL}`,
        `**Système :** ${os.type()} ${os.release()} (${process.arch})`,
        `**Processeur :** ${cpu}`,
        `**Cœurs :** ${os.cpus?.()?.length ?? '—'}`,
        `**Mémoire du processus :** ${megabytes(memory.rss)} (dont ${megabytes(memory.heapUsed)} de tas JS)`,
      ].join('\n'),
    },
    {
      name: '🧩 Versions',
      value: [
        `**Bot :** v${version}`,
        `**Node.js :** ${process.version}`,
        `**discord.js :** v${require('discord.js').version}`,
        `**Shards :** ${shards.count} — \`${shards.ids.join(', ')}\``,
      ].join('\n'),
    },
  );
  return embed;
}

function buildComponents(view, client = null) {
  const key = VIEWS[view] ? view : DEFAULT_VIEW;

  const select = new StringSelectMenuBuilder()
    .setCustomId(SELECT_ID)
    .setPlaceholder('Choisir une vue…')
    .addOptions(Object.entries(VIEWS).map(([id, meta]) => ({
      label: meta.label,
      description: meta.description,
      emoji: meta.emoji,
      value: id,
      default: id === key,
    })));

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bi_refresh:${key}`).setEmoji('🔄').setLabel('Rafraîchir').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bi_close').setEmoji('✖️').setLabel('Fermer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('Inviter').setEmoji('🔗').setStyle(ButtonStyle.Link).setURL(inviteUrl(client)),
    new ButtonBuilder().setLabel('Support').setEmoji('💬').setStyle(ButtonStyle.Link).setURL(SUPPORT_URL),
    new ButtonBuilder().setLabel('Site').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(SITE_URL),
  );

  return [new ActionRowBuilder().addComponents(select), buttons];
}

function closedEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🤖 Panneau fermé')
    .setDescription('Relance `/botinfo` pour rouvrir le panneau.')
    .setFooter({ text: brand.footer('Bot info') });
}

/**
 * Contexte d'une vue. La carte de statut a besoin du serveur et de sa
 * configuration ; les autres vues restent purement globales (aucune lecture
 * de base supplémentaire).
 */
async function viewContext(interaction, view) {
  const base = { by: interaction?.user?.username || null };
  if (view !== 'statut') return base;

  const guild = interaction?.guild || null;
  if (!guild?.id) return { ...base, guild: null };

  const [cfg, license] = await Promise.all([
    guildStatus.getConfig(guild.id).catch(() => null),
    guildStatus.readLicense(guild.id).catch(() => null),
  ]);
  const admin = Boolean(interaction?.memberPermissions?.has?.('ManageGuild'));
  return { ...base, guild, cfg, license, admin };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('🤖 Informations complètes sur le bot'),

  async execute(interaction) {
    const client = interaction.client;
    const options = await viewContext(interaction, DEFAULT_VIEW);
    return interaction.reply({
      embeds: [buildView(DEFAULT_VIEW, client, options)],
      components: buildComponents(DEFAULT_VIEW, client),
    });
  },

  // ── Sélecteur de vue : bi_select ──────────────────────────────────────────
  async handleSelect(interaction, client) {
    if (interaction.customId !== SELECT_ID) return;
    const view = interaction.values?.[0];
    if (!VIEWS[view]) return;
    const options = await viewContext(interaction, view);
    return interaction.update({
      embeds: [buildView(view, client, options)],
      components: buildComponents(view, client),
    });
  },

  // ── Boutons : bi_refresh:<vue> et bi_close ────────────────────────────────
  async handleButton(interaction, client) {
    const id = interaction.customId || '';

    if (id === 'bi_close') {
      return interaction.update({ embeds: [closedEmbed()], components: [] });
    }

    if (id.startsWith('bi_refresh')) {
      const view = id.split(':')[1] || DEFAULT_VIEW;
      const options = await viewContext(interaction, view);
      return interaction.update({
        embeds: [buildView(view, client, options)],
        components: buildComponents(view, client),
      });
    }
  },

  __testables: {
    VIEWS, DEFAULT_VIEW, SELECT_ID, SITE_URL, SUPPORT_URL,
    buildView, buildComponents, closedEmbed, formatUptime, formatRelative, formatDate, totals, viewContext,
  },
};
