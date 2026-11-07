'use strict';
// commands/securite/antiping.js — Panneau de la garde anti-ping et des salons.
//
// Une seule commande racine, aucune sous-commande : tout se règle dans un
// panneau à sections, comme /securite.
//
// Accès : la commande est protégée par le COFFRE D'ACCÈS (utils/commandVault),
// indépendant du système de licences. Par défaut, seul le propriétaire du
// serveur peut l'ouvrir ; il peut ensuite définir un code, ou autoriser des
// membres et des rôles, depuis la section « Accès ».
//
// Le rendu (`buildPanel`) est exporté tel quel : il ne touche ni à Discord ni à
// la base, ce qui permet de le vérifier hors-ligne dans tests/ping-guard.test.js.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');

const PingGuard = require('../../models/PingGuard');
const { COLORS } = require('../../utils/embeds');
const ui = require('../../utils/ui');
const { e, emojiObject } = require('../../utils/emojiSync');
const engine = require('../../utils/pingGuardEngine');
const vaultEngine = require('../../utils/commandVaultEngine');
const { invalidate, restoreRecent, deletedChannels } = require('../../utils/pingGuard');
const { getVault, guardCommand } = require('../../utils/commandVault');

const PANEL_TIMEOUT_MS = 10 * 60_000;
const MAX_SELECT_OPTIONS = 25;

const SECTIONS = ['main', 'mentions', 'salons', 'confiance', 'acces', 'restaurer'];
const SECTION_LABELS = {
  main: 'Vue d’ensemble',
  mentions: 'Mentions',
  salons: 'Salons suspects',
  confiance: 'Confiance',
  acces: 'Accès',
  restaurer: 'Restauration',
};

const OK = value => (value ? e('check') : e('alert'));
const SANCTION_LABELS = {
  delete: 'Supprimer le message',
  timeout: 'Exclusion temporaire',
  kick: 'Expulser',
  ban: 'Bannir',
};
const SANCTION_ORDER = ['delete', 'timeout', 'kick', 'ban'];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function clamp(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

async function loadConfig(guildId) {
  return PingGuard.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true },
  );
}

function pendingRestores(guildId) {
  return (deletedChannels.get(guildId) || []).length;
}

// ─── Rendu ───────────────────────────────────────────────────────────────────
// Un seul langage pour les six sections : titre court, sur-titre, filet, puis
// des champs de deux ou trois lignes. Les états utilisent deux glyphes (● / ○)
// au lieu d'un emoji par ligne : la page se lit d'un coup d'œil.
function eventLine(entry) {
  const when = Math.floor(new Date(entry.at).getTime() / 1000);
  return `<t:${when}:R> · ${entry.kind} · ${entry.userId ? `<@${entry.userId}>` : '—'} — ${entry.detail || '—'}`;
}

