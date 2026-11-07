// commands/economie/give.js — Cadeau de pièces, moteur commun avec /balance.
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { COLORS, errorEmbed } = require('../../utils/embeds');
const { getAppEmoji } = require('../../utils/emojiSync');
const economy = require('../../utils/economy');

const ERROR_TITLES = {
  insufficient: 'Solde insuffisant',
  amount: 'Montant invalide',
  self: 'Impossible',
  bot: 'Impossible',
  target: 'Destinataire introuvable',
  db: 'Erreur de base',
  credit_failed: 'Paiement annulé',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('give')
    .setDescription('💝 Donner des pièces à quelqu\'un')
    .addUserOption(o => o.setName('user').setDescription('Utilisateur').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Montant').setMinValue(1).setMaxValue(economy.MAX_TRANSFER).setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison du cadeau (optionnel)').setMaxLength(economy.MAX_REASON)),

  async execute(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const reason = interaction.options.getString('raison') || '';

    const result = await economy.transferCoins({
      guildId: interaction.guildId,
      fromId: interaction.user.id,
      toId: target.id,
      amount,
      reason,
      targetIsBot: target.bot,
    });

    if (!result.ok) {
      return interaction.editReply({
        embeds: [errorEmbed(ERROR_TITLES[result.code] || 'Transfert impossible', result.error)],
      });
    }

    const coin = getAppEmoji(interaction.client, 'bumpify_coin') || '💰';
    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle('💝 Transfert effectué !')
      .addFields(
        { name: '👤 De', value: `<@${interaction.user.id}>`, inline: true },
        { name: '➜', value: `<@${target.id}>`, inline: true },
        { name: `${coin} Montant`, value: `**${economy.formatCoins(result.amount)}**`, inline: true },
        { name: '💳 Solde restant', value: `**${economy.formatCoins(result.sender.coins)}**`, inline: true },
      )
      .setTimestamp();

    if (result.reason) embed.addFields({ name: '📝 Raison', value: result.reason });

    interaction.editReply({ embeds: [embed] });
  },
};
