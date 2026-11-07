'use strict';
// commands/securite/controle-arrivee.js — Vigie : contrôle du profil à l'arrivée.
//
// L'anti-raid compte les arrivées ; Vigie juge chaque profil : compte créé il y
// a quelques minutes, avatar par défaut, pseudo contenant une invitation, un mot
// d'arnaque, une imitation du staff ou des caractères invisibles. Selon le score,
// le membre est laissé passer, mis sous surveillance (rôle d'attente) ou écarté
// (kick / ban / quarantaine / simple journalisation).
//
// Panneau unique, sans collecteur : les composants `cj_*` sont routés de façon
// persistante par events/interactionCreate.js (voir aussi /anti-nuke).

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const {
  getConfig, countQuarantined, releaseQuarantined, ensureQuarantineRole,
} = require('../../utils/joinGuardActions');
const {
  CHECKS, LABELS, formatDecision, effectiveThresholds,
} = require('../../utils/joinGuardEngine');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');

// Trois réponses au compte trop récent, comme sur les grosses protections :
// expulser, garder en salle d'attente jusqu'à l'âge requis, ou laisser le
// captcha décider. `ban`, `quarantine` et `log` restent offerts.
const ACTION_LABELS = {
  kick:       '👢 Expulser',
  jail:       '⏳ Salle d’attente (jusqu’à l’âge requis)',
  captcha:    '🔒 Envoyer au captcha (aucune sanction)',
  ban:        '🔨 Bannir',
  quarantine: '🚪 Mettre en attente',
  log:        '📝 Journaliser seulement',
};
const REVIEW_LABELS = {
  quarantine: '🚪 Mettre en attente',
  log:        '📝 Journaliser seulement',
};

function parseBool(raw, fallback = false) {
  const v = String(raw || '').toLowerCase().trim();
  if (['oui', 'yes', '1', 'true', 'on', 'activé', 'active'].includes(v)) return true;
  if (['non', 'no', '0', 'false', 'off', 'désactivé', 'desactive'].includes(v)) return false;
  return fallback;
}

function checkState(config) {
  const state = {};
  for (const name of CHECKS) state[name] = config.checks?.[name] !== false;
  return state;
}

function plainRecent(config) {
  return (config.recent || []).map(r => (typeof r.toObject === 'function' ? r.toObject() : r));
}

