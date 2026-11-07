'use strict';
// utils/embedStudio.js — 🎨 Studio d'embeds multi-panels.
//
// Chaque serveur peut enregistrer plusieurs embeds (e1, e2, …), les modifier,
// les prévisualiser et les publier/mettre à jour dans un salon. Tout est
// configurable : contenu au-dessus, auteur + icône, titre, description,
// couleur, image, miniature, pied de page + icône, horodatage, jusqu'à 25
// champs (inline ou non) et 25 boutons-liens.
//
// Toute écriture passe par embedStudioConfig (validation pure) : Discord ne
// peut donc jamais recevoir un embed hors limites.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionFlagsBits,
} = require('discord.js');

const EmbedPanel = require('../models/EmbedPanel');
const cfg = require('./embedStudioConfig');
const brand = require('./brand');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('./embeds');

const { BRAND } = brand;
const footerOf = (text) => (typeof brand.footer === 'function' ? brand.footer(text) : `${BRAND?.name || 'REZO'} • ${text}`);

const SESSION_TTL = 15 * 60 * 1000;
const SESSIONS = new Map();
const keyOf = (userId, guildId) => `${userId}:${guildId}`;
const timer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SESSIONS) if (now - v.at > SESSION_TTL) SESSIONS.delete(k);
}, 60_000);
if (typeof timer.unref === 'function') timer.unref();

const row = (...c) => new ActionRowBuilder().addComponents(...c);
const btn = (id, label, emoji, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(disabled);
const input = (id, label, value, { paragraph = false, required = false, max = 200, placeholder = null } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(String(label).slice(0, 45))
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setValue(value === null || value === undefined ? '' : String(value).slice(0, max))
    .setRequired(required).setMaxLength(max);
  if (placeholder) t.setPlaceholder(String(placeholder).slice(0, 100));
  return t;
};
const modal = (id, title, inputs) => {
  const m = new ModalBuilder().setCustomId(id).setTitle(String(title).slice(0, 45));
  for (const i of inputs) m.addComponents(row(i));
  return m;
};

// ── Rendu ────────────────────────────────────────────────────────────────────

function buildEmbed(panel = {}) {
  const embed = new EmbedBuilder().setColor(cfg.hexToInt(panel.color, BRAND?.colors?.primary ?? 0x8B1A1A));

  if (panel.title) embed.setTitle(String(panel.title).slice(0, cfg.LIMITS.title));
  if (panel.description) embed.setDescription(String(panel.description).slice(0, cfg.LIMITS.description));

  if (panel.authorName) {
    const author = { name: String(panel.authorName).slice(0, cfg.LIMITS.author) };
    if (cfg.isHttpUrl(panel.authorIcon)) author.iconURL = String(panel.authorIcon);
    embed.setAuthor(author);
  }

  const footer = { text: panel.footer ? String(panel.footer).slice(0, cfg.LIMITS.footer) : footerOf('Studio d\'embeds') };
  if (cfg.isHttpUrl(panel.footerIcon)) footer.iconURL = String(panel.footerIcon);
  embed.setFooter(footer);

  if (cfg.isHttpUrl(panel.image)) embed.setImage(String(panel.image));
  if (cfg.isHttpUrl(panel.thumbnail)) embed.setThumbnail(String(panel.thumbnail));

  const fields = cfg.normalizeFields(panel.fields);
  if (fields.length) embed.addFields(fields);

  if (!panel.title && !panel.description && !fields.length) {
    embed.setDescription('*Aperçu vide — ajoutez un titre, une description ou des champs.*');
  }
  if (panel.timestamp !== false) embed.setTimestamp();
  return embed;
}

function buildRows(panel = {}) {
  // On conserve l'index d'origine : le customId publié pointe sur la position
  // exacte dans le document, même si un bouton de rôle incomplet est masqué.
  const buttons = cfg.normalizeButtons(panel.buttons)
    .map((b, index) => ({ b, index }))
    .filter(({ b }) => b.type !== 'role' || !!b.roleId);

  const rows = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    const slice = buttons.slice(i, i + 5);
    rows.push(row(...slice.map(({ b, index }) => {
      const style = b.type === 'link' ? ButtonStyle.Link
        : b.type === 'ticket' ? ButtonStyle.Success
        : b.type === 'role' ? ButtonStyle.Primary
        : ButtonStyle.Secondary;
      const button = new ButtonBuilder().setLabel(b.label).setStyle(style);
      if (b.emoji) button.setEmoji(b.emoji);
      if (b.type === 'link') button.setURL(b.url);
      else button.setCustomId(`es_btn:${panel.panelKey || 'e1'}:${index}`);
      return button;
    })));
  }
  return rows;
}

function payloadOf(panel) {
  const p = { embeds: [buildEmbed(panel)], components: buildRows(panel) };
  if (panel.content) p.content = String(panel.content).slice(0, cfg.LIMITS.content);
  return p;
}

// ── Vues ─────────────────────────────────────────────────────────────────────

const ok = (v) => (v ? '✅' : '⬜');

