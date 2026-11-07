const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Reminder = require('../../models/Reminder');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

function parseDuration(str){
  const m=str.match(/^(\d+)(s|m|h|d)$/i); if(!m) return null;
  const map={s:1000,m:60000,h:3600000,d:86400000};
  return parseInt(m[1])*map[m[2].toLowerCase()];
}

module.exports = {
  data: new SlashCommandBuilder().setName('reminder').setDescription('⏰ Créer un rappel personnel')
    .addStringOption(o=>o.setName('durée').setDescription('Ex: 10m, 2h, 1d').setRequired(true))
    .addStringOption(o=>o.setName('message').setDescription('Message du rappel').setRequired(true)),

  async execute(interaction, client) {
    const durStr  = interaction.options.getString('durée');
    const message = interaction.options.getString('message');
    const ms      = parseDuration(durStr);

    if(!ms || ms < 10000) return interaction.reply({ embeds:[errorEmbed('Durée invalide','Minimum 10 secondes. Formats : 10m, 2h, 1d')], ephemeral:true });
    if(ms > 30*24*3600000) return interaction.reply({ embeds:[errorEmbed('Trop long','Maximum 30 jours.')], ephemeral:true });

    const remindAt = new Date(Date.now()+ms);
    const rem = await Reminder.create({ userId:interaction.user.id, guildId:interaction.guildId, channelId:interaction.channelId, message, remindAt });

    await interaction.reply({ embeds:[successEmbed('Rappel créé !',
      `Je te rappellerai **${message}** <t:${Math.floor(remindAt/1000)}:R>`)], ephemeral:true });

    // Programmer le rappel
    setTimeout(async () => {
      try {
        const user = await client.users.fetch(interaction.user.id);
        await user.send({ embeds:[new EmbedBuilder().setColor(COLORS.warning)
          .setTitle('⏰ Rappel !')
          .setDescription(`**${message}**\n\n*Créé <t:${Math.floor((Date.now()-ms)/1000)}:R>*`)
          .setTimestamp()] });
      } catch {
        // Essayer d'envoyer dans le salon si DM échoue
        const ch = client.channels.cache.get(interaction.channelId);
        if(ch) ch.send({ content:`<@${interaction.user.id}> ⏰ Rappel : **${message}**` }).catch(()=>{});
      }
      await Reminder.findByIdAndUpdate(rem._id, { done:true });
    }, ms);
  },
};
