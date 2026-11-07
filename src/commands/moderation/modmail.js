'use strict';
// commands/modmail.js — Système ModMail complet et configurable
// Flux : Utilisateur envoie DM au bot → thread créé dans une catégorie → staff répond → transcript à la fermeture

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
} = require('discord.js');

const {
  ModMailConfig,
  ModMailThread,
  ModMailCounter,
  ModMailCooldown,
} = require('../../models/ModMail');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getConfig(guildId) {
  return ModMailConfig.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true }
  );
}

async function nextNumber(guildId) {
  const doc = await ModMailCounter.findOneAndUpdate(
    { guildId },
    { $inc: { count: 1 } },
    { upsert: true, new: true }
  );
  return doc.count;
}

// ─── Embed d'un message entrant (dans le salon staff) ────────────────────────
function buildIncomingEmbed(user, content, attachments = []) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: `${user.username}`, iconURL: user.displayAvatarURL({ size: 64 }) })
    .setDescription(content || '*[Message sans texte]*')
    .setFooter({ text: `ID: ${user.id}` })
    .setTimestamp();
  if (attachments.length > 0) {
    embed.addFields({ name: `📎 Pièces jointes (${attachments.length})`, value: attachments.map((a, i) => `[Fichier ${i + 1}](${a})`).join('\n') });
  }
  return embed;
}

// ─── Embed d'une réponse staff (dans le DM utilisateur) ──────────────────────
function buildStaffReplyEmbed(guild, staffMember, content, anonymous) {
  return new EmbedBuilder()
    .setColor(COLORS.success)
    .setAuthor({
      name: anonymous ? `Staff de ${guild.name}` : `${staffMember.user.username} • Staff`,
      iconURL: anonymous ? (guild.iconURL({ dynamic: true }) || undefined) : staffMember.user.displayAvatarURL({ size: 64 }),
    })
    .setDescription(content)
    .setFooter({ text: `${guild.name} • ModMail` })
    .setTimestamp();
}

// ─── Générer le transcript texte ─────────────────────────────────────────────
function generateTranscript(thread, user, guild) {
  const lines = [
    `═══════════════════════════════════════════`,
    `  TRANSCRIPT MODMAIL — ${guild.name}`,
    `═══════════════════════════════════════════`,
    `Ticket #${thread.number}`,
    `Utilisateur : ${user?.tag || thread.userId} (${thread.userId})`,
    `Ouvert le   : ${new Date(thread.openedAt).toLocaleString('fr-FR')}`,
    `Fermé le    : ${thread.closedAt ? new Date(thread.closedAt).toLocaleString('fr-FR') : 'N/A'}`,
    `Fermé par   : ${thread.closedBy || 'N/A'}`,
    `Raison      : ${thread.closeReason || 'Aucune'}`,
    `───────────────────────────────────────────`,
    '',
  ];

  for (const msg of thread.messages) {
    const time   = new Date(msg.sentAt).toLocaleTimeString('fr-FR');
    const author = msg.fromStaff
      ? `[STAFF${msg.anonymous ? ' ANONYME' : ''}] ${msg.authorTag}`
      : `[USER] ${msg.authorTag}`;
    lines.push(`[${time}] ${author}`);
    if (msg.content) lines.push(`  ${msg.content}`);
    if (msg.attachments?.length) lines.push(`  📎 ${msg.attachments.join(', ')}`);
    lines.push('');
  }

  lines.push(`═══════════════════════════════════════════`);
  return lines.join('\n');
}

