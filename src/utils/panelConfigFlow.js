'use strict';
// utils/panelConfigFlow.js — L'édition en direct du panel v3.
//
// Ce fichier ne fait que le lien entre les interactions Discord et le moteur
// `panelConfig` : il choisit le contrôle adapté au champ (interrupteur,
// sélecteur de salon/rôle, menu d'énumération, fenêtre de saisie), enregistre
// la valeur et redessine la même vue.
//
// Toutes les vues restent sur le message éphémère du `/setting` : rien n'est
// publié, et un collecteur unique (celui de la commande) suffit.

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const panelConfig = require('./panelConfig');

const PREFIX = 'cfg_';
const MODAL_TIMEOUT = 5 * 60 * 1000;
const AFTER_SAVE_TIMEOUT = 1500;

function isConfigComponent(customId) {
  return typeof customId === 'string' && customId.startsWith(PREFIX);
}

function parse(customId) {
  const parts = String(customId).split(':');
  return {
    kind: parts[0] || '',
    value: parts[1] || '',
    rest: parts.slice(2).join(':'),
  };
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function editorPayload(value, doc, { note = null, page = 0, hasPanel = false, guild = null } = {}) {
  return {
    embeds: [panelConfig.buildEditorEmbed(value, doc, { note, guild })],
    components: panelConfig.editorComponents(value, doc, page, { hasPanel, guild }),
  };
}

/**
 * Effet de bord d'un module après un enregistrement réussi (surnom du bot,
 * republication d'une carte…).
 *
 * Borné dans le temps : la valeur est déjà en base, donc un appel Discord qui
 * traîne ne doit jamais figer le panel. Le résultat devient une ligne du
 * compte rendu — un surnom refusé par Discord doit se voir, pas se taire.
 */
async function afterSave(interaction, value) {
  const entry = panelConfig.moduleOf(value);
  if (typeof entry?.after !== 'function') return null;

  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), AFTER_SAVE_TIMEOUT); });
  const result = await Promise.race([
    Promise.resolve().then(() => entry.after(interaction)).catch(() => null),
    timeout,
  ]).finally(() => clearTimeout(timer));

  if (!result || typeof result !== 'object') return null;
  const notes = [];
  if (result.nickname) {
    notes.push(result.nickname.ok
      ? (result.nickname.changed ? 'surnom du bot appliqué' : 'surnom du bot déjà à jour')
      : `surnom non appliqué — ${result.nickname.error}`);
  }
  if (result.card) {
    notes.push(result.card.ok
      ? (result.card.mode === 'edit' ? 'carte de statut mise à jour' : 'carte de statut publiée')
      : `carte non publiée — ${result.card.error}`);
  }
  return notes.length ? notes.join(' · ') : null;
}

async function respond(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload).catch(() => {});
  }
  return interaction.update(payload).catch(() => {});
}

/** Ouvre l'éditeur d'un module. */
async function open(interaction, value, { page = 0, note = null, hasPanel = false } = {}) {
  if (!panelConfig.isEditable(value)) return null;
  const doc = await panelConfig.readDoc(value, interaction.guild.id);
  return respond(interaction, editorPayload(value, doc, { note, page, hasPanel, guild: interaction.guild }));
}

// ─── Saisie libre (texte / nombre) ─────────────────────────────────────────

