'use strict';
// utils/ticketPanelView.js — 🎫 PANEL UNIQUE du système de tickets.
//
// Une seule interface, ouverte par la commande unique `/ticket` (aucune
// sous-commande). Tout s'y fait, sans jamais taper d'autre commande :
//
//   • Vue d'ensemble  → état réel + complétude + activité
//   • Personnalisation → titre, description, couleur, image, bouton, accueil…
//   • Comportement     → MP, mention, cooldown, archivage, transcripts
//   • Catégories       → ajouter / modifier / supprimer les types de tickets
//   • Support & stats  → console staff : stats, liste, blacklist,
//                        claim / fermer / priorité / ajouter-retirer / transcript
//
// Les vues d'administration exigent « Gérer le serveur » ; la console support
// reste accessible au staff qui n'a que les accès du salon du ticket.
//
// Aucune dépendance à la commande : ce module est appelé par ticket.js et testé
// directement (hors-ligne, modèles et Discord simulés).

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');

const TicketPanel = require('../models/TicketPanel');
const { Ticket, TicketConfig } = require('../models/Ticket');
const engine = require('./ticketEngine');
const cfg    = require('./ticketPanelConfig');
const brand  = require('./brand');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('./embeds');
const { getLimit, isPremium } = require('./premium');

const { BRAND, bar, grade } = brand;
const { PRIORITIES } = engine;

// ── Sessions : un modal (interaction séparée) doit pouvoir rafraîchir le panel
//    d'origine de l'utilisateur. Nettoyées automatiquement à l'expiration.
const SESSION_TTL = 15 * 60 * 1000;
const SESSIONS = new Map();
const keyOf = (userId, guildId) => `${userId}:${guildId}`;
function setSession(interaction, patch) {
  const key = keyOf(interaction.user.id, interaction.guildId);
  SESSIONS.set(key, { ...(SESSIONS.get(key) || {}), at: Date.now(), ...patch });
}
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SESSIONS) if (now - v.at > SESSION_TTL) SESSIONS.delete(k);
}, 60_000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

// ── Petits constructeurs ─────────────────────────────────────────────────────
const row  = (...components) => new ActionRowBuilder().addComponents(...components);
const btn  = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);
const backTo = () => btn('tp_back', 'Vue d\'ensemble', '↩️');

function pickerRow(pending) {
  switch (pending) {
    case 'panel-channel':
      return row(new ChannelSelectMenuBuilder().setCustomId('tp_pick_panel_channel')
        .setPlaceholder('📍 Salon où poster le panel…').setChannelTypes(ChannelType.GuildText));
    case 'archive':
      return row(new ChannelSelectMenuBuilder().setCustomId('tp_pick_archive')
        .setPlaceholder('🗄️ Catégorie d\'archivage…').setChannelTypes(ChannelType.GuildCategory));
    case 'transcript':
      return row(new ChannelSelectMenuBuilder().setCustomId('tp_pick_transcript')
        .setPlaceholder('📄 Salon des transcripts…').setChannelTypes(ChannelType.GuildText));
    case 'cat-role':
      return row(new RoleSelectMenuBuilder().setCustomId('tp_pick_cat_role').setPlaceholder('🎭 Rôle support…'));
    case 'cat-dest':
      return row(new ChannelSelectMenuBuilder().setCustomId('tp_pick_cat_dest')
        .setPlaceholder('📂 Catégorie Discord de destination…').setChannelTypes(ChannelType.GuildCategory));
    case 'cat-fixed':
      return row(new ChannelSelectMenuBuilder().setCustomId('tp_pick_cat_fixed')
        .setPlaceholder('📌 Salon fixe…').setChannelTypes(ChannelType.GuildText));
    case 'ticket-add':
      return row(new UserSelectMenuBuilder().setCustomId('tp_pick_ticket_add').setPlaceholder('👤 Membre à ajouter au ticket…'));
    case 'ticket-remove':
      return row(new UserSelectMenuBuilder().setCustomId('tp_pick_ticket_remove').setPlaceholder('👤 Membre à retirer du ticket…'));
    case 'blacklist-add':
      return row(new UserSelectMenuBuilder().setCustomId('tp_pick_bl_add').setPlaceholder('🚫 Membre à blacklister…'));
    case 'blacklist-remove':
      return row(new UserSelectMenuBuilder().setCustomId('tp_pick_bl_remove').setPlaceholder('✅ Membre à retirer de la blacklist…'));
    case 'ticket-priority':
      return row(new StringSelectMenuBuilder().setCustomId('tp_pick_priority')
        .setPlaceholder('📌 Nouvelle priorité…')
        .addOptions(Object.entries(PRIORITIES).map(([value, p]) => ({
          label: p.label, value, emoji: p.emoji,
        }))));
    default:
      return null;
  }
}

function panelSelect(panels, currentKey) {
  return new StringSelectMenuBuilder()
    .setCustomId('tp_panel')
    .setPlaceholder('🎫 Choisir un panel à configurer…')
    .addOptions(panels.slice(0, 25).map((p, i) => ({
      label: String(p.name ?? p.panelKey ?? `panel ${i + 1}`).slice(0, 100),
      value: String(p.panelKey ?? `t${i + 1}`).slice(0, 100),
      emoji: '🎫',
      description: `${(Array.isArray(p.categories) ? p.categories : []).filter(c => c.enabled).length} catégorie(s) • ${p.stats?.open || 0} ouvert(s)`,
      default: p.panelKey === currentKey,
    })));
}

function viewSelect(view, canManage) {
  const views = canManage ? cfg.PANEL_VIEWS : cfg.PANEL_VIEWS.filter(v => v.value === 'staff');
  return new StringSelectMenuBuilder()
    .setCustomId('tp_view')
    .setPlaceholder('🧭 Naviguer dans le panel…')
    .addOptions(views.map(v => ({ ...v, default: v.value === view })));
}

function fieldSelect(fields, customId) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder('✏️ Que voulez-vous modifier ?')
    .addOptions(fields.map(f => ({ label: f.label, value: f.value, emoji: f.emoji, description: f.description })));
}

function catSelect(cats, currentKey) {
  return new StringSelectMenuBuilder()
    .setCustomId('tp_cat')
    .setPlaceholder('🗂️ Choisir une catégorie…')
    .addOptions(cats.slice(0, 25).map(c => ({
      label: `${c.emoji || '🎫'} ${c.name ?? c.key}`.slice(0, 100),
      value: String(c.key).slice(0, 100),
      description: (c.description || 'Aucune description').slice(0, 100),
      default: c.key === currentKey,
    })));
}

function staffSelect({ inTicket, canManage, blacklistCount }) {
  const options = [];
  if (inTicket) {
    options.push(
      { label: 'Claim / relâcher', value: 'claim', emoji: '✋', description: 'Prendre en charge ou relâcher ce ticket' },
      { label: 'Priorité', value: 'priority', emoji: '📌', description: 'Basse, normale, haute ou urgente' },
      { label: 'Fermer le ticket', value: 'close', emoji: '🔒', description: 'Clôturer le ticket de ce salon' },
      { label: 'Ajouter un membre', value: 'add', emoji: '➕', description: 'Donner l\'accès au ticket' },
      { label: 'Retirer un membre', value: 'remove', emoji: '➖', description: 'Retirer l\'accès au ticket' },
      { label: 'Transcrire le ticket', value: 'transcript', emoji: '📄', description: 'Générer le transcript du salon' },
    );
  } else {
    options.push(
      { label: 'Actualiser', value: 'refresh', emoji: '🔃', description: 'Recharger les statistiques' },
    );
  }
  if (canManage) {
    options.push(
      { label: 'Tous les tickets', value: 'list', emoji: '🗂️', description: 'Liste détaillée (20 derniers)' },
      { label: `Blacklist (${blacklistCount})`, value: 'blacklist-list', emoji: '🚫', description: 'Membres interdits de ticket' },
      { label: 'Blacklister un membre', value: 'blacklist-add', emoji: '⛔', description: 'Interdire l\'ouverture de tickets' },
      { label: 'Retirer de la blacklist', value: 'blacklist-remove', emoji: '✅', description: 'Autoriser de nouveau' },
      { label: 'Resynchroniser le panel', value: 'repost', emoji: '📤', description: 'Régénérer le message public' },
    );
  }
  return new StringSelectMenuBuilder()
    .setCustomId('tp_staff')
    .setPlaceholder('🛠️ Action support…')
    .addOptions(options.slice(0, 25));
}

// ── Embeds : vues du panel ───────────────────────────────────────────────────
const ok = v => (v ? '✅' : '⬜');

