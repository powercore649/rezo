'use strict';
// commands/configuration/rolemenu.js — Menus de rôles en libre-service.
//
// Un serveur = un panneau, publié dans le salon de son choix. Les membres
// cliquent un bouton (ou choisissent dans un menu déroulant) et reçoivent le
// rôle correspondant, sans passer par un modérateur.
//
// Le panneau est édité sur place à chaque modification de la configuration :
// il n'est jamais recréé, donc les customId statiques restent valides après un
// redémarrage du bot. Toute la logique de rendu vit dans utils/roleMenuView.js,
// ce qui laisse cette commande concentrée sur les permissions et les écritures.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const RoleMenu = require('../../models/RoleMenu');
const view = require('../../utils/roleMenuView');
const editor = require('../../utils/roleMenuEditor');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ── Aides internes ──────────────────────────────────────────────────────────

async function fetchMenu(guildId) {
  return RoleMenu.findOne({ guildId });
}

/** Document du serveur, créé à la première modification (l'éditeur a besoin d'un id). */
async function loadOrCreate(guildId, userId = null) {
  const existing = await RoleMenu.findOne({ guildId });
  if (existing) return existing;
  const created = new RoleMenu({ guildId, updatedBy: userId });
  await created.save();
  return created;
}

function botCanManageRoles(guild) {
  return Boolean(guild?.members?.me?.permissions?.has(PermissionFlagsBits.ManageRoles));
}

/** Salon textuel dans lequel le panneau est publié (ou peut l'être). */
function resolveChannel(guild, channelId) {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return null;
  return channel.isTextBased?.() && !channel.isVoiceBased?.() ? channel : null;
}

/**
 * Édite le panneau déjà publié. Retourne une raison lisible quand ce n'est pas
 * possible, pour que la commande puisse prévenir sans jamais échouer.
 */
async function refreshPanel(menu, guild) {
  if (!menu?.channelId || !menu?.messageId) return { ok: false, reason: 'panneau non publié' };
  const channel = resolveChannel(guild, menu.channelId)
    || await guild.channels.fetch(menu.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return { ok: false, reason: 'salon introuvable' };

  const message = await channel.messages.fetch(menu.messageId).catch(() => null);
  if (!message) return { ok: false, reason: 'message supprimé' };

  await message.edit(view.buildPanel(menu, guild)).catch(() => {});
  return { ok: true };
}

/**
 * Publie (ou met à jour) le panneau dans un salon et mémorise où il vit.
 * Un panneau déplacé d'un salon à l'autre ne laisse pas de doublon derrière lui.
 */
async function publishPanel(channel, menu, guild) {
  if (menu.messageId && menu.channelId && menu.channelId !== channel.id) {
    const previousChannel = resolveChannel(guild, menu.channelId);
    const previousMessage = previousChannel
      ? await previousChannel.messages.fetch(menu.messageId).catch(() => null)
      : null;
    await previousMessage?.delete().catch(() => {});
    menu.messageId = null;
  }

  const existing = menu.messageId
    ? await channel.messages.fetch(menu.messageId).catch(() => null)
    : null;

  const message = existing
    ? await existing.edit(view.buildPanel(menu, guild))
    : await channel.send(view.buildPanel(menu, guild));

  menu.channelId = channel.id;
  menu.messageId = message.id;
  await menu.save();
  return message;
}

/**
 * Applique un état de rôles au membre.
 *
 * On raisonne en « ensemble voulu » plutôt qu'en bascule : c'est la seule façon
 * de gérer correctement le mode exclusif (un seul rôle) et un menu déroulant
 * multi-choix, où Discord envoie la sélection complète et non un delta.
 */
async function applySelection(interaction, menu, wantedIds) {
  const guild = interaction.guild;
  const member = interaction.member;
  const me = guild.members.me;

  const menuRoles = (menu.entries || []).map(entry => entry.roleId);
  const wanted = new Set(wantedIds.filter(id => menuRoles.includes(id)));
  const added = [];
  const removed = [];
  const skipped = [];

  for (const roleId of menuRoles) {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      if (wanted.has(roleId)) skipped.push('un rôle supprimé');
      continue;
    }
    const hasIt = member.roles.cache.has(roleId);
    const wantIt = wanted.has(roleId);
    if (hasIt === wantIt) continue;

    // Un rôle géré par une intégration, ou placé au-dessus du bot, ne peut pas
    // être attribué : on le signale au lieu d'échouer silencieusement.
    if (role.managed || role.position >= me.roles.highest.position) {
      skipped.push(role.name);
      continue;
    }

    const applied = wantIt
      ? await member.roles.add(role, 'Menu de rôles').then(() => true).catch(() => false)
      : await member.roles.remove(role, 'Menu de rôles').then(() => true).catch(() => false);

    if (applied) (wantIt ? added : removed).push(role.name);
    else skipped.push(role.name);
  }

  return { added, removed, skipped };
}

