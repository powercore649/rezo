'use strict';
// commands/configuration/recap.js — 📊 Récap hebdomadaire d'activité — PANEL UNIQUE
//
// Une seule commande `/recap` ouvre un panel interactif : salon de publication,
// rôle à mentionner, fréquence, sections affichées, activation, aperçu et envoi
// immédiat. L'envoi automatique est assuré par le cron de src/index.js.
//
// Fonctionnalité sous licence : l'ouverture du panel est déjà filtrée par le
// routeur (interactionCreate + LICENSE_REQUIRED_COMMANDS) ; l'activation et
// l'envoi immédiat revérifient l'accès (au cas où la licence expirerait pendant
// que le panel reste ouvert).

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

const WeeklyRecap = require('../../models/WeeklyRecap');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');
const { generateRecap, buildGuildSnapshot, DEFAULT_SCHEDULE } = require('../../utils/weeklyRecap');

// ── Sections affichables ─────────────────────────────────────────────────────
const SECTION_LABELS = {
  messages:   '💬 Messages envoyés',
  xp:         '⭐ XP gagné',
  members:    '👥 Évolution des membres',
  bumps:      '🚀 Bumps réseau + top bumpers',
  topMembers: '🏆 Top activité (top 5)',
  moderation: '🛡️ Sanctions (avertissements)',
};

// ── Fréquences prêtes à l'emploi ─────────────────────────────────────────────
const SCHEDULE_PRESETS = {
  sun18:   { label: 'Chaque dimanche à 18h',  cron: '0 18 * * 0' },
  mon9:    { label: 'Chaque lundi à 9h',      cron: '0 9 * * 1' },
  fri18:   { label: 'Chaque vendredi à 18h',  cron: '0 18 * * 5' },
  daily18: { label: 'Tous les jours à 18h',   cron: '0 18 * * *' },
  monthly: { label: 'Le 1er du mois à 10h',   cron: '0 10 1 * *' },
  custom:  { label: 'Personnalisé (cron)…' },
};

function scheduleLabel(cron) {
  const preset = Object.values(SCHEDULE_PRESETS).find(p => p.cron === cron);
  return preset ? preset.label : `Personnalisé — \`${cron}\``;
}

async function getOrCreate(guildId) {
  let cfg = await WeeklyRecap.findOne({ guildId });
  if (!cfg) cfg = await WeeklyRecap.create({ guildId });
  return cfg;
}

