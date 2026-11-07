// commands/moderation/modlog.js — Logs de modération : salon dédié + événements
// configurables. Utilisé par les events (guildMemberAdd / guildMemberRemove)
// via sendModLog() et le modèle ModlogConfig exportés ci-dessous.
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const mongoose = require('mongoose');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ── Modèle : une config par serveur ──────────────────────────────────────────
const modlogConfigSchema = new mongoose.Schema({
  guildId:   { type: String, required: true, unique: true },
  channelId: { type: String, default: null },
  enabled:   { type: Boolean, default: true },
  events: {
    type: new mongoose.Schema({
      memberJoin:  { type: Boolean, default: true },
      memberLeave: { type: Boolean, default: true },
    }, { _id: false }),
    default: () => ({}),
  },
}, { timestamps: true });

const ModlogConfig = mongoose.model('ModlogConfig', modlogConfigSchema);

// ── Envoyer un embed dans le salon de modlog (silencieux si non configuré) ───
async function sendModLog(client, guildId, embed) {
  try {
    const cfg = await ModlogConfig.findOne({ guildId }).lean();
    if (!cfg?.channelId || cfg.enabled === false) return null;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    const channel = guild.channels.cache.get(cfg.channelId);
    if (!channel?.isTextBased()) return null;

    const perms = channel.permissionsFor(guild.members.me);
    if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return null;

    return await channel.send({ embeds: [embed] });
  } catch (_) {
    return null;
  }
}

// ── Commande /modlog ─────────────────────────────────────────────────────────
module.exports = {
  sendModLog,
  ModlogConfig,

  data: new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('📜 Configure les logs de modération (arrivées, départs…)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s
      .setName('salon')
      .setDescription('Définir le salon qui recevra les logs')
      .addChannelOption(o => o
        .setName('salon')
        .setDescription('Salon texte des logs')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)))
    .addSubcommand(s => s.setName('activer').setDescription('Activer les logs de modération'))
    .addSubcommand(s => s.setName('desactiver').setDescription('Désactiver les logs de modération'))
    .addSubcommand(s => s
      .setName('evenement')
      .setDescription('Activer / désactiver un événement loggé')
      .addStringOption(o => o
        .setName('evenement')
        .setDescription('Événement à configurer')
        .setRequired(true)
        .addChoices(
          { name: '👋 Arrivée de membre', value: 'memberJoin' },
          { name: '🚪 Départ de membre',  value: 'memberLeave' },
        ))
      .addBooleanOption(o => o.setName('etat').setDescription('Événement activé ?').setRequired(true)))
    .addSubcommand(s => s.setName('voir').setDescription('Voir la configuration actuelle')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    let cfg = await ModlogConfig.findOne({ guildId: interaction.guildId });
    if (!cfg) cfg = await ModlogConfig.create({ guildId: interaction.guildId });

    if (sub === 'salon') {
      const channel = interaction.options.getChannel('salon');
      const perms = channel.permissionsFor(interaction.guild.members.me);
      if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
        return interaction.reply({
          embeds: [errorEmbed('Permissions manquantes', `Je dois pouvoir **envoyer des messages** et **intégrer des liens** dans ${channel}.`)],
          ephemeral: true,
        });
      }
      cfg.channelId = channel.id;
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Salon des logs défini', `Les logs de modération seront envoyés dans ${channel}.`)], ephemeral: true });
    }

    if (sub === 'activer' || sub === 'desactiver') {
      cfg.enabled = sub === 'activer';
      await cfg.save();
      return interaction.reply({
        embeds: [successEmbed(`Logs ${cfg.enabled ? 'activés' : 'désactivés'}`, cfg.enabled
          ? 'Les logs de modération sont maintenant actifs.'
          : 'Les logs de modération sont suspendus (la config est conservée).')],
        ephemeral: true,
      });
    }

    if (sub === 'evenement') {
      const event = interaction.options.getString('evenement');
      const etat  = interaction.options.getBoolean('etat');
      cfg.events[event] = etat;
      await cfg.save();
      const label = event === 'memberJoin' ? 'Arrivée de membre' : 'Départ de membre';
      return interaction.reply({ embeds: [successEmbed('Événement mis à jour', `**${label}** : ${etat ? 'activé' : 'désactivé'}.`)], ephemeral: true });
    }

    if (sub === 'voir') {
      const ev = cfg.events || {};
      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle('📜 Logs de modération')
        .addFields(
          { name: '📊 État', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
          { name: '💬 Salon', value: cfg.channelId ? `<#${cfg.channelId}>` : '*Non défini*', inline: true },
          { name: '👋 Arrivées', value: ev.memberJoin === false ? '🔴 Désactivé' : '🟢 Activé', inline: true },
          { name: '🚪 Départs', value: ev.memberLeave === false ? '🔴 Désactivé' : '🟢 Activé', inline: true },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
