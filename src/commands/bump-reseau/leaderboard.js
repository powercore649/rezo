// commands/leaderboard.js — Leaderboard bumps ET richesse
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const Balance = require('../../models/Balance');
const User    = require('../../models/User');
const { COLORS } = require('../../utils/embeds');

const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];

// ─── Construction d'un embed de classement (réutilisable, ex: auto-post cron) ──
async function buildLeaderboardEmbed(client, guild, type) {
  const XP = require('../../models/XP');
  let entries, title, valueKey, unit, isXp = false;

  if (type === 'coins') {
    entries  = await Balance.find({ guildId: guild.id }).sort({ coins: -1 }).limit(10);
    title    = '💰 Leaderboard richesse';
    valueKey = 'coins';
    unit     = '🪙';
  } else if (type === 'weekly') {
    entries  = await User.find({ guildId: guild.id, weeklyBumps: { $gt: 0 } }).sort({ weeklyBumps: -1 }).limit(10);
    title    = '📅 Leaderboard bumps (semaine)';
    valueKey = 'weeklyBumps';
    unit     = 'bumps';
  } else if (type === 'xp') {
    entries  = await XP.find({ guildId: guild.id }).sort({ level: -1, xp: -1 }).limit(10);
    title    = '🏆 Leaderboard XP';
    valueKey = 'totalXp';
    unit     = 'XP';
    isXp = true;
  } else {
    entries  = await User.find({ guildId: guild.id, bumps: { $gt: 0 } }).sort({ bumps: -1 }).limit(10);
    title    = '🚀 Leaderboard bumps';
    valueKey = 'bumps';
    unit     = 'bumps';
  }

  let description = '';
  for (const [i, entry] of entries.entries()) {
    try {
      const user = await client.users.fetch(entry.userId);
      description += `${medals[i]} **${user.username}** — ${isXp ? `Niv. ${entry.level} ・ ` : ''}${entry[valueKey].toLocaleString()} ${unit}\n`;
    } catch {
      description += `${medals[i]} *Utilisateur inconnu* — ${entry[valueKey].toLocaleString()} ${unit}\n`;
    }
  }

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`${title} — ${guild.name}`)
    .setDescription(description || '*Aucune donnée disponible*')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setFooter({ text: 'REZO • Classement automatique' })
    .setTimestamp();
}

// ─── Comparaison simple d'un champ cron ("*", "*/n" ou liste de valeurs) ──────
function cronFieldMatches(field, value) {
  if (field === '*') return true;
  return field.split(',').some(part => {
    if (part.includes('/')) {
      const [, step] = part.split('/');
      return value % parseInt(step, 10) === 0;
    }
    return parseInt(part, 10) === value;
  });
}

// Vérifie si une expression cron à 5 champs (min heure jour mois jourSemaine)
// correspond à la date donnée (minute près) — utilisé pour le déclenchement
// périodique par-guilde sans avoir à recréer une tâche node-cron à chaque modif.
function cronMatchesNow(expr, date = new Date()) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, month, dow] = parts;
  return cronFieldMatches(min, date.getMinutes())
    && cronFieldMatches(hour, date.getHours())
    && cronFieldMatches(dom, date.getDate())
    && cronFieldMatches(month, date.getMonth() + 1)
    && cronFieldMatches(dow, date.getDay());
}

