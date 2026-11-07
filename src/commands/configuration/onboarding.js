'use strict';
// commands/configuration/onboarding.js — Panel v2 du portail d'accès
//
// Quatre pages : vue d'ensemble, canaux, rôles, questions. Tout ce qui était
// figé avant (question ajoutée puis impossible à corriger, un seul rôle
// d'accès, aucune trace) est maintenant réglable ici.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType,
} = require('discord.js');
const OnboardingConfig = require('../../models/OnboardingConfig');
const {
  lockdownExistingChannels, ensureUnverifiedRole, buildStepPayload,
  normalizeType, normalizeIdList, validateQuestion, resolveAccessRoles,
  TYPE_LABEL, MAX_QUESTIONS,
} = require('../../utils/onboardingManager');
const { COLORS, errorEmbed } = require('../../utils/embeds');

async function getOrCreate(guildId) {
  let cfg = await OnboardingConfig.findOne({ guildId });
  if (!cfg) cfg = await OnboardingConfig.create({ guildId });
  return cfg;
}

const onOff = value => (value ? '✅ Oui' : '❌ Non');
const chan = id => (id ? `<#${id}>` : '*Non défini*');
const role = id => (id ? `<@&${id}>` : '*Aucun*');

// ─── Vue d'ensemble ─────────────────────────────────────────────────────────

function buildOverviewEmbed(cfg, guild) {
  const preview = cfg.questions.length
    ? cfg.questions.slice(0, 8).map((q, i) =>
      `**${i + 1}.** ${TYPE_LABEL[q.type] || '💬 Texte'} — ${q.prompt.slice(0, 60)}${q.required === false ? ' *(optionnel)*' : ''}`,
    ).join('\n') + (cfg.questions.length > 8 ? `\n*… et ${cfg.questions.length - 8} autre(s)*` : '')
    : '*Aucune étape configurée.*';

  const access = resolveAccessRoles(cfg);

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🚪 Portail d’accès — vue d’ensemble')
    .setDescription('Chaque nouveau membre reçoit un portail, répond aux étapes, puis obtient ses rôles. Le captcha et la validation staff s’appliquent avant l’accès.')
    .addFields(
      { name: '📢 Statut', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: '🧭 Mode', value: cfg.mode === 'shared' ? '👥 Salon partagé' : '🔒 Salon privé', inline: true },
      { name: '📁 Catégorie', value: chan(cfg.categoryId), inline: true },
      { name: '🚫 Non-vérifié', value: role(cfg.unverifiedRoleId), inline: true },
      { name: '✅ Rôles d’accès', value: access.length ? access.map(id => `<@&${id}>`).join(' ') : '*Aucun (retrait de la quarantaine seule)*', inline: true },
      { name: '🗑️ Salon à la fin', value: onOff(cfg.deleteChannelOnComplete), inline: true },
      { name: '⏱️ Délai', value: cfg.timeoutMinutes > 0 ? `${cfg.timeoutMinutes} min → ${cfg.timeoutAction === 'kick' ? 'expulsion' : 'aucune action'}` : '*Aucune limite*', inline: true },
      { name: '🔔 Relance', value: cfg.remindAfterMinutes > 0 ? `Après ${cfg.remindAfterMinutes} min` : '*Aucune*', inline: true },
      { name: '🕓 Validation staff', value: cfg.reviewEnabled ? `Oui — ${chan(cfg.reviewChannelId)}` : 'Non', inline: true },
      { name: '📋 Journal', value: chan(cfg.logChannelId), inline: true },
      { name: '💬 MP d’accueil', value: onOff(cfg.dmWelcome !== false), inline: true },
      { name: '📊 Arrivées / terminés / expirés', value: `${cfg.totalStarted || 0} / ${cfg.totalCompleted || 0} / ${cfg.totalTimedOut || 0}`, inline: true },
      { name: '🗳️ Validés / refusés (staff)', value: `${cfg.totalApproved || 0} / ${cfg.totalRejected || 0}`, inline: true },
      { name: `❓ Étapes (${cfg.questions.length}/${MAX_QUESTIONS})`, value: preview, inline: false },
    )
    .setThumbnail(guild.iconURL?.({ dynamic: true }) || null)
    .setFooter({ text: 'Placeholders : {user} {server} {link}' })
    .setTimestamp();
}