function buildOverview(panel, panels) {
  const cpl = cfg.completeness(panel);
  return new EmbedBuilder()
    .setColor(cfg.hexToInt(panel.color, BRAND?.colors?.primary ?? 0x8B1A1A))
    .setAuthor({ name: `${BRAND?.name || 'REZO'} • Studio d'embeds` })
    .setTitle(`🎨 ${panel.name}`)
    .setDescription([
      `**${panels.length}** embed(s) enregistré(s) sur ce serveur.`,
      `Complétude : **${cpl.percent}%**`,
      '',
      cpl.todo.length ? `À compléter : ${cpl.todo.join(', ')}` : '🏆 Embed complet.',
    ].join('\n'))
    .addFields(
      { name: '🏷️ Titre', value: (panel.title || '*aucun*').slice(0, 120), inline: true },
      { name: '🎨 Couleur', value: `#${String(panel.color || '').replace('0x', '')}`, inline: true },
      { name: '📌 État', value: [
        `${ok(panel.channelId)} Salon : ${panel.channelId ? `<#${panel.channelId}>` : '*non défini*'}`,
        `${ok(panel.messageId)} Publié : ${panel.messageId ? 'oui' : 'non'}`,
        `${ok(panel.timestamp !== false)} Horodatage`,
      ].join('\n'), inline: true },
      { name: '🧱 Champs', value: `${cfg.normalizeFields(panel.fields).length}/${cfg.LIMITS.fields}`, inline: true },
      { name: '🔗 Boutons', value: `${cfg.normalizeButtons(panel.buttons).length}/${cfg.LIMITS.buttons}`, inline: true },
      { name: '💬 Message au-dessus', value: panel.content ? panel.content.slice(0, 200) : '*aucun*' },
    )
    .setFooter({ text: footerOf(`Embed ${panel.panelKey}`) })
    .setTimestamp();
}

function buildContentView(panel) {
  return new EmbedBuilder()
    .setColor(cfg.hexToInt(panel.color, BRAND?.colors?.primary ?? 0x8B1A1A))
    .setAuthor({ name: `${BRAND?.name || 'REZO'} • Studio d'embeds` })
    .setTitle(`📝 Contenu — ${panel.name}`)
    .setDescription('Choisissez un élément ci-dessous. Chaque modification est enregistrée immédiatement.')
    .addFields(
      { name: '👤 Auteur', value: (panel.authorName || '*aucun*').slice(0, 100), inline: true },
      { name: '🖼️ Icône auteur', value: panel.authorIcon ? '✅ définie' : '⬜ aucune', inline: true },
      { name: '🕒 Horodatage', value: panel.timestamp !== false ? '✅ activé' : '⬜ désactivé', inline: true },
      { name: '📝 Titre', value: (panel.title || '*aucun*').slice(0, 200) },
      { name: '📄 Description', value: (panel.description || '*aucune*').slice(0, 500) },
      { name: '📎 Pied de page', value: (panel.footer || '*par défaut*').slice(0, 200), inline: true },
      { name: '🖼️ Icône footer', value: panel.footerIcon ? '✅ définie' : '⬜ aucune', inline: true },
      { name: '🖼️ Image', value: panel.image ? `[voir](${panel.image})` : '*aucune*', inline: true },
      { name: '🖼️ Miniature', value: panel.thumbnail ? `[voir](${panel.thumbnail})` : '*aucune*', inline: true },
    )
    .setFooter({ text: footerOf('Contenu de l\'embed') });
}

function buildFieldsView(panel) {
  const fields = cfg.normalizeFields(panel.fields);
  return new EmbedBuilder()
    .setColor(BRAND?.colors?.primary ?? 0x8B1A1A)
    .setAuthor({ name: `${BRAND?.name || 'REZO'} • Studio d'embeds` })
    .setTitle(`🧱 Champs — ${panel.name}`)
    .setDescription(fields.length
      ? fields.slice(0, 12).map((f, i) => `**${i + 1}. ${f.name}**${f.inline ? ' *(inline)*' : ''}\n${f.value.slice(0, 90)}`).join('\n\n')
      : '*Aucun champ. Ajoutez-en un ci-dessous.*')
    .setFooter({ text: footerOf(`${fields.length}/${cfg.LIMITS.fields} champs`) });
}

const BUTTON_LABELS = { link: '🔗 Lien', role: '🎭 Rôle', reply: '💬 Réponse', ticket: '🎫 Ticket' };
function buttonDetail(b) {
  if (b.type === 'link') return b.url;
  if (b.type === 'role') return b.roleId ? `<@&${b.roleId}> (${b.roleMode})` : '⚠️ rôle non défini';
  if (b.type === 'reply') return b.response.slice(0, 80);
  return `panel ${b.ticketPanel || 't1'}`;
}

