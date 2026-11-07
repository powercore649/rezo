'use strict';
// utils/ticketEngine.js — Moteur du systeme de tickets v4

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType, PermissionFlagsBits,
  TextInputBuilder, TextInputStyle, ModalBuilder,
} = require('discord.js');
const { COLORS, BRAND_FOOTER, successEmbed, errorEmbed } = require('./embeds');
const { Ticket, TicketConfig } = require('../models/Ticket');
const TicketPanel = require('../models/TicketPanel');

const PRIORITIES = {
  low:    { emoji: '🟢', label: 'Basse',   color: 0x2ECC71 },
  normal: { emoji: '🔵', label: 'Normale', color: 0x3498DB },
  high:   { emoji: '🟠', label: 'Haute',   color: 0xF39C12 },
  urgent: { emoji: '🔴', label: 'Urgente', color: 0xE74C3C },
};

// ─── Cle de panel unique ──────────────────────────────────────────────────────

async function nextPanelKey(guildId) {
  // Plus petit identifiant libre : robuste aux suppressions (sinon t2 puis
  // suppression de t1 redonnerait t2 en collision).
  const existing = await TicketPanel.find({ guildId }).select('panelKey -_id').lean().exec();
  const used = new Set(existing.map(p => p.panelKey));
  let n = 1;
  while (used.has(`t${n}`)) n++;
  return `t${n}`;
}

// ─── Post / rafraichir un panel ───────────────────────────────────────────────

async function postPanel(guild, panel) {
  const target = guild.channels.cache.get(panel.channelId);
  if (!target || target.type !== ChannelType.GuildText) return null;

  const embed = buildPanelEmbed(panel);
  const rows  = buildPanelRows(panel);

  const existing = panel.messageId
    ? await target.messages.fetch(panel.messageId).catch(() => null)
    : null;

  if (existing) {
    await existing.edit({ content: panel.panelContent || '', embeds: [embed], components: rows }).catch(() => {});
    return { url: existing.url, id: existing.id };
  }

  const sent = await target.send({ content: panel.panelContent || undefined, embeds: [embed], components: rows }).catch(() => null);
  if (!sent) return null;

  panel.messageId = sent.id;
  await panel.save().catch(() => {});
  return { url: sent.url, id: sent.id };
}

function buildPanelEmbed(panel) {
  const color = (panel.embedColor || '0x3498DB').replace('0x', '').padStart(6, '0');
  const embed = new EmbedBuilder()
    .setColor(parseInt(color, 16) || 0x3498DB)
    .setTitle(panel.embedTitle || panel.name)
    .setDescription(panel.embedDesc || 'Selectionnez une categorie ci-dessous pour ouvrir un ticket.');

  // Apparence complète : auteur, footer et miniature sont optionnels et ne
  // doivent jamais produire d'URL vide (Discord refuse une icône invalide).
  if (panel.embedAuthor) {
    const author = { name: String(panel.embedAuthor).slice(0, 256) };
    if (/^https?:\/\//i.test(panel.embedAuthorIcon || '')) author.iconURL = panel.embedAuthorIcon;
    embed.setAuthor(author);
  }

  if (panel.embedFooter) {
    const footer = { text: String(panel.embedFooter).slice(0, 2048) };
    if (/^https?:\/\//i.test(panel.embedFooterIcon || '')) footer.iconURL = panel.embedFooterIcon;
    embed.setFooter(footer);
  } else {
    embed.setFooter({ text: BRAND_FOOTER || 'REZO' });
  }

  if (/^https?:\/\//i.test(panel.embedThumbnail || '')) embed.setThumbnail(panel.embedThumbnail);
  if (panel.embedImage) embed.setImage(panel.embedImage);
  if (panel.embedTimestamp !== false) embed.setTimestamp();
  return embed;
}

function buildPanelRows(panel) {
  const cats = panel.categories.filter(c => c.enabled);
  if (!cats.length) return [];

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ticket_open:${panel.panelKey}`)
    .setPlaceholder('Choisissez une categorie')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(cats.map(c => ({
      label: `${c.emoji || '🎫'} ${c.name}`.slice(0, 100),
      value: c.key,
      description: (c.description || 'Ouvrir un ticket').slice(0, 100),
    })));

  return [new ActionRowBuilder().addComponents(menu)];
}

// ─── Modal d'ouverture ────────────────────────────────────────────────────────

async function showOpenModal(interaction, panel, cat) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket_submit:${panel.panelKey}:${cat.key}`)
    .setTitle(`${panel.name} — ${cat.name}`.slice(0, 45));

  const rows = [];

  if (cat.questions && cat.questions.length > 0) {
    cat.questions.slice(0, 5).forEach((q, idx) => {
      rows.push(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(`q_${idx}`)
          .setLabel(q.label.slice(0, 45))
          .setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(q.required !== false)
          .setMaxLength(q.maxLength || 1000),
      ));
    });
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('q_sujet')
        .setLabel('Sujet de votre demande')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(200),
    ));
  }

  modal.addComponents(rows);
  await interaction.showModal(modal);
}