function buildOverviewRows(cfg) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ob_toggle_enabled').setLabel(cfg.enabled ? '🔴 Désactiver' : '🟢 Activer').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ob_toggle_mode').setLabel(cfg.mode === 'shared' ? '🔒 Passer en privé' : '👥 Passer en partagé').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ob_toggle_delete').setLabel('🗑️ Salon à la fin').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ob_toggle_review').setLabel('🕓 Validation staff').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ob_settings').setLabel('⚙️ Délais & relance').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ob_messages').setLabel('💬 Messages').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ob_page_channels').setLabel('📁 Canaux').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ob_page_roles').setLabel('🎭 Rôles').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ob_settings_review').setLabel('🕓 Délai de revue').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ob_page_questions').setLabel('📋 Étapes').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ob_preview').setLabel('👁️ Aperçu').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ob_close').setLabel('✖ Fermer').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Canaux ─────────────────────────────────────────────────────────────────

function buildChannelsEmbed(cfg) {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📁 Canaux du portail')
    .setDescription('Choisis où vivent les portails, où arrivent les décisions et où se trouve le journal.')
    .addFields(
      { name: '📁 Catégorie (salons privés)', value: chan(cfg.categoryId), inline: true },
      { name: '👥 Salon partagé', value: chan(cfg.sharedChannelId), inline: true },
      { name: '📋 Journal', value: chan(cfg.logChannelId), inline: true },
      { name: '🕓 Validation staff', value: chan(cfg.reviewChannelId), inline: true },
    )
    .setFooter({ text: 'Le salon partagé n’est utilisé qu’en mode partagé.' });
}