// ─── Publication automatique périodique (appelée par le cron dans index.js) ──
async function postScheduledLeaderboards(client) {
  const LeaderboardConfig = require('../../models/LeaderboardConfig');
  const configs = await LeaderboardConfig.find({ cronEnabled: true, channelId: { $ne: null } });
  const now = new Date();
  for (const cfg of configs) {
    try {
      if (!cronMatchesNow(cfg.schedule, now)) continue;
      const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
      if (!guild) continue;
      const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
      if (!channel?.isTextBased()) continue;
      const embed = await buildLeaderboardEmbed(client, guild, cfg.type);
      await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      console.error(`❌ postScheduledLeaderboards (${cfg.guildId}):`, err.message);
    }
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('🏆 Classements du serveur')
    .addStringOption(o => o.setName('type').setDescription('Type de classement').addChoices(
      { name: '💰 Richesse (coins)',       value: 'coins'   },
      { name: '🚀 Bumps totaux',           value: 'bumps'   },
      { name: '📅 Bumps cette semaine',    value: 'weekly'  },
    )),

  async execute(interaction) {
    await interaction.deferReply();
    const type  = interaction.options.getString('type') || 'bumps';
    const guild = interaction.guild;

    let entries, title, valueKey, unit;

    if (type === 'coins') {
      entries  = await Balance.find({ guildId: guild.id }).sort({ coins: -1 }).limit(10);
      title    = '💰 Leaderboard richesse';
      valueKey = 'coins';
      unit     = '🪙';
    } else if (type === 'weekly') {
      entries  = await User.find({ guildId: guild.id, weeklyBumps: { $gt: 0 } }).sort({ weeklyBumps: -1 }).limit(10);
      title    = '📅 Leaderboard bumps (semaine)';
      valueKey = 'weeklyBumps';
      unit     = 'bumps';
    } else {
      entries  = await User.find({ guildId: guild.id, bumps: { $gt: 0 } }).sort({ bumps: -1 }).limit(10);
      title    = '🚀 Leaderboard bumps';
      valueKey = 'bumps';
      unit     = 'bumps';
    }

    let description = '';
    for (const [i, entry] of entries.entries()) {
      try {
        const user = await interaction.client.users.fetch(entry.userId);
        description += `${medals[i]} **${user.username}** — ${entry[valueKey].toLocaleString()} ${unit}\n`;
      } catch {
        description += `${medals[i]} *Utilisateur inconnu* — ${entry[valueKey].toLocaleString()} ${unit}\n`;
      }
    }

    // Position de l'utilisateur actuel
    let myRank = null;
    if (type === 'coins') {
      const myEntry = await Balance.findOne({ userId: interaction.user.id, guildId: guild.id });
      if (myEntry) {
        myRank = await Balance.countDocuments({ guildId: guild.id, coins: { $gt: myEntry.coins } }) + 1;
        description += `\n*Votre position : **#${myRank}** — ${myEntry.coins.toLocaleString()} 🪙*`;
      }
    } else {
      const myEntry = await User.findOne({ userId: interaction.user.id, guildId: guild.id });
      if (myEntry) {
        const field = type === 'weekly' ? 'weeklyBumps' : 'bumps';
        myRank = await User.countDocuments({ guildId: guild.id, [field]: { $gt: myEntry[field] || 0 } }) + 1;
        description += `\n*Votre position : **#${myRank}** — ${(myEntry[field] || 0).toLocaleString()} ${unit}*`;
      }
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle(`${title} — ${guild.name}`)
      .setDescription(description || '*Aucune donnée disponible*')
      .setThumbnail(guild.iconURL({ dynamic: true }))
      .setFooter({ text: 'REZO • Classement' })
      .setTimestamp();

    // Menu pour changer de type
    const menu = new StringSelectMenuBuilder()
      .setCustomId('lb_switch')
      .setPlaceholder('Changer de classement…')
      .addOptions([
        { label: '🚀 Bumps totaux',        value: 'bumps',  emoji: '🚀' },
        { label: '📅 Bumps cette semaine', value: 'weekly', emoji: '📅' },
        { label: '💰 Richesse (coins)',    value: 'coins',  emoji: '💰' },
      ]);

    const reply = await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(menu)],
      fetchReply: true,
    });

    // Collecteur pour changer de type
    const col = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 5 * 60 * 1000 });
    col.on('collect', async i => {
      if (i.customId !== 'lb_switch') return;
      const newType = i.values[0];

      let newEntries, newTitle, newKey, newUnit;
      if (newType === 'coins') {
        newEntries = await Balance.find({ guildId: guild.id }).sort({ coins: -1 }).limit(10);
        newTitle = '💰 Leaderboard richesse'; newKey = 'coins'; newUnit = '🪙';
      } else if (newType === 'weekly') {
        newEntries = await User.find({ guildId: guild.id, weeklyBumps: { $gt: 0 } }).sort({ weeklyBumps: -1 }).limit(10);
        newTitle = '📅 Leaderboard bumps (semaine)'; newKey = 'weeklyBumps'; newUnit = 'bumps';
      } else {
        newEntries = await User.find({ guildId: guild.id, bumps: { $gt: 0 } }).sort({ bumps: -1 }).limit(10);
        newTitle = '🚀 Leaderboard bumps'; newKey = 'bumps'; newUnit = 'bumps';
      }

      let desc = '';
      for (const [idx, entry] of newEntries.entries()) {
        try {
          const u = await interaction.client.users.fetch(entry.userId);
          desc += `${medals[idx]} **${u.username}** — ${entry[newKey].toLocaleString()} ${newUnit}\n`;
        } catch { desc += `${medals[idx]} *Inconnu* — ${entry[newKey].toLocaleString()} ${newUnit}\n`; }
      }

      await i.update({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(`${newTitle} — ${guild.name}`)
          .setDescription(desc || '*Aucune donnée*')
          .setThumbnail(guild.iconURL({ dynamic: true }))
          .setFooter({ text: 'REZO • Classement' }).setTimestamp()],
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    });
    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  buildLeaderboardEmbed,
  postScheduledLeaderboards,
};
