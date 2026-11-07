'use strict';
// commands/configuration/support-vocal.js — 🎧 Support vocal (tickets vocaux).
//
// Deux sous-commandes seulement, comme demandé :
//   • `/support-vocal setup` — configure le système et publie le panneau public ;
//   • `/support-vocal info`  — affiche la configuration actuelle du serveur.
//
// Le panneau de configuration est un vrai panel vivant : chaque menu/ bouton
// enregistre immédiatement son choix (aucun formulaire à re-remplir), et les
// valeurs actuelles sont toujours visibles dans l'embed.
//
// Un seul emplacement de commande est consommé (limite Discord de 100), les deux
// fonctions vivant en sous-commandes. La logique métier est dans
// utils/supportVocal.js.

const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const engine = require('../../utils/supportVocal');
const { COLORS } = require('../../utils/embeds');

const PANEL_TIMEOUT_MS = 10 * 60_000;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function canManage(member, memberPermissions) {
  const perms = memberPermissions || member?.permissions;
  return Boolean(perms?.has?.(PermissionFlagsBits.ManageGuild));
}

// ─── Vue du panneau de configuration ─────────────────────────────────────────
function buildSetupEmbed(guild, cfg, note = null) {
  const s = engine.settings(cfg);
  const problems = engine.healthChecks(guild, cfg);

  const embed = new EmbedBuilder()
    .setColor(problems.length ? COLORS.warning : COLORS.success)
    .setTitle('🎧 Support vocal — configuration')
    .setDescription(
      'Un membre clique sur le **panneau public** → le bot lui crée un salon **vocal privé** '
      + 'et publie une demande dans le salon des demandes. Ton équipe rejoint, prend en charge, puis ferme.\n\n'
      + 'Chaque réglage ci-dessous est enregistré **immédiatement**.',
    )
    .addFields(
      { name: '⚙️ Statut', value: s.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '📢 Salon du panneau', value: cfg.panelChannelId ? `<#${cfg.panelChannelId}>` : '*Non défini*', inline: true },
      { name: '📥 Salon des demandes', value: cfg.requestChannelId ? `<#${cfg.requestChannelId}>` : '*Non défini*', inline: true },
      { name: '🗂️ Catégorie des vocaux', value: cfg.categoryId ? `<#${cfg.categoryId}>` : '*Racine du serveur*', inline: true },
      { name: '🛡️ Rôle support', value: cfg.supportRoleId ? `<@&${cfg.supportRoleId}>` : '*Aucun*', inline: true },
      { name: '🏷️ Nom du salon', value: `\`${s.nameTemplate}\``, inline: true },
      { name: '👥 Limite / membre', value: `**${s.maxOpenPerUser}**`, inline: true },
      { name: '⏱️ Cooldown', value: s.cooldownSeconds ? `**${s.cooldownSeconds}s**` : '*Aucun*', inline: true },
      { name: '📋 Logs', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*Aucun (modlog)*', inline: true },
      { name: '🔊 Fermeture auto', value: s.autoCloseEmpty ? '🟢 salon vide' : '🔴 manuelle', inline: true },
      { name: '📣 Mention staff', value: s.mentionStaff ? '🟢 oui' : '🔴 non', inline: true },
      { name: '🧾 Demandes ouvertes', value: `**${cfg.totalRequests || 0}** au total`, inline: true },
    )
    .setFooter({ text: 'REZO • Support vocal · Session 10 min' })
    .setTimestamp();

  if (note) embed.addFields({ name: 'ℹ️ Dernière action', value: String(note).slice(0, 1024), inline: false });
  if (problems.length) {
    embed.addFields({ name: '⚠️ À corriger', value: problems.map(p => `• ${p}`).join('\n').slice(0, 1024), inline: false });
  }
  return embed;
}

function buildSetupComponents(page = 'main') {
  if (page === 'more') {
    return [
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('svs_logs')
          .setPlaceholder('📋 Salon de logs (optionnel)')
          .setChannelTypes(TEXT_CHANNELS)
          .setMinValues(0)
          .setMaxValues(1),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('svs_limits').setLabel('⚙️ Réglages avancés').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('svs_mention').setLabel('📣 Mention staff').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('svs_autoclose').setLabel('🔊 Fermeture auto').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('svs_back').setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
      ),
    ];
  }

  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('svs_panel')
        .setPlaceholder('📢 Salon du panneau public')
        .setChannelTypes(TEXT_CHANNELS)
        .setMinValues(0)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('svs_requests')
        .setPlaceholder('📥 Salon des demandes (staff)')
        .setChannelTypes(TEXT_CHANNELS)
        .setMinValues(0)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('svs_category')
        .setPlaceholder('🗂️ Catégorie des salons vocaux privés')
        .setChannelTypes([ChannelType.GuildCategory])
        .setMinValues(0)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('svs_role')
        .setPlaceholder('🛡️ Rôle support')
        .setMinValues(0)
        .setMaxValues(1),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('svs_toggle').setLabel('⚙️ Activer / Désactiver').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('svs_publish').setLabel('📢 Publier le panneau').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('svs_more').setLabel('➕ Plus de réglages').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('svs_close').setLabel('✖️ Fermer').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildSetupView(guild, cfg, page = 'main', note = null) {
  return { embeds: [buildSetupEmbed(guild, cfg, note)], components: buildSetupComponents(page) };
}

function limitsModal(cfg) {
  const s = engine.settings(cfg);
  const modal = new ModalBuilder().setCustomId('svs_modal_limits').setTitle('⚙️ Réglages avancés');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('nom').setLabel('Nom du salon ({user} {tag} {server})')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue(s.nameTemplate).setMaxLength(100),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('limite').setLabel('Demandes simultanées par membre (1-10)')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue(String(s.maxOpenPerUser)).setMaxLength(2),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('cooldown').setLabel('Cooldown entre deux demandes (secondes)')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue(String(s.cooldownSeconds)).setMaxLength(6),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('accueil').setLabel('Message d\'accueil du salon vocal (optionnel)')
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setValue(String(cfg.welcomeMessage || '')).setMaxLength(1000),
    ),
  );
  return modal;
}

function boundedInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ─── /support-vocal info ─────────────────────────────────────────────────────
async function showInfo(interaction) {
  const cfg = await engine.getConfig(interaction.guild.id);
  const open = await engine.getOpenTickets(interaction.guild.id);
  const embed = engine.buildInfoEmbed(cfg, {
    guild: interaction.guild,
    openCount: open.length,
    openTickets: open,
    totalRequests: cfg.totalRequests,
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sv_info_setup').setLabel('⚙️ Configurer').setStyle(ButtonStyle.Primary),
  );
  return interaction.reply({ embeds: [embed], components: [row] });
}

// ─── /support-vocal setup (+ bouton « Configurer » de info) ─────────────────
async function openSetup(interaction) {
  if (!canManage(interaction.member, interaction.memberPermissions)) {
    const payload = { content: '❌ Réservé aux membres avec la permission **Gérer le serveur**.', ephemeral: true };
    return (interaction.replied || interaction.deferred
      ? interaction.followUp(payload)
      : interaction.reply(payload)).catch(() => {});
  }

  const guild = interaction.guild;
  const cfg = await engine.getConfig(guild.id);
  let page = 'main';
  let note = null;

  const message = await interaction.reply({
    ...buildSetupView(guild, cfg, page, note),
    ephemeral: true,
    fetchReply: true,
  });
  if (!message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({ idle: PANEL_TIMEOUT_MS });

  collector.on('collect', async i => {
    if (i.user.id !== interaction.user.id) {
      return i.reply({ content: 'Ce panneau ne t\'appartient pas.', ephemeral: true }).catch(() => {});
    }

    try {
      // ── Menus de salons ───────────────────────────────────────────────────
      if (i.isChannelSelectMenu()) {
        const target = {
          svs_panel: 'panelChannelId',
          svs_requests: 'requestChannelId',
          svs_category: 'categoryId',
          svs_logs: 'logChannelId',
        }[i.customId];
        if (!target) return;
        cfg[target] = i.values?.[0] || null;
        cfg.updatedAt = new Date();
        await cfg.save();
        note = target === 'panelChannelId' && cfg.panelChannelId
          ? `Salon du panneau défini. Clique sur **📢 Publier le panneau** pour y poster le bouton.`
          : 'Réglage enregistré.';
        return i.update(buildSetupView(guild, cfg, page, note));
      }

      // ── Menu de rôle ──────────────────────────────────────────────────────
      if (i.isRoleSelectMenu() && i.customId === 'svs_role') {
        cfg.supportRoleId = i.values?.[0] || null;
        cfg.updatedAt = new Date();
        await cfg.save();
        note = cfg.supportRoleId ? `Rôle support : <@&${cfg.supportRoleId}>.` : 'Rôle support retiré (tout le staff pourra prendre en charge).';
        return i.update(buildSetupView(guild, cfg, page, note));
      }

      if (!i.isButton()) return;

      switch (i.customId) {
        case 'svs_toggle':
          cfg.enabled = !cfg.enabled;
          await cfg.save();
          note = cfg.enabled ? '🟢 Support vocal activé.' : '🔴 Support vocal désactivé.';
          return i.update(buildSetupView(guild, cfg, page, note));

        case 'svs_mention':
          cfg.mentionStaff = !cfg.mentionStaff;
          await cfg.save();
          note = cfg.mentionStaff ? 'Le rôle support sera mentionné à chaque demande.' : 'Plus de mention du rôle support.';
          return i.update(buildSetupView(guild, cfg, page, note));

        case 'svs_autoclose':
          cfg.autoCloseEmpty = !cfg.autoCloseEmpty;
          await cfg.save();
          note = cfg.autoCloseEmpty ? 'La demande se fermera quand le salon vocal sera vide.' : 'Fermeture manuelle uniquement.';
          return i.update(buildSetupView(guild, cfg, page, note));

        case 'svs_more':
          page = 'more';
          return i.update(buildSetupView(guild, cfg, page, note));

        case 'svs_back':
          page = 'main';
          return i.update(buildSetupView(guild, cfg, page, note));

        case 'svs_publish': {
          if (!cfg.panelChannelId) {
            note = '❌ Choisis d\'abord le **salon du panneau public**.';
            return i.update(buildSetupView(guild, cfg, page, note));
          }
          const result = await engine.publishPanel(guild, cfg);
          note = result.ok
            ? `📢 Panneau ${result.created ? 'publié' : 'actualisé'} dans <#${cfg.panelChannelId}>.`
            : `❌ ${result.reason}`;
          return i.update(buildSetupView(guild, cfg, page, note));
        }

        case 'svs_limits': {
          await i.showModal(limitsModal(cfg));
          const submitted = await i.awaitModalSubmit({
            time: 120_000,
            filter: m => m.customId === 'svs_modal_limits' && m.user.id === interaction.user.id,
          }).catch(() => null);
          if (!submitted) return;

          cfg.nameTemplate = String(submitted.fields.getTextInputValue('nom') || cfg.nameTemplate).slice(0, 100) || engine.DEFAULTS.nameTemplate;
          cfg.maxOpenPerUser = boundedInt(submitted.fields.getTextInputValue('limite'), engine.DEFAULTS.maxOpenPerUser, 1, 10);
          cfg.cooldownSeconds = boundedInt(submitted.fields.getTextInputValue('cooldown'), engine.DEFAULTS.cooldownSeconds, 0, 86_400);
          cfg.welcomeMessage = String(submitted.fields.getTextInputValue('accueil') || '').slice(0, 1000);
          await cfg.save();
          note = '✅ Réglages avancés enregistrés.';
          return submitted.update(buildSetupView(guild, cfg, page, note));
        }

        case 'svs_close':
          collector.stop();
          return i.update({ embeds: [buildSetupEmbed(guild, cfg)], components: [] });

        default:
          return;
      }
    } catch (err) {
      console.error('[support-vocal] panneau:', err.message);
      if (!i.replied && !i.deferred) {
        await i.reply({ content: '❌ Erreur pendant l\'enregistrement, réessaie.', ephemeral: true }).catch(() => {});
      }
    }
  });

  collector.on('end', async () => {
    await message.edit({ components: [] }).catch(() => {});
  });
}

// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('support-vocal')
    .setDescription('🎧 Support vocal — tickets vocaux pour serveurs communautaires')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('setup')
      .setDescription('Configurer le support vocal (salons, rôle staff, limites, panneau)'))
    .addSubcommand(sub => sub
      .setName('info')
      .setDescription('Afficher la configuration actuelle du support vocal')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'info') return showInfo(interaction);
    return openSetup(interaction);
  },

  // Boutons publics du panneau (sv_open) et des cartes de demande (sv_join_*,
  // sv_claim_*, sv_close_*), plus « Configurer » depuis /support-vocal info.
  handleButton(interaction, client) {
    if (interaction.customId === 'sv_info_setup') return openSetup(interaction);
    return engine.handleTicketButton(interaction, client);
  },

  __testables: { buildSetupEmbed, buildSetupComponents, buildSetupView, limitsModal, showInfo, openSetup },
};