function resultEmbed({ added, removed, skipped }) {
  const lines = [];
  if (added.length) lines.push(`✅ **Ajouté** : ${added.join(', ')}`);
  if (removed.length) lines.push(`➖ **Retiré** : ${removed.join(', ')}`);
  if (skipped.length) lines.push(`⚠️ **Ignoré** : ${skipped.join(', ')}`);

  const nothing = lines.length === 0;
  return new EmbedBuilder()
    .setColor(nothing ? COLORS.info : COLORS.success)
    .setTitle(nothing ? '🎭 Aucun changement' : '🎭 Rôles mis à jour')
    .setDescription(lines.join('\n') || '*Tu avais déjà exactement ces rôles.*')
    .setTimestamp();
}

/** Garde-fou commun aux clics : salon, menu existant, permission du bot. */
async function loadClickContext(interaction, menuId) {
  if (!interaction.inGuild()) return { error: 'Cette action ne fonctionne que sur un serveur.' };
  if (!botCanManageRoles(interaction.guild)) {
    return { error: 'Il me manque la permission **Gérer les rôles** pour distribuer des rôles.' };
  }
  const menu = await RoleMenu.findById(menuId).catch(() => null);
  if (!menu || menu.guildId !== interaction.guildId) return { error: 'Ce menu n\'existe plus.' };
  if (!menu.entries.length) return { error: 'Ce menu ne contient aucun rôle.' };
  return { menu };
}

// ── Interactions ────────────────────────────────────────────────────────────