// ─── Ouvrir un thread ModMail (appelé depuis messageCreate) ──────────────────
async function openThread(client, message, guildId) {
  const config = await ModMailConfig.findOne({ guildId, enabled: true });
  if (!config) return null;

  // Cooldown
  const now = Date.now();
  const cd  = await ModMailCooldown.findOne({ userId: message.author.id, guildId });
  if (cd) {
    const elapsed = now - new Date(cd.lastOpen).getTime();
    if (elapsed < config.cooldownSeconds * 1000) {
      const remainS = Math.ceil((config.cooldownSeconds * 1000 - elapsed) / 1000);
      await message.author.send({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('⏳ Veuillez patienter')
          .setDescription(`Vous pourrez ouvrir un nouveau ticket dans **${remainS}s**.`)],
      }).catch(() => {});
      return null;
    }
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  // Vérifier qu'il n'y a pas déjà un thread ouvert
  const existing = await ModMailThread.findOne({ guildId, userId: message.author.id, status: 'open' });
  if (existing) {
    // Rediriger le message vers le thread existant
    await relayToThread(client, message, existing, config, guild);
    return existing;
  }

  // Créer le salon dans la catégorie
  const num     = await nextNumber(guildId);
  const name    = `${config.channelPrefix}${message.author.username}-${num}`.slice(0, 100).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const perms   = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.user.id,          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (config.staffRoleId) {
    perms.push({ id: config.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: config.categoryId || null,
    permissionOverwrites: perms,
    topic: `ModMail #${num} — ${message.author.username} (${message.author.id})`,
    reason: `ModMail ouvert par ${message.author.username}`,
  }).catch(err => { console.error('ModMail createChannel:', err.message); return null; });

  if (!channel) return null;

  // Créer le thread en BDD
  const thread = await ModMailThread.create({
    guildId,
    userId:    message.author.id,
    channelId: channel.id,
    status:    'open',
    subject:   message.content?.slice(0, 100) || 'Nouveau message',
    number:    num,
  });

  // Mettre à jour le cooldown
  await ModMailCooldown.findOneAndUpdate(
    { userId: message.author.id, guildId },
    { lastOpen: new Date() },
    { upsert: true }
  );

  // Envoyer l'embed d'accueil dans le salon staff
  const attachUrls = [...message.attachments.values()].map(a => a.url);
  const headerEmbed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`📬 ModMail #${num} — Nouveau ticket`)
    .setThumbnail(message.author.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: '👤 Utilisateur',  value: `${message.author.username}\n\`${message.author.id}\``, inline: true },
      { name: '📅 Ouvert le',    value: `<t:${Math.floor(Date.now() / 1000)}:F>`,            inline: true },
      { name: '🔢 Ticket',       value: `#${num}`,                                            inline: true },
    )
    .setFooter({ text: 'Utilisez les boutons ci-dessous pour répondre ou fermer.' });

  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mm_reply_${thread._id}`).setLabel('✉️ Répondre').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`mm_reply_anon_${thread._id}`).setLabel('🎭 Répondre anonymement').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mm_close_${thread._id}`).setLabel('🔒 Fermer').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mm_snippet_${thread._id}`).setLabel('⚡ Snippet').setStyle(ButtonStyle.Success),
  );

  const mentionContent = config.mentionStaff && config.staffRoleId ? `<@&${config.staffRoleId}>` : null;
  await channel.send({ content: mentionContent, embeds: [headerEmbed], components: [controlRow] });

  // Premier message de l'utilisateur
  await channel.send({ embeds: [buildIncomingEmbed(message.author, message.content, attachUrls)] });

  // Centre de notifications — abonnés « ModMail » (staff)
  try {
    const { sendNotification } = require('../../utils/notificationManager');
    await sendNotification(
      client,
      guild.id,
      'modmail',
      new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`📬 ModMail #${num} — nouveau ticket`)
        .setDescription(message.content?.slice(0, 500) || '*Message sans texte*')
        .addFields(
          { name: '👤 Utilisateur', value: `${message.author.tag || message.author.username}` , inline: true },
          { name: '🔢 Ticket',      value: `#${num}`,                                     inline: true },
        )
        .setTimestamp(),
      `ModMail #${num}`,
    );
  } catch (err) { console.error('ModMail notif:', err.message); }

  // Sauvegarder le message dans le thread
  thread.messages.push({
    authorId: message.author.id, authorTag: message.author.username,
    content: message.content || '', attachments: attachUrls,
    fromStaff: false, anonymous: false, sentAt: new Date(),
  });
  await thread.save();

  // DM de confirmation à l'utilisateur
  await message.author.send({
    embeds: [new EmbedBuilder()
      .setColor(COLORS.success)
      .setTitle(`📬 Ticket #${num} ouvert — ${guild.name}`)
      .setDescription(config.welcomeMessage)
      .setThumbnail(guild.iconURL({ dynamic: true }))
      .setFooter({ text: 'Continuez à écrire ici pour envoyer des messages à notre équipe.' })
      .setTimestamp()],
  }).catch(() => {});

  // Log
  if (config.logChannelId) {
    const logCh = guild.channels.cache.get(config.logChannelId);
    logCh?.send({ embeds: [new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('📬 ModMail ouvert')
      .addFields(
        { name: 'Utilisateur', value: `${message.author.username} (${message.author.id})`, inline: true },
        { name: 'Ticket',      value: `#${num}`,                                       inline: true },
        { name: 'Salon',       value: `<#${channel.id}>`,                              inline: true },
      )
      .setTimestamp()] }).catch(() => {});
  }

  return thread;
}