function buildButtonsView(panel) {
  const buttons = cfg.normalizeButtons(panel.buttons);
  return new EmbedBuilder()
    .setColor(BRAND?.colors?.primary ?? 0x8B1A1A)
    .setAuthor({ name: `${BRAND?.name || 'REZO'} • Studio d'embeds` })
    .setTitle(`🔗 Boutons — ${panel.name}`)
    .setDescription([
      'Types disponibles : **lien**, **rôle** (donne/retire/bascule), **réponse** éphémère, **ticket** (ouvre le support).',
      '',
      buttons.length
        ? buttons.map((b, i) => `**${i + 1}.** ${b.emoji ? `${b.emoji} ` : ''}${b.label} — ${BUTTON_LABELS[b.type] || 'lien'}\n> ${buttonDetail(b)}`).join('\n')
        : '*Aucun bouton.*',
    ].join('\n').slice(0, 4000))
    .setFooter({ text: footerOf(`${buttons.length}/${cfg.LIMITS.buttons} boutons`) });
}

function buildPublishView(panel) {
  return new EmbedBuilder()
    .setColor(BRAND?.colors?.primary ?? 0x8B1A1A)
    .setAuthor({ name: `${BRAND?.name || 'REZO'} • Studio d'embeds` })
    .setTitle(`📤 Publier — ${panel.name}`)
    .setDescription([
      panel.channelId ? `Salon : <#${panel.channelId}>` : '⚠️ Choisissez d’abord un salon ci-dessous.',
      panel.messageId ? 'Un message est déjà publié : **Publier** le mettra à jour sur place.' : 'Aucun message publié pour l’instant.',
      '',
      'Le message inclut le contenu au-dessus, l’embed et les boutons-liens.',
    ].join('\n'))
    .setFooter({ text: footerOf('Publication') });
}

function buildEmpty(panels) {
  return new EmbedBuilder()
    .setColor(BRAND?.colors?.primary ?? 0x8B1A1A)
    .setAuthor({ name: `${BRAND?.name || 'REZO'} • Studio d'embeds` })
    .setTitle('🎨 Studio d\'embeds')
    .setDescription([
      'Aucun embed enregistré sur ce serveur.',
      '',
      'Créez-en un : titre, description, auteur, image, miniature, champs, boutons-liens, publication et mise à jour — tout est configurable et conservé.',
      panels.length ? `*${panels.length} panel(s) détecté(s).*` : '',
    ].filter(Boolean).join('\n'))
    .setFooter({ text: footerOf('Multi-panels') })
    .setTimestamp();
}

// ── Composants ───────────────────────────────────────────────────────────────

function panelSelect(panels, currentKey) {
  return new StringSelectMenuBuilder()
    .setCustomId('es_panel')
    .setPlaceholder('🎨 Choisir un embed à modifier…')
    .addOptions(panels.slice(0, 25).map(p => ({
      label: String(p.name || p.panelKey).slice(0, 100),
      value: String(p.panelKey).slice(0, 100),
      emoji: '🎨',
      description: `${cfg.normalizeFields(p.fields).length} champ(s) • ${cfg.normalizeButtons(p.buttons).length} bouton(s)${p.messageId ? ' • publié' : ''}`.slice(0, 100),
      default: p.panelKey === currentKey,
    })));
}

function navRow() {
  return row(
    btn('es_view:overview', 'Vue', '📊'),
    btn('es_view:content', 'Contenu', '📝'),
    btn('es_view:fields', 'Champs', '🧱'),
    btn('es_view:buttons', 'Boutons', '🔗'),
    btn('es_view:publish', 'Publication', '📤'),
  );
}

function actionRow(panel = {}, view = 'overview') {
  const buttons = [
    btn('es_preview', 'Aperçu', '👁️'),
    btn('es_new', 'Nouveau', '🆕', ButtonStyle.Success),
    btn('es_delete', 'Supprimer', '🗑️', ButtonStyle.Danger),
  ];
  // Le bouton d'envoi réel n'existe que dans la vue Publication : l'onglet
  // `es_view:publish` ne fait qu'afficher l'écran, c'est `es_publish` qui
  // envoie (ou met à jour) le message dans le salon choisi.
  if (view === 'publish') {
    buttons.unshift(btn('es_publish', 'Publier', '📤', ButtonStyle.Success, !panel.channelId));
  }
  return row(...buttons.slice(0, 5));
}

function contentSelect(panel) {
  return new StringSelectMenuBuilder()
    .setCustomId('es_content')
    .setPlaceholder('✏️ Modifier un élément…')
    .addOptions([
      { label: 'Titre', value: 'title', emoji: '🏷️', description: 'Titre de l\'embed (256 max)' },
      { label: 'Description', value: 'desc', emoji: '📄', description: 'Texte principal (4096 max)' },
      { label: 'Auteur', value: 'author', emoji: '👤', description: 'Ligne au-dessus du titre' },
      { label: 'Icône de l\'auteur', value: 'authoricon', emoji: '🖼️', description: 'URL d\'image' },
      { label: 'Couleur', value: 'color', emoji: '🎨', description: 'Hex : 8B1A1A' },
      { label: 'Pied de page', value: 'footer', emoji: '📎', description: 'Texte du footer' },
      { label: 'Icône du footer', value: 'footericon', emoji: '🖼️', description: 'URL d\'image' },
      { label: 'Image', value: 'image', emoji: '🖼️', description: 'Grande image' },
      { label: 'Miniature', value: 'thumb', emoji: '🖼️', description: 'En haut à droite' },
      { label: 'Message au-dessus', value: 'content', emoji: '💬', description: 'Texte hors embed' },
      { label: panel.timestamp !== false ? 'Désactiver l\'horodatage' : 'Activer l\'horodatage', value: 'timestamp', emoji: '🕒' },
      { label: 'Renommer le panel', value: 'rename', emoji: '✏️' },
    ]);
}