// ════════════════════════════════════════════════════════════════════════════
//  EMBED & COMPOSANTS
// ════════════════════════════════════════════════════════════════════════════
function buildPanelEmbed(guild, cfg) {
  const sectionsText = Object.entries(SECTION_LABELS)
    .map(([key, label]) => `${cfg.sections[key] ? '🟢' : '⚫'} ${label}`)
    .join('\n');

  const lastSent = cfg.lastSentAt
    ? `<t:${Math.floor(new Date(cfg.lastSentAt).getTime() / 1000)}:R>`
    : '*Jamais encore*';

  const periodStart = cfg.snapshot?.takenAt
    ? `<t:${Math.floor(new Date(cfg.snapshot.takenAt).getTime() / 1000)}:R>`
    : '*dès l\'activation*';

  return new EmbedBuilder()
    .setColor(cfg.enabled ? COLORS.primary : COLORS.warning)
    .setTitle('📊 Récap hebdomadaire — Panel de configuration')
    .setThumbnail(guild.iconURL?.({ dynamic: true }) || null)
    .setDescription(
      cfg.channelId
        ? 'Réglez la publication automatique du résumé d\'activité ci-dessous.'
        : '⚠️ Aucun salon choisi. Sélectionnez un **salon de publication** pour pouvoir activer le récap.',
    )
    .addFields(
      { name: 'Statut',        value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Salon',         value: cfg.channelId ? `<#${cfg.channelId}>` : '*Non défini*', inline: true },
      { name: 'Rôle pingé',    value: cfg.pingRoleId ? `<@&${cfg.pingRoleId}>` : '*Aucun*', inline: true },
      { name: 'Fréquence',     value: scheduleLabel(cfg.schedule || DEFAULT_SCHEDULE), inline: true },
      { name: 'Dernier envoi', value: lastSent, inline: true },
      { name: 'Période en cours', value: periodStart, inline: true },
      { name: 'Sections affichées', value: sectionsText, inline: false },
    )
    .setFooter({ text: 'REZO • Récap hebdomadaire — fonctionnalité sous licence' })
    .setTimestamp();
}

function buildPanelComponents(cfg) {
  const rows = [];

  // 1. Salon de publication
  rows.push(new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('rcp_edit_channel')
      .setPlaceholder('📢 Salon de publication du récap...')
      .setChannelTypes(ChannelType.GuildText),
  ));

  // 2. Rôle à mentionner
  rows.push(new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('rcp_edit_role')
      .setPlaceholder('🔔 Rôle à mentionner (optionnel)...'),
  ));

  // 3. Fréquence
  const currentPreset = Object.entries(SCHEDULE_PRESETS)
    .find(([, p]) => p.cron === cfg.schedule)?.[0] || 'custom';
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('rcp_edit_schedule')
      .setPlaceholder('⏰ Fréquence de publication...')
      .addOptions(Object.entries(SCHEDULE_PRESETS).map(([value, p]) => ({
        label: p.label,
        value,
        default: value === currentPreset,
      }))),
  ));

  // 4. Sections (multi-sélection)
  rows.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('rcp_edit_sections')
      .setPlaceholder('🧩 Sections affichées dans le récap...')
      .setMinValues(0)
      .setMaxValues(Object.keys(SECTION_LABELS).length)
      .addOptions(Object.entries(SECTION_LABELS).map(([key, label]) => ({
        label,
        value: key,
        default: !!cfg.sections[key],
      }))),
  ));

  // 5. Actions
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rcp_toggle_enabled')
      .setLabel(cfg.enabled ? 'Désactiver' : 'Activer')
      .setEmoji(cfg.enabled ? '⏸️' : '▶️')
      .setStyle(cfg.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('rcp_preview').setLabel('Aperçu').setEmoji('👁️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('rcp_send_now').setLabel('Envoyer').setEmoji('📤').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('rcp_refresh').setLabel('Actualiser').setEmoji('🔃').setStyle(ButtonStyle.Secondary),
  ));

  return rows;
}