// ─── Relayer un message DM vers le thread existant ────────────────────────────
async function relayToThread(client, message, thread, config, guild) {
  const channel = guild.channels.cache.get(thread.channelId);
  if (!channel) return;

  const attachUrls = [...message.attachments.values()].map(a => a.url);
  await channel.send({ embeds: [buildIncomingEmbed(message.author, message.content, attachUrls)] });

  thread.messages.push({
    authorId: message.author.id, authorTag: message.author.username,
    content: message.content || '', attachments: attachUrls,
    fromStaff: false, anonymous: false, sentAt: new Date(),
  });
  await thread.save();

  // Confirmation DM
  if (config.confirmDM) {
    await message.author.send({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.info)
        .setDescription(`✅ Message envoyé à l'équipe de **${guild.name}**.`)],
    }).catch(() => {});
  }
}

// ─── Fermer un thread ─────────────────────────────────────────────────────────
async function closeThread(client, thread, closedBy, reason, guild, config) {
  thread.status      = 'closed';
  thread.closedAt    = new Date();
  thread.closedBy    = closedBy.username;
  thread.closeReason = reason || null;
  await thread.save();

  // Récupérer l'utilisateur pour le transcript
  const user = await client.users.fetch(thread.userId).catch(() => null);

  // Générer le transcript
  const transcriptText = generateTranscript(thread, user, guild);
  const transcriptBuf  = Buffer.from(transcriptText, 'utf8');
  const attachment     = new AttachmentBuilder(transcriptBuf, { name: `modmail-${thread.number}.txt` });

  // Envoyer le transcript dans les logs
  if (config.logChannelId) {
    const logCh = guild.channels.cache.get(config.logChannelId);
    if (logCh) {
      await logCh.send({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle(`🔒 ModMail #${thread.number} fermé`)
          .addFields(
            { name: 'Utilisateur', value: `${user?.tag || thread.userId} (${thread.userId})`, inline: true },
            { name: 'Fermé par',   value: closedBy.username,                                        inline: true },
            { name: 'Raison',      value: reason || '*Aucune*',                                inline: true },
            { name: 'Durée',       value: `${Math.round((Date.now() - new Date(thread.openedAt).getTime()) / 60000)} min`, inline: true },
            { name: 'Messages',    value: `${thread.messages.length}`,                         inline: true },
          )
          .setTimestamp()],
        files: [attachment],
      }).catch(() => {});
    }
  }

  // DM de fermeture à l'utilisateur
  if (user) {
    await user.send({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle(`🔒 Ticket #${thread.number} fermé — ${guild.name}`)
        .setDescription(config.closeMessage)
        .addFields(reason ? [{ name: 'Raison', value: reason }] : [])
        .setTimestamp()],
      files: [new AttachmentBuilder(Buffer.from(transcriptText, 'utf8'), { name: `transcript-${thread.number}.txt` })],
    }).catch(() => {});
  }

  // Supprimer le salon après 5s
  const channel = guild.channels.cache.get(thread.channelId);
  if (channel) {
    await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.warning)
        .setTitle('🔒 Ticket fermé')
        .setDescription(`Fermé par **${closedBy.username}**${reason ? `\nRaison : ${reason}` : ''}\n\nCe salon sera supprimé dans 5 secondes.`)],
    }).catch(() => {});
    setTimeout(() => channel.delete('ModMail fermé').catch(() => {}), 5_000);
  }
}