function fieldsSelect(panel) {
  const fields = cfg.normalizeFields(panel.fields);
  const options = [{ label: 'Ajouter un champ', value: 'new', emoji: '➕', description: `${fields.length}/${cfg.LIMITS.fields}` }];
  fields.slice(0, 24).forEach((f, i) => options.push({
    label: `${i + 1}. ${f.name}`.slice(0, 100),
    value: `f:${i}`,
    emoji: f.inline ? '↔️' : '🧱',
    description: f.value.slice(0, 100),
  }));
  return new StringSelectMenuBuilder().setCustomId('es_field').setPlaceholder('🧱 Champ à modifier…').addOptions(options);
}

function buttonsSelect(panel) {
  const buttons = cfg.normalizeButtons(panel.buttons);
  const options = [{ label: 'Ajouter un bouton', value: 'new', emoji: '➕', description: `${buttons.length}/${cfg.LIMITS.buttons}` }];
  buttons.slice(0, 24).forEach((b, i) => options.push({
    label: `${i + 1}. ${b.label}`.slice(0, 100),
    value: `b:${i}`,
    emoji: '🔗',
    description: b.url.slice(0, 100),
  }));
  return new StringSelectMenuBuilder().setCustomId('es_button').setPlaceholder('🔗 Bouton à modifier…').addOptions(options);
}

function buildComponents({ panels, panel, view, pending }) {
  const rows = [];
  if (panels.length) rows.push(row(panelSelect(panels, panel?.panelKey)));

  if (pending === 'confirm-delete') {
    rows.push(row(btn('es_delete_yes', 'Confirmer', '🗑️', ButtonStyle.Danger), btn('es_cancel', 'Annuler', '✖️')));
    return rows.slice(0, 5);
  }
  if (!panel) {
    rows.push(row(btn('es_new', 'Créer un embed', '🆕', ButtonStyle.Success)));
    return rows.slice(0, 5);
  }

  rows.push(navRow());
  if (view === 'content') rows.push(row(contentSelect(panel)));
  else if (view === 'fields') rows.push(row(fieldsSelect(panel)));
  else if (view === 'buttons') rows.push(row(buttonsSelect(panel)));
  else if (view === 'publish') {
    rows.push(row(new ChannelSelectMenuBuilder().setCustomId('es_channel')
      .setPlaceholder('📢 Salon de publication…').setChannelTypes(ChannelType.GuildText)));
  }
  rows.push(actionRow(panel, view));
  return rows.slice(0, 5);
}

// ── Chargement / rendu ───────────────────────────────────────────────────────