// ─── Panneau ─────────────────────────────────────────────────────────────────
async function buildPanel(config, guild) {
  const { blockScore, reviewScore, minAccountAgeDays } = effectiveThresholds(config);
  const state = checkState(config);
  const active = CHECKS.filter(name => state[name]);
  const recent = plainRecent(config);
  const quarantined = countQuarantined(guild, config);

  const embed = new EmbedBuilder()
    .setColor(!config.enabled ? COLORS.primary : (config.actionBlock === 'log' ? COLORS.warning : COLORS.success))
    .setTitle(`🚪 Vigie — contrôle à l'arrivée sur ${guild.name}`)
    .setDescription(
      '> Chaque nouveau profil est noté : **compte récent**, **avatar par défaut**, **pseudo à invitation ou à mot d\'arnaque**, ' +
      '**imitation du staff**, **caractères invisibles**. Le score décide si le membre entre, reste en attente ou repart.\n' +
      '> *L\'anti-raid compte les vagues d\'arrivées ; Vigie juge l\'arrivée elle-même — les deux se complètent.*',
    )
    .addFields(
      { name: '📢 Protection', value: config.enabled ? '🟢 Activée' : '🔴 Désactivée', inline: true },
      { name: '⛔ Score de blocage', value: `≥ **${blockScore}**`, inline: true },
      { name: '🟡 Score de surveillance', value: `≥ **${reviewScore}**`, inline: true },
      { name: '⚖️ Action — profil dangereux', value: `\`${config.actionBlock}\``, inline: true },
      { name: '🚪 Action — profil à surveiller', value: `\`${config.actionReview}\``, inline: true },
      { name: '🎂 Âge minimum du compte', value: minAccountAgeDays > 0 ? `**${minAccountAgeDays}** jour(s)` : '*contrôle désactivé*', inline: true },
      { name: '🔎 Contrôles actifs', value: active.length ? active.map(name => `✅ ${LABELS[name] || name}`).join('\n') : '*aucun contrôle actif*', inline: false },
      { name: '📋 Salon d\'alerte', value: config.logChannelId ? `<#${config.logChannelId}>` : '*salon automatique*', inline: true },
      { name: '🚪 Rôle d\'attente', value: config.quarantineRoleId ? `<@&${config.quarantineRoleId}> · **${quarantined}** membre(s)` : '*créé automatiquement*', inline: true },
      { name: '⏳ Salle d’attente', value: (config.jail || []).length ? `**${config.jail.length}** membre(s) en attente de l’âge requis` : '*personne en attente*', inline: true },
      { name: '🔔 MP au membre', value: config.dmOnBlock ? '🟢 Oui' : '🔴 Non', inline: true },
      { name: '📛 Confiance', value: `${(config.trustedRoles || []).map(r => `<@&${r}>`).join(', ') || '*aucun rôle*'} · ${(config.trustedUsers || []).length} utilisateur(s)`, inline: false },
      { name: '📊 Statistiques', value: `✅ ${config.stats?.allowed || 0} laissé(s) passer · 🟡 ${config.stats?.reviewed || 0} surveillé(s) · ⛔ ${config.stats?.blocked || 0} écarté(s)`, inline: false },
      { name: '🗂️ Dernières décisions', value: recent.length ? recent.slice(-3).reverse().map(d => formatDecision(d)).join('\n') : '*aucune arrivée analysée*', inline: false },
    )
    .setFooter({ text: 'REZO • Vigie — seuls les profils signalés sont journalisés' })
    .setTimestamp();

  // ⚠️ Un select menu occupe toute la largeur d'une rangée : jamais de bouton
  // dans la même rangée (erreur Discord 50035 WIDTH_EXCEEDED).
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cj_toggle').setLabel(config.enabled ? '🔴 Désactiver' : '🟢 Activer').setStyle(config.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cj_status').setLabel('Statut').setEmoji('📊').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('cj_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('cj_alert').setPlaceholder('📋 Salon des alertes Vigie…').addChannelTypes(ChannelType.GuildText),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('cj_qrole').setPlaceholder('🚪 Rôle d\'attente (quarantaine)…').setMinValues(1).setMaxValues(1),
  );

  const row4 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('cj_action').setPlaceholder('⚖️ Action pour un profil dangereux…').addOptions(
      Object.entries(ACTION_LABELS).map(([value, label]) => ({ label, value, default: config.actionBlock === value })),
    ),
  );

  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cj_thresholds').setLabel('Seuils').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cj_words').setLabel('Mots interdits').setEmoji('🤬').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cj_checks').setLabel('Contrôles').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cj_trust').setLabel('Confiance').setEmoji('📛').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cj_recent').setLabel('Arrivées').setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

// ─── Vues éphémères ──────────────────────────────────────────────────────────
function buildChecksView(config) {
  const state = checkState(config);
  const checksMenu = new StringSelectMenuBuilder()
    .setCustomId('cj_checks_select')
    .setPlaceholder('🔎 Contrôles à appliquer (cochez pour activer)…')
    .setMinValues(0)
    .setMaxValues(CHECKS.length)
    .addOptions(CHECKS.map(name => ({
      label: (LABELS[name] || name).slice(0, 100),
      value: name,
      default: state[name],
    })));

  const reviewMenu = new StringSelectMenuBuilder()
    .setCustomId('cj_review_select')
    .setPlaceholder('🚪 Action pour un profil à surveiller…')
    .addOptions(Object.entries(REVIEW_LABELS).map(([value, label]) => ({ label, value, default: config.actionReview === value })));

  return {
    embeds: [infoEmbed(
      '🔎 Contrôles et actions fines',
      'Choisissez les contrôles appliqués à chaque arrivée, puis ce qu\'il advient d\'un profil simplement **à surveiller** ' +
      '(sous le score de blocage).\n\n' +
      CHECKS.map(name => `${state[name] ? '🟢' : '🔴'} ${LABELS[name] || name}`).join('\n'),
    )],
    components: [
      new ActionRowBuilder().addComponents(checksMenu),
      new ActionRowBuilder().addComponents(reviewMenu),
    ],
  };
}

