'use strict';
// commands/configuration/vanity.js — 💎 Vanity par statut : panneau de contrôle.
//
// Un membre affiche le texte du serveur dans son statut personnalisé Discord →
// le bot lui donne le rôle configuré et publie une annonce en embed dans le
// salon choisi. Tout se règle ici, sans quitter Discord :
//
//   • textes acceptés (jusqu'à 10 variantes, correspondance « contient » ou
//     « exacte », casse et accents gérés) ;
//   • rôle attribué, salon d'annonce, salon de logs ;
//   • embed d'annonce entièrement personnalisable (placeholders {user},
//     {mention}, {status}, {role}, {count}, {date}…) ;
//   • conditions : âge du compte, ancienneté, rôle requis, rôles exclus ;
//   • comportement : retrait automatique après grâce, annonce unique, MP,
//     ré-annonce, suppression de l'ancienne annonce ;
//   • « Tester mon statut » et « Vérifier maintenant » pour contrôler sans
//     attendre la passe de dix minutes.
//
// Les composants sont persistants (préfixe `vty_`) : ils sont routés par
// events/core/interactionCreate.js et ne dépendent donc d'aucun collecteur qui
// expirerait au bout de quinze minutes.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const VanityConfig = require('../../models/VanityConfig');
const VanityMember = require('../../models/VanityMember');
const { COLORS, successEmbed, errorEmbed, warningEmbed } = require('../../utils/embeds');
const brand = require('../../utils/brand');
const vanity = require('../../utils/vanityEngine');

const { truncate } = vanity;

// ════════════════════════════════════════════════════════════════════════════
//  RENDU DU PANNEAU
// ════════════════════════════════════════════════════════════════════════════

async function loadConfig(guildId) {
  const existing = await VanityConfig.findOne({ guildId });
  return existing || new VanityConfig({ guildId });
}

function diagnostics(guild, cfg) {
  const issues = [];
  const me = guild.members.me;

  if (!cfg.roleId) {
    issues.push('⚠️ Aucun rôle cible : le module ne peut rien attribuer.');
  } else {
    const role = guild.roles.cache.get(cfg.roleId);
    if (!role) issues.push('⚠️ Le rôle configuré n’existe plus.');
    else if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) issues.push('⚠️ Permission **Gérer les rôles** manquante.');
    else if (role.position >= me.roles.highest.position) issues.push('⚠️ Mon rôle est sous le rôle vanity : remonte-le.');
  }

  if (!vanity.statusVariants(cfg).length) issues.push('⚠️ Aucun texte de statut requis : rien ne peut correspondre.');
  if (!cfg.announceChannelId) issues.push('ℹ️ Aucun salon d’annonce : le rôle sera attribué sans embed.');
  else if (!guild.channels.cache.get(cfg.announceChannelId)) issues.push('⚠️ Le salon d’annonce n’existe plus.');
  if (!cfg.enabled) issues.push('ℹ️ Module désactivé : rien n’est vérifié en direct.');

  return issues;
}