async function loadPanels(guildId) {
  try {
    const raw = await EmbedPanel.find({ guildId }).sort({ panelKey: 1 }).lean().exec();
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

async function render(guild, state) {
  const panels = await loadPanels(guild.id);
  let panel = panels.find(p => p.panelKey === state.panelKey) || null;
  if (!panel && panels.length) { panel = panels[0]; state.panelKey = panel.panelKey; }
  if (!panel) { state.view = 'overview'; state.panelKey = null; }

  let embed;
  if (!panels.length) embed = buildEmpty(panels);
  else if (!panel) embed = buildEmpty(panels);
  else if (state.view === 'content') embed = buildContentView(panel);
  else if (state.view === 'fields') embed = buildFieldsView(panel);
  else if (state.view === 'buttons') embed = buildButtonsView(panel);
  else if (state.view === 'publish') embed = buildPublishView(panel);
  else embed = buildOverview(panel, panels);

  return { embeds: [embed], components: buildComponents({ panels, panel, view: state.view, pending: state.pending }), panel, panels };
}

// ── Publication ──────────────────────────────────────────────────────────────

async function publish(guild, panel) {
  if (!panel.channelId) return { ok: false, reason: 'Choisissez d’abord un salon de publication.' };
  const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
  if (!channel) return { ok: false, reason: 'Salon introuvable.' };

  const data = payloadOf(panel);
  if (panel.messageId) {
    const existing = await channel.messages.fetch(panel.messageId).catch(() => null);
    if (existing) {
      try {
        await existing.edit(data);
        return { ok: true, url: existing.url, updated: true };
      } catch (err) {
        // Message supprimé/salon changé entre-temps : on repart sur un envoi.
        console.error('[embedStudio] edit:', err.message);
      }
    }
  }
  let sent = null;
  try {
    sent = await channel.send(data);
  } catch (err) {
    const detail = err?.message ? ` (${err.message})` : '';
    return { ok: false, reason: `Envoi impossible dans <#${panel.channelId}>${detail}. Vérifiez « Envoyer des messages » et « Intégrer des liens ».` };
  }
  if (!sent) return { ok: false, reason: 'Envoi impossible : aucune réponse du salon.' };
  panel.messageId = sent.id;
  await panel.save().catch(() => {});
  return { ok: true, url: sent.url, updated: false };
}

// ── Création ─────────────────────────────────────────────────────────────────

async function createPanel(guild, name) {
  const panels = await loadPanels(guild.id);
  const panelKey = cfg.nextPanelKey(panels.map(p => p.panelKey));
  try {
    const doc = await EmbedPanel.create({ guildId: guild.id, panelKey, ...cfg.defaults(name) });
    return { ok: true, panel: doc };
  } catch (err) {
    return { ok: false, reason: `Création impossible : ${err.message}` };
  }
}

// ── Modaux ───────────────────────────────────────────────────────────────────

const CONTENT_MODALS = {
  title:      { field: 'title',       label: 'Titre (256 max)',        max: 256, para: false },
  desc:       { field: 'description', label: 'Description (4000 max)', max: 4000, para: true },
  author:     { field: 'authorName',  label: 'Auteur (256 max)',       max: 256, para: false },
  authoricon: { field: 'authorIcon',  label: 'URL de l’icône',         max: 400, para: false },
  color:      { field: 'color',       label: 'Couleur hex (8B1A1A)',   max: 7,   para: false },
  footer:     { field: 'footer',      label: 'Pied de page (2048)',    max: 2048, para: false },
  footericon: { field: 'footerIcon',  label: 'URL icône footer',       max: 400, para: false },
  image:      { field: 'image',       label: 'URL de l’image',         max: 400, para: false },
  thumb:      { field: 'thumbnail',   label: 'URL de la miniature',    max: 400, para: false },
  content:    { field: 'content',     label: 'Message au-dessus',      max: 2000, para: true },
  rename:     { field: 'name',        label: 'Nom du panel',           max: 60,  para: false },
};

function contentModal(panel, key) {
  const conf = CONTENT_MODALS[key];
  if (!conf) return null;
  // La clé du panel est encodée dans le customId : un modal reste donc lié au
  // bon embed même si l'utilisateur possède plusieurs studios ouverts.
  // Couleur : Discord plafonne un champ à 7 caractères, on préremplit sans
  // le préfixe `0x` (sinon le modal serait refusé en 50035).
  const value = conf.field === 'color'
    ? String(panel.color || '').replace(/^0x/i, '').slice(0, 6)
    : panel[conf.field] || '';
  return modal(`es_modal_content_${key}_${panel.panelKey}`, `Modifier — ${conf.label}`, [
    input('val', conf.label, value, { paragraph: conf.para, max: conf.max }),
  ]);
}

function fieldModal(panel, value) {
  const fields = cfg.normalizeFields(panel.fields);
  const idx = value === 'new' ? -1 : parseInt(String(value).replace('f:', ''), 10);
  const current = idx >= 0 ? fields[idx] : null;
  const id = `es_modal_field_${idx >= 0 ? idx : 'new'}_${panel.panelKey}`;
  return modal(id, idx >= 0 ? 'Modifier un champ' : 'Ajouter un champ', [
    input('name', 'Nom du champ', current?.name || '', { max: cfg.LIMITS.fieldName, required: true }),
    input('value', 'Valeur du champ', current?.value || '', { paragraph: true, max: cfg.LIMITS.fieldValue, required: true }),
    input('inline', 'Inline ? (oui/non)', current?.inline ? 'oui' : 'non', { max: 3 }),
  ]);
}

function buttonModal(panel, value) {
  const buttons = cfg.normalizeButtons(panel.buttons);
  const idx = value === 'new' ? -1 : parseInt(String(value).replace('b:', ''), 10);
  const current = idx >= 0 ? buttons[idx] : null;
  const target = !current ? ''
    : current.type === 'link' ? current.url
    : current.type === 'role' ? current.roleMode
    : current.type === 'reply' ? current.response
    : current.ticketPanel;
  const id = `es_modal_button_${idx >= 0 ? idx : 'new'}_${panel.panelKey}`;
  return modal(id, idx >= 0 ? 'Modifier un bouton' : 'Ajouter un bouton', [
    input('label', 'Texte du bouton', current?.label || '', { max: 80, required: true }),
    input('emoji', 'Emoji (optionnel)', current?.emoji || '', { max: 16 }),
    input('type', 'Type : lien / role / reponse / ticket', current?.type || 'lien', { max: 10 }),
    input('target', 'Cible : URL, mode, texte ou panel', target, { max: 1000, placeholder: 'lien→URL · role→basculer · reponse→texte · ticket→t1' }),
    input('delete', 'Taper « supprimer » pour retirer', '', { max: 12 }),
  ]);
}

function newPanelModal() {
  return modal('es_modal_new', 'Nouvel embed', [input('name', 'Nom du panel', '', { max: 60, required: true, placeholder: 'Règlement, Annonces, Boutique…' })]);
}

// ── Application d'un modal ───────────────────────────────────────────────────

async function applyModal(interaction, guild) {
  const parts = interaction.customId.replace('es_modal_', '').split('_');
  const kind = parts[0];

  if (kind === 'new') {
    const name = interaction.fields.getTextInputValue('name');
    const res = await createPanel(guild, name);
    return res.ok ? { notice: `✅ Embed **${res.panel.name}** créé.`, panelKey: res.panel.panelKey } : { notice: `⚠️ ${res.reason}` };
  }

  const panelKey = parts[2] || null;
  const source = panelKey
    ? await EmbedPanel.findOne({ guildId: guild.id, panelKey }).exec()
    : await EmbedPanel.findOne({ guildId: guild.id }).sort({ panelKey: 1 }).exec();
  if (!source) return { notice: '⚠️ Aucun embed à modifier.' };

  if (kind === 'content') {
    const key = parts[1];
    const conf = CONTENT_MODALS[key];
    if (!conf) return { notice: '⚠️ Élément inconnu.' };
    const raw = interaction.fields.getTextInputValue('val');
    if (conf.field === 'color') {
      const hex = cfg.normalizeHex(raw);
      if (!hex) return { notice: '⚠️ Couleur invalide : utilisez un code hex comme `8B1A1A`.' };
      source.color = hex;
    } else if (['authorIcon', 'footerIcon', 'image', 'thumbnail'].includes(conf.field)) {
      const url = String(raw || '').trim();
      if (url && !cfg.isHttpUrl(url)) return { notice: '⚠️ URL invalide : elle doit commencer par http(s)://.' };
      source[conf.field] = url.slice(0, cfg.LIMITS.url);
    } else if (conf.field === 'name') {
      source.name = cfg.clampText(raw, cfg.LIMITS.name, source.name);
    } else {
      source[conf.field] = String(raw || '').trim().slice(0, conf.max);
    }
    await source.save();
    return { notice: '✅ Élément mis à jour.', panelKey: source.panelKey, view: 'content' };
  }

  if (kind === 'field') {
    const idx = parts[1] === 'new' ? -1 : parseInt(parts[1], 10);
    const name = interaction.fields.getTextInputValue('name');
    const value = interaction.fields.getTextInputValue('value');
    const inline = /^(oui|yes|true|1)$/i.test(String(interaction.fields.getTextInputValue('inline') || '').trim());
    const fields = cfg.normalizeFields(source.fields);

    const field = cfg.normalizeField({ name, value, inline });
    if (!field) return { notice: '⚠️ Nom et valeur sont obligatoires.' };
    if (idx >= 0) {
      if (idx >= fields.length) return { notice: '⚠️ Champ introuvable.' };
      fields[idx] = field;
    } else {
      if (fields.length >= cfg.LIMITS.fields) return { notice: `⚠️ Maximum ${cfg.LIMITS.fields} champs.` };
      fields.push(field);
    }
    source.fields = fields;
    await source.save();
    return { notice: idx >= 0 ? '✅ Champ modifié.' : '✅ Champ ajouté.', panelKey: source.panelKey, view: 'fields' };
  }

  if (kind === 'button') {
    const idx = parts[1] === 'new' ? -1 : parseInt(parts[1], 10);
    const buttons = cfg.normalizeButtons(source.buttons);
    const get = (k) => String(interaction.fields.getTextInputValue(k) ?? '').trim();

    if (/^supprimer$/i.test(get('delete')) && idx >= 0) {
      if (idx >= buttons.length) return { notice: '⚠️ Bouton introuvable.' };
      buttons.splice(idx, 1);
      source.buttons = buttons;
      await source.save();
      return { notice: '🗑️ Bouton supprimé.', panelKey: source.panelKey, view: 'buttons' };
    }

    const type = cfg.normalizeType(get('type'));
    const target = get('target');
    const draft = { label: get('label'), emoji: get('emoji'), type };
    if (type === 'link') draft.url = target;
    if (type === 'role') {
      draft.roleMode = cfg.normalizeRoleMode(target);
      draft.roleId = idx >= 0 ? buttons[idx]?.roleId || '' : '';
    }
    if (type === 'reply') draft.response = target;
    if (type === 'ticket') draft.ticketPanel = target || 't1';

    const button = cfg.normalizeButton(draft);
    if (!button) {
      return { notice: '⚠️ Bouton invalide : un lien a besoin d’une URL http(s), une réponse d’un texte.' };
    }

    if (idx >= 0) {
      if (idx >= buttons.length) return { notice: '⚠️ Bouton introuvable.' };
      buttons[idx] = button;
    } else {
      if (buttons.length >= cfg.LIMITS.buttons) return { notice: `⚠️ Maximum ${cfg.LIMITS.buttons} boutons.` };
      buttons.push(button);
    }
    source.buttons = buttons;
    await source.save();

    const finalIndex = idx >= 0 ? idx : buttons.length - 1;
    const needsRole = button.type === 'role' && !button.roleId;
    return {
      notice: idx >= 0 ? '✅ Bouton modifié.' : '✅ Bouton ajouté.',
      panelKey: source.panelKey,
      view: 'buttons',
      attachRole: needsRole ? { panelKey: source.panelKey, index: finalIndex } : null,
    };
  }

  return { notice: '⚠️ Action inconnue.' };
}

// ── Autorisations ────────────────────────────────────────────────────────────

function canManageGuild(interaction) {
  const perms = interaction?.member?.permissions;
  if (typeof perms?.has !== 'function') return false;
  try { return !!perms.has(PermissionFlagsBits.ManageGuild) || !!perms.has('ManageGuild'); } catch { return false; }
}

// ── Ouverture du studio ──────────────────────────────────────────────────────

async function openStudio(interaction) {
  if (!canManageGuild(interaction)) {
    return interaction.reply({
      embeds: [errorEmbed('Accès refusé', 'Le studio d’embeds est réservé aux membres avec **Gérer le serveur**.')],
      ephemeral: true,
    }).catch(() => {});
  }

  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const guild = interaction.guild;
  const state = { panelKey: null, view: 'overview', pending: null, notice: null };

  const first = await render(guild, state);
  const reply = await interaction.editReply({ embeds: first.embeds, components: first.components });
  if (!reply) return;

  const key = keyOf(interaction.user.id, interaction.guildId);
  // On garde l'objet Message : un message éphémère ne peut PAS être récupéré
  // par son identifiant via l'API, il faut conserver l'instance pour l'éditer.
  SESSIONS.set(key, { message: reply, messageId: reply.id, channelId: reply.channelId, panelKey: state.panelKey, view: state.view, at: Date.now() });

  const col = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 15 * 60 * 1000 });

  col.on('collect', async (i) => {
    try {
      const id = i.customId;

      if (id === 'es_panel') {
        state.panelKey = i.values[0];
        state.view = 'overview';
        state.pending = null;
      } else if (id.startsWith('es_view:')) {
        state.view = id.split(':')[1] || 'overview';
        state.pending = null;
      } else if (id === 'es_content') {
        const panel = await EmbedPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).exec();
        if (!panel) return i.deferUpdate().catch(() => {});
        if (i.values[0] === 'timestamp') {
          panel.timestamp = panel.timestamp === false;
          await panel.save();
          state.view = 'content';
        } else {
          const m = contentModal(panel, i.values[0]);
          if (m) return i.showModal(m);
        }
      } else if (id === 'es_field' || id === 'es_button') {
        const panel = await EmbedPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).exec();
        if (!panel) return i.deferUpdate().catch(() => {});
        return i.showModal(id === 'es_field' ? fieldModal(panel, i.values[0]) : buttonModal(panel, i.values[0]));
      } else if (id === 'es_channel') {
        const panel = await EmbedPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).exec();
        if (panel) { panel.channelId = i.values[0]; await panel.save().catch(() => {}); }
        state.view = 'publish';
      } else if (id === 'es_publish') {
        const panel = await EmbedPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).exec();
        if (!panel) return i.deferUpdate().catch(() => {});
        const res = await publish(guild, panel);
        state.notice = res.ok ? `✅ ${res.updated ? 'Message mis à jour' : 'Embed publié'} : ${res.url}` : `⚠️ ${res.reason}`;
        state.view = 'publish';
      } else if (id === 'es_preview') {
        const panel = await EmbedPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).lean().exec();
        if (!panel) return i.deferUpdate().catch(() => {});
        return i.reply({ ...payloadOf(panel), ephemeral: true }).catch(() => {});
      } else if (id === 'es_new') {
        return i.showModal(newPanelModal());
      } else if (id === 'es_delete') {
        state.pending = 'confirm-delete';
      } else if (id === 'es_cancel') {
        state.pending = null;
      } else if (id === 'es_delete_yes') {
        const panel = await EmbedPanel.findOne({ guildId: guild.id, panelKey: state.panelKey }).exec();
        if (panel) {
          if (panel.messageId) {
            const ch = await guild.channels.fetch(panel.channelId).catch(() => null);
            const msg = await ch?.messages.fetch(panel.messageId).catch(() => null);
            await msg?.delete().catch(() => {});
          }
          await EmbedPanel.deleteOne({ _id: panel._id }).catch(() => {});
        }
        state.panelKey = null; state.pending = null; state.view = 'overview';
        state.notice = '🗑️ Embed supprimé (le message publié a été retiré).';
      }
      else return i.deferUpdate().catch(() => {});

      const out = await render(guild, state);
      await i.update({ embeds: out.embeds, components: out.components }).catch(() => {});
      state.panelKey = out.panel?.panelKey || null;
      SESSIONS.set(key, { message: i.message, messageId: i.message?.id, channelId: i.message?.channelId, panelKey: state.panelKey, view: state.view, at: Date.now() });

      if (state.notice) {
        const notice = state.notice; state.notice = null;
        await i.followUp({ embeds: [/⚠️/.test(notice) ? errorEmbed('Non appliqué', notice.replace('⚠️', '').trim()) : successEmbed('Studio d\'embeds', notice)], ephemeral: true }).catch(() => {});
      }
    } catch (err) {
      console.error('[embedStudio] collect:', err);
      const payload = { embeds: [errorEmbed('Erreur', 'Action impossible pour le moment.')], ephemeral: true };
      if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
      else await i.reply(payload).catch(() => {});
    }
  });

  col.on('end', () => {
    SESSIONS.delete(key);
    interaction.editReply({ components: [] }).catch(() => {});
  });
}

