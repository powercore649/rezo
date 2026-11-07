'use strict';
// commands/moderation/sanctions.js — 🔨 Sanctions officielles Discord.
//
// Une seule commande, deux visages :
//   • `/sanctions` (sans option) → le registre paginé des bannissements du
//     serveur, lus directement chez Discord, avec filtre, export et rafraîchis-
//     sement ;
//   • `/sanctions membre:@x` → la fiche « situation » d'un membre : banni ou
//     non (et pourquoi, par qui, quand), exclusion temporaire en cours,
//     avertissements du bot et historique du journal d'audit.
//
// Pourquoi cette commande existe : `/ds`-like (les sanctions Trust & Safety de
// Discord) n'est PAS reproductible — aucune API ne les expose à un bot, seul le
// titulaire du compte les voit. Ce qui EST officiel, et que personne ne montre
// bien, c'est la liste des bannissements du serveur et le journal d'audit. On
// les rend lisibles au lieu de simuler une donnée qu'on ne peut pas avoir.
//
// Tout ce qui est décidable sans Discord (filtre, pagination, encodage du
// filtre, description d'un timeout, export) vit dans `utils/sanctionsRegistry`
// et se teste hors-ligne.

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Warn = require('../../models/Warn');
const registry = require('../../utils/sanctionsRegistry');
const tools = require('../../utils/modTools');
const { errorEmbed, successEmbed, COLORS } = require('../../utils/embeds');
const { sendModLog } = require('./modlog');

const { ID } = registry;

// ─── Garde-fou ──────────────────────────────────────────────────────────────
// Lire une raison de bannissement, c'est déjà la permission « Bannir des
// membres » côté Discord : on applique la même règle ici, même si un serveur a
// surchargé les permissions par défaut de la commande.
async function canRead(interaction) {
  const perms = interaction.memberPermissions || interaction.member?.permissions;
  if (perms?.has?.(PermissionFlagsBits.BanMembers)) return true;
  await interaction.editReply({
    embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Bannir des membres** pour consulter les sanctions officielles.')],
  }).catch(() => {});
  return false;
}

const FETCH_ERRORS = {
  forbidden: 'Je n’ai pas la permission **Bannir des membres** sur ce serveur : Discord refuse de me donner la liste des bannissements.',
  'no-guild': 'Cette commande ne fonctionne que dans un serveur.',
  failed: 'Discord n’a pas répondu correctement. Réessaie dans un instant.',
};

// ─── Liste paginée ──────────────────────────────────────────────────────────
async function renderList(interaction, { page = 1, filter = '', force = false } = {}) {
  const guild = interaction.guild;
  const snapshot = await registry.fetchSnapshot(guild, { force });

  if (!snapshot.ok) {
    return interaction.editReply({ embeds: [errorEmbed('Liste indisponible', FETCH_ERRORS[snapshot.code] || FETCH_ERRORS.failed)] });
  }

  const filtered = registry.filterEntries(snapshot.entries, filter);
  const view = registry.paginate(filtered, page);

  return interaction.editReply({
    embeds: [registry.buildListEmbed({ guildName: guild.name, page: view, filter, fetchedAt: snapshot.fetchedAt })],
    components: registry.buildListComponents({ page: view, filter }),
  });
}

// ─── Fiche d'un membre ─────────────────────────────────────────────────────
async function renderMember(interaction, raw, { filter = '' } = {}) {
  const guild = interaction.guild;
  const userId = tools.parseUserId(raw);

  if (!userId) {
    return interaction.editReply({
      embeds: [errorEmbed('Identifiant invalide', 'Donne un identifiant Discord (17 à 20 chiffres) ou une mention.')],
    });
  }

  const [member, userFetched, ban, warns, history] = await Promise.all([
    guild.members?.fetch?.(userId).catch(() => null) || null,
    interaction.client?.users?.fetch?.(userId).catch(() => null) || null,
    guild.bans?.fetch?.(userId).catch(() => null) || null,
    Warn.countDocuments({ userId, guildId: guild.id }).catch(() => 0),
    registry.fetchUserHistory(guild, userId),
  ]);

  const user = member?.user || userFetched || ban?.user || null;
  if (!user && !ban) {
    return interaction.editReply({
      embeds: [errorEmbed('Introuvable', 'Ce membre n’est ni sur le serveur ni banni : Discord ne me donne aucune information sur lui.')],
    });
  }

  const timeout = registry.describeTimeout(member?.communicationDisabledUntilTimestamp);
  const banEntry = ban ? registry.buildEntry(ban, new Map()) : null;

  return interaction.editReply({
    embeds: [registry.buildMemberEmbed({
      guildName: guild.name,
      user,
      member,
      ban: banEntry,
      timeout,
      warns,
      history,
      filterHint: filter ? `filtre « ${registry.truncate(filter, 24)} »` : '',
    })],
    components: registry.buildMemberComponents({ userId, banned: Boolean(ban), filter }),
  });
}