// ─── Cree un ticket ───────────────────────────────────────────────────────────

async function createTicket(interaction, client, { panel, cat, answers, subject }) {
  const guild = interaction.guild;

  // Cooldown
  if (panel.cooldown > 0) {
    const now = Date.now();
    const cd  = await TicketConfig.findOne({ guildId: guild.id }).exec();
    if (cd) {
      const last = (cd.lastTicketOpen || {})[interaction.user.id] || 0;
      if (now - last < panel.cooldown * 1000) {
        const wait = Math.ceil((panel.cooldown * 1000 - (now - last)) / 1000);
        return { ok: false, reason: `Attendez encore **${wait}s** avant d'ouvrir un nouveau ticket.` };
      }
      if (!cd.lastTicketOpen) cd.lastTicketOpen = {};
      cd.lastTicketOpen[interaction.user.id] = now;
      // Chemin Mixed : sans markModified, l'horodatage ne serait jamais écrit.
      cd.markModified('lastTicketOpen');
      await cd.save().catch(() => {});
    }
  }

  // Limite par utilisateur
  const catCfg = panel.categories.find(c => c.key === cat.key);
  if (catCfg && catCfg.limitPerUser > 0) {
    const openCount = await Ticket.countDocuments({
      guildId: guild.id,
      authorId: interaction.user.id,
      panelKey: panel.panelKey,
      status: 'open',
    }).exec();
    if (openCount >= catCfg.limitPerUser) {
      return { ok: false, reason: `Vous avez atteint la limite de **${catCfg.limitPerUser}** ticket(s) ouvert(s).` };
    }
  }

  // Destination
  let targetCategoryId = catCfg?.targetCategoryId || null;
  let fixedChannelId   = catCfg?.targetChannelId  || null;

  if (fixedChannelId) {
    const fixedCh = guild.channels.cache.get(fixedChannelId);
    if (!fixedCh) fixedChannelId = null;
  }

  if (!fixedChannelId && targetCategoryId) {
    const catObj = await guild.channels.fetch(targetCategoryId).catch(() => null);
    if (!catObj || catObj.type !== ChannelType.GuildCategory) targetCategoryId = null;
  }

  const num        = await nextTicketNumber(guild.id);
  const newChannel = await createTicketChannel(guild, fixedChannelId, targetCategoryId, catCfg, panel, num, interaction.user);
  if (!newChannel) return { ok: false, reason: 'Impossible de creer le salon du ticket.' };

  const ticket = await Ticket.create({
    guildId:  guild.id,
    channelId: newChannel.id,
    authorId:  interaction.user.id,
    panelKey:  panel.panelKey,
    catKey:    cat.key,
    subject:   subject || 'Nouveau ticket',
    status:    'open',
    priority:  catCfg?.defaultPriority || 'normal',
    number:    num,
  });

  // Message de bienvenue dans le salon
  const welcomeMsg = (panel.welcomeMessage || '')
    .replace('{user}',     `<@${interaction.user.id}>`)
    .replace('{guild}',    guild.name)
    .replace('{category}', cat.name);

  const closeBtns = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_close_btn_${ticket._id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_claim_${ticket._id}`).setLabel('Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_priority_${ticket._id}`).setLabel('Priorite').setStyle(ButtonStyle.Secondary),
  );

  await newChannel.send({
    content: `<@${interaction.user.id}>${catCfg?.supportRoleId ? ` <@&${catCfg.supportRoleId}>` : ''}`,
    embeds: [new EmbedBuilder()
      .setColor(0x3498DB)
      .setTitle(`Ticket #${String(num).padStart(4, '0')} — ${cat.name}`)
      .setDescription(welcomeMsg || `Bonjour <@${interaction.user.id}>, merci d'ouvrir un ticket.\nUn staff vous repondra dans les plus brefs delais.`)
      .setTimestamp()],
    components: [closeBtns],
  }).catch(() => {});

  // DM de confirmation
  if (panel.dmUser) {
    interaction.user.send({
      embeds: [new EmbedBuilder().setColor(0x2ECC71)
        .setTitle('Ticket ouvert')
        .setDescription(`Votre ticket **#${num}** dans **${guild.name}** est disponible : <#${newChannel.id}>`)
        .setTimestamp()],
    }).catch(() => {});
  }

  return { ok: true, number: num, channel: newChannel, ticket };
}

