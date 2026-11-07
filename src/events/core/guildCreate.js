'use strict';
// events/core/guildCreate.js — Le bot rejoint un serveur

const fs   = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const Server     = require('../../models/Server');
const { COLORS } = require('../../utils/embeds');
const brand      = require('../../utils/brand');
const blacklist  = require('../../utils/blacklist');
const { siteUrl } = require('../../utils/siteUrl');

// Liens publics — les mêmes que /help et /botinfo : une seule adresse affichée
// partout, pour éviter les invitations mortes dans les messages d'arrivée.
const SITE_URL    = siteUrl();
const SUPPORT_URL = 'https://discord.gg/ts5mh326ew';

// Bannière de l'arrivée : envoyée en pièce jointe, donc aucun hébergement
// externe à maintenir (le fichier est livré avec le bot).
const BANNER_PATH = path.join(__dirname, '..', '..', '..', 'assets', 'banners', 'help-banner.jpg');
const BANNER_NAME = 'rezo-banner.jpg';

function bannerExists() {
  try { return fs.existsSync(BANNER_PATH); } catch { return false; }
}

// ── Message d'arrivée dans le serveur ────────────────────────────────────────
// Fonction pure (hors lecture du fichier bannière) : elle ne fait aucun appel
// réseau, ce qui permet de la tester sans client Discord réel.
function buildJoinEmbed({ client, guild, guildIcon = null, banner = true }) {
  const botName = client.user.username;
  const botIcon = client.user.displayAvatarURL({ size: 256 });
  const commandes = client.commands?.size || 0;

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: botName, iconURL: botIcon })
    .setTitle(`👋 Merci de m'avoir ajouté sur ${guild.name} !`)
    .setDescription([
      `Tout est déjà là : **${commandes} commandes**, **11 domaines**, un seul panneau à configurer — sans empiler dix bots.`,
      '',
      brand.divider(14),
      '**🚀 Démarrage en 3 minutes**',
      '> **1.** `/setting` — ouvrir le tableau de bord',
      '> **2.** `/autopilote` — noter le serveur et installer ce qui manque',
      '> **3.** `/help` — la fiche de chaque commande, permissions comprises',
    ].join('\n'))
    .setThumbnail(guildIcon || botIcon)
    .addFields(
      {
        name: '🛡️ Protéger',
        value: ['`/securite` · `/antiraid`', '`/anti-nuke` · `/captcha`', '`/controle-arrivee` · `/antivpn`'].join('\n'),
        inline: true,
      },
      {
        name: '🎉 Animer',
        value: ['`/giveaway` · `/leveling`', '`/welcome` · `/ticket`', '`/starboard` · `/anniversaire`'].join('\n'),
        inline: true,
      },
      {
        name: '📊 Piloter',
        value: ['`/stats` · `/bump`', '`/leaderboard` · `/recap`', '`/modmail` · `/help`'].join('\n'),
        inline: true,
      },
      {
        name: '🔑 Licence',
        value: [
          'Les systèmes avancés (tickets, anti-raid, bump réseau, anti-VPN, autopilote…) demandent une licence.',
          '**Essai gratuit de 7 jours** pour le propriétaire — `/license` → *Essai gratuit*.',
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: brand.footer(), iconURL: botIcon })
    .setTimestamp();

  if (banner && bannerExists()) embed.setImage(`attachment://${BANNER_NAME}`);
  return embed;
}

// Boutons du message d'arrivée. Les identifiants `ping_open_*` sont déjà
// persistants et passent par le même garde-fou licence que les slash commands.
function buildJoinRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('⚙️ Ouvrir le panel')
      .setStyle(ButtonStyle.Primary)
      .setCustomId('ping_open_panel'),
    new ButtonBuilder()
      .setLabel('🔑 Licence')
      .setStyle(ButtonStyle.Secondary)
      .setCustomId('ping_open_license'),
    new ButtonBuilder()
      .setLabel('📖 Aide')
      .setStyle(ButtonStyle.Secondary)
      .setCustomId('ping_open_help'),
    new ButtonBuilder()
      .setLabel('💬 Support')
      .setStyle(ButtonStyle.Link)
      .setURL(SUPPORT_URL),
  );
}

