'use strict';
// utils/roleMenuEditor.js — Éditeur unique du menu de rôles.
//
// Un seul panneau pour tout : l'aperçu affiché est exactement l'embed que les
// membres verront, et chaque modification le met à jour immédiatement (l'appelant
// réécrit le message de l'éditeur et le panneau publié).
//
// Ce module ne parle ni à Discord ni à la base : il construit les composants,
// les modaux, et applique une saisie au document en mémoire. La commande décide
// quand sauvegarder.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const view = require('./roleMenuView');

const CID_SELECT = 'rmnedit:f';   // champ choisi dans la liste
const CID_ACTION = 'rmnedit:';    // rmnedit:pub · rmnedit:fermer
const CID_MODAL = 'rmneditm:';    // rmneditm:<champ>

const MAX_URL = 2048;
const HEX = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const ok = () => ({ ok: true });
const fail = error => ({ ok: false, error });

const truncate = (value, size) => String(value ?? '').slice(0, size);

/** Champ éditable → entrée de menu déroulant (libellé + valeur courante). */
function describeFields(menu) {
  const dash = '—';
  return [
    { field: 'titre',       label: '📝 Titre',                value: truncate(menu.title || dash, 90) },
    { field: 'description', label: '📄 Description',          value: menu.description ? truncate(menu.description.replace(/\n/g, ' '), 90) : dash },
    { field: 'image',       label: '🖼️ Image principale',     value: menu.imageUrl ? 'définie' : dash },
    { field: 'miniature',   label: '🔳 Miniature',            value: menu.thumbnailUrl ? 'définie' : dash },
    { field: 'auteur',      label: '👤 Auteur',               value: menu.authorName || dash },
    { field: 'footer',      label: '🔻 Pied de page',         value: menu.footerText || dash },
    { field: 'couleur',     label: '🎨 Couleur',              value: menu.color || dash },
    { field: 'role',        label: '🎭 Rôle : libellé & émoji', value: `${menu.entries?.length || 0} rôle(s)` },
    { field: 'style',       label: '🔘 Style des boutons',    value: menu.mode === 'select' ? 'menu déroulant' : 'boutons' },
    { field: 'exclusif',    label: '☑️ Un seul rôle à la fois', value: menu.exclusive ? 'oui' : 'non' },
  ];
}

/** Message complet de l'éditeur (aperçu + contrôles). */
function buildEditor(menu, guild) {
  const style = menu.mode === 'select' ? 'menu déroulant' : 'boutons';
  const state = [
    `${menu.entries?.length || 0}/${view.MAX_ENTRIES} rôle(s)`,
    style,
    menu.exclusive ? 'un seul rôle' : 'plusieurs rôles',
    menu.messageId ? 'publié' : 'non publié',
  ].join(' · ');

  const select = new StringSelectMenuBuilder()
    .setCustomId(CID_SELECT)
    .setPlaceholder('Modifier un élément du panneau…')
    .addOptions(describeFields(menu).map(item => ({
      label: item.label.slice(0, 100),
      value: item.field,
      description: item.value.slice(0, 100),
    })));

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CID_ACTION}pub`)
      .setLabel(menu.messageId ? 'Mettre à jour le panneau' : 'Publier le panneau')
      .setEmoji('📤')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CID_ACTION}fermer`)
      .setLabel('Fermer')
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    content: [
      '### 🎛️ Éditeur de menu de rôles',
      'L\'aperçu ci-dessous est **exactement** ce que verront les membres — chaque modification s\'applique aussitôt.',
      `-# ${state}`,
    ].join('\n'),
    embeds: [view.buildEmbed(menu, guild)],
    components: [new ActionRowBuilder().addComponents(select), actions],
  };
}

// ── Modaux ──────────────────────────────────────────────────────────────────

function textInput(id, label, { value = null, paragraph = false, required = false, placeholder = null, max = 1024 } = {}) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label.slice(0, 45))
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(Math.min(max, 4000));
  if (value) input.setValue(String(value).slice(0, Math.min(max, 4000)));
  if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(input);
}

/**
 * Modal du champ demandé — `null` quand le champ n'en a pas besoin
 * (style et exclusif se basculent d'un clic).
 */
function buildModal(field, menu) {
  const modal = new ModalBuilder().setCustomId(`${CID_MODAL}${field}`);

  switch (field) {
    case 'titre':
      return modal.setTitle('Titre du panneau')
        .addComponents(textInput('valeur', 'Titre', { value: menu.title, required: true, max: 256, placeholder: '🎭 Choisis tes rôles' }));

    case 'description':
      return modal.setTitle('Description du panneau')
        .addComponents(textInput('valeur', 'Description (vide = aucune)', { value: menu.description, paragraph: true, max: 2000, placeholder: 'Choisis les rôles qui te correspondent.' }));

    case 'image':
      return modal.setTitle('Image principale')
        .addComponents(textInput('url', 'Lien de l\'image (vide = retirer)', { value: menu.imageUrl, max: MAX_URL, placeholder: 'https://exemple.fr/banniere.png' }));

    case 'miniature':
      return modal.setTitle('Miniature')
        .addComponents(textInput('url', 'Lien de la miniature (vide = retirer)', { value: menu.thumbnailUrl, max: MAX_URL, placeholder: 'https://exemple.fr/logo.png' }));

    case 'auteur':
      return modal.setTitle('Auteur du panneau')
        .addComponents(
          textInput('nom', 'Nom affiché (vide = retirer)', { value: menu.authorName, max: 256, placeholder: 'Équipe REZO' }),
          textInput('icone', 'Icône — lien (facultatif)', { value: menu.authorIconUrl, max: MAX_URL, placeholder: 'https://exemple.fr/avatar.png' }),
        );

    case 'footer':
      return modal.setTitle('Pied de page')
        .addComponents(
          textInput('texte', 'Texte (vide = retirer)', { value: menu.footerText, max: 2048, placeholder: 'Menu de rôles · REZO' }),
          textInput('icone', 'Icône — lien (facultatif)', { value: menu.footerIconUrl, max: MAX_URL, placeholder: 'https://exemple.fr/logo.png' }),
        );

    case 'couleur':
      return modal.setTitle('Couleur du panneau')
        .addComponents(textInput('hex', 'Code couleur hexadécimal (vide = défaut)', { value: menu.color, max: 7, placeholder: '#5865F2' }));

    case 'role':
      return modal.setTitle('Rôle : libellé et émoji')
        .addComponents(
          textInput('cible', 'Rôle (identifiant ou nom exact)', { required: true, max: 100, placeholder: '123456789012345678 ou Artiste' }),
          textInput('libelle', 'Texte du bouton (vide = nom du rôle)', { max: 80, placeholder: 'Artiste' }),
          textInput('emoji', 'Émoji (vide = aucun)', { max: 64, placeholder: '🎨' }),
        );

    default:
      return null;
  }
}