// Verrou de licence pour les actions sensibles (activation / envoi)
async function ensureLicensed(guildId, replyFn) {
  const { checkAccess, lockEmbed } = require('../../utils/licenseGate');
  const access = await checkAccess(guildId, 'recap');
  if (!access.ok) {
    await replyFn({ embeds: [lockEmbed('recap', { access })], ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  COMMANDE
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('recap')
    .setDescription('📊 Panel du récap hebdomadaire d\'activité (sous licence)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const guildId = interaction.guildId;
    let cfg = await getOrCreate(guildId);

    // Pose la référence dès l'ouverture pour que le premier récap couvre une
    // période pleine (sans écraser une référence déjà posée).
    if (!cfg.snapshot?.takenAt) {
      cfg.snapshot = await buildGuildSnapshot(interaction.guild).catch(() => cfg.snapshot);
      await cfg.save().catch(() => {});
    }

    const reply = await interaction.editReply({
      embeds:     [buildPanelEmbed(interaction.guild, cfg)],
      components: buildPanelComponents(cfg),
    });

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time:   15 * 60 * 1000,
    });

    col.on('collect', async (i) => {
      try {
        const id = i.customId;

        // ── Actualiser ────────────────────────────────────────────────────
        if (id === 'rcp_refresh') {
          cfg = await getOrCreate(guildId);
          return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
        }

        // ── Salon de publication ──────────────────────────────────────────
        if (id === 'rcp_edit_channel') {
          cfg.channelId = i.values[0];
          await cfg.save();
          return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
        }

        // ── Rôle mentionné (optionnel) ────────────────────────────────────
        if (id === 'rcp_edit_role') {
          cfg.pingRoleId = i.values[0] || null;
          await cfg.save();
          return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
        }

        // ── Fréquence ─────────────────────────────────────────────────────
        if (id === 'rcp_edit_schedule') {
          const value = i.values[0];

          if (value === 'custom') {
            const modal = new ModalBuilder().setCustomId('rcp_modal_cron').setTitle('⏰ Planification personnalisée');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('rcp_cron_value')
                .setLabel('Cron : minute heure jour mois jourSemaine')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('0 18 * * 0')
                .setValue(cfg.schedule || DEFAULT_SCHEDULE),
            ));
            await i.showModal(modal);

            const submitted = await i.awaitModalSubmit({
              filter: m => m.customId === 'rcp_modal_cron' && m.user.id === interaction.user.id,
              time: 180_000,
            }).catch(() => null);
            if (!submitted) return;

            const expr = submitted.fields.getTextInputValue('rcp_cron_value').trim();
            const cron = require('node-cron');
            if (!cron.validate(expr)) {
              return submitted.reply({ embeds: [errorEmbed('Expression invalide', `\`${expr}\` n'est pas une expression cron valide.`)] }).catch(() => {});
            }
            cfg.schedule = expr;
            await cfg.save();
            return submitted.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }

          const preset = SCHEDULE_PRESETS[value];
          if (preset?.cron) {
            cfg.schedule = preset.cron;
            await cfg.save();
            return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
          }
          return;
        }

        // ── Sections ──────────────────────────────────────────────────────
        if (id === 'rcp_edit_sections') {
          const selected = new Set(i.values);
          for (const key of Object.keys(SECTION_LABELS)) {
            cfg.sections[key] = selected.has(key);
          }
          await cfg.save();
          return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
        }

        // ── Activer / désactiver ──────────────────────────────────────────
        if (id === 'rcp_toggle_enabled') {
          if (!cfg.enabled) {
            // Activation : revérifie la licence + exige un salon
            if (!(await ensureLicensed(guildId, p => i.reply(p)))) return;
            if (!cfg.channelId) {
              return i.reply({ embeds: [errorEmbed('Salon manquant', 'Sélectionnez d\'abord un **salon de publication**.')], ephemeral: true }).catch(() => {});
            }
            cfg.enabled = true;
          } else {
            cfg.enabled = false;
          }
          await cfg.save();
          return i.update({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) });
        }

        // ── Aperçu (sans consommer la période) ────────────────────────────
        if (id === 'rcp_preview') {
          await i.deferReply({ ephemeral: true });
          const { embed } = await generateRecap(client, interaction.guild, cfg);
          return i.editReply({
            content: '👁️ **Aperçu** — la période et l\'instantané ne sont pas modifiés.',
            embeds: [embed],
          });
        }

        // ── Envoyer maintenant ────────────────────────────────────────────
        if (id === 'rcp_send_now') {
          if (!(await ensureLicensed(guildId, p => i.reply(p)))) return;
          await i.deferReply({ ephemeral: true });

          const channel = cfg.channelId
            ? await interaction.guild.channels.fetch(cfg.channelId).catch(() => null)
            : interaction.channel;

          if (!channel?.isTextBased()) {
            return i.editReply({ embeds: [errorEmbed('Aucun salon', 'Choisissez un salon de publication dans le panel.')] });
          }

          const { embed, content, snapshot } = await generateRecap(client, interaction.guild, cfg);
          await channel.send({ content, embeds: [embed] });

          cfg.snapshot   = snapshot;
          cfg.lastSentAt = new Date();
          await cfg.save();

          await i.editReply({ embeds: [successEmbed('Récap envoyé', `Publié dans <#${channel.id}>. La période repart de maintenant.`)] });
          return i.message?.edit({ embeds: [buildPanelEmbed(interaction.guild, cfg)], components: buildPanelComponents(cfg) }).catch(() => {});
        }
      } catch (err) {
        console.error('[RecapPanel]', err);
        const payload = { embeds: [errorEmbed('Erreur', 'Une erreur est survenue. Réessayez.')], ephemeral: true };
        if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
        else await i.reply(payload).catch(() => {});
      }
    });

    col.on('end', () => { interaction.editReply({ components: [] }).catch(() => {}); });
  },
};