function buildEmptyEmbed(guild) {
  return new EmbedBuilder()
    .setColor(BRAND.colors.primary)
    .setAuthor({ name: `${BRAND.name} ${BRAND.emoji.spark}` })
    .setTitle('🎫 Système de tickets — aucun panel')
    .setDescription(
      `Ce serveur n'a encore aucun panel de tickets.\n\n` +
      `**Créez votre premier panel** en un clic : il sera posté dans le salon de votre choix, ` +
      `puis tout se règle ici — sans jamais taper d'autre commande.`,
    )
    .addFields({ name: '🚀 Commencer', value: 'Cliquez sur **Créer un panel** ci-dessous.' })
    .setFooter({ text: brand.footer('Gestion des tickets') })
    .setTimestamp();
}

function buildOverviewView(panel, cats) {
  const list = cats.filter(c => c.enabled);
  const cpl  = cfg.completeness(panel, cats);
  const g    = grade(cpl.percent);

  const embed = new EmbedBuilder()
    .setColor(brand.scoreColor(cpl.percent))
    .setAuthor({ name: `${BRAND.name} ${BRAND.emoji.spark}` })
    .setTitle(`🎫 ${panel.name} — vue d'ensemble`)
    .setDescription([
      `${bar(cpl.percent, { length: 16 })}  ${g.emoji} **${g.label}**`,
      '',
      cpl.todo.length
        ? `🎯 **${cpl.todo.length} réglage(s)** manquent pour un panel complet.`
        : '🏆 **Panel complet** — rien à ajouter, tout est en place.',
    ].join('\n'))
    .addFields(
      { name: '⚙️ Réglages', inline: true, value: [
        `Panel : \`${panel.panelKey}\``,
        `Salon : ${panel.channelId ? `<#${panel.channelId}>` : '*non défini*'}`,
        `Message : ${panel.messageId ? '✅ posté' : '⬜ non posté'}`,
      ].join('\n') },
      { name: '🗂️ Catégories', inline: true, value: [
        `**${list.length}** active(s)`,
        ...list.slice(0, 5).map(c => `• ${c.emoji || '🎫'} ${c.name}`),
        list.length > 5 ? `*…et ${list.length - 5} autre(s)*` : '',
      ].filter(Boolean).join('\n') },
      { name: '📊 Activité', inline: true, value: [
        `Total : **${panel.stats?.total || 0}**`,
        `Ouverts : **${panel.stats?.open || 0}**`,
        `Fermés : **${panel.stats?.closed || 0}**`,
      ].join('\n') },
    );

  if (cpl.todo.length) {
    embed.addFields({
      name: '🎯 À compléter',
      value: cpl.todo.slice(0, 8).map(t => `• **${t.label}** — *${t.hint}*`).join('\n').slice(0, 1024),
    });
  }
  embed.setFooter({ text: brand.footer(`Complétude ${cpl.percent}%`) }).setTimestamp();
  return embed;
}

function buildEmbedView(panel) {
  const color = panel.embedColor || cfg.PANEL_DEFAULTS.embedColor;
  return new EmbedBuilder()
    .setColor(cfg.hexToInt(color, BRAND.colors.primary))
    .setAuthor({ name: `${BRAND.name} ${BRAND.emoji.spark}` })
    .setTitle(`🎨 Personnalisation — ${panel.name}`)
    .setDescription('Choisissez un réglage dans le menu ci-dessous. Chaque modification est immédiate.')
    .addFields(
      { name: '🏷️ Titre',             inline: true, value: (panel.embedTitle || panel.name).slice(0, 100) },
      { name: '🎨 Couleur',           inline: true, value: `#${String(color).replace('0x', '').slice(0, 6)}` },
      { name: '🔘 Bouton',            inline: true, value: `${panel.buttonEmoji || ''} ${panel.buttonLabel || '—'}`.slice(0, 80) },
      { name: '📝 Description',       value: (panel.embedDesc || '—').slice(0, 300) },
      { name: '👋 Message d\'accueil', value: (panel.welcomeMessage || '—').slice(0, 300) },
      { name: '🖼️ Image',             value: panel.embedImage ? `[voir l'image](${panel.embedImage})` : '*aucune*' },
      { name: '🖼️ Miniature',         value: panel.embedThumbnail ? `[voir](${panel.embedThumbnail})` : '*aucune*', inline: true },
      { name: '👤 Auteur',            value: (panel.embedAuthor || '*aucun*').slice(0, 100), inline: true },
      { name: '🕒 Horodatage',        value: panel.embedTimestamp === false ? '⬜ désactivé' : '✅ activé', inline: true },
      { name: '📎 Pied de page',      value: (panel.embedFooter || '*par défaut*').slice(0, 150), inline: true },
      { name: '💬 Message au-dessus', value: (panel.panelContent || '*aucun*').slice(0, 150) },
    )
    .setFooter({ text: brand.footer('Personnalisation du panel') });
}

function buildBehaviorView(panel) {
  return new EmbedBuilder()
    .setColor(BRAND.colors.primary)
    .setAuthor({ name: `${BRAND.name} ${BRAND.emoji.spark}` })
    .setTitle(`⚙️ Comportement — ${panel.name}`)
    .setDescription('Réglages appliqués à l\'ouverture, à la fermeture et à l\'archivage des tickets.')
    .addFields(
      { name: '📬 Notifications', inline: true, value: [
        `${ok(panel.dmUser)} MP à l'ouverture`,
        `${ok(panel.dmOnClose)} MP à la fermeture`,
        `${ok(panel.mentionOnOpen)} Mentionner le rôle support`,
      ].join('\n') },
      { name: '⏱️ Anti-abus', inline: true, value: `Cooldown : **${panel.cooldown || 0}s**` },
      { name: '🗄️ Archivage', value: [
        `Catégorie fermés : ${panel.closeCategoryId ? `<#${panel.closeCategoryId}>` : '*aucune (salon laissé sur place)*'}`,
        `Transcripts : ${panel.transcriptChannelId ? `<#${panel.transcriptChannelId}>` : '*non défini*'}`,
      ].join('\n') },
    )
    .setFooter({ text: brand.footer('Comportement des tickets') });
}

function buildCategoriesView(panel) {
  const cats = panel.categories || [];
  return new EmbedBuilder()
    .setColor(BRAND.colors.primary)
    .setAuthor({ name: `${BRAND.name} ${BRAND.emoji.spark}` })
    .setTitle(`🗂️ Catégories — ${panel.name}`)
    .setDescription(
      cats.length
        ? 'Sélectionnez une catégorie pour la configurer, ou créez-en une nouvelle.'
        : 'Aucune catégorie : créez-en une pour que les membres puissent ouvrir un ticket.',
    )
    .addFields(cats.slice(0, 8).map(c => ({
      name: `${c.emoji || '🎫'} ${c.name}`.slice(0, 250),
      value: [
        `${ok(c.enabled)} ${c.enabled === false ? 'désactivée' : 'active'} • dossier \`${c.channelPrefix}\``,
        `● support ${c.supportRoleId ? `<@&${c.supportRoleId}>` : '*aucun*'} • priorité ${(PRIORITIES[c.defaultPriority] || PRIORITIES.normal).label}`,
        `● destination ${c.targetChannelId ? `<#${c.targetChannelId}>` : (c.targetCategoryId ? `<#${c.targetCategoryId}>` : '*racine*')} • limite ${c.limitPerUser}/membre`,
        `● questions : **${(c.questions || []).length}**`,
      ].join('\n').slice(0, 1024),
    })))
    .setFooter({ text: brand.footer(`${cats.length} catégorie(s)`) });
}

function buildCategoryView(panel, cat) {
  const pr = PRIORITIES[cat.defaultPriority] || PRIORITIES.normal;
  return new EmbedBuilder()
    .setColor(BRAND.colors.primary)
    .setAuthor({ name: `${BRAND.name} ${BRAND.emoji.spark}` })
    .setTitle(`${cat.emoji || '🎫'} ${cat.name} — ${panel.name}`)
    .setDescription('Choisissez un réglage à modifier dans le menu ci-dessous.')
    .addFields(
      { name: '📍 Où vont les tickets', inline: true, value: [
        cat.targetChannelId ? `Salon fixe : <#${cat.targetChannelId}>` : 'Salon fixe : *non*',
        cat.targetCategoryId ? `Créés dans : <#${cat.targetCategoryId}>` : 'Créés dans : *racine du serveur*',
        `Préfixe : \`${cat.channelPrefix}\``,
      ].join('\n') },
      { name: '🎭 Staff & priorité', inline: true, value: [
        `Rôle support : ${cat.supportRoleId ? `<@&${cat.supportRoleId}>` : '*aucun*'}`,
        `Priorité : ${pr.emoji} ${pr.label}`,
        `Auto-claim : ${ok(cat.autoClaim)}`,
      ].join('\n') },
      { name: '🧾 Formulaire', value: [
        `Questions : **${(cat.questions || []).length}**`,
        ...(cat.questions || []).slice(0, 4).map((q, i) => `${i + 1}. ${q.label}`),
      ].join('\n') },
      { name: '🔁 État', value: `${ok(cat.enabled)} ${cat.enabled === false ? 'désactivée (masquée du panel)' : 'active'}` },
    )
    .setFooter({ text: brand.footer('Configuration d\'une catégorie') });
}