// ── Application d'une saisie ────────────────────────────────────────────────

function normalizeUrl(raw, { allowEmpty = true } = {}) {
  const value = String(raw || '').trim();
  if (!value) return allowEmpty ? { ok: true, value: null } : fail('Un lien est obligatoire.');
  if (value.length > MAX_URL) return fail('Lien trop long (2048 caractères maximum).');
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fail('Seuls les liens **http(s)** sont acceptés.');
    }
  } catch {
    return fail('Lien invalide : il doit commencer par `https://`.');
  }
  return { ok: true, value };
}

/**
 * Applique la saisie d'un modal au document (en mémoire).
 * Retourne `{ ok: true }` ou `{ ok: false, error }` avec un message affichable.
 */
function applyField(menu, field, read, guild) {
  switch (field) {
    case 'titre': {
      const value = String(read('valeur') || '').trim().slice(0, 256);
      if (!value) return fail('Le titre ne peut pas être vide.');
      menu.title = value;
      return ok();
    }

    case 'description': {
      const value = String(read('valeur') || '').trim().slice(0, 2000);
      menu.description = value || null;
      return ok();
    }

    case 'image':
    case 'miniature': {
      const parsed = normalizeUrl(read('url'));
      if (!parsed.ok) return parsed;
      if (field === 'image') menu.imageUrl = parsed.value;
      else menu.thumbnailUrl = parsed.value;
      return ok();
    }

    case 'auteur': {
      const name = String(read('nom') || '').trim().slice(0, 256);
      const icon = normalizeUrl(read('icone'));
      if (!icon.ok) return icon;
      if (!name) {
        menu.authorName = null;
        menu.authorIconUrl = null;
        return ok();
      }
      menu.authorName = name;
      menu.authorIconUrl = icon.value;
      return ok();
    }

    case 'footer': {
      const text = String(read('texte') || '').trim().slice(0, 2048);
      const icon = normalizeUrl(read('icone'));
      if (!icon.ok) return icon;
      if (!text) {
        menu.footerText = null;
        menu.footerIconUrl = null;
        return ok();
      }
      menu.footerText = text;
      menu.footerIconUrl = icon.value;
      return ok();
    }

    case 'couleur': {
      const value = String(read('hex') || '').trim();
      if (!value) {
        menu.color = null;
        return ok();
      }
      if (!HEX.test(value)) return fail('Couleur invalide : utilise un code hexadécimal comme `#5865F2`.');
      const hex = value.startsWith('#') ? value : `#${value}`;
      menu.color = hex.toUpperCase();
      return ok();
    }

    case 'role': {
      if (!guild?.roles?.cache) return fail('Serveur indisponible.');
      const target = String(read('cible') || '').trim();
      const role = /^\d{5,32}$/.test(target)
        ? guild.roles.cache.get(target)
        : guild.roles.cache.find(candidate => candidate.name.toLowerCase() === target.toLowerCase());

      if (!role) return fail(`Rôle introuvable : \`${target}\`. Donne son identifiant ou son nom exact.`);
      if (role.id === guild.id) return fail('Le rôle **@everyone** ne peut pas être distribué par un menu.');
      if (role.managed) return fail(`**${role.name}** est géré par une intégration : il ne peut pas être attribué à la main.`);

      const me = guild.members?.me;
      if (me && role.position >= me.roles.highest.position) {
        return fail(`**${role.name}** est au-dessus de mon rôle : place mon rôle plus haut, puis réessaie.`);
      }

      const label = String(read('libelle') || '').trim().slice(0, 80) || null;
      const emoji = String(read('emoji') || '').trim().slice(0, 64) || null;

      const existing = (menu.entries || []).find(entry => entry.roleId === role.id);
      if (existing) {
        existing.label = label;
        existing.emoji = emoji;
        return { ok: true, added: false };
      }
      if ((menu.entries?.length || 0) >= view.MAX_ENTRIES) {
        return fail(`Le panneau est plein (**${view.MAX_ENTRIES} rôles** maximum).`);
      }
      menu.entries.push({ roleId: role.id, label, emoji });
      return { ok: true, added: true };
    }

    default:
      return fail('Champ inconnu.');
  }
}

module.exports = {
  CID_SELECT,
  CID_ACTION,
  CID_MODAL,
  describeFields,
  buildEditor,
  buildModal,
  applyField,
  normalizeUrl,
};