function buildChannelsRows() {
  return [
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId('ob_select_category')
      .setPlaceholder('📁 Catégorie des salons d’accueil…')
      .addChannelTypes(ChannelType.GuildCategory)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId('ob_select_shared')
      .setPlaceholder('👥 Salon partagé (mode partagé)…')
      .addChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId('ob_select_log')
      .setPlaceholder('📋 Salon de journal…')
      .addChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId('ob_select_review')
      .setPlaceholder('🕓 Salon de validation staff…')
      .addChannelTypes(ChannelType.GuildText)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ob_page_overview').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Rôles ──────────────────────────────────────────────────────────────────

function buildRolesEmbed(cfg) {
  const access = resolveAccessRoles(cfg);
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🎭 Rôles du portail')
    .setDescription('Le rôle non-vérifié sert de quarantaine ; les rôles d’accès sont posés à la fin du portail.')
    .addFields(
      { name: '🚫 Non-vérifié', value: role(cfg.unverifiedRoleId), inline: true },
      { name: '✅ Rôles d’accès', value: access.length ? access.map(id => `<@&${id}>`).join(' ') : '*Aucun*', inline: false },
      { name: '🔔 Rôle averti (validation)', value: role(cfg.reviewPingRoleId), inline: true },
    )
    .setFooter({ text: 'Les menus d’étapes de type « rôles » attribuent les rôles choisis par le membre.' });
}

function buildRolesRows() {
  return [
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
      .setCustomId('ob_select_roles')
      .setPlaceholder('✅ Rôles donnés à la fin (jusqu’à 5)…')
      .setMinValues(0)
      .setMaxValues(5)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
      .setCustomId('ob_select_unverified')
      .setPlaceholder('🚫 Rôle de quarantaine…')
      .setMinValues(0)
      .setMaxValues(1)),
    new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
      .setCustomId('ob_select_review_ping')
      .setPlaceholder('🔔 Rôle averti lors d’une demande…')
      .setMinValues(0)
      .setMaxValues(1)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ob_page_overview').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ─── Étapes ─────────────────────────────────────────────────────────────────

function buildQuestionsEmbed(cfg) {
  const lines = cfg.questions.length
    ? cfg.questions.map((q, i) => {
      const extra = q.type === 'choice' ? `\n> ${q.choices.join(' · ')}`
        : q.type === 'roles' ? `\n> ${normalizeIdList(q.choices.join(' '), 25).map(id => `<@&${id}>`).join(' ')}`
          : '';
      return `**${i + 1}.** ${TYPE_LABEL[q.type] || '💬 Texte'} — ${q.prompt}${q.required === false ? ' *(optionnel)*' : ''}${extra}`;
    }).join('\n\n')
    : '*Aucune étape : les membres entreront directement.*';

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📋 Étapes du portail')
    .setDescription(lines.slice(0, 4000))
    .setFooter({ text: 'Types : texte, choix (boutons), rôles (menu), règlement (acceptation).' });
}

function buildQuestionsRows(cfg) {
  const rows = [];
  if (cfg.questions.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId('ob_select_question')
      .setPlaceholder('Sélectionner une étape…')
      .addOptions(cfg.questions.slice(0, 25).map((q, i) => ({
        label: `${i + 1}. ${q.prompt}`.slice(0, 100),
        description: (TYPE_LABEL[q.type] || 'Texte').slice(0, 100),
        value: q.id,
      })))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ob_add_question').setLabel('➕ Ajouter').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ob_question_edit').setLabel('✏️ Modifier').setStyle(ButtonStyle.Primary).setDisabled(!cfg.questions.length),
    new ButtonBuilder().setCustomId('ob_question_up').setLabel('⬆️').setStyle(ButtonStyle.Secondary).setDisabled(!cfg.questions.length),
    new ButtonBuilder().setCustomId('ob_question_down').setLabel('⬇️').setStyle(ButtonStyle.Secondary).setDisabled(!cfg.questions.length),
    new ButtonBuilder().setCustomId('ob_question_delete').setLabel('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!cfg.questions.length),
  ));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ob_preview').setLabel('👁️ Aperçu').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ob_page_overview').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

function render(cfg, guild, page = 'overview') {
  if (page === 'channels') {
    return { embeds: [buildChannelsEmbed(cfg)], components: buildChannelsRows() };
  }
  if (page === 'roles') {
    return { embeds: [buildRolesEmbed(cfg)], components: buildRolesRows() };
  }
  if (page === 'questions') {
    return { embeds: [buildQuestionsEmbed(cfg)], components: buildQuestionsRows(cfg) };
  }
  return { embeds: [buildOverviewEmbed(cfg, guild)], components: buildOverviewRows(cfg) };
}

// ─── Modaux ─────────────────────────────────────────────────────────────────

function questionModal(cfg, question) {
  const edit = Boolean(question);
  const type = question?.type || 'text';
  const choices = question
    ? (type === 'roles' ? normalizeIdList(question.choices.join(' '), 10).join(', ') : (question.choices || []).join(', '))
    : '';

  const modal = new ModalBuilder()
    .setCustomId(edit ? `ob_modal_edit_question:${question.id}` : 'ob_modal_add_question')
    .setTitle(edit ? '✏️ Modifier une étape' : '➕ Nouvelle étape');

  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('ob_q_prompt')
      .setLabel('Question posée')
      .setStyle(TextInputStyle.Paragraph)
      .setValue(question?.prompt || '')
      .setMaxLength(300)
      .setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('ob_q_type')
      .setLabel('Type : texte, choix, rôles ou règlement')
      .setStyle(TextInputStyle.Short)
      .setValue(type)
      .setMaxLength(20)
      .setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('ob_q_choices')
      .setLabel('Choix (libellés) ou IDs de rôles')
      .setStyle(TextInputStyle.Paragraph)
      .setValue(choices)
      .setMaxLength(500)
      .setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('ob_q_required')
      .setLabel('Obligatoire ? oui / non')
      .setStyle(TextInputStyle.Short)
      .setValue(question ? (question.required === false ? 'non' : 'oui') : 'oui')
      .setMaxLength(5)
      .setRequired(true)),
  );

  return modal;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('onboarding')
    .setDescription('🚪 Panel du portail d’accès (étapes, rôles, validation staff)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles),

  async execute(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);
    let page = 'overview';
    // Dernière étape choisie dans le menu : les boutons Modifier / ⬆️ / ⬇️ / 🗑️
    // n'ont pas de `values`, ils s'appuient sur cette sélection.
    let selectedId = null;

    const refresh = async (i, nextPage = page) => {
      page = nextPage;
      const fresh = await getOrCreate(interaction.guild.id);
      const payload = render(fresh, interaction.guild, page);
      if (i.deferred || i.replied) return i.editReply(payload).catch(() => {});
      return i.update(payload).catch(() => {});
    };

    const reply = await interaction.reply({
      ...render(cfg, interaction.guild, page),
      ephemeral: true,
      fetchReply: true,
    });

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 20 * 60 * 1000,
    });

    col.on('collect', async i => {
      try {
        const live = await getOrCreate(interaction.guild.id);
        if (i.customId === 'ob_close') return i.update({ components: [] });

        // ── Navigation ────────────────────────────────────────────────────
        if (i.customId.startsWith('ob_page_')) return refresh(i, i.customId.replace('ob_page_', ''));
        if (i.customId === 'ob_preview') {
          const demo = live.questions[0] || {
            id: 'apercu', type: 'choice', prompt: 'Aperçu : cette étape n’existe pas encore.',
            choices: ['Option A', 'Option B'], required: true,
          };
          return i.reply({
            ...buildStepPayload(demo, 0, Math.max(1, live.questions.length), { guild: interaction.guild, memberId: i.user.id }),
            ephemeral: true,
          });
        }

        // ── Canaux ────────────────────────────────────────────────────────
        if (i.customId === 'ob_select_category') { live.categoryId = i.values[0] || null; await live.save(); return refresh(i); }
        if (i.customId === 'ob_select_shared') { live.sharedChannelId = i.values[0] || null; await live.save(); return refresh(i, 'channels'); }
        if (i.customId === 'ob_select_log') { live.logChannelId = i.values[0] || null; await live.save(); return refresh(i, 'channels'); }
        if (i.customId === 'ob_select_review') { live.reviewChannelId = i.values[0] || null; await live.save(); return refresh(i, 'channels'); }

        // ── Rôles ─────────────────────────────────────────────────────────
        if (i.customId === 'ob_select_roles') { live.accessRoleIds = i.values || []; live.accessRoleId = null; await live.save(); return refresh(i, 'roles'); }
        if (i.customId === 'ob_select_unverified') { live.unverifiedRoleId = i.values[0] || null; await live.save(); return refresh(i, 'roles'); }
        if (i.customId === 'ob_select_review_ping') { live.reviewPingRoleId = i.values[0] || null; await live.save(); return refresh(i, 'roles'); }

        // ── Interrupteurs ─────────────────────────────────────────────────
        if (i.customId === 'ob_toggle_enabled') {
          if (!live.enabled && live.questions.length === 0) {
            return i.reply({
              embeds: [errorEmbed('Aucune étape', 'Ajoute au moins une étape avant d’activer le portail.')],
              ephemeral: true,
            });
          }
          const enabling = !live.enabled;
          live.enabled = enabling;
          await live.save();
          if (!enabling) return refresh(i);

          // À l'activation : quarantaine réelle sur tous les salons existants.
          await i.deferUpdate();
          const unverified = await ensureUnverifiedRole(interaction.guild, live);
          await lockdownExistingChannels(interaction.guild, unverified, live.categoryId);
          const fresh = await getOrCreate(interaction.guild.id);
          return i.editReply(render(fresh, interaction.guild, 'overview')).catch(() => {});
        }

        if (i.customId === 'ob_toggle_mode') {
          live.mode = live.mode === 'shared' ? 'private' : 'shared';
          await live.save();
          return refresh(i);
        }
        if (i.customId === 'ob_toggle_delete') { live.deleteChannelOnComplete = !live.deleteChannelOnComplete; await live.save(); return refresh(i); }
        if (i.customId === 'ob_toggle_review') { live.reviewEnabled = !live.reviewEnabled; await live.save(); return refresh(i); }

        // ── Modaux ────────────────────────────────────────────────────────
        if (i.customId === 'ob_settings') {
          return i.showModal(new ModalBuilder().setCustomId('ob_modal_settings').setTitle('⚙️ Délais du portail').addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ob_timeout').setLabel('Délai limite en minutes (0 = aucun)').setStyle(TextInputStyle.Short).setValue(String(live.timeoutMinutes || 0)).setMaxLength(5).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ob_remind').setLabel('Relance après X minutes (0 = jamais)').setStyle(TextInputStyle.Short).setValue(String(live.remindAfterMinutes || 0)).setMaxLength(5).setRequired(true)),
          ));
        }

        if (i.customId === 'ob_messages') {
          return i.showModal(new ModalBuilder().setCustomId('ob_modal_messages').setTitle('💬 Messages du portail').addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ob_welcome').setLabel('Accueil dans le salon').setStyle(TextInputStyle.Paragraph).setValue(live.welcomeMessage).setMaxLength(1000).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ob_dm').setLabel('MP d’accueil ({link} = lien)').setStyle(TextInputStyle.Paragraph).setValue(live.dmMessage || '').setMaxLength(1000).setRequired(false)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ob_completion').setLabel('Message de fin').setStyle(TextInputStyle.Paragraph).setValue(live.completionMessage).setMaxLength(1000).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ob_rejection').setLabel('Message de refus (validation staff)').setStyle(TextInputStyle.Paragraph).setValue(live.rejectionMessage || '').setMaxLength(1000).setRequired(false)),
          ));
        }

        if (i.customId === 'ob_page_review' || i.customId === 'ob_settings_review') {
          return i.showModal(new ModalBuilder().setCustomId('ob_modal_review').setTitle('🕓 Validation staff').addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ob_review_timeout').setLabel('Refus auto après X minutes (0 = jamais)').setStyle(TextInputStyle.Short).setValue(String(live.reviewTimeoutMinutes || 0)).setMaxLength(5).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ob_reject_action').setLabel('Membre refusé : aucune action ou kick').setStyle(TextInputStyle.Short).setValue(live.reviewRejectAction || 'none').setMaxLength(10).setRequired(true)),
          ));
        }

        if (i.customId === 'ob_add_question') {
          if (live.questions.length >= MAX_QUESTIONS) {
            return i.reply({ embeds: [errorEmbed('Limite atteinte', `Maximum ${MAX_QUESTIONS} étapes.`)], ephemeral: true });
          }
          return i.showModal(questionModal(live, null));
        }

        // ── Édition des étapes ────────────────────────────────────────────
        if (i.customId === 'ob_select_question') { selectedId = i.values[0]; return i.deferUpdate().catch(() => {}); }

        if (i.customId === 'ob_question_edit') {
          const target = live.questions.find(q => q.id === selectedId) || live.questions[0];
          return i.showModal(questionModal(live, target));
        }

        if (i.customId === 'ob_question_up' || i.customId === 'ob_question_down') {
          const target = live.questions.find(q => q.id === selectedId) || live.questions[0];
          const at = live.questions.findIndex(q => q.id === target?.id);
          const to = i.customId === 'ob_question_up' ? at - 1 : at + 1;
          if (at < 0 || to < 0 || to >= live.questions.length) return refresh(i, 'questions');
          const list = [...live.questions];
          [list[at], list[to]] = [list[to], list[at]];
          live.questions = list;
          await live.save();
          return refresh(i, 'questions');
        }

        if (i.customId === 'ob_question_delete') {
          const target = live.questions.find(q => q.id === selectedId) || live.questions[0];
          if (!target) return refresh(i, 'questions');
          live.questions = live.questions.filter(q => q.id !== target.id);
          await live.save();
          return refresh(i, 'questions');
        }
      } catch (err) {
        console.error('onboarding panel:', err.message);
      }
    });

    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Soumissions de modaux (routées depuis interactionCreate.js) ──────────
  async handleModal(interaction) {
    const cfg = await getOrCreate(interaction.guild.id);

    if (interaction.customId === 'ob_modal_settings') {
      const timeout = parseInt(interaction.fields.getTextInputValue('ob_timeout'), 10);
      const remind = parseInt(interaction.fields.getTextInputValue('ob_remind'), 10);
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 10080
        || !Number.isFinite(remind) || remind < 0 || remind > 10080) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Les délais vont de 0 à 10080 minutes (7 jours).')], ephemeral: true });
      }
      cfg.timeoutMinutes = timeout;
      cfg.remindAfterMinutes = remind;
      await cfg.save();
    }

    if (interaction.customId === 'ob_modal_messages') {
      cfg.welcomeMessage = interaction.fields.getTextInputValue('ob_welcome').trim();
      cfg.completionMessage = interaction.fields.getTextInputValue('ob_completion').trim();
      cfg.dmMessage = interaction.fields.getTextInputValue('ob_dm').trim();
      cfg.rejectionMessage = interaction.fields.getTextInputValue('ob_rejection').trim();
      await cfg.save();
    }

    if (interaction.customId === 'ob_modal_review') {
      const timeout = parseInt(interaction.fields.getTextInputValue('ob_review_timeout'), 10);
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 10080) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Le délai va de 0 à 10080 minutes.')], ephemeral: true });
      }
      cfg.reviewTimeoutMinutes = timeout;
      cfg.reviewRejectAction = /kick/i.test(interaction.fields.getTextInputValue('ob_reject_action')) ? 'kick' : 'none';
      await cfg.save();
    }

    if (interaction.customId === 'ob_modal_add_question' || interaction.customId.startsWith('ob_modal_edit_question')) {
      const editId = interaction.customId.startsWith('ob_modal_edit_question')
        ? interaction.customId.split(':')[1]
        : null;

      const prompt = interaction.fields.getTextInputValue('ob_q_prompt').trim();
      const type = normalizeType(interaction.fields.getTextInputValue('ob_q_type'));
      const rawChoices = interaction.fields.getTextInputValue('ob_q_choices');
      const required = !/^non$/i.test(interaction.fields.getTextInputValue('ob_q_required').trim());

      const choices = type === 'roles'
        ? normalizeIdList(rawChoices, 10)
        : rawChoices.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);

      const verdict = validateQuestion({ prompt, type, choices, required });
      if (!verdict.ok) {
        return interaction.reply({ embeds: [errorEmbed('Étape invalide', verdict.error)], ephemeral: true });
      }

      if (editId) {
        const target = cfg.questions.find(q => q.id === editId);
        if (target) {
          target.prompt = prompt;
          target.type = type;
          target.choices = choices;
          target.required = type === 'rules' ? true : required;
        }
      } else {
        if (cfg.questions.length >= MAX_QUESTIONS) {
          return interaction.reply({ embeds: [errorEmbed('Limite atteinte', `Maximum ${MAX_QUESTIONS} étapes.`)], ephemeral: true });
        }
        cfg.questions.push({
          id: `q_${Date.now()}`,
          type, prompt, choices,
          required: type === 'rules' ? true : required,
        });
      }
      await cfg.save();
    }

    const payload = render(cfg, interaction.guild, 'overview');
    if (interaction.isFromMessage?.()) return interaction.update(payload);
    return interaction.reply({ ...payload, ephemeral: true });
  },

  // Exposé aux vérifications hors-ligne (structure des rangées Discord).
  _builders: { render, buildOverviewRows, buildChannelsRows, buildRolesRows, buildQuestionsRows },
};
