'use strict';
// commands/configuration/youtube-sub.js
// Panel unique — /youtube-sub ouvre un panneau central avec liste, ajout et config

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits,
} = require('discord.js');

const YoutubeSubAlert    = require('../../models/YoutubeSubAlert');
const { resolveChannel } = require('../../utils/youtubeFetcher');
const { successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const licenseGate = require('../../utils/licenseGate');

// ─── Paliers par défaut ────────────────────────────────────────────────────────
const DEFAULT_MILESTONES = [
  10, 25, 50, 75,
  100, 250, 500, 750,
  1_000, 2_500, 5_000, 7_500,
  10_000, 25_000, 50_000, 75_000,
  100_000, 250_000, 500_000,
  1_000_000, 2_000_000, 5_000_000, 10_000_000,
];

function formatNumber(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return n.toLocaleString('fr-FR');
}

function getNextMilestone(current, milestones) {
  const list = milestones.length ? [...milestones].sort((a, b) => a - b) : DEFAULT_MILESTONES;
  return list.find(m => m > current) || null;
}

function buildProgressBar(current, next, length = 12) {
  if (!next) return '█'.repeat(length);
  const prev = DEFAULT_MILESTONES.filter(m => m <= current).pop() || 0;
  const pct  = Math.min(1, (current - prev) / (next - prev));
  const fill = Math.round(pct * length);
  return '█'.repeat(fill) + '░'.repeat(length - fill);
}

// ─── Embed de notification (aperçu) ───────────────────────────────────────────
function buildPreviewEmbed(alert, palier) {
  const current  = alert.lastSubCount || palier || 1000;
  const next     = getNextMilestone(current, alert.customMilestones);
  const progress = buildProgressBar(current, next);
  const vars = {
    '{chaine}':         alert.ytChannelName || 'Ma Chaîne',
    '{abonnes}':        formatNumber(current),
    '{palier}':         formatNumber(palier || current),
    '{prochainpalier}': next ? formatNumber(next) : '—',
    '{progression}':    progress,
    '{url}':            `https://youtube.com/channel/${alert.ytChannelId}`,
    '{serveur}':        'Votre Serveur',
  };
  let description = alert.customMessage
    || '🎉 **{chaine}** vient de franchir le cap des **{palier} abonnés** !\n\nTotal actuel : **{abonnes}** abonnés\n\n`{progression}` → **{prochainpalier}**';
  for (const [k, v] of Object.entries(vars)) description = description.replaceAll(k, v);
  const color = parseInt((alert.embedColor || '0xFF0000').replace('0x', ''), 16) || 0xFF0000;
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: (alert.ytChannelName || 'Chaîne YouTube').slice(0, 100), iconURL: alert.ytThumbnail || undefined })
    .setDescription(description.slice(0, 4000))
    .setThumbnail(alert.ytThumbnail || null)
    .setFooter({ text: 'Aperçu — notification YouTube Sub Alert' })
    .setTimestamp();
}

// ─── Embed du panel HOME (liste des chaînes) ───────────────────────────────────
function buildHomeEmbed(alerts, guildName) {
  const embed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🔔 YouTube Sub Alert')
    .setDescription(
      alerts.length === 0
        ? '> Aucune chaîne surveillée.\n> Cliquez sur **➕ Ajouter une chaîne** pour commencer.'
        : `**${alerts.length}** chaîne${alerts.length > 1 ? 's' : ''} surveillée${alerts.length > 1 ? 's' : ''} sur ce serveur.\nSélectionnez une chaîne pour la configurer.`
    )
    .setFooter({ text: `YouTube Sub Alert • ${guildName}` })
    .setTimestamp();

  if (alerts.length > 0) {
    embed.addFields({
      name: '📋 Chaînes actives',
      value: alerts.map((a, i) => {
        const next = getNextMilestone(a.lastSubCount || 0, a.customMilestones);
        return [
          `**${i + 1}. ${(a.ytChannelName || a.ytChannelId).slice(0, 50)}**`,
          `> ${a.enabled ? '✅' : '❌'} **${formatNumber(a.lastSubCount || 0)}** abonnés • Prochain : **${next ? formatNumber(next) : '—'}**`,
          `> Salon : ${a.channelId ? `<#${a.channelId}>` : '*non défini*'}`,
        ].join('\n');
      }).join('\n\n').slice(0, 4000),
    });
  }

  return embed;
}