/** Bouton `rmn:<menuId>:<roleId>` — bascule un rôle unique. */
async function handleButton(interaction) {
  const parsed = view.parseButtonId(interaction.customId);
  if (!parsed) return;

  const { menu, error } = await loadClickContext(interaction, parsed.menuId);
  if (error) return interaction.reply({ embeds: [errorEmbed('Indisponible', error)], ephemeral: true });

  const entry = menu.entries.find(item => item.roleId === parsed.roleId);
  if (!entry) {
    return interaction.reply({
      embeds: [errorEmbed('Rôle retiré', 'Ce rôle ne fait plus partie du menu. Signale-le à un administrateur.')],
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const current = new Set(
    menu.entries.map(item => item.roleId).filter(id => interaction.member.roles.cache.has(id)),
  );
  if (current.has(parsed.roleId)) {
    current.delete(parsed.roleId);
  } else {
    if (menu.exclusive) current.clear();
    current.add(parsed.roleId);
  }

  const result = await applySelection(interaction, menu, [...current]);
  return interaction.editReply({ embeds: [resultEmbed(result)] }).catch(() => {});
}

/** Menu déroulant `rmnsel:<menuId>` — envoie la sélection complète. */
async function handleSelect(interaction) {
  const parsed = view.parseSelectId(interaction.customId);
  if (!parsed) return;

  const { menu, error } = await loadClickContext(interaction, parsed.menuId);
  if (error) return interaction.reply({ embeds: [errorEmbed('Indisponible', error)], ephemeral: true });

  await interaction.deferReply({ ephemeral: true });

  let values = [...(interaction.values || [])];
  if (menu.exclusive) values = values.slice(0, 1);

  const result = await applySelection(interaction, menu, values);
  return interaction.editReply({ embeds: [resultEmbed(result)] }).catch(() => {});
}

// ── Éditeur unique ──────────────────────────────────────────────────────────
//
// L'éditeur est un message éphémère dont l'embed EST le panneau : chaque
// modification réécrit ce message (`interaction.update`) et, si le panneau est
// déjà publié, le message public en même temps. C'est l'aperçu en temps réel.

async function editorGuard(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) return true;
  await interaction.reply({
    embeds: [errorEmbed('Accès refusé', 'Tu as besoin de la permission **Gérer les rôles** pour modifier le menu.')],
    ephemeral: true,
  }).catch(() => {});
  return false;
}

/** Réécrit l'aperçu (et le panneau publié) après une modification. */
async function syncAfterChange(interaction, menu, guild, note = null) {
  await refreshPanel(menu, guild);
  const payload = editor.buildEditor(menu, guild);
  if (note) payload.content = `${note}\n${payload.content}`;

  // `update()` réécrit le message d'origine. Un modal ouvert depuis un composant
  // porte ce message ; dans le cas contraire (modal orphelin) on répond par un
  // nouvel aperçu plutôt que de laisser la personne devant un écran figé.
  if (interaction.message) {
    return interaction.update(payload).catch(() => {});
  }
  return interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
}

/** Menu déroulant de l'éditeur : bascule directe ou ouverture d'un modal. */
async function handleEditorSelect(interaction) {
  if (!(await editorGuard(interaction))) return;
  const field = interaction.values?.[0];
  const guild = interaction.guild;
  const menu = await loadOrCreate(guild.id, interaction.user.id);

  if (field === 'style') {
    menu.mode = menu.mode === 'select' ? 'buttons' : 'select';
    menu.updatedBy = interaction.user.id;
    await menu.save();
    return syncAfterChange(interaction, menu, guild, `✅ Style : **${menu.mode === 'select' ? 'menu déroulant' : 'boutons'}**`);
  }

  if (field === 'exclusif') {
    menu.exclusive = !menu.exclusive;
    menu.updatedBy = interaction.user.id;
    await menu.save();
    return syncAfterChange(interaction, menu, guild,
      `✅ Choix : **${menu.exclusive ? 'un seul rôle à la fois' : 'plusieurs rôles'}**`);
  }

  const modal = editor.buildModal(field, menu);
  if (!modal) return;
  return interaction.showModal(modal).catch(() => {});
}

/** Boutons de l'éditeur : publier / fermer. */
async function handleEditorButton(interaction) {
  const action = String(interaction.customId).slice(editor.CID_ACTION.length);

  if (action === 'fermer') {
    return interaction.update({
      content: 'Éditeur fermé — ton panneau, lui, reste en place. Rouvre-le avec `/rolemenu editeur`.',
      embeds: [],
      components: [],
    }).catch(() => {});
  }

  if (!(await editorGuard(interaction))) return;

  const guild = interaction.guild;
  const menu = await loadOrCreate(guild.id, interaction.user.id);
  const stored = resolveChannel(guild, menu.channelId)
    || await guild.channels.fetch(menu.channelId).catch(() => null);
  const target = stored?.isTextBased?.() ? stored : interaction.channel;

  if (!target?.isTextBased?.()) {
    return interaction.update(editor.buildEditor(menu, guild)).catch(() => {});
  }

  await publishPanel(target, menu, guild);
  return syncAfterChange(interaction, menu, guild, `📤 Panneau publié dans ${target}`);
}

/** Modal de l'éditeur : validation puis application au document. */
async function handleEditorModal(interaction) {
  const field = String(interaction.customId).slice(editor.CID_MODAL.length);
  if (!(await editorGuard(interaction))) return;

  const guild = interaction.guild;
  const menu = await loadOrCreate(guild.id, interaction.user.id);
  const read = id => {
    try { return interaction.fields.getTextInputValue(id); } catch { return ''; }
  };

  const result = editor.applyField(menu, field, read, guild);
  if (!result.ok) {
    return interaction.reply({ embeds: [errorEmbed('Valeur refusée', result.error)], ephemeral: true }).catch(() => {});
  }

  menu.updatedBy = interaction.user.id;
  await menu.save();

  const note = result.added === true
    ? '✅ Rôle ajouté au panneau'
    : result.added === false
      ? '✅ Apparence du rôle mise à jour'
      : '✅ Modification enregistrée';
  return syncAfterChange(interaction, menu, guild, note);
}

// ── Commande ────────────────────────────────────────────────────────────────

module.exports = {
  handleButton,
  handleSelect,
  handleEditorSelect,
  handleEditorButton,
  handleEditorModal,

  data: new SlashCommandBuilder()
    .setName('rolemenu')
    .setDescription('🎭 Menu de rôles en libre-service (boutons ou menu déroulant)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addSubcommand(s => s
      .setName('publier')
      .setDescription('Publier (ou mettre à jour) le panneau dans un salon')
      .addChannelOption(o => o
        .setName('salon')
        .setDescription('Salon d’accueil du panneau (par défaut : ici)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption(o => o.setName('titre').setDescription('Titre du panneau').setMaxLength(256))
      .addStringOption(o => o.setName('description').setDescription('Texte d’introduction').setMaxLength(2000))
      .addStringOption(o => o
        .setName('style')
        .setDescription('Boutons (25 max) ou menu déroulant')
        .addChoices(
          { name: '🔘 Boutons', value: 'buttons' },
          { name: '📋 Menu déroulant', value: 'select' },
        ))
      .addBooleanOption(o => o
        .setName('exclusif')
        .setDescription('Un seul rôle à la fois (les autres sont retirés automatiquement)')))
    .addSubcommand(s => s
      .setName('ajouter')
      .setDescription('Ajouter un rôle au menu')
      .addRoleOption(o => o.setName('role').setDescription('Rôle distribué par ce menu').setRequired(true))
      .addStringOption(o => o.setName('libelle').setDescription('Texte du bouton (par défaut : nom du rôle)').setMaxLength(80))
      .addStringOption(o => o.setName('emoji').setDescription('Émoji du bouton, ex. 🎨')))
    .addSubcommand(s => s
      .setName('retirer')
      .setDescription('Retirer un rôle du menu')
      .addRoleOption(o => o.setName('role').setDescription('Rôle à retirer').setRequired(true)))
    .addSubcommand(s => s
      .setName('editeur')
      .setDescription('🎛️ Éditeur unique : apparence, rôles et aperçu en direct'))
    .addSubcommand(s => s.setName('apercu').setDescription('Voir le menu et son état (privé)'))
    .addSubcommand(s => s.setName('supprimer').setDescription('Supprimer le menu et son panneau')),

  async execute(interaction) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();

    if (!botCanManageRoles(guild)) {
      return interaction.reply({
        embeds: [errorEmbed('Permission manquante', 'J\'ai besoin de la permission **Gérer les rôles** pour distribuer des rôles.')],
        ephemeral: true,
      });
    }

    const menu = await fetchMenu(guild.id);

    // ── Éditeur unique ──────────────────────────────────────────────────────
    if (sub === 'editeur') {
      const doc = menu || await loadOrCreate(guild.id, interaction.user.id);
      return interaction.reply({ ...editor.buildEditor(doc, guild), ephemeral: true });
    }

    // ── Aperçu ──────────────────────────────────────────────────────────────
    if (sub === 'apercu') {
      if (!menu) {
        return interaction.reply({
          embeds: [errorEmbed('Aucun menu', 'Crée d\'abord un menu avec `/rolemenu ajouter`, puis publie-le avec `/rolemenu publier`.')],
          ephemeral: true,
        });
      }
      return interaction.reply({ embeds: [view.buildPreview(menu, guild)], ephemeral: true });
    }

    // ── Suppression ─────────────────────────────────────────────────────────
    if (sub === 'supprimer') {
      if (!menu) {
        return interaction.reply({ embeds: [errorEmbed('Aucun menu', 'Ce serveur n\'a pas de menu de rôles.')], ephemeral: true });
      }
      const channel = resolveChannel(guild, menu.channelId);
      if (channel && menu.messageId) {
        const message = await channel.messages.fetch(menu.messageId).catch(() => null);
        await message?.delete().catch(() => {});
      }
      await RoleMenu.deleteOne({ _id: menu._id });
      return interaction.reply({
        embeds: [successEmbed('Menu supprimé', 'Le panneau a été retiré. Les rôles déjà attribués restent en place.')],
        ephemeral: true,
      });
    }

    // ── Ajout d'un rôle ─────────────────────────────────────────────────────
    if (sub === 'ajouter') {
      const role = interaction.options.getRole('role');
      const label = interaction.options.getString('libelle');
      const emoji = interaction.options.getString('emoji');
      const me = guild.members.me;

      if (role.id === guild.id) {
        return interaction.reply({ embeds: [errorEmbed('Rôle invalide', 'Le rôle **@everyone** ne peut pas être distribué par un menu.')], ephemeral: true });
      }
      if (role.managed) {
        return interaction.reply({ embeds: [errorEmbed('Rôle géré', `${role} est géré par une intégration et ne peut pas être attribué à la main.`)], ephemeral: true });
      }
      if (role.position >= me.roles.highest.position) {
        return interaction.reply({ embeds: [errorEmbed('Rôle trop haut', `Mon rôle doit être **au-dessus** de ${role} dans la hiérarchie.`)], ephemeral: true });
      }

      const entries = menu?.entries || [];
      if (entries.some(entry => entry.roleId === role.id)) {
        return interaction.reply({ embeds: [errorEmbed('Déjà présent', `${role} figure déjà dans le menu.`)], ephemeral: true });
      }
      if (entries.length >= view.MAX_ENTRIES) {
        return interaction.reply({
          embeds: [errorEmbed('Menu complet', `Un panneau ne peut pas dépasser **${view.MAX_ENTRIES} rôles** (limite de Discord).`)],
          ephemeral: true,
        });
      }

      const doc = menu || new RoleMenu({ guildId: guild.id });
      doc.entries.push({ roleId: role.id, label: label || null, emoji: emoji || null });
      doc.updatedBy = interaction.user.id;
      await doc.save();

      const refreshed = await refreshPanel(doc, guild);
      return interaction.reply({
        embeds: [successEmbed('Rôle ajouté', [
          `${role} rejoint le menu (**${doc.entries.length}/${view.MAX_ENTRIES}**).`,
          refreshed.ok ? 'Le panneau publié a été mis à jour.' : 'Publie le panneau avec `/rolemenu publier`.',
        ].join('\n'))],
        ephemeral: true,
      });
    }

    // ── Retrait d'un rôle ───────────────────────────────────────────────────
    if (sub === 'retirer') {
      const role = interaction.options.getRole('role');
      if (!menu) {
        return interaction.reply({ embeds: [errorEmbed('Aucun menu', 'Ce serveur n\'a pas de menu de rôles.')], ephemeral: true });
      }
      const before = menu.entries.length;
      menu.entries = menu.entries.filter(entry => entry.roleId !== role.id);
      if (menu.entries.length === before) {
        return interaction.reply({ embeds: [errorEmbed('Introuvable', `${role} ne fait pas partie du menu.`)], ephemeral: true });
      }
      menu.updatedBy = interaction.user.id;
      await menu.save();

      const refreshed = await refreshPanel(menu, guild);
      return interaction.reply({
        embeds: [successEmbed('Rôle retiré', [
          `${role} ne fait plus partie du menu.`,
          refreshed.ok ? 'Le panneau publié a été mis à jour.' : 'Pense à publier le panneau avec `/rolemenu publier`.',
        ].join('\n'))],
        ephemeral: true,
      });
    }

    // ── Publication / mise à jour du panneau ────────────────────────────────
    const target = interaction.options.getChannel('salon') || interaction.channel;
    const title = interaction.options.getString('titre');
    const description = interaction.options.getString('description');
    const style = interaction.options.getString('style');
    const exclusive = interaction.options.getBoolean('exclusif');

    const channel = resolveChannel(guild, target?.id) || await guild.channels.fetch(target?.id).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isVoiceBased?.()) {
      return interaction.reply({ embeds: [errorEmbed('Salon invalide', 'Choisis un salon textuel pour publier le panneau.')], ephemeral: true });
    }

    const doc = menu || new RoleMenu({ guildId: guild.id });
    if (title) doc.title = title;
    if (description) doc.description = description;
    if (style) doc.mode = style;
    if (typeof exclusive === 'boolean') doc.exclusive = exclusive;
    doc.updatedBy = interaction.user.id;

    // Publie, ou met à jour sur place : un panneau déplacé de salon ne laisse
    // jamais de doublon derrière lui (voir publishPanel).
    await publishPanel(channel, doc, guild);

    const warnings = doc.entries
      .map(entry => ({ entry, issue: view.roleIssue(guild, entry.roleId) }))
      .filter(item => item.issue);

    const embed = successEmbed('Panneau publié', [
      `Salon : ${channel}`,
      `Rôles : **${doc.entries.length}/${view.MAX_ENTRIES}**`,
      `Style : **${doc.mode === 'select' ? 'menu déroulant' : 'boutons'}** · ${doc.exclusive ? 'un seul rôle' : 'plusieurs rôles'}`,
      doc.entries.length ? 'Les membres peuvent choisir dès maintenant.' : 'Ajoute des rôles avec `/rolemenu ajouter`.',
      ...(warnings.length ? ['', `⚠️ ${warnings.length} rôle(s) à vérifier — voir \`/rolemenu apercu\`.`] : []),
    ].join('\n'));

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