// ─── Export ────────────────────────────────────────────────────────────────
async function sendExport(interaction, filter) {
  const guild = interaction.guild;
  const snapshot = await registry.fetchSnapshot(guild);

  if (!snapshot.ok) {
    return interaction.followUp({ embeds: [errorEmbed('Export impossible', FETCH_ERRORS[snapshot.code] || FETCH_ERRORS.failed)], ephemeral: true });
  }

  const filtered = registry.filterEntries(snapshot.entries, filter);
  const text = registry.buildExport(filtered, { guildName: guild.name, filter });
  const name = `sanctions-${guild.id}-${new Date().toISOString().slice(0, 10)}.txt`;

  return interaction.followUp({
    embeds: [successEmbed('Export prêt', `**${filtered.length}** bannissement(s) exporté(s)${filter ? ` (filtre « ${registry.truncate(filter, 40)} »)` : ''}.`)],
    files: [{ attachment: Buffer.from(text, 'utf8'), name }],
    ephemeral: true,
  });
}

// ─── Débannir depuis la fiche ──────────────────────────────────────────────
async function unbanFromCard(interaction, userId) {
  const guild = interaction.guild;

  const perms = interaction.memberPermissions || interaction.member?.permissions;
  if (!perms?.has?.(PermissionFlagsBits.BanMembers)) {
    return interaction.followUp({
      embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Bannir des membres**.')],
      ephemeral: true,
    });
  }

  const result = await tools.applyUnban(guild, { userId, reason: `Débannissement via /sanctions par ${interaction.user.tag}` });
  if (!result.ok) {
    return interaction.followUp({ embeds: [errorEmbed('Débannissement impossible', tools.errorText(result.code))], ephemeral: true });
  }

  const log = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('✅ Bannissement levé')
    .addFields(
      { name: '👤 Utilisateur', value: result.tag, inline: true },
      { name: '🛡️ Modérateur', value: `<@${interaction.user.id}>`, inline: true },
      { name: '✍️ Raison', value: 'Depuis le registre des sanctions', inline: false },
    )
    .setTimestamp();

  await sendModLog(interaction.client, guild.id, log).catch(() => {});
  await interaction.followUp({ embeds: [successEmbed('Bannissement levé', `**${result.tag}** peut revenir sur le serveur.`)], ephemeral: true });

  // La fiche doit tout de suite refléter la réalité : plus de ban.
  return renderMember(interaction, userId);
}

// ─── Commande ─────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('sanctions')
    .setDescription('🔨 Sanctions officielles Discord : bannissements, exclusions temporaires, historique')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o
      .setName('membre')
      .setDescription('Voir la situation complète d’un membre (défaut : le registre des bannissements)')
      .setRequired(false))
    .addStringOption(o => o
      .setName('filtre')
      .setDescription('Filtrer la liste par pseudo, identifiant ou motif')
      .setRequired(false)
      .setMaxLength(48)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    if (!await canRead(interaction)) return;

    const member = interaction.options.getUser('membre');
    // `normalizeFilter` ramène la saisie à ce qui tient dans un identifiant de
    // bouton : ainsi la page 2 filtre exactement comme la page 1.
    const filter = registry.normalizeFilter(interaction.options.getString('filtre') || '');

    if (member) return renderMember(interaction, member.id, { filter });
    return renderList(interaction, { filter });
  },

  // ─── Boutons : pagination, filtre, export, membre, déban ────────────────
  async handleButton(interaction) {
    const [prefix, arg = '', extra = ''] = String(interaction.customId).split(':');
    const filter = registry.decodeFilter(extra);

    // ⚠️ Discord n'autorise QU'UNE réponse initiale. Un modal doit être cette
    // réponse : il passe donc AVANT tout `deferUpdate`. Le faire après lève
    // « Interaction has already been acknowledged ».
    if (prefix === ID.filter) {
      return interaction.showModal(registry.buildFilterModal({ filter: registry.decodeFilter(arg) }));
    }
    if (prefix === ID.member && (!arg || arg === '-')) {
      return interaction.showModal(registry.buildMemberModal());
    }

    await interaction.deferUpdate().catch(() => {});

    switch (prefix) {
      case ID.page:
        return renderList(interaction, { page: Number(arg) || 1, filter });

      case ID.refresh:
        return renderList(interaction, { page: 1, filter, force: true });

      case ID.member:
        return renderMember(interaction, arg, { filter });

      case ID.export:
        return sendExport(interaction, filter);

      case ID.unban:
        return unbanFromCard(interaction, arg);

      default:
        return undefined;
    }
  },

  // ─── Modaux : filtre et recherche de membre ────────────────────────────
  async handleModal(interaction) {
    if (interaction.customId === ID.modalFilter) {
      const filter = registry.normalizeFilter(interaction.fields.getTextInputValue('q') || '');
      await interaction.deferUpdate().catch(() => {});
      return renderList(interaction, { page: 1, filter });
    }

    if (interaction.customId === ID.modalMember) {
      const raw = (interaction.fields.getTextInputValue('member') || '').trim();
      await interaction.deferUpdate().catch(() => {});
      return renderMember(interaction, raw);
    }

    return undefined;
  },

  // Exposé pour les tests hors-ligne (aucun accès Discord requis).
  _internals: { canRead, renderList, renderMember, FETCH_ERRORS },
};
