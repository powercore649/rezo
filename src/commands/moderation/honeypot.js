'use strict';
// commands/honeypot.js — Salon + bouton piège anti-bot / anti-token-grabber (v3)
// ─────────────────────────────────────────────────────────────────────────────
// Système AUTONOME (indépendant des honeypots de l'anti-raid qui sont gérés
// dans /antiraid — les deux coexistent sans interférence).
//
// Panel interactif complet : tous les réglages se font dans le panneau, en un
// seul écran (≤ 5 rangées Discord). Routage persistant des interactions via
// interactionCreate.js (handleButton / handleSelect / handleModal, ids `_hp_`)
// + collecteur interne tant que le panel reste actif (10 min).
//
// Flux de sanction (inchangé) : messageCreate.js → handleTrigger()
//                              bouton hp_trap_click → handleButtonTrigger()

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, PermissionFlagsBits, ChannelType,
} = require('discord.js');
const Honeypot = require('../../models/Honeypot');
const HoneypotTrigger = require('../../models/HoneypotTrigger');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

const ACTION_EMOJIS = { mute: '🔇', kick: '👢', ban: '🔨' };
const ACTION_LABELS = {
  mute: '🔇 Mute temporaire',
  kick: '👢 Expulsion',
  ban:  '🔨 Bannissement',
};
const ACTION_SHORT = { mute: 'Mute temporaire', kick: 'Expulsion', ban: 'Bannissement' };

// Durées de mute proposées (minutes) — Discord limite le timeout à 28 jours.
const DURATIONS = [
  { label: '1 heure',  value: 60 },
  { label: '12 heures', value: 12 * 60 },
  { label: '1 jour',   value: 24 * 60 },
  { label: '3 jours',  value: 3 * 24 * 60 },
  { label: '7 jours',  value: 7 * 24 * 60 },
  { label: '14 jours', value: 14 * 24 * 60 },
  { label: '28 jours', value: 28 * 24 * 60 },
];

// Noms crédibles pour attirer les bots (évite les mots "piège"/"trap" qui les feraient fuir)
const DECOY_NAMES = [
  'verification-compte', 'lisez-avant-de-parler', 'annonces-importantes',
  'regles-du-serveur', 'bienvenue-ici', 'confirmez-votre-arrivee',
  'infos-serveur', 'a-lire-absolument',
];

const fmtDuration = (min) => {
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.round(min / 60)} heure(s)`;
  return `${Math.round(min / (24 * 60))} jour(s)`;
};

async function getOrCreate(guildId) {
  let cfg = await Honeypot.findOne({ guildId });
  if (!cfg) cfg = await Honeypot.create({ guildId });
  return cfg;
}

// ─── Sanction partagée (message piège ET bouton piège) ───────────────────────
async function applySanction(guild, member, user, cfg, { channelId, contentPreview, triggerLabel }) {
  if (cfg.dmUser) {
    const actionTxt = {
      mute: `mis en sourdine pendant **${fmtDuration(cfg.muteDuration)}**`,
      kick: 'expulsé du serveur',
      ban:  'banni du serveur',
    }[cfg.action];
    await user.send({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle('⚠️ Sanction automatique — Honeypot')
        .setDescription(`Vous avez déclenché un piège de sécurité sur **${guild.name}**.\nVous avez été ${actionTxt}.`)],
    }).catch(() => {});
  }

  if (member) {
    if (cfg.action === 'mute' && member.moderatable) {
      await member.timeout(cfg.muteDuration * 60 * 1000, 'Honeypot déclenché').catch(() => {});
    } else if (cfg.action === 'kick' && member.kickable) {
      await member.kick('Honeypot déclenché').catch(() => {});
    } else if (cfg.action === 'ban' && member.bannable) {
      await member.ban({ reason: 'Honeypot déclenché' }).catch(() => {});
    }
  }

  await Honeypot.updateOne({ guildId: guild.id }, { $inc: { totalTriggered: 1 } }).catch(() => {});

  await HoneypotTrigger.create({
    guildId: guild.id, userId: user.id, userTag: user.tag, channelId, action: cfg.action, contentPreview,
  }).catch(() => {});

  if (cfg.logChannelId) {
    const logChannel = guild.channels.cache.get(cfg.logChannelId);
    if (logChannel) {
      await logChannel.send({
        embeds: [new EmbedBuilder()
          .setColor(0xE67E22)
          .setTitle('🍯 Honeypot déclenché')
          .addFields(
            { name: 'Membre', value: `${user.tag} (${user.id})`, inline: true },
            { name: 'Salon', value: `<#${channelId}>`, inline: true },
            { name: 'Déclencheur', value: triggerLabel, inline: true },
            { name: 'Action', value: ACTION_LABELS[cfg.action], inline: true },
            { name: 'Détail', value: contentPreview.slice(0, 500), inline: false },
          )
          .setTimestamp()],
      }).catch(() => {});
    }
  }
}

