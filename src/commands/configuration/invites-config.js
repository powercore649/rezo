const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, AttachmentBuilder,
} = require('discord.js');
const InviteConfig = require('../../models/InviteConfig');
const { COLORS, errorEmbed, successEmbed, infoEmbed } = require('../../utils/embeds');
const { renderInviteCardSafe, INVITE_CARD_FILENAME } = require('../../utils/inviteCard');
const {
  computeInviteStats, getInviteRank, buildJoinEmbed, validateInviteColor,
} = require('../../utils/inviteEngine');
const { getCacheHealth } = require('../../utils/inviteCache');

async function getOrCreate(guildId) {
  let cfg = await InviteConfig.findOne({ guildId });
  if (!cfg) cfg = await InviteConfig.create({ guildId });
  return cfg;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('invites-config')
    .setDescription('⚙️ Configurer le système d\'invitations avancé')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('statut')
      .setDescription('Voir la configuration actuelle'))
    .addSubcommand(s => s.setName('activer')
      .setDescription('Activer ou désactiver le tracking d\'invitations')
      .addBooleanOption(o => o.setName('etat').setDescription('true = activé, false = désactivé').setRequired(true)))
    .addSubcommand(s => s.setName('salon')
      .setDescription('Définir le salon d\'annonce des arrivées/départs')
      .addChannelOption(o => o.setName('salon').setDescription('Salon texte').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('annonces')
      .setDescription('Activer/désactiver les annonces de join et/ou de leave')
      .addBooleanOption(o => o.setName('join').setDescription('Annoncer les arrivées').setRequired(true))
      .addBooleanOption(o => o.setName('leave').setDescription('Annoncer les départs').setRequired(true)))
    .addSubcommand(s => s.setName('carte')
      .setDescription('Afficher ou masquer la carte d’invitations dans les annonces d’arrivée')
      .addBooleanOption(o => o.setName('activer').setDescription('true = carte affichée').setRequired(true)))
    .addSubcommand(s => s.setName('couleur')
      .setDescription('Couleur des embeds d’arrivée')
      .addStringOption(o => o.setName('hex').setDescription('Code hexadécimal (ex: 57F287)').setRequired(true)))
    .addSubcommand(s => s.setName('coins')
      .setDescription('Coins gagnés par invitation valide (0 = désactivé)')
      .addIntegerOption(o => o.setName('montant').setDescription('0 à 1000 coins').setRequired(true).setMinValue(0).setMaxValue(1000)))
    .addSubcommand(s => s.setName('palier')
      .setDescription('Annoncer un palier toutes les N invitations (0 = désactivé)')
      .addIntegerOption(o => o.setName('etape').setDescription('Ex: 5 → paliers à 5, 10, 15… (0 = désactivé)').setRequired(true).setMinValue(0).setMaxValue(100))
      .addBooleanOption(o => o.setName('dm').setDescription('Envoyer la carte en MP à l’inviteur au palier')))
    .addSubcommand(s => s.setName('apercu')
      .setDescription('Prévisualiser la carte et l’embed d’arrivée'))
    .addSubcommand(s => s.setName('message-join')
      .setDescription('Personnaliser le message d\'arrivée (invitation connue)')
      .addStringOption(o => o.setName('texte').setDescription('Placeholders: {user} {server} {inviter} {code} {totalInvites} {rank}…').setRequired(true)))
    .addSubcommand(s => s.setName('message-join-inconnu')
      .setDescription('Personnaliser le message d\'arrivée (invitation inconnue)')
      .addStringOption(o => o.setName('texte').setDescription('Placeholders: {user} {server}').setRequired(true)))
    .addSubcommand(s => s.setName('message-leave')
      .setDescription('Personnaliser le message de départ')
      .addStringOption(o => o.setName('texte').setDescription('Placeholders: {user} {server} {inviter} {inviterTag} {code}').setRequired(true)))
    .addSubcommand(s => s.setName('anti-fake')
      .setDescription('Définir l\'âge minimum de compte (jours) pour qu\'une invitation soit valide')
      .addIntegerOption(o => o.setName('jours').setDescription('0 = désactivé').setRequired(true).setMinValue(0).setMaxValue(365)))
    .addSubcommand(s => s.setName('ignorer-ajouter')
      .setDescription('Exclure un code d\'invitation du tracking')
      .addStringOption(o => o.setName('code').setDescription('Code d\'invitation (ex: aBcD1e)').setRequired(true)))
    .addSubcommand(s => s.setName('ignorer-retirer')
      .setDescription('Réinclure un code d\'invitation précédemment ignoré')
      .addStringOption(o => o.setName('code').setDescription('Code d\'invitation').setRequired(true)))
    .addSubcommand(s => s.setName('role-ajouter')
      .setDescription('Ajouter un rôle bonus débloqué à N invitations valides')
      .addRoleOption(o => o.setName('role').setDescription('Rôle à donner').setRequired(true))
      .addIntegerOption(o => o.setName('seuil').setDescription('Nombre d\'invitations requises').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('role-retirer')
      .setDescription('Retirer un rôle bonus configuré')
      .addRoleOption(o => o.setName('role').setDescription('Rôle à retirer de la config').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const cfg = await getOrCreate(interaction.guildId);

    if (sub === 'statut') {
      const rolesText = cfg.rewardRoles.length
        ? cfg.rewardRoles.sort((a, b) => a.threshold - b.threshold)
            .map(r => `<@&${r.roleId}> à **${r.threshold}** invitation(s)`).join('\n')
        : '*Aucun*';

      const health = getCacheHealth(interaction.guildId);
      const healthText = !health.available
        ? '⚠️ Lecture impossible — le bot a besoin de la permission **Gérer le serveur** pour lire les invitations. Sans elle, les arrivées sont « inconnues ».'
        : (health.primedAt
          ? `✅ ${health.codes} lien(s) suivi(s) · actualisé <t:${Math.floor(health.primedAt / 1000)}:R>`
          : '⏳ Pas encore lu — la prochaine arrivée ou un redémarrage amorce la lecture.');

      const embed = infoEmbed('⚙️ Configuration du système d\'invitations')
        .addFields(
          { name: 'Activé', value: cfg.enabled ? '✅ Oui' : '❌ Non', inline: true },
          { name: 'Lecture des invitations', value: healthText, inline: false },
          { name: 'Salon d\'annonce', value: cfg.announceChannelId ? `<#${cfg.announceChannelId}>` : '*Non défini*', inline: true },
          { name: 'Annonces', value: `Join: ${cfg.announceJoin ? '✅' : '❌'} · Leave: ${cfg.announceLeave ? '✅' : '❌'}`, inline: true },
          { name: 'Âge min. compte (anti-fake)', value: cfg.minAccountAgeDays > 0 ? `${cfg.minAccountAgeDays} jour(s)` : '*Désactivé*', inline: true },
          { name: 'Carte d’arrivée', value: cfg.useCardOnJoin === false ? '❌ Masquée' : '✅ Affichée', inline: true },
          { name: 'Couleur des embeds', value: `#${cfg.embedColor || '57F287'}`, inline: true },
          { name: 'Coins / invitation valide', value: cfg.rewardCoins > 0 ? `🪙 ${cfg.rewardCoins}` : '*Désactivé*', inline: true },
          { name: 'Paliers', value: cfg.milestoneStep > 0 ? `Tous les **${cfg.milestoneStep}** · MP : ${cfg.milestoneDm === false ? '❌' : '✅'}` : '*Désactivés*', inline: true },
          { name: 'Codes ignorés', value: cfg.ignoredCodes.length ? cfg.ignoredCodes.map(c => `\`${c}\``).join(', ') : '*Aucun*', inline: true },
          { name: 'Rôles bonus', value: rolesText, inline: false },
          { name: 'Message join (connu)', value: `\`${cfg.joinMessage}\``, inline: false },
          { name: 'Message join (inconnu)', value: `\`${cfg.joinMessageUnknown}\``, inline: false },
          { name: 'Message leave', value: `\`${cfg.leaveMessage}\``, inline: false },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'activer') {
      cfg.enabled = interaction.options.getBoolean('etat');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Configuration mise à jour', `Le système d'invitations est maintenant **${cfg.enabled ? 'activé' : 'désactivé'}**.`)], ephemeral: true });
    }

    if (sub === 'salon') {
      const channel = interaction.options.getChannel('salon');
      cfg.announceChannelId = channel.id;
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Salon défini', `Les arrivées/départs seront annoncés dans ${channel}.`)], ephemeral: true });
    }

    if (sub === 'annonces') {
      cfg.announceJoin = interaction.options.getBoolean('join');
      cfg.announceLeave = interaction.options.getBoolean('leave');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Annonces mises à jour', `Join: **${cfg.announceJoin ? 'activé' : 'désactivé'}** · Leave: **${cfg.announceLeave ? 'activé' : 'désactivé'}**`)], ephemeral: true });
    }

    if (sub === 'carte') {
      cfg.useCardOnJoin = interaction.options.getBoolean('activer');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Carte mise à jour', cfg.useCardOnJoin
        ? 'La carte d’invitations sera jointe à chaque annonce d’arrivée.'
        : 'Les annonces d’arrivée repasseront en embed simple.')], ephemeral: true });
    }

    if (sub === 'couleur') {
      const result = validateInviteColor(interaction.options.getString('hex'));
      if (!result.ok) {
        return interaction.reply({ embeds: [errorEmbed('Couleur invalide', result.error)], ephemeral: true });
      }
      cfg.embedColor = result.hex;
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Couleur mise à jour', `Les embeds d’arrivée utiliseront désormais \`#${cfg.embedColor}\`.`)], ephemeral: true });
    }

    if (sub === 'coins') {
      cfg.rewardCoins = interaction.options.getInteger('montant');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Récompense mise à jour', cfg.rewardCoins > 0
        ? `Chaque invitation valide rapportera **${cfg.rewardCoins} coins** à l’inviteur.`
        : 'Les invitations ne rapportent plus de coins.')], ephemeral: true });
    }

    if (sub === 'palier') {
      cfg.milestoneStep = interaction.options.getInteger('etape');
      const dm = interaction.options.getBoolean('dm');
      if (dm !== null) cfg.milestoneDm = dm;
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Paliers mis à jour', cfg.milestoneStep > 0
        ? `Un palier sera annoncé tous les **${cfg.milestoneStep}** invitation(s) active(s)${cfg.milestoneDm ? ', avec une carte en MP à l’inviteur' : ''}.`
        : 'Les paliers d’invitations sont désactivés.')], ephemeral: true });
    }

    if (sub === 'apercu') {
      const target = interaction.member || interaction.user;
      const stats = await computeInviteStats(interaction.guildId, interaction.user.id);
      const previewStats = stats.active > 0 ? stats : { joins: 15, active: 12, leaves: 2, fakes: 1 };
      const rank = stats.active > 0 ? await getInviteRank(interaction.guildId, interaction.user.id, stats.active) : 3;

      const card = await renderInviteCardSafe({
        member: target,
        guild: interaction.guild,
        stats: previewStats,
        rank,
        caption: `${interaction.guild.name} · ${previewStats.active} invitation(s) active(s)`,
      });

      const sampleMember = {
        id: '000000000000000000',
        user: {
          tag: 'Nina#0001',
          username: 'nina',
          createdTimestamp: Date.now() - 200 * 86_400_000,
          displayAvatarURL: () => null,
        },
      };

      const embed = buildJoinEmbed({
        guild: interaction.guild,
        member: sampleMember,
        inviterId: interaction.user.id,
        inviterTag: interaction.user.tag,
        code: 'rezo-demo',
        method: 'invite',
        stats: previewStats,
        rank,
        cfg,
        accountAge: 200,
        accountCreatedTs: sampleMember.user.createdTimestamp,
        milestone: cfg.milestoneStep > 0 ? cfg.milestoneStep : null,
        coins: cfg.rewardCoins,
      });

      if (!stats.active) {
        embed.setFooter({ text: 'REZO • Aperçu (tes vrais chiffres apparaîtront après tes premières invitations)' });
      }
      if (card) embed.setImage(`attachment://${INVITE_CARD_FILENAME}`);

      return interaction.reply({
        embeds: [embed],
        files: card ? [new AttachmentBuilder(card, { name: INVITE_CARD_FILENAME })] : [],
        ephemeral: true,
      });
    }

    if (sub === 'message-join') {
      cfg.joinMessage = interaction.options.getString('texte');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Message mis à jour', `Nouveau message de join :\n\`${cfg.joinMessage}\``)], ephemeral: true });
    }

    if (sub === 'message-join-inconnu') {
      cfg.joinMessageUnknown = interaction.options.getString('texte');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Message mis à jour', `Nouveau message de join (inconnu) :\n\`${cfg.joinMessageUnknown}\``)], ephemeral: true });
    }

    if (sub === 'message-leave') {
      cfg.leaveMessage = interaction.options.getString('texte');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Message mis à jour', `Nouveau message de départ :\n\`${cfg.leaveMessage}\``)], ephemeral: true });
    }

    if (sub === 'anti-fake') {
      cfg.minAccountAgeDays = interaction.options.getInteger('jours');
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Anti-fake mis à jour', cfg.minAccountAgeDays > 0
        ? `Les comptes de moins de **${cfg.minAccountAgeDays} jour(s)** seront marqués comme invitations fake (non comptabilisées).`
        : 'Protection anti-fake désactivée.')], ephemeral: true });
    }

    if (sub === 'ignorer-ajouter') {
      const code = interaction.options.getString('code').trim();
      if (!cfg.ignoredCodes.includes(code)) cfg.ignoredCodes.push(code);
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Code ignoré', `Le code \`${code}\` ne sera plus tracké.`)], ephemeral: true });
    }

    if (sub === 'ignorer-retirer') {
      const code = interaction.options.getString('code').trim();
      const before = cfg.ignoredCodes.length;
      cfg.ignoredCodes = cfg.ignoredCodes.filter(c => c !== code);
      await cfg.save();
      if (cfg.ignoredCodes.length === before) {
        return interaction.reply({ embeds: [errorEmbed('Introuvable', `Le code \`${code}\` n'était pas dans la liste des codes ignorés.`)], ephemeral: true });
      }
      return interaction.reply({ embeds: [successEmbed('Code réintégré', `Le code \`${code}\` est de nouveau tracké.`)], ephemeral: true });
    }

    if (sub === 'role-ajouter') {
      const role = interaction.options.getRole('role');
      const seuil = interaction.options.getInteger('seuil');

      if (role.managed) {
        return interaction.reply({ embeds: [errorEmbed('Rôle invalide', 'Ce rôle est géré par une intégration et ne peut pas être attribué manuellement.')], ephemeral: true });
      }
      const botMember = interaction.guild.members.me;
      if (botMember.roles.highest.position <= role.position) {
        return interaction.reply({ embeds: [errorEmbed('Rôle trop haut', `Mon rôle doit être positionné au-dessus de ${role} dans la hiérarchie pour pouvoir l'attribuer.`)], ephemeral: true });
      }

      cfg.rewardRoles = cfg.rewardRoles.filter(r => r.roleId !== role.id);
      cfg.rewardRoles.push({ roleId: role.id, threshold: seuil });
      await cfg.save();
      return interaction.reply({ embeds: [successEmbed('Rôle bonus ajouté', `${role} sera attribué automatiquement à partir de **${seuil}** invitation(s) valide(s).`)], ephemeral: true });
    }

    if (sub === 'role-retirer') {
      const role = interaction.options.getRole('role');
      const before = cfg.rewardRoles.length;
      cfg.rewardRoles = cfg.rewardRoles.filter(r => r.roleId !== role.id);
      await cfg.save();
      if (cfg.rewardRoles.length === before) {
        return interaction.reply({ embeds: [errorEmbed('Introuvable', `${role} n'était pas configuré comme rôle bonus.`)], ephemeral: true });
      }
      return interaction.reply({ embeds: [successEmbed('Rôle bonus retiré', `${role} ne sera plus attribué automatiquement (les membres qui l'ont déjà le gardent).`)], ephemeral: true });
    }
  },
};
