// commands/owner/blacklist.js — [Propriétaire uniquement] Blacklist globale
// de serveurs. Un serveur blacklisté : aucune commande/fonctionnalité du bot
// ne répond, et le bot le quitte automatiquement. L'ID est blacklistable même
// si le bot n'est pas (ou plus) sur le serveur.
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const blacklist = require('../../utils/blacklist');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

function getOwnerIds() {
  return (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}
function isOwner(userId) {
  return getOwnerIds().includes(userId);
}

async function buildGuildLine(client, guildId) {
  const g = client.guilds.cache.get(guildId)
    || await client.guilds.fetch(guildId).catch(() => null);
  return g ? `${g.name} — \`${guildId}\`` : `\`${guildId}\` *(bot absent du serveur)*`;
}

module.exports = {
  isOwner,

  data: new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('⛔ [Propriétaire uniquement] Blacklist globale des serveurs')
    .addSubcommand(s => s
      .setName('serveur')
      .setDescription('Blacklister un serveur (fonctionne même si le bot n\'y est pas)')
      .addStringOption(o => o.setName('serveur_id').setDescription('ID du serveur à blacklister').setRequired(true).setMinLength(15).setMaxLength(25))
      .addStringOption(o => o.setName('raison').setDescription('Motif de la blacklist').setMaxLength(500)))
    .addSubcommand(s => s
      .setName('retirer')
      .setDescription('Retirer un serveur de la blacklist')
      .addStringOption(o => o.setName('serveur_id').setDescription('ID du serveur à déblacklister').setRequired(true).setMinLength(15).setMaxLength(25)))
    .addSubcommand(s => s.setName('liste').setDescription('Voir tous les serveurs blacklistés'))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('Voir si un serveur est blacklisté')
      .addStringOption(o => o.setName('serveur_id').setDescription('ID du serveur').setRequired(true).setMinLength(15).setMaxLength(25))),

  async execute(interaction, client) {
    if (!isOwner(interaction.user.id)) {
      return interaction.reply({ embeds: [errorEmbed('Accès refusé', 'Cette commande est réservée au(x) propriétaire(s) du bot.')], ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'serveur') {
      const guildId = interaction.options.getString('serveur_id').trim();
      const raison  = interaction.options.getString('raison') || 'Aucune raison fournie';

      if (guildId === interaction.guildId) {
        return interaction.reply({ embeds: [errorEmbed('Action bloquée', 'Tu ne peux pas blacklister le serveur depuis lequel tu exécutes la commande — tu perdrais l\'accès au bot ici.')], ephemeral: true });
      }
      if (!/^\d{15,25}$/.test(guildId)) {
        return interaction.reply({ embeds: [errorEmbed('ID invalide', '`' + guildId + '` n\'est pas un identifiant de serveur valide (chiffres uniquement, 15-25 caractères).')], ephemeral: true });
      }

      const already = blacklist.isBlacklisted(guildId);
      await blacklist.add(guildId, { reason: raison, addedBy: interaction.user.tag });

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      let left = '';
      if (guild) {
        await guild.leave().catch(() => {});
        left = '\n🚪 Le bot a **quitté le serveur** immédiatement.';
      }

      return interaction.reply({
        embeds: [already
          ? successEmbed('Blacklist mise à jour', `Serveur : **${guild?.name || guildId}**\nNouvelle raison : ${raison}${left}`)
          : successEmbed('Serveur blacklisté', `Serveur : **${guild?.name || guildId}** (\`${guildId}\`)\nRaison : ${raison}${left}\n\n➡️ Aucune commande ni fonctionnalité du bot ne répondra sur ce serveur.`)],
        ephemeral: true,
      });
    }

    if (sub === 'retirer') {
      const guildId = interaction.options.getString('serveur_id').trim();
      const doc = await blacklist.list();
      const entry = doc.find(d => d.guildId === guildId);

      if (!entry) {
        return interaction.reply({ embeds: [errorEmbed('Non blacklisté', `Le serveur \`${guildId}\` n'est pas dans la blacklist.`)], ephemeral: true });
      }

      await blacklist.remove(guildId);
      return interaction.reply({
        embeds: [successEmbed('Serveur déblacklisté', `Serveur : ${await buildGuildLine(client, guildId)}\nLe bot peut à nouveau y être invité et y répondre.`)],
        ephemeral: true,
      });
    }

    if (sub === 'liste') {
      const entries = await blacklist.list();
      if (!entries.length) {
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('⛔ Blacklist globale').setDescription('*Aucun serveur blacklisté.*')], ephemeral: true });
      }

      const lines = [];
      for (const e of entries.slice(0, 25)) {
        const g = client.guilds.cache.get(e.guildId);
        const name = g ? g.name : '*bot absent*';
        lines.push(`**${name}** — \`${e.guildId}\`\n> ${e.reason} · par ${e.addedBy || '?'} · <t:${Math.floor(new Date(e.addedAt).getTime() / 1000)}:R>`);
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle(`⛔ Blacklist globale — ${entries.length} serveur(s)`)
        .setDescription(lines.join('\n'))
        .setTimestamp();
      if (entries.length > 25) embed.setFooter({ text: `+ ${entries.length - 25} autre(s) — voir la base de données` });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // info
    const guildId = interaction.options.getString('serveur_id').trim();
    const entries = await blacklist.list();
    const entry = entries.find(d => d.guildId === guildId);

    if (!entry) {
      return interaction.reply({ embeds: [successEmbed('Non blacklisté', `Le serveur ${await buildGuildLine(client, guildId)} n'est pas blacklisté.`)], ephemeral: true });
    }

    const g = client.guilds.cache.get(guildId);
    const embed = new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle('⛔ Serveur blacklisté')
      .addFields(
        { name: '🏠 Serveur', value: g ? `${g.name} (\`${guildId}\`)` : `\`${guildId}\` *(bot absent)*`, inline: false },
        { name: '📄 Raison', value: entry.reason, inline: false },
        { name: '👤 Par', value: entry.addedBy || '?', inline: true },
        { name: '📅 Le', value: `<t:${Math.floor(new Date(entry.addedAt).getTime() / 1000)}:D>`, inline: true },
      )
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