function buildTrustView(config) {
  const roles = config.trustedRoles || [];
  const users = config.trustedUsers || [];
  return {
    embeds: [infoEmbed(
      '📛 Membres de confiance',
      'Les membres de confiance ne sont **jamais** analysés : propriétaire, bot, rôles et utilisateurs ci-dessous. ' +
      'Ajoutez-y votre staff et vos bots de gestion légitimes.\n\u200b',
    ).addFields(
      { name: '🎭 Rôles', value: roles.length ? roles.map(r => `<@&${r}>`).join('\n') : '*aucun*', inline: true },
      { name: '👤 Utilisateurs', value: users.length ? users.map(u => `<@${u}>`).join('\n') : '*aucun*', inline: true },
    )],
    components: [
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId('cj_trust_roles').setPlaceholder('➕ Ajouter des rôles de confiance…').setMinValues(1).setMaxValues(10),
      ),
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('cj_trust_users').setPlaceholder('➕ Ajouter des utilisateurs de confiance…').setMinValues(1).setMaxValues(10),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cj_trust_clear_roles').setLabel('Vider les rôles').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cj_trust_clear_users').setLabel('Vider les utilisateurs').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

function buildRecentView(config, guild) {
  const recent = plainRecent(config).slice().reverse().slice(0, 12);
  const quarantined = countQuarantined(guild, config);
  return {
    embeds: [new EmbedBuilder()
      .setColor(recent.length ? COLORS.info : COLORS.success)
      .setTitle('🗂️ Vigie — arrivées analysées')
      .setDescription(recent.length
        ? recent.map(d => formatDecision(d)).join('\n\n')
        : 'Aucune arrivée signalée. 🎉')
      .addFields({ name: '🚪 En attente de vérification', value: `${quarantined} membre(s)${config.quarantineRoleId ? ` avec <@&${config.quarantineRoleId}>` : ''}`, inline: false })
      .setFooter({ text: `REZO • Vigie — ${config.stats?.blocked || 0} profil(s) écarté(s) au total · 12 dernières décisions` })
      .setTimestamp()],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cj_release').setLabel(`Libérer les ${quarantined} en attente`).setEmoji('🔓').setStyle(ButtonStyle.Success).setDisabled(quarantined === 0 || !config.quarantineRoleId),
      ),
    ],
  };
}

// ─── Modaux ──────────────────────────────────────────────────────────────────
function thresholdsModal(config) {
  const { blockScore, reviewScore, minAccountAgeDays } = effectiveThresholds(config);
  return new ModalBuilder().setCustomId('cj_modal_thresholds').setTitle('📊 Seuils de Vigie')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min_age').setLabel('Âge minimum du compte (jours, 0 = off)').setStyle(TextInputStyle.Short).setValue(String(minAccountAgeDays)).setRequired(true).setMaxLength(4)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('block_score').setLabel('Score de blocage (10-100)').setStyle(TextInputStyle.Short).setValue(String(blockScore)).setRequired(true).setMaxLength(3)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('review_score').setLabel('Score de surveillance (5-99)').setStyle(TextInputStyle.Short).setValue(String(reviewScore)).setRequired(true).setMaxLength(3)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dm').setLabel('Prévenir le membre par MP ? (oui/non)').setStyle(TextInputStyle.Short).setValue(config.dmOnBlock ? 'oui' : 'non').setRequired(true).setMaxLength(3)),
    );
}

function wordsModal(config) {
  return new ModalBuilder().setCustomId('cj_modal_words').setTitle('🤬 Mots interdits et exceptions')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('blocked').setLabel('Mots interdits (un par ligne)').setStyle(TextInputStyle.Paragraph).setRequired(false)
          .setValue((config.blockedWords || []).join('\n')).setPlaceholder('exemple\ncrypto\nmon-serveur').setMaxLength(800),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('allowed').setLabel('Exceptions (un par ligne)').setStyle(TextInputStyle.Paragraph).setRequired(false)
          .setValue((config.allowedWords || []).join('\n')).setPlaceholder('mot que vous autorisez malgré tout').setMaxLength(500),
      ),
    );
}

