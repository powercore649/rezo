// commands/territoires.js — Guerre de territoires inter-serveurs
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const Territory      = require('../../models/Territory');
const TerritoryGuild  = require('../../models/TerritoryGuild');
const { generateMapImage } = require('../../utils/territoryMap');
const { ensureMapInitialized, rankForCaptures } = require('../../utils/territoryEngine');
const { COLORS, errorEmbed } = require('../../utils/embeds');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('territoires')
    .setDescription('🗺️ Guerre de territoires inter-serveurs — exclusif REZO !')
    .addSubcommand(s => s.setName('carte').setDescription('Voir la carte de guerre en temps réel'))
    .addSubcommand(s => s.setName('classement').setDescription('Classement des empires (serveurs)'))
    .addSubcommand(s => s.setName('mon-empire').setDescription('Voir les territoires de ce serveur'))
    .addSubcommand(s => s.setName('zone').setDescription('Détails d\'une zone précise')
      .addStringOption(o => o.setName('id').setDescription('ID de la zone (ex: A1, C3)').setRequired(true))),

  async execute(interaction) {
    await interaction.deferReply();
    await ensureMapInitialized();
    const sub = interaction.options.getSubcommand();

    // ── Carte visuelle ───────────────────────────────────────────────────
    if (sub === 'carte') {
      const territories = await Territory.find().lean();
      const ownedCount   = territories.filter(t => t.ownerGuildId).length;

      try {
        const buf = await generateMapImage(territories);
        const embed = new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle('🗺️ Carte des Territoires')
          .setDescription(
            `**${ownedCount}/${territories.length}** zones conquises dans le réseau.\n` +
            `Chaque \`/bump\` lance une attaque automatique sur une zone ! ⚔️\n` +
            `⭐ = Zone légendaire ・ ◆ = Zone rare`
          )
          .setImage('attachment://territory-map.png')
          .setFooter({ text: 'REZO • Territoires • Mise à jour en temps réel' })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed], files: [new AttachmentBuilder(buf, { name: 'territory-map.png' })] });
      } catch (err) {
        console.error('territoires carte canvas:', err);
        return interaction.editReply({ embeds: [errorEmbed('Erreur de génération', 'Impossible de générer la carte pour le moment.')] });
      }
    }

    // ── Classement des empires ────────────────────────────────────────────
    if (sub === 'classement') {
      const top = await TerritoryGuild.find().sort({ totalCaptures: -1 }).limit(10);
      if (!top.length) return interaction.editReply({ embeds: [errorEmbed('Aucune donnée', 'Aucun serveur n\'a encore conquis de territoire. Utilisez `/bump` pour commencer !')] });

      const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
      const desc = top.map((g, i) =>
        `${medals[i]} **${g.guildName || 'Serveur inconnu'}** — ${g.rank}\n` +
        `　 ⚔️ ${g.totalCaptures} conquêtes ・ 💀 ${g.totalLost} pertes ・ 🪙 ${g.warCoins} war-coins`
      ).join('\n\n');

      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('👑 Classement des Empires')
        .setDescription(desc)
        .setFooter({ text: 'REZO • Territoires' })
        .setTimestamp()] });
    }

    // ── Mon empire ─────────────────────────────────────────────────────────
    if (sub === 'mon-empire') {
      const guild = interaction.guild;
      const myZones = await Territory.find({ ownerGuildId: guild.id }).sort({ tier: -1 });
      const stats   = await TerritoryGuild.findOne({ guildId: guild.id });

      if (!myZones.length) {
        return interaction.editReply({ embeds: [new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('🏳️ Aucun territoire')
          .setDescription(`**${guild.name}** ne possède encore aucun territoire.\nUtilisez \`/bump\` pour lancer des attaques automatiques !`)] });
      }

      const tierEmoji = { 1: '⬜', 2: '◆', 3: '⭐' };
      const desc = myZones.map(z => `${tierEmoji[z.tier]} \`${z.zoneId}\` **${z.name}** — Puissance: ${z.power}/500`).join('\n');

      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle(`🏰 Empire de ${guild.name}`)
        .setThumbnail(guild.iconURL({ dynamic: true }))
        .setDescription(desc)
        .addFields(
          { name: '👑 Rang',        value: stats?.rank || 'Recrue', inline: true },
          { name: '⚔️ Conquêtes',   value: String(stats?.totalCaptures || 0), inline: true },
          { name: '🪙 War-coins',   value: String(stats?.warCoins || 0), inline: true },
        )
        .setFooter({ text: 'REZO • Territoires' })
        .setTimestamp()] });
    }

    // ── Détails d'une zone ────────────────────────────────────────────────
    if (sub === 'zone') {
      const zoneId = interaction.options.getString('id').toUpperCase();
      const zone = await Territory.findOne({ zoneId });
      if (!zone) return interaction.editReply({ embeds: [errorEmbed('Zone introuvable', `Aucune zone avec l'ID \`${zoneId}\`. Format attendu : A1 à F5.`)] });

      const tierLabel = { 1: 'Commune', 2: 'Rare ◆', 3: 'Légendaire ⭐' }[zone.tier];
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(zone.tier === 3 ? 0xFFD700 : COLORS.primary)
        .setTitle(`🗺️ Zone ${zone.zoneId} — ${zone.name}`)
        .addFields(
          { name: '🏷️ Rareté',     value: tierLabel, inline: true },
          { name: '👑 Propriétaire', value: zone.ownerGuildId ? (zone.ownerName || 'Inconnu') : '*Territoire libre*', inline: true },
          { name: '💪 Puissance',   value: `${zone.power}/500`, inline: true },
          { name: '📅 Capturée',    value: zone.capturedAt ? `<t:${Math.floor(new Date(zone.capturedAt).getTime()/1000)}:R>` : '*Jamais*', inline: true },
        )
        .setFooter({ text: 'REZO • Territoires' })
        .setTimestamp()] });
    }
  },
};
