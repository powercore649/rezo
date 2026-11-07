'use strict';
// commands/moderation/mod.js — Hub de modération REZO.
//
// Pourquoi un hub : Discord plafonne une application à 100 commandes globales et
// le budget est plein. Plutôt que d'ajouter un déban, un verrou, un mode lent et
// un bypass captcha (4 emplacements inexistants), ils rejoignent ici la fonction
// d'avertissement qui vivait dans `/warn` — celui-ci devient `/mod avertir`.
// Rien n'est perdu, une seule commande porte désormais tous les gestes de
// modération ponctuels.
//
// Répartition :
//   • avertir            → le casier (ex-`/warn ajouter`) et les paliers ;
//   • paliers ajouter…   → sanctions automatiques à N avertissements (ex-`/warn config`) ;
//   • kick               → expulsion immédiate, avec raison et journal ;
//   • unban              → lever un bannissement, avec raison ;
//   • lock / unlock      → verrouiller ou rouvrir un salon (raison acceptée) ;
//   • slowmode           → régler le mode lent d'un salon ;
//   • bypass             → débloquer un membre coincé derrière le captcha.

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Warn = require('../../models/Warn');
const WarnThresholds = require('../../models/WarnThresholds');
const { errorEmbed, successEmbed, COLORS } = require('../../utils/embeds');
const tools = require('../../utils/modTools');
const { sendModLog } = require('./modlog');

const ACTION_LABELS = { mute: '🔇 Mute', kick: '👋 Kick', ban: '🔨 Ban' };

// ─── Avertissements à paliers configurables ─────────────────────────────────
// Vérifie si le nombre actuel d'avertissements correspond à un palier configuré
// et applique l'action associée (mute/kick/ban). N'affecte pas le comportement
// par défaut si aucun palier n'est configuré pour ce serveur.
async function checkThresholds(guild, member, count) {
  try {
    const cfg = await WarnThresholds.findOne({ guildId: guild.id });
    if (!cfg || !cfg.thresholds.length) return null;

    const match = cfg.thresholds.find(t => t.count === count);
    if (!match || !member) return null;

    if (match.action === 'mute') {
      const ms = (match.duration > 0 ? match.duration : 10) * 60 * 1000;
      await member.timeout(ms, `Palier d'avertissements atteint (${count})`).catch(() => {});
    } else if (match.action === 'kick') {
      await member.kick(`Palier d'avertissements atteint (${count})`).catch(() => {});
    } else if (match.action === 'ban') {
      await member.ban({ reason: `Palier d'avertissements atteint (${count})` }).catch(() => {});
    }
    return match;
  } catch (err) {
    console.error('mod.checkThresholds:', err);
    return null;
  }
}

// ─── Aides ──────────────────────────────────────────────────────────────────
async function getThresholds(guildId) {
  let cfg = await WarnThresholds.findOne({ guildId });
  if (!cfg) cfg = await WarnThresholds.create({ guildId });
  return cfg;
}

/** Répond au lieu d'agir quand la permission Discord manque. */
async function hasPermission(interaction, flag, label) {
  const perms = interaction.memberPermissions || interaction.member?.permissions;
  if (perms?.has?.(flag)) return true;
  await interaction.reply({
    embeds: [errorEmbed('Permission manquante', `Il faut la permission **${label}**.`)],
    ephemeral: true,
  }).catch(() => {});
  return false;
}

/** Garde le mode lent (et le verrou) à l'abri des cibles hors de portée du bot. */
async function callableChannel(interaction, channel) {
  if (!interaction.guild) return null;
  const me = interaction.guild.members?.me;
  const perms = channel?.permissionsFor?.(me);
  if (perms && !perms.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      embeds: [errorEmbed('Permission manquante', `Je n'ai pas **Gérer les salons** dans <#${channel.id}>.`)],
      ephemeral: true,
    }).catch(() => {});
    return null;
  }
  return channel;
}