// ── Retour d'un modal : rafraîchit le studio ouvert ─────────────────────────

async function handleStudioModal(interaction) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const guild = interaction.guild;
  const key = keyOf(interaction.user.id, interaction.guildId);
  const sess = SESSIONS.get(key) || {};

  let result;
  try {
    result = await applyModal(interaction, guild);
  } catch (err) {
    console.error('[embedStudio] modal:', err);
    return interaction.editReply({ embeds: [errorEmbed('Erreur', 'Modification impossible pour le moment.')] }).catch(() => {});
  }

  if (result.panelKey !== undefined) sess.panelKey = result.panelKey;
  if (result.view !== undefined) sess.view = result.view;
  SESSIONS.set(key, { ...sess, at: Date.now() });

  await refreshStudioPanel(guild, interaction, sess, key);

  // Bouton de rôle créé sans rôle : on enchaîne sur le sélecteur de rôle.
  if (result.attachRole) {
    return interaction.editReply({
      embeds: [infoEmbed('Bouton de rôle', 'Choisissez maintenant le rôle que ce bouton donnera ou retirera.')],
      components: [row(new RoleSelectMenuBuilder()
        .setCustomId(`es_attach_role:${result.attachRole.panelKey}:${result.attachRole.index}`)
        .setPlaceholder('🎭 Choisir un rôle…'))],
    }).catch(() => {});
  }

  const embed = /⚠️/.test(result.notice || '')
    ? errorEmbed('Non appliqué', String(result.notice).replace('⚠️', '').trim())
    : successEmbed('Enregistré', result.notice || 'Modification enregistrée.');
  return interaction.editReply({ embeds: [embed] }).catch(() => {});
}