// ─── Commande Slash ───────────────────────────────────────────────────────────
const authGate = require('../../utils/authGate');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('modmail')
    .setDescription('📬 Système de ModMail — Messages privés vers le staff')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s
      .setName('config')
      .setDescription('⚙️ Configurer le système ModMail'))
    .addSubcommand(s => s
      .setName('activer')
      .setDescription('🟢 Activer le ModMail'))
    .addSubcommand(s => s
      .setName('desactiver')
      .setDescription('🔴 Désactiver le ModMail'))
    .addSubcommand(s => s
      .setName('fermer')
      .setDescription('🔒 Fermer le ticket de ce salon')
      .addStringOption(o => o.setName('raison').setDescription('Raison de la fermeture')))
    .addSubcommand(s => s
      .setName('repondre')
      .setDescription('✉️ Répondre à l\'utilisateur depuis ce salon')
      .addStringOption(o => o.setName('message').setDescription('Votre réponse').setRequired(true))
      .addBooleanOption(o => o.setName('anonyme').setDescription('Envoyer anonymement ?')))
    .addSubcommand(s => s
      .setName('snippet')
      .setDescription('⚡ Gérer les réponses rapides')
      .addStringOption(o => o
        .setName('action')
        .setDescription('Action')
        .setRequired(true)
        .addChoices(
          { name: '➕ Ajouter', value: 'add' },
          { name: '🗑️ Supprimer', value: 'remove' },
          { name: '📋 Lister', value: 'list' },
        ))
      .addStringOption(o => o.setName('nom').setDescription('Nom du snippet'))
      .addStringOption(o => o.setName('contenu').setDescription('Contenu du snippet')))
    .addSubcommand(s => s
      .setName('info')
      .setDescription('ℹ️ Informations sur ce ticket ModMail'))
    .addSubcommand(s => s
      .setName('blacklist')
      .setDescription('🚫 Blacklister un utilisateur du ModMail')
      .addUserOption(o => o.setName('utilisateur').setDescription('Utilisateur').setRequired(true))
      .addStringOption(o => o.setName('raison').setDescription('Raison'))),

  // ── Exports pour les autres fichiers ───────────────────────────────────
  openThread,
  relayToThread,
  closeThread,
  getConfig,

  async execute(interaction, client) {
    const sub   = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // ── /modmail config ────────────────────────────────────────────────────
    if (sub === 'config') {
      await interaction.deferReply({ ephemeral: true });
      const config = await getConfig(guild.id);
      await showConfigPanel(interaction, config, guild, client);
      return;
    }

    // ── /modmail activer ───────────────────────────────────────────────────
    if (sub === 'activer') {
      await interaction.deferReply({ ephemeral: true });
      const config = await getConfig(guild.id);
      if (!config.categoryId) {
        return interaction.editReply({ embeds: [errorEmbed('Configuration incomplète', 'Définissez d\'abord une catégorie via `/modmail config`.')] });
      }
      config.enabled = true;
      await config.save();
      return interaction.editReply({ embeds: [successEmbed('ModMail activé', 'Les utilisateurs peuvent maintenant envoyer un DM au bot pour ouvrir un ticket.')] });
    }

    // ── /modmail desactiver ────────────────────────────────────────────────
    if (sub === 'desactiver') {
      await interaction.deferReply({ ephemeral: true });
      await ModMailConfig.findOneAndUpdate({ guildId: guild.id }, { enabled: false }, { upsert: true });
      return interaction.editReply({ embeds: [successEmbed('ModMail désactivé', 'Les nouveaux tickets ne seront plus acceptés.')] });
    }

    // ── /modmail fermer ────────────────────────────────────────────────────
    if (sub === 'fermer') {
      await interaction.deferReply();
      const thread = await ModMailThread.findOne({ channelId: interaction.channelId, status: 'open' });
      if (!thread) return interaction.editReply({ embeds: [errorEmbed('Pas de ticket', 'Ce salon n\'est pas un ticket ModMail ouvert.')] });
      const config = await getConfig(guild.id);
      const reason = interaction.options.getString('raison');
      await closeThread(client, thread, interaction.user, reason, guild, config);
      return;
    }

    // ── /modmail repondre ──────────────────────────────────────────────────
    if (sub === 'repondre') {
      await interaction.deferReply();
      const thread = await ModMailThread.findOne({ channelId: interaction.channelId, status: 'open' });
      if (!thread) return interaction.editReply({ embeds: [errorEmbed('Pas de ticket', 'Ce salon n\'est pas un ticket ModMail ouvert.')] });

      const content   = interaction.options.getString('message');
      const anonymous = interaction.options.getBoolean('anonyme') ?? false;
      await sendStaffReply(client, thread, interaction.member, content, anonymous, guild, await getConfig(guild.id));
      return interaction.deleteReply().catch(() => {});
    }

    // ── /modmail snippet ───────────────────────────────────────────────────
    if (sub === 'snippet') {
      await interaction.deferReply({ ephemeral: true });
      const action  = interaction.options.getString('action');
      const config  = await getConfig(guild.id);

      if (action === 'list') {
        if (!config.snippets?.length) return interaction.editReply({ embeds: [errorEmbed('Aucun snippet', 'Utilisez `add` pour en créer.')] });
        const lines = config.snippets.map(s => `\`${s.name}\` → ${s.content.slice(0, 60)}${s.content.length > 60 ? '…' : ''}`).join('\n');
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('⚡ Snippets').setDescription(lines)] });
      }
      if (action === 'add') {
        const nom     = interaction.options.getString('nom');
        const contenu = interaction.options.getString('contenu');
        if (!nom || !contenu) return interaction.editReply({ embeds: [errorEmbed('Paramètres manquants', 'Fournissez `nom` et `contenu`.')] });
        if (config.snippets?.some(s => s.name === nom)) return interaction.editReply({ embeds: [errorEmbed('Déjà existant', `Un snippet \`${nom}\` existe déjà.`)] });
        config.snippets = config.snippets || [];
        config.snippets.push({ name: nom, content: contenu });
        await config.save();
        return interaction.editReply({ embeds: [successEmbed('Snippet ajouté', `\`${nom}\` → ${contenu.slice(0, 80)}`)] });
      }
      if (action === 'remove') {
        const nom = interaction.options.getString('nom');
        if (!nom) return interaction.editReply({ embeds: [errorEmbed('Paramètre manquant', 'Fournissez le `nom` du snippet.')] });
        const before = config.snippets?.length || 0;
        config.snippets = (config.snippets || []).filter(s => s.name !== nom);
        if (config.snippets.length === before) return interaction.editReply({ embeds: [errorEmbed('Introuvable', `Aucun snippet \`${nom}\`.`)] });
        await config.save();
        return interaction.editReply({ embeds: [successEmbed('Snippet supprimé', `\`${nom}\` retiré.`)] });
      }
    }

    // ── /modmail info ──────────────────────────────────────────────────────
    if (sub === 'info') {
      await interaction.deferReply({ ephemeral: true });
      const thread = await ModMailThread.findOne({ channelId: interaction.channelId });
      if (!thread) return interaction.editReply({ embeds: [errorEmbed('Pas un ticket', 'Ce salon n\'est pas lié à un ticket ModMail.')] });
      const user = await client.users.fetch(thread.userId).catch(() => null);
      return interaction.editReply({ embeds: [new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle(`📬 Ticket #${thread.number}`)
        .setThumbnail(user?.displayAvatarURL({ size: 128 }) || null)
        .addFields(
          { name: 'Utilisateur',  value: user ? `${user.username}\n\`${user.id}\`` : `\`${thread.userId}\``, inline: true },
          { name: 'Statut',       value: thread.status === 'open' ? '🟢 Ouvert' : '🔴 Fermé', inline: true },
          { name: 'Ouvert le',    value: `<t:${Math.floor(new Date(thread.openedAt).getTime() / 1000)}:F>`, inline: true },
          { name: 'Messages',     value: `${thread.messages.length}`, inline: true },
          { name: 'Sujet',        value: thread.subject?.slice(0, 100) || '*Aucun*', inline: false },
          ...(thread.closedAt ? [
            { name: 'Fermé le',  value: `<t:${Math.floor(new Date(thread.closedAt).getTime() / 1000)}:F>`, inline: true },
            { name: 'Fermé par', value: thread.closedBy || 'Inconnu', inline: true },
          ] : []),
        )
        .setTimestamp()] });
    }

    // ── /modmail blacklist ─────────────────────────────────────────────────
    if (sub === 'blacklist') {
      await interaction.deferReply({ ephemeral: true });
      const target = interaction.options.getUser('utilisateur');
      const raison = interaction.options.getString('raison') || 'Aucune raison';
      // On set le cooldown à très long terme (10 ans)
      await ModMailCooldown.findOneAndUpdate(
        { userId: target.id, guildId: guild.id },
        { lastOpen: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000) },
        { upsert: true }
      );
      return interaction.editReply({ embeds: [successEmbed('Utilisateur blacklisté', `**${target.tag}** ne pourra plus ouvrir de ticket ModMail.\nRaison : ${raison}`)] });
    }
  },

  // ── Handler boutons (appelé depuis interactionCreate) ──────────────────
  async handleButton(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'ModMail' }))) return;
    const id = interaction.customId;

    // mm_reply_<threadId>
    if (id.startsWith('mm_reply_') && !id.startsWith('mm_reply_anon_')) {
      const threadId = id.replace('mm_reply_', '');
      const thread   = await ModMailThread.findById(threadId);
      if (!thread || thread.status !== 'open') {
        return interaction.reply({ embeds: [errorEmbed('Ticket fermé', 'Ce ticket est déjà fermé.')], ephemeral: true });
      }
      const modal = buildReplyModal(threadId, false);
      return interaction.showModal(modal);
    }

    // mm_reply_anon_<threadId>
    if (id.startsWith('mm_reply_anon_')) {
      const threadId = id.replace('mm_reply_anon_', '');
      const thread   = await ModMailThread.findById(threadId);
      if (!thread || thread.status !== 'open') {
        return interaction.reply({ embeds: [errorEmbed('Ticket fermé', 'Ce ticket est déjà fermé.')], ephemeral: true });
      }
      const modal = buildReplyModal(threadId, true);
      return interaction.showModal(modal);
    }

    // mm_close_<threadId>
    if (id.startsWith('mm_close_')) {
      const threadId = id.replace('mm_close_', '');
      const thread   = await ModMailThread.findById(threadId);
      if (!thread || thread.status !== 'open') {
        return interaction.reply({ embeds: [errorEmbed('Ticket déjà fermé', 'Ce ticket est déjà fermé.')], ephemeral: true });
      }
      // Demander une raison via modal
      const modal = new ModalBuilder()
        .setCustomId(`mm_close_modal_${threadId}`)
        .setTitle('🔒 Fermer le ticket ModMail');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('raison')
            .setLabel('Raison de la fermeture (optionnel)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(500)
            .setPlaceholder('Problème résolu, spam, etc.')
        )
      );
      return interaction.showModal(modal);
    }

    // mm_snippet_<threadId>
    if (id.startsWith('mm_snippet_')) {
      const threadId = id.replace('mm_snippet_', '');
      const thread   = await ModMailThread.findById(threadId);
      if (!thread || thread.status !== 'open') {
        return interaction.reply({ embeds: [errorEmbed('Ticket fermé', 'Ce ticket est déjà fermé.')], ephemeral: true });
      }
      const config = await getConfig(thread.guildId);
      if (!config.snippets?.length) {
        return interaction.reply({ embeds: [errorEmbed('Aucun snippet', 'Créez des snippets avec `/modmail snippet add`.')], ephemeral: true });
      }
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`mm_snippet_select_${threadId}`)
        .setPlaceholder('Choisir un snippet...')
        .addOptions(config.snippets.slice(0, 25).map(s => ({
          label: s.name.slice(0, 100),
          value: s.name,
          description: s.content.slice(0, 100),
        })));
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('⚡ Choisir un snippet').setDescription('Sélectionnez un snippet à envoyer.')],
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true,
      });
    }
  },

  // ── Handler modaux ─────────────────────────────────────────────────────
  async handleModal(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'ModMail' }))) return;
    const id = interaction.customId;

    // Réponse (normal ou anonyme)
    if (id.startsWith('mm_modal_reply_') || id.startsWith('mm_modal_anon_')) {
      const anonymous = id.startsWith('mm_modal_anon_');
      const threadId  = id.replace(anonymous ? 'mm_modal_anon_' : 'mm_modal_reply_', '');
      const content   = interaction.fields.getTextInputValue('content');
      const thread    = await ModMailThread.findById(threadId);
      if (!thread || thread.status !== 'open') {
        return interaction.reply({ embeds: [errorEmbed('Ticket fermé', 'Ce ticket est déjà fermé.')], ephemeral: true });
      }
      const guild  = interaction.guild;
      const config = await getConfig(guild.id);
      await interaction.deferReply({ ephemeral: true });
      await sendStaffReply(client, thread, interaction.member, content, anonymous, guild, config);
      await interaction.editReply({ embeds: [{ color: 0x57F287, description: `✅ Réponse envoyée${anonymous ? ' anonymement' : ''}.` }] });
      return;
    }

    // Fermeture avec raison
    if (id.startsWith('mm_close_modal_')) {
      const threadId = id.replace('mm_close_modal_', '');
      const reason   = interaction.fields.getTextInputValue('raison') || null;
      const thread   = await ModMailThread.findById(threadId);
      if (!thread || thread.status !== 'open') {
        return interaction.reply({ embeds: [errorEmbed('Ticket déjà fermé', '')], ephemeral: true });
      }
      const guild  = interaction.guild;
      const config = await getConfig(guild.id);
      await interaction.deferReply({ ephemeral: true });
      await closeThread(client, thread, interaction.user, reason, guild, config);
      return;
    }

    // Modal config messages
    if (id === 'mm_config_welcome') {
      const msg    = interaction.fields.getTextInputValue('message');
      const prefix = interaction.fields.getTextInputValue('prefix').trim() || 'modmail-';
      const cd     = parseInt(interaction.fields.getTextInputValue('cooldown')) || 300;
      await ModMailConfig.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { welcomeMessage: msg, channelPrefix: prefix, cooldownSeconds: Math.max(0, Math.min(cd, 3600)) },
        { upsert: true }
      );
      const config = await getConfig(interaction.guild.id);
      await interaction.reply({ embeds: [buildConfigEmbed(config, interaction.guild)], components: buildConfigComponents(), ephemeral: true });
      return;
    }

    if (id === 'mm_config_close') {
      const msg = interaction.fields.getTextInputValue('message');
      await ModMailConfig.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { closeMessage: msg },
        { upsert: true }
      );
      const config = await getConfig(interaction.guild.id);
      await interaction.reply({ embeds: [buildConfigEmbed(config, interaction.guild)], components: buildConfigComponents(), ephemeral: true });
      return;
    }
  },

  // ── Handler select menus ───────────────────────────────────────────────
  async handleSelect(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'ModMail' }))) return;
    const id = interaction.customId;

    // Snippet sélectionné
    if (id.startsWith('mm_snippet_select_')) {
      const threadId   = id.replace('mm_snippet_select_', '');
      const snippetName = interaction.values[0];
      const thread     = await ModMailThread.findById(threadId);
      if (!thread || thread.status !== 'open') {
        return interaction.update({ embeds: [errorEmbed('Ticket fermé', '')], components: [] });
      }
      const config  = await getConfig(thread.guildId);
      const snippet = config.snippets?.find(s => s.name === snippetName);
      if (!snippet) return interaction.update({ embeds: [errorEmbed('Snippet introuvable', '')], components: [] });
      await interaction.update({ embeds: [new EmbedBuilder().setColor(COLORS.success).setDescription(`✅ Snippet **${snippetName}** envoyé.`)], components: [] });
      const guild = interaction.guild;
      await sendStaffReply(client, thread, interaction.member, snippet.content, false, guild, config);
      return;
    }

    // Config — sélection catégorie/rôle/salon
    if (id === 'mm_config_action') {
      const action = interaction.values[0];
      const config = await getConfig(interaction.guild.id);

      if (action === 'toggle') {
        if (!config.categoryId) {
          return interaction.reply({ embeds: [errorEmbed('Config incomplète', 'Définissez d\'abord une catégorie.')], ephemeral: true });
        }
        config.enabled = !config.enabled;
        await config.save();
        await interaction.update({ embeds: [buildConfigEmbed(config, interaction.guild)], components: buildConfigComponents() });
        return;
      }
      if (action === 'mention_toggle') {
        config.mentionStaff = !config.mentionStaff;
        await config.save();
        await interaction.update({ embeds: [buildConfigEmbed(config, interaction.guild)], components: buildConfigComponents() });
        return;
      }
      if (action === 'confirm_toggle') {
        config.confirmDM = !config.confirmDM;
        await config.save();
        await interaction.update({ embeds: [buildConfigEmbed(config, interaction.guild)], components: buildConfigComponents() });
        return;
      }
      if (action === 'edit_welcome') {
        const modal = new ModalBuilder().setCustomId('mm_config_welcome').setTitle('✉️ Messages de bienvenue & config');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Message de bienvenue (DM à l\'ouverture)').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(config.welcomeMessage).setMaxLength(1000)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prefix').setLabel('Préfixe des salons (ex: modmail-)').setStyle(TextInputStyle.Short).setRequired(true).setValue(config.channelPrefix).setMaxLength(20)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cooldown').setLabel('Cooldown entre tickets (secondes)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.cooldownSeconds)).setMaxLength(5)),
        );
        return interaction.showModal(modal);
      }
      if (action === 'edit_close') {
        const modal = new ModalBuilder().setCustomId('mm_config_close').setTitle('🔒 Message de fermeture');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Message envoyé en DM à la fermeture').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(config.closeMessage).setMaxLength(1000)),
        );
        return interaction.showModal(modal);
      }
      return;
    }
  },
};