// ─── Avertir (casier) ───────────────────────────────────────────────────────
async function handleWarn(interaction) {
  await interaction.deferReply();
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'Pas de raison';

  await Warn.create({
    userId: user.id,
    guildId: interaction.guildId,
    warnedBy: interaction.user.id,
    reason,
  });

  const count = await Warn.countDocuments({ userId: user.id, guildId: interaction.guildId });

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('⚠️ Avertissement enregistré')
    .addFields(
      { name: '👤 Utilisateur', value: user.tag, inline: true },
      { name: '📊 Avertissements', value: `${count}`, inline: true },
      { name: '✍️ Raison', value: reason, inline: false },
    )
    .setThumbnail(user.displayAvatarURL())
    .setTimestamp();

  // ── Application des paliers configurables ────────────────────────────────
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const triggered = await checkThresholds(interaction.guild, member, count);
  if (triggered) {
    embed.addFields({ name: '🚨 Palier atteint', value: `Action automatique appliquée : **${ACTION_LABELS[triggered.action]}**` });
  }

  return interaction.editReply({ embeds: [embed] });
}

// ─── Paliers de sanctions ───────────────────────────────────────────────────
async function handleThresholds(interaction, sub) {
  const cfg = await getThresholds(interaction.guildId);

  if (sub === 'ajouter') {
    const seuil = interaction.options.getInteger('seuil');
    const action = interaction.options.getString('action');
    const duree = interaction.options.getInteger('duree') || 0;

    cfg.thresholds = cfg.thresholds.filter(t => t.count !== seuil);
    cfg.thresholds.push({ count: seuil, action, duration: duree });
    cfg.thresholds.sort((a, b) => a.count - b.count);
    await cfg.save();

    return interaction.reply({
      embeds: [successEmbed('Palier ajouté', `À **${seuil} avertissement(s)** → **${ACTION_LABELS[action]}**${action === 'mute' && duree > 0 ? ` (${duree} min)` : ''}`)],
      ephemeral: true,
    });
  }

  if (sub === 'retirer') {
    const seuil = interaction.options.getInteger('seuil');
    if (!cfg.thresholds.some(t => t.count === seuil)) {
      return interaction.reply({ embeds: [errorEmbed('Introuvable', `Aucun palier à ${seuil} avertissements.`)], ephemeral: true });
    }
    cfg.thresholds = cfg.thresholds.filter(t => t.count !== seuil);
    await cfg.save();
    return interaction.reply({ embeds: [successEmbed('Palier retiré', `Le palier à **${seuil}** avertissement(s) a été supprimé.`)], ephemeral: true });
  }

  if (!cfg.thresholds.length) {
    return interaction.reply({
      embeds: [errorEmbed('Aucun palier', 'Aucun palier configuré. Utilise `/mod paliers ajouter seuil:3 action:mute`.')],
      ephemeral: true,
    });
  }

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle('⚠️ Paliers d\'avertissements configurés')
      .setDescription(cfg.thresholds
        .map(t => `**${t.count}** avertissement(s) → **${ACTION_LABELS[t.action]}**${t.action === 'mute' && t.duration > 0 ? ` (${t.duration} min)` : ''}`)
        .join('\n'))
      .setTimestamp()],
    ephemeral: true,
  });
}

// ─── Expulsion ──────────────────────────────────────────────────────────────
async function handleKick(interaction) {
  if (!await hasPermission(interaction, PermissionFlagsBits.KickMembers, 'Expulser des membres')) return;

  await interaction.deferReply({ ephemeral: true });
  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'Aucune raison';

  if (user.id === interaction.user.id) {
    return interaction.editReply({ embeds: [errorEmbed('Impossible', 'Vous ne pouvez pas vous expulser.')] });
  }
  if (user.id === interaction.client.user.id) {
    return interaction.editReply({ embeds: [errorEmbed('Impossible', 'Je ne peux pas m’expulser moi-même.')] });
  }

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply({ embeds: [errorEmbed('Introuvable', 'Ce membre n’est pas sur le serveur.')] });
  }
  if (tools.outranked(interaction.member, member)) {
    return interaction.editReply({ embeds: [errorEmbed('Rôles trop hauts', 'Ce membre a un rôle supérieur ou égal au tien.')] });
  }
  if (!member.kickable) {
    return interaction.editReply({ embeds: [errorEmbed('Expulsion impossible', 'Ce membre n’est pas modifiable : mon rôle est trop bas ou il est administrateur.')] });
  }

  const ok = await member.kick(reason).then(() => true).catch(() => false);
  if (!ok) {
    return interaction.editReply({ embeds: [errorEmbed('Expulsion impossible', 'Discord a refusé l’action — vérifie mes permissions.')] });
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('👢 Membre expulsé')
    .addFields(
      { name: '👤 Utilisateur', value: `${user.tag} (\`${user.id}\`)`, inline: true },
      { name: '🛡️ Modérateur', value: `<@${interaction.user.id}>`, inline: true },
      { name: '✍️ Raison', value: reason, inline: false },
    )
    .setTimestamp();
  if (user.displayAvatarURL()) embed.setThumbnail(user.displayAvatarURL());

  await sendModLog(interaction.client, interaction.guildId, embed).catch(() => {});
  return interaction.editReply({ embeds: [embed] });
}