// ── Sélection du rôle d'un bouton (routée depuis interactionCreate) ────────
async function attachRole(interaction) {
  const [, panelKey, idxRaw] = interaction.customId.split(':');
  const idx = parseInt(idxRaw, 10);
  const panel = await EmbedPanel.findOne({ guildId: interaction.guildId, panelKey }).exec();
  if (!panel) return interaction.reply({ embeds: [errorEmbed('Panel introuvable', 'Cet embed a été supprimé.')], ephemeral: true });

  const button = panel.buttons?.[idx];
  if (!button || button.type !== 'role') {
    return interaction.reply({ embeds: [errorEmbed('Bouton introuvable', 'Ce bouton n’est plus un bouton de rôle.')], ephemeral: true });
  }

  const role = await interaction.guild.roles.fetch(interaction.values[0]).catch(() => null);
  if (!role) return interaction.reply({ embeds: [errorEmbed('Rôle introuvable', 'Ce rôle n’existe plus.')], ephemeral: true });
  if (role.managed) return interaction.reply({ embeds: [errorEmbed('Rôle géré', 'Ce rôle est géré par une intégration et ne peut pas être attribué à la main.')], ephemeral: true });

  button.roleId = role.id;
  await panel.save().catch(() => {});

  const key = keyOf(interaction.user.id, interaction.guildId);
  const sess = SESSIONS.get(key) || {};
  if (!sess.panelKey) sess.panelKey = panel.panelKey;
  if (!sess.view) sess.view = 'buttons';
  await refreshStudioPanel(interaction.guild, interaction, sess, key);

  return interaction.reply({ embeds: [successEmbed('Rôle associé', `Le bouton ${roleModeLabel(button.roleMode)} ${role}.`)], ephemeral: true });
}