// ─── Déclenché en écrivant dans un salon piège — utilisé par messageCreate.js ─
async function handleTrigger(message, cfg) {
  const member = message.member;
  if (member?.permissions?.has(PermissionFlagsBits.Administrator)) return; // jamais un admin

  if (cfg.deleteMessage) await message.delete().catch(() => {});

  await applySanction(message.guild, member, message.author, cfg, {
    channelId: message.channel.id,
    contentPreview: message.content ? message.content.slice(0, 300) : '*Vide / pièce jointe*',
    triggerLabel: '💬 Message envoyé',
  });
}

// ─── Déclenché en cliquant le bouton piège — routé depuis interactionCreate.js
async function handleButtonTrigger(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const cfg = await Honeypot.findOne({ guildId: guild.id, enabled: true });
  if (!cfg) {
    return interaction.reply({ content: "⚠️ Ce piège n'est plus actif.", ephemeral: true }).catch(() => {});
  }

  const member = interaction.member;
  if (member?.permissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '👑 Les administrateurs ne sont pas affectés par ce piège.', ephemeral: true }).catch(() => {});
  }

  await interaction.reply({ content: '⏳ Vérification en cours…', ephemeral: true }).catch(() => {});

  await applySanction(guild, member, interaction.user, cfg, {
    channelId: interaction.channel?.id || 'inconnu',
    contentPreview: '🔘 Bouton piège cliqué',
    triggerLabel: '🔘 Bouton cliqué',
  });
}

// ─── Message d'avertissement publié dans les salons pièges ───────────────────
function buildWarningPayload(guild, cfg) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle('⚠️ Avertissement')
    .setDescription(cfg.warningMessage)
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setFooter({ text: `Sécurité automatique • ${guild.name}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hp_trap_click').setLabel(cfg.triggerLabel || '✅ Confirmer avoir lu').setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row] };
}

// ─── Embed du panneau ─────────────────────────────────────────────────────────
async function buildPanelEmbed(cfg) {
  const totalTriggers = await HoneypotTrigger.countDocuments({ guildId: cfg.guildId }).catch(() => cfg.totalTriggered);
  const last24 = await HoneypotTrigger.countDocuments({
    guildId: cfg.guildId, triggeredAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
  }).catch(() => 0);

  return new EmbedBuilder()
    .setColor(cfg.enabled ? COLORS.success : COLORS.primary)
    .setTitle('🍯 Honeypot — Salon & bouton piège anti-bot')
    .setDescription(
      'Piège invisible pour les humains pressés, mortel pour les bots : un salon qui ressemble à une porte d\'entrée classique, ' +
      'et un bouton « Confirmer avoir lu » qui tente les automatisations. **Toute interaction déclenche la sanction choisie.**\n\n' +
      '*(Système indépendant des honeypots de l\'anti-raid — réglés dans `/antiraid`.)*',
    )
    .addFields(
      { name: '🟢 État', value: cfg.enabled ? '**Activé**' : '**Désactivé**', inline: true },
      { name: '⚔️ Sanction', value: ACTION_LABELS[cfg.action], inline: true },
      { name: '⏱️ Durée du mute', value: cfg.action === 'mute' ? fmtDuration(cfg.muteDuration) : '—', inline: true },
      {
        name: `🚪 Salons piège (${cfg.channelIds.length})`,
        value: cfg.channelIds.length
          ? cfg.channelIds.slice(0, 20).map(id => `<#${id}>`).join(' · ') + (cfg.channelIds.length > 20 ? ' …' : '')
          : '*Aucun — ajoutez-en au moins un pour activer*',
        inline: false,
      },
      { name: '📋 Logs', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*Aucun*', inline: true },
      { name: '🗑️ Suppr. message', value: cfg.deleteMessage ? '✅ Oui' : '❌ Non', inline: true },
      { name: '📨 DM au membre', value: cfg.dmUser ? '✅ Oui' : '❌ Non', inline: true },
      { name: '📊 Déclenchements', value: `**${totalTriggers}** au total · **${last24}** sur 24h`, inline: true },
    )
    .setFooter({ text: 'REZO • Honeypot v3' })
    .setTimestamp();
}

