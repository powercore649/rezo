'use strict';
// commands/configuration/waitingroom.js — 🎧 Salon vocal d'attente.
//
// Une seule commande, sans sous-commande : `/waitingroom` ouvre un panel où
// tout se règle à la souris (salon vocal, log, rôles, comportement), et où le
// staff peut appeler le suivant ou retirer quelqu'un de la file. C'est
// volontairement une commande « directe » (aucun subcommand) pour qu'elle soit
// ouvrable telle quelle depuis `/setting` → Support.
//
// La logique métier vit dans utils/waitingRoom.js ; ce fichier ne fait que
// l'interface.

const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const WaitingRoom = require('../../models/WaitingRoom');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');
const wr = require('../../utils/waitingRoom');

const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
const CAPACITIES = [
  { label: 'Illimité', value: 0 },
  { label: '3 personnes', value: 3 },
  { label: '5 personnes', value: 5 },
  { label: '10 personnes', value: 10 },
  { label: '15 personnes', value: 15 },
  { label: '25 personnes', value: 25 },
];

const PANEL_TIMEOUT_MS = 10 * 60 * 1000;

// ── Rendu du panel ───────────────────────────────────────────────────────────
function permissionWarning(guild, cfg) {
  if (!cfg.voiceChannelId) return null;
  const channel = guild.channels.cache.get(cfg.voiceChannelId);
  if (!channel) return '❌ Le salon vocal configuré n\'existe plus — choisis-en un nouveau.';
  const me = guild.members.me;
  if (!me) return null;
  const perms = channel.permissionsFor(me);
  const missing = [];
  if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('Voir le salon');
  if (!perms?.has(PermissionFlagsBits.Connect)) missing.push('Se connecter');
  if (cfg.targetChannelId && !perms?.has(PermissionFlagsBits.MoveMembers)) missing.push('Déplacer des membres');
  if (cfg.createTempChannel && !perms?.has(PermissionFlagsBits.ManageChannels)) missing.push('Gérer les salons (création des salons temporaires)');
  if (cfg.muteWaiting && !perms?.has(PermissionFlagsBits.MuteMembers)) missing.push('Rendre muet/sourd des membres');
  if (!missing.length) return null;
  return `⚠️ Permissions manquantes pour le bot dans <#${cfg.voiceChannelId}> : ${missing.join(', ')}.`;
}