// ─── Envoi d'une réponse staff → DM utilisateur ──────────────────────────────
async function sendStaffReply(client, thread, member, content, anonymous, guild, config) {
  const user = await client.users.fetch(thread.userId).catch(() => null);
  if (!user) return;

  // DM à l'utilisateur
  await user.send({
    embeds: [buildStaffReplyEmbed(guild, member, content, anonymous)],
  }).catch(() => {});

  // Copie dans le salon staff
  const channel = guild.channels.cache.get(thread.channelId);
  if (channel) {
    await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(anonymous ? COLORS.warning : COLORS.success)
        .setAuthor({
          name: anonymous ? `Réponse anonyme` : `${member.user.username}`,
          iconURL: anonymous ? undefined : member.user.displayAvatarURL({ size: 64 }),
        })
        .setDescription(content)
        .setFooter({ text: anonymous ? '🎭 Envoyé anonymement' : '✉️ Réponse envoyée' })
        .setTimestamp()],
    }).catch(() => {});
  }

  // Sauvegarder dans le thread
  thread.messages.push({
    authorId: member.user.id, authorTag: member.user.username,
    content, attachments: [],
    fromStaff: true, anonymous, sentAt: new Date(),
  });
  await thread.save();
}

// ─── Modal de réponse ─────────────────────────────────────────────────────────
function buildReplyModal(threadId, anonymous) {
  const modal = new ModalBuilder()
    .setCustomId(anonymous ? `mm_modal_anon_${threadId}` : `mm_modal_reply_${threadId}`)
    .setTitle(anonymous ? '🎭 Réponse anonyme' : '✉️ Répondre à l\'utilisateur');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('content')
        .setLabel('Votre message')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1900)
        .setPlaceholder('Tapez votre réponse ici...')
    )
  );
  return modal;
}

