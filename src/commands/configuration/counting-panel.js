'use strict';
// commands/counting-panel.js — 🔢 Système de Counting Game — setup & panel de configuration

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const CountingGame = require('../../models/CountingGame');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');
const { pickNextSecretTarget } = require('../../utils/countingGame');

const MODE_LABEL = {
  secret:    '🎁 Nombre mystère caché',
  milestone: '🏆 Paliers fixes',
  both:      '🎁🏆 Nombre mystère + paliers',
  none:      '🚫 Aucune récompense',
};

// ════════════════════════════════════════════════════════════════════════════
//  EMBEDS & COMPOSANTS
// ════════════════════════════════════════════════════════════════════════════
function buildPanelEmbed(guild, cfg) {
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('🔢 Panel — Counting Game')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setDescription(cfg?.channelId
      ? 'Configurez les règles et les récompenses du salon de comptage.'
      : '⚠️ Aucun salon configuré. Choisissez-en un pour démarrer.')
    .addFields(
      { name: 'Statut', value: cfg?.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Salon', value: cfg?.channelId ? `<#${cfg.channelId}>` : '*Non défini*', inline: true },
      { name: 'Compte actuel', value: `**${cfg?.currentCount ?? 0}**`, inline: true },
      { name: 'Meilleur score', value: `**${cfg?.highestCount ?? 0}**`, inline: true },
      { name: 'Même membre 2x d\'affilée', value: cfg?.allowSameUserTwice ? '✅ Autorisé' : '❌ Interdit', inline: true },
      { name: 'Reset si erreur', value: cfg?.resetOnFail ? '✅ Oui' : '❌ Non (reprend au dernier bon nombre)', inline: true },
      { name: 'Supprimer messages faux', value: cfg?.deleteWrongMessages ? '✅ Oui' : '❌ Non', inline: true },
      { name: 'Mode récompense', value: MODE_LABEL[cfg?.rewardMode] || '—', inline: true },
      { name: 'Palier (si activé)', value: `Tous les **${cfg?.milestoneEvery ?? 100}**`, inline: true },
      { name: 'Rôle récompense', value: cfg?.rewardRoleId ? `<@&${cfg.rewardRoleId}>` : '*Aucun*', inline: true },
      { name: '🎉 Cadeaux trouvés', value: `**${cfg?.totalWins ?? 0}**`, inline: true },
      { name: '💥 Comptes cassés', value: `**${cfg?.totalFails ?? 0}**`, inline: true },
    )
    .setFooter({ text: 'REZO • Counting Game — Le nombre mystère n\'est jamais révélé' })
    .setTimestamp();
  return embed;
}

function buildPanelComponents(cfg) {
  const rows = [];

  rows.push(new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('cnt_edit_channel')
      .setPlaceholder('📢 Choisir / changer le salon de comptage...')
      .setChannelTypes(ChannelType.GuildText),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('cnt_edit_mode')
      .setPlaceholder('🎁 Mode de récompense...')
      .addOptions(Object.entries(MODE_LABEL).map(([value, label]) => ({ label, value }))),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('cnt_edit_role').setPlaceholder('🔔 Rôle récompense (optionnel)...'),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cnt_toggle_enabled').setLabel(cfg?.enabled ? 'Désactiver' : 'Activer').setEmoji(cfg?.enabled ? '⏸️' : '▶️').setStyle(cfg?.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cnt_toggle_same_user').setLabel('Membre 2x').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cnt_toggle_reset').setLabel('Reset si erreur').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cnt_toggle_delete').setLabel('Suppr. messages faux').setEmoji('🗑️').setStyle(ButtonStyle.Secondary),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cnt_edit_milestone').setLabel('Palier / plage secrète').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cnt_edit_message').setLabel('Message récompense').setEmoji('💬').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cnt_reset_count').setLabel('Remettre à 0').setEmoji('🔄').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('cnt_refresh').setLabel('Actualiser').setEmoji('🔃').setStyle(ButtonStyle.Primary),
  ));

  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