function buildSetupEmbed(guild, cfg) {
  const queue = wr.queueOf(cfg);
  const on = '🟢', off = '🔴';
  const list = queue.slice(0, 8)
    .map((e, i) => `**${i + 1}.** <@${e.userId}>${e.calledAt ? ' — 🔔 appelé' : ''}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(cfg.voiceChannelId ? COLORS.primary : COLORS.warning)
    .setTitle('🎧 Salon vocal d\'attente')
    .setDescription(
      cfg.voiceChannelId
        ? 'Les membres qui rejoignent le salon vocal entrent automatiquement en file d\'attente.\n'
        : '⚠️ **Aucun salon vocal configuré** — la fonctionnalité est inactive.\nCommence par choisir le **salon vocal d\'attente**.\n'
    )
    .addFields(
      { name: '⚙️ Statut', value: cfg.enabled ? `${on} Activé` : `${off} Désactivé`, inline: true },
      { name: '🎙️ Salon d\'attente', value: cfg.voiceChannelId ? `<#${cfg.voiceChannelId}>` : '*Non défini*', inline: true },
      { name: '➡️ Destination', value: cfg.targetChannelId ? `<#${cfg.targetChannelId}>` : '*Aucune*', inline: true },
      { name: '💬 Salon logs / file', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*Aucun*', inline: true },
      { name: '🛡️ Rôle staff notifié', value: cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : '*Aucun*', inline: true },
      { name: '⏳ Rôle d\'attente', value: cfg.waitingRoleId ? `<@&${cfg.waitingRoleId}>` : '*Aucun*', inline: true },
      { name: '🔔 Notifications', value: cfg.notifyStaff ? `${on} Activées` : `${off} Désactivées`, inline: true },
      { name: '🤖 Appel auto', value: cfg.autoCallNext ? `${on} Activé` : `${off} Désactivé`, inline: true },
      { name: '👥 Capacité', value: cfg.maxQueue > 0 ? `**${cfg.maxQueue}**` : '*Illimitée*', inline: true },
      { name: '🚪 Salon temporaire', value: cfg.createTempChannel ? `${on} Créé à l'arrivée` : `${off} Désactivé`, inline: true },
      { name: '🔇 Mute + sourdine', value: cfg.muteWaiting ? `${on} Activés` : `${off} Désactivés`, inline: true },
      { name: '🗂️ Catégorie temporaires', value: cfg.tempCategoryId ? `<#${cfg.tempCategoryId}>` : '*Celle du salon d\'attente*', inline: true },
      { name: `📋 File d'attente (${queue.length}${cfg.maxQueue > 0 ? `/${cfg.maxQueue}` : ''})`, value: list || '*Personne en attente.*', inline: false },
      { name: '✅ Total pris en charge', value: `**${cfg.totalServed || 0}**`, inline: true },
    )
    .setFooter({ text: 'REZO • Salon d\'attente' })
    .setTimestamp();

  const warn = permissionWarning(guild, cfg);
  if (warn) embed.addFields({ name: '⚠️ Attention', value: warn, inline: false });
  if (!cfg.logChannelId) embed.addFields({ name: '💡 Astuce', value: 'Choisis un **salon logs** pour publier la file et notifier le staff.', inline: false });
  return embed;
}

function buildPanelComponents(cfg) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('wr_setup')
        .setPlaceholder('⚙️ Configurer le salon d\'attente…')
        .addOptions([
          { label: 'Salon vocal d\'attente', value: 'voice', emoji: '🎙️', description: 'Le salon vocal surveillé' },
          { label: 'Salon vocal de destination', value: 'target', emoji: '➡️', description: 'Où déplacer la personne appelée (optionnel)' },
          { label: 'Salon logs / file d\'attente', value: 'log', emoji: '💬', description: 'Où publier la file et notifier le staff' },
          { label: 'Rôle staff à notifier', value: 'staff', emoji: '🛡️', description: 'Rôle mentionné à chaque arrivée' },
          { label: 'Rôle d\'attente', value: 'role', emoji: '⏳', description: 'Rôle porté pendant l\'attente' },
          { label: 'Capacité de la file', value: 'capacity', emoji: '👥', description: 'Alerte le staff quand la file est pleine' },
          { label: 'Catégorie des salons temporaires', value: 'category', emoji: '🗂️', description: 'Où sont créés les salons d\'attente individuels' },
          { label: 'Nom du salon temporaire', value: 'tempname', emoji: '🏷️', description: 'Nom des salons créés (variable : {user})' },
          { label: 'Message de notification', value: 'message', emoji: '📝', description: 'Variables : {user} {position}' },
        ]),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('wr_actions')
        .setPlaceholder('🎛️ Actions…')
        .addOptions([
          { label: cfg.enabled ? 'Désactiver' : 'Activer', value: 'toggle', emoji: '⚙️' },
          { label: cfg.notifyStaff ? 'Couper les notifications' : 'Activer les notifications', value: 'notify', emoji: '🔔' },
          { label: cfg.giveRole ? 'Ne plus donner le rôle' : 'Donner le rôle d\'attente', value: 'role_toggle', emoji: '⏳' },
          { label: cfg.autoCallNext ? 'Désactiver l\'appel auto' : 'Activer l\'appel auto', value: 'autocall', emoji: '🤖' },
          { label: cfg.createTempChannel ? 'Ne plus créer de salon temporaire' : 'Créer un salon temporaire par membre', value: 'temp_toggle', emoji: '🚪' },
          { label: cfg.muteWaiting ? 'Laisser parler pendant l\'attente' : 'Mute + sourdine pendant l\'attente', value: 'mute_toggle', emoji: '🔇' },
          { label: 'Publier / rafraîchir la file', value: 'publish', emoji: '📣' },
          { label: 'Appeler le suivant', value: 'next', emoji: '📢' },
          { label: 'Retirer un membre de la file', value: 'remove', emoji: '❌' },
          { label: 'Vider la file', value: 'clear', emoji: '🧹' },
        ]),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('wr_refresh').setLabel('Rafraîchir').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('wr_close').setLabel('Fermer').setEmoji('✖').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function backRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('wr_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMANDE
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('waitingroom')
    .setDescription('🎧・Configure le salon vocal d\'attente')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ embeds: [errorEmbed('Erreur', 'Commande utilisable uniquement sur un serveur.')], ephemeral: true });

    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
    const cfg = await wr.getConfig(guildId);

    const render = () => ({
      embeds: [buildSetupEmbed(interaction.guild, cfg)],
      components: buildPanelComponents(cfg),
    });

    const reply = await interaction.editReply({ ...render(), fetchReply: true }).catch(() => null);
    if (!reply || typeof reply.createMessageComponentCollector !== 'function') return;

    const collector = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: PANEL_TIMEOUT_MS,
    });

    const reload = async () => {
      const fresh = await WaitingRoom.findOne({ guildId });
      if (fresh) {
        cfg.enabled = fresh.enabled;
        cfg.voiceChannelId = fresh.voiceChannelId;
        cfg.targetChannelId = fresh.targetChannelId;
        cfg.logChannelId = fresh.logChannelId;
        cfg.staffRoleId = fresh.staffRoleId;
        cfg.waitingRoleId = fresh.waitingRoleId;
        cfg.notifyStaff = fresh.notifyStaff;
        cfg.giveRole = fresh.giveRole;
        cfg.autoCallNext = fresh.autoCallNext;
        cfg.maxQueue = fresh.maxQueue;
        cfg.createTempChannel = fresh.createTempChannel;
        cfg.tempCategoryId = fresh.tempCategoryId;
        cfg.tempChannelName = fresh.tempChannelName;
        cfg.muteWaiting = fresh.muteWaiting;
        cfg.tempChannelIds = fresh.tempChannelIds;
        cfg.notifyMessage = fresh.notifyMessage;
        cfg.queue = fresh.queue;
        cfg.totalServed = fresh.totalServed;
        cfg.queueMessageId = fresh.queueMessageId;
      }
    };

    collector.on('collect', async i => {
      try {
        // ── Fermer / retour / rafraîchir ────────────────────────────────
        if (i.customId === 'wr_close') return i.update({ components: [] });

        if (i.customId === 'wr_back' || i.customId === 'wr_refresh') {
          await reload();
          return i.update(render());
        }

        // ── Choix de ressource (sous-vues) ──────────────────────────────
        if (i.customId === 'wr_setup') {
          const action = i.values[0];
          if (action === 'voice' || action === 'target') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(
                action === 'voice' ? '🎙️ Choisis le salon vocal d\'attente' : '➡️ Choisis le salon vocal de destination'
              ).setDescription(action === 'voice'
                ? 'Les membres qui rejoignent ce salon entrent en file d\'attente.'
                : 'Optionnel : la personne appelée y sera déplacée automatiquement.')],
              components: [
                new ActionRowBuilder().addComponents(
                  new ChannelSelectMenuBuilder()
                    .setCustomId(action === 'voice' ? 'wr_select_voice' : 'wr_select_target')
                    .setPlaceholder('Salon vocal…')
                    .addChannelTypes(...VOICE_TYPES),
                ),
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId(action === 'voice' ? 'wr_clear_voice' : 'wr_clear_target').setLabel('Aucun / effacer').setEmoji('❌').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId('wr_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
                ),
              ],
            });
          }
          if (action === 'log') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('💬 Choisis le salon des logs').setDescription('La file d\'attente y sera publiée et le staff y sera notifié.')],
              components: [
                new ActionRowBuilder().addComponents(
                  new ChannelSelectMenuBuilder().setCustomId('wr_select_log').setPlaceholder('Salon texte…')
                    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
                ),
                backRow(),
              ],
            });
          }
          if (action === 'staff') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🛡️ Choisis le rôle du staff')],
              components: [
                new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('wr_select_staff').setPlaceholder('Rôle staff…')),
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('wr_clear_staff').setLabel('Aucun / effacer').setEmoji('❌').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId('wr_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
                ),
              ],
            });
          }
          if (action === 'role') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('⏳ Choisis le rôle d\'attente').setDescription('Donné à l\'entrée dans le salon d\'attente, retiré à la sortie.')],
              components: [
                new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('wr_select_role').setPlaceholder('Rôle d\'attente…')),
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('wr_clear_role').setLabel('Aucun / effacer').setEmoji('❌').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId('wr_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
                ),
              ],
            });
          }
          if (action === 'capacity') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('👥 Capacité de la file').setDescription(`Capacité actuelle : ${cfg.maxQueue > 0 ? `**${cfg.maxQueue}**` : '*illimitée*'}\nAu-delà, le staff est alerté.`).setFooter({ text: 'REZO • Salon d\'attente' })],
              components: [
                new ActionRowBuilder().addComponents(
                  new StringSelectMenuBuilder().setCustomId('wr_set_capacity').setPlaceholder('Choisir une capacité…')
                    .addOptions(CAPACITIES.map(c => ({ label: c.label, value: String(c.value), default: c.value === cfg.maxQueue }))),
                ),
                backRow(),
              ],
            });
          }
          if (action === 'message') {
            const modal = new ModalBuilder().setCustomId('wr_modal_message').setTitle('📝 Message de notification');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('message').setLabel('Message ({user} et {position})')
                .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
                .setValue(cfg.notifyMessage || ''),
            ));
            return i.showModal(modal);
          }
          if (action === 'category') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🗂️ Catégorie des salons temporaires')
                .setDescription(cfg.voiceChannelId
                  ? 'Les salons d\'attente individuels seront créés dans cette catégorie. Par défaut : celle du salon d\'attente.'
                  : 'Choisis d\'abord un salon vocal d\'attente.')],
              components: [
                new ActionRowBuilder().addComponents(
                  new ChannelSelectMenuBuilder().setCustomId('wr_select_category').setPlaceholder('Catégorie…')
                    .addChannelTypes(ChannelType.GuildCategory),
                ),
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder().setCustomId('wr_clear_category').setLabel('Aucune / effacer').setEmoji('❌').setStyle(ButtonStyle.Secondary),
                  new ButtonBuilder().setCustomId('wr_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
                ),
              ],
            });
          }
          if (action === 'tempname') {
            const modal = new ModalBuilder().setCustomId('wr_modal_tempname').setTitle('🏷️ Nom du salon temporaire');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('name').setLabel('Nom ({user} = pseudo du membre)')
                .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
                .setValue(cfg.tempChannelName || '⏳・{user}'),
            ));
            return i.showModal(modal);
          }
          return;
        }

        // ── Sélections ──────────────────────────────────────────────────
        if (i.customId === 'wr_select_voice') {
          cfg.voiceChannelId = i.values[0];
          cfg.queueMessageId = null; // la file sera republiée
          await cfg.save();
          await reload();
          return i.update(render());
        }
        if (i.customId === 'wr_select_target') {
          cfg.targetChannelId = i.values[0];
          await cfg.save();
          await reload();
          return i.update(render());
        }
        if (i.customId === 'wr_select_log') {
          cfg.logChannelId = i.values[0];
          cfg.queueMessageId = null;
          await cfg.save();
          await reload();
          await wr.refreshQueueMessage(interaction.guild, cfg).catch(() => {});
          return i.update({
            embeds: [successEmbed('Salon des logs défini', `La file d'attente sera publiée dans <#${cfg.logChannelId}>.`)],
            components: [backRow()],
          });
        }
        if (i.customId === 'wr_select_staff') {
          cfg.staffRoleId = i.values[0];
          await cfg.save();
          await reload();
          return i.update(render());
        }
        if (i.customId === 'wr_select_role') {
          cfg.waitingRoleId = i.values[0];
          await cfg.save();
          await reload();
          return i.update(render());
        }
        if (i.customId === 'wr_select_category') {
          cfg.tempCategoryId = i.values[0];
          await cfg.save();
          await reload();
          return i.update(render());
        }
        if (i.customId === 'wr_set_capacity') {
          cfg.maxQueue = parseInt(i.values[0], 10) || 0;
          await cfg.save();
          await reload();
          return i.update(render());
        }

        // ── Effacements ─────────────────────────────────────────────────
        if (i.customId.startsWith('wr_clear_')) {
          const key = i.customId.replace('wr_clear_', '');
          const map = { voice: 'voiceChannelId', target: 'targetChannelId', staff: 'staffRoleId', role: 'waitingRoleId', category: 'tempCategoryId' };
          if (map[key]) {
            cfg[map[key]] = null;
            if (key === 'voice') cfg.queueMessageId = null;
            await cfg.save();
          }
          await reload();
          return i.update(render());
        }

        // ── Actions ─────────────────────────────────────────────────────
        if (i.customId === 'wr_actions') {
          const action = i.values[0];

          if (action === 'toggle') { cfg.enabled = !cfg.enabled; await cfg.save(); await reload(); return i.update(render()); }
          if (action === 'notify') { cfg.notifyStaff = !cfg.notifyStaff; await cfg.save(); await reload(); return i.update(render()); }
          if (action === 'role_toggle') { cfg.giveRole = !cfg.giveRole; await cfg.save(); await reload(); return i.update(render()); }
          if (action === 'autocall') { cfg.autoCallNext = !cfg.autoCallNext; await cfg.save(); await reload(); return i.update(render()); }
          if (action === 'temp_toggle') { cfg.createTempChannel = !cfg.createTempChannel; await cfg.save(); await reload(); return i.update(render()); }
          if (action === 'mute_toggle') { cfg.muteWaiting = !cfg.muteWaiting; await cfg.save(); await reload(); return i.update(render()); }

          if (action === 'publish') {
            if (!cfg.logChannelId) return i.reply({ embeds: [errorEmbed('Salon logs manquant', 'Choisis d\'abord un salon pour publier la file.')], ephemeral: true });
            const msg = await wr.refreshQueueMessage(interaction.guild, cfg);
            if (!msg) return i.reply({ embeds: [errorEmbed('Publication impossible', 'Vérifie que le bot peut écrire dans le salon logs.')], ephemeral: true });
            return i.update({
              embeds: [successEmbed('File publiée', `La file d'attente est visible dans <#${cfg.logChannelId}>.`)],
              components: [backRow()],
            });
          }

          if (action === 'next') {
            const res = await wr.callNext(interaction.guild, cfg, { byUser: interaction.user });
            await reload();
            if (!res.ok) return i.reply({ embeds: [errorEmbed('Personne à appeler', 'La file d\'attente est vide ou tout le monde a déjà été appelé.')], ephemeral: true });
            return i.update({
              embeds: [successEmbed('Suivant appelé', `<@${res.userId}> a été appelé (position ${res.position}).`)],
              components: [backRow()],
            });
          }

          if (action === 'remove') {
            if (!wr.queueOf(cfg).length) return i.reply({ embeds: [errorEmbed('File vide', 'Personne à retirer.')], ephemeral: true });
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('❌ Retirer un membre de la file').setDescription('Sélectionne le membre à retirer.')],
              components: [
                new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('wr_select_remove').setPlaceholder('Membre…').setMaxValues(1)),
                backRow(),
              ],
            });
          }

          if (action === 'clear') {
            if (!wr.queueOf(cfg).length) return i.reply({ embeds: [errorEmbed('File vide', 'Il n\'y a personne à retirer.')], ephemeral: true });
            cfg.queue = [];
            await cfg.save();
            await reload();
            await wr.refreshQueueMessage(interaction.guild, cfg).catch(() => {});
            return i.update({
              embeds: [successEmbed('File vidée', 'Tous les membres en attente ont été retirés de la file.')],
              components: [backRow()],
            });
          }
          return;
        }

        if (i.customId === 'wr_select_remove') {
          const userId = i.values[0];
          const removed = await wr.removeFromQueue(cfg, userId);
          await reload();
          await wr.refreshQueueMessage(interaction.guild, cfg).catch(() => {});
          return i.update({
            embeds: [removed
              ? successEmbed('Membre retiré', `<@${userId}> ne fait plus partie de la file d'attente.`)
              : errorEmbed('Introuvable', `<@${userId}> n'était pas dans la file.`)],
            components: [backRow()],
          });
        }
      } catch (err) {
        console.error('[waitingroom] panel:', err.message);
        if (!i.replied && !i.deferred) {
          await i.reply({ embeds: [errorEmbed('Erreur', 'Action impossible, réessaie.')], ephemeral: true }).catch(() => {});
        }
      }
    });

    collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ── Bouton public « Appeler le suivant » (message de file) ───────────────
  async handleNext(interaction, client) {
    const cfg = await WaitingRoom.findOne({ guildId: interaction.guildId }).catch(() => null);
    if (!cfg || !cfg.voiceChannelId) {
      return interaction.reply({ embeds: [errorEmbed('Salon d\'attente inactif', 'La fonctionnalité n\'est pas configurée sur ce serveur.')], ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const res = await wr.callNext(interaction.guild, cfg, { byUser: interaction.user });
    if (!res.ok) return interaction.editReply({ embeds: [errorEmbed('Personne à appeler', 'La file d\'attente est vide ou tout le monde a déjà été appelé.')] });
    return interaction.editReply({ embeds: [successEmbed('Suivant appelé', `<@${res.userId}> a été appelé (position ${res.position}).`)] });
  },

  // ── Bouton public « Rafraîchir » (message de file) ───────────────────────
  async handleRefresh(interaction) {
    const cfg = await WaitingRoom.findOne({ guildId: interaction.guildId }).catch(() => null);
    if (!cfg) return interaction.reply({ embeds: [errorEmbed('Salon d\'attente inactif', 'La fonctionnalité n\'est pas configurée sur ce serveur.')], ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const msg = await wr.refreshQueueMessage(interaction.guild, cfg);
    if (!msg) return interaction.editReply({ embeds: [errorEmbed('Rafraîchissement impossible', 'Le message de file est introuvable ou le salon est inaccessible.')] });
    return interaction.editReply({ embeds: [successEmbed('File rafraîchie', `\`${cfg.queue.length}\` personne(s) en attente.`)] });
  },

  // ── Modale : message de notification ─────────────────────────────────────
  async handleModal(interaction, client) {
    const cfg = await wr.getConfig(interaction.guildId);

    if (interaction.customId === 'wr_modal_tempname') {
      cfg.tempChannelName = interaction.fields.getTextInputValue('name').slice(0, 100);
      await cfg.save();
      return interaction.reply({
        embeds: [successEmbed('Nom du salon temporaire mis à jour', `\`${cfg.tempChannelName}\`\n\nVariable disponible : \`{user}\` (pseudo du membre).`)],
        ephemeral: true,
      }).catch(() => {});
    }

    if (interaction.customId !== 'wr_modal_message') return;
    cfg.notifyMessage = interaction.fields.getTextInputValue('message').slice(0, 500);
    await cfg.save();
    return interaction.reply({
      embeds: [successEmbed('Message de notification mis à jour', `\`${cfg.notifyMessage}\`\n\nVariables disponibles : \`{user}\`, \`{position}\`.`)],
      ephemeral: true,
    }).catch(() => {});
  },
};
