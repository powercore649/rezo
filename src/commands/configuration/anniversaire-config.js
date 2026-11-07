'use strict';
// commands/configuration/anniversaire-config.js — 🎂 Panneau des anniversaires.
//
// Panneau persistant (routé par interactionCreate, pas de collecteur qui expire
// au bout de 10 minutes) avec tout ce qu'il faut pour que le système fonctionne
// réellement : activation, salon, rôle du jour, rôle mentionné, message, heure
// d'annonce, fuseau horaire, test immédiat, et aperçu des prochains inscrits.
//
// Le panneau refuse d'activer le système sans salon : auparavant on pouvait
// l'activer dans le vide, et rien ne partait — sans le moindre message.

const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');

const BirthdayConfig = require('../../models/BirthdayConfig');
const Birthday = require('../../models/Birthday');
const { COLORS } = require('../../utils/embeds');
const brand = require('../../utils/brand');
const engine = require('../../utils/birthdayEngine');
const { buildAnnouncement } = require('../../utils/birthdayScheduler');

async function getOrCreate(guildId) {
  let cfg = await BirthdayConfig.findOne({ guildId });
  if (!cfg) cfg = await BirthdayConfig.create({ guildId });
  return cfg;
}

function ownsPanel(interaction) {
  const ownerId = interaction?.message?.interactionMetadata?.user?.id;
  if (!ownerId) return true; // panneau éphémère : seul l'auteur le voit
  return ownerId === interaction?.user?.id;
}

async function loadStats(guildId, cfg) {
  let docs = [];
  try { docs = await Birthday.find({ guildId }); } catch { docs = []; }
  const list = docs.map(doc => (typeof doc.toObject === 'function' ? doc.toObject() : doc));
  const today = engine.partsInTimeZone(new Date(), engine.sanitizeTimezone(cfg.timezone));
  const upcoming = engine.sortUpcoming(
    list.filter(doc => doc.day && doc.month),
    today,
  ).slice(0, 5);
  return { count: list.length, upcoming, today };
}

function buildPanel(cfg, { guild = null, stats = null } = {}) {
  const timezone = engine.sanitizeTimezone(cfg.timezone);
  const hour = engine.sanitizeHour(cfg.announceHour);
  const upcoming = stats?.upcoming || [];

  let state = cfg.enabled ? '🟢 Activé' : '🔴 Désactivé';
  if (cfg.enabled && !cfg.channelId) state += '\n⚠️ aucun salon d’annonce';
  else if (cfg.enabled) state += '\n✅ prêt à annoncer';

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: `${brand.BRAND.name} • Anniversaires` })
    .setTitle('🎂 Anniversaires — Panneau de configuration')
    .setDescription([
      'Tout se configure ici. Le bot vérifie les anniversaires **toutes les heures**',
      'et rattrape les annonces manquées après un redémarrage.',
      '',
      `**${stats?.count ?? '—'}** membre(s) ont enregistré leur date avec \`/anniversaire definir\`.`,
    ].join('\n'))
    .addFields(
      { name: 'État', value: state, inline: true },
      { name: 'Salon d’annonce', value: cfg.channelId ? `<#${cfg.channelId}>` : '*Non défini*', inline: true },
      { name: 'Heure d’annonce', value: `**${hour}h** — \`${timezone}\``, inline: true },
      { name: 'Rôle du jour', value: cfg.roleId ? `<@&${cfg.roleId}>` : '*Aucun*', inline: true },
      { name: 'Rôle mentionné', value: cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : '*Aucun*', inline: true },
      { name: 'Annonces en attente', value: 'Réessayées automatiquement en cas d’échec', inline: true },
      {
        name: '📅 Prochains anniversaires',
        value: upcoming.length
          ? upcoming.map(item => `<@${item.userId}> — **${item.label}**${item.daysUntil === 0 ? ' *(aujourd’hui)*' : ` (dans ${item.daysUntil} j)`}`).join('\n').slice(0, 1024)
          : '*Aucune date enregistrée pour le moment.*',
      },
      {
        name: '💬 Message',
        value: `\`\`\`${String(cfg.message || engine.DEFAULT_MESSAGE).slice(0, 900)}\`\`\``,
      },
    )
    .setFooter({
      text: brand.footer('Variables : {user}, {server} · vérification horaire'),
    })
    .setTimestamp();

  if (guild?.iconURL) {
    const icon = guild.iconURL({ size: 128 });
    if (icon) embed.setThumbnail(icon);
  }

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bd_toggle')
      .setLabel(cfg.enabled ? 'Désactiver' : 'Activer')
      .setEmoji(cfg.enabled ? '🔴' : '🟢')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bd_message').setLabel('Message').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bd_settings').setLabel('Heure & fuseau').setEmoji('🕘').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bd_test').setLabel('Tester').setEmoji('📨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('bd_close').setLabel('Fermer').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
  );

  const channelRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('bd_channel')
      .setPlaceholder('📍 Choisir le salon d’annonce')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );

  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('bd_role')
      .setPlaceholder('🎉 Rôle donné le jour J (optionnel)')
      .setMinValues(0).setMaxValues(1),
  );

  const pingRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('bd_ping_role')
      .setPlaceholder('📣 Rôle à mentionner (optionnel)')
      .setMinValues(0).setMaxValues(1),
  );

  return { embeds: [embed], components: [buttons, channelRow, roleRow, pingRow] };
}

