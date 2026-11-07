// commands/configuration/prefix.js — Préfixe de commandes personnalisé par serveur
// Système hybride REZO : les slash restent la voie principale ; un préfixe
// texte (ex : "b!ping") exécute les mêmes commandes. Config via ce /prefix.
const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} = require('discord.js');
const PrefixConfig = require('../../models/PrefixConfig');
const { successEmbed, errorEmbed, infoEmbed, warningEmbed, COLORS } = require('../../utils/embeds');
const prefixCommands = require('../../utils/prefixCommands');

const DEFAULT_PREFIX = 'b!';

async function getOrCreateConfig(guildId) {
  let cfg = await PrefixConfig.findOne({ guildId });
  if (!cfg) cfg = await PrefixConfig.create({ guildId });
  return cfg;
}

function buildPanelEmbed(cfg, guild) {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('⌨️ Préfixe de commandes — Panneau')
    .setDescription(
      'Système hybride REZO : tes membres préfèrent les vieilles commandes texte ? ' +
      'Active un préfixe qui exécute **les mêmes commandes slash**, sans rien reconfigurer.',
    )
    .addFields(
      { name: '⚡ État', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '⌨️ Préfixe', value: `\`${cfg.prefix || DEFAULT_PREFIX}\``, inline: true },
      { name: '💡 Indice', value: cfg.showHint ? 'Affiché' : 'Masqué', inline: true },
      { name: '🚫 Salons ignorés', value: cfg.ignoredChannelIds?.length ? cfg.ignoredChannelIds.map(id => `<#${id}>`).join(', ').slice(0, 100) : 'Aucun', inline: true },
      { name: '📊 Utilisations', value: String(cfg.stats?.used ?? 0), inline: true },
      { name: '🕐 Dernière', value: cfg.stats?.lastUsedAt ? `<t:${Math.floor(new Date(cfg.stats.lastUsedAt).getTime() / 1000)}:R>` : 'Jamais', inline: true },
      {
        name: '🧪 Exemples',
        value: [
          `\`${cfg.prefix}ping\` → identique à \`/ping\``,
          `\`${cfg.prefix}ban @membre raid\` → identique à \`/ban\``,
          `\`${cfg.prefix}help\` → liste des commandes`,
        ].join('\n'),
      },
      {
        name: '📌 Bon à savoir',
        value: [
          '• Toutes les réponses sont envoyées **dans le salon** (jamais en MP).',
          '• Les commandes à **menu déroulant/modal** ou **choix fixes** restent en slash uniquement.',
          '• Commandes owner du bot : slash uniquement.',
          '• Permissions, cooldowns et logs s\'appliquent à l\'identique.',
        ].join('\n'),
      },
    );
}

function buildPanelComponents(cfg) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pfx_toggle').setLabel(cfg.enabled ? 'Désactiver' : 'Activer').setEmoji('⚡')
        .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('pfx_change').setLabel('Changer le préfixe').setEmoji('⌨️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pfx_hint').setLabel('Indice').setEmoji('💡').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pfx_ignored').setLabel('Salons ignorés').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('pfx_test').setLabel('Tester').setEmoji('🧪').setStyle(ButtonStyle.Primary),
    ),
  ];
}

