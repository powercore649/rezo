'use strict';
// utils/profilePanelView.js — Vues du panel /profile.
//
// Le panel est entièrement piloté par des composants persistants : chaque
// bouton/menu/modal porte un custom_id `prf_*` routé par interactionCreate.
// Il n'y a donc aucun collecteur qui expire, et le panel reste utilisable sur
// un message ancien.
//
// Tout est borné ici (longueurs, nombre d'options, nombre de rangées) pour que
// les limites Discord ne puissent pas être franchies par une donnée utilisateur.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require('discord.js');
const { COLORS } = require('./embeds');
const profileBadges = require('./profileBadges');

const IDS = {
  identity: 'prf_btn_identity',
  style: 'prf_btn_style',
  badges: 'prf_btn_badges',
  preview: 'prf_btn_preview',
  toggleBadges: 'prf_btn_toggle_badges',
  reset: 'prf_btn_reset',
  resetConfirm: 'prf_btn_reset_confirm',
  back: 'prf_btn_back',
  pagePrev: 'prf_btn_page_prev',
  pageNext: 'prf_btn_page_next',
  cancel: 'prf_btn_cancel',
  openPanel: 'prf_btn_open_panel',
  visibilitySelect: 'prf_sel_visibility',
  badgeSelect: 'prf_sel_badges',
  identityModal: 'prf_modal_identity',
  styleModal: 'prf_modal_style',
};

const VISIBILITY_LABELS = {
  public: '🌍 Public — tout le serveur',
  serveur: '🏠 Serveur — les membres du serveur',
  prive: '🔒 Privé — moi uniquement',
};

const PER_PAGE = 8;

function accentOf(profile) {
  return /^#[0-9a-fA-F]{6}$/.test(String(profile?.color || '')) ? profile.color : COLORS.primary;
}

function visibilityLabel(value) {
  return VISIBILITY_LABELS[value] || VISIBILITY_LABELS.serveur;
}

function clip(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Nombre d'entrées par page de la galerie. */
function pageCount(badges) {
  const total = Array.isArray(badges) ? badges.length : 0;
  return Math.max(1, Math.ceil(total / PER_PAGE));
}

function pageEntries(badges, page = 1) {
  const list = Array.isArray(badges) ? badges : [];
  const index = Math.max(1, Math.min(page, pageCount(list)));
  return list.slice((index - 1) * PER_PAGE, index * PER_PAGE);
}

// ─── Panel principal ────────────────────────────────────────────────────────

function buildMainEmbed({ profile, displayName, guildName, badges, earned, next = [] }) {
  const counts = profileBadges.countByRarity(badges);
  const rarityLine = Object.values(profileBadges.RARITIES)
    .filter(rarity => counts[rarity.id])
    .map(rarity => `${rarity.emoji} ${counts[rarity.id]}`)
    .join(' · ') || 'Aucun badge débloqué';

  const nextLine = next.length
    ? next.map(badge => `${badge.emoji} **${badge.name}** — ${badge.progressLabel}`).join('\n')
    : 'Tous les badges automatiques sont débloqués 🎉';

  const lines = [
    `**${clip(displayName, 60)}** sur **${clip(guildName, 60)}**`,
    '',
    profile.bio ? `> ${clip(profile.bio, 200).replace(/\n/g, '\n> ')}` : '_Aucune présentation pour l’instant._',
    '',
    `🏅 **${earned}/${(badges || []).length}** badges débloqués — ${rarityLine}`,
  ];

  return new EmbedBuilder()
    .setColor(accentOf(profile))
    .setAuthor({ name: '🎖️ Mon profil REZO' })
    .setTitle(profile.title ? clip(profile.title, 48) : 'Profil sans accroche')
    .setDescription(clip(lines.join('\n'), 3900))
    .addFields(
      { name: '🎨 Style', value: `Accent : ${profile.color || 'REZO'}\nBannière : ${profile.bannerUrl ? 'personnalisée' : 'dégradé par défaut'}`, inline: true },
      { name: '👁️ Visibilité', value: visibilityLabel(profile.visibility), inline: true },
      { name: '🏅 Badges affichés', value: `${profile.showBadges ? 'Oui' : 'Non'} — ${profile.pinnedBadges?.length || 0} épinglé(s)`, inline: true },
      { name: '🔓 Prochains badges', value: clip(nextLine, 1000) },
      {
        name: '🛠️ Comment ça marche',
        value: [
          '• **Titre & bio** : ta présentation sur la carte.',
          '• **Couleur & bannière** : l’habillage de la carte.',
          '• **Badges** : choisis jusqu’à 6 badges à mettre en avant.',
          '• **Visibilité** : qui peut consulter ta carte.',
          '• **Aperçu** : rend la carte exactement comme les autres la voient.',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'REZO • /profile voir pour la carte publique' });
}

function mainComponents(profile) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.identity).setLabel('Titre & bio').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(IDS.style).setLabel('Couleur & bannière').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.badges).setLabel('Mes badges').setEmoji('🏅').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.preview).setLabel('Aperçu de la carte').setEmoji('🖼️').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(IDS.toggleBadges)
      .setLabel(profile.showBadges ? 'Masquer les badges' : 'Afficher les badges')
      .setEmoji(profile.showBadges ? '🙈' : '👁️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.reset).setLabel('Réinitialiser').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(IDS.visibilitySelect)
      .setPlaceholder(`Visibilité : ${visibilityLabel(profile.visibility)}`)
      .addOptions(
        Object.entries(VISIBILITY_LABELS).map(([value, label]) => new StringSelectMenuOptionBuilder()
          .setLabel(clip(label, 100))
          .setValue(value)
          .setDefault(value === profile.visibility)),
      ),
  );

  return [row1, row2, row3];
}