// ─── Composants du panel HOME ─────────────────────────────────────────────────
function buildHomeComponents(alerts) {
  const rows = [];

  // Sélecteur de chaîne (si au moins une)
  if (alerts.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ysub_select_chain')
        .setPlaceholder('⚙️ Sélectionner une chaîne à configurer...')
        .addOptions(alerts.map(a => ({
          label: (a.ytChannelName || a.ytChannelId).slice(0, 100),
          value: a.ytChannelId,
          description: `${formatNumber(a.lastSubCount || 0)} abonnés • ${a.enabled ? 'Actif' : 'Désactivé'}`,
          emoji: a.enabled ? '✅' : '❌',
        }))),
    ));
  }

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ysub_btn_add')
      .setLabel('Ajouter une chaîne')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ysub_btn_variables')
      .setLabel('Variables')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ysub_btn_refresh')
      .setLabel('Actualiser')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  ));

  return rows;
}

// ─── Embed du panel CONFIG (une chaîne) ───────────────────────────────────────
function buildConfigEmbed(alert) {
  const milestones = alert.customMilestones.length
    ? alert.customMilestones.map(formatNumber).join(', ').slice(0, 500)
    : `Automatiques (${DEFAULT_MILESTONES.slice(0, 6).map(formatNumber).join(', ')}…)`;
  const next = getNextMilestone(alert.lastSubCount || 0, alert.customMilestones);

  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setAuthor({
      name: `⚙️ Configuration — ${(alert.ytChannelName || alert.ytChannelId).slice(0, 50)}`,
      iconURL: alert.ytThumbnail || undefined,
    })
    .setThumbnail(alert.ytThumbnail || null)
    .setDescription('Utilisez le menu ci-dessous pour modifier la configuration.')
    .addFields(
      {
        name: '📺 Chaîne',
        value: [
          `**${(alert.ytChannelName || '—').slice(0, 80)}**`,
          `\`${alert.ytChannelId}\``,
        ].join('\n'),
        inline: true,
      },
      {
        name: '📊 Abonnés',
        value: [
          `Actuel : **${formatNumber(alert.lastSubCount || 0)}**`,
          `Prochain : **${next ? formatNumber(next) : '—'}**`,
          alert.lastCheckedAt
            ? `Vérifié <t:${Math.floor(new Date(alert.lastCheckedAt).getTime() / 1000)}:R>`
            : 'Pas encore vérifié',
        ].join('\n'),
        inline: true,
      },
      {
        name: '⚙️ Paramètres',
        value: [
          `Salon : ${alert.channelId ? `<#${alert.channelId}>` : '*non défini*'}`,
          `Mention : ${alert.mentionRoleId ? `<@&${alert.mentionRoleId}>` : '*aucune*'}`,
          `Embed : **${alert.showEmbed ? 'Oui' : 'Non'}** • Couleur : \`#${(alert.embedColor || '0xFF0000').replace('0x', '')}\``,
          `Statut : ${alert.enabled ? '✅ Actif' : '❌ Désactivé'}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '🎯 Paliers',
        value: milestones,
        inline: false,
      },
      {
        name: '💬 Message',
        value: alert.customMessage
          ? '```' + alert.customMessage.slice(0, 800) + (alert.customMessage.length > 800 ? '…' : '') + '```'
          : '*Message par défaut*',
        inline: false,
      },
    )
    .setFooter({ text: 'YouTube Sub Alert • ← Retour pour voir la liste' })
    .setTimestamp();
}

// ─── Composants du panel CONFIG ────────────────────────────────────────────────
function buildConfigComponents(alert) {
  const row1 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ysub_config_action:${alert.ytChannelId}`)
      .setPlaceholder('⚙️ Modifier...')
      .addOptions([
        { label: 'Salon de notification', value: 'channel',    emoji: '📢' },
        { label: 'Rôle à mentionner',     value: 'role',       emoji: '🔔' },
        { label: 'Message personnalisé',  value: 'message',    emoji: '✏️' },
        { label: "Couleur de l'embed",    value: 'color',      emoji: '🎨' },
        { label: 'Paliers personnalisés', value: 'milestones', emoji: '🎯' },
        { label: 'Activer / Désactiver',  value: 'toggle',     emoji: '🔄' },
        { label: "Afficher l'embed",      value: 'embed',      emoji: '🖼️' },
      ]),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ysub_btn_preview:${alert.ytChannelId}`)
      .setLabel('Aperçu')
      .setEmoji('👁️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ysub_btn_test:${alert.ytChannelId}`)
      .setLabel('Tester')
      .setEmoji('📤')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ysub_btn_delete:${alert.ytChannelId}`)
      .setLabel('Supprimer')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ysub_btn_back')
      .setLabel('Retour')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

// ─── Embed variables ───────────────────────────────────────────────────────────
function buildVariablesEmbed() {
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('📝 Variables disponibles — YouTube Sub Alert')
    .setDescription('Utilisez ces variables dans votre message personnalisé.')
    .addFields(
      { name: '{chaine}',         value: 'Nom de la chaîne YouTube',            inline: true },
      { name: '{abonnes}',        value: 'Abonnés actuels (ex: 10,4k)',          inline: true },
      { name: '{palier}',         value: 'Palier franchi (ex: 10 000)',           inline: true },
      { name: '{prochainpalier}', value: 'Prochain palier',                       inline: true },
      { name: '{progression}',    value: 'Barre de progression ██████░░░░',       inline: true },
      { name: '{url}',            value: 'URL de la chaîne YouTube',              inline: true },
      { name: '{serveur}',        value: 'Nom du serveur Discord',                inline: true },
    )
    .addFields({
      name: '💡 Exemple',
      value: '```\n🎉 {chaine} vient de franchir {palier} abonnés !\n\n📊 Total : {abonnes} | 🎯 Prochain : {prochainpalier}\n`{progression}`\n🔗 {url}\n```',
    })
    .setFooter({ text: 'YouTube Sub Alert • REZO' });
}

// ─── Fetch abonnés ─────────────────────────────────────────────────────────────
async function fetchSubCount(ytChannelId) {
  const https = require('https');
  const key   = process.env.YOUTUBE_API_KEY;
  if (!key) return 0;
  return new Promise(resolve => {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${ytChannelId}&key=${key}`;
    const req = https.get(url, { timeout: 10000 }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(parseInt(JSON.parse(raw).items?.[0]?.statistics?.subscriberCount || '0', 10)); }
        catch { resolve(0); }
      });
      res.on('error', () => resolve(0));
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