// ─── Composants du panneau (5 rangées, un écran unique) ───────────────────────
// ⚠️ Discord : un select menu occupe TOUTE la largeur d'une rangée — jamais
// de boutons ni de second select dans la même rangée (50035 WIDTH_EXCEEDED).
function buildPanelComponents(cfg) {
  // R1 — état + réglages rapides (boutons uniquement)
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('_hp_toggle')
      .setLabel(cfg.enabled ? 'Désactiver' : 'Activer')
      .setEmoji(cfg.enabled ? '🔴' : '🟢')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('_hp_delete_toggle').setLabel(`Suppr. message : ${cfg.deleteMessage ? 'ON' : 'OFF'}`).setEmoji('🗑️').setStyle(cfg.deleteMessage ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('_hp_dm_toggle').setLabel(`DM : ${cfg.dmUser ? 'ON' : 'OFF'}`).setEmoji('📨').setStyle(cfg.dmUser ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  // R2 — sanction automatique (menu seul)
  const r2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('_hp_action').setPlaceholder('⚔️ Sanction automatique…').addOptions(
      Object.keys(ACTION_LABELS).map(value => ({
        label: ACTION_SHORT[value], value, emoji: ACTION_EMOJIS[value],
        default: cfg.action === value,
      })),
    ),
  );

  // R3 — durée du mute (menu seul)
  const r3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('_hp_duration').setPlaceholder('⏱️ Durée du mute…').addOptions(
      DURATIONS.map(d => ({
        label: d.label, value: String(d.value), default: cfg.muteDuration === d.value,
      })),
    ),
  );

  // R4 — salons pièges (menu seul)
  const r4 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('_hp_channels_add')
      .setPlaceholder('➕ Ajouter des salons pièges…')
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(0).setMaxValues(5),
  );

  // R5 — boutons de navigation vers les sous-vues (logs, salons, etc.)
  const r5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('_hp_channels_view').setLabel('Gérer les salons').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('_hp_logs_view').setLabel('Logs').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('_hp_advanced').setLabel('Avertissement').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('_hp_stats').setLabel('Statistiques').setEmoji('📊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('_hp_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  return [r1, r2, r3, r4, r5];
}

// ─── Vue « gérer les salons » (retrait) ───────────────────────────────────────
function buildChannelsView(guild, cfg) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🚪 Salons pièges')
    .setDescription(
      `**Actuels (${cfg.channelIds.length}) :** ${cfg.channelIds.length ? cfg.channelIds.map(id => `<#${id}>`).join(' · ') : '*aucun*'}\n\n` +
      'Tout message envoyé dans l\'un de ces salons déclenche la sanction. Les salons retirés restent sur le serveur — supprimez-les à la main si besoin.',
    );
}

