'use strict';
// commands/communaute/anniversaire.js — 🎂 Gérer sa date d'anniversaire.
//
// La commande s'appuie sur le moteur pur (validation réelle des dates, 29 février,
// fuseau du serveur) et indique toujours la prochaine occurrence : « dans X jours ».
// Modifier sa date réinitialise le suivi d'annonce et le rôle temporaire, sinon un
// membre ayant déjà été souhaité cette année ne le serait plus jamais après un
// changement de date.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Birthday = require('../../models/Birthday');
const BirthdayConfig = require('../../models/BirthdayConfig');
const { successEmbed, errorEmbed, COLORS } = require('../../utils/embeds');
const brand = require('../../utils/brand');
const engine = require('../../utils/birthdayEngine');

async function guildSettings(guildId) {
  try {
    const cfg = await BirthdayConfig.findOne({ guildId });
    return {
      timezone: engine.sanitizeTimezone(cfg?.timezone),
      hour: engine.sanitizeHour(cfg?.announceHour),
    };
  } catch {
    return { timezone: engine.DEFAULT_TIMEZONE, hour: engine.DEFAULT_HOUR };
  }
}

function occurrenceLine(occurrence) {
  if (occurrence.daysUntil === 0) return '🎉 **C’est aujourd’hui !**';
  return `Dans **${occurrence.daysUntil} jour(s)** — ${occurrence.label}.`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('anniversaire')
    .setDescription('🎂 Gérer votre date d\'anniversaire sur ce serveur')
    .addSubcommand((s) => s.setName('definir').setDescription('Définir votre date d\'anniversaire')
      .addIntegerOption((o) => o.setName('jour').setDescription('Jour (1-31)').setMinValue(1).setMaxValue(31).setRequired(true))
      .addIntegerOption((o) => o.setName('mois').setDescription('Mois (1-12)').setMinValue(1).setMaxValue(12).setRequired(true))
      .addIntegerOption((o) => o.setName('annee').setDescription('Année de naissance (optionnel, jamais affichée)').setMinValue(1900).setMaxValue(new Date().getFullYear())))
    .addSubcommand((s) => s.setName('supprimer').setDescription('Supprimer votre date d\'anniversaire enregistrée'))
    .addSubcommand((s) => s.setName('voir').setDescription('Voir la date d\'anniversaire de quelqu\'un')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre (vous par défaut)')))
    .addSubcommand((s) => s.setName('liste').setDescription('Voir les 10 prochains anniversaires du serveur')),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ embeds: [errorEmbed('Serveur uniquement', 'Les anniversaires sont liés à un serveur : lance la commande depuis ton serveur.')], ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // ── Définir ────────────────────────────────────────────────────────────
    if (sub === 'definir') {
      const day = interaction.options.getInteger('jour');
      const month = interaction.options.getInteger('mois');
      const year = interaction.options.getInteger('annee');

      const verdict = engine.validateDate(day, month, year);
      if (!verdict.ok) {
        return interaction.reply({ embeds: [errorEmbed('Date invalide', verdict.error)], ephemeral: true });
      }

      await Birthday.findOneAndUpdate(
        { guildId, userId: interaction.user.id },
        {
          day,
          month,
          year: year ?? null,
          // Nouvelle date = nouvelle chance d'être annoncé, et rôle à réévaluer.
          lastAnnouncedOn: null,
          lastAnnouncedYear: null,
          roleGrantedOn: null,
        },
        { upsert: true, setDefaultsOnInsert: true },
      );

      const { timezone, hour } = await guildSettings(guildId);
      const today = engine.partsInTimeZone(new Date(), timezone);
      const next = engine.nextOccurrence(day, month, today);

      return interaction.reply({
        embeds: [successEmbed(
          'Anniversaire enregistré',
          [
            `🎂 Votre anniversaire est fixé au **${engine.formatDate(day, month)}**.`,
            occurrenceLine(next),
            '',
            `*Le serveur souhaite les anniversaires à ${hour}h (${timezone}).*`,
            verdict.warning ? `\n⚠️ ${verdict.warning}` : '',
          ].join('\n'),
        )],
        ephemeral: true,
      });
    }

    // ── Supprimer ─────────────────────────────────────────────────────────
    if (sub === 'supprimer') {
      const doc = await Birthday.findOne({ guildId, userId: interaction.user.id });
      if (!doc) {
        return interaction.reply({ embeds: [errorEmbed('Aucune date enregistrée', 'Vous n\'avez pas encore défini d\'anniversaire.')], ephemeral: true });
      }

      // Retirer tout de suite le rôle temporaire éventuel.
      try {
        const cfg = await BirthdayConfig.findOne({ guildId });
        const role = cfg?.roleId ? interaction.guild.roles.cache.get(cfg.roleId) : null;
        if (role) {
          const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          if (member?.roles?.cache?.has(role.id)) await member.roles.remove(role, 'Anniversaire supprimé').catch(() => {});
        }
      } catch { /* le nettoyage horaire s'en chargera */ }

      await Birthday.deleteOne({ guildId, userId: interaction.user.id });
      return interaction.reply({ embeds: [successEmbed('Anniversaire supprimé', 'Votre date a été retirée de ce serveur.')], ephemeral: true });
    }

    // ── Voir ──────────────────────────────────────────────────────────────
    if (sub === 'voir') {
      const target = interaction.options.getUser('membre') || interaction.user;
      const bday = await Birthday.findOne({ guildId, userId: target.id });
      if (!bday) {
        const subject = target.id === interaction.user.id ? 'Vous n\'avez' : `**${target.username}** n'a`;
        return interaction.reply({
          embeds: [errorEmbed('Aucune date enregistrée', `${subject} pas encore défini de date d'anniversaire.`)],
          ephemeral: true,
        });
      }

      const { timezone } = await guildSettings(guildId);
      const today = engine.partsInTimeZone(new Date(), timezone);
      const next = engine.nextOccurrence(bday.day, bday.month, today);

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.info)
          .setAuthor({ name: `${brand.BRAND.name} • Anniversaire` })
          .setTitle(`🎂 ${target.username}`)
          .setDescription([`**${engine.formatDate(bday.day, bday.month)}**`, occurrenceLine(next)].join('\n'))
          .setFooter({ text: brand.footer('Fuseau du serveur : ' + timezone) })
          .setTimestamp()],
        ephemeral: true,
      });
    }

    // ── Liste ─────────────────────────────────────────────────────────────
    if (sub === 'liste') {
      const all = await Birthday.find({ guildId });
      if (all.length === 0) {
        return interaction.reply({
          embeds: [errorEmbed('Aucun anniversaire enregistré', 'Personne n\'a encore utilisé `/anniversaire definir` sur ce serveur.')],
          ephemeral: true,
        });
      }

      const { timezone } = await guildSettings(guildId);
      const today = engine.partsInTimeZone(new Date(), timezone);
      const upcoming = engine.sortUpcoming(all.map(b => (typeof b.toObject === 'function' ? b.toObject() : b)), today).slice(0, 10);

      const lines = upcoming.map(item => {
        const when = item.daysUntil === 0 ? '🎉 **aujourd\'hui**' : `dans ${item.daysUntil} j`;
        return `<@${item.userId}> — **${item.label}** · ${when}`;
      });

      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.primary)
          .setAuthor({ name: `${brand.BRAND.name} • Anniversaires` })
          .setTitle('🎂 Prochains anniversaires')
          .setDescription(lines.join('\n'))
          .setFooter({ text: brand.footer(`${all.length} inscrit(s) · fuseau ${timezone}`) })
          .setTimestamp()],
      });
    }
  },
};