// ─── Panel de configuration ───────────────────────────────────────────────────
function buildConfigEmbed(config, guild) {
  const ok = v => v ? '🟢' : '🔴';
  return new EmbedBuilder()
    .setColor(config.enabled ? COLORS.success : COLORS.warning)
    .setTitle('📬 Configuration ModMail')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .addFields(
      { name: 'Statut',             value: config.enabled ? '🟢 Activé' : '🔴 Désactivé',                             inline: true },
      { name: 'Catégorie',          value: config.categoryId ? `<#${config.categoryId}>` : '*Non définie*',             inline: true },
      { name: 'Logs',               value: config.logChannelId ? `<#${config.logChannelId}>` : '*Non défini*',          inline: true },
      { name: 'Rôle staff',         value: config.staffRoleId ? `<@&${config.staffRoleId}>` : '*Non défini*',           inline: true },
      { name: 'Préfixe salons',     value: `\`${config.channelPrefix}\``,                                               inline: true },
      { name: 'Cooldown',           value: `${config.cooldownSeconds}s`,                                                inline: true },
      { name: `${ok(config.mentionStaff)} Mention staff`, value: config.mentionStaff ? 'Oui' : 'Non',                  inline: true },
      { name: `${ok(config.confirmDM)} Confirmation DM`,  value: config.confirmDM ? 'Oui' : 'Non',                     inline: true },
      { name: '⚡ Snippets',        value: `${config.snippets?.length || 0} snippet(s)`,                               inline: true },
      { name: '✉️ Message bienvenue', value: config.welcomeMessage.slice(0, 200),                                      inline: false },
      { name: '🔒 Message fermeture', value: config.closeMessage.slice(0, 200),                                        inline: false },
    )
    .setFooter({ text: 'Utilisez le menu pour configurer chaque option' })
    .setTimestamp();
}