// ─── Commande ─────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('youtube-sub')
    .setDescription('🔔 Gérer les notifications de paliers d\'abonnés YouTube')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: true });

    if (!process.env.YOUTUBE_API_KEY) {
      return interaction.editReply({ embeds: [errorEmbed('API non configurée', 'La clé `YOUTUBE_API_KEY` est absente du `.env`.')] });
    }

    const alerts = await YoutubeSubAlert.find({ guildId: interaction.guildId }).lean().exec();

    const reply = await interaction.editReply({
      embeds:     [buildHomeEmbed(alerts, interaction.guild.name)],
      components: buildHomeComponents(alerts),
    });

    // ── Collecteur principal ───────────────────────────────────────────────
    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time:   20 * 60 * 1000,
    });

    // État courant du panel
    let currentChainId = null; // null = HOME, string = CONFIG d'une chaîne

    col.on('collect', async i => {
      try {

        // ══════════════════════ BOUTONS HOME ══════════════════════════════

        // ── Actualiser ────────────────────────────────────────────────────
        if (i.customId === 'ysub_btn_refresh') {
          const fresh = await YoutubeSubAlert.find({ guildId: i.guild.id }).lean().exec();
          currentChainId = null;
          return i.update({ embeds: [buildHomeEmbed(fresh, i.guild.name)], components: buildHomeComponents(fresh) });
        }

        // ── Ajouter une chaîne ────────────────────────────────────────────
        if (i.customId === 'ysub_btn_add') {
          const count = await YoutubeSubAlert.countDocuments({ guildId: i.guild.id }).exec();
          if (count >= 10) {
            return i.reply({ embeds: [errorEmbed('Limite atteinte', 'Maximum **10** chaînes surveillées par serveur.')], ephemeral: true });
          }
          const modal = new ModalBuilder()
            .setCustomId('ysub_modal_add')
            .setTitle('Ajouter une chaîne YouTube');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('chain')
                .setLabel('Chaîne YouTube (ID, URL, @handle ou nom)')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)
                .setPlaceholder('ex: @PewDiePie ou https://youtube.com/@...'),
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('channel')
                .setLabel('ID du salon Discord de destination')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)
                .setPlaceholder('ex: 1234567890123456789'),
            ),
          );
          return i.showModal(modal);
        }

        // ── Variables ─────────────────────────────────────────────────────
        if (i.customId === 'ysub_btn_variables') {
          return i.reply({ embeds: [buildVariablesEmbed()], ephemeral: true });
        }

        // ── Sélection d'une chaîne → page config ──────────────────────────
        if (i.customId === 'ysub_select_chain') {
          const ytChannelId = i.values[0];
          const alert = await YoutubeSubAlert.findOne({ guildId: i.guild.id, ytChannelId }).exec();
          if (!alert) return i.update({ embeds: [errorEmbed('Introuvable')], components: [] });
          currentChainId = ytChannelId;
          return i.update({ embeds: [buildConfigEmbed(alert)], components: buildConfigComponents(alert) });
        }

        // ══════════════════════ BOUTONS CONFIG ════════════════════════════

        // ── Retour à la liste ─────────────────────────────────────────────
        if (i.customId === 'ysub_btn_back') {
          currentChainId = null;
          const fresh = await YoutubeSubAlert.find({ guildId: i.guild.id }).lean().exec();
          return i.update({ embeds: [buildHomeEmbed(fresh, i.guild.name)], components: buildHomeComponents(fresh) });
        }

        // ── Aperçu ────────────────────────────────────────────────────────
        if (i.customId.startsWith('ysub_btn_preview:')) {
          const ytChannelId = i.customId.split(':')[1];
          const alert = await YoutubeSubAlert.findOne({ guildId: i.guild.id, ytChannelId }).exec();
          if (!alert) return i.reply({ embeds: [errorEmbed('Introuvable')], ephemeral: true });
          const palier = getNextMilestone(alert.lastSubCount || 0, alert.customMilestones) || 1000;
          return i.reply({ embeds: [buildPreviewEmbed(alert, palier)], ephemeral: true });
        }

        // ── Test (envoie dans le vrai salon) ─────────────────────────────
        if (i.customId.startsWith('ysub_btn_test:')) {
          const ytChannelId = i.customId.split(':')[1];
          const alert = await YoutubeSubAlert.findOne({ guildId: i.guild.id, ytChannelId }).exec();
          if (!alert) return i.reply({ embeds: [errorEmbed('Introuvable')], ephemeral: true });
          if (!alert.channelId) return i.reply({ embeds: [errorEmbed('Salon non défini', 'Configurez d\'abord un salon dans ⚙️ Modifier.')], ephemeral: true });
          const dest = await i.guild.channels.fetch(alert.channelId).catch(() => null);
          if (!dest) return i.reply({ embeds: [errorEmbed('Salon introuvable')], ephemeral: true });
          const palier  = getNextMilestone(alert.lastSubCount || 0, alert.customMilestones) || 1000;
          const mention = alert.mentionRoleId ? `<@&${alert.mentionRoleId}> ` : '';
          await dest.send({ content: mention + '*(Test — YouTube Sub Alert)*', embeds: alert.showEmbed ? [buildPreviewEmbed(alert, palier)] : [] }).catch(() => {});
          return i.reply({ embeds: [successEmbed('Test envoyé', `Aperçu envoyé dans <#${alert.channelId}>.`)], ephemeral: true });
        }

        // ── Supprimer ─────────────────────────────────────────────────────
        if (i.customId.startsWith('ysub_btn_delete:')) {
          const ytChannelId = i.customId.split(':')[1];
          const alert = await YoutubeSubAlert.findOneAndDelete({ guildId: i.guild.id, ytChannelId }).exec();
          currentChainId = null;
          const fresh = await YoutubeSubAlert.find({ guildId: i.guild.id }).lean().exec();
          await i.reply({ embeds: [successEmbed('Alerte supprimée', `La surveillance de **${alert?.ytChannelName || ytChannelId}** a été supprimée.`)], ephemeral: true });
          return i.message.edit({ embeds: [buildHomeEmbed(fresh, i.guild.name)], components: buildHomeComponents(fresh) }).catch(() => {});
        }

        // ══════════════════════ MENU CONFIG ═══════════════════════════════

        if (i.customId.startsWith('ysub_config_action:')) {
          const ytChannelId = i.customId.split(':')[1];
          const action      = i.values[0];
          const fresh       = await YoutubeSubAlert.findOne({ guildId: i.guild.id, ytChannelId }).exec();
          if (!fresh) return i.update({ embeds: [errorEmbed('Introuvable')], components: [] });

          // toggle actif/inactif
          if (action === 'toggle') {
            fresh.enabled = !fresh.enabled;
            await fresh.save();
            return i.update({ embeds: [buildConfigEmbed(fresh)], components: buildConfigComponents(fresh) });
          }

          // toggle embed
          if (action === 'embed') {
            fresh.showEmbed = !fresh.showEmbed;
            await fresh.save();
            return i.update({ embeds: [buildConfigEmbed(fresh)], components: buildConfigComponents(fresh) });
          }

          // Salon → ChannelSelect
          if (action === 'channel') {
            const row = new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder()
                .setCustomId(`ysub_set_channel:${ytChannelId}`)
                .setPlaceholder('📢 Choisir le salon de notification...')
                .addChannelTypes(ChannelType.GuildText),
            );
            return i.reply({ content: '📢 Sélectionnez le salon de destination :', components: [row], ephemeral: true });
          }

          // Rôle → RoleSelect
          if (action === 'role') {
            const rowRole   = new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId(`ysub_set_role:${ytChannelId}`)
                .setPlaceholder('🔔 Choisir le rôle à mentionner...'),
            );
            const rowRemove = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`ysub_remove_role:${ytChannelId}`)
                .setLabel('Retirer la mention')
                .setStyle(ButtonStyle.Danger),
            );
            return i.reply({ content: '🔔 Sélectionnez le rôle à mentionner :', components: [rowRole, rowRemove], ephemeral: true });
          }

          // Message → Modal
          if (action === 'message') {
            const modal = new ModalBuilder()
              .setCustomId(`ysub_modal_message:${ytChannelId}`)
              .setTitle('Message personnalisé');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('val')
                .setLabel('Message (variables: {chaine}, {abonnes}…)')
                .setStyle(TextInputStyle.Paragraph)
                .setValue((fresh.customMessage || '').slice(0, 1500))
                .setRequired(false).setMaxLength(1500)
                .setPlaceholder('🎉 {chaine} vient de franchir {palier} abonnés !'),
            ));
            return i.showModal(modal);
          }

          // Couleur → Modal
          if (action === 'color') {
            const modal = new ModalBuilder()
              .setCustomId(`ysub_modal_color:${ytChannelId}`)
              .setTitle('Couleur de l\'embed');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('val')
                .setLabel('Code hex (ex: FF0000 pour rouge)')
                .setStyle(TextInputStyle.Short)
                .setValue((fresh.embedColor || '0xFF0000').replace('0x', '').replace('#', '').slice(0, 6))
                .setRequired(true).setMaxLength(6),
            ));
            return i.showModal(modal);
          }

          // Paliers → Modal
          if (action === 'milestones') {
            const modal = new ModalBuilder()
              .setCustomId(`ysub_modal_milestones:${ytChannelId}`)
              .setTitle('Paliers personnalisés');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('val')
                .setLabel('Paliers séparés par des virgules')
                .setStyle(TextInputStyle.Short)
                .setValue(fresh.customMilestones.join(', '))
                .setRequired(false).setMaxLength(200)
                .setPlaceholder('10, 100, 1000, 10000, 100000'),
            ));
            return i.showModal(modal);
          }
        }

      } catch (err) {
        console.error('[youtube-sub] collector:', err.message);
      }
    });

    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Handlers externes ────────────────────────────────────────────────────

  async handleModal(interaction) {
    const id  = interaction.customId;
    const guild = interaction.guild;

    // ── Ajout d'une chaîne ────────────────────────────────────────────────
    if (id === 'ysub_modal_add') {
      const chainInput   = interaction.fields.getTextInputValue('chain').trim();
      const channelInput = interaction.fields.getTextInputValue('channel').trim();

      // Vérifier le salon
      const dest = await guild.channels.fetch(channelInput).catch(() => null);
      if (!dest || !dest.isTextBased()) {
        return interaction.reply({ embeds: [errorEmbed('Salon invalide', `Impossible de trouver le salon \`${channelInput}\`.\nVérifiez l'ID et réessayez.`)], ephemeral: true });
      }

      // Vérifier la limite
      const count = await YoutubeSubAlert.countDocuments({ guildId: guild.id }).exec();
      if (count >= 10) {
        return interaction.reply({ embeds: [errorEmbed('Limite atteinte', 'Maximum **10** chaînes surveillées par serveur.')], ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      // Résoudre la chaîne YouTube
      const ytInfo = await resolveChannel(chainInput).catch(() => null);
      if (!ytInfo?.channelId) {
        return interaction.editReply({ embeds: [errorEmbed('Chaîne introuvable', `Impossible de trouver la chaîne YouTube \`${chainInput}\`.\nEssayez avec l'ID direct (UC...), une URL ou @handle.`)] });
      }

      // Vérifier doublon
      const existing = await YoutubeSubAlert.findOne({ guildId: guild.id, ytChannelId: ytInfo.channelId }).exec();
      if (existing) {
        return interaction.editReply({ embeds: [errorEmbed('Déjà surveillée', `La chaîne **${ytInfo.title}** est déjà surveillée dans ce serveur.`)] });
      }

      // Fetch abonnés actuels
      const subCount = await fetchSubCount(ytInfo.channelId);

      // Créer l'alerte
      await YoutubeSubAlert.create({
        guildId:           guild.id,
        channelId:         dest.id,
        addedBy:           interaction.user.id,
        ytChannelId:       ytInfo.channelId,
        ytChannelName:     ytInfo.title,
        ytThumbnail:       ytInfo.thumbnail,
        lastSubCount:      subCount,
        lastNotifiedCount: subCount,
      });

      return interaction.editReply({ embeds: [successEmbed('Chaîne ajoutée !', [
        `**${ytInfo.title}** est maintenant surveillée.`,
        `📊 Abonnés actuels : **${formatNumber(subCount)}**`,
        `📢 Notifications dans : <#${dest.id}>`,
        `🎯 Prochain palier : **${formatNumber(getNextMilestone(subCount, []) || 0)}**`,
        '',
        'Retournez dans le panel `/youtube-sub` pour configurer les messages et paliers.',
      ].join('\n'))] });
    }

    // ── Modaux de config ──────────────────────────────────────────────────
    const parts       = id.split(':');
    const type        = parts[0];
    const ytChannelId = parts[1];
    const val         = interaction.fields.getTextInputValue('val').trim();
    const alert       = await YoutubeSubAlert.findOne({ guildId: guild.id, ytChannelId }).exec();
    if (!alert) return interaction.reply({ embeds: [errorEmbed('Introuvable')], ephemeral: true });

    if (type === 'ysub_modal_message') {
      alert.customMessage = val || null;
      await alert.save();
      return interaction.reply({ embeds: [successEmbed('Message mis à jour', val ? 'Message personnalisé enregistré.' : 'Message par défaut rétabli.')], ephemeral: true });
    }

    if (type === 'ysub_modal_color') {
      const hex = val.replace(/^#/, '');
      if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
        return interaction.reply({ embeds: [errorEmbed('Couleur invalide', 'Utilisez un code hex à 6 caractères (ex: FF0000).')], ephemeral: true });
      }
      alert.embedColor = `0x${hex.toUpperCase()}`;
      await alert.save();
      return interaction.reply({ embeds: [successEmbed('Couleur mise à jour', `Couleur : \`#${hex.toUpperCase()}\``)], ephemeral: true });
    }

    if (type === 'ysub_modal_milestones') {
      if (!val) {
        alert.customMilestones = [];
        await alert.save();
        return interaction.reply({ embeds: [successEmbed('Paliers réinitialisés', 'Paliers automatiques rétablis.')], ephemeral: true });
      }
      const parsed = val.split(',')
        .map(s => parseInt(s.trim().replace(/[^0-9]/g, ''), 10))
        .filter(n => !isNaN(n) && n > 0)
        .sort((a, b) => a - b)
        .slice(0, 20);
      if (!parsed.length) {
        return interaction.reply({ embeds: [errorEmbed('Paliers invalides', 'Entrez des nombres séparés par des virgules (ex: 100, 500, 1000).')], ephemeral: true });
      }
      alert.customMilestones = parsed;
      await alert.save();
      return interaction.reply({ embeds: [successEmbed('Paliers mis à jour', `${parsed.length} palier(s) : ${parsed.map(formatNumber).join(', ')}`)], ephemeral: true });
    }
  },

  async handleSelect(interaction) {
    if (!(await licenseGate.guardComponent(interaction, 'youtube-sub'))) return;

    const [type, ytChannelId] = interaction.customId.split(':');
    const alert = await YoutubeSubAlert.findOne({ guildId: interaction.guild.id, ytChannelId }).exec();
    if (!alert) return interaction.reply({ embeds: [errorEmbed('Introuvable')], ephemeral: true });

    if (type === 'ysub_set_channel') {
      alert.channelId = interaction.values[0];
      await alert.save();
      return interaction.reply({ embeds: [successEmbed('Salon mis à jour', `Notifications dans <#${alert.channelId}>.`)], ephemeral: true });
    }

    if (type === 'ysub_set_role') {
      alert.mentionRoleId = interaction.values[0];
      await alert.save();
      return interaction.reply({ embeds: [successEmbed('Rôle défini', `<@&${alert.mentionRoleId}> sera mentionné à chaque palier.`)], ephemeral: true });
    }
  },

  async handleButton(interaction) {
    if (!(await licenseGate.guardComponent(interaction, 'youtube-sub'))) return;

    const [type, ytChannelId] = interaction.customId.split(':');
    if (type === 'ysub_remove_role') {
      const alert = await YoutubeSubAlert.findOne({ guildId: interaction.guild.id, ytChannelId }).exec();
      if (!alert) return interaction.reply({ embeds: [errorEmbed('Introuvable')], ephemeral: true });
      alert.mentionRoleId = null;
      await alert.save();
      return interaction.reply({ embeds: [successEmbed('Mention retirée', 'Plus aucun rôle ne sera mentionné.')], ephemeral: true });
    }
  },

  // Exposé pour le scheduler
  formatNumber,
  getNextMilestone,
  buildProgressBar,
  DEFAULT_MILESTONES,
  buildPreviewEmbed,
};