function buildOverview(doc, config, pending, guildName) {
  const cg = config.channelGuard;
  const stats = doc?.stats || {};
  const recent = [...(doc?.recent || [])].reverse().slice(0, 3);

  return ui.panelEmbed({
    title: `${e('shield')} Anti-ping et salons`,
    subtitle: guildName,
    description: [
      config.enabled ? 'Protection active.' : 'Protection désactivée : rien n’est filtré.',
      pending ? `${pending} salon(s) supprimé(s) en attente de restauration.` : null,
      'Choisis une section dans le menu ci-dessous.',
    ].filter(Boolean).join('\n'),
    color: config.enabled ? COLORS.success : COLORS.warning,
    fields: [
      {
        name: 'Mentions',
        value: [
          `${OK(config.blockEveryone)} @everyone    ${OK(config.blockHere)} @here`,
          `Rôles ${config.maxRoleMentions || 'off'} · Membres ${config.maxUserMentions || 'off'}`,
          `\`${config.punishment}\` · ban à ${config.strikesBeforeBan} récidive(s)`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Salons',
        value: [
          `${OK(cg.enabled)} Détection`,
          `Suppression ${OK(cg.deleteChannel)} · Ban ${OK(cg.banAuthor)}`,
          `Restauration ${OK(cg.restoreDeleted)} · ${cg.restoreWindowMin} min`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Activité',
        value: [
          `${stats.pingsBlocked || 0} mentions bloquées`,
          `${stats.channelsBlocked || 0} salons bloqués`,
          `${stats.restores || 0} restauration(s)`,
        ].join('\n'),
        inline: true,
      },
      {
        name: 'Derniers événements',
        value: recent.length ? recent.map(eventLine).join('\n').slice(0, 1024) : 'Aucun événement.',
      },
    ],
    footer: 'Anti-ping · vue d’ensemble',
  });
}

function buildMentions(doc, config) {
  const exemptRoles = config.exemptRoles.length ? config.exemptRoles.map(id => `<@&${id}>`).join(' ') : '*aucun*';
  return ui.panelEmbed({
    title: `${e('mute')} Mentions`,
    subtitle: '@everyone · @here · mentions en masse',
    description: [
      'Un membre sans la permission « Mentionner @everyone » ne peut pas pinger tout le serveur ; le staff n’est jamais filtré.',
      'Une mention écrite dans du code n’est jamais comptée.',
    ].join('\n'),
    color: config.enabled ? COLORS.success : COLORS.warning,
    fields: [
      { name: 'Statut', value: config.enabled ? 'Activé' : 'Désactivé', inline: true },
      { name: '@everyone', value: OK(config.blockEveryone), inline: true },
      { name: '@here', value: OK(config.blockHere), inline: true },
      { name: 'Rôles', value: config.maxRoleMentions ? `max ${config.maxRoleMentions}` : '*désactivé*', inline: true },
      { name: 'Membres', value: config.maxUserMentions ? `max ${config.maxUserMentions}` : '*désactivé*', inline: true },
      { name: 'Sanction', value: `\`${config.punishment}\` — ${SANCTION_LABELS[config.punishment]}`, inline: true },
      { name: 'Exclusion', value: `${config.timeoutMin} min`, inline: true },
      { name: 'Escalade', value: `ban à ${config.strikesBeforeBan} récidive(s)`, inline: true },
      { name: 'Fenêtre', value: `${config.strikeWindowMin} min`, inline: true },
      { name: 'Rôles exemptés', value: exemptRoles.slice(0, 1024) },
    ],
    footer: 'Anti-ping · mentions',
  });
}

function buildSalons(doc, config) {
  const cg = config.channelGuard;
  const keywords = cg.keywords.map(keyword => `\`${keyword}\``).join(', ').slice(0, 1024);
  return ui.panelEmbed({
    title: `${e('siren')} Salons`,
    subtitle: 'Noms suspects',
    description: [
      'Un salon dont le nom sert d’attaque (invitation Discord, `@everyone`, lien, « nuke », « free nitro »…) est supprimé et son auteur banni.',
      'Les salons que cet auteur venait de supprimer sont ensuite reconstruits. Les formules sont des phrases entières : `#raid-annonces` reste légitime.',
    ].join('\n'),
    color: cg.enabled ? COLORS.success : COLORS.warning,
    fields: [
      { name: 'Détection', value: OK(cg.enabled), inline: true },
      { name: 'Supprimer le salon', value: OK(cg.deleteChannel), inline: true },
      { name: 'Bannir l’auteur', value: OK(cg.banAuthor), inline: true },
      { name: 'Restaurer', value: OK(cg.restoreDeleted), inline: true },
      { name: 'Fenêtre', value: `${cg.restoreWindowMin} min`, inline: true },
      { name: 'Journaux d’audit', value: 'requis pour identifier l’auteur', inline: true },
      { name: `Formules suivies (${cg.keywords.length})`, value: keywords || '*aucune*' },
      { name: 'Exemptés', value: 'le propriétaire, le bot et la section **Confiance**.' },
    ],
    footer: 'Anti-ping · salons',
  });
}

function buildConfiance(doc, config, guild) {
  const nameOfUser = id => guild?.members?.cache?.get?.(id)?.user?.username || id;
  const nameOfRole = id => guild?.roles?.cache?.get?.(id)?.name || id;
  const users = config.trustedUsers.length
    ? config.trustedUsers.map(id => `<@${id}> (${nameOfUser(id)})`).join('\n')
    : '*aucun membre*';
  const roles = config.trustedRoles.length
    ? config.trustedRoles.map(id => `<@&${id}> (${nameOfRole(id)})`).join('\n')
    : '*aucun rôle*';
  return ui.panelEmbed({
    title: `${e('check')} Confiance`,
    subtitle: 'Jamais sanctionnés par cette garde',
    description: 'À réserver au staff : un compte compromis de cette liste ne serait plus arrêté par cette protection.',
    color: COLORS.info,
    fields: [
      { name: 'Membres', value: users.slice(0, 1024), inline: true },
      { name: 'Rôles', value: roles.slice(0, 1024), inline: true },
      { name: 'Toujours de confiance', value: 'le propriétaire du serveur et le bot' },
    ],
    footer: 'Anti-ping · confiance',
  });
}

function buildAcces(vault, guild) {
  const users = vault?.authorizedUsers?.length
    ? vault.authorizedUsers.map(id => `<@${id}>`).join(' ')
    : '*aucun*';
  const roles = vault?.authorizedRoles?.length
    ? vault.authorizedRoles.map(id => `<@&${id}>`).join(' ')
    : '*aucun*';
  return ui.panelEmbed({
    title: `${e('pin')} Accès`,
    subtitle: 'Coffre du panneau',
    description: [
      'Protection locale au serveur, sans lien avec les licences : ni abonnement, ni clé, ni appel extérieur.',
      'Le code est haché (scrypt + sel) et n’est jamais affiché. Sans code défini, seul le propriétaire ouvre ce panneau.',
    ].join('\n'),
    color: vault?.enabled === false ? COLORS.warning : COLORS.info,
    fields: [
      { name: 'Coffre', value: vault?.enabled === false ? 'Désactivé — tout « Gérer le serveur » ouvre le panneau' : 'Activé', inline: true },
      { name: 'Code', value: vault?.codeHash ? 'défini' : '*aucun — propriétaire seulement*', inline: true },
      { name: 'Session', value: `${Math.round(vaultEngine.SESSION_MS / 60_000)} min`, inline: true },
      { name: 'Membres autorisés', value: users.slice(0, 1024) },
      { name: 'Rôles autorisés', value: roles.slice(0, 1024) },
      {
        name: 'Anti-force brute',
        value: `${vaultEngine.MAX_ATTEMPTS} codes faux → verrou ${Math.round(vaultEngine.LOCK_MS / 60_000)} min · refus **${vault?.stats?.denied || 0}** · ouvertures **${vault?.stats?.opens || 0}**`,
      },
      { name: 'Réglages réservés', value: 'seul le propriétaire du serveur modifie cette section' },
    ],
    footer: 'Anti-ping · accès',
  });
}

function buildRestauration(doc, config, guild, pending) {
  return ui.panelEmbed({
    title: `${e('trash')} Restauration`,
    subtitle: 'Salons supprimés',
    description: [
      'Chaque suppression laisse un instantané complet (nom, catégorie, position, sujet, mode lent, permissions) conservé une heure.',
      'Un salon détruit par une attaque est donc reconstruit au lieu de rester un trou définitif.',
    ].join('\n'),
    color: pending ? COLORS.warning : COLORS.info,
    fields: [
      { name: 'Salons mémorisés', value: `**${pending}**`, inline: true },
      { name: 'Fenêtre', value: `${config.channelGuard.restoreWindowMin} min`, inline: true },
      { name: 'Automatique', value: OK(config.channelGuard.restoreDeleted), inline: true },
      { name: 'Mémoire', value: '40 salons par serveur, une heure, en mémoire du processus (perdue au redémarrage).' },
    ],
    footer: 'Anti-ping · restauration',
  });
}

// ─── Composants ──────────────────────────────────────────────────────────────
// Une seule source pour l'emoji d'une section : le menu et les titres restent
// alignés.
const SECTION_EMOJI_KEY = {
  main: 'shield',
  mentions: 'mute',
  salons: 'siren',
  confiance: 'check',
  acces: 'pin',
  restaurer: 'trash',
};

function sectionMenu(section) {
  return new StringSelectMenuBuilder()
    .setCustomId('ap_menu')
    .setPlaceholder('Choisir une section…')
    .addOptions(SECTIONS.map(key => {
      const optionEmoji = emojiObject(SECTION_EMOJI_KEY[key]);
      return {
        label: SECTION_LABELS[key],
        value: key,
        default: key === section,
        ...(optionEmoji ? { emoji: optionEmoji } : {}),
      };
    }));
}

// Aucun bouton ne porte d'emoji : l'état se lit à la couleur (vert = actif,
// gris = coupé). Les emojis animés sont réservés aux options des menus.
function toggle(customId, label, active, styleOn = ButtonStyle.Success) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(`${label}`)
    .setStyle(active ? styleOn : ButtonStyle.Secondary);
}

function button(customId, label, style = ButtonStyle.Primary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

function untrustOptions(list, guild, kind) {
  const nameOfUser = id => guild?.members?.cache?.get?.(id)?.user?.username || id;
  const nameOfRole = id => guild?.roles?.cache?.get?.(id)?.name || id;
  const optionEmoji = emojiObject('trash');
  return (list || []).map(id => ({
    label: `${kind === 'user' ? 'Membre' : 'Rôle'} : ${kind === 'user' ? nameOfUser(id) : nameOfRole(id)}`.slice(0, 100),
    value: `${kind}:${id}`,
    ...(optionEmoji ? { emoji: optionEmoji } : {}),
  })).slice(0, MAX_SELECT_OPTIONS);
}

/**
 * Construit l'embed et les composants d'une section.
 * Aucun accès Discord : appelable dans un test.
 * @param {string} section
 * @param {{doc?:object, config?:object, vault?:object, guild?:object, guildName?:string, pending?:number, owner?:boolean}} ctx
 */
function buildPanel(section, ctx = {}) {
  const key = SECTIONS.includes(section) ? section : 'main';
  const {
    doc = {}, config = vaultEngineFallbackConfig(), vault = {},
    guild = null, guildName = 'ce serveur', pending = 0, owner = false,
  } = ctx;

  const embed = {
    main: () => buildOverview(doc, config, pending, guildName),
    mentions: () => buildMentions(doc, config),
    salons: () => buildSalons(doc, config),
    confiance: () => buildConfiance(doc, config, guild),
    acces: () => buildAcces(vault, guild),
    restaurer: () => buildRestauration(doc, config, guild, pending),
  }[key]();

  const rows = [new ActionRowBuilder().addComponents(sectionMenu(key))];

  if (key === 'main') {
    rows.push(new ActionRowBuilder().addComponents(
      toggle('ap_toggle_master', config.enabled ? 'Protection ON' : 'Protection OFF', config.enabled),
      button('ap_refresh', 'Actualiser', ButtonStyle.Secondary),
    ));
  }

  if (key === 'mentions') {
    rows.push(new ActionRowBuilder().addComponents(
      toggle('ap_toggle_everyone', '@everyone', config.blockEveryone),
      toggle('ap_toggle_here', '@here', config.blockHere),
      button('ap_sanction', `${SANCTION_LABELS[config.punishment]}`, ButtonStyle.Secondary),
      button('ap_limits', 'Seuils'),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      button('ap_back', 'Vue d’ensemble', ButtonStyle.Secondary),
    ));
  }

  if (key === 'salons') {
    rows.push(new ActionRowBuilder().addComponents(
      toggle('ap_toggle_channels', 'Détection', config.channelGuard.enabled),
      toggle('ap_toggle_delete', 'Supprimer', config.channelGuard.deleteChannel),
      toggle('ap_toggle_ban', 'Bannir', config.channelGuard.banAuthor),
      toggle('ap_toggle_restore', 'Restaurer', config.channelGuard.restoreDeleted),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      button('ap_channels_cfg', 'Formules & fenêtre'),
      button('ap_back', 'Vue d’ensemble', ButtonStyle.Secondary),
    ));
  }

  if (key === 'confiance') {
    rows.push(new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('ap_trust_user')
        .setPlaceholder('Ajouter un membre de confiance')
        .setMinValues(1)
        .setMaxValues(5),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('ap_trust_role')
        .setPlaceholder('Ajouter un rôle de confiance')
        .setMinValues(1)
        .setMaxValues(5),
    ));
    const removable = untrustOptions(config.trustedUsers, guild, 'user')
      .concat(untrustOptions(config.trustedRoles, guild, 'role'))
      .slice(0, MAX_SELECT_OPTIONS);
    if (removable.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('ap_untrust')
          .setPlaceholder('Retirer une entrée de confiance')
          .addOptions(removable),
      ));
    }
    rows.push(new ActionRowBuilder().addComponents(
      button('ap_back', 'Vue d’ensemble', ButtonStyle.Secondary),
    ));
  }

  if (key === 'acces') {
    if (owner) {
      rows.push(new ActionRowBuilder().addComponents(
        toggle('ap_vault_toggle', vault.enabled === false ? 'Coffre OFF' : 'Coffre ON', vault.enabled !== false),
        button('ap_vault_code', vault.codeHash ? 'Changer le code' : 'Définir un code'),
        button('ap_back', 'Vue d’ensemble', ButtonStyle.Secondary),
      ));
      rows.push(new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId('ap_vault_users')
          .setPlaceholder('Autoriser un membre (sans code)')
          .setMinValues(1)
          .setMaxValues(5),
      ));
      rows.push(new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('ap_vault_roles')
          .setPlaceholder('Autoriser un rôle (sans code)')
          .setMinValues(1)
          .setMaxValues(5),
      ));
      const removable = untrustOptions(vault.authorizedUsers, guild, 'user')
        .concat(untrustOptions(vault.authorizedRoles, guild, 'role'))
        .slice(0, MAX_SELECT_OPTIONS);
      rows.push(new ActionRowBuilder().addComponents(
        removable.length
          ? new StringSelectMenuBuilder()
            .setCustomId('ap_vault_remove')
            .setPlaceholder('Retirer une autorisation')
            .addOptions(removable)
          : button('ap_back', 'Vue d’ensemble', ButtonStyle.Secondary),
      ));
    } else {
      rows.push(new ActionRowBuilder().addComponents(
        button('ap_back', 'Vue d’ensemble', ButtonStyle.Secondary),
      ));
    }
  }

  if (key === 'restaurer') {
    rows.push(new ActionRowBuilder().addComponents(
      button(
        'ap_restore_all',
        config.channelGuard.restoreDeleted ? 'Restaurer tout' : 'Restauration désactivée',
        config.channelGuard.restoreDeleted ? ButtonStyle.Success : ButtonStyle.Secondary,
      ),
      button('ap_back', 'Vue d’ensemble', ButtonStyle.Secondary),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('ap_restore_author')
        .setPlaceholder('Seulement les salons supprimés par…')
        .setMinValues(1)
        .setMaxValues(1),
    ));
  }

  return { embeds: [embed], components: rows };
}

