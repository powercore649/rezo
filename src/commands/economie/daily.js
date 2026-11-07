const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Balance = require('../../models/Balance');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');
const { getAppEmoji } = require('../../utils/emojiSync');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('💰 Réclamez vos pièces quotidiennes'),

  async execute(interaction, client) {
    await interaction.deferReply();
    const eCoin = getAppEmoji(client, 'bumpify_coin') || '💰';
    const user = interaction.user;
    const DAILY_AMOUNT = 500;
    const COOLDOWN = 24 * 60 * 60 * 1000; // 24h

    let balance = await Balance.findOne({ userId: user.id, guildId: interaction.guildId });
    if (!balance) {
      balance = await Balance.create({ userId: user.id, guildId: interaction.guildId });
    }

    const now = Date.now();
    if (balance.lastDaily) {
      const elapsed = now - new Date(balance.lastDaily).getTime();
      if (elapsed < COOLDOWN) {
        const remaining = COOLDOWN - elapsed;
        const hours = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        return interaction.editReply({
          embeds: [errorEmbed('Cooldown', `Revenez dans **${hours}h ${mins}m** pour votre récompense quotidienne!`)],
        });
      }
    }

    balance.coins += DAILY_AMOUNT;
    balance.lastDaily = new Date();
    await balance.save();

    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle(`${eCoin} Récompense quotidienne!`)
      .setDescription(`Vous avez reçu **${DAILY_AMOUNT} 🪙**`)
      .addFields({ name: 'Nouveau solde', value: `${balance.coins} 🪙` })
      .setTimestamp();

    interaction.editReply({ embeds: [embed] });
  },
};