async function askValue(interaction, value, field, doc, { hasPanel = false } = {}) {
  const current = panelConfig.docValue(doc, field.path);
  const isLong = field.type === 'longtext';

  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(clip(field.label, 45))
    .setStyle(isLong ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(isLong ? 1900 : 200);

  if (current !== undefined && current !== null && current !== '') {
    input.setValue(clip(String(current), isLong ? 1900 : 200));
  }
  if (field.type === 'number') {
    const bounds = [field.min, field.max].filter(bound => typeof bound === 'number');
    input.setPlaceholder(bounds.length ? `Entre ${field.min ?? '…'} et ${field.max ?? '…'}` : 'Un nombre entier ou décimal');
  }

  const modal = new ModalBuilder()
    .setCustomId(`cfg_modal:${value}:${field.path}`)
    .setTitle(clip(`Modifier — ${field.label}`, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);

  const submitted = await interaction
    .awaitModalSubmit({ time: MODAL_TIMEOUT, filter: i => i.customId === modal.data.custom_id })
    .catch(() => null);
  if (!submitted) return null;

  await submitted.deferUpdate().catch(() => {});
  const raw = submitted.fields.getTextInputValue('value');
  const result = await panelConfig.applyValue(value, interaction.guild.id, field.path, raw);
  const sideEffect = result.ok ? await afterSave(interaction, value) : null;

  const doc2 = result.ok ? result.doc : await panelConfig.readDoc(value, interaction.guild.id);
  const note = result.ok
    ? `✅ **${field.label}** enregistré : ${panelConfig.formatFieldValue(field, result.value, interaction.guild)}${sideEffect ? `\n• ${sideEffect}` : ''}`
    : `❌ ${result.error}`;

  const payload = editorPayload(value, doc2, { note, page: 0, hasPanel, guild: interaction.guild });
  const target = submitted.message || interaction.message;
  return target?.edit(payload).catch(() => {});
}

// ─── Sélection d'un réglage ────────────────────────────────────────────────

async function onFieldPicked(interaction, value, ctx) {
  const path = interaction.values?.[0];
  const field = panelConfig.fieldByPath(value, path);
  if (!field) return open(interaction, value, { hasPanel: ctx.hasPanel });

  const doc = await panelConfig.readDoc(value, interaction.guild.id);

  if (field.type === 'bool') {
    const current = Boolean(panelConfig.docValue(doc, path));
    const result = await panelConfig.applyValue(value, interaction.guild.id, path, !current);
    const sideEffect = result.ok ? await afterSave(interaction, value) : null;
    const note = result.ok
      ? `✅ **${field.label}** : ${!current ? '🟢 activé' : '🔴 désactivé'}${sideEffect ? `\n• ${sideEffect}` : ''}`
      : `❌ ${result.error}`;
    const fresh = result.ok ? result.doc : doc;
    return respond(interaction, editorPayload(value, fresh, {
      note, hasPanel: ctx.hasPanel, guild: interaction.guild,
    }));
  }

  if (field.type === 'number' || field.type === 'text' || field.type === 'longtext') {
    return askValue(interaction, value, field, doc, { hasPanel: ctx.hasPanel });
  }

  return respond(interaction, {
    embeds: [panelConfig.buildPickerEmbed(value, field, doc, { guild: interaction.guild })],
    components: panelConfig.pickerComponents(value, field, doc),
  });
}

// ─── Application d'une valeur choisie ──────────────────────────────────────

async function onValuePicked(interaction, value, path, ctx) {
  const field = panelConfig.fieldByPath(value, path);
  if (!field) return open(interaction, value, { hasPanel: ctx.hasPanel });

  const picked = interaction.values || [];
  let input;
  if (field.type === 'channels' || field.type === 'roles') input = picked;
  else input = picked[0] ?? null;

  const result = await panelConfig.applyValue(value, interaction.guild.id, path, input);
  const sideEffect = result.ok ? await afterSave(interaction, value) : null;
  const note = result.ok
    ? `✅ **${field.label}** : ${panelConfig.formatFieldValue(field, result.value, interaction.guild)}${sideEffect ? `\n• ${sideEffect}` : ''}`
    : `❌ ${result.error}`;

  const doc = result.ok ? result.doc : await panelConfig.readDoc(value, interaction.guild.id);
  return respond(interaction, editorPayload(value, doc, {
    note, hasPanel: ctx.hasPanel, guild: interaction.guild,
  }));
}

// ─── Routeur ───────────────────────────────────────────────────────────────

/**
 * Traite une interaction du panel de configuration.
 * `ctx.hasPanel(value)` indique si le module possède aussi un panneau dédié,
 * `ctx.relay(interaction, value)` l'ouvre.
 */
async function handle(interaction, ctx = {}) {
  const { kind, value, rest } = parse(interaction.customId);

  switch (kind) {
    case 'cfg_page':
      return open(interaction, value, { page: Number(rest) || 0, hasPanel: Boolean(ctx.hasPanel?.(value)) });
    case 'cfg_back':
      return open(interaction, value, { hasPanel: Boolean(ctx.hasPanel?.(value)) });
    case 'cfg_field':
      return onFieldPicked(interaction, value, { hasPanel: Boolean(ctx.hasPanel?.(value)) });
    case 'cfg_pick':
      return onValuePicked(interaction, value, rest, { hasPanel: Boolean(ctx.hasPanel?.(value)) });
    case 'cfg_panel':
      return ctx.relay ? ctx.relay(interaction, value) : null;
    default:
      return null;
  }
}

module.exports = {
  PREFIX,
  MODAL_TIMEOUT,
  AFTER_SAVE_TIMEOUT,
  isConfigComponent,
  parse,
  open,
  handle,
  editorPayload,
  afterSave,
  onFieldPicked,
  onValuePicked,
};