function vaultEngineFallbackConfig() {
  return engine.normalizeConfig({});
}

// ─── Modaux ──────────────────────────────────────────────────────────────────
function textRow(customId, label, value, maxLength, style = TextInputStyle.Short) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(style)
      .setRequired(true)
      .setValue(String(value))
      .setMaxLength(maxLength),
  );
}

function limitsModal(config) {
  return new ModalBuilder()
    .setCustomId('ap_modal_limits')
    .setTitle('Seuils anti-ping')
    .addComponents(
      textRow('roles', 'Rôles max par message (0 = off)', config.maxRoleMentions, 2),
      textRow('membres', 'Membres max par message (0 = off)', config.maxUserMentions, 2),
      textRow('duree', 'Exclusion temporaire (minutes)', config.timeoutMin, 5),
      textRow('avant_ban', 'Récidives avant ban', config.strikesBeforeBan, 2),
      textRow('fenetre', 'Fenêtre des récidives (minutes)', config.strikeWindowMin, 4),
    );
}

function channelsModal(config) {
  return new ModalBuilder()
    .setCustomId('ap_modal_channels')
    .setTitle('Salons — formules & fenêtre')
    .addComponents(
      textRow('formules', 'Formules suspectes, séparées par des virgules', config.channelGuard.keywords.join(', '), 500, TextInputStyle.Paragraph),
      textRow('fenetre', 'Fenêtre de restauration (minutes)', config.channelGuard.restoreWindowMin, 4),
    );
}

