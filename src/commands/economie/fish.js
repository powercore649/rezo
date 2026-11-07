const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Fishing = require('../../models/Fishing');
const Balance = require('../../models/Balance');
const { COLORS, errorEmbed } = require('../../utils/embeds');

const FISH = [
  { name: '🐟 Sardine',     value: [5,15],   weight: 30 },
  { name: '🐠 Poisson exotique', value: [15,30], weight: 22 },
  { name: '🦐 Crevette',    value: [3,10],   weight: 25 },
  { name: '🦀 Crabe',       value: [20,40],  weight: 15 },
  { name: '🐡 Fugu',        value: [40,70],  weight: 8 },
  { name: '🦈 Requin',      value: [100,200],weight: 3 },
  { name: '🐉 Dragon des mers', value: [300,600], weight: 1 },
  { name: '👢 Vieille botte', value: [0,2],  weight: 20 },
];
const RODS = { basic: { name: 'Canne basique', mult: 1, cooldown: 30*1000 }, pro: { name: 'Canne pro', mult: 1.3, cooldown: 20*1000 }, golden: { name: 'Canne dorée', mult: 1.8, cooldown: 12*1000 } };

function rollFish() {
  const total = FISH.reduce((a, f) => a + f.weight, 0);
  let r = Math.random() * total;
  for (const f of FISH) { if (r < f.weight) return f; r -= f.weight; }
  return FISH[0];
}

module.exports = {
  data: new SlashCommandBuilder().setName('fish').setDescription('🎣 Aller pêcher pour gagner des coins'),
  async execute(interaction) {
    let profile = await Fishing.findOne({ userId: interaction.user.id, guildId: interaction.guildId });
    if (!profile) profile = await Fishing.create({ userId: interaction.user.id, guildId: interaction.guildId });

    const rod = RODS[profile.rod] || RODS.basic;
    if (profile.lastFish && Date.now() - new Date(profile.lastFish).getTime() < rod.cooldown) {
      const next = Math.floor((new Date(profile.lastFish).getTime() + rod.cooldown) / 1000);
      return interaction.reply({ embeds: [errorEmbed('Ta ligne est encore à l\'eau', `Réessaie <t:${next}:R>`)], ephemeral: true });
    }

    const fish  = rollFish();
    const value = Math.floor((Math.random() * (fish.value[1] - fish.value[0] + 1) + fish.value[0]) * rod.mult);

    profile.lastFish   = new Date();
    profile.totalCatch += 1;
    profile.totalValue += value;
    if (value > profile.bestValue) { profile.bestValue = value; profile.bestCatch = fish.name; }
    await profile.save();

    if (value > 0) await Balance.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guildId }, { $inc: { coins: value } }, { upsert: true });

    const isRare = fish.weight <= 3;
    return interaction.reply({ embeds: [new EmbedBuilder()
      .setColor(isRare ? 0xFFD700 : COLORS.success)
      .setTitle(isRare ? '🌟 PRISE RARE !' : '🎣 Tu as pêché !')
      .setDescription(`${fish.name}\nValeur : **${value} coins** 🪙\n*Canne utilisée : ${rod.name}*`)
      .setFooter({ text: `Total : ${profile.totalCatch} prises • Record : ${profile.bestCatch || 'Aucun'}` })] });
  },
};