//  COMMANDE
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('counting-panel')
    .setDescription('🔢 Système de Counting Game — configuration')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s
      .setName('setup')
      .setDescription('🚀 Démarrer le counting game dans un salon')
      .addChannelOption((o) => o.setName('salon').setDescription('Salon dédié au comptage').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addIntegerOption((o) => o.setName('depart').setDescription('Nombre de départ (défaut : 0)').setMinValue(0).setRequired(false)))
    .addSubcommand((s) => s
      .setName('panel')
      .setDescription('⚙️ Ouvrir le panel de configuration'))
    .addSubcommand((s) => s
      .setName('stats')
      .setDescription('📊 Voir les statistiques du counting game')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // ── /counting-panel setup ───────────────────────────────────────────────
    if (sub === 'setup') {
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.options.getChannel('salon');
      const depart  = interaction.options.getInteger('depart') ?? 0;

      const perms = channel.permissionsFor(interaction.guild.members.me);
      if (!perms?.has(['SendMessages', 'ManageMessages', 'AddReactions', 'ViewChannel'])) {
        return interaction.editReply({ embeds: [errorEmbed('Permissions manquantes', `Je dois avoir **Envoyer des messages**, **Gérer les messages** et **Ajouter des réactions** dans <#${channel.id}>.`)] });
      }

      let cfg = await CountingGame.findOne({ guildId });
      const secretTarget = pickNextSecretTarget({ secretMin: 10, secretMax: 100 }, depart);

      if (cfg) {
        cfg.channelId     = channel.id;
        cfg.enabled       = true;
        cfg.currentCount  = depart;
        cfg.lastUserId    = null;
        cfg.secretTarget  = secretTarget;
        await cfg.save();
      } else {
        cfg = await CountingGame.create({ guildId, channelId: channel.id, enabled: true, currentCount: depart, secretTarget });
      }

      return interaction.editReply({
        embeds: [successEmbed('Counting Game activé !', `📢 Salon : <#${channel.id}>\n🔢 Prochain nombre attendu : **${depart + 1}**\n🎁 Un nombre mystère est déjà caché quelque part...`)],
      });
    }

    // ── /counting-panel stats ───────────────────────────────────────────────
    if (sub === 'stats') {
      await interaction.deferReply({ ephemeral: true });
      const cfg = await CountingGame.findOne({ guildId });
      if (!cfg) return interaction.editReply({ embeds: [errorEmbed('Non configuré', 'Utilisez `/counting-panel setup` pour démarrer.')] });
      return interaction.editReply({ embeds: [buildPanelEmbed(interaction.guild, cfg)] });
    }

    // ── /counting-panel panel ───────────────────────────────────────────────
    if (sub === 'panel') {
      await interaction.deferReply({ ephemeral: true });
      let cfg = await CountingGame.findOne({ guildId });

      const reply = await interaction.editReply({
        embeds:     [buildPanelEmbed(interaction.guild, cfg)],
        components: buildPanelComponents(cfg),
      });

      const col = reply.createMessageComponentCollector({
        filter: (i) => i.user.id === interaction.user.id,
        time:   15 * 60 * 1000,
      });

      col.on('collect', async (i) => {
        try {
          const id = i.customId;

          if (!cfg && id !== 'cnt_edit_channel') {
            return i.reply({ embeds: [errorEmbed('Non configuré', 'Choisissez d\'abord un salon.')], ephemeral: true });
          }

          if (id === 'cnt_refresh') {
            cfg = await CountingGame.findOne({ guildId });
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_edit_channel') {
            const channelId = i.values[0];
            const secretTarget = pickNextSecretTarget({ secretMin: 10, secretMax: 100 }, 0);
            cfg = await CountingGame.findOneAndUpdate(
              { guildId },
              { $setOnInsert: { currentCount: 0, secretTarget }, channelId, enabled: true },
              { upsert: true, new: true },
            );
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_edit_mode') {
            cfg.rewardMode = i.values[0];
            if ((cfg.rewardMode === 'secret' || cfg.rewardMode === 'both') && cfg.secretTarget === null) {
              cfg.secretTarget = pickNextSecretTarget(cfg, cfg.currentCount);
            }
            await cfg.save();
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_edit_role') {
            cfg.rewardRoleId = i.values[0];
            await cfg.save();
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_toggle_enabled') {
            cfg.enabled = !cfg.enabled;
            await cfg.save();
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_toggle_same_user') {
            cfg.allowSameUserTwice = !cfg.allowSameUserTwice;
            await cfg.save();
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_toggle_reset') {
            cfg.resetOnFail = !cfg.resetOnFail;
            await cfg.save();
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_toggle_delete') {
            cfg.deleteWrongMessages = !cfg.deleteWrongMessages;
            await cfg.save();
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_reset_count') {
            cfg.currentCount = 0;
            cfg.lastUserId   = null;
            cfg.secretTarget = pickNextSecretTarget(cfg, 0);
            await cfg.save();
            await i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
            return i.followUp({ embeds: [successEmbed('Compteur réinitialisé', 'Prochain nombre attendu : **1**')], ephemeral: true }).catch(() => {});
          }

          if (id === 'cnt_edit_milestone') {
            const modal = new ModalBuilder().setCustomId('cnt_modal_milestone').setTitle('✏️ Palier & plage secrète');
            modal.addComponents(
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('cnt_milestone_every').setLabel('Palier fixe (ex: 100)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.milestoneEvery || 100)),
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('cnt_secret_min').setLabel('Plage secrète — minimum').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.secretMin || 10)),
              ),
              new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('cnt_secret_max').setLabel('Plage secrète — maximum').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.secretMax || 100)),
              ),
            );
            await i.showModal(modal);

            const modalSubmit = await i.awaitModalSubmit({
              filter: (m) => m.customId === 'cnt_modal_milestone' && m.user.id === interaction.user.id,
              time: 180_000,
            }).catch(() => null);
            if (!modalSubmit) return;

            const every = parseInt(modalSubmit.fields.getTextInputValue('cnt_milestone_every'), 10);
            const min   = parseInt(modalSubmit.fields.getTextInputValue('cnt_secret_min'), 10);
            const max   = parseInt(modalSubmit.fields.getTextInputValue('cnt_secret_max'), 10);

            if (Number.isFinite(every) && every > 0) cfg.milestoneEvery = every;
            if (Number.isFinite(min) && min > 0) cfg.secretMin = min;
            if (Number.isFinite(max) && max >= cfg.secretMin) cfg.secretMax = max;
            cfg.secretTarget = pickNextSecretTarget(cfg, cfg.currentCount);
            await cfg.save();

            return modalSubmit.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          if (id === 'cnt_edit_message') {
            const modal = new ModalBuilder().setCustomId('cnt_modal_message').setTitle('💬 Message de récompense');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('cnt_msg_value')
                .setLabel('Message (vide = message par défaut)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Placeholders : {user} {number}')
                .setRequired(false)
                .setMaxLength(500)
                .setValue(cfg.rewardMessage || ''),
            ));
            await i.showModal(modal);

            const modalSubmit = await i.awaitModalSubmit({
              filter: (m) => m.customId === 'cnt_modal_message' && m.user.id === interaction.user.id,
              time: 180_000,
            }).catch(() => null);
            if (!modalSubmit) return;

            cfg.rewardMessage = modalSubmit.fields.getTextInputValue('cnt_msg_value')?.trim() || null;
            await cfg.save();
            return modalSubmit.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }
        } catch (err) {
          console.error('[CountingPanel] panel:', err);
          const payload = { embeds: [errorEmbed('Erreur', 'Une erreur est survenue. Réessayez.')], ephemeral: true };
          if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
          else await i.reply(payload).catch(() => {});
        }
      });

      col.on('end', () => { interaction.editReply({ components: [] }).catch(() => {}); });
      return;
    }
  },
};