function buildConfigComponents() {
  const actionMenu = new StringSelectMenuBuilder()
    .setCustomId('mm_config_action')
    .setPlaceholder('⚙️ Choisir une action...')
    .addOptions([
      { label: '🟢/🔴 Activer / Désactiver',         value: 'toggle',          description: 'Basculer le système ModMail' },
      { label: '✉️ Modifier le message de bienvenue', value: 'edit_welcome',    description: 'Message DM à l\'ouverture + préfixe + cooldown' },
      { label: '🔒 Modifier le message de fermeture', value: 'edit_close',      description: 'Message DM à la fermeture' },
      { label: '🔔 Basculer mention staff',           value: 'mention_toggle',  description: 'Mentionner le rôle staff à chaque ticket' },
      { label: '📨 Basculer confirmation DM',         value: 'confirm_toggle',  description: 'Confirmer en DM chaque message reçu' },
    ]);

  return [new ActionRowBuilder().addComponents(actionMenu)];
}

async function showConfigPanel(interaction, config, guild, client) {
  const embed = buildConfigEmbed(config, guild);
  const reply = await interaction.editReply({
    embeds: [embed],
    components: [
      ...buildConfigComponents(),
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('mm_set_category')
          .setPlaceholder('📁 Catégorie des tickets...')
          .setChannelTypes(ChannelType.GuildCategory)
      ),
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId('mm_set_log')
          .setPlaceholder('📋 Salon de logs...')
          .setChannelTypes(ChannelType.GuildText)
      ),
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('mm_set_role')
          .setPlaceholder('🎭 Rôle staff notifié...')
      ),
    ],
    fetchReply: true,
  });

  const col = reply.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time: 10 * 60 * 1000,
  });

  col.on('collect', async i => {
    const cid = i.customId;

    if (cid === 'mm_set_category') {
      await i.deferUpdate();
      await ModMailConfig.findOneAndUpdate({ guildId: guild.id }, { categoryId: i.values[0] }, { upsert: true });
      const c = await getConfig(guild.id);
      await i.editReply({ embeds: [buildConfigEmbed(c, guild)], components: i.message.components });
      return;
    }
    if (cid === 'mm_set_log') {
      await i.deferUpdate();
      await ModMailConfig.findOneAndUpdate({ guildId: guild.id }, { logChannelId: i.values[0] }, { upsert: true });
      const c = await getConfig(guild.id);
      await i.editReply({ embeds: [buildConfigEmbed(c, guild)], components: i.message.components });
      return;
    }
    if (cid === 'mm_set_role') {
      await i.deferUpdate();
      await ModMailConfig.findOneAndUpdate({ guildId: guild.id }, { staffRoleId: i.values[0] }, { upsert: true });
      const c = await getConfig(guild.id);
      await i.editReply({ embeds: [buildConfigEmbed(c, guild)], components: i.message.components });
      return;
    }
    if (cid === 'mm_config_action') {
      const mod = require('./modmail');
      await mod.handleSelect(i, client);
      return;
    }
  });

  col.on('end', () => {
    interaction.editReply({ components: [] }).catch(() => {});
  });
}