// ─── Débannissement ─────────────────────────────────────────────────────────
async function handleUnban(interaction) {
  if (!await hasPermission(interaction, PermissionFlagsBits.BanMembers, 'Bannir des membres')) return;

  await interaction.deferReply({ ephemeral: true });
  const raw = interaction.options.getString('utilisateur');
  const reason = interaction.options.getString('raison') || 'Aucune raison';

  const result = await tools.applyUnban(interaction.guild, { userId: raw, reason });
  if (!result.ok) {
    return interaction.editReply({ embeds: [errorEmbed('Débannissement impossible', tools.errorText(result.code))] });
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('✅ Bannissement levé')
    .addFields(
      { name: '👤 Utilisateur', value: result.tag, inline: true },
      { name: '🛡️ Modérateur', value: `<@${interaction.user.id}>`, inline: true },
      { name: '✍️ Raison', value: reason, inline: false },
    )
    .setTimestamp();

  await sendModLog(interaction.client, interaction.guildId, embed).catch(() => {});
  return interaction.editReply({ embeds: [embed] });
}

// ─── Verrouillage / mode lent ───────────────────────────────────────────────
async function handleLock(interaction, locked) {
  if (!await hasPermission(interaction, PermissionFlagsBits.ManageChannels, 'Gérer les salons')) return;

  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getChannel('salon') || interaction.channel;
  const reason = interaction.options.getString('raison') || (locked ? 'Salon verrouillé' : 'Salon rouvert');

  const channel = await callableChannel(interaction, target);
  if (!channel) return;

  const result = await tools.applyLock(channel, interaction.guild, { locked, reason });
  if (!result.ok) {
    return interaction.editReply({ embeds: [errorEmbed('Action impossible', tools.errorText(result.code))] });
  }

  const embed = new EmbedBuilder()
    .setColor(locked ? COLORS.warning : COLORS.success)
    .setTitle(locked ? '🔒 Salon verrouillé' : '🔓 Salon rouvert')
    .setDescription(result.already
      ? `<#${channel.id}> était **déjà** dans cet état : rien n'a été modifié.`
      : `<#${channel.id}> ${locked ? 'n’accepte plus' : 'accepte de nouveau'} les messages de **@everyone**.`)
    .addFields(
      { name: '🛡️ Modérateur', value: `<@${interaction.user.id}>`, inline: true },
      { name: '✍️ Raison', value: reason, inline: false },
    )
    .setTimestamp();

  await sendModLog(interaction.client, interaction.guildId, embed).catch(() => {});
  return interaction.editReply({ embeds: [embed] });
}

async function handleSlowmode(interaction) {
  if (!await hasPermission(interaction, PermissionFlagsBits.ManageChannels, 'Gérer les salons')) return;

  const parsed = tools.parseSlowmode(interaction.options.getString('duree'));
  if (!parsed.ok) {
    return interaction.reply({ embeds: [errorEmbed('Durée invalide', parsed.error)], ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getChannel('salon') || interaction.channel;
  const reason = interaction.options.getString('raison') || 'Réglage du mode lent';

  const channel = await callableChannel(interaction, target);
  if (!channel) return;

  const result = await tools.applySlowmode(channel, { seconds: parsed.seconds, reason });
  if (!result.ok) {
    return interaction.editReply({ embeds: [errorEmbed('Action impossible', tools.errorText(result.code))] });
  }

  const embed = new EmbedBuilder()
    .setColor(parsed.seconds === 0 ? COLORS.success : COLORS.warning)
    .setTitle(parsed.seconds === 0 ? '⏱️ Mode lent désactivé' : '⏱️ Mode lent réglé')
    .setDescription(result.changed
      ? `<#${channel.id}> → **${tools.describeSlowmode(parsed.seconds)}** (${parsed.seconds} s).`
      : `<#${channel.id}> était déjà à **${tools.describeSlowmode(parsed.seconds)}** : rien n'a été modifié.`)
    .addFields(
      { name: '🛡️ Modérateur', value: `<@${interaction.user.id}>`, inline: true },
      { name: '✍️ Raison', value: reason, inline: false },
    )
    .setTimestamp();

  await sendModLog(interaction.client, interaction.guildId, embed).catch(() => {});
  return interaction.editReply({ embeds: [embed] });
}

// ─── Bypass captcha ─────────────────────────────────────────────────────────
async function handleBypass(interaction) {
  if (!await hasPermission(interaction, PermissionFlagsBits.ManageRoles, 'Gérer les rôles')) return;

  await interaction.deferReply({ ephemeral: true });
  const user = interaction.options.getUser('membre');
  const reason = interaction.options.getString('raison') || 'Membre légitime bloqué par le captcha';

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return interaction.editReply({ embeds: [errorEmbed('Introuvable', 'Ce membre n’est pas sur le serveur.')] });
  }
  if (tools.outranked(interaction.member, member)) {
    return interaction.editReply({ embeds: [errorEmbed('Rôles trop hauts', 'Ce membre a un rôle supérieur ou égal au tien.')] });
  }

  const result = await tools.applyCaptchaBypass(member, { moderatorId: interaction.user.id, reason });
  if (!result.ok) {
    return interaction.editReply({ embeds: [errorEmbed('Bypass impossible', tools.errorText(result.code))] });
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('🔓 Captcha contourné')
    .setDescription(`<@${user.id}> est vérifié sans résoudre le captcha. La vérification en attente a été annulée : il ne sera pas expulsé par l’expiration.`)
    .addFields(
      { name: '🛡️ Modérateur', value: `<@${interaction.user.id}>`, inline: true },
      { name: '🎭 Rôle accordé', value: result.added ? `<@&${result.added}>` : '—', inline: true },
      { name: '✍️ Raison', value: reason, inline: false },
    )
    .setTimestamp();

  await sendModLog(interaction.client, interaction.guildId, embed).catch(() => {});
  return interaction.editReply({ embeds: [embed] });
}

// ─── Vue d'ensemble (appel sans sous-commande) ──────────────────────────────
// Le panneau `/setting` peut relayer vers cette commande sans sous-commande :
// dans ce cas on affiche le mode d'emploi plutôt qu'une erreur.
async function showOverview(interaction) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('⚖️ Modération')
    .setDescription('Tous les gestes de modération ponctuels sont regroupés ici.')
    .addFields(
      { name: '⚠️ `/mod avertir`', value: 'Avertir un membre (il entre dans son casier).', inline: false },
      { name: '👢 `/mod kick`', value: 'Expulser un membre, avec raison journalisée.', inline: false },
      { name: '📈 `/mod paliers`', value: 'Sanctions automatiques à N avertissements.', inline: false },
      { name: '✅ `/mod unban`', value: 'Lever un bannissement, avec raison.', inline: false },
      { name: '🔒 `/mod lock` · `/mod unlock`', value: 'Fermer puis rouvrir un salon.', inline: false },
      { name: '⏱️ `/mod slowmode`', value: 'Régler le mode lent (`off`, `30s`, `5m`, `2h`).', inline: false },
      { name: '🔓 `/mod bypass`', value: 'Vérifier un membre coincé derrière le captcha.', inline: false },
    )
    .setTimestamp();
  return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
}

// ─── Commande ───────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('mod')
    .setDescription('⚖️ Modération : avertir, expulser, débannir, verrouiller, mode lent, bypass captcha')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)      .addSubcommand(s => s
      .setName('avertir')
      .setDescription('Avertir un membre (enregistré dans son casier)')
      .addUserOption(o => o.setName('user').setDescription('Utilisateur').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Raison').setRequired(false)))
    .addSubcommand(s => s
      .setName('kick')
      .setDescription('👢 Expulser un membre du serveur')
      .addUserOption(o => o.setName('user').setDescription('Utilisateur à expulser').setRequired(true))
      .addStringOption(o => o.setName('reason').setDescription('Raison').setRequired(false)))
    .addSubcommandGroup(g => g
      .setName('paliers')
      .setDescription('Sanctions automatiques déclenchées à N avertissements')
      .addSubcommand(s => s
        .setName('ajouter')
        .setDescription('Ajouter un palier (action automatique à N avertissements)')
        .addIntegerOption(o => o.setName('seuil').setDescription('Nombre d\'avertissements déclenchant l\'action').setRequired(true).setMinValue(1))
        .addStringOption(o => o.setName('action').setDescription('Action à appliquer').setRequired(true).addChoices(
          { name: '🔇 Mute', value: 'mute' },
          { name: '👋 Kick', value: 'kick' },
          { name: '🔨 Ban', value: 'ban' },
        ))
        .addIntegerOption(o => o.setName('duree').setDescription('Durée du mute en minutes (0 = défaut)').setMinValue(0)))
      .addSubcommand(s => s
        .setName('retirer')
        .setDescription('Retirer un palier')
        .addIntegerOption(o => o.setName('seuil').setDescription('Seuil à retirer').setRequired(true).setMinValue(1)))
      .addSubcommand(s => s.setName('liste').setDescription('Voir les paliers configurés')))
    .addSubcommand(s => s
      .setName('unban')
      .setDescription('Débannir un utilisateur (identifiant ou mention)')
      .addStringOption(o => o.setName('utilisateur').setDescription('Identifiant Discord ou mention').setRequired(true))
      .addStringOption(o => o.setName('raison').setDescription('Raison du débannissement').setRequired(false)))
    .addSubcommand(s => s
      .setName('lock')
      .setDescription('Verrouiller un salon (plus d’écriture pour @everyone)')
      .addChannelOption(o => o.setName('salon').setDescription('Salon à verrouiller (défaut : celui-ci)').setRequired(false))
      .addStringOption(o => o.setName('raison').setDescription('Raison du verrouillage').setRequired(false)))
    .addSubcommand(s => s
      .setName('unlock')
      .setDescription('Rouvrir un salon verrouillé')
      .addChannelOption(o => o.setName('salon').setDescription('Salon à rouvrir (défaut : celui-ci)').setRequired(false))
      .addStringOption(o => o.setName('raison').setDescription('Raison de la réouverture').setRequired(false)))
    .addSubcommand(s => s
      .setName('slowmode')
      .setDescription('Régler le mode lent d’un salon (off, 30s, 5m, 2h)')
      .addStringOption(o => o.setName('duree').setDescription('Durée : off, 30s, 5m, 2h…').setRequired(true))
      .addChannelOption(o => o.setName('salon').setDescription('Salon concerné (défaut : celui-ci)').setRequired(false))
      .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false)))
    .addSubcommand(s => s
      .setName('bypass')
      .setDescription('Débloquer un membre coincé derrière le captcha')
      .addUserOption(o => o.setName('membre').setDescription('Membre à vérifier manuellement').setRequired(true))
      .addStringOption(o => o.setName('raison').setDescription('Raison').setRequired(false))),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);

    // Sans sous-commande (relais depuis le panneau), on explique au lieu d'échouer.
    if (!sub) return showOverview(interaction);

    if (group === 'paliers') return handleThresholds(interaction, sub);

    switch (sub) {
      case 'avertir':  return handleWarn(interaction);
      case 'kick':     return handleKick(interaction);
      case 'unban':    return handleUnban(interaction);
      case 'lock':     return handleLock(interaction, true);
      case 'unlock':   return handleLock(interaction, false);
      case 'slowmode': return handleSlowmode(interaction);
      case 'bypass':   return handleBypass(interaction);
      default:
        return interaction.reply({
          embeds: [errorEmbed('Action inconnue', 'Rouvre `/mod` : cette action n’existe plus.')],
          ephemeral: true,
        }).catch(() => {});
    }
  },

  // Exposé pour les tests hors-ligne (aucun accès Discord).
  _internals: { checkThresholds, showOverview },
};