function buildStaffView({ stats, tickets, currentTicket, panel, canManage, blacklist }) {
  const embed = new EmbedBuilder()
    .setColor(BRAND.colors.primary)
    .setAuthor({ name: `${BRAND.name} ${BRAND.emoji.spark}` })
    .setTitle('🛠️ Support & statistiques')
    .setDescription(
      canManage
        ? 'Console du système de tickets. Tout se pilote depuis ce message.'
        : 'Vos accès support. Les réglages du système restent réservés aux administrateurs.',
    );

  if (stats) {
    embed.addFields(
      { name: '📊 Tickets', inline: true, value: [
        `Total : **${stats.total}**`,
        `Ouverts : **${stats.open}**`,
        `Fermés : **${stats.closed}**`,
      ].join('\n') },
      { name: '⏱️ En cours', inline: true, value: [
        `Claimes : **${stats.claimed}/${stats.open}**`,
        `Priorité haute : **${stats.urgent}**`,
        `En attente : **${Math.max(0, stats.open - stats.claimed)}**`,
      ].join('\n') },
      { name: '⭐ Satisfaction', inline: true, value: stats.rating === null
        ? '*aucun avis*'
        : `**${stats.rating.toFixed(1)}**/5\n*${stats.ratingCount} avis*` },
    );
  } else {
    embed.addFields({ name: '📊 Statistiques', value: '⚠️ Indisponibles pour le moment (base de données injoignable ?).' });
  }

  if (currentTicket) {
    const pr = PRIORITIES[currentTicket.priority] || PRIORITIES.normal;
    embed.addFields({
      name: `📍 Ce salon — ticket #${String(currentTicket.number).padStart(4, '0')}`,
      value: [
        `Auteur : <@${currentTicket.authorId}>`,
        `Pris en charge : ${currentTicket.claimedBy ? `<@${currentTicket.claimedBy}>` : '*personne*'}`,
        `Priorité : ${pr.emoji} ${pr.label} • Sujet : ${(currentTicket.subject || 'Support').slice(0, 60)}`,
      ].join('\n'),
    });
  } else {
    embed.addFields({
      name: '📍 Ce salon',
      value: 'Pas un ticket ouvert. Ouvrez la vue **Support** depuis un salon de ticket pour agir dessus.',
    });
  }

  if (canManage && tickets.length) {
    embed.addFields({
      name: '🗂️ Derniers tickets',
      value: tickets.slice(0, 8).map(t => {
        const pr = PRIORITIES[t.priority] || PRIORITIES.normal;
        return `${pr.emoji} \`#${String(t.number).padStart(4, '0')}\` **${(t.subject || 'Support').slice(0, 32)}** — <@${t.authorId}>${t.claimedBy ? ` → <@${t.claimedBy}>` : ''}`;
      }).join('\n').slice(0, 1024),
    });
  }
  if (canManage) {
    embed.addFields({
      name: '🚫 Blacklist',
      value: blacklist.length
        ? `${blacklist.length} membre(s) : ${blacklist.slice(0, 6).map(b => `<@${b.userId}>`).join(', ')}${blacklist.length > 6 ? ` *+${blacklist.length - 6}*` : ''}`
        : '*vide*',
    });
  }
  if (panel) {
    embed.setFooter({ text: brand.footer(`Panel ${panel.panelKey} · ${panel.name}`) });
  } else {
    embed.setFooter({ text: brand.footer('Aucun panel — créez-en un dans la vue d\'ensemble') });
  }
  return embed.setTimestamp();
}

// ── Composition des rangées ──────────────────────────────────────────────────
function actionButtons({ post = false, preview = false, back = false }) {
  const b = [];
  if (post)    b.push(btn('tp_post', 'Reposter', '📤', ButtonStyle.Primary));
  if (preview) b.push(btn('tp_preview', 'Aperçu', '👁️'));
  if (back)    b.push(backTo());
  return row(...b);
}

function buildComponents({ state, panels, panel, cats, cat, staff }) {
  const rows = [];
  const canManage = !!state.canManage;
  if (canManage && panels.length) rows.push(row(panelSelect(panels, state.panelKey)));
  rows.push(row(viewSelect(state.view, canManage)));

  let context = null;
  let actions = [];

  if (state.view === 'staff') {
    context = staffSelect({
      inTicket: !!staff.currentTicket,
      canManage,
      blacklistCount: staff.blacklist.length,
    });
    const inTicket = !!staff.currentTicket;
    const claimed = staff.currentTicket && staff.currentTicket.claimedBy === state.userId;
    actions = [row(
      btn('tp_staff_claim', claimed ? 'Relâcher' : 'Claim', claimed ? '↩️' : '✋',
        claimed ? ButtonStyle.Secondary : ButtonStyle.Primary, !inTicket),
      btn('tp_staff_close', 'Fermer', '🔒', ButtonStyle.Danger, !inTicket),
      btn('tp_staff_priority', 'Priorité', '📌', ButtonStyle.Secondary, !inTicket),
      btn('tp_staff_transcript', 'Transcript', '📄', ButtonStyle.Secondary, !inTicket),
    )];
  } else if (!panel) {
    actions = [row(btn('tp_new', panels.length ? 'Nouveau panel' : 'Créer un panel', '🆕', ButtonStyle.Success))];
  } else if (state.view === 'embed') {
    context = fieldSelect(cfg.PANEL_FIELDS, 'tp_field');
    actions = [actionButtons({ post: true, preview: true, back: true })];
  } else if (state.view === 'behavior') {
    context = fieldSelect(cfg.BEHAVIOR_FIELDS, 'tp_behavior');
    actions = [actionButtons({ post: true, back: true })];
  } else if (state.view === 'categories') {
    context = cats.length ? catSelect(cats, state.catKey) : null;
    actions = [row(
      btn('tp_cat_new', 'Nouvelle catégorie', '➕', ButtonStyle.Success),
      btn('tp_post', 'Reposter', '📤', ButtonStyle.Primary),
      backTo(),
    )];
  } else if (state.view === 'category' && cat) {
    context = fieldSelect(cfg.CATEGORY_FIELDS, 'tp_cat_field');
    actions = [row(btn('tp_categories', 'Catégories', '↩️', ButtonStyle.Secondary))];
  } else if (!canManage) {
    actions = [];
  } else {
    actions = [
      row(
        btn('tp_new', 'Nouveau panel', '🆕'),
        btn('tp_post', 'Reposter', '📤', ButtonStyle.Primary),
        btn('tp_preview', 'Aperçu', '👁️'),
      ),
      row(btn('tp_refresh', 'Actualiser', '🔃')),
    ];
  }

  if (state.pending === 'confirm-delete') {
    rows.push(row(
      btn('tp_del_yes', 'Confirmer la suppression', '🗑️', ButtonStyle.Danger),
      btn('tp_cancel', 'Annuler', '✖️'),
    ));
    return rows.slice(0, 5);
  }

  if (state.pending) {
    const picker = pickerRow(state.pending);
    if (picker) {
      rows.push(row(btn('tp_cancel', 'Annuler', '✖️')));
      rows.push(picker);
      return rows.slice(0, 5);
    }
    state.pending = null;
  }

  if (context) rows.push(row(context));
  for (const a of actions) rows.push(a);
  return rows.slice(0, 5);
}

// ── Chargement / rendu ───────────────────────────────────────────────────────
async function collectStats(guildId) {
  try {
    const [total, open, closed, claimed, urgent] = await Promise.all([
      Ticket.countDocuments({ guildId, status: { $ne: 'deleted' } }).exec(),
      Ticket.countDocuments({ guildId, status: 'open' }).exec(),
      Ticket.countDocuments({ guildId, status: 'closed' }).exec(),
      Ticket.countDocuments({ guildId, status: 'open', claimedBy: { $ne: null } }).exec(),
      Ticket.countDocuments({ guildId, status: 'open', priority: { $in: ['high', 'urgent'] } }).exec(),
    ]);
    const agg = await Ticket.aggregate([
      { $match: { guildId, rating: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } },
    ]).exec();
    return { total, open, closed, claimed, urgent, rating: agg[0]?.avg ?? null, ratingCount: agg[0]?.n ?? 0 };
  } catch {
    return null;
  }
}

