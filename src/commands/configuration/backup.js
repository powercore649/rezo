'use strict';
// commands/configuration/backup.js — Sauvegarde et restauration complète du serveur.
//
// /backup creer      → instantané complet (rôles, salons, catégories, permissions,
//                      ordre, emojis, bannissements, réglages) et renvoie un ID.
// /backup liste      → les sauvegardes de CE serveur (jamais celles d'un autre).
// /backup info <id>  → contenu réel + ce qui ne pourra pas être restauré à l'identique.
// /backup charger    → restauration, avec DEUX confirmations explicites.
// /backup supprimer  → suppression d'une sauvegarde (avec confirmation).
//
// Le travail lourd est dans utils/serverBackup.js (pur) et utils/backupManager.js
// (I/O Discord). Ici : garde-fous, rendu et routage des boutons bk_.

const {
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

const backupManager = require('../../utils/backupManager');
const sb = require('../../utils/serverBackup');
const licenseGate = require('../../utils/licenseGate');
const { COLORS } = require('../../utils/embeds');
const { applyBrand, BRAND } = require('../../utils/brand');

const LIMIT = 10;

const REFUSED = '❌ Cette sauvegarde appartient à un autre serveur et n\'est pas partagée.\n'
  + 'Son créateur peut l\'ouvrir avec `/backup partager` sur le serveur d\'origine.';

// ── Autorisation d'utiliser une sauvegarde ────────────────────────────────
// Une sauvegarde peut être chargée sur N'IMPORTE QUEL serveur, mais seulement :
//   • depuis son serveur d'origine ;
//   • par la personne qui l'a créée (migration vers un nouveau serveur) ;
//   • par un owner du bot ;
//   • ou si elle a été explicitement partagée avec `/backup partager`.
// Le simple fait de connaître l'identifiant ne suffit donc jamais.
function canUseBackup(backup, userId, guildId) {
  if (!backup) return false;
  if (String(backup.guildId) === String(guildId)) return true;
  if (backup.shared === true) return true;
  if (String(backup.createdBy) === String(userId)) return true;
  return licenseGate.isOwner(userId);
}

function isForeign(backup, guildId) {
  return Boolean(backup) && String(backup.guildId) !== String(guildId);
}

function originLabel(backup) {
  return String(backup?.guildName || backup?.guild?.name || backup?.guildId || 'serveur inconnu').slice(0, 80);
}

// ── Rendus ──────────────────────────────────────────────────────────────────
function baseEmbed(color = COLORS.primary) {
  return applyBrand(new EmbedBuilder().setColor(color).setTimestamp());
}

function timestamp(date) {
  const ms = new Date(date).getTime();
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : '—';
}

function contentLine(backup) {
  const counts = backup.counts || {};
  return [
    `👥 **${counts.roles ?? (backup.roles || []).length}** rôle(s)`,
    `📁 **${counts.categories ?? 0}** catégorie(s)`,
    `💬 **${counts.channels ?? 0}** salon(s)`,
    `🔒 **${counts.locked ?? 0}** verrouillé(s)`,
    `😀 **${counts.emojis ?? (backup.emojis || []).length}** emoji(s)`,
  ].join(' · ');
}

function createdEmbed(result) {
  const { backup, counts, warnings } = result;
  const embed = baseEmbed(COLORS.success)
    .setTitle('💾 Sauvegarde créée')
    .setDescription(
      `**${backup.name}** est enregistrée.\n`
      + `Identifiant : \`${backup.backupId}\`\n\n`
      + 'Conservez cet identifiant : il permet de restaurer le serveur plus tard, '
      + 'même après une suppression accidentelle de salons ou de rôles.\n\n'
      + 'Pour la charger sur un **autre** serveur (migration, modèle), utilisez '
      + '`/backup charger` depuis ce serveur — ou ouvrez-la à tous avec `/backup partager`.',
    )
    .addFields(
      { name: '📦 Contenu', value: contentLine(backup), inline: false },
      { name: '🛡️ Structure', value: `${counts.roles} rôle(s) · ${counts.categories} catégorie(s) · ${counts.channels} salon(s)${counts.locked ? ` · 🔒 ${counts.locked} verrouillé(s)` : ''}`, inline: true },
      { name: '👤 Créée par', value: `<@${backup.createdBy}>`, inline: true },
    );
  if (warnings?.length) {
    embed.addFields({ name: '⚠️ Points d\'attention', value: warnings.slice(0, 5).map(w => `• ${w}`).join('\n').slice(0, 1024) });
  }
  return embed;
}

function listEmbed(backups, total) {
  const embed = baseEmbed()
    .setTitle('💾 Sauvegardes du serveur')
    .setDescription(
      backups.length
        ? backups.map((backup, index) => {
          const counts = backup.counts || {};
          return `**${index + 1}.** \`${backup.backupId}\` — **${backup.name}**${backup.shared ? ' 📤 *(partagée)*' : ''}\n`
            + `   ↳ ${counts.roles ?? 0} rôle(s) · ${counts.channels ?? 0} salon(s) · ${timestamp(backup.createdAt)} · <@${backup.createdBy}>`;
        }).join('\n\n')
        : 'Aucune sauvegarde pour le moment. Lancez `/backup creer`.\n\n'
          + '💡 Une sauvegarde créée sur un **autre** serveur ? Utilisez `/backup charger` avec son identifiant.',
    );
  if (total > backups.length) {
    embed.setFooter({ text: `${BRAND.name} • ${backups.length} affichée(s) sur ${total}` });
  }
  return embed;
}

function infoEmbed(backup, inspection, guildId) {
  const { stats, warnings } = inspection;
  const settings = backup.guild || {};
  const embed = baseEmbed()
    .setTitle(`💾 ${backup.name}`)
    .setDescription(
      `Identifiant : \`${backup.backupId}\`\nCréée ${timestamp(backup.createdAt)} par <@${backup.createdBy}>`
      + (isForeign(backup, guildId) ? `\n📤 Provient du serveur **${originLabel(backup)}**${backup.shared ? ' · *partagée*' : ''}` : ''),
    )
    .addFields(
      { name: '📦 Contenu', value: contentLine(backup), inline: false },
      {
        name: '📁 Structure',
        value: `**${stats.roles}** rôle(s) recréables${stats.managed ? ` (+${stats.managed} géré(s))` : ''}\n`
          + `**${stats.categories}** catégorie(s) · **${stats.channels}** salon(s) · **${stats.locked}** verrouillé(s)\n`
          + `**${stats.emojis}** emoji(s) · **${stats.bans}** bannissement(s)`,
        inline: true,
      },
      {
        name: '🔒 Verrous',
        value: stats.locked
          ? `**${stats.locked}** salon(s) seront recréés **verrouillés** (@everyone ne peut plus y écrire).`
          : 'Aucun salon verrouillé : tous seront ouverts comme à l\'origine.',
        inline: true,
      },
      {
        name: '⚙️ Réglages',
        value: `Niveau de vérification : **${settings.verificationLevel ?? 0}**\n`
          + `Filtre média : **${settings.explicitContentFilter ?? 0}**\n`
          + `Locale : **${settings.preferredLocale || 'inconnue'}**`,
        inline: true,
      },
    );

  const roles = (backup.roles || []).filter(r => !r.managed).slice(0, 20).map(r => `@${r.name}`);
  if (roles.length) {
    embed.addFields({
      name: `🎭 Rôles (${stats.roles})`,
      value: roles.join(', ').slice(0, 1024) + (stats.roles > roles.length ? ` … +${stats.roles - roles.length}` : ''),
    });
  }

  if (warnings.length) {
    embed.addFields({
      name: '⚠️ Points d\'attention',
      value: warnings.slice(0, 6).map(w => `• ${w}`).join('\n').slice(0, 1024),
    });
  } else {
    embed.addFields({ name: '✅ Restauration fidèle', value: 'Aucun élément de la sauvegarde ne pose problème : tout peut être recréé à l\'identique.' });
  }

  return embed;
}

function confirmLoadEmbed(backup, inspection, clearExisting = true, guildId = null, preflight = null) {
  const guild = backup.guild || {};
  const { stats, warnings } = inspection;
  const foreign = isForeign(backup, guildId);
  const intro = clearExisting
    ? `La sauvegarde **${backup.name}** (\`${backup.backupId}\`) va **remplacer** la structure actuelle :\n`
      + 'les salons et les rôles listés ci-dessous seront **supprimés**, puis recréés à l\'identique '
      + '(noms, catégories, ordre, permissions, slowmode, bitrate, emojis).\n\n'
      + (foreign
        ? `\n📤 Cette sauvegarde vient du serveur **${originLabel(backup)}** : le nom de CE serveur ne sera pas modifié.\n\n`
        : '')
      + 'Les rôles **ne sont pas réattribués** aux membres : ils devront être rendus manuellement.\n\n'
      + '**Cette action est irréversible.** Les messages des salons supprimés ne reviendront pas.'
    : `La sauvegarde **${backup.name}** (\`${backup.backupId}\`) va être **ajoutée** à la structure actuelle.\n`
      + 'Rien ne sera supprimé, mais des doublons de noms peuvent apparaître '
      + '(les salons existants ne sont pas modifiés).';
  return baseEmbed(clearExisting ? COLORS.error : COLORS.warning)
    .setTitle(clearExisting ? '⚠️ Restauration complète du serveur' : '⚠️ Ajout de la structure sauvegardée')
    .setDescription(intro)
    .addFields(
      { name: '🏗️ Sera recréé', value: `**${stats.roles}** rôle(s) · **${stats.categories}** catégorie(s) · **${stats.channels}** salon(s)\n**${stats.locked}** verrou(s) · **${stats.bans}** bannissement(s) · permissions et ordre exacts`, inline: false },
      { name: '⚙️ Réglages', value: `Nom : **${(guild.name || '—').slice(0, 60)}**\n${guild.verificationLevel ?? 0} (vérification) · ${guild.explicitContentFilter ?? 0} (filtre) · ${guild.preferredLocale || '—'}`, inline: false },
      {
        name: '⚠️ À savoir',
        value: (warnings.length ? warnings.slice(0, 4).map(w => `• ${w}`) : ['• Aucun élément bloquant détecté.']).join('\n').slice(0, 1024),
        inline: false,
      },
      {
        name: botPermissionsBroken(preflight) ? '🚫 Permissions du bot manquantes' : '🛡️ Permissions du bot',
        value: botPermissionsBroken(preflight)
          ? `Le bot n'a pas : **${preflight.missingLabels.join(', ')}**.\n`
            + 'Donnez-lui ces permissions, puis relancez `/backup charger`. **Rien n\'a été modifié.**'
          : 'Toutes les permissions nécessaires sont présentes : la restauration peut se dérouler entièrement.',
        inline: false,
      },
    )
    .setFooter({ text: `${BRAND.name} • Restauration — double confirmation requise` });
}

function botPermissionsBroken(preflight) {
  return Boolean(preflight) && preflight.ok === false;
}

function reportEmbed(report, backup) {
  const color = report.errors.length ? (report.rolesCreated || report.channelsCreated ? COLORS.warning : COLORS.error)
    : report.warnings.length ? COLORS.warning : COLORS.success;
  const embed = baseEmbed(color)
    .setTitle(report.ok ? '✅ Restauration terminée' : '⚠️ Restauration terminée avec des erreurs')
    .setDescription(`Sauvegarde **${backup.name}** (\`${backup.backupId}\`) appliquée en ${(report.durationMs / 1000).toFixed(1)} s.`)
    .addFields({
      name: '📊 Résultat',
      value: [
        `🎭 **${report.rolesCreated}** rôle(s) créé(s)${report.rolesFailed ? ` · ${report.rolesFailed} échec(s)` : ''}`,
        `💬 **${report.channelsCreated}** salon(s) créé(s)${report.channelsFailed ? ` · ${report.channelsFailed} échec(s)` : ''}`,
        `🗑️ **${report.deletedChannels}** salon(s) et **${report.deletedRoles}** rôle(s) supprimés`,
        ...(report.channelsLocked
          ? [`🔒 **${report.channelsLocked}** salon(s) verrouillé(s)${report.locksReapplied ? ` (${report.locksReapplied} verrou(s) reposé(s))` : ''}`]
          : []),
        `🔨 **${report.bansRestored}** bannissement(s) restauré(s)`,
      ].join('\n'),
      inline: false,
    });

  if (report.errors.length) {
    embed.addFields({
      name: `❌ Erreurs (${report.errors.length})`,
      value: report.errors.slice(0, 8).map(e => `• ${e}`).join('\n').slice(0, 1024),
    });
  }
  if (report.warnings.length) {
    embed.addFields({
      name: `⚠️ Avertissements (${report.warnings.length})`,
      value: report.warnings.slice(0, 8).map(w => `• ${w}`).join('\n').slice(0, 1024),
    });
  }
  return embed;
}

// ── Restauration (bouton de confirmation finale) ────────────────────────────
async function runRestore(interaction, backup, { clearExisting }) {
  // Deux restaurations simultanées se détruiraient mutuellement les salons.
  if (backupManager.isRestoring(interaction.guild?.id)) {
    return interaction.reply({
      content: '⏳ Une restauration est déjà en cours sur ce serveur. Attendez qu\'elle se termine.',
      ephemeral: true,
    }).catch(() => {});
  }

  const progress = applyBrand(new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('⏳ Restauration en cours…')
    .setDescription('Préparation…'));

  await interaction.update({ embeds: [progress], components: [] }).catch(() => {});

  let lastEdit = 0;
  const onProgress = ({ detail }) => {
    const now = Date.now();
    if (now - lastEdit < 1500) return;
    lastEdit = now;
    applyBrand(progress.setDescription(`${detail}…\n\n**Ne quittez pas cette page** : la restauration continue.`));
    interaction.editReply({ embeds: [progress] }).catch(() => {});
  };

  const report = await backupManager.restoreBackup(interaction.guild, backup, {
    clearExisting,
    onProgress,
  });

  const payload = { embeds: [reportEmbed(report, backup)] };
  const delivered = await interaction.editReply(payload).then(() => true).catch(() => false);

  // Le salon d'origine fait souvent partie de ceux qui viennent d'être supprimés :
  // le rapport doit quand même arriver quelque part, jamais disparaître en silence.
  if (!delivered) {
    await interaction.user.send(payload).catch(() => {});
    const me = interaction.guild?.members?.me;
    const candidates = [
      interaction.guild?.systemChannel,
      ...sb.values(interaction.guild?.channels?.cache).filter(channel => (
        typeof channel.isTextBased === 'function' && channel.isTextBased()
      )),
    ].filter(Boolean);
    // On essaie chaque salon : le premier où le bot peut écrire reçoit le
    // rapport. Une restauration ne doit jamais finir sans compte rendu.
    for (const channel of candidates) {
      if (typeof channel.send !== 'function') continue;
      if (me && channel.permissionsFor && !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) continue;
      const sent = await channel.send(payload).then(() => true).catch(() => false);
      if (sent) break;
    }
  }
}

// ── Commande ────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('💾 Sauvegarde et restaure toute la structure du serveur')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub => sub
      .setName('creer')
      .setDescription('Enregistrer une sauvegarde complète du serveur')
      .addStringOption(option => option
        .setName('nom')
        .setDescription('Nom de la sauvegarde (ex. « avant refonte »)')
        .setMaxLength(60)
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('liste')
      .setDescription('Afficher les sauvegardes de ce serveur'))
    .addSubcommand(sub => sub
      .setName('info')
      .setDescription('Détail d\'une sauvegarde')
      .addStringOption(option => option
        .setName('id')
        .setDescription('Identifiant de la sauvegarde')
        .setRequired(true)
        .setMaxLength(16)))
    .addSubcommand(sub => sub
      .setName('charger')
      .setDescription('Restaurer une sauvegarde (remplace la structure actuelle)')
      .addStringOption(option => option
        .setName('id')
        .setDescription('Identifiant de la sauvegarde à restaurer')
        .setRequired(true)
        .setMaxLength(16))
      .addBooleanOption(option => option
        .setName('vider')
        .setDescription('Supprimer les salons et rôles actuels avant de restaurer (défaut : oui)')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('partager')
      .setDescription('Autoriser (ou non) le chargement de cette sauvegarde sur d\'autres serveurs')
      .addStringOption(option => option
        .setName('id')
        .setDescription('Identifiant de la sauvegarde')
        .setRequired(true)
        .setMaxLength(16))
      .addBooleanOption(option => option
        .setName('actif')
        .setDescription('Partager (oui) ou repasser en privé (non). Défaut : inverser l\'état actuel')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('supprimer')
      .setDescription('Supprimer définitivement une sauvegarde')
      .addStringOption(option => option
        .setName('id')
        .setDescription('Identifiant de la sauvegarde')
        .setRequired(true)
        .setMaxLength(16))),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ Commande utilisable uniquement dans un serveur.', ephemeral: true });
    }
    if (interaction.memberPermissions && !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ Vous devez avoir la permission **Gérer le serveur**.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // ── Créer ───────────────────────────────────────────────────────────────
    if (sub === 'creer') {
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.options.getString('nom')
        || `Sauvegarde du ${new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;
      try {
        const result = await backupManager.createBackup(interaction.guild, interaction.user.id, name);
        return interaction.editReply({ embeds: [createdEmbed(result)] });
      } catch (err) {
        return interaction.editReply({ content: `❌ Sauvegarde impossible : ${err.message}` });
      }
    }

    // ── Liste ───────────────────────────────────────────────────────────────
    if (sub === 'liste') {
      await interaction.deferReply({ ephemeral: true });
      const [backups, total] = await Promise.all([
        backupManager.listBackups(guildId, LIMIT).catch(() => []),
        backupManager.countBackups(guildId).catch(() => 0),
      ]);
      return interaction.editReply({ embeds: [listEmbed(backups, total)] });
    }

    // ── Info ────────────────────────────────────────────────────────────────
    // L'identifiant est unique tous serveurs : on peut inspecter une sauvegarde
    // venue d'ailleurs avant de décider de la charger ici.
    if (sub === 'info') {
      await interaction.deferReply({ ephemeral: true });
      const backup = await backupManager.findBackupAnywhere(interaction.options.getString('id')).catch(() => null);
      if (!backup) return interaction.editReply({ content: '❌ Sauvegarde introuvable. Vérifiez l\'identifiant avec `/backup liste`.' });
      if (!canUseBackup(backup, interaction.user.id, guildId)) {
        return interaction.editReply({ content: REFUSED });
      }
      const inspection = sb.inspectBackup(backup);
      return interaction.editReply({ embeds: [infoEmbed(backup, inspection, guildId)] });
    }

    // ── Charger (serveur courant OU autre serveur) ───────────────────────────
    if (sub === 'charger') {
      await interaction.deferReply({ ephemeral: true });
      const backup = await backupManager.findBackupAnywhere(interaction.options.getString('id')).catch(() => null);
      if (!backup) return interaction.editReply({ content: '❌ Sauvegarde introuvable. Vérifiez l\'identifiant avec `/backup liste`.' });
      if (!canUseBackup(backup, interaction.user.id, guildId)) {
        return interaction.editReply({ content: REFUSED });
      }

      const inspection = sb.inspectBackup(backup);
      const clearExisting = interaction.options.getBoolean('vider') ?? true;
      // Contrôle AVANT la confirmation : on n'invite jamais à confirmer une
      // restauration que le bot ne peut pas mener à bien.
      const preflight = await backupManager.preflightRestore(interaction.guild, backup);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bk_go_${backup.backupId}_${interaction.user.id}_${clearExisting ? 1 : 0}`)
          .setLabel(clearExisting ? '⚠️ Remplacer le serveur' : '📥 Ajouter la structure')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(botPermissionsBroken(preflight)),
        new ButtonBuilder()
          .setCustomId(`bk_cancel_${interaction.user.id}`)
          .setLabel('Annuler')
          .setStyle(ButtonStyle.Secondary),
      );
      return interaction.editReply({
        embeds: [confirmLoadEmbed(backup, inspection, clearExisting, guildId, preflight)],
        components: [row],
      });
    }

    // ── Partager (autorise le chargement sur d'autres serveurs) ──────────────
    if (sub === 'partager') {
      await interaction.deferReply({ ephemeral: true });
      const backup = await backupManager.findBackup(guildId, interaction.options.getString('id')).catch(() => null);
      if (!backup) {
        return interaction.editReply({ content: '❌ Sauvegarde introuvable sur ce serveur. Seul le serveur d\'origine peut modifier son partage.' });
      }
      const shared = interaction.options.getBoolean('actif') ?? !backup.shared;
      await backupManager.setBackupShared(guildId, backup.backupId, shared).catch(() => null);

      const embed = baseEmbed(shared ? COLORS.success : COLORS.info)
        .setTitle(shared ? '📤 Sauvegarde partagée' : '🔒 Sauvegarde privée')
        .setDescription(
          shared
            ? `**${backup.name}** (\`${backup.backupId}\`) peut désormais être chargée sur n'importe quel serveur, `
              + 'par toute personne ayant la permission **Gérer le serveur** sur ce serveur cible.\n\n'
              + 'Partagez cet identifiant avec la personne concernée. Repassez-la en privé avec `/backup partager actif:non`.'
            : `**${backup.name}** (\`${backup.backupId}\`) n'est plus partagée : seuls son créateur et les owners du bot `
              + 'peuvent la charger sur un autre serveur.',
        );
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Supprimer : confirmation ────────────────────────────────────────────
    if (sub === 'supprimer') {
      await interaction.deferReply({ ephemeral: true });
      const backup = await backupManager.findBackup(guildId, interaction.options.getString('id')).catch(() => null);
      if (!backup) return interaction.editReply({ content: '❌ Sauvegarde introuvable sur ce serveur.' });

      const embed = baseEmbed(COLORS.warning)
        .setTitle('🗑️ Supprimer cette sauvegarde ?')
        .setDescription(`**${backup.name}** (\`${backup.backupId}\`) sera définitivement supprimée.\n\nElle ne pourra plus servir à restaurer le serveur.`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bk_delyes_${backup.backupId}_${interaction.user.id}`)
          .setLabel('Supprimer définitivement')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`bk_cancel_${interaction.user.id}`)
          .setLabel('Annuler')
          .setStyle(ButtonStyle.Secondary),
      );
      return interaction.editReply({ embeds: [embed], components: [row] });
    }
  },

  // Exposé pour les tests hors-ligne de l'autorisation inter-serveurs.
  __testables: { canUseBackup, isForeign, originLabel },

  // ── Boutons persistants bk_ ───────────────────────────────────────────────
  async handleButton(interaction) {
    const parts = String(interaction.customId).split('_');
    const action = parts[1];
    // Formes : bk_cancel_<uid> · bk_delyes_<id>_<uid> · bk_go|confirm_<id>_<uid>_<0|1>
    const requesterId = action === 'cancel' ? parts[2] : parts[3];
    const clearExisting = parts[4] !== '0';

    if (requesterId !== interaction.user.id) {
      return interaction.reply({
        content: '❌ Seule la personne qui a lancé cette commande peut utiliser ces boutons.',
        ephemeral: true,
      });
    }
    if (interaction.memberPermissions && !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ Permission **Gérer le serveur** requise.', ephemeral: true });
    }

    if (action === 'cancel') {
      return interaction.update({
        embeds: [applyBrand(new EmbedBuilder()
          .setColor(COLORS.info)
          .setTitle('✖️ Action annulée')
          .setDescription('Aucune modification n\'a été apportée au serveur.'))],
        components: [],
      }).catch(() => {});
    }

    const backupId = parts[2];
    const backup = await backupManager.findBackupAnywhere(backupId).catch(() => null);
    if (!backup) {
      return interaction.update({
        embeds: [applyBrand(new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle('❌ Sauvegarde introuvable')
          .setDescription('Elle a peut-être été supprimée entre-temps.'))],
        components: [],
      }).catch(() => {});
    }
    // L'autorisation est revérifiée au moment d'agir : un bouton posté avant un
    // retrait de partage ne doit pas permettre de contourner la règle.
    if (!canUseBackup(backup, interaction.user.id, interaction.guildId)) {
      return interaction.reply({ content: REFUSED, ephemeral: true }).catch(() => {});
    }
    // Une suppression ne se fait que depuis le serveur qui possède la sauvegarde.
    if (action === 'delyes' && isForeign(backup, interaction.guildId)) {
      return interaction.reply({
        content: '❌ Seul le serveur d\'origine peut supprimer cette sauvegarde.',
        ephemeral: true,
      }).catch(() => {});
    }

    if (action === 'go') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bk_confirm_${backup.backupId}_${interaction.user.id}_${clearExisting ? 1 : 0}`)
          .setLabel('✅ Confirmer définitivement')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`bk_cancel_${interaction.user.id}`)
          .setLabel('Annuler')
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.update({
        embeds: [applyBrand(new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle('⚠️ Dernière confirmation')
          .setDescription(
            `La sauvegarde **${backup.name}** va être appliquée.\n`
            + (clearExisting
              ? 'Les salons et rôles actuels seront supprimés **immédiatement**.\n\n'
              : 'Aucun salon ni rôle existant ne sera supprimé.\n\n')
            + 'Cliquez sur **Confirmer définitivement** pour lancer la restauration.',
          ))],
        components: [row],
      }).catch(() => {});
      return;
    }

    if (action === 'confirm') {
      return runRestore(interaction, backup, { clearExisting });
    }

    if (action === 'delyes') {
      await backupManager.deleteBackup(interaction.guildId, backup.backupId).catch(() => null);
      return interaction.update({
        embeds: [applyBrand(new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('🗑️ Sauvegarde supprimée')
          .setDescription(`**${backup.name}** (\`${backup.backupId}\`) a été supprimée.`))],
        components: [],
      }).catch(() => {});
    }
  },
};
