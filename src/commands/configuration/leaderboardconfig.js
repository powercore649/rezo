// commands/leaderboardconfig.js — Configuration du leaderboard auto-posté (type par défaut + cron)
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const LeaderboardConfig = require('../../models/LeaderboardConfig');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');

async function getOrCreate(guildId) {
  let cfg = await LeaderboardConfig.findOne({ guildId });
  if (!cfg) cfg = await LeaderboardConfig.create({ guildId });
  return cfg;
}

const TYPE_LABELS = {
  coins:  '💰 Richesse (coins)',
  bumps:  '🚀 Bumps totaux',
  weekly: '📅 Bumps cette semaine',
  xp:     '🏆 XP',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboardconfig')
    .setDescription('⚙️ Configurer le classement automatique du serveur')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('statut').setDescription('Voir la configuration actuelle'))
    .addSubcommand(s => s.setName('type').setDescription('Définir le type de classement par défaut')
      .addStringOption(o => o.setName('valeur').setDescription('Type de classement').setRequired(true).addChoices(
        { name: '💰 Richesse (coins)',    value: 'coins'  },
        { name: '🚀 Bumps totaux',        value: 'bumps'  },
        { name: '📅 Bumps cette semaine', value: 'weekly' },
        { name: '🏆 XP',                  value: 'xp'     },
      )))
    .addSubcommand(s => s.setName('auto-post').setDescription('Activer/désactiver la publication automatique périodique')
      .addBooleanOption(o => o.setName('activer').setDescription('Activer (true) ou désactiver (false)').setRequired(true))
      .addChannelOption(o => o.setName('salon').setDescription('Salon où publier le classement'))
      .addStringOption(o => o.setName('cron').setDescription('Expression cron (ex: "0 12 * * *" = tous les jours à 12h)'))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const cfg = await getOrCreate(interaction.guildId);

    if (sub === 'statut') {
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('🏆 Leaderboard — Configuration')
        .addFields(
          { name: '📊 Type par défaut', value: TYPE_LABELS[cfg.type] || cfg.type, inline: true },
          { name: '📤 Publication auto', value: cfg.cronEnabled ? '🟢 Activée' : '🔴 Désactivée', inline: true },
          { name: '📺 Salon', value: cfg.channelId ? `<#${cfg.channelId}>` : '*Non défini*', inline: true },
          { name: '⏱️ Planification', value: `\`${cfg.schedule}\``, inline: true },
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'type') {
      cfg.type = interaction.options.getString('valeur');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Type mis à jour', `Type de classement par défaut : **${TYPE_LABELS[cfg.type]}**`)], ephemeral: true });
    }

    if (sub === 'auto-post') {
      const activer = interaction.options.getBoolean('activer');
      const salon   = interaction.options.getChannel('salon');
      const cronExpr = interaction.options.getString('cron');

      if (activer && !salon && !cfg.channelId) {
        return interaction.reply({ embeds: [errorEmbed('Salon manquant', 'Spécifiez un salon pour activer la publication automatique.')], ephemeral: true });
      }

      cfg.cronEnabled = activer;
      if (salon) cfg.channelId = salon.id;
      if (cronExpr) {
        const cron = require('node-cron');
        if (!cron.validate(cronExpr)) {
          return interaction.reply({ embeds: [errorEmbed('Expression invalide', 'L\'expression cron fournie n\'est pas valide.')], ephemeral: true });
        }
        cfg.schedule = cronExpr;
      }
      await cfg.save();

      return interaction.reply({ embeds: [successEmbed('Publication automatique mise à jour',
        `Statut : **${cfg.cronEnabled ? 'Activée' : 'Désactivée'}**\nSalon : ${cfg.channelId ? `<#${cfg.channelId}>` : '*Non défini*'}\nPlanification : \`${cfg.schedule}\``)], ephemeral: true });
    }
  },
};