module.exports = {
  name: 'guildCreate',
  buildJoinEmbed,
  buildJoinRow,
  async execute(guild, client) {
    console.log(`➕ Rejoint : ${guild.name} (${guild.id}) — ${guild.memberCount} membres`);

    // ── Blacklist — départ immédiat ───────────────────────────────────────────
    if (blacklist.isBlacklisted(guild.id)) {
      console.warn(`⛔ ${guild.name} est blacklisté — départ automatique.`);
      await guild.leave().catch(err => console.error('guildCreate leave:', err.message));
      return;
    }

    // ── Sauvegarde en base ────────────────────────────────────────────────────
    await Server.findOneAndUpdate(
      { guildId: guild.id },
      { guildName: guild.name, guildIcon: guild.iconURL({ dynamic: true }), memberCount: guild.memberCount },
      { upsert: true }
    ).catch(() => {});

    // ── Salon administrateur + programme d'installation ───────────────────────
    // Créé une seule fois par serveur, invisible pour les non-administrateurs,
    // avec le bouton « Start here » qui ouvre l'installation des modules.
    try {
      const { onGuildJoin } = require('../../utils/setupHub');
      await onGuildJoin(guild, client);
    } catch (err) {
      console.error(`[setupHub] guildCreate ${guild.id}:`, err.message);
    }

    // ── Cache invitations ─────────────────────────────────────────────────────
    try {
      const { primeGuildCache } = require('../../utils/inviteCache');
      await primeGuildCache(guild);
    } catch (err) {
      console.error(`[inviteCache] guildCreate ${guild.id}:`, err.message);
    }

    const totalGuilds = client.guilds.cache.size;
    const iconURL     = client.user.displayAvatarURL({ size: 256 });
    const guildIcon   = guild.iconURL({ dynamic: true, size: 256 }) || iconURL;

    // ── DM à l'owner du serveur ───────────────────────────────────────────────
    try {
      const owner = await guild.fetchOwner();

      const dmEmbed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setAuthor({ name: client.user.username, iconURL })
        .setTitle(`Merci d'avoir ajouté ${client.user.username} sur ${guild.name} !`)
        .setDescription([
          `Bonjour **${owner.user.username}** 👋`,
          '',
          `**${client.user.username}** est un bot **tout-en-un** conçu pour gérer, animer et sécuriser votre serveur Discord.`,
          '',
          '**🚀 Par où commencer ?**',
          '> `/setting` — Tableau de bord : tout se règle et se lance ici',
          '> `/autopilote` — Installer automatiquement ce qui manque',
          '> `/help` — Liste complète des commandes',
          '',
          '**🛡️ Modération & Sécurité**',
          '> `/securite` · `/antiraid` · `/controle-arrivee` · `/anti-nuke` · `/captcha`',
          '',
          '**🎉 Animation & Communauté**',
          '> `/giveaway` · `/leveling` · `/welcome`',
          '',
          '**🎫 Support**',
          '> `/ticket` — Système de tickets avancé avec panels',
          '> `/modmail` — Messagerie privée staff ↔ membres',
          '',
          '**📊 Statistiques & Outils**',
          '> `/stats` · `/bump` · `/poll`',
          '',
          '*Une question ? Rejoignez notre serveur de support ci-dessous.*',
        ].join('\n'))
        .setThumbnail(iconURL)
        .addFields(
          { name: '🌍 Serveurs',  value: `**${totalGuilds}**`,             inline: true },
          { name: '👥 Membres',   value: `**${guild.memberCount}**`,        inline: true },
          { name: '⚡ Commandes', value: `**${client.commands.size}**`,     inline: true },
        )
        .setFooter({ text: brand.footer('Bot tout-en-un'), iconURL })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🌐 Site')
          .setStyle(ButtonStyle.Link)
          .setURL(SITE_URL),
        new ButtonBuilder()
          .setLabel('💬 Serveur de support')
          .setStyle(ButtonStyle.Link)
          .setURL(SUPPORT_URL),
      );

      await owner.send({ embeds: [dmEmbed], components: [row] });
    } catch (err) {
      console.warn(`⚠️ DM owner impossible (${guild.name}) : ${err.message}`);
    }

    // ── Message dans le serveur ───────────────────────────────────────────────
    const me = guild.members?.me || null;
    const channel = guild.systemChannel ||
      guild.channels.cache
        .filter(c => c.isTextBased() && me && c.permissionsFor(me)?.has('SendMessages'))
        .sort((a, b) => a.position - b.position)
        .first();

    if (channel) {
      const serverEmbed = buildJoinEmbed({ client, guild, guildIcon });
      const row   = buildJoinRow();
      const files = [];

      if (bannerExists()) {
        try {
          files.push(new AttachmentBuilder(BANNER_PATH, { name: BANNER_NAME }));
        } catch (err) {
          console.warn(`⚠️ Bannière d'arrivée indisponible : ${err.message}`);
          serverEmbed.setImage(null);
        }
      }

      await channel.send({ embeds: [serverEmbed], components: [row], files }).catch(() => {
        // Une image refusée ne doit jamais priver le serveur du message d'accueil :
        // on renvoie exactement le même embed, sans bannière ni pièce jointe.
        if (!files.length) return;
        const fallback = buildJoinEmbed({ client, guild, guildIcon, banner: false });
        return channel.send({ embeds: [fallback], components: [row] }).catch(() => {});
      });
    }

    // ── Log interne vers le salon de logs du propriétaire du bot ─────────────
    const logChannelId = process.env.LOG_CHANNEL_ID;
    if (logChannelId) {
      const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
      if (logChannel) {
        const logEmbed = new EmbedBuilder()
          .setColor(0x57F287)
          .setAuthor({ name: '➕ Nouveau serveur', iconURL: guildIcon })
          .setTitle(guild.name)
          .setThumbnail(guildIcon)
          .addFields(
            { name: 'ID',         value: `\`${guild.id}\``,                                   inline: true },
            { name: 'Membres',    value: `**${guild.memberCount}**`,                           inline: true },
            { name: 'Total bot',  value: `**${totalGuilds}** serveurs`,                        inline: true },
            { name: 'Créé le',    value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
          )
          .setFooter({ text: `ID : ${guild.id}` })
          .setTimestamp();
        logChannel.send({ embeds: [logEmbed] }).catch(() => {});
      }
    }
  },
};