function closedPanel(cfg) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('🎂 Panneau fermé')
      .setDescription(cfg.enabled
        ? `Les anniversaires restent actifs : annonce à **${engine.sanitizeHour(cfg.announceHour)}h** (${engine.sanitizeTimezone(cfg.timezone)}).\nRouvre le panneau avec \`/anniversaire-config\`.`
        : 'Les anniversaires sont désactivés. Rouvre le panneau avec `/anniversaire-config`.')],
    components: [],
  };
}

async function refresh(interaction, guildId) {
  const cfg = await getOrCreate(guildId);
  const stats = await loadStats(guildId, cfg);
  return buildPanel(cfg, { guild: interaction.guild, stats });
}

module.exports = {
  getOrCreate,
  buildPanel,
  loadStats,
  closedPanel,
  ownsPanel,

  data: new SlashCommandBuilder()
    .setName('anniversaire-config')
    .setDescription('🎂 Ouvrir le panneau de configuration des anniversaires')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ Ce panneau se configure depuis un serveur.', ephemeral: true });
    }
    const cfg = await getOrCreate(interaction.guild.id);
    const stats = await loadStats(interaction.guild.id, cfg);
    return interaction.reply({
      ...buildPanel(cfg, { guild: interaction.guild, stats }),
      ephemeral: true,
    });
  },

  // ── Boutons ────────────────────────────────────────────────────────────────
  async handleButton(interaction) {
    if (!ownsPanel(interaction)) {
      return interaction.reply({ content: '❌ Seule la personne ayant ouvert ce panneau peut l’utiliser.', ephemeral: true });
    }
    const cfg = await getOrCreate(interaction.guildId);

    switch (interaction.customId) {
      case 'bd_close':
        return interaction.update(closedPanel(cfg));

      case 'bd_toggle': {
        if (!cfg.enabled && !cfg.channelId) {
          return interaction.reply({
            content: '⚠️ Choisis d’abord un **salon d’annonce** : sans salon, aucun anniversaire ne pourrait être publié.',
            ephemeral: true,
          });
        }
        cfg.enabled = !cfg.enabled;
        await cfg.save();
        return interaction.update(await refresh(interaction, interaction.guildId));
      }

      case 'bd_message': {
        const modal = new ModalBuilder().setCustomId('bd_modal_message').setTitle('Message d’anniversaire');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('value')
            .setLabel('Message — variables {user} et {server}')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(String(cfg.message || engine.DEFAULT_MESSAGE).slice(0, 2000))
            .setMaxLength(1500)
            .setRequired(true),
        ));
        return interaction.showModal(modal);
      }

      case 'bd_settings': {
        const modal = new ModalBuilder().setCustomId('bd_modal_settings').setTitle('Heure et fuseau d’annonce');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('hour')
              .setLabel('Heure d’annonce (0 à 23)')
              .setStyle(TextInputStyle.Short)
              .setValue(String(engine.sanitizeHour(cfg.announceHour)))
              .setMaxLength(2)
              .setRequired(true),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('timezone')
              .setLabel('Fuseau horaire (ex : Europe/Paris)')
              .setPlaceholder(engine.TIMEZONE_CHOICES.map(choice => choice.value).slice(0, 3).join(', '))
              .setStyle(TextInputStyle.Short)
              .setValue(engine.sanitizeTimezone(cfg.timezone))
              .setMaxLength(64)
              .setRequired(true),
          ),
        );
        return interaction.showModal(modal);
      }

      case 'bd_test': {
        const channel = cfg.channelId ? interaction.guild.channels.cache.get(cfg.channelId) : null;
        if (!channel || typeof channel.send !== 'function') {
          return interaction.reply({ content: '⚠️ Aucun salon d’annonce valide : choisis-en un avant de tester.', ephemeral: true });
        }
        const member = interaction.member;
        if (!member) {
          return interaction.reply({ content: '❌ Test impossible sans membre de serveur.', ephemeral: true });
        }
        const payload = buildAnnouncement({
          message: cfg.message,
          member,
          guild: interaction.guild,
          pingRoleId: cfg.pingRoleId,
        });
        const sent = await channel.send(payload).then(() => true).catch(() => false);
        return interaction.reply({
          content: sent
            ? `✅ Annonce de test envoyée dans <#${cfg.channelId}>. Elle n’est pas comptée comme un vrai anniversaire.`
            : `❌ Envoi impossible dans <#${cfg.channelId}> — vérifie les permissions du bot (**Voir le salon**, **Envoyer des messages**, **Intégrer des liens**).`,
          ephemeral: true,
        });
      }

      default:
        return interaction.reply({ content: '❌ Action inconnue.', ephemeral: true });
    }
  },

  // ── Sélecteurs ────────────────────────────────────────────────────────────
  async handleSelect(interaction) {
    if (!ownsPanel(interaction)) {
      return interaction.reply({ content: '❌ Seule la personne ayant ouvert ce panneau peut l’utiliser.', ephemeral: true });
    }
    const cfg = await getOrCreate(interaction.guildId);
    const value = interaction.values?.[0] || null;

    if (interaction.customId === 'bd_channel') {
      cfg.channelId = value;
      // Un salon supprimé ne doit pas laisser le système « actif mais muet ».
      if (!value) cfg.enabled = false;
      await cfg.save();
    } else if (interaction.customId === 'bd_role') {
      cfg.roleId = value;
      await cfg.save();
    } else if (interaction.customId === 'bd_ping_role') {
      cfg.pingRoleId = value;
      await cfg.save();
    } else {
      return interaction.reply({ content: '❌ Action inconnue.', ephemeral: true });
    }

    return interaction.update(await refresh(interaction, interaction.guildId));
  },

  // ── Modales ───────────────────────────────────────────────────────────────
  async handleModal(interaction) {
    if (!ownsPanel(interaction)) {
      return interaction.reply({ content: '❌ Seule la personne ayant ouvert ce panneau peut l’utiliser.', ephemeral: true });
    }
    const cfg = await getOrCreate(interaction.guildId);
    const get = name => interaction.fields.getTextInputValue(name);

    if (interaction.customId === 'bd_modal_message') {
      const value = String(get('value') || '').trim();
      if (!value) {
        return interaction.reply({ content: '❌ Le message ne peut pas être vide.', ephemeral: true });
      }
      cfg.message = value.slice(0, 1500);
      await cfg.save();
      return interaction.update(await refresh(interaction, interaction.guildId));
    }

    if (interaction.customId === 'bd_modal_settings') {
      const rawHour = String(get('hour') || '').trim();
      const rawTz = String(get('timezone') || '').trim();
      const hour = Number(rawHour);
      if (!/^\d{1,2}$/.test(rawHour) || !Number.isInteger(hour) || hour < 0 || hour > 23) {
        return interaction.reply({ content: '❌ Heure invalide : indique un nombre entier entre **0** et **23**.', ephemeral: true });
      }
      if (!engine.isValidTimeZone(rawTz)) {
        const examples = engine.TIMEZONE_CHOICES.slice(0, 4).map(choice => `\`${choice.value}\``).join(', ');
        return interaction.reply({
          content: `❌ Fuseau inconnu : **${rawTz || '(vide)'}**. Exemples valides : ${examples}.`,
          ephemeral: true,
        });
      }
      cfg.announceHour = hour;
      cfg.timezone = rawTz;
      await cfg.save();
      return interaction.update(await refresh(interaction, interaction.guildId));
    }

    return interaction.reply({ content: '❌ Formulaire inconnu.', ephemeral: true });
  },
};
