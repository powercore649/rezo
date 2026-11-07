// commands/autothread.js  —  Auto-thread avancé
const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType,
} = require('discord.js');
const AutoThread = require('../../models/AutoThread');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');

const ARCHIVE_CHOICES = [
  { name: '1 heure',  value: 60 },
  { name: '24 heures', value: 1440 },
  { name: '3 jours',  value: 4320 },
  { name: '7 jours',  value: 10080 },
];

async function getOrCreate(guildId) {
  let cfg = await AutoThread.findOne({ guildId });
  if (!cfg) cfg = await AutoThread.create({ guildId });
  return cfg;
}

function buildStatusEmbed(cfg) {
  const on = '🟢 Activé', off = '🔴 Désactivé';
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🧵 Auto-Thread — Configuration')
    .addFields(
      { name: '📢 Statut', value: cfg.enabled ? on : off, inline: true },
      { name: '⏱️ Archivage auto', value: `${cfg.autoArchiveDuration} min`, inline: true },
      { name: '🐌 Slowmode', value: `${cfg.slowmodeSeconds}s`, inline: true },
      { name: '👤 1er message seulement', value: cfg.onlyFirstMessagePerUser ? 'Oui' : 'Non', inline: true },
      { name: '🛡️ Rôle restreint', value: cfg.restrictRoleId ? `<@&${cfg.restrictRoleId}>` : '*Aucun*', inline: true },
      { name: '📝 Modèle de nom', value: `\`${cfg.threadNameTemplate}\``, inline: false },
      { name: '✅ Salons inclus', value: cfg.includeChannels.length ? cfg.includeChannels.map(c => `<#${c}>`).join(', ') : '*Tous les salons*', inline: false },
      { name: '🚫 Salons exclus', value: cfg.excludeChannels.length ? cfg.excludeChannels.map(c => `<#${c}>`).join(', ') : '*Aucun*', inline: false },
    )
    .setTimestamp();
}