function roleModeLabel(mode) {
  return mode === 'add' ? 'donnera' : mode === 'remove' ? 'retirera' : 'basculera';
}

// Édite le panel éphémère du studio après un modal ou un sélecteur de rôle.
// On utilise l'instance Message de la session ; le fallback par identifiant ne
// sert qu'après un redémarrage du bot (et échouera proprement sinon).
async function refreshStudioPanel(guild, interaction, sess, key) {
  try {
    const state = { panelKey: sess.panelKey, view: sess.view || 'overview', pending: null };
    const out = await render(guild, state);

    if (sess.message && typeof sess.message.edit === 'function') {
      await sess.message.edit({ embeds: out.embeds, components: out.components }).catch(() => {});
    } else if (sess.messageId && sess.channelId) {
      const ch = await guild.channels.fetch(sess.channelId).catch(() => null);
      const msg = await ch?.messages.fetch(sess.messageId).catch(() => null);
      await msg?.edit({ embeds: out.embeds, components: out.components }).catch(() => {});
    }

    sess.panelKey = out.panel?.panelKey || sess.panelKey;
    SESSIONS.set(key, { ...sess, at: Date.now() });
  } catch (err) { console.error('[embedStudio] refresh:', err.message); }
}

module.exports = {
  openStudio,
  handleStudioModal,
  attachRole,
  buildEmbed,
  buildRows,
  payloadOf,
  publish,
  createPanel,
  contentModal,
  fieldModal,
  buttonModal,
  newPanelModal,
  canManageGuild,
  __testables: { buildOverview, buildContentView, buildFieldsView, buildButtonsView, buildPublishView, buildComponents, panelSelect },
};