/** Vue de confirmation avant suppression (action irréversible). */
function buildResetEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🗑️ Réinitialiser ton profil ?')
    .setDescription(
      'Le titre, la bio, les couleurs, la bannière et les badges épinglés seront effacés.\n'
      + 'Tes **badges gagnés ne sont pas perdus** : ils sont recalculés depuis tes statistiques.\n\n'
      + 'Cette action est immédiate.',
    )
    .setFooter({ text: 'REZO • Profil' });
}

function resetComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.resetConfirm).setLabel('Confirmer la réinitialisation').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(IDS.cancel).setLabel('Annuler').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** Bouton unique de retour au panel (vue aperçu). */
function backComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(IDS.back).setLabel('Retour au panel').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Galerie de badges ──────────────────────────────────────────────────────

function buildBadgesEmbed(badges, { page = 1, pinned = [] } = {}) {
  const list = Array.isArray(badges) ? badges : [];
  const totalPages = pageCount(list);
  const index = Math.max(1, Math.min(page, totalPages));
  const entries = pageEntries(list, index);
  const acquired = profileBadges.earned(list).length;
  const counts = profileBadges.countByRarity(list);

  const lines = entries.map((badge) => {
    const rarity = badge.rarityInfo || profileBadges.rarityInfo(badge.rarity);
    const pin = pinned.includes(badge.id) ? ' 📌' : '';
    const status = badge.earned
      ? `Acquis${pin}`
      : `${badge.progressLabel} (${Math.round(badge.progress * 100)} %)`;
    return `${badge.earned ? badge.emoji : '🔒'} ${rarity.emoji} **${clip(badge.name, 40)}** — ${status}\n> ${clip(badge.description, 90)}`;
  });

  const rarityLine = Object.values(profileBadges.RARITIES)
    .map(rarity => `${rarity.emoji} ${counts[rarity.id] || 0}`)
    .join(' · ');

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setAuthor({ name: '🏅 Tes badges' })
    .setTitle(`${acquired}/${list.length} badges débloqués`)
    .setDescription(clip(lines.join('\n\n') || '_Aucun badge pour l’instant — participe au serveur !_', 3900))
    .addFields(
      { name: 'Raretés', value: rarityLine, inline: true },
      { name: '📌 Épinglés', value: `${pinned.length}/6`, inline: true },
    )
    .setFooter({ text: `Page ${index}/${totalPages} · les badges se débloquent automatiquement` });
}

function badgeComponents(badges, { page = 1, pinned = [] } = {}) {
  const list = Array.isArray(badges) ? badges : [];
  const totalPages = pageCount(list);
  const index = Math.max(1, Math.min(page, totalPages));

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${IDS.pagePrev}:${index - 1}`).setLabel('Précédent').setEmoji('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(index <= 1),
    new ButtonBuilder().setCustomId(`${IDS.pageNext}:${index + 1}`).setLabel('Suivant').setEmoji('➡️').setStyle(ButtonStyle.Secondary).setDisabled(index >= totalPages),
    new ButtonBuilder().setCustomId(IDS.back).setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Primary),
  );

  const earned = profileBadges.earned(list);
  if (!earned.length) return [nav];

  const options = earned.slice(0, 25).map((badge) => {
    const rarity = badge.rarityInfo || profileBadges.rarityInfo(badge.rarity);
    return new StringSelectMenuOptionBuilder()
      .setLabel(clip(`${badge.emoji} ${badge.name}`, 100))
      .setValue(clip(badge.id, 100))
      .setDescription(clip(`${rarity.label} • ${badge.description}`, 100))
      .setDefault(pinned.includes(badge.id));
  });

  const select = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(IDS.badgeSelect)
      .setPlaceholder('📌 Épingler jusqu’à 6 badges sur ta carte')
      .setMinValues(0)
      .setMaxValues(Math.min(6, options.length))
      .addOptions(options),
  );

  return [nav, select].slice(0, 5);
}

// ─── Modaux ─────────────────────────────────────────────────────────────────

function buildIdentityModal(profile) {
  const title = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Accroche (0 à 48 caractères)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(48)
    .setValue(clip(profile?.title || '', 48));

  const bio = new TextInputBuilder()
    .setCustomId('bio')
    .setLabel('Présentation (240 caractères max)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(240)
    .setValue(String(profile?.bio || '').slice(0, 240));

  return new ModalBuilder()
    .setCustomId(IDS.identityModal)
    .setTitle('✏️ Titre & bio')
    .addComponents(
      new ActionRowBuilder().addComponents(title),
      new ActionRowBuilder().addComponents(bio),
    );
}

function buildStyleModal(profile) {
  const color = new TextInputBuilder()
    .setCustomId('color')
    .setLabel('Couleur d’accent (#RRGGBB — vide = défaut)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMinLength(6)
    .setMaxLength(7)
    .setValue(clip(profile?.color || '', 7));

  const banner = new TextInputBuilder()
    .setCustomId('banner')
    .setLabel('URL de bannière (vide = dégradé)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(512)
    .setValue(clip(profile?.bannerUrl || '', 512));

  return new ModalBuilder()
    .setCustomId(IDS.styleModal)
    .setTitle('🎨 Couleur & bannière')
    .addComponents(
      new ActionRowBuilder().addComponents(color),
      new ActionRowBuilder().addComponents(banner),
    );
}

module.exports = {
  IDS,
  PER_PAGE,
  VISIBILITY_LABELS,
  accentOf,
  visibilityLabel,
  pageCount,
  pageEntries,
  buildMainEmbed,
  mainComponents,
  buildResetEmbed,
  resetComponents,
  backComponents,
  buildBadgesEmbed,
  badgeComponents,
  buildIdentityModal,
  buildStyleModal,
};