async function collectTickets(guildId, limit = 20) {
  try {
    return await Ticket.find({ guildId, status: { $ne: 'deleted' } })
      .sort({ createdAt: -1 }).limit(limit).lean().exec();
  } catch { return []; }
}

async function currentTicketOf(guildId, channelId) {
  try {
    return await Ticket.findOne({
      guildId,
      status: 'open',
      $or: [{ channelId }, { 'meta.realChannelId': channelId }],
    }).exec();
  } catch { return null; }
}

async function loadBlacklist(guildId) {
  try {
    const config = await TicketConfig.findOne({ guildId }).lean().exec();
    return config?.blacklist || [];
  } catch { return []; }
}

// ── Normalisation des documents ─────────────────────────────────────────────
// Un panel ou une catégorie hérité / partiel ne doit JAMAIS empêcher
// l'ouverture du panel : Discord refuse un menu dont une option n'a pas de
// valeur, et une simple lecture de champ absent ferait échouer la commande.
function normalizeCategory(cat) {
  if (!cat || typeof cat !== 'object') return null;
  const key = String(cat.key ?? cat.id ?? '').trim().slice(0, 100);
  if (!key) return null; // sans clé, la catégorie n'est ni sélectionnable ni configurable
  // Les anciennes configurations pouvaient contenir un emoji custom : il est
  // remplacé à l'affichage par l'emoji Unicode par défaut du ticket.
  return {
    ...cat,
    key,
    name: String(cat.name ?? key).slice(0, 100),
    emoji: cfg.normalizeEmoji(cat.emoji) || '🎫',
  };
}

function normalizePanel(panel) {
  if (!panel || typeof panel !== 'object') return null;
  const panelKey = String(panel.panelKey ?? panel.key ?? '').trim().slice(0, 100);
  if (!panelKey) return null;
  const categories = (Array.isArray(panel.categories) ? panel.categories : [])
    .map(normalizeCategory).filter(Boolean);
  return { ...panel, panelKey, name: String(panel.name ?? panelKey).slice(0, 100), categories };
}

// Lit les panels du serveur en les rendant sûrs à afficher (documents corrompus
// ou d'une version antérieure inclus). Les entrées irrécupérables sont ignorées
// et signalées dans la console, jamais à l'utilisateur.
async function loadPanels(guildId) {
  const raw = await TicketPanel.find({ guildId }).sort({ panelKey: 1 }).lean().exec();
  if (!Array.isArray(raw)) return [];
  const panels = raw.map(normalizePanel).filter(Boolean);
  if (panels.length !== raw.length) {
    console.warn(`[ticketPanel] ${raw.length - panels.length} panel(s) ignoré(s) : clé (panelKey) manquante`);
  }
  return panels;
}

async function render(guild, state, interaction) {
  const canManage = !!state.canManage;
  const panels = await loadPanels(guild.id);
  let panel = panels.find(p => p.panelKey === state.panelKey) || null;
  if (!panel && panels.length && canManage) {
    panel = panels[0];
    state.panelKey = panel.panelKey;
  }
  // Vues d'administration réservées
  if (!canManage && state.view !== 'staff') state.view = 'staff';
  if (!canManage) state.panelKey = panel?.panelKey || null;

  const cats = Array.isArray(panel?.categories) ? panel.categories : [];
  if (state.catKey && !cats.some(c => c.key === state.catKey)) state.catKey = null;
  const cat = cats.find(c => c.key === state.catKey) || null;
  if (state.view === 'category' && !cat) state.view = panel ? 'categories' : 'staff';
  if (!panel && !['staff', 'overview'].includes(state.view)) state.view = 'overview';

  let staff = { currentTicket: null, blacklist: [], stats: null, tickets: [] };
  if (state.view === 'staff') {
    staff = {
      currentTicket: await currentTicketOf(guild.id, interaction.channelId),
      blacklist: canManage ? await loadBlacklist(guild.id) : [],
      stats: await collectStats(guild.id),
      tickets: canManage ? await collectTickets(guild.id, 20) : [],
    };
  }

  let embed;
  if (state.view === 'staff')        embed = buildStaffView({ ...staff, panel, canManage });
  else if (!panel)                   embed = buildEmptyEmbed(guild);
  else if (state.view === 'embed')   embed = buildEmbedView(panel);
  else if (state.view === 'behavior') embed = buildBehaviorView(panel);
  else if (state.view === 'categories') embed = buildCategoriesView(panel);
  else if (state.view === 'category' && cat) embed = buildCategoryView(panel, cat);
  else                               embed = buildOverviewView(panel, cats);

  const components = buildComponents({ state, panels, panel, cats, cat, staff });
  return { embeds: [embed], components, panel, panels, cats, cat, staff };
}

// ── Écritures ────────────────────────────────────────────────────────────────
async function createPanel(guild, channelId, name) {
  const maxPanels = await getLimit(guild.id, 'ticketPanels').catch(() => Infinity);
  const count = await TicketPanel.countDocuments({ guildId: guild.id }).exec();
  if (Number.isFinite(maxPanels) && count >= maxPanels) {
    return { ok: false, reason: `Limite de **${maxPanels}** panel(s) ${(await isPremium(guild.id)) ? 'premium' : 'gratuit'} atteinte. Supprimez un panel ou débloquez plus de panneaux avec \`/license\`.` };
  }
  const panelKey = await engine.nextPanelKey(guild.id);
  let panel;
  try {
    panel = await TicketPanel.create({
      guildId: guild.id, panelKey,
      name: name || `Support ${count + 1}`,
      channelId,
      embedColor: cfg.PANEL_DEFAULTS.embedColor,
      embedTitle: '', embedDesc: '', welcomeMessage: '',
      categories: [{
        key: 'general',
        name: '🎫 Support général',
        description: 'Toute demande de support',
        channelPrefix: 'ticket',
        defaultPriority: 'normal',
        limitPerUser: 3,
        enabled: true,
      }],
    });
  } catch (err) {
    return { ok: false, reason: `Création impossible : ${err.message}` };
  }
  const message = await engine.postPanel(guild, panel).catch(() => null);
  return { ok: true, panel, message };
}

async function removePanel(guild, panel) {
  if (panel.messageId) {
    const ch = guild.channels.cache.get(panel.channelId);
    const msg = await ch?.messages.fetch(panel.messageId).catch(() => null);
    await msg?.delete().catch(() => {});
  }
  await TicketPanel.deleteOne({ _id: panel._id }).catch(() => {});
}

// ── Modaux (saisie de texte) ─────────────────────────────────────────────────
function modal(id, title, inputs) {
  const m = new ModalBuilder().setCustomId(id).setTitle(String(title).slice(0, 45));
  for (const input of inputs) m.addComponents(row(input));
  return m;
}
function input(id, label, value, { paragraph = false, required = true, max = 200, placeholder = null } = {}) {
  const t = new TextInputBuilder().setCustomId(id).setLabel(String(label).slice(0, 45))
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setValue(value === null || value === undefined ? '' : String(value))
    .setRequired(required).setMaxLength(max);
  if (placeholder) t.setPlaceholder(String(placeholder).slice(0, 100));
  return t;
}

