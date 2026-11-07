const { SlashCommandBuilder } = require('discord.js');
const Balance  = require('../../models/Balance');
const Cooldown = require('../../models/Cooldowns');
const { successEmbed, errorEmbed } = require('../../utils/embeds');

const JOBS = [
  { name: 'Développeur', min: 80,  max: 180, msg: 'as corrigé 3 bugs critiques' },
  { name: 'Livreur',     min: 40,  max: 100, msg: 'as livré 12 colis' },
  { name: 'Streamer',    min: 20,  max: 220, msg: 'as fait un live viral' },
  { name: 'Chef',        min: 60,  max: 140, msg: 'as cuisiné pour un mariage' },
  { name: 'Musicien',    min: 50,  max: 160, msg: 'as joué dans un bar' },
  { name: 'Mineur',      min: 70,  max: 130, msg: 'as extrait du minerai rare' },
];
const COOLDOWN_MS = 60 * 60 * 1000; // 1h

module.exports = {
  data: new SlashCommandBuilder().setName('work').setDescription('💼 Travailler pour gagner des coins (cooldown 1h)'),
  async execute(interaction) {
    const cd = await Cooldown.findOne({ userId: interaction.user.id, guildId: interaction.guildId, type: 'work' });
    if (cd?.lastUse && Date.now() - new Date(cd.lastUse).getTime() < COOLDOWN_MS) {
      const next = Math.floor((new Date(cd.lastUse).getTime() + COOLDOWN_MS) / 1000);
      return interaction.reply({ embeds: [errorEmbed('Cooldown actif', `Tu pourras retravailler <t:${next}:R>`)], ephemeral: true });
    }

    const job = JOBS[Math.floor(Math.random() * JOBS.length)];
    const gain = Math.floor(Math.random() * (job.max - job.min + 1)) + job.min;

    await Balance.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guildId }, { $inc: { coins: gain } }, { upsert: true });
    await Cooldown.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guildId, type: 'work' }, { lastUse: new Date() }, { upsert: true });

    return interaction.reply({ embeds: [successEmbed(`💼 ${job.name}`, `Tu ${job.msg} et gagné **${gain} coins** 🪙 !`)] });
  },
};