function codeModal(hasCode) {
  const modal = new ModalBuilder()
    .setCustomId('ap_modal_code')
    .setTitle(hasCode ? 'Changer le code d’accès' : 'Définir un code d’accès');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('code')
        .setLabel(`Code (${vaultEngine.MIN_CODE_LENGTH} caractères minimum)`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(vaultEngine.MIN_CODE_LENGTH)
        .setMaxLength(vaultEngine.MAX_CODE_LENGTH),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('confirmation')
        .setLabel('Confirme le code')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(vaultEngine.MIN_CODE_LENGTH)
        .setMaxLength(vaultEngine.MAX_CODE_LENGTH),
    ),
  );
  return modal;
}

// ─── Commande ────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('antiping')
    .setDescription('Panneau anti-ping @everyone/@here et salons aux noms suspects')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  buildPanel,
  sections: SECTIONS,

  async execute(interaction) {
    const guild = interaction.guild;

    // ── Coffre d'accès (indépendant des licences) ──────────────────────────
    const access = await guardCommand(interaction, { label: 'le panneau anti-ping' });
    if (!access.allowed) return;
    const replyTo = access.replyTo;

    let section = 'main';

    const render = async () => {
      const [doc, vault] = await Promise.all([loadConfig(guild.id), getVault(guild.id)]);
      return buildPanel(section, {
        doc,
        config: engine.normalizeConfig(doc),
        vault,
        guild,
        guildName: guild.name,
        pending: pendingRestores(guild.id),
        owner: guild.ownerId === interaction.user.id,
      });
    };

    const msg = await replyTo.reply({
      ...(await render()),
      ephemeral: true,
      fetchReply: true,
    });

    const collector = msg.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: PANEL_TIMEOUT_MS,
    });

    collector.on('collect', async i => {
      try {
        // Le panneau peut bannir ou modifier la protection : même preuve
        // d'identité que le panneau /securite quand elle est configurée.
        const { authorizeComponent } = require('../../utils/authGate');
        if (!(await authorizeComponent(i, { label: 'Panneau anti-ping' }))) return;

        const id = i.customId;
        const doc = await loadConfig(guild.id);
        const config = engine.normalizeConfig(doc);

        // ── Navigation ──────────────────────────────────────────────────────
        if (id === 'ap_menu') {
          section = i.values[0];
          return i.update(await render());
        }
        if (id === 'ap_back') {
          section = 'main';
          return i.update(await render());
        }
        if (id === 'ap_refresh') {
          return i.update(await render());
        }

        // ── Coffre d'accès (propriétaire uniquement) ───────────────────────
        if (id.startsWith('ap_vault_')) {
          if (guild.ownerId !== i.user.id) {
            return i.reply({ content: '⛔ Cette section est réservée au propriétaire du serveur.', ephemeral: true });
          }
          const vault = await getVault(guild.id);

          if (id === 'ap_vault_toggle') {
            vault.enabled = vault.enabled === false;
            await vault.save();
            section = 'acces';
            return i.update(await render());
          }

          if (id === 'ap_vault_code') {
            await i.showModal(codeModal(Boolean(vault.codeHash)));
            const submitted = await i.awaitModalSubmit({
              time: 120_000,
              filter: s => s.user.id === interaction.user.id && s.customId === 'ap_modal_code',
            }).catch(() => null);
            if (!submitted) return;

            const code = submitted.fields.getTextInputValue('code');
            const confirmation = submitted.fields.getTextInputValue('confirmation');
            const check = vaultEngine.validateCode(code);
            if (!check.ok) {
              return submitted.reply({ content: `⛔ Code refusé : ${check.reason}.`, ephemeral: true });
            }
            if (code !== confirmation) {
              return submitted.reply({ content: '⛔ Les deux codes ne correspondent pas.', ephemeral: true });
            }

            const hashed = vaultEngine.hashCode(code);
            vault.codeSalt = hashed.salt;
            vault.codeHash = hashed.hash;
            vault.enabled = true;
            await vault.save();
            section = 'acces';
            return submitted.update(await render());
          }

          if (id === 'ap_vault_users') {
            const users = new Set(vault.authorizedUsers || []);
            for (const userId of i.values) users.add(userId);
            vault.authorizedUsers = [...users].slice(0, 50);
            await vault.save();
            section = 'acces';
            return i.update(await render());
          }
          if (id === 'ap_vault_roles') {
            const roles = new Set(vault.authorizedRoles || []);
            for (const roleId of i.values) roles.add(roleId);
            vault.authorizedRoles = [...roles].slice(0, 50);
            await vault.save();
            section = 'acces';
            return i.update(await render());
          }
          if (id === 'ap_vault_remove') {
            const [kind, targetId] = String(i.values[0]).split(':');
            if (kind === 'user') vault.authorizedUsers = (vault.authorizedUsers || []).filter(value => value !== targetId);
            if (kind === 'role') vault.authorizedRoles = (vault.authorizedRoles || []).filter(value => value !== targetId);
            await vault.save();
            section = 'acces';
            return i.update(await render());
          }
        }

        // ── Interrupteurs ──────────────────────────────────────────────────
        const toggles = {
          ap_toggle_master: () => { doc.enabled = !doc.enabled; section = 'main'; },
          ap_toggle_everyone: () => { doc.blockEveryone = !doc.blockEveryone; },
          ap_toggle_here: () => { doc.blockHere = !doc.blockHere; },
          ap_toggle_channels: () => { doc.channelGuard.enabled = !doc.channelGuard.enabled; },
          ap_toggle_delete: () => { doc.channelGuard.deleteChannel = !doc.channelGuard.deleteChannel; },
          ap_toggle_ban: () => { doc.channelGuard.banAuthor = !doc.channelGuard.banAuthor; },
          ap_toggle_restore: () => { doc.channelGuard.restoreDeleted = !doc.channelGuard.restoreDeleted; },
        };
        if (toggles[id]) {
          toggles[id]();
          await doc.save();
          invalidate(guild.id);
          return i.update(await render());
        }

        // ── Cycle de sanction ──────────────────────────────────────────────
        if (id === 'ap_sanction') {
          const next = SANCTION_ORDER[(SANCTION_ORDER.indexOf(config.punishment) + 1) % SANCTION_ORDER.length];
          doc.punishment = next;
          await doc.save();
          invalidate(guild.id);
          return i.update(await render());
        }

        // ── Seuils (modal) ─────────────────────────────────────────────────
        if (id === 'ap_limits') {
          await i.showModal(limitsModal(config));
          const submitted = await i.awaitModalSubmit({
            time: 60_000,
            filter: s => s.user.id === interaction.user.id && s.customId === 'ap_modal_limits',
          }).catch(() => null);
          if (!submitted) return;
          const fresh = await loadConfig(guild.id);
          fresh.maxRoleMentions = clamp(submitted.fields.getTextInputValue('roles'), config.maxRoleMentions, 0, 25);
          fresh.maxUserMentions = clamp(submitted.fields.getTextInputValue('membres'), config.maxUserMentions, 0, 50);
          fresh.timeoutMin = clamp(submitted.fields.getTextInputValue('duree'), config.timeoutMin, 1, 40_320);
          fresh.strikesBeforeBan = clamp(submitted.fields.getTextInputValue('avant_ban'), config.strikesBeforeBan, 1, 10);
          fresh.strikeWindowMin = clamp(submitted.fields.getTextInputValue('fenetre'), config.strikeWindowMin, 1, 1440);
          await fresh.save();
          invalidate(guild.id);
          section = 'mentions';
          return submitted.update(await render());
        }

        // ── Formules & fenêtre (modal) ─────────────────────────────────────
        if (id === 'ap_channels_cfg') {
          await i.showModal(channelsModal(config));
          const submitted = await i.awaitModalSubmit({
            time: 60_000,
            filter: s => s.user.id === interaction.user.id && s.customId === 'ap_modal_channels',
          }).catch(() => null);
          if (!submitted) return;
          const fresh = await loadConfig(guild.id);
          fresh.channelGuard.keywords = engine.normalizeKeywords(
            submitted.fields.getTextInputValue('formules')
              .split(',')
              .map(part => part.trim())
              .filter(Boolean),
          );
          fresh.channelGuard.restoreWindowMin = clamp(
            submitted.fields.getTextInputValue('fenetre'), config.channelGuard.restoreWindowMin, 1, 1440,
          );
          await fresh.save();
          invalidate(guild.id);
          section = 'salons';
          return submitted.update(await render());
        }

        // ── Confiance (garde des salons) ───────────────────────────────────
        if (id === 'ap_trust_user') {
          const users = new Set(doc.trustedUsers || []);
          for (const userId of i.values) users.add(userId);
          doc.trustedUsers = [...users].slice(0, 50);
          await doc.save();
          invalidate(guild.id);
          return i.update(await render());
        }
        if (id === 'ap_trust_role') {
          const roles = new Set(doc.trustedRoles || []);
          for (const roleId of i.values) roles.add(roleId);
          doc.trustedRoles = [...roles].slice(0, 50);
          await doc.save();
          invalidate(guild.id);
          return i.update(await render());
        }
        if (id === 'ap_untrust') {
          const [kind, targetId] = String(i.values[0]).split(':');
          if (kind === 'user') doc.trustedUsers = (doc.trustedUsers || []).filter(value => value !== targetId);
          if (kind === 'role') doc.trustedRoles = (doc.trustedRoles || []).filter(value => value !== targetId);
          await doc.save();
          invalidate(guild.id);
          return i.update(await render());
        }

        // ── Restauration ───────────────────────────────────────────────────
        if (id === 'ap_restore_all' || id === 'ap_restore_author') {
          if (!config.channelGuard.restoreDeleted) {
            return i.reply({ content: '⛔ La restauration est désactivée : active-la dans la section Salons.', ephemeral: true });
          }
          const actorId = id === 'ap_restore_author' ? i.values[0] : null;
          await i.deferUpdate();
          const result = await restoreRecent(guild, {
            actorId,
            minutes: config.channelGuard.restoreWindowMin,
          });
          section = 'restaurer';
          return i.editReply({
            content: (result.restored
              ? `♻️ **${result.restored}** salon(s) reconstruit(s) : ${result.names.map(name => `#${name}`).join(', ')}`
              : '⚠️ Aucun salon n’a pu être reconstruit (rien dans la fenêtre, ou permission « Gérer les salons » manquante).').slice(0, 1900),
            ...(await render()),
          });
        }
      } catch (err) {
        console.error('[antiping] panneau :', err.message);
        const payload = { content: '⚠️ Action impossible (permission manquante ou erreur temporaire).', ephemeral: true };
        if (i.deferred || i.replied) i.followUp(payload).catch(() => {});
        else i.reply(payload).catch(() => {});
      }
    });

    // Le panneau expire : on retire les boutons pour qu'aucun clic ne tombe
    // sur un collecteur mort.
    collector.on('end', () => {
      msg.edit({ components: [] }).catch(() => {});
    });
  },
};