function parseWords(raw) {
  return String(raw || '')
    .split(/[\n,;]+/)
    .map(w => w.trim())
    .filter(Boolean)
    .slice(0, 100);
}

// ═════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('controle-arrivee')
    .setDescription('🚪 Vigie — contrôle du profil des membres qui rejoignent (comptes neufs, pseudos suspects)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const config = await getConfig(interaction.guild.id);
    return interaction.reply({ ...(await buildPanel(config, interaction.guild)), ephemeral: true });
  },

  // ─── Boutons (persistants) ─────────────────────────────────────────────────
  async handleButton(interaction, client) {
    const id = interaction.customId;
    const guild = interaction.guild;
    const config = await getConfig(guild.id);

    if (id === 'cj_refresh') return interaction.update(await buildPanel(config, guild));

    if (id === 'cj_toggle') {
      config.enabled = !config.enabled;
      await config.save();
      if (config.enabled && !config.quarantineRoleId) {
        await ensureQuarantineRole(guild, config, {
          name: '🚪 En attente de vérification',
          color: 0x99AAB5,
          reason: 'Vigie : rôle d\'attente',
        }).catch(() => {});
      }
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'cj_status') {
      const { blockScore, reviewScore } = effectiveThresholds(config);
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(config.enabled ? COLORS.info : COLORS.warning)
          .setTitle('📊 Vigie — état du contrôle à l\'arrivée')
          .setDescription(config.enabled
            ? 'Chaque arrivée est analysée. Un score ≥ ' + blockScore + ' écarte le profil, un score ≥ ' + reviewScore + ' le met sous surveillance.'
            : '⚠️ Vigie est **désactivée** : les profils ne sont plus analysés.')
          .addFields(
            { name: '📊 Statistiques', value: `✅ ${config.stats?.allowed || 0} · 🟡 ${config.stats?.reviewed || 0} · ⛔ ${config.stats?.blocked || 0}`, inline: true },
            { name: '🚪 En attente', value: `${countQuarantined(guild, config)} membre(s)`, inline: true },
            { name: '🕐 Dernière décision', value: config.stats?.lastDecisionAt ? `<t:${Math.floor(new Date(config.stats.lastDecisionAt).getTime() / 1000)}:R>` : '*aucune*', inline: true },
            { name: '🔗 Liste noire anti-raid', value: config.useAntiRaidBlacklist ? '🟢 Partagée' : '🔴 Ignorée', inline: true },
          )
          .setTimestamp()],
        ephemeral: true,
      });
    }

    if (id === 'cj_thresholds') return interaction.showModal(thresholdsModal(config));
    if (id === 'cj_words') return interaction.showModal(wordsModal(config));
    if (id === 'cj_checks') return interaction.reply({ ...buildChecksView(config), ephemeral: true });
    if (id === 'cj_trust') return interaction.reply({ ...buildTrustView(config), ephemeral: true });
    if (id === 'cj_recent') return interaction.reply({ ...buildRecentView(config, guild), ephemeral: true });

    if (id === 'cj_release') {
      const released = await releaseQuarantined(guild, config);
      return interaction.reply({
        embeds: [released
          ? successEmbed('Quarantaines levées', `${released} membre(s) peuvent de nouveau écrire : le rôle d'attente leur a été retiré.`)
          : infoEmbed('Rien à libérer', 'Aucun membre ne porte le rôle d\'attente.')],
        ephemeral: true,
      });
    }

    if (id === 'cj_trust_clear_roles' || id === 'cj_trust_clear_users') {
      if (id === 'cj_trust_clear_roles') config.trustedRoles = [];
      else config.trustedUsers = [];
      await config.save();
      return interaction.update(buildTrustView(config));
    }

    return interaction.reply({ embeds: [errorEmbed('Action inconnue', 'Ce bouton n\'est plus valide — rouvrez `/controle-arrivee`.')], ephemeral: true });
  },

  // ─── Menus (persistants) ───────────────────────────────────────────────────
  async handleSelect(interaction, client) {
    const id = interaction.customId;
    const guild = interaction.guild;
    const config = await getConfig(guild.id);

    if (id === 'cj_alert') {
      config.logChannelId = interaction.values[0];
      await config.save();
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'cj_qrole') {
      config.quarantineRoleId = interaction.values[0];
      await config.save();
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'cj_action') {
      config.actionBlock = interaction.values[0];
      await config.save();
      return interaction.update(await buildPanel(config, guild));
    }

    if (id === 'cj_checks_select') {
      const selected = interaction.values;
      const checks = {};
      for (const name of CHECKS) checks[name] = selected.includes(name);
      config.checks = checks;
      await config.save();
      return interaction.update(buildChecksView(config));
    }

    if (id === 'cj_review_select') {
      config.actionReview = interaction.values[0];
      await config.save();
      return interaction.update(buildChecksView(config));
    }

    if (id === 'cj_trust_roles') {
      config.trustedRoles = [...new Set([...(config.trustedRoles || []), ...interaction.values])];
      await config.save();
      return interaction.update(buildTrustView(config));
    }

    if (id === 'cj_trust_users') {
      config.trustedUsers = [...new Set([...(config.trustedUsers || []), ...interaction.values])];
      await config.save();
      return interaction.update(buildTrustView(config));
    }
  },

  // ─── Modaux (persistants) ──────────────────────────────────────────────────
  async handleModal(interaction) {
    const id = interaction.customId;
    const config = await getConfig(interaction.guildId);

    if (id === 'cj_modal_thresholds') {
      const minAge = parseInt(interaction.fields.getTextInputValue('min_age'), 10);
      const blockScore = parseInt(interaction.fields.getTextInputValue('block_score'), 10);
      const reviewScore = parseInt(interaction.fields.getTextInputValue('review_score'), 10);
      const dm = parseBool(interaction.fields.getTextInputValue('dm'), config.dmOnBlock);

      if (!Number.isFinite(minAge) || minAge < 0 || minAge > 365) {
        return interaction.reply({ embeds: [errorEmbed('Âge invalide', 'Indiquez un nombre de jours entre **0** (contrôle désactivé) et **365**.')], ephemeral: true });
      }
      if (!Number.isFinite(blockScore) || blockScore < 10 || blockScore > 100 ||
          !Number.isFinite(reviewScore) || reviewScore < 5 || reviewScore > 99 || reviewScore >= blockScore) {
        return interaction.reply({ embeds: [errorEmbed('Scores invalides', 'Le score de blocage doit être entre **10** et **100**, celui de surveillance entre **5** et **99**, et **inférieur** au score de blocage.')], ephemeral: true });
      }

      config.minAccountAgeDays = minAge;
      config.blockScore = blockScore;
      config.reviewScore = reviewScore;
      config.dmOnBlock = dm;
      await config.save();
      return interaction.reply({
        embeds: [successEmbed('Seuils mis à jour', `Âge minimum : **${minAge || 'désactivé'}** · blocage ≥ **${blockScore}** · surveillance ≥ **${reviewScore}** · MP : **${dm ? 'oui' : 'non'}**`)],
        ephemeral: true,
      });
    }

    if (id === 'cj_modal_words') {
      config.blockedWords = parseWords(interaction.fields.getTextInputValue('blocked'));
      config.allowedWords = parseWords(interaction.fields.getTextInputValue('allowed'));
      await config.save();
      return interaction.reply({
        embeds: [successEmbed('Listes mises à jour', `**${config.blockedWords.length}** mot(s) interdit(s) · **${config.allowedWords.length}** exception(s).\nLes exceptions priment toujours sur les mots interdits et sur le vocabulaire d'arnaque.`)],
        ephemeral: true,
      });
    }
  },

  __testables: { parseBool, parseWords, buildPanel, buildChecksView, buildTrustView, buildRecentView, thresholdsModal, wordsModal, checkState },
};
