// commands/configuration/autorole.js — Rôles automatiques à l'arrivée et
// récompenses de rôles pour les bumpers. Utilisé par l'event guildMemberAdd
// (type 'join') et par /bump via checkBumpRoles() (type 'bump').
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const AutoRole = require('../../models/AutoRole');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ── Attribue les rôles 'join' actifs à un membre qui arrive ───────────────────
async function handleJoinRoles(member) {
  const roles = await AutoRole.find({ guildId: member.guild.id, type: 'join', enabled: true }).lean();
  if (!roles.length) return;

  const me = member.guild.members.me;
  for (const role of roles) {
    const r = member.guild.roles.cache.get(role.roleId);
    if (!r) continue;
    if (r.position >= me.roles.highest.position) continue;
    if (member.roles.cache.has(role.roleId)) continue;
    await member.roles.add(r, 'AutoRole — arrivée').catch(() => {});
  }
}

// ── Attribue les rôles 'bump' atteints grâce au Nième bump ────────────────────
async function checkBumpRoles(member, bumpCount) {
  const rewards = await AutoRole.find({ guildId: member.guild.id, type: 'bump', enabled: true }).lean();
  if (!rewards.length) return;

  const me = member.guild.members.me;
  for (const reward of rewards) {
    if (!reward.bumps || bumpCount < reward.bumps) continue;
    const r = member.guild.roles.cache.get(reward.roleId);
    if (!r || r.position >= me.roles.highest.position) continue;
    if (member.roles.cache.has(reward.roleId)) continue;
    await member.roles.add(r, `AutoRole — ${bumpCount} bumps`).catch(() => {});
  }
}

// ── Embed récapitulatif ───────────────────────────────────────────────────────
function buildListEmbed(guild, roles) {
  const me = guild.members.me;
  const lines = roles.map(r => {
    const role = guild.roles.cache.get(r.roleId);
    const broken = !role ? ' ⚠️ *rôle supprimé*' : (role.position >= me.roles.highest.position ? ' ⚠️ *rôle au-dessus du bot*' : '');
    const detail = r.type === 'bump' ? `🏆 dès **${r.bumps} bump(s)**` : '👋 dès l\'arrivée';
    return `<@&${r.roleId}> — ${detail}${r.enabled ? '' : ' ⏸️ *désactivé*'}${broken}`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🎭 Rôles automatiques')
    .setDescription(lines.length ? lines.join('\n') : '*Aucun rôle automatique configuré.*');
}

module.exports = {
  handleJoinRoles,
  checkBumpRoles,

  data: new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('🎭 Rôles automatiques (arrivée, récompenses de bump)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(s => s
      .setName('ajouter')
      .setDescription('Ajouter un rôle automatique')
      .addRoleOption(o => o.setName('role').setDescription('Rôle à attribuer automatiquement').setRequired(true))
      .addStringOption(o => o
        .setName('type')
        .setDescription('Quand attribuer ce rôle ?')
        .setRequired(true)
        .addChoices(
          { name: '👋 À l\'arrivée',            value: 'join' },
          { name: '🏆 Récompense de bump',      value: 'bump' },
        ))
      .addIntegerOption(o => o
        .setName('bumps')
        .setDescription('Nombre de bumps requis (type "bump" uniquement)')
        .setMinValue(1)
        .setMaxValue(10_000)))
    .addSubcommand(s => s
      .setName('retirer')
      .setDescription('Retirer un rôle automatique')
      .addRoleOption(o => o.setName('role').setDescription('Rôle à retirer').setRequired(true)))
    .addSubcommand(s => s
      .setName('basculer')
      .setDescription('Activer / désactiver une entrée')
      .addRoleOption(o => o.setName('role').setDescription('Rôle concerné').setRequired(true)))
    .addSubcommand(s => s.setName('liste').setDescription('Voir les rôles automatiques')),

  async execute(interaction) {
    const guild = interaction.guild;
    const me = guild.members.me;

    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'J\'ai besoin de la permission **Gérer les rôles** pour attribuer des rôles.')], ephemeral: true });
    }

    const sub  = interaction.options.getSubcommand();

    if (sub === 'liste') {
      const roles = await AutoRole.find({ guildId: guild.id }).sort({ type: 1, bumps: 1 }).lean();
      return interaction.reply({ embeds: [buildListEmbed(guild, roles)], ephemeral: true });
    }

    if (sub === 'ajouter') {
      const role = interaction.options.getRole('role');
      const type = interaction.options.getString('type');
      const bumps = interaction.options.getInteger('bumps');

      if (role.id === guild.id) {
        return interaction.reply({ embeds: [errorEmbed('Rôle invalide', 'Le rôle **@everyone** ne peut pas être attribué automatiquement.')], ephemeral: true });
      }
      if (role.position >= me.roles.highest.position) {
        return interaction.reply({ embeds: [errorEmbed('Rôle trop haut', `Mon rôle doit être **au-dessus** de ${role} dans la hiérarchie.`)], ephemeral: true });
      }
      if (type === 'bump' && !bumps) {
        return interaction.reply({ embeds: [errorEmbed('Nombre de bumps requis', 'Pour un rôle de type **bump**, précise l\'option `bumps` (ex. 10).')], ephemeral: true });
      }

      const existing = await AutoRole.findOne({ guildId: guild.id, type, roleId: role.id });
      if (existing) {
        existing.enabled = true;
        if (type === 'bump') existing.bumps = bumps || existing.bumps;
        await existing.save();
        return interaction.reply({ embeds: [successEmbed('Rôle automatique mis à jour', `${role} — mis à jour.`)], ephemeral: true });
      }

      await AutoRole.create({
        guildId: guild.id,
        type,
        roleId: role.id,
        bumps: type === 'bump' ? bumps : null,
      });
      return interaction.reply({
        embeds: [successEmbed('Rôle automatique ajouté', type === 'bump'
          ? `${role} sera attribué dès **${bumps} bump(s)**.`
          : `${role} sera attribué à chaque **arrivée**.`)],
        ephemeral: true,
      });
    }

    if (sub === 'retirer') {
      const role = interaction.options.getRole('role');
      const res = await AutoRole.deleteMany({ guildId: guild.id, roleId: role.id });
      return interaction.reply({
        embeds: [res.deletedCount
          ? successEmbed('Rôle automatique retiré', `${role} n'est plus attribué automatiquement.`)
          : errorEmbed('Introuvable', `${role} n'était pas configuré comme rôle automatique.`)],
        ephemeral: true,
      });
    }

    // basculer
    const role = interaction.options.getRole('role');
    const docs = await AutoRole.find({ guildId: guild.id, roleId: role.id });
    if (!docs.length) {
      return interaction.reply({ embeds: [errorEmbed('Introuvable', `${role} n'est pas un rôle automatique. Utilise \`/autorole ajouter\`.`)], ephemeral: true });
    }
    const newState = !docs[0].enabled;
    await AutoRole.updateMany({ guildId: guild.id, roleId: role.id }, { enabled: newState });
    return interaction.reply({
      embeds: [successEmbed('Rôle automatique mis à jour', `${role} — ${newState ? 'activé' : 'désactivé'}.`)],
      ephemeral: true,
    });
  },
};
