// commands/configuration/reglement.js — v2 : PANNEAU UNIQUE /reglement
// Une seule commande, aucun sous-commande : tout se gère dans le panneau
// interactif (ajout en masse par collage, édition, suppression, déplacement,
// apparence, rôle d'acceptation, salon de publication, aperçu, publication
// avec mise à jour du message existant).
//
// Conventions customId : reglm_ (modaux), regls_ (menus), regl_ (boutons)
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
} = require('discord.js');
const Reglement = require('../../models/Reglement');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');

const MAX_RULES = 40;

// ─── Helpers (exportés pour les tests) ────────────────────────────────────────
function normalizeColor(input) {
  if (!input) return null;
  const c = String(input).trim().replace(/^#/, '');
  return /^[0-9A-Fa-f]{6}$/.test(c) ? `#${c.toUpperCase()}` : null;
}

// Découpe un collage multi-lignes en règles propres (une par ligne).
function parseBulkRules(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

function buildRulesText(reg) {
  return reg.rules
    .map((r, i) => (reg.showNumbering ? `**${i + 1}.** ${r}` : `• ${r}`))
    .join('\n\n');
}

// Embed exact qui sera publié (utilisé pour l'aperçu et la publication).
function buildReglementEmbed(reg, guild) {
  const colorInt = normalizeColor(reg.color) ? parseInt(normalizeColor(reg.color).slice(1), 16) : COLORS.primary;
  const embed = new EmbedBuilder()
    .setColor(colorInt)
    .setTitle(reg.title || `📜 Règlement — ${guild.name}`);
  const parts = [];
  if (reg.description) parts.push(reg.description);
  if (reg.rules.length) parts.push(buildRulesText(reg));
  embed.setDescription(parts.join('\n\n') || '*Aucune règle pour le moment.*');
  if (reg.footer) embed.setFooter({ text: reg.footer });
  else if (reg.acceptRoleId) embed.setFooter({ text: 'Cliquez sur « J\'accepte » pour obtenir l\'accès au serveur' });
  return embed;
}

// ─── Panneau principal ────────────────────────────────────────────────────────
function buildPanel(reg, guild, note = null) {
  const published = reg.messageId && reg.channelId;
  const msgUrl = published
    ? (reg.publishedUrl || `https://discord.com/channels/${guild.id}/${reg.channelId}/${reg.messageId}`)
    : null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📜 Panneau du règlement')
    .setDescription(
      'Gérez **tout** le règlement depuis ce panneau : règles, apparence, publication.\n'
      + `\n**📑 Règles :** ${reg.rules.length}/${MAX_RULES}`
      + `\n**🔢 Numérotation :** ${reg.showNumbering ? 'Activée' : 'Désactivée'}`
      + `\n**✅ Rôle d'acceptation :** ${reg.acceptRoleId ? `<@&${reg.acceptRoleId}>` : '*Aucun*'}`
      + `\n**📢 Salon de publication :** ${reg.channelId ? `<#${reg.channelId}>` : '*Non défini*'}`
      + `\n**🧵 Message publié :** ${msgUrl ? `[Voir](${msgUrl})` : '*Non publié*'}`
      + `\n**🎨 Titre actuel :** ${reg.title ? `\`${reg.title}\`` : '*Par défaut*'}`
      + (note ? `\n\n${note}` : ''),
    )
    .setFooter({ text: 'Astuce : « Ajouter » accepte le collage de plusieurs règles, une par ligne' });

  const actionSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('regls_action')
      .setPlaceholder('⚡ Choisir une action…')
      .addOptions(
        { label: 'Ajouter des règles', value: 'add', emoji: '📥', description: 'Coller une ou plusieurs règles (une par ligne)' },
        { label: 'Modifier une règle', value: 'edit', emoji: '✏️', description: 'Réécrire le texte d\'une règle existante' },
        { label: 'Supprimer une règle', value: 'del', emoji: '🗑️', description: 'Retirer une règle du règlement' },
        { label: 'Déplacer une règle', value: 'move', emoji: '↕️', description: 'Réordonner (monter / descendre)' },
        { label: 'Apparence', value: 'app', emoji: '🎨', description: 'Titre, intro, couleur, pied de page, bouton' },
      ),
  );

  const channelSelect = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('regls_channel')
      .setPlaceholder('📢 Salon de publication…')
      .addChannelTypes(ChannelType.GuildText),
  );

  const roleSelect = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('regls_role')
      .setPlaceholder('✅ Rôle donné à l\'acceptation…'),
  );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('regl_preview').setLabel('Aperçu').setEmoji('👁️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('regl_numbering').setLabel(`Numérotation : ${reg.showNumbering ? 'ON' : 'OFF'}`).setEmoji('🔢').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('regl_role_clear').setLabel('Retirer le rôle').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('regl_publish').setLabel(published ? 'Mettre à jour le message' : 'Publier').setEmoji(published ? '🔄' : '📤').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('regl_repost').setLabel('Reposter (nouveau message)').setEmoji('➕').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('regl_close').setLabel('Fermer').setEmoji('❌').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [actionSelect, channelSelect, roleSelect, row1, row2] };
}

// ─── Sous-panneaux de gestion des règles ──────────────────────────────────────
function buildRulesPanel(reg, mode) {
  const meta = {
    edit: { title: '✏️ Modifier une règle', customId: 'regls_edit', placeholder: 'Choisir la règle à modifier…' },
    del:  { title: '🗑️ Supprimer une règle', customId: 'regls_del', placeholder: 'Choisir la règle à supprimer…' },
    move: { title: '↕️ Déplacer une règle', customId: 'regls_mv', placeholder: 'Choisir la règle à déplacer…' },
  }[mode];

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(meta.title)
    .setDescription(buildRulesText(reg) || '*Aucune règle.*');
  if (reg.rules.length > 25) embed.setFooter({ text: 'Seules les 25 premières règles sont listées dans le menu' });

  const options = reg.rules.slice(0, 25).map((r, i) => ({
    label: `#${i + 1} — ${r.slice(0, 90) || '(vide)'}`,
    value: String(i),
  }));

  const select = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(meta.customId).setPlaceholder(meta.placeholder).addOptions(options),
  );
  const back = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('regl_back').setLabel('Retour au panneau').setEmoji('🔙').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [select, back] };
}