// ─── Statistiques détaillées + historique ─────────────────────────────────────
async function buildStatsEmbed(guildId) {
  const now = Date.now();
  const since = h => new Date(now - h * 3600 * 1000);

  const [total, last24h, last7d, last30d, byAction, byChannel, recent] = await Promise.all([
    HoneypotTrigger.countDocuments({ guildId }),
    HoneypotTrigger.countDocuments({ guildId, triggeredAt: { $gte: since(24) } }),
    HoneypotTrigger.countDocuments({ guildId, triggeredAt: { $gte: since(24 * 7) } }),
    HoneypotTrigger.countDocuments({ guildId, triggeredAt: { $gte: since(24 * 30) } }),
    HoneypotTrigger.aggregate([{ $match: { guildId } }, { $group: { _id: '$action', count: { $sum: 1 } } }]).catch(() => []),
    HoneypotTrigger.aggregate([
      { $match: { guildId } },
      { $group: { _id: '$channelId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]).catch(() => []),
    HoneypotTrigger.find({ guildId }).sort({ triggeredAt: -1 }).limit(10).lean().catch(() => []),
  ]);

  const actionCounts = { mute: 0, kick: 0, ban: 0 };
  byAction.forEach(a => { actionCounts[a._id] = a.count; });
  const topChannel = byChannel[0];

  const recentLines = recent.length
    ? recent.map(r => {
        const ts = Math.floor(new Date(r.triggeredAt).getTime() / 1000);
        return `${ACTION_LABELS[r.action]} — **${r.userTag}** dans <#${r.channelId}> <t:${ts}:R>`;
      }).join('\n')
    : '*Aucun déclenchement enregistré.*';

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📊 Honeypot — Statistiques détaillées')
    .setDescription('Historique des 10 derniers déclenchements et répartition par sanction.')
    .addFields(
      { name: 'Total',    value: `${total}`,    inline: true },
      { name: '24h',      value: `${last24h}`,  inline: true },
      { name: '7 jours',  value: `${last7d}`,   inline: true },
      { name: '30 jours', value: `${last30d}`,  inline: true },
      { name: 'Par action', value: `🔇 Mute: **${actionCounts.mute}**\n👢 Kick: **${actionCounts.kick}**\n🔨 Ban: **${actionCounts.ban}**`, inline: true },
      { name: 'Salon le plus déclenché', value: topChannel ? `<#${topChannel._id}> (${topChannel.count})` : '*Aucun*', inline: true },
      { name: 'Historique récent', value: recentLines, inline: false },
    )
    .setFooter({ text: 'REZO • Honeypot v3' })
    .setTimestamp();
}

// ═════════════════════════════════════════════════════════════════════════════
const authGate = require('../../utils/authGate');

module.exports = {
  getOrCreate,
  handleTrigger,
  handleButtonTrigger,

  data: new SlashCommandBuilder()
    .setName('honeypot')
    .setDescription('🍯 Configurer le salon + bouton piège anti-bot / anti-token-grabber')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ─── Ouverture du panneau ────────────────────────────────────────────────
  async execute(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);

    const reply = await interaction.reply({
      embeds: [await buildPanelEmbed(cfg)],
      components: buildPanelComponents(cfg),
      ephemeral: true,
      fetchReply: true,
    });

    // Le collecteur garde le panneau actif 10 min ; les ids `_hp_` sont AUSSI
    // routés de façon persistante par interactionCreate (handleButton/handleSelect)
    // → le panneau reste fonctionnel même après expiration du collecteur.
    const col = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 10 * 60 * 1000 });
    col.on('collect', () => {});
    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Actions rapides internes (collecteur 10 min) ────────────────────────
  _panelAction: async (interaction, client) => {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Panneau honeypot' }))) return;
    const refresh = async () => {
      const cfg = await getOrCreate(interaction.guild.id);
      return interaction.update({ embeds: [await buildPanelEmbed(cfg)], components: buildPanelComponents(cfg) });
    };

    // ── Activer / Désactiver ─────────────────────────────────────────────
    if (interaction.customId === '_hp_toggle') {
      const cfg = await getOrCreate(interaction.guild.id);
      if (!cfg.enabled && cfg.channelIds.length === 0) {
        return interaction.reply({
          embeds: [errorEmbed('Aucun salon configuré', 'Ajoute au moins un salon piège (menu « ➕ Ajouter des salons pièges » ou 🪄 Créer un salon) avant d\'activer le système.')],
          ephemeral: true,
        });
      }
      cfg.enabled = !cfg.enabled;
      await cfg.save();
      return refresh();
    }

    // ── Vue de gestion des salons (retrait) ──────────────────────────────
    if (interaction.customId === '_hp_channels_view') {
      const cfg = await getOrCreate(interaction.guild.id);
      return interaction.update({ embeds: [buildChannelsView(interaction.guild, cfg)], components: buildChannelsComponents(cfg, interaction.guild) });
    }

    // ── Création automatique du salon piège ──────────────────────────────
    if (interaction.customId === '_hp_autocreate') {
      const cfg = await getOrCreate(interaction.guild.id);
      const me = interaction.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return interaction.reply({
          embeds: [errorEmbed('Permission manquante', 'Le bot a besoin de la permission « Gérer les salons » pour créer le salon automatiquement.')],
          ephemeral: true,
        });
      }

      const name = DECOY_NAMES[Math.floor(Math.random() * DECOY_NAMES.length)];
      let channel;
      try {
        channel = await interaction.guild.channels.create({
          name,
          type: ChannelType.GuildText,
          topic: '⚠️ Salon système généré par REZO — ne pas supprimer',
          position: 0, // en haut de la liste pour être vu (et scanné) en premier
          permissionOverwrites: [
            {
              id: interaction.guild.roles.everyone.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
            },
          ],
        });
      } catch (err) {
        return interaction.reply({
          embeds: [errorEmbed('Échec de la création', `Discord a refusé la création du salon : ${err.message}`)],
          ephemeral: true,
        });
      }

      cfg.channelIds = Array.from(new Set([...cfg.channelIds, channel.id]));
      await cfg.save();

      // Publie et épingle immédiatement l'avertissement dans le nouveau salon
      const warnMsg = await channel.send(buildWarningPayload(interaction.guild, cfg)).catch(() => null);
      if (warnMsg) await warnMsg.pin().catch(() => {});

      await refresh();
      return interaction.followUp({
        embeds: [successEmbed('Salon créé', `<#${channel.id}> est désormais un piège, avec l'avertissement épinglé.\n⚠️ **Prévenez votre staff** : personne ne doit y écrire, jamais.`)],
        ephemeral: true,
      });
    }

    // ── Publier l'avertissement dans les salons pièges ───────────────────
    if (interaction.customId === '_hp_publish') {
      const cfg = await getOrCreate(interaction.guild.id);
      if (!cfg.channelIds.length) {
        return interaction.reply({
          embeds: [errorEmbed('Aucun salon configuré', 'Ajoute un salon piège avant de publier le message.')],
          ephemeral: true,
        });
      }
      let posted = 0;
      for (const id of cfg.channelIds) {
        const ch = interaction.guild.channels.cache.get(id);
        if (!ch) continue;
        const msg = await ch.send(buildWarningPayload(interaction.guild, cfg)).catch(() => null);
        if (msg) { await msg.pin().catch(() => {}); posted++; }
      }
      return interaction.reply({
        embeds: [successEmbed('Message publié', `Avertissement envoyé et épinglé dans ${posted} salon(s).`)],
        ephemeral: true,
      });
    }

    // ── Modal « avertissement & bouton » ─────────────────────────────────
    if (interaction.customId === '_hp_advanced') {
      const cfg = await getOrCreate(interaction.guild.id);
      const modal = new ModalBuilder().setCustomId('hp_advanced_modal').setTitle('Avertissement & bouton piège');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('hp_message')
            .setLabel("Message d'avertissement (embed épinglé)")
            .setStyle(TextInputStyle.Paragraph)
            .setValue(cfg.warningMessage.slice(0, 1000))
            .setMaxLength(1000)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('hp_trigger')
            .setLabel('Libellé du bouton piège')
            .setStyle(TextInputStyle.Short)
            .setValue(cfg.triggerLabel || '✅ Confirmer avoir lu')
            .setMaxLength(80)
            .setRequired(true),
        ),
      );
      return interaction.showModal(modal);
    }

    // ── Sous-vue logs ────────────────────────────────────────────────────
    if (interaction.customId === '_hp_logs_view') {
      const cfg = await getOrCreate(interaction.guild.id);
      return interaction.update({
        embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('📋 Salon de logs')
          .setDescription(`Actuel : ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*Aucun*'}\n\nChaque sanction (mute/kick/ban) y est journalisée avec le membre, le salon et l'aperçu du message.`)],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId('_hp_logs').setPlaceholder('📋 Choisir un salon de logs…').addChannelTypes(ChannelType.GuildText),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('_hp_logs_clear').setLabel('Retirer les logs').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('_hp_back').setLabel('Retour au panneau').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }
    if (interaction.customId === '_hp_logs_clear') {
      const cfg = await getOrCreate(interaction.guild.id);
      cfg.logChannelId = null;
      await cfg.save();
      return refresh();
    }

    // ── Retour au panneau depuis une vue ─────────────────────────────────
    if (interaction.customId === '_hp_back') return refresh();

    // ── Statistiques ─────────────────────────────────────────────────────
    if (interaction.customId === '_hp_stats') {
      const statsEmbed = await buildStatsEmbed(interaction.guild.id);
      return interaction.update({
        embeds: [statsEmbed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('_hp_back').setLabel('Retour au panneau').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('_hp_stats_clear').setLabel('Vider l\'historique').setEmoji('🧹').setStyle(ButtonStyle.Danger),
        )],
      });
    }
    if (interaction.customId === '_hp_stats_clear') {
      await HoneypotTrigger.deleteMany({ guildId: interaction.guild.id });
      await Honeypot.updateOne({ guildId: interaction.guild.id }, { $set: { totalTriggered: 0 } });
      const statsEmbed = await buildStatsEmbed(interaction.guild.id);
      return interaction.update({
        embeds: [statsEmbed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('_hp_back').setLabel('Retour au panneau').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('_hp_stats_clear').setLabel('Vider l\'historique').setEmoji('🧹').setStyle(ButtonStyle.Danger),
        )],
      });
    }

    // ── Toggles rapides (suppression message / DM) ───────────────────────
    if (interaction.customId === '_hp_delete_toggle') {
      const cfg = await getOrCreate(interaction.guild.id);
      cfg.deleteMessage = !cfg.deleteMessage;
      await cfg.save();
      return refresh();
    }
    if (interaction.customId === '_hp_dm_toggle') {
      const cfg = await getOrCreate(interaction.guild.id);
      cfg.dmUser = !cfg.dmUser;
      await cfg.save();
      return refresh();
    }

    // ── Actualiser ───────────────────────────────────────────────────────
    if (interaction.customId === '_hp_refresh') return refresh();
  },

  // ─── Routage persistant : boutons `_hp_` (interactionCreate.js) ──────────
  async handleButton(interaction, client) {
    return this._panelAction(interaction, client);
  },

  // ─── Routage persistant : menus `_hp_` (interactionCreate.js) ────────────
  async handleSelect(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Panneau honeypot' }))) return;
    const id = interaction.customId;
    const cfg = await getOrCreate(interaction.guild.id);

    if (id === '_hp_action') {
      cfg.action = interaction.values[0];
      await cfg.save();
      return interaction.update({ embeds: [await buildPanelEmbed(cfg)], components: buildPanelComponents(cfg) });
    }

    if (id === '_hp_duration') {
      cfg.muteDuration = parseInt(interaction.values[0], 10) || cfg.muteDuration;
      await cfg.save();
      return interaction.update({ embeds: [await buildPanelEmbed(cfg)], components: buildPanelComponents(cfg) });
    }

    if (id === '_hp_channels_add') {
      const merged = Array.from(new Set([...cfg.channelIds, ...interaction.values]));
      cfg.channelIds = merged;
      await cfg.save();
      return interaction.update({ embeds: [await buildPanelEmbed(cfg)], components: buildPanelComponents(cfg) });
    }

    if (id === '_hp_channels_remove') {
      cfg.channelIds = cfg.channelIds.filter(x => !interaction.values.includes(x));
      await cfg.save();
      return interaction.update({ embeds: [buildChannelsView(interaction.guild, cfg)], components: buildChannelsComponents(cfg, interaction.guild) });
    }

    if (id === '_hp_logs') {
      cfg.logChannelId = interaction.values[0];
      await cfg.save();
      return interaction.update({ embeds: [await buildPanelEmbed(cfg)], components: buildPanelComponents(cfg) });
    }
  },

  // ─── Modal « avertissement & bouton » (routage persistant hp_advanced_modal) ─
  async handleAdvancedModal(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);

    cfg.warningMessage = interaction.fields.getTextInputValue('hp_message').slice(0, 1000);
    const trigger = interaction.fields.getTextInputValue('hp_trigger').trim();
    if (trigger) cfg.triggerLabel = trigger.slice(0, 80);

    await cfg.save();

    return interaction.reply({
      embeds: [successEmbed('Avertissement mis à jour',
        `Le nouveau texte et le libellé du bouton (« ${cfg.triggerLabel} ») seront utilisés aux prochaines publications.`)],
      ephemeral: true,
    });
  },
};

// Rangées de la vue de gestion des salons (helper séparé pour lisibilité)
function buildChannelsComponents(cfg, guild) {
  const rows = [];
  if (cfg.channelIds.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('_hp_channels_remove')
        .setPlaceholder('➖ Retirer des salons…')
        .setMinValues(1).setMaxValues(cfg.channelIds.length)
        .addOptions(cfg.channelIds.slice(0, 25).map(id => {
          const ch = guild?.channels?.cache.get(id);
          return { label: ch ? `#${ch.name}` : id, value: id };
        })),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('_hp_autocreate').setLabel('Créer un salon').setEmoji('🪄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('_hp_publish').setLabel('Publier l\'avertissement').setEmoji('📌').setStyle(ButtonStyle.Secondary),
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('_hp_back').setLabel('Retour au panneau').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}