async function sendPanel(interaction, cfg) {
  return interaction.reply({
    embeds: [buildPanelEmbed(cfg, interaction.guild)],
    components: buildPanelComponents(cfg),
    ephemeral: true,
    fetchReply: true,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('prefix')
    .setDescription('⌨️ Préfixe de commandes personnalisé par serveur (système hybride)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('panel').setDescription('Ouvrir le panneau de configuration'))
    .addSubcommand(s => s.setName('help').setDescription('Comment fonctionne le préfixe')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'panel') {
      const cfg = await getOrCreateConfig(interaction.guildId);
      return sendPanel(interaction, cfg);
    }

    if (sub === 'help') {
      return interaction.reply({
        embeds: [infoEmbed('Le préfixe REZO', [
          '**Principe** — un préfixe par serveur (ex : `b!`) qui exécute les **mêmes commandes slash**.',
          '',
          '**Exemple** — `b!ban @raideur spam` fait exactement comme `/ban`.',
          '',
          '**Réponses** — toujours postées dans le salon, même pour les commandes « éphémères » en slash.',
          '**Non disponibles en préfixe** — modals, menus déroulants, options à choix fixes, commandes owner.',
          '',
          'Config : `/prefix panel`',
        ].join('\n'))],
        ephemeral: true,
      });
    }
  },

  async handleButton(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur**.')], ephemeral: true });
    }
    const id = interaction.customId;
    const cfg = await getOrCreateConfig(interaction.guildId);

    if (id === 'pfx_toggle') {
      if (!cfg.enabled && (!cfg.prefix || cfg.prefix.length < 1)) {
        return interaction.reply({ embeds: [warningEmbed('Préfixe requis', 'Définis d\'abord un préfixe (bouton ⌨️).')], ephemeral: true });
      }
      cfg.enabled = !cfg.enabled;
      await cfg.save();
      prefixCommands.invalidate(interaction.guildId);
      await interaction.update({ embeds: [buildPanelEmbed(cfg, interaction.guild)], components: buildPanelComponents(cfg) });
      return;
    }

    if (id === 'pfx_change') {
      const modal = new ModalBuilder().setCustomId('pfxm_change').setTitle('⌨️ Préfixe du serveur');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('pfx_value')
            .setLabel('Préfixe (1 à 5 caractères)')
            .setStyle(TextInputStyle.Short)
            .setValue(cfg.prefix || DEFAULT_PREFIX)
            .setMaxLength(5)
            .setMinLength(1)
            .setRequired(true),
        ),
      );
      return interaction.showModal(modal);
    }

    if (id === 'pfx_hint') {
      cfg.showHint = !cfg.showHint;
      await cfg.save();
      await interaction.update({ embeds: [buildPanelEmbed(cfg, interaction.guild)], components: buildPanelComponents(cfg) });
      return;
    }

    if (id === 'pfx_ignored') {
      const options = interaction.guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText)
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .first(25)
        .map(c => ({ label: c.name.slice(0, 100), value: c.id }));
      return interaction.reply({
        embeds: [infoEmbed('Salons ignorés', 'Le préfixe ne répondra pas dans ces salons (ex : confession, compteur).')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('pfxs_ignored')
            .setMinValues(0)
            .setMaxValues(Math.max(1, options.length))
            .addOptions(options.length ? options : [{ label: 'Aucun', value: 'none' }]),
        )],
        ephemeral: true,
      });
    }

    if (id === 'pfx_test') {
      await interaction.deferReply({ ephemeral: true });
      const { parseArgs, resolveCommand } = require('../../utils/prefixCommands');
      const tokens = parseArgs('ping');
      const match = resolveCommand(interaction.client, tokens);
      if (!match) {
        return interaction.editReply({ embeds: [errorEmbed('Impossible', 'La commande ping n\'est pas chargée ?!')] });
      }
      return interaction.editReply({
        embeds: [successEmbed('Préfixe opérationnel', `Le moteur trouve bien \`/${match.json.name}\`. Essaye \`${cfg.prefix}ping\` dans un salon !`)],
      });
    }
  },

  async handleSelect(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur**.')], ephemeral: true });
    }
    if (interaction.customId === 'pfxs_ignored') {
      const cfg = await getOrCreateConfig(interaction.guildId);
      const values = interaction.values.filter(v => v !== 'none');
      cfg.ignoredChannelIds = values;
      await cfg.save();
      prefixCommands.invalidate(interaction.guildId);
      return interaction.update({ embeds: [successEmbed('Salons ignorés mis à jour', values.length ? values.map(v => `<#${v}>`).join(', ') : 'Aucun salon ignoré.')], components: [] });
    }
  },

  async handleModal(interaction) {
    if (interaction.customId === 'pfxm_change') {
      const raw = interaction.fields.getTextInputValue('pfx_value').trim();
      if (!raw || raw.length < 1 || raw.length > 5 || /\s/.test(raw)) {
        return interaction.reply({ embeds: [errorEmbed('Préfixe invalide', 'Entre 1 et 5 caractères, sans espace.')], ephemeral: true });
      }
      const cfg = await getOrCreateConfig(interaction.guildId);
      cfg.prefix = raw;
      await cfg.save();
      prefixCommands.invalidate(interaction.guildId);
      return interaction.reply({ embeds: [successEmbed('Préfixe enregistré', `Nouveau préfixe : \`${raw}\``)], ephemeral: true });
    }
  },
};