function panelFieldModal(panel, field) {
  switch (field) {
    case 'title':    return modal(`tp_modal_field:title:${panel.panelKey}`, 'Titre du panel', [input('val', 'Titre', panel.embedTitle, { max: 200 })]);
    case 'desc':     return modal(`tp_modal_field:desc:${panel.panelKey}`, 'Description', [input('val', 'Description', panel.embedDesc, { paragraph: true, max: 2000 })]);
    case 'color':    return modal(`tp_modal_field:color:${panel.panelKey}`, 'Couleur (hex)', [input('val', 'Ex : 8B1A1A', String(panel.embedColor || '').replace('0x', ''), { max: 7 })]);
    case 'image':    return modal(`tp_modal_field:image:${panel.panelKey}`, 'Image du panel', [input('val', 'URL de l\'image', panel.embedImage, { required: false, max: 400, placeholder: 'Laisser vide pour retirer' })]);
    case 'button':   return modal(`tp_modal_field:button:${panel.panelKey}`, 'Bouton du panel', [
      input('label', 'Texte du bouton', panel.buttonLabel, { max: 80 }),
      input('emoji', 'Emoji (optionnel)', panel.buttonEmoji || '', { required: false, max: 10 }),
    ]);
    case 'welcome':  return modal(`tp_modal_field:welcome:${panel.panelKey}`, 'Message d\'accueil', [input('val', 'Variables : {user} {guild} {category}', panel.welcomeMessage, { paragraph: true, max: 1000 })]);
    case 'rename':   return modal(`tp_modal_field:rename:${panel.panelKey}`, 'Renommer le panel', [input('val', 'Nom du panel', panel.name, { max: 60 })]);
    case 'cooldown': return modal(`tp_modal_field:cooldown:${panel.panelKey}`, 'Cooldown par membre', [input('val', 'Secondes (0 = aucun)', String(panel.cooldown || 0), { max: 5 })]);
    case 'author':     return modal(`tp_modal_field:author:${panel.panelKey}`, 'Auteur de l\'embed', [input('val', 'Texte au-dessus du titre', panel.embedAuthor, { required: false, max: 200, placeholder: 'Laisser vide pour retirer' })]);
    case 'authoricon': return modal(`tp_modal_field:authoricon:${panel.panelKey}`, 'Icône de l\'auteur', [input('val', 'URL de l\'icône', panel.embedAuthorIcon, { required: false, max: 400 })]);
    case 'footer':     return modal(`tp_modal_field:footer:${panel.panelKey}`, 'Pied de page', [input('val', 'Texte du footer', panel.embedFooter, { required: false, max: 1000, placeholder: 'Vide = signature REZO' })]);
    case 'footericon': return modal(`tp_modal_field:footericon:${panel.panelKey}`, 'Icône du footer', [input('val', 'URL de l\'icône', panel.embedFooterIcon, { required: false, max: 400 })]);
    case 'thumbnail':  return modal(`tp_modal_field:thumbnail:${panel.panelKey}`, 'Miniature', [input('val', 'URL de la miniature', panel.embedThumbnail, { required: false, max: 400 })]);
    case 'content':    return modal(`tp_modal_field:content:${panel.panelKey}`, 'Message au-dessus', [input('val', 'Texte hors embed', panel.panelContent, { paragraph: true, required: false, max: 1000, placeholder: 'Vide pour retirer' })]);
    default:         return null;
  }
}

function categoryFieldModal(panel, cat, field) {
  const id = `tp_modal_cat:${field}:${panel.panelKey}:${cat.key}`;
  switch (field) {
    case 'rename':      return modal(id, 'Renommer la catégorie', [input('val', 'Nom affiché', cat.name, { max: 80 })]);
    case 'emoji':       return modal(id, 'Emoji de la catégorie', [input('val', 'Emoji', cat.emoji, { max: 10 })]);
    case 'description': return modal(id, 'Description', [input('val', 'Texte du menu', cat.description, { max: 100 })]);
    case 'prefix':      return modal(id, 'Préfixe des salons', [input('val', 'Ex : support', cat.channelPrefix, { max: 15 })]);
    case 'priority':    return modal(id, 'Priorité par défaut', [input('val', 'low / normal / high / urgent', cat.defaultPriority, { max: 6 })]);
    case 'limit':       return modal(id, 'Limite par membre', [input('val', '0 = illimité', String(cat.limitPerUser), { max: 2 })]);
    case 'questions':   return modal(id, 'Questions du formulaire', [input('val', 'Séparées par | (max 5)', cfg.questionsToText(cat.questions), { paragraph: true, required: false, max: 400, placeholder: 'Votre pseudo ? | Décrivez le problème' })]);
    default:            return null;
  }
}

// ── Autorisations support ────────────────────────────────────────────────────
function canManageGuild(interaction) {
  const perms = interaction?.member?.permissions;
  if (typeof perms?.has !== 'function') return false;
  try { return !!perms.has(PermissionFlagsBits.ManageGuild) || !!perms.has('ManageGuild'); } catch { return false; }
}

function staffPermission(interaction, ticket, panel) {
  if (!ticket) return { ok: false, reason: 'Ce salon n\'est pas un ticket ouvert.' };
  const realChannelId = ticket.meta?.realChannelId || ticket.channelId;
  if (interaction.channelId && realChannelId && interaction.channelId !== realChannelId) {
    return { ok: false, reason: 'Vous devez être dans le salon du ticket pour agir dessus.' };
  }
  if (canManageGuild(interaction)) return { ok: true };
  if (ticket.authorId === interaction.user.id) return { ok: true };
  if (ticket.claimedBy && ticket.claimedBy === interaction.user.id) return { ok: true };
  const cat = (panel?.categories || []).find(c => c.key === ticket.catKey);
  if (cat?.supportRoleId && interaction.member?.roles?.cache?.has?.(cat.supportRoleId)) return { ok: true };
  return { ok: false, reason: 'Vous n\'avez pas les droits pour agir sur ce ticket.' };
}

async function addUserToTicket(guild, ticket, userId, add) {
  const realChannelId = ticket.meta?.realChannelId || ticket.channelId;
  const ch = guild.channels.cache.get(realChannelId);
  if (!ch) return { ok: false, reason: 'Salon du ticket introuvable.' };
  try {
    await ch.permissionOverwrites.edit(userId, add
      ? { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }
      : { ViewChannel: false, SendMessages: false, ReadMessageHistory: false });
    return { ok: true, channel: ch };
  } catch (err) {
    return { ok: false, reason: `Permissions : ${err.message}` };
  }
}