async function nextTicketNumber(guildId) {
  const doc = await TicketConfig.findOneAndUpdate(
    { guildId },
    { $inc: { ticketCounter: 1 }, $setOnInsert: { guildId } },
    { upsert: true, new: true },
  ).exec();
  return doc.ticketCounter || 1;
}

async function createTicketChannel(guild, fixedChannelId, parentCategoryId, catCfg, panel, num, user) {
  // Si salon fixe, on l'utilise directement
  if (fixedChannelId) {
    return guild.channels.cache.get(fixedChannelId) || null;
  }

  const prefix = catCfg?.channelPrefix || 'ticket';
  const name   = `${prefix}-${String(num).padStart(4, '0')}`;

  const perms = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  if (catCfg?.supportRoleId) {
    perms.push({ id: catCfg.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  return guild.channels.create({
    name,
    type:                ChannelType.GuildText,
    parent:              parentCategoryId || null,
    permissionOverwrites: perms,
    topic:               `Ticket #${num} — ${panel.name}`,
    reason:              `Ticket ouvert par ${user.username}`,
  }).catch(err => { console.error('[ticketEngine] createChannel:', err.message); return null; });
}

// ─── Ferme un ticket ─────────────────────────────────────────────────────────

async function closeTicket(interaction, client, { reason }) {
  const ticket = await findTicketInChannel(interaction);
  if (!ticket) return { ok: false, reason: "Ce salon n'est pas un ticket ouvert." };

  ticket.status      = 'closed';
  ticket.closedAt    = new Date();
  ticket.closedBy    = interaction.user.id;
  ticket.closeReason = reason || null;
  await ticket.save().catch(() => {});

  const closedEmbed = new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle('Ticket ferme')
    .setDescription(`Ferme par **${interaction.user.tag}**${reason ? `\nRaison : ${reason}` : ''}.`)
    .setTimestamp();

  const reopenRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_reopen_${ticket._id}`).setLabel('Reuvrir').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_delete_${ticket._id}`).setLabel('Supprimer').setStyle(ButtonStyle.Danger),
  );

  await interaction.channel?.send({ embeds: [closedEmbed], components: [reopenRow] }).catch(() => {});

  // Sondage de satisfaction : alimente la note moyenne affichée dans la console
  // support (sans lui, `Ticket.rating` ne serait jamais renseigné).
  const rateRow = new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map(n => new ButtonBuilder()
      .setCustomId(`ticket_rate_${ticket._id}_${n}`)
      .setLabel(String(n))
      .setEmoji('⭐')
      .setStyle(n >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary)),
  );
  await interaction.channel?.send({
    content: '⭐ **Votre avis compte** — comment s\'est passé ce support ?',
    components: [rateRow],
  }).catch(() => {});

  // Archivage ou suppression
  const panel = await TicketPanel.findOne({ guildId: ticket.guildId, panelKey: ticket.panelKey }).lean().exec();
  if (panel?.closeCategoryId) {
    const archiveCat = interaction.guild.channels.cache.get(panel.closeCategoryId);
    if (archiveCat && archiveCat.type === ChannelType.GuildCategory) {
      const ticketCh = interaction.guild.channels.cache.get(ticket.channelId);
      await ticketCh?.setParent(archiveCat, { lockPermissions: false }).catch(() => {});
    }
  }

  // DM fermeture
  if (panel?.dmOnClose) {
    const author = await client.users.fetch(ticket.authorId).catch(() => null);
    author?.send({
      embeds: [new EmbedBuilder().setColor(0xE74C3C)
        .setTitle('Ticket ferme')
        .setDescription(`Votre ticket **#${ticket.number}** a ete ferme${reason ? `.\nRaison : ${reason}` : '.'}`)
        .setTimestamp()],
    }).catch(() => {});
  }

  return { ok: true, ticket };
}