function buildPanelEmbed(guild, cfg) {
  const texts = vanity.statusVariants(cfg);
  const cond = cfg.conditions || {};
  const beh = cfg.behavior || {};
  const stats = cfg.stats || {};
  const role = cfg.roleId ? guild.roles.cache.get(cfg.roleId) : null;
  const holders = role?.members?.size ?? 0;
  const grace = beh.graceMinutes > 0 ? `${beh.graceMinutes} min` : 'immédiat';

  const conditions = [
    `Âge du compte : **${cond.minAccountAgeDays > 0 ? `${cond.minAccountAgeDays} j` : 'aucun'}**`,
    `Ancienneté serveur : **${cond.minMemberDays > 0 ? `${cond.minMemberDays} j` : 'aucune'}**`,
    cond.requiredRoleId ? `Rôle requis : <@&${cond.requiredRoleId}>` : null,
    cond.forbiddenRoleIds?.length
      ? `Rôles exclus : ${cond.forbiddenRoleIds.map(id => `<@&${id}>`).join(', ')}`
      : null,
  ].filter(Boolean).join('\n');

  const embed = new EmbedBuilder()
    .setColor(cfg.enabled ? COLORS.success : COLORS.primary)
    .setTitle('💎 Vanity par statut — panneau de contrôle')
    .setDescription([
      cfg.enabled
        ? '🟢 **Module actif** — les statuts sont vérifiés en direct, puis toutes les 10 minutes.'
        : '🔴 **Module désactivé** — aucun rôle n’est attribué.',
      '',
      texts.length
        ? `Les membres doivent afficher **l’un de ces textes** dans leur statut personnalisé `
          + `(${cfg.matchMode === 'exact' ? 'texte exact' : 'le texte doit être contenu'}, `
          + `${cfg.caseSensitive ? 'casse exacte' : 'casse et accents ignorés'}).`
        : '⚠️ **Aucun texte requis** : le module ne peut rien détecter. Commence par « Textes requis ».',
    ].join('\n'))
    .addFields(
      { name: '🎭 Rôle vanity', value: cfg.roleId ? `<@&${cfg.roleId}>` : '*aucun*', inline: true },
      { name: '👥 Membres validés', value: `**${holders}**`, inline: true },
      { name: '⏱️ Retrait', value: beh.removeOnLost !== false ? `Auto après **${grace}**` : 'Désactivé', inline: true },
      {
        name: '💬 Textes acceptés',
        value: texts.length
          ? truncate(texts.map(text => `\`${text}\``).join('\n'), 1024)
          : '*aucun*',
        inline: false,
      },
      { name: '🛡️ Conditions', value: conditions || '*aucune*', inline: false },
      {
        name: '📢 Annonce',
        value: `${cfg.announceChannelId ? `<#${cfg.announceChannelId}>` : '*non configuré*'}\n`
          + `${beh.announceOnce !== false ? 'Une seule annonce par membre' : 'Ré-annonce possible'}`
          + `${beh.dmMember ? ' · MP activé' : ''}`,
        inline: true,
      },
      { name: '🗂️ Logs', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*non configuré*', inline: true },
      {
        name: '📊 Statistiques',
        value: `**${stats.totalGrants || 0}** attribution(s) · **${stats.totalRevokes || 0}** retrait(s)\n`
          + `**${stats.totalAnnounces || 0}** annonce(s)`
          + (stats.lastSweepAt
            ? ` · dernière passe <t:${Math.floor(new Date(stats.lastSweepAt).getTime() / 1000)}:R>`
            : ''),
        inline: false,
      },
    )
    .setFooter({ text: 'REZO • Vanity — statut vérifié à chaque changement puis toutes les 10 minutes' })
    .setTimestamp();

  if (guild.iconURL()) embed.setThumbnail(guild.iconURL({ size: 128 }));

  const issues = diagnostics(guild, cfg);
  if (issues.length) embed.addFields({ name: '🩺 Diagnostic', value: truncate(issues.join('\n'), 1024), inline: false });

  return brand.applyBrand(embed);
}

function buildPanelComponents(cfg) {
  const beh = cfg.behavior || {};
  const rows = [];

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vty_toggle')
      .setLabel(cfg.enabled ? 'Désactiver' : 'Activer')
      .setEmoji(cfg.enabled ? '⏸️' : '▶️')
      .setStyle(cfg.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('vty_modal_text').setLabel('Textes requis').setEmoji('📝').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vty_modal_embed').setLabel('Annonce').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vty_modal_conditions').setLabel('Conditions').setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vty_refresh').setLabel('Actualiser').setEmoji('🔃').setStyle(ButtonStyle.Primary),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vty_toggle_remove')
      .setLabel('Retrait auto')
      .setEmoji('↩️')
      .setStyle(beh.removeOnLost !== false ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('vty_toggle_once')
      .setLabel('Annonce unique')
      .setEmoji('🔔')
      .setStyle(beh.announceOnce !== false ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vty_modal_advanced').setLabel('Avancé').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vty_check_me').setLabel('Tester mon statut').setEmoji('🧪').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('vty_scan').setLabel('Vérifier').setEmoji('⚡').setStyle(ButtonStyle.Danger),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('vty_sel_role')
      .setPlaceholder('🎭 Rôle à attribuer aux statuts validés…')
      .setMinValues(0)
      .setMaxValues(1),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('vty_sel_announce')
      .setPlaceholder('📢 Salon des annonces vanity…')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(0)
      .setMaxValues(1),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('vty_sel_log')
      .setPlaceholder('🗂️ Salon des logs (attributions / retraits)…')
      .setChannelTypes(ChannelType.GuildText)
      .setMinValues(0)
      .setMaxValues(1),
  ));

  return rows;
}