function buildConfirmPanel(title, description, rows) {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle(title).setDescription(description)],
    components: rows,
  };
}

// ─── Publication ──────────────────────────────────────────────────────────────
async function publish(interaction, reg, { forceNew = false } = {}) {
  const guild = interaction.guild;
  if (!reg.rules.length) {
    return interaction.reply({ embeds: [errorEmbed('Vide', 'Ajoutez des règles avant de publier (bouton 📥 via le menu d\'actions).')], ephemeral: true });
  }
  if (!reg.channelId) {
    return interaction.reply({ embeds: [errorEmbed('Salon manquant', 'Choisissez d\'abord un **salon de publication** dans le panneau.')], ephemeral: true });
  }
  const channel = await guild.channels.fetch(reg.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    return interaction.reply({ embeds: [errorEmbed('Salon introuvable', 'Le salon configuré n\'existe plus. Choisissez-en un autre.')], ephemeral: true });
  }

  const embed = buildReglementEmbed(reg, guild);
  const components = [];
  if (reg.acceptRoleId) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('reglement_accept').setLabel(reg.acceptLabel || '✅ J\'accepte le règlement').setStyle(ButtonStyle.Success),
    ));
  }

  // Mise à jour du message existant (sauf repost forcé)
  if (reg.messageId && !forceNew) {
    const oldMsg = await channel.messages.fetch(reg.messageId).catch(() => null);
    if (oldMsg) {
      await oldMsg.edit({ embeds: [embed], components });
      reg.updatedAt = new Date();
      await reg.save();
      return interaction.reply({ embeds: [successEmbed('Règlement mis à jour', `Le [message existant](${oldMsg.url}) a été édité — aucune duplication.`)], ephemeral: true });
    }
  }

  const msg = await channel.send({ embeds: [embed], components });

  // Si on reposte : l'ancien message reste en place (choix du staff) —
  // on pointe simplement la config vers le nouveau.
  reg.messageId = msg.id;
  reg.channelId = channel.id;
  reg.publishedUrl = msg.url;
  reg.updatedAt = new Date();
  await reg.save();

  return interaction.reply({ embeds: [successEmbed('Règlement publié', `Publié dans <#${channel.id}> — [voir le message](${msg.url}).\n${reg.acceptRoleId ? `Le rôle <@&${reg.acceptRoleId}> est donné à l'acceptation.` : '*Aucun rôle d\'acceptation configuré.*'}`)], ephemeral: true });
}

// ─── Commande unique : /reglement ─────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('reglement')
    .setDescription('📜 Panneau de gestion complète du règlement (règles, apparence, publication)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    if (!interaction.inGuild()) return;
    let reg = await Reglement.findOne({ guildId: interaction.guildId });
    if (!reg) reg = await Reglement.create({ guildId: interaction.guildId });
    return interaction.reply({ ...buildPanel(reg, interaction.guild), ephemeral: true });
  },

  // ── Menus ───────────────────────────────────────────────────────────────────
  async handleSelect(interaction) {
    const id = interaction.customId;
    const reg = await Reglement.findOne({ guildId: interaction.guildId });
    if (!reg) return;

    // Menu d'actions principal
    if (id === 'regls_action') {
      const action = interaction.values[0];

      if (action === 'add') {
        const modal = new ModalBuilder().setCustomId('reglm_add').setTitle('📥 Ajouter des règles');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('regles').setLabel('Règles (une par ligne)')
              .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3900)
              .setPlaceholder('Pas d\'insultes\nRespectez le staff\nPas de spam'),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('mode').setLabel('Mode : « ajouter » ou « remplacer »')
              .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(10)
              .setPlaceholder('ajouter (par défaut)'),
          ),
        );
        return interaction.showModal(modal);
      }

      if (action === 'app') {
        const modal = new ModalBuilder().setCustomId('reglm_app').setTitle('🎨 Apparence du règlement');
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('titre').setLabel('Titre (vide = par défaut)')
              .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)
              .setValue(reg.title || '').setPlaceholder(`Règlement — ${interaction.guild.name}`),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('intro').setLabel('Intro affichée au-dessus des règles')
              .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
              .setValue(reg.description || ''),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('couleur').setLabel('Couleur en hex (ex: #5865F2)')
              .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(7)
              .setValue(reg.color || '#8B1A1A'),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('footer').setLabel('Pied de page (vide = par défaut)')
              .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(150)
              .setValue(reg.footer || ''),
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('label').setLabel('Texte du bouton d\'acceptation')
              .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)
              .setValue(reg.acceptLabel || '✅ J\'accepte le règlement'),
          ),
        );
        return interaction.showModal(modal);
      }

      // edit / del / move → sous-panneau avec sélecteur de règle
      return interaction.update(buildRulesPanel(reg, action));
    }

    // Édition d'une règle → modal prérempli
    if (id === 'regls_edit') {
      const i = parseInt(interaction.values[0], 10);
      const modal = new ModalBuilder().setCustomId(`reglm_edit_${i}`).setTitle(`✏️ Modifier la règle #${i + 1}`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('texte').setLabel('Nouveau texte de la règle')
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)
            .setValue(reg.rules[i] || ''),
        ),
      );
      return interaction.showModal(modal);
    }

    // Suppression → confirmation
    if (id === 'regls_del') {
      const i = parseInt(interaction.values[0], 10);
      return interaction.update(buildConfirmPanel(
        `🗑️ Supprimer la règle #${i + 1} ?`,
        `> ${reg.rules[i]}\n\nCette action est **irréversible** (mais vous pouvez la recréer).`,
        [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`regl_del_${i}`).setLabel('Confirmer la suppression').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('regl_back').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
          ),
        ],
      ));
    }

    // Déplacement → boutons monter/descendre
    if (id === 'regls_mv') {
      const i = parseInt(interaction.values[0], 10);
      const rows = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`regl_up_${i}`).setLabel('Monter').setEmoji('⬆️').setStyle(ButtonStyle.Primary).setDisabled(i === 0),
        new ButtonBuilder().setCustomId(`regl_down_${i}`).setLabel('Descendre').setEmoji('⬇️').setStyle(ButtonStyle.Primary).setDisabled(i === reg.rules.length - 1),
        new ButtonBuilder().setCustomId('regl_back').setLabel('Retour').setEmoji('🔙').setStyle(ButtonStyle.Secondary),
      )];
      return interaction.update(buildConfirmPanel(
        `↕️ Déplacer la règle #${i + 1}`,
        `> ${reg.rules[i]}\n\nPosition actuelle : **${i + 1}/${reg.rules.length}**`,
        rows,
      ));
    }

    // Salon de publication
    if (id === 'regls_channel') {
      reg.channelId = interaction.values[0];
      reg.updatedAt = new Date();
      await reg.save();
      return interaction.update(buildPanel(reg, interaction.guild, `✅ Salon de publication : <#${reg.channelId}>`));
    }
    // Rôle d'acceptation
    if (id === 'regls_role') {
      reg.acceptRoleId = interaction.values[0];
      reg.updatedAt = new Date();
      await reg.save();
      return interaction.update(buildPanel(reg, interaction.guild, `✅ Rôle d'acceptation : <@&${reg.acceptRoleId}>`));
    }
  },

  // ── Boutons ─────────────────────────────────────────────────────────────────
  async handleButton(interaction) {
    const id = interaction.customId;
    const reg = await Reglement.findOne({ guildId: interaction.guildId });
    if (!reg) return;

    if (id === 'regl_back') return interaction.update(buildPanel(reg, interaction.guild));
    if (id === 'regl_close') {
      return interaction.update({ embeds: [infoEmbed('Panneau fermé', 'Relancez `/reglement` pour le rouvrir.')], components: [] });
    }

    if (id === 'regl_preview') {
      const embed = buildReglementEmbed(reg, interaction.guild);
      const components = reg.acceptRoleId ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('regl_noop').setLabel(reg.acceptLabel || '✅ J\'accepte le règlement').setStyle(ButtonStyle.Success).setDisabled(true),
      )] : [];
      return interaction.reply({ embeds: [embed.setFooter(embed.data.footer || { text: '👁️ Aperçu — ceci est exactement le message qui sera publié' })], components, ephemeral: true });
    }

    if (id === 'regl_numbering') {
      reg.showNumbering = !reg.showNumbering;
      reg.updatedAt = new Date();
      await reg.save();
      return interaction.update(buildPanel(reg, interaction.guild, `🔢 Numérotation ${reg.showNumbering ? '**activée**' : '**désactivée**'}.`));
    }

    if (id === 'regl_role_clear') {
      reg.acceptRoleId = null;
      reg.updatedAt = new Date();
      await reg.save();
      return interaction.update(buildPanel(reg, interaction.guild, '🧹 Rôle d\'acceptation retiré — le bouton d\'acceptation ne sera plus affiché.'));
    }

    if (id === 'regl_publish') return publish(interaction, reg);
    if (id === 'regl_repost') return publish(interaction, reg, { forceNew: true });

    // Suppression confirmée
    if (id.startsWith('regl_del_')) {
      const i = parseInt(id.split('_')[2], 10);
      if (!reg.rules[i]) return interaction.update({ embeds: [errorEmbed('Introuvable', 'Cette règle n\'existe plus.')], components: [] });
      const [removed] = reg.rules.splice(i, 1);
      reg.updatedAt = new Date();
      await reg.save();
      return interaction.update(buildPanel(reg, interaction.guild, `🗑️ Règle #${i + 1} supprimée : « ${removed.slice(0, 80)} »`));
    }

    // Déplacement
    if (id.startsWith('regl_up_') || id.startsWith('regl_down_')) {
      const [_, dir, idxStr] = id.split('_');
      const i = parseInt(idxStr, 10);
      const j = dir === 'up' ? i - 1 : i + 1;
      if (!reg.rules[i] || j < 0 || j >= reg.rules.length) {
        return interaction.update(buildPanel(reg, interaction.guild));
      }
      [reg.rules[i], reg.rules[j]] = [reg.rules[j], reg.rules[i]];
      reg.updatedAt = new Date();
      await reg.save();
      const newPos = j + 1;
      return interaction.update(buildPanel(reg, interaction.guild, `↕️ Règle déplacée en position **${newPos}** : « ${reg.rules[j].slice(0, 80)} »`));
    }

    if (id === 'regl_noop') return interaction.deferUpdate().catch(() => {});
  },

  // ── Modaux ──────────────────────────────────────────────────────────────────
  async handleModal(interaction) {
    const id = interaction.customId;
    const reg = await Reglement.findOne({ guildId: interaction.guildId });
    if (!reg) return;

    // Ajout en masse (collage multi-lignes)
    if (id === 'reglm_add') {
      const newRules = parseBulkRules(interaction.fields.getTextInputValue('regles'));
      if (!newRules.length) {
        return interaction.reply({ embeds: [errorEmbed('Aucune règle', 'Le texte ne contient aucune ligne valide.')], ephemeral: true });
      }
      const mode = (interaction.fields.getTextInputValue('mode') || 'ajouter').trim().toLowerCase();
      const replace = ['remplacer', 'replace', 'remplacement'].includes(mode);

      const before = reg.rules.length;
      if (replace) reg.rules = [];
      let added = 0;
      let skipped = 0;
      for (const r of newRules) {
        if (reg.rules.length >= MAX_RULES) { skipped++; continue; }
        reg.rules.push(r.slice(0, 1000));
        added++;
      }
      reg.updatedAt = new Date();
      await reg.save();

      const note = replace
        ? `♻️ Règlement **remplacé** : ${added} règle(s) enregistrée(s).`
        : `📥 ${added} règle(s) ajoutée(s) — total : **${reg.rules.length}/${MAX_RULES}**.`;
      return interaction.reply({ ...buildPanel(reg, interaction.guild, note + (skipped ? `\n⚠️ ${skipped} ligne(s) ignorée(s) : limite de ${MAX_RULES} règles atteinte.` : '')), ephemeral: true });
    }

    // Apparence
    if (id === 'reglm_app') {
      const titre = interaction.fields.getTextInputValue('titre')?.trim() || '';
      const intro = interaction.fields.getTextInputValue('intro')?.trim() || '';
      const couleurRaw = interaction.fields.getTextInputValue('couleur')?.trim() || '';
      const footer = interaction.fields.getTextInputValue('footer')?.trim() || '';
      const label = interaction.fields.getTextInputValue('label')?.trim() || '✅ J\'accepte le règlement';

      const couleur = normalizeColor(couleurRaw);
      if (couleurRaw && !couleur) {
        return interaction.reply({ embeds: [errorEmbed('Couleur invalide', `\`${couleurRaw}\` n'est pas un hex valide. Format attendu : \`#5865F2\``)], ephemeral: true });
      }

      reg.title = titre;
      reg.description = intro;
      reg.color = couleur || '#8B1A1A';
      reg.footer = footer;
      reg.acceptLabel = label;
      reg.updatedAt = new Date();
      await reg.save();
      return interaction.reply({ ...buildPanel(reg, interaction.guild, '🎨 Apparence enregistrée.'), ephemeral: true });
    }
    // Édition d'une règle
    if (id.startsWith('reglm_edit_')) {
      const i = parseInt(id.replace('reglm_edit_', ''), 10);
      if (!reg.rules[i]) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Cette règle n\'existe plus.')], ephemeral: true });
      reg.rules[i] = interaction.fields.getTextInputValue('texte').trim().slice(0, 1000);
      reg.updatedAt = new Date();
      await reg.save();
      return interaction.reply({ ...buildPanel(reg, interaction.guild, `✏️ Règle #${i + 1} modifiée.`), ephemeral: true });
    }  },

  // Bouton « J'accepte » sur le message publié
  async handleAccept(interaction) {
    const reg = await Reglement.findOne({ guildId: interaction.guildId });
    if (!reg?.acceptRoleId) return interaction.reply({ content: '✅ Règlement accepté !', ephemeral: true });
    if (interaction.member.roles.cache.has(reg.acceptRoleId)) {
      return interaction.reply({ content: '✅ Tu as déjà accepté le règlement.', ephemeral: true });
    }
    await interaction.member.roles.add(reg.acceptRoleId).catch(() => {});
    reg.acceptCount = (reg.acceptCount || 0) + 1;
    await reg.save().catch(() => {});
    return interaction.reply({ content: '✅ Règlement accepté ! Accès débloqué.', ephemeral: true });
  },

  // Rendus réutilisables (Starter Pack publie le règlement avec exactement le
  // même embed que `/reglement`).
  buildReglementEmbed, buildRulesText, buildPanel, normalizeColor, parseBulkRules,

  // Exposés pour les tests
  _internal: { parseBulkRules, normalizeColor, buildReglementEmbed, buildPanel, buildRulesText },
};
