// commands/utilitaires/poll.js — Créer un sondage avancé
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { COLORS } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('📊 Crée un sondage')
    .addStringOption(option =>
      option
        .setName('question')
        .setDescription('La question du sondage')
        .setRequired(true)
        .setMaxLength(200)
    )
    .addStringOption(option =>
      option
        .setName('option1')
        .setDescription('Première option')
        .setRequired(true)
        .setMaxLength(80)
    )
    .addStringOption(option =>
      option
        .setName('option2')
        .setDescription('Deuxième option')
        .setRequired(true)
        .setMaxLength(80)
    )
    .addStringOption(option =>
      option
        .setName('option3')
        .setDescription('Troisième option (optionnel)')
        .setMaxLength(80)
    )
    .addStringOption(option =>
      option
        .setName('option4')
        .setDescription('Quatrième option (optionnel)')
        .setMaxLength(80)
    )
    .addIntegerOption(option =>
      option
        .setName('duree')
        .setDescription('Durée du sondage en minutes (optionnel)')
        .setMinValue(1)
        .setMaxValue(10080) // 1 semaine
    ),

  async execute(interaction) {
    const question = interaction.options.getString('question');
    const option1 = interaction.options.getString('option1');
    const option2 = interaction.options.getString('option2');
    const option3 = interaction.options.getString('option3');
    const option4 = interaction.options.getString('option4');
    const duration = interaction.options.getInteger('duree');

    // Construire la liste d'options
    const options = [option1, option2];
    if (option3) options.push(option3);
    if (option4) options.push(option4);

    // Emojis pour les options
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

    // Tracker des votes
    const votes = {};
    options.forEach((_, index) => {
      votes[index] = new Set();
    });

    // Créer l'embed
    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle('📊 ' + question)
      .setDescription(
        options.map((opt, i) => `${emojis[i]} **${opt}** - 0 vote(s) (0%)`).join('\n\n') +
        (duration ? `\n\n⏰ Durée: ${duration} minute${duration > 1 ? 's' : ''}` : '')
      )
      .setFooter({ text: `Sondage créé par ${interaction.user.username}` })
      .setTimestamp();

    // Envoyer le message
    const message = await interaction.reply({ embeds: [embed], fetchReply: true });

    // Ajouter les réactions
    for (let i = 0; i < options.length; i++) {
      await message.react(emojis[i]);
    }

    // Collecter les réactions
    const collector = message.createReactionCollector({ 
      filter: (reaction, user) => !user.bot && emojis.includes(reaction.emoji.name),
      time: duration ? duration * 60 * 1000 : undefined
    });

    collector.on('collect', async (reaction, user) => {
      const emojiIndex = emojis.indexOf(reaction.emoji.name);
      
      if (emojiIndex === -1) return;

      // Retirer l'utilisateur des autres options
      Object.keys(votes).forEach(key => {
        if (parseInt(key) !== emojiIndex) {
          votes[key].delete(user.id);
        }
      });

      // Ajouter le vote
      votes[emojiIndex].add(user.id);

      // Calculer le total de votes
      const totalVotes = Object.values(votes).reduce((sum, set) => sum + set.size, 0);

      // Mettre à jour l'embed
      const updatedEmbed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('📊 ' + question)
        .setDescription(
          options.map((opt, i) => {
            const voteCount = votes[i].size;
            const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
            const barLength = Math.round(percentage / 10);
            const bar = '█'.repeat(barLength) + '░'.repeat(10 - barLength);
            return `${emojis[i]} **${opt}**\n${bar} ${voteCount} vote${voteCount > 1 ? 's' : ''} (${percentage}%)`;
          }).join('\n\n') +
          (duration ? `\n\n⏰ Temps restant: ${Math.ceil((duration * 60 * 1000 - (Date.now() - message.createdTimestamp)) / 60000)} minute(s)` : '')
        )
        .setFooter({ text: `Sondage créé par ${interaction.user.username} • ${totalVotes} vote${totalVotes > 1 ? 's' : ''} total` })
        .setTimestamp();

      await message.edit({ embeds: [updatedEmbed] }).catch(() => {});
    });

    collector.on('end', async () => {
      if (!duration) return;

      // Calculer les résultats finaux
      const totalVotes = Object.values(votes).reduce((sum, set) => sum + set.size, 0);
      
      let winnerIndex = 0;
      let maxVotes = 0;
      Object.entries(votes).forEach(([index, set]) => {
        if (set.size > maxVotes) {
          maxVotes = set.size;
          winnerIndex = parseInt(index);
        }
      });

      const finalEmbed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('📊 ' + question + ' - TERMINÉ')
        .setDescription(
          options.map((opt, i) => {
            const voteCount = votes[i].size;
            const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
            const barLength = Math.round(percentage / 10);
            const bar = '█'.repeat(barLength) + '░'.repeat(10 - barLength);
            const isWinner = i === winnerIndex && totalVotes > 0;
            return `${emojis[i]} **${opt}** ${isWinner ? '🏆' : ''}\n${bar} ${voteCount} vote${voteCount > 1 ? 's' : ''} (${percentage}%)`;
          }).join('\n\n') +
          `\n\n${totalVotes > 0 ? `🏆 **Gagnant:** ${options[winnerIndex]}` : '❌ Aucun vote'}`
        )
        .setFooter({ text: `Sondage terminé • ${totalVotes} vote${totalVotes > 1 ? 's' : ''} total` })
        .setTimestamp();

      await message.edit({ embeds: [finalEmbed] }).catch(() => {});
    });
  }
};