function payload(guild, cfg) {
  return { embeds: [buildPanelEmbed(guild, cfg)], components: buildPanelComponents(cfg) };
}

// ════════════════════════════════════════════════════════════════════════════
//  SAISIES (modaux)
// ════════════════════════════════════════════════════════════════════════════

function readBool(value, fallback = false) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['oui', 'yes', 'true', '1', 'on', 'actif', 'active', 'activé'].includes(raw);
}

function readInt(value, { min = 0, max = 100_000, fallback = 0 } = {}) {
  const parsed = Number.parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function readIds(value) {
  const ids = String(value ?? '').match(/\d{15,25}/g) || [];
  return [...new Set(ids)].slice(0, 20);
}

function showTextModal(interaction, cfg) {
  const modal = new ModalBuilder().setCustomId('vty_modal_text').setTitle('📝 Textes de statut acceptés');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('vty_texts')
      .setLabel('Un texte par ligne (10 maximum)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000)
      .setPlaceholder('discord.gg/rezo\n.rezo')
      .setValue((cfg.requiredStatuses || []).join('\n').slice(0, 1000)),
  ));
  return interaction.showModal(modal);
}

function showEmbedModal(interaction, cfg) {
  const data = cfg.embed || {};
  const modal = new ModalBuilder().setCustomId('vty_modal_embed').setTitle('🎨 Annonce vanity (embed)');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_embed_title')
        .setLabel('Titre')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(256)
        .setValue(String(data.title || '').slice(0, 256)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_embed_desc')
        .setLabel('Description de l’annonce')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(4000)
        .setPlaceholder('{mention} a validé le statut {status} — {count} membres l’affichent.')
        .setValue(String(data.description || '').slice(0, 4000)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_embed_color')
        .setLabel('Couleur hexadécimale (#8B1A1A)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(7)
        .setValue(String(data.color || '#8B1A1A').slice(0, 7)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_embed_thumb')
        .setLabel('Miniature : user / guild / none / URL')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(300)
        .setValue(String(data.thumbnail || 'user').slice(0, 300)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_embed_author')
        .setLabel('Auteur de l’embed (vide = aucun)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(256)
        .setValue(String(data.author || '').slice(0, 256)),
    ),
  );
  return interaction.showModal(modal);
}

function showConditionsModal(interaction, cfg) {
  const cond = cfg.conditions || {};
  const modal = new ModalBuilder().setCustomId('vty_modal_conditions').setTitle('🛡️ Conditions d’éligibilité');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_cond_mode')
        .setLabel('Mode : contains (contient) ou exact')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(10)
        .setValue(cfg.matchMode === 'exact' ? 'exact' : 'contains'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_cond_case')
        .setLabel('Casse exacte ? (oui / non)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(5)
        .setValue(cfg.caseSensitive ? 'oui' : 'non'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_cond_account')
        .setLabel('Âge minimum du compte (jours, 0 = aucun)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(4)
        .setValue(String(cond.minAccountAgeDays || 0)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_cond_member')
        .setLabel('Ancienneté minimum sur le serveur (jours)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(4)
        .setValue(String(cond.minMemberDays || 0)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_cond_forbidden')
        .setLabel('Rôles exclus (IDs ou mentions)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(400)
        .setValue((cond.forbiddenRoleIds || []).map(id => `<@&${id}>`).join(' ').slice(0, 400)),
    ),
  );
  return interaction.showModal(modal);
}

function showAdvancedModal(interaction, cfg) {
  const cond = cfg.conditions || {};
  const beh = cfg.behavior || {};
  const modal = new ModalBuilder().setCustomId('vty_modal_advanced').setTitle('⚙️ Réglages avancés');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_adv_required_role')
        .setLabel('Rôle requis avant le vanity (ID)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(30)
        .setValue(String(cond.requiredRoleId || '').slice(0, 30)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_adv_grace')
        .setLabel('Délai de grâce avant retrait (minutes)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(5)
        .setValue(String(beh.graceMinutes ?? 60)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_adv_reannounce')
        .setLabel('Ré-annonce après N jours (0 = jamais)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(3)
        .setValue(String(beh.reannounceAfterDays || 0)),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_adv_delete_old')
        .setLabel('Supprimer l’ancienne annonce ? (oui / non)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(5)
        .setValue(beh.deletePreviousAnnounce ? 'oui' : 'non'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('vty_adv_dm')
        .setLabel('Annonce en MP au membre ? (oui/non)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(5)
        .setValue(beh.dmMember ? 'oui' : 'non'),
    ),
  );
  return interaction.showModal(modal);
}

// ════════════════════════════════════════════════════════════════════════════
//  ACTIONS
// ════════════════════════════════════════════════════════════════════════════

function isStaff(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

async function checkSelf(interaction, cfg) {
  const info = vanity.inspectMember(interaction.member, cfg);
  const lines = [
    `**Statut détecté :** ${info.statusText ? `\`${truncate(info.statusText, 120)}\`` : '*aucun statut personnalisé visible*'}`,
    `**Correspondance :** ${info.matched ? `✅ \`${info.matched}\`` : '❌ aucun texte configuré ne correspond'}`,
    `**Conditions :** ${info.eligibility.ok ? '✅ remplies' : `⚠️ ${info.eligibility.reason}`}`,
    `**Rôle :** ${info.role.ok ? '✅ attribuable' : `⚠️ ${info.role.reason}`}`,
    `**État actuel :** ${info.hasRole ? '🎭 tu portes déjà le rôle vanity' : '— rôle non porté'}`,
  ];
  const ok = info.matched && info.eligibility.ok && info.role.ok;

  // Tout est bon et le rôle manque : on l'attribue MAINTENANT. Le membre ne
  // doit pas attendre la passe périodique pour voir le résultat de sa commande.
  if (ok && !info.hasRole) {
    const outcome = await vanity
      .grant(interaction.member, cfg, info.statusText, { source: 'self' })
      .catch(() => null);
    if (outcome?.granted) {
      return interaction.reply({
        embeds: [successEmbed('Rôle attribué', `${lines.join('\n')}\n\n✅ Ton rôle vanity vient d’être attribué.`)],
        ephemeral: true,
      });
    }
    if (outcome && outcome.ok === false) {
      lines.push(`**Attribution :** ⚠️ ${outcome.reason || outcome.code}`);
    }
  }

  const embed = ok
    ? successEmbed('Statut conforme', `${lines.join('\n')}\n\n${info.hasRole
      ? '✅ Tu portes déjà le rôle vanity.'
      : 'Ton rôle sera attribué automatiquement dès que ton statut sera vu.'}`)
    : warningEmbed('Statut non validé', lines.join('\n'));
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function scanNow(interaction) {
  const guild = interaction.guild;
  await interaction.deferReply({ ephemeral: true });
  const cfg = await loadConfig(guild.id);
  if (!cfg.enabled) {
    return interaction.editReply({ embeds: [errorEmbed('Module désactivé', 'Active le module avant de lancer une vérification.')] });
  }
  const result = await vanity.sweepGuild(guild, cfg).catch(err => {
    console.error('[vanity] vérification manuelle :', err);
    return null;
  });
  if (!result) return interaction.editReply({ embeds: [errorEmbed('Vérification impossible', 'Une erreur est survenue pendant la passe. Réessaie dans un instant.')] });

  return interaction.editReply({
    embeds: [successEmbed('Vérification terminée', [
      `**${result.checked}** présence(s) contrôlée(s)`,
      `**${result.granted}** rôle(s) attribué(s)`,
      `**${result.revoked}** rôle(s) retiré(s)`,
      result.skipped ? `**${result.skipped}** membre(s) en attente de conditions` : null,
    ].filter(Boolean).join('\n'))],
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  COMMANDE
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
  data: new SlashCommandBuilder()
    .setName('vanity')
    .setDescription('💎 Vanity par statut : rôle automatique + annonce en embed')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(s => s
      .setName('panel')
      .setDescription('🎛️ Ouvrir le panneau de contrôle du vanity'))
    .addSubcommand(s => s
      .setName('verifier')
      .setDescription('⚡ Vérifier maintenant les statuts de tous les membres'))
    .addSubcommand(s => s
      .setName('membres')
      .setDescription('👥 Voir les derniers membres validés')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand(false) || 'panel';
    const guild = interaction.guild;

    // ── /vanity membres ────────────────────────────────────────────────────
    if (sub === 'membres') {
      await interaction.deferReply({ ephemeral: true });
      const cfg = await loadConfig(guild.id);
      const records = await VanityMember.find({ guildId: guild.id, active: true })
        .sort({ grantedAt: -1 })
        .limit(20)
        .lean();

      if (!records.length) {
        return interaction.editReply({
          embeds: [warningEmbed('Aucun membre validé', 'Personne ne porte encore le rôle vanity. Configure le module puis lance **Vérifier**.')],
        });
      }

      const lines = records.map((record, index) => {
        const since = record.grantedAt
          ? `<t:${Math.floor(new Date(record.grantedAt).getTime() / 1000)}:R>`
          : '*date inconnue*';
        return `**${index + 1}.** <@${record.userId}> — ${since} · \`${truncate(record.matched || record.statusText || '—', 40)}\``;
      });

      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('💎 Membres validés')
        .setDescription(lines.join('\n'))
        .addFields({
          name: 'Total',
          value: `**${await VanityMember.countDocuments({ guildId: guild.id, active: true })}** membre(s) portent le rôle`
            + (cfg.roleId ? ` <@&${cfg.roleId}>` : ''),
        })
        .setFooter({ text: 'REZO • Vanity — 20 plus récents' })
        .setTimestamp();
      return interaction.editReply({ embeds: [brand.applyBrand(embed)] });
    }

    // ── /vanity verifier ───────────────────────────────────────────────────
    if (sub === 'verifier') return scanNow(interaction);

    // ── /vanity panel (défaut) ─────────────────────────────────────────────
    const cfg = await loadConfig(guild.id);
    return interaction.reply({ ...payload(guild, cfg), ephemeral: true });
  },

  // ── Boutons persistants ─────────────────────────────────────────────────
  async handleButton(interaction) {
    if (!isStaff(interaction)) {
      return interaction.reply({ embeds: [errorEmbed('Accès refusé', 'Il faut la permission **Gérer le serveur**.')], ephemeral: true });
    }

    const id = interaction.customId;
    const guild = interaction.guild;
    const cfg = await loadConfig(guild.id);

    if (id === 'vty_modal_text') return showTextModal(interaction, cfg);
    if (id === 'vty_modal_embed') return showEmbedModal(interaction, cfg);
    if (id === 'vty_modal_conditions') return showConditionsModal(interaction, cfg);
    if (id === 'vty_modal_advanced') return showAdvancedModal(interaction, cfg);
    if (id === 'vty_check_me') return checkSelf(interaction, cfg);
    if (id === 'vty_scan') return scanNow(interaction);

    if (id === 'vty_toggle') {
      cfg.enabled = !cfg.enabled;
      if (cfg.enabled && !vanity.statusVariants(cfg).length) {
        cfg.enabled = false;
        return interaction.reply({
          embeds: [errorEmbed('Textes requis manquants', 'Renseigne d’abord les textes de statut acceptés (**📝 Textes requis**).')],
          ephemeral: true,
        });
      }
      if (cfg.enabled && !cfg.roleId) {
        cfg.enabled = false;
        return interaction.reply({
          embeds: [errorEmbed('Rôle manquant', 'Choisis d’abord le rôle à attribuer (menu **🎭 Rôle**).')],
          ephemeral: true,
        });
      }
    } else if (id === 'vty_toggle_remove') {
      cfg.behavior.removeOnLost = !cfg.behavior.removeOnLost;
    } else if (id === 'vty_toggle_once') {
      cfg.behavior.announceOnce = !cfg.behavior.announceOnce;
    } else if (id !== 'vty_refresh') {
      return;
    }

    if (id !== 'vty_refresh') await cfg.save();
    return interaction.update(payload(guild, cfg));
  },

  // ── Menus de sélection ──────────────────────────────────────────────────
  async handleSelect(interaction) {
    if (!isStaff(interaction)) {
      return interaction.reply({ embeds: [errorEmbed('Accès refusé', 'Il faut la permission **Gérer le serveur**.')], ephemeral: true });
    }

    const guild = interaction.guild;
    const cfg = await loadConfig(guild.id);
    const value = interaction.values?.[0] || null;

    if (interaction.customId === 'vty_sel_role') {
      if (value) {
        const role = guild.roles.cache.get(value);
        const me = guild.members.me;
        if (!role || role.id === guild.id) {
          return interaction.reply({ embeds: [errorEmbed('Rôle invalide', 'Le rôle **@everyone** ne peut pas être attribué.')], ephemeral: true });
        }
        if (role.managed) {
          return interaction.reply({
            embeds: [errorEmbed('Rôle géré', `${role} est géré par une intégration : Discord interdit de l’attribuer à la main.`)],
            ephemeral: true,
          });
        }
        if (role.position >= me.roles.highest.position) {
          return interaction.reply({
            embeds: [errorEmbed('Rôle trop haut', `Mon rôle le plus haut (${me.roles.highest.name}) doit être **au-dessus** de ${role} — remonte mon rôle dans **Serveur → Rôles**.`)],
            ephemeral: true,
          });
        }
      }
      cfg.roleId = value;
    } else if (interaction.customId === 'vty_sel_announce') {
      cfg.announceChannelId = value;
    } else if (interaction.customId === 'vty_sel_log') {
      cfg.logChannelId = value;
    } else {
      return;
    }

    await cfg.save();
    return interaction.update(payload(guild, cfg));
  },

  // ── Modaux ──────────────────────────────────────────────────────────────
  async handleModal(interaction) {
    if (!isStaff(interaction)) {
      return interaction.reply({ embeds: [errorEmbed('Accès refusé', 'Il faut la permission **Gérer le serveur**.')], ephemeral: true });
    }

    const guild = interaction.guild;
    const cfg = await loadConfig(guild.id);
    const id = interaction.customId;

    if (id === 'vty_modal_text') {
      const list = vanity.splitStatuses(interaction.fields.getTextInputValue('vty_texts'));
      if (!list.length) {
        return interaction.reply({ embeds: [errorEmbed('Texte vide', 'Donne au moins un texte de statut (un par ligne).')], ephemeral: true });
      }
      cfg.requiredStatuses = list;
    }

    if (id === 'vty_modal_embed') {
      const title = interaction.fields.getTextInputValue('vty_embed_title').trim();
      const description = interaction.fields.getTextInputValue('vty_embed_desc').trim();
      const color = interaction.fields.getTextInputValue('vty_embed_color').trim();
      const thumb = interaction.fields.getTextInputValue('vty_embed_thumb').trim();
      const author = interaction.fields.getTextInputValue('vty_embed_author').trim();

      cfg.embed.title = title || null;
      cfg.embed.description = description || null;
      if (/^#?[0-9a-f]{6}$/i.test(color)) cfg.embed.color = color.startsWith('#') ? color : `#${color}`;
      cfg.embed.thumbnail = thumb || 'none';
      cfg.embed.author = author || null;
    }

    if (id === 'vty_modal_conditions') {
      const mode = interaction.fields.getTextInputValue('vty_cond_mode').trim().toLowerCase();
      cfg.matchMode = mode === 'exact' ? 'exact' : 'contains';
      cfg.caseSensitive = readBool(interaction.fields.getTextInputValue('vty_cond_case'), cfg.caseSensitive);
      cfg.conditions.minAccountAgeDays = readInt(interaction.fields.getTextInputValue('vty_cond_account'), { max: 3650 });
      cfg.conditions.minMemberDays = readInt(interaction.fields.getTextInputValue('vty_cond_member'), { max: 3650 });
      cfg.conditions.forbiddenRoleIds = readIds(interaction.fields.getTextInputValue('vty_cond_forbidden'));
    }

    if (id === 'vty_modal_advanced') {
      const requiredRole = readIds(interaction.fields.getTextInputValue('vty_adv_required_role'))[0] || null;
      cfg.conditions.requiredRoleId = requiredRole;
      cfg.behavior.graceMinutes = readInt(interaction.fields.getTextInputValue('vty_adv_grace'), { max: 10_080, fallback: 60 });
      cfg.behavior.reannounceAfterDays = readInt(interaction.fields.getTextInputValue('vty_adv_reannounce'), { max: 365 });
      cfg.behavior.deletePreviousAnnounce = readBool(interaction.fields.getTextInputValue('vty_adv_delete_old'), cfg.behavior.deletePreviousAnnounce);
      cfg.behavior.dmMember = readBool(interaction.fields.getTextInputValue('vty_adv_dm'), cfg.behavior.dmMember);
    }

    await cfg.save();
    return interaction.update(payload(guild, cfg));
  },
};