function buildPanelComponents(cfg) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('autothread_panel_action')
        .setPlaceholder('⚙️ Configurer...')
        .addOptions([
          { label: cfg.enabled ? '🔴 Désactiver' : '🟢 Activer', value: 'toggle' },
          { label: '✅ Ajouter salon inclus', value: 'add_include' },
          { label: '🚫 Ajouter salon exclu', value: 'add_exclude' },
          { label: '🛡️ Définir rôle restreint', value: 'set_role' },
          { label: '👤 Activer/Désactiver 1er message', value: 'toggle_first' },
        ]),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('autothread_panel_close').setLabel('✖ Fermer').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('autothread')
    .setDescription('🧵 Gestion de l\'auto-thread avancé')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand(s => s.setName('status').setDescription('Voir la configuration actuelle'))
    .addSubcommand(s => s.setName('toggle').setDescription('Activer / désactiver l\'auto-thread')
      .addBooleanOption(o => o.setName('activer').setDescription('Activer ?').setRequired(true)))
    .addSubcommand(s => s.setName('include-ajouter').setDescription('Ajouter un salon à la liste des salons inclus')
      .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true)))
    .addSubcommand(s => s.setName('include-retirer').setDescription('Retirer un salon de la liste des salons inclus')
      .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true)))
    .addSubcommand(s => s.setName('exclude-ajouter').setDescription('Ajouter un salon à la liste des salons exclus')
      .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true)))
    .addSubcommand(s => s.setName('exclude-retirer').setDescription('Retirer un salon de la liste des salons exclus')
      .addChannelOption(o => o.setName('salon').setDescription('Salon').setRequired(true)))
    .addSubcommand(s => s.setName('nom-modele').setDescription('Définir le modèle de nom de thread (utilisez {username})')
      .addStringOption(o => o.setName('modele').setDescription('Modèle, ex: Discussion de {username}').setRequired(true)))
    .addSubcommand(s => s.setName('archivage').setDescription('Définir la durée d\'archivage automatique')
      .addIntegerOption(o => o.setName('duree').setDescription('Durée').setRequired(true).addChoices(...ARCHIVE_CHOICES)))
    .addSubcommand(s => s.setName('slowmode').setDescription('Définir le slowmode des threads créés')
      .addIntegerOption(o => o.setName('secondes').setDescription('Secondes (0 = désactivé)').setMinValue(0).setMaxValue(21600).setRequired(true)))
    .addSubcommand(s => s.setName('premier-message').setDescription('Activer/désactiver : un thread seulement pour le 1er message du jour par utilisateur')
      .addBooleanOption(o => o.setName('activer').setDescription('Activer ?').setRequired(true)))
    .addSubcommand(s => s.setName('role-restreint').setDescription('Définir le rôle requis pour déclencher l\'auto-thread')
      .addRoleOption(o => o.setName('role').setDescription('Rôle requis (laisser vide pour effacer)')))
    .addSubcommand(s => s.setName('panel').setDescription('Afficher le panel interactif de configuration')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const cfg = await getOrCreate(interaction.guildId);

    if (sub === 'status') {
      return interaction.reply({ embeds: [buildStatusEmbed(cfg)], ephemeral: true });
    }

    if (sub === 'toggle') {
      cfg.enabled = interaction.options.getBoolean('activer');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Auto-thread mis à jour', `Statut : **${cfg.enabled ? 'Activé' : 'Désactivé'}**`)], ephemeral: true });
    }

    if (sub === 'include-ajouter') {
      const ch = interaction.options.getChannel('salon');
      if (!cfg.includeChannels.includes(ch.id)) cfg.includeChannels.push(ch.id);
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Salon ajouté', `<#${ch.id}> ajouté aux salons inclus.`)], ephemeral: true });
    }

    if (sub === 'include-retirer') {
      const ch = interaction.options.getChannel('salon');
      cfg.includeChannels = cfg.includeChannels.filter(c => c !== ch.id);
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Salon retiré', `<#${ch.id}> retiré des salons inclus.`)], ephemeral: true });
    }

    if (sub === 'exclude-ajouter') {
      const ch = interaction.options.getChannel('salon');
      if (!cfg.excludeChannels.includes(ch.id)) cfg.excludeChannels.push(ch.id);
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Salon ajouté', `<#${ch.id}> ajouté aux salons exclus.`)], ephemeral: true });
    }

    if (sub === 'exclude-retirer') {
      const ch = interaction.options.getChannel('salon');
      cfg.excludeChannels = cfg.excludeChannels.filter(c => c !== ch.id);
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Salon retiré', `<#${ch.id}> retiré des salons exclus.`)], ephemeral: true });
    }

    if (sub === 'nom-modele') {
      cfg.threadNameTemplate = interaction.options.getString('modele');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Modèle mis à jour', `Nouveau modèle : \`${cfg.threadNameTemplate}\``)], ephemeral: true });
    }

    if (sub === 'archivage') {
      cfg.autoArchiveDuration = interaction.options.getInteger('duree');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Archivage mis à jour', `Durée : **${cfg.autoArchiveDuration} min**`)], ephemeral: true });
    }

    if (sub === 'slowmode') {
      cfg.slowmodeSeconds = interaction.options.getInteger('secondes');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Slowmode mis à jour', `${cfg.slowmodeSeconds}s`)], ephemeral: true });
    }

    if (sub === 'premier-message') {
      cfg.onlyFirstMessagePerUser = interaction.options.getBoolean('activer');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Mis à jour', `Restriction au 1er message par jour : **${cfg.onlyFirstMessagePerUser ? 'Activée' : 'Désactivée'}**`)], ephemeral: true });
    }

    if (sub === 'role-restreint') {
      const role = interaction.options.getRole('role');
      cfg.restrictRoleId = role ? role.id : null;
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Mis à jour', role ? `Rôle requis : <@&${role.id}>` : 'Restriction de rôle effacée.')], ephemeral: true });
    }

    if (sub === 'panel') {
      const reply = await interaction.reply({
        embeds: [buildStatusEmbed(cfg)],
        components: buildPanelComponents(cfg),
        ephemeral: true,
        fetchReply: true,
      });

      const col = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 600000 });

      col.on('collect', async i => {
        let current = await getOrCreate(interaction.guildId);

        if (i.customId === 'autothread_panel_close') {
          return i.update({ components: [] });
        }

        if (i.customId === 'autothread_panel_action') {
          const action = i.values[0];

          if (action === 'toggle') {
            current.enabled = !current.enabled;
            await current.save();
            return i.update({ embeds: [buildStatusEmbed(current)], components: buildPanelComponents(current) });
          }

          if (action === 'toggle_first') {
            current.onlyFirstMessagePerUser = !current.onlyFirstMessagePerUser;
            await current.save();
            return i.update({ embeds: [buildStatusEmbed(current)], components: buildPanelComponents(current) });
          }

          if (action === 'add_include') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('✅ Sélectionner un salon à inclure')],
              components: [
                new ActionRowBuilder().addComponents(
                  new ChannelSelectMenuBuilder().setCustomId('autothread_select_include').setPlaceholder('Salon...').addChannelTypes(ChannelType.GuildText),
                ),
                new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('autothread_panel_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary)),
              ],
            });
          }

          if (action === 'add_exclude') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🚫 Sélectionner un salon à exclure')],
              components: [
                new ActionRowBuilder().addComponents(
                  new ChannelSelectMenuBuilder().setCustomId('autothread_select_exclude').setPlaceholder('Salon...').addChannelTypes(ChannelType.GuildText),
                ),
                new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('autothread_panel_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary)),
              ],
            });
          }

          if (action === 'set_role') {
            return i.update({
              embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🛡️ Sélectionner le rôle restreint')],
              components: [
                new ActionRowBuilder().addComponents(
                  new RoleSelectMenuBuilder().setCustomId('autothread_select_role').setPlaceholder('Rôle...'),
                ),
                new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('autothread_panel_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary)),
              ],
            });
          }
        }

        if (i.customId === 'autothread_panel_back') {
          current = await getOrCreate(interaction.guildId);
          return i.update({ embeds: [buildStatusEmbed(current)], components: buildPanelComponents(current) });
        }

        if (i.customId === 'autothread_select_include') {
          const chId = i.values[0];
          if (!current.includeChannels.includes(chId)) current.includeChannels.push(chId);
          await current.save();
          current = await getOrCreate(interaction.guildId);
          return i.update({ embeds: [buildStatusEmbed(current)], components: buildPanelComponents(current) });
        }

        if (i.customId === 'autothread_select_exclude') {
          const chId = i.values[0];
          if (!current.excludeChannels.includes(chId)) current.excludeChannels.push(chId);
          await current.save();
          current = await getOrCreate(interaction.guildId);
          return i.update({ embeds: [buildStatusEmbed(current)], components: buildPanelComponents(current) });
        }

        if (i.customId === 'autothread_select_role') {
          current.restrictRoleId = i.values[0];
          await current.save();
          current = await getOrCreate(interaction.guildId);
          return i.update({ embeds: [buildStatusEmbed(current)], components: buildPanelComponents(current) });
        }
      });

      col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
    }
  },
};
