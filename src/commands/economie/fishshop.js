const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Fishing = require('../../models/Fishing');
const Balance = require('../../models/Balance');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

const RODS = [
  { id: 'basic',  name: 'Canne basique', price: 0,    mult: '1x',   cooldown: '30s' },
  { id: 'pro',    name: 'Canne pro',     price: 500,  mult: '1.3x', cooldown: '20s' },
  { id: 'golden', name: 'Canne dorée',   price: 2000, mult: '1.8x', cooldown: '12s' },
];

module.exports = {
  data: new SlashCommandBuilder().setName('fishshop').setDescription('🛍️ Boutique de cannes à pêche')
    .addSubcommand(s => s.setName('voir').setDescription('Voir les cannes disponibles'))
    .addSubcommand(s => s.setName('acheter').setDescription('Acheter une canne')
      .addStringOption(o => o.setName('canne').setDescription('Canne à acheter').setRequired(true)
        .addChoices({ name: 'Canne pro (500 🪙)', value: 'pro' }, { name: 'Canne dorée (2000 🪙)', value: 'golden' }))),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'voir') {
      const profile = await Fishing.findOne({ userId: interaction.user.id, guildId: interaction.guildId });
      const owned = profile?.rod || 'basic';
      const embed = new EmbedBuilder().setColor(COLORS.primary).setTitle('🛍️ Boutique de Cannes');
      RODS.forEach(r => embed.addFields({ name: `${r.name} ${owned === r.id ? '✅ Possédée' : ''}`, value: `💰 ${r.price} coins ・ Multiplicateur : ${r.mult} ・ Cooldown : ${r.cooldown}` }));
      return interaction.reply({ embeds: [embed] });
    }
    if (sub === 'acheter') {
      const rodId = interaction.options.getString('canne');
      const rod   = RODS.find(r => r.id === rodId);
      const bal   = await Balance.findOne({ userId: interaction.user.id, guildId: interaction.guildId });
      if (!bal || bal.coins < rod.price) return interaction.reply({ embeds: [errorEmbed('Solde insuffisant', `Il te manque ${rod.price - (bal?.coins || 0)} coins.`)], ephemeral: true });

      await Balance.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guildId }, { $inc: { coins: -rod.price } });
      await Fishing.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guildId }, { rod: rodId }, { upsert: true });
      return interaction.reply({ embeds: [successEmbed('Canne achetée !', `Tu pêches maintenant avec la **${rod.name}** !`)] });
    }
  },
};