// ── Traitement d'un composant du panel ───────────────────────────────────────
async function handleComponent(i, state, guild) {
  const id = i.customId;
  const canManage = !!state.canManage;

  // ── Navigation (autorisations revues au rendu) ─────────────────────────────
  if (id === 'tp_view') {
    const wanted = i.values[0];
    if (wanted !== 'staff' && !canManage) return { handled: false, denied: true };
    state.view = wanted; state.pending = null;
    return { changed: true };
  }
  if (id === 'tp_back')    { state.view = canManage ? 'overview' : 'staff'; state.catKey = null; state.pending = null; return { changed: true }; }
  if (id === 'tp_refresh') { return { changed: true }; }
  if (id === 'tp_cancel')  { state.pending = null; return { changed: true }; }
  if (id === 'tp_categories') { state.view = 'categories'; state.pending = null; return { changed: true }; }
  if (id === 'tp_panel')   { state.panelKey = i.values[0]; state.view = 'overview'; state.catKey = null; state.pending = null; return { changed: true }; }
  if (id === 'tp_cat')     { state.catKey = i.values[0]; state.view = 'category'; state.pending = null; return { changed: true }; }

  // ── Console support (accessible au staff sans « Gérer le serveur ») ───────
  if (id === 'tp_staff' || id.startsWith('tp_staff_')) {
    return handleStaffAction(i, state, guild);
  }

  // À partir d'ici : réservé aux gestionnaires.
  if (!canManage) return { handled: false, denied: true };

  // Création de panel : ne dépend d'aucun panel existant.
  if (id === 'tp_new') { state.pending = 'panel-channel'; return { changed: true }; }
  if (id === 'tp_pick_panel_channel' && !state.panelKey) {
    const res = await createPanel(guild, i.values[0], null);
    state.pending = null;
    if (res.ok) {
      state.panelKey = res.panel.panelKey;
      state.view = 'overview';
      state.notice = `✅ Panel **${res.panel.name}** créé${res.message ? ' et posté' : ''}. Configurez-le maintenant !`;
    } else {
      state.notice = `⚠️ ${res.reason}`;
    }
    return { changed: true };
  }

  const panel = await TicketPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).exec();
  if (!panel) return { changed: true };

  if (id === 'tp_field') {
    if (i.values[0] === 'channel') { state.pending = 'panel-channel'; return { changed: true }; }
    if (i.values[0] === 'timestamp') {
      panel.embedTimestamp = panel.embedTimestamp === false;
      await panel.save();
      await engine.postPanel(guild, panel).catch(() => {});
      return { changed: true };
    }
    const m = panelFieldModal(panel, i.values[0]);
    if (m) { await i.showModal(m); return { handled: true }; }
    return { changed: false };
  }

  if (id === 'tp_behavior') {
    const choice = i.values[0];
    switch (choice) {
      case 'dmopen':   panel.dmUser        = !panel.dmUser;        await panel.save(); return { changed: true };
      case 'dmclose':  panel.dmOnClose     = !panel.dmOnClose;     await panel.save(); return { changed: true };
      case 'mention':  panel.mentionOnOpen = !panel.mentionOnOpen; await panel.save(); return { changed: true };
      case 'cooldown': await i.showModal(panelFieldModal(panel, 'cooldown')); return { handled: true };
      case 'archive':  state.pending = 'archive';    return { changed: true };
      case 'transcript': state.pending = 'transcript'; return { changed: true };
    }
    return { changed: false };
  }

  if (id === 'tp_cat_field') {
    const cat = (panel.categories || []).find(c => c.key === state.catKey);
    if (!cat) return { changed: true };
    const choice = i.values[0];
    if (choice === 'role')  { state.pending = 'cat-role';  return { changed: true }; }
    if (choice === 'dest')  { state.pending = 'cat-dest';  return { changed: true }; }
    if (choice === 'fixed') { state.pending = 'cat-fixed'; return { changed: true }; }
    if (choice === 'autoclaim') { cat.autoClaim = !cat.autoClaim; await panel.save(); return { changed: true }; }
    if (choice === 'enabled')   { cat.enabled = cat.enabled === false; await panel.save(); await engine.postPanel(guild, panel).catch(() => {}); return { changed: true }; }
    if (choice === 'delete') {
      if ((panel.categories || []).length <= 1) {
        state.notice = 'Un panel doit conserver au moins une catégorie.';
        return { changed: true };
      }
      panel.categories = panel.categories.filter(c => c.key !== cat.key);
      state.catKey = null;
      state.view = 'categories';
      await panel.save();
      await engine.postPanel(guild, panel).catch(() => {});
      return { changed: true };
    }
    const m = categoryFieldModal(panel, cat, choice);
    if (m) { await i.showModal(m); return { handled: true }; }
    return { changed: false };
  }

  if (id === 'tp_cat_new') {
    await i.showModal(modal(`tp_modal_newcat:${panel.panelKey}`, 'Nouvelle catégorie', [
      input('name', 'Nom de la catégorie', '', { max: 80, placeholder: 'Bug, Achat, Partenariat…' }),
      input('desc', 'Description', '', { required: false, max: 100 }),
      input('prefix', 'Préfixe des salons', 'ticket', { max: 15 }),
      input('emoji', 'Emoji', '🎫', { required: false, max: 10 }),
    ]));
    return { handled: true };
  }

  if (id === 'tp_post') {
    const msg = await engine.postPanel(guild, panel).catch(() => null);
    state.notice = msg ? '✅ Panel mis à jour.' : '⚠️ Impossible de poster : vérifiez le salon et vos permissions.';
    return { changed: true };
  }
  if (id === 'tp_preview') {
    await i.reply({ embeds: [engine.buildPanelEmbed(panel)], ephemeral: true }).catch(() => {});
    return { handled: true };
  }
  if (id === 'tp_del')     { state.pending = 'confirm-delete'; return { changed: true }; }
  if (id === 'tp_del_yes') {
    await removePanel(guild, panel);
    state.panelKey = null; state.pending = null; state.view = 'overview'; state.catKey = null;
    state.notice = '🗑️ Panel supprimé (les tickets ouverts ne sont pas affectés).';
    return { changed: true };
  }

  const pick = { 'tp_pick_archive': 'closeCategoryId', 'tp_pick_transcript': 'transcriptChannelId' }[id];
  if (pick) {
    panel[pick] = i.values[0];
    await panel.save();
    state.pending = null;
    return { changed: true };
  }

  if (id === 'tp_pick_panel_channel') {
    if (panel.messageId) {
      const oldCh = guild.channels.cache.get(panel.channelId);
      const oldMsg = await oldCh?.messages.fetch(panel.messageId).catch(() => null);
      await oldMsg?.delete().catch(() => {});
      panel.messageId = null;
    }
    panel.channelId = i.values[0];
    await panel.save();
    const msg = await engine.postPanel(guild, panel).catch(() => null);
    state.notice = msg ? `✅ Panel posté dans <#${panel.channelId}>.` : '⚠️ Post impossible dans ce salon (permissions ?).';
    state.pending = null;
    return { changed: true };
  }

  if (id === 'tp_pick_cat_role' || id === 'tp_pick_cat_dest' || id === 'tp_pick_cat_fixed') {
    const cat = (panel.categories || []).find(c => c.key === state.catKey);
    if (cat) {
      if (id === 'tp_pick_cat_role')  cat.supportRoleId    = i.values[0];
      if (id === 'tp_pick_cat_dest')  { cat.targetCategoryId = i.values[0]; cat.targetChannelId = null; }
      if (id === 'tp_pick_cat_fixed') { cat.targetChannelId  = i.values[0]; }
      await panel.save();
    }
    state.pending = null;
    return { changed: true };
  }

  return { changed: false };
}

// ── Console support ──────────────────────────────────────────────────────────
async function handleStaffAction(i, state, guild) {
  const id = i.customId;
  const canManage = !!state.canManage;
  const choice = id === 'tp_staff' ? i.values[0] : id.replace('tp_staff_', '');

  // Actions réservées aux gestionnaires
  const adminOnly = ['list', 'blacklist-list', 'blacklist-add', 'blacklist-remove', 'repost'];
  if (adminOnly.includes(choice) && !canManage) return { handled: false, denied: true };

  if (choice === 'refresh') return { changed: true };

  if (choice === 'list') {
    const tickets = await collectTickets(guild.id, 20);
    const embed = tickets.length
      ? new EmbedBuilder()
        .setColor(COLORS.primary)
        .setAuthor({ name: `${BRAND.name} • Tickets` })
        .setTitle('🗂️ Tickets récents')
        .setDescription(tickets.map(t => {
          const pr = PRIORITIES[t.priority] || PRIORITIES.normal;
          const state2 = t.status === 'open' ? '🟢' : '🔴';
          return `${state2} ${pr.emoji} \`#${String(t.number).padStart(4, '0')}\` **${(t.subject || 'Support').slice(0, 34)}**\n   <@${t.authorId}> • <t:${Math.floor(new Date(t.createdAt).getTime() / 1000)}:R>${t.claimedBy ? ` • <@${t.claimedBy}>` : ''}`;
        }).join('\n').slice(0, 4000))
        .setFooter({ text: `${tickets.length} ticket(s) · REZO` })
        .setTimestamp()
      : infoEmbed('Aucun ticket', 'Aucun ticket enregistré pour le moment.');
    await i.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    return { handled: true };
  }

  if (choice === 'blacklist-list') {
    const blacklist = await loadBlacklist(guild.id);
    const embed = blacklist.length
      ? new EmbedBuilder()
        .setColor(COLORS.warning)
        .setAuthor({ name: `${BRAND.name} • Blacklist` })
        .setTitle('🚫 Blacklist des tickets')
        .setDescription(blacklist.map(b => `<@${b.userId}> — *${b.reason || 'Aucune raison'}* (${new Date(b.at || 0).toLocaleDateString('fr-FR')})`).join('\n').slice(0, 2000))
        .setTimestamp()
      : infoEmbed('Blacklist vide', 'Aucun membre blacklisté.');
    await i.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    return { handled: true };
  }

  if (choice === 'blacklist-add')    { state.pending = 'blacklist-add';    return { changed: true }; }
  if (choice === 'blacklist-remove') { state.pending = 'blacklist-remove'; return { changed: true }; }

  if (choice === 'repost') {
    const panel = await TicketPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).exec();
    if (!panel) { state.notice = '⚠️ Aucun panel à resynchroniser.'; return { changed: true }; }
    const msg = await engine.postPanel(guild, panel).catch(() => null);
    state.notice = msg ? '✅ Panel public resynchronisé.' : '⚠️ Impossible de reposter le panel.';
    return { changed: true };
  }

  if (choice === 'add')    { state.pending = 'ticket-add';    return { changed: true }; }
  if (choice === 'remove') { state.pending = 'ticket-remove'; return { changed: true }; }
  if (choice === 'priority') { state.pending = 'ticket-priority'; return { changed: true }; }

  // Actions sur le ticket courant
  const ticket = await currentTicketOf(guild.id, i.channelId);
  const panel = await TicketPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).lean().exec();
  const perm = staffPermission(i, ticket, panel);
  if (!perm.ok) { state.notice = `⚠️ ${perm.reason}`; return { changed: true }; }

  if (choice === 'claim') {
    if (ticket.claimedBy && ticket.claimedBy !== i.user.id) {
      state.notice = `⚠️ Déjà pris en charge par <@${ticket.claimedBy}>.`;
      return { changed: true };
    }
    if (ticket.claimedBy === i.user.id) {
      ticket.claimedBy = null;
      await ticket.save().catch(() => {});
      state.notice = '↩️ Prise en charge relâchée.';
    } else {
      ticket.claimedBy = i.user.id;
      if (panel?.categories) {
        const cat = panel.categories.find(c => c.key === ticket.catKey);
        if (cat?.autoClaim === false) { /* rien de plus */ }
      }
      await ticket.save().catch(() => {});
      await i.channel?.setTopic(`Ticket #${ticket.number} — Claim par ${i.user.tag}`).catch(() => {});
      state.notice = `✋ Ticket #${ticket.number} pris en charge.`;
    }
    return { changed: true };
  }

  if (choice === 'close') {
    const res = await engine.closeTicket(i, i.client, { reason: null });
    state.notice = res.ok ? `🔒 Ticket #${ticket.number} fermé.` : `⚠️ ${res.reason}`;
    return { changed: true };
  }

  if (choice === 'transcript') {
    let url = null;
    const file = await engine.generateTranscript(i.client, guild, ticket, i.channel).catch(() => null);
    if (file) {
      const { AttachmentBuilder } = require('discord.js');
      const attachment = new AttachmentBuilder(file, { name: `transcript-${ticket.number}.html` });
      const target = panel?.transcriptChannelId
        ? await guild.channels.fetch(panel.transcriptChannelId).catch(() => null)
        : i.channel;
      const sent = await target?.send({ content: `📄 Transcript du ticket **#${ticket.number}**`, files: [attachment] }).catch(() => null);
      url = sent?.url || null;
    }
    state.notice = url ? `📄 Transcript généré : ${url}` : '⚠️ Transcript impossible à générer.';
    return { changed: true };
  }

  return { changed: false };
}