// ─── Reuvrir un ticket ────────────────────────────────────────────────────────

async function reopenTicket(interaction, client, ticketId) {
  const ticket = await Ticket.findById(ticketId).exec();
  if (!ticket) return { ok: false, reason: 'Ticket introuvable.' };
  if (ticket.status === 'open') return { ok: false, reason: 'Ce ticket est deja ouvert.' };

  ticket.status      = 'open';
  ticket.closedAt    = null;
  ticket.closedBy    = null;
  ticket.closeReason = null;
  await ticket.save().catch(() => {});

  return { ok: true, ticket };
}

// ─── Supprimer un ticket ──────────────────────────────────────────────────────

async function deleteTicket(interaction, client, ticketId) {
  const ticket = await Ticket.findById(ticketId).exec();
  if (!ticket) return { ok: false, reason: 'Ticket introuvable.' };

  const ticketCh = interaction.guild.channels.cache.get(ticket.channelId);
  if (ticketCh) await ticketCh.delete('Ticket supprime').catch(() => {});

  await ticket.deleteOne().catch(() => {});
  return { ok: true, ticket };
}

// ─── Trouver un ticket dans le salon courant ──────────────────────────────────

async function findTicketInChannel(interaction) {
  return Ticket.findOne({
    guildId: interaction.guild.id,
    $or: [
      { channelId: interaction.channel.id },
      { 'meta.realChannelId': interaction.channel.id },
    ],
    status: 'open',
  }).exec();
}

// ─── Transcript simple ────────────────────────────────────────────────────────

async function generateTranscript(client, guild, ticket, channel) {
  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const ts = t => new Date(t).toLocaleString('fr-FR');
  const lines = [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    '<style>body{font-family:sans-serif;padding:16px} .meta{color:#888;font-size:12px}</style>',
    '</head><body>',
    `<h1>Ticket #${ticket.number} — ${ticket.subject || ''}</h1>`,
    `<div class="meta">Ouvert le ${ts(ticket.createdAt)} • ${guild.name}</div>`,
    ticket.closedAt ? `<div class="meta">Ferme le ${ts(ticket.closedAt)}</div>` : '',
    '<hr>',
    '<p><em>Transcript genere automatiquement.</em></p>',
    '</body></html>',
  ];

  const dir  = path.join(os.tmpdir(), 'rezo-tickets');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `transcript-${ticket.number}.html`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  PRIORITIES,
  nextPanelKey,
  postPanel,
  buildPanelEmbed,
  buildPanelRows,
  showOpenModal,
  createTicket,
  closeTicket,
  reopenTicket,
  deleteTicket,
  findTicketInChannel,
  generateTranscript,
  getOrCreateConfig: async (guildId) => {
    return TicketConfig.findOneAndUpdate(
      { guildId },
      { $setOnInsert: { guildId } },
      { upsert: true, new: true },
    ).exec();
  },
};