// Picks utilisateur de la console support
async function handleStaffPick(i, state, guild) {
  const id = i.customId;
  const userId = i.values[0];

  if (id === 'tp_pick_priority') {
    const ticket = await currentTicketOf(guild.id, i.channelId);
    if (!ticket) { state.notice = '⚠️ Aucun ticket dans ce salon.'; state.pending = null; return { changed: true }; }
    ticket.priority = i.values[0];
    await ticket.save().catch(() => {});
    const pr = PRIORITIES[i.values[0]] || PRIORITIES.normal;
    await i.channel?.setTopic(`Ticket #${ticket.number} — Priorité : ${pr.label}`).catch(() => {});
    state.pending = null;
    state.notice = `📌 Priorité : ${pr.emoji} ${pr.label}.`;
    return { changed: true };
  }

  if (id === 'tp_pick_ticket_add' || id === 'tp_pick_ticket_remove') {
    const ticket = await currentTicketOf(guild.id, i.channelId);
    const panel = await TicketPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).lean().exec();
    const perm = staffPermission(i, ticket, panel);
    state.pending = null;
    if (!perm.ok) { state.notice = `⚠️ ${perm.reason}`; return { changed: true }; }
    const res = await addUserToTicket(guild, ticket, userId, id === 'tp_pick_ticket_add');
    state.notice = res.ok
      ? `${id === 'tp_pick_ticket_add' ? '➕ Membre ajouté' : '➖ Membre retiré'} : <@${userId}>.`
      : `⚠️ ${res.reason}`;
    return { changed: true };
  }

  if (id === 'tp_pick_bl_add' || id === 'tp_pick_bl_remove') {
    state.pending = null;
    if (!state.canManage) return { handled: false, denied: true };
    const config = await engine.getOrCreateConfig(guild.id).catch(() => null);
    if (!config) { state.notice = '⚠️ Configuration inaccessible.'; return { changed: true }; }
    if (id === 'tp_pick_bl_add') {
      if (config.blacklist.some(b => b.userId === userId)) { state.notice = `⚠️ <@${userId}> est déjà blacklisté.`; return { changed: true }; }
      config.blacklist.push({ userId, reason: 'Depuis la console support', byId: i.user.id, at: Date.now() });
      await config.save().catch(() => {});
      state.notice = `🚫 <@${userId}> ne pourra plus ouvrir de ticket.`;
    } else {
      const before = config.blacklist.length;
      config.blacklist = config.blacklist.filter(b => b.userId !== userId);
      await config.save().catch(() => {});
      state.notice = before !== config.blacklist.length
        ? `✅ <@${userId}> peut de nouveau ouvrir des tickets.`
        : `⚠️ <@${userId}> n'était pas blacklisté.`;
    }
    return { changed: true };
  }

  return { changed: false };
}

// ── Application d'un modal (interaction séparée) ─────────────────────────────
function noticeFor(action) {
  return {
    title: '🏷️ Titre mis à jour', desc: '📝 Description mise à jour', color: '🎨 Couleur mise à jour',
    image: '🖼️ Image mise à jour', button: '🔘 Bouton mis à jour', welcome: '👋 Message d\'accueil mis à jour',
    rename: '✏️ Panel renommé', cooldown: '⏱️ Cooldown mis à jour',
    author: '👤 Auteur mis à jour', authoricon: '🖼️ Icône d\'auteur mise à jour',
    footer: '📎 Pied de page mis à jour', footericon: '🖼️ Icône du footer mise à jour',
    thumbnail: '🖼️ Miniature mise à jour', content: '💬 Message au-dessus mis à jour',
    emoji: '😀 Emoji mis à jour', description: '📝 Description mise à jour', prefix: '🏷️ Préfixe mis à jour',
    priority: '📌 Priorité mise à jour', limit: '🔢 Limite mise à jour', questions: '❓ Questions mises à jour',
  }[action] || '✅ Modification enregistrée';
}

async function applyModal(interaction, guild) {
  const parts = interaction.customId.replace('tp_modal_', '').split(':');

  if (parts[0] === 'newpanel') {
    const channelId = parts[1];
    const name = cfg.clampText(interaction.fields.getTextInputValue('val'), 60, { fallback: null });
    const res = await createPanel(guild, channelId, name);
    return res.ok
      ? { notice: `✅ Panel **${res.panel.name}** créé${res.message ? ' et posté' : ''}. Configurez-le maintenant !`, panelKey: res.panel.panelKey }
      : { notice: `⚠️ ${res.reason}` };
  }

  if (parts[0] === 'newcat') {
    const panelKey = parts[1];
    const panel = await TicketPanel.findOne({ guildId: guild.id, panelKey }).exec();
    if (!panel) return { notice: '⚠️ Panel introuvable.' };
    const maxCats = Math.max(await getLimit(guild.id, 'ticketCategories').catch(() => 10), 10);
    if ((panel.categories || []).length >= maxCats) return { notice: `⚠️ Maximum **${maxCats}** catégories par panel.` };
    const name = cfg.clampText(interaction.fields.getTextInputValue('name'), 80, { fallback: 'Support' });
    const description = cfg.clampText(interaction.fields.getTextInputValue('desc'), 100);
    const prefix = cfg.sanitizePrefix(interaction.fields.getTextInputValue('prefix'));
    const emoji = cfg.normalizeEmoji(interaction.fields.getTextInputValue('emoji')) || '🎫';
    let key, tries = 0;
    do { key = Math.random().toString(36).slice(2, 8); tries++; }
    while ((panel.categories || []).some(c => c.key === key) && tries < 20);
    panel.categories.push({ key, name: `${emoji} ${name}`.slice(0, 80), emoji, description, channelPrefix: prefix, defaultPriority: 'normal', limitPerUser: 3, enabled: true });
    await panel.save();
    await engine.postPanel(guild, panel).catch(() => {});
    return { notice: `✅ Catégorie **${name}** ajoutée.`, panelKey, catKey: key, view: 'category' };
  }

  if (parts[0] === 'field') {
    const [, field, panelKey] = parts;
    const panel = await TicketPanel.findOne({ guildId: guild.id, panelKey }).exec();
    if (!panel) return { notice: '⚠️ Panel introuvable.' };
    const val = interaction.fields.getTextInputValue('val') ?? '';
    switch (field) {
      case 'title':    panel.embedTitle = cfg.clampText(val, 200, { fallback: '' }); break;
      case 'desc':     panel.embedDesc  = cfg.clampText(val, 2000, { fallback: '' }); break;
      case 'color': {
        const hex = cfg.normalizeHex(val);
        if (!hex) return { notice: '⚠️ Couleur invalide. Utilisez un code hex comme `8B1A1A`.' };
        panel.embedColor = hex; break;
      }
      case 'image': {
        const url = String(val || '').trim();
        if (url && !/^https?:\/\/\S+$/i.test(url)) return { notice: '⚠️ URL invalide (elle doit commencer par http).' };
        panel.embedImage = url.slice(0, 400); break;
      }
      case 'button': {
        panel.buttonLabel = cfg.clampText(interaction.fields.getTextInputValue('label'), 80, { fallback: 'Ouvrir un ticket' });
        try { panel.buttonEmoji = cfg.normalizeEmoji(interaction.fields.getTextInputValue('emoji')) || ''; } catch { panel.buttonEmoji = ''; }
        break;
      }
      case 'welcome':  panel.welcomeMessage = cfg.clampText(val, 1000, { fallback: '' }); break;
      case 'rename':   panel.name = cfg.clampText(val, 60, { fallback: panel.name }); break;
      case 'cooldown': panel.cooldown = cfg.clampCooldown(val); break;
      case 'author':     panel.embedAuthor = cfg.clampText(val, 200, { fallback: '' }); break;
      case 'footer':     panel.embedFooter = cfg.clampText(val, 1000, { fallback: '' }); break;
      case 'content':    panel.panelContent = cfg.clampText(val, 1000, { fallback: '' }); break;
      case 'authoricon':
      case 'footericon':
      case 'thumbnail': {
        const url = String(val || '').trim();
        if (url && !/^https?:\/\/\S+$/i.test(url)) return { notice: '⚠️ URL invalide (elle doit commencer par http).' };
        if (field === 'authoricon') panel.embedAuthorIcon = url.slice(0, 400);
        if (field === 'footericon') panel.embedFooterIcon = url.slice(0, 400);
        if (field === 'thumbnail')  panel.embedThumbnail = url.slice(0, 400);
        break;
      }
      default: return { notice: '⚠️ Champ inconnu.' };
    }
    await panel.save();
    return { notice: noticeFor(field), panelKey, view: 'embed' };
  }

  if (parts[0] === 'cat') {
    const [, field, panelKey, catKey] = parts;
    const panel = await TicketPanel.findOne({ guildId: guild.id, panelKey }).exec();
    if (!panel) return { notice: '⚠️ Panel introuvable.' };
    const cat = (panel.categories || []).find(c => c.key === catKey);
    if (!cat) return { notice: '⚠️ Catégorie introuvable.' };
    const val = interaction.fields.getTextInputValue('val') ?? '';
    switch (field) {
      case 'rename':      cat.name = cfg.clampText(val, 80, { fallback: cat.name }); break;
      case 'emoji':       cat.emoji = cfg.normalizeEmoji(val) || cat.emoji; break;
      case 'description': cat.description = cfg.clampText(val, 100, { fallback: '' }); break;
      case 'prefix':      cat.channelPrefix = cfg.sanitizePrefix(val); break;
      case 'priority': {
        const v = String(val || '').toLowerCase().trim();
        if (!cfg.isValidPriority(v)) return { notice: '⚠️ Priorité invalide : `low`, `normal`, `high` ou `urgent`.' };
        cat.defaultPriority = v; break;
      }
      case 'limit':       cat.limitPerUser = cfg.clampInt(val, 0, 10, 3); break;
      case 'questions':   cat.questions = cfg.parseQuestions(val); break;
      default: return { notice: '⚠️ Champ inconnu.' };
    }
    await panel.save();
    if (['rename', 'emoji'].includes(field)) await engine.postPanel(guild, panel).catch(() => {});
    return { notice: noticeFor(field), panelKey, catKey, view: 'category' };
  }

  return { notice: '⚠️ Action inconnue.' };
}

// ════════════════════════════════════════════════════════════════════════════
//  ENTRÉE : ouverture du panel
// ════════════════════════════════════════════════════════════════════════════
async function openPanel(interaction, client) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const guild = interaction.guild;
  const canManage = canManageGuild(interaction);
  const state = {
    panelKey: null,
    view: canManage ? 'overview' : 'staff',
    catKey: null,
    pending: null,
    notice: null,
    canManage,
    userId: interaction.user.id,
  };

  const first = await render(guild, state, interaction);
  const reply = await interaction.editReply({ embeds: first.embeds, components: first.components });
  if (!reply) return;
  // Instance conservée : un message éphémère n'est pas récupérable par ID.
  setSession(interaction, {
    message: reply,
    messageId: reply.id || interaction.message?.id,
    channelId: reply.channelId || interaction.channelId,
    panelKey: state.panelKey, view: state.view, catKey: state.catKey,
  });

  const col = reply.createMessageComponentCollector({
    filter: i => i.user.id === interaction.user.id,
    time:   15 * 60 * 1000,
  });

  col.on('collect', async i => {
    try {
      let res;
      if (i.customId.startsWith('tp_pick_bl_') || i.customId.startsWith('tp_pick_ticket_') || i.customId === 'tp_pick_priority') {
        res = await handleStaffPick(i, state, guild);
      } else {
        res = await handleComponent(i, state, guild);
      }
      if (res.handled) return;

      if (res.denied) {
        return i.reply({
          embeds: [errorEmbed('Accès refusé', 'Cette section est réservée aux membres ayant **Gérer le serveur**.')],
          ephemeral: true,
        }).catch(() => {});
      }

      const out = await render(guild, state, i);
      await i.update({ embeds: out.embeds, components: out.components }).catch(() => {});
      setSession(interaction, {
        message: i.message,
        messageId: i.message?.id, channelId: i.message?.channelId,
        panelKey: state.panelKey, view: state.view, catKey: state.catKey,
      });

      if (state.notice) {
        const notice = state.notice;
        state.notice = null;
        await i.followUp({ embeds: [infoEmbed('Information', notice)], ephemeral: true }).catch(() => {});
      }
    } catch (err) {
      console.error('[TicketPanel] collect:', err);
      const payload = { embeds: [errorEmbed('Erreur', 'Impossible d\'appliquer ce réglage pour le moment.')], ephemeral: true };
      if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
      else await i.reply(payload).catch(() => {});
    }
  });

  col.on('end', () => {
    SESSIONS.delete(keyOf(interaction.user.id, interaction.guildId));
    interaction.editReply({ components: [] }).catch(() => {});
  });
}

// Applique un modal puis rafraîchit le panel de l'utilisateur (les modaux ne
// passent pas par le collecteur du message : on retrouve le message par session).
async function handlePanelModal(interaction, client) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const guild = interaction.guild;

  let result;
  try {
    result = await applyModal(interaction, guild);
  } catch (err) {
    console.error('[TicketPanel] modal:', err);
    return interaction.editReply({ embeds: [errorEmbed('Erreur', 'Modification impossible pour le moment.')] }).catch(() => {});
  }

  const key = keyOf(interaction.user.id, interaction.guildId);
  const sess = SESSIONS.get(key) || {};
  if (result.panelKey !== undefined) sess.panelKey = result.panelKey;
  if (result.catKey !== undefined)   sess.catKey   = result.catKey;
  if (result.view !== undefined)     sess.view     = result.view;
  SESSIONS.set(key, { ...sess, at: Date.now() });

  if (sess.message || (sess.messageId && sess.channelId)) {
    try {
      const fresh = {
        panelKey: sess.panelKey, view: sess.view, catKey: sess.catKey,
        pending: null, notice: null, canManage: true, userId: interaction.user.id,
      };
      const out = await render(guild, fresh, interaction);

      if (sess.message && typeof sess.message.edit === 'function') {
        await sess.message.edit({ embeds: out.embeds, components: out.components }).catch(() => {});
      } else {
        const ch = guild.channels.cache.get(sess.channelId) || await guild.channels.fetch(sess.channelId).catch(() => null);
        const msg = await ch?.messages.fetch(sess.messageId).catch(() => null);
        await msg?.edit({ embeds: out.embeds, components: out.components }).catch(() => {});
      }

      sess.panelKey = fresh.panelKey; sess.view = fresh.view; sess.catKey = fresh.catKey;
      SESSIONS.set(key, { ...sess, at: Date.now() });
    } catch (err) { console.error('[TicketPanel] refresh:', err.message); }
  }

  const embed = /⚠️/.test(result.notice || '')
    ? errorEmbed('Non appliqué', String(result.notice).replace('⚠️', '').trim())
    : successEmbed('Enregistré', result.notice || 'Modification enregistrée.');
  return interaction.editReply({ embeds: [embed] }).catch(() => {});
}

module.exports = {
  openPanel,
  handlePanelModal,
  // Exposé pour la suite de tests : rendu et composition purs (aucune I/O).
  __testables: {
    buildEmptyEmbed, buildOverviewView, buildEmbedView, buildBehaviorView,
    buildCategoriesView, buildCategoryView, buildStaffView, buildComponents,
    panelFieldModal, categoryFieldModal, noticeFor, staffSelect, pickerRow,
    viewSelect, panelSelect, catSelect, canManageGuild, staffPermission,
    normalizePanel, normalizeCategory,
  },
};
