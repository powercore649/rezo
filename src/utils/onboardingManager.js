'use strict';
// utils/onboardingManager.js — Moteur du portail d'accès (v2)
//
// Parcours d'un nouveau membre :
//   1. rôle « Non-vérifié » + salon (privé ou partagé) + session en base
//   2. étapes : texte, boutons, menu de rôles, acceptation du règlement
//   3. fin → captcha si actif, puis validation staff si demandée, puis accès
//
// Rien n'est accordé sans passer par `grantAccess` : c'est le seul endroit qui
// retire la quarantaine, pose les rôles d'accès et clôture la session.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, PermissionFlagsBits, ChannelType,
} = require('discord.js');
const OnboardingConfig = require('../models/OnboardingConfig');
const OnboardingSession = require('../models/OnboardingSession');
const { COLORS, errorEmbed } = require('./embeds');

const MAX_QUESTIONS = 15;
const TYPES = ['text', 'choice', 'roles', 'rules'];
const TYPE_LABEL = { text: '💬 Texte', choice: '🔘 Choix', roles: '🎭 Rôles', rules: '📜 Règlement' };
const SNOWFLAKE = /^\d{17,20}$/;

// ─── Helpers purs (testables hors-ligne) ─────────────────────────────────────

/** Barre de progression textuelle : 10 cases, jamais hors bornes. */
function progressBar(index, total) {
  const size = 10;
  const count = Math.max(1, Number(total) || 1);
  const at = Math.max(0, Math.min(count - 1, Number(index) || 0));
  const filled = Math.max(1, Math.min(size, Math.round(((at + 1) / count) * size)));
  return '▓'.repeat(filled) + '░'.repeat(size - filled);
}

/** Accepte les formulations françaises saisies par le staff. */
function normalizeType(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (['choices', 'choix', 'choix multiples', 'bouton', 'boutons'].includes(value)) return 'choice';
  if (['role', 'roles', 'rôle', 'rôles', 'menu de rôles', 'menu de roles'].includes(value)) return 'roles';
  if (['regle', 'règle', 'reglement', 'règlement', 'rules', 'charte', 'cgu'].includes(value)) return 'rules';
  return 'text';
}

/** Nettoie une liste d'IDs Discord (rôles) saisie librement. */
function normalizeIdList(raw, max = 10) {
  const list = String(raw || '')
    .split(/[,;\s]+/)
    .map(part => part.replace(/[<@&>]/g, '').trim())
    .filter(part => SNOWFLAKE.test(part));
  return [...new Set(list)].slice(0, max);
}

/**
 * Valide une étape avant enregistrement.
 * @returns {{ok: true}|{ok: false, error: string}}
 */
function validateQuestion({ prompt, type, choices = [], required = true } = {}) {
  const text = String(prompt || '').trim();
  if (text.length < 3) return { ok: false, error: 'La question doit faire au moins 3 caractères.' };
  if (text.length > 300) return { ok: false, error: 'La question ne peut pas dépasser 300 caractères.' };
  if (!TYPES.includes(type)) return { ok: false, error: 'Type inconnu : texte, choix, rôles ou règlement.' };

  if (type === 'choice') {
    const labels = choices.map(c => String(c).trim()).filter(Boolean);
    if (labels.length < 2) return { ok: false, error: 'Une question à choix a besoin d’au moins 2 options séparées par des virgules.' };
    if (labels.length > 5) return { ok: false, error: 'Maximum 5 options (limite des boutons Discord).' };
    if (labels.some(l => l.length > 80)) return { ok: false, error: 'Chaque option doit tenir en 80 caractères.' };
  }

  if (type === 'roles') {
    const ids = normalizeIdList(choices.join(' '));
    if (!ids.length) return { ok: false, error: 'Indique au moins un ID de rôle (clic droit sur le rôle → Copier l’identifiant).' };
    if (ids.length > 10) return { ok: false, error: 'Maximum 10 rôles par étape.' };
  }

  if (type === 'rules' && required === false) {
    return { ok: false, error: 'Une acceptation de règlement est toujours obligatoire.' };
  }

  return { ok: true };
}

/** Rôles d'accès : nouveau champ multiple + ancien champ unique. */
function resolveAccessRoles(cfg) {
  const list = [...(cfg?.accessRoleIds || [])];
  if (cfg?.accessRoleId) list.push(cfg.accessRoleId);
  return [...new Set(list.filter(id => SNOWFLAKE.test(String(id))))];
}

// ─── Salons & rôle de quarantaine ────────────────────────────────────────────

async function ensureUnverifiedRole(guild, cfg) {
  if (cfg.unverifiedRoleId) {
    const existing = guild.roles.cache.get(cfg.unverifiedRoleId);
    if (existing) return existing;
  }

  const role = await guild.roles.create({
    name: 'Non-vérifié',
    color: 0x99AAB5,
    reason: 'Portail d’accès REZO — rôle créé automatiquement',
    permissions: [],
  });

  cfg.unverifiedRoleId = role.id;
  await cfg.save();
  return role;
}

// Verrouille les salons existants pour le rôle non-vérifié (sauf la catégorie
// et le salon partagé du portail, qui doivent rester visibles).
async function lockdownExistingChannels(guild, unverifiedRole, categoryId) {
  const channels = guild.channels.cache.filter(c =>
    c.parentId !== categoryId && c.id !== categoryId);
  for (const channel of channels.values()) {
    if (!channel.permissionsFor || typeof channel.permissionOverwrites?.edit !== 'function') continue;
    await channel.permissionOverwrites.edit(unverifiedRole, { ViewChannel: false }).catch(() => {});
  }
}

async function createOnboardingChannel(member, cfg) {
  const guild = member.guild;
  const category = cfg.categoryId ? guild.channels.cache.get(cfg.categoryId) : null;

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
  ];

  return guild.channels.create({
    name: `accueil-${member.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: category?.id || null,
    topic: `Portail d’accès de ${member.user.tag} (${member.id})`,
    permissionOverwrites: overwrites,
    reason: 'Portail d’accès REZO',
  }).catch(err => { console.error('[Onboarding] Création salon:', err.message); return null; });
}

// Mode partagé : un seul salon pour tout le monde, créé à la première arrivée.
async function ensureSharedChannel(guild, cfg) {
  if (cfg.sharedChannelId) {
    const existing = guild.channels.cache.get(cfg.sharedChannelId);
    if (existing) return existing;
  }
  if (!cfg.unverifiedRoleId) return null;

  const channel = await guild.channels.create({
    name: 'portail-acces',
    type: ChannelType.GuildText,
    parent: cfg.categoryId || null,
    topic: 'Portail d’accès — réponds aux questions pour débloquer le serveur.',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: cfg.unverifiedRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
    ],
    reason: 'Portail d’accès REZO — salon partagé',
  }).catch(err => { console.error('[Onboarding] Salon partagé:', err.message); return null; });

  if (!channel) return null;
  cfg.sharedChannelId = channel.id;
  await cfg.save().catch(() => {});
  return channel;
}

// ─── Étapes ──────────────────────────────────────────────────────────────────

/**
 * Message d'une étape. Exporté pour l'aperçu du panel et les tests.
 * @param {object} question
 * @param {number} index
 * @param {number} total
 * @param {{guild?: object, memberId?: string, shared?: boolean}} ctx
 */
function buildStepPayload(question, index, total, ctx = {}) {
  const count = Math.max(1, Number(total) || 1);
  const isLast = index + 1 >= count;
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(isLast ? '🚪 Portail d’accès — dernière étape' : `🚪 Portail d’accès — étape ${index + 1}/${count}`)
    .setDescription(`${ctx.shared && ctx.memberId ? `<@${ctx.memberId}>\n` : ''}${question.prompt || '*Question vide*'}`)
    .setFooter({
      text: `${progressBar(index, count)} · ${
        question.required === false ? 'Tu peux passer cette étape' : 'Réponse requise'
      }${question.type === 'text' ? ' · réponds ici' : ''}`,
    });

  const components = [];

  if (question.type === 'choice') {
    const choices = (question.choices || []).map(c => String(c)).filter(Boolean).slice(0, 5);
    if (choices.length) {
      components.push(new ActionRowBuilder().addComponents(
        choices.map((choice, i) => new ButtonBuilder()
          .setCustomId(`ob_answer:${question.id}:${i}`)
          .setLabel(choice.slice(0, 80))
          .setStyle(ButtonStyle.Primary)),
      ));
    }
  }

  if (question.type === 'roles') {
    const options = normalizeIdList((question.choices || []).join(' '), 25).map(id => {
      const role = ctx.guild?.roles?.cache?.get?.(id);
      return { label: String(role?.name || `Rôle ${id}`).slice(0, 100), value: id };
    });
    if (options.length) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ob_roles:${question.id}`)
          .setPlaceholder('Choisis ton ou tes rôles…')
          .setMinValues(question.required === false ? 0 : 1)
          .setMaxValues(Math.max(1, Math.min(question.maxChoices || 5, options.length)))
          .addOptions(options),
      ));
    }
  }

  if (question.type === 'rules') {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ob_rules:${question.id}`)
        .setLabel('✅ J’accepte')
        .setStyle(ButtonStyle.Success),
    ));
  }

  if (question.required === false && question.type !== 'roles') {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ob_skip:${question.id}`)
        .setLabel('Passer')
        .setStyle(ButtonStyle.Secondary),
    ));
  }

  return { embeds: [embed], components: components.slice(0, 5) };
}

function placeholderMessage(template, member, guild, channel) {
  return String(template || '')
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{server}', guild.name)
    .replaceAll('{link}', channel ? `https://discord.com/channels/${guild.id}/${channel.id}` : guild.name);
}

async function sendStep(member, session, cfg, channel) {
  const question = cfg.questions[session.currentQuestionIdx];
  if (!question) return completeOnboarding(member, session, cfg, channel);

  // `interaction.channel` peut manquer (salon en cache partiel) : sans ce
  // repli, le portail s'arrêtait silencieusement à l'étape suivante.
  channel = channel || member.guild.channels.cache.get(session.channelId);
  if (!channel) {
    console.error(`[Onboarding] salon introuvable pour la session ${session._id}`);
    return false;
  }

  const payload = buildStepPayload(question, session.currentQuestionIdx, cfg.questions.length, {
    guild: member.guild,
    memberId: member.id,
    shared: cfg.mode === 'shared',
  });

  await channel.send({
    ...payload,
    allowedMentions: cfg.mode === 'shared' ? { users: [member.id] } : { parse: [] },
  }).catch(err => console.error('[Onboarding] envoi étape:', err.message));
}

async function advance(member, session, cfg, channel) {
  const next = session.currentQuestionIdx + 1;
  if (next >= cfg.questions.length) return completeOnboarding(member, session, cfg, channel);

  session.currentQuestionIdx = next;
  await session.save().catch(() => {});
  await sendStep(member, session, cfg, channel);
}

async function recordAnswer(session, question, answer) {
  session.answers.push({
    questionId: question.id,
    label: String(question.prompt || '').slice(0, 200),
    answer: String(answer || '').slice(0, 1000),
  });
  await session.save().catch(() => {});
}

// ─── Démarrage ───────────────────────────────────────────────────────────────

async function startOnboarding(member, cfg, client) {
  const guild = member.guild;
  if (!member || member.user?.bot) return null;

  const unverifiedRole = await ensureUnverifiedRole(guild, cfg);
  await member.roles.add(unverifiedRole).catch(err => console.error('[Onboarding] Ajout rôle:', err.message));

  const channel = cfg.mode === 'shared'
    ? await ensureSharedChannel(guild, cfg)
    : await createOnboardingChannel(member, cfg);

  if (!channel) {
    console.error(`[Onboarding] salon indisponible pour ${member.user.tag} (${guild.id})`);
    return null;
  }

  const session = await OnboardingSession.findOneAndUpdate(
    { guildId: guild.id, userId: member.id },
    {
      channelId: channel.id,
      currentQuestionIdx: 0,
      answers: [],
      completed: false,
      status: 'in_progress',
      awaitingCaptcha: false,
      remindedAt: null,
      submittedAt: null,
      reviewMessageId: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  cfg.totalStarted = (cfg.totalStarted || 0) + 1;
  await cfg.save().catch(() => {});

  // Accueil dans le salon (privé uniquement : en partagé, chaque message
  // d'accueil noierait les autres membres).
  if (cfg.mode !== 'shared') {
    const welcome = placeholderMessage(
      cfg.welcomeMessage || 'Bienvenue {user} ! Réponds aux questions pour accéder au serveur.',
      member, guild, channel,
    );
    await channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.primary).setDescription(welcome)] }).catch(() => {});
  }

  // MP d'accueil : le membre garde le lien s'il ferme Discord.
  if (cfg.dmWelcome !== false) {
    const dm = placeholderMessage(cfg.dmMessage || '', member, guild, channel);
    if (dm) {
      await member.send({ embeds: [new EmbedBuilder().setColor(COLORS.primary).setDescription(dm)] })
        .catch(() => {}); // MP fermés : le portail reste visible dans le serveur
    }
  }

  await logOnboarding(guild, cfg, new EmbedBuilder()
    .setColor(COLORS.info || 0x5865F2)
    .setTitle('🚪 Portail ouvert')
    .setDescription(`<@${member.id}> a reçu son portail d’accès (${cfg.questions.length} étape(s), mode ${cfg.mode === 'shared' ? 'partagé' : 'privé'}).`)
    .setTimestamp());

  if (!cfg.questions.length) return completeOnboarding(member, session, cfg, channel);
  await sendStep(member, session, cfg, channel);
  return session;
}

// ─── Réponses ────────────────────────────────────────────────────────────────

// Session encore ouverte (compatibilité : les anciennes n'ont pas de statut).
function openSessionFilter(guildId, userId) {
  return {
    guildId,
    userId,
    completed: { $ne: true },
    status: { $nin: ['approved', 'rejected', 'pending_review'] },
  };
}

async function loadRunningSession(interaction) {
  const guildId = interaction.guild?.id;
  if (!guildId) return null;
  const session = await OnboardingSession.findOne(openSessionFilter(guildId, interaction.user.id));
  if (!session) return null;
  const cfg = await OnboardingConfig.findOne({ guildId, enabled: true });
  if (!cfg) return null;
  return { session, cfg };
}

/** Boutons, menu de rôles et acceptation du règlement. */
async function handleStepInteraction(interaction) {
  const loaded = await loadRunningSession(interaction);
  if (!loaded) {
    return interaction.reply({
      embeds: [errorEmbed('Portail introuvable', 'Ta session est terminée ou a expiré. Ouvre un ticket si tu as besoin d’aide.')],
      ephemeral: true,
    }).catch(() => {});
  }

  const { session, cfg } = loaded;
  const [kind, questionId, extra] = interaction.customId.split(':');
  const question = cfg.questions[session.currentQuestionIdx];

  if (!question || question.id !== questionId) {
    return interaction.reply({
      embeds: [errorEmbed('Étape dépassée', 'Ce bouton appartient à une étape déjà franchie.')],
      ephemeral: true,
    }).catch(() => {});
  }

  let answer = '';
  if (kind === 'ob_answer') answer = String(question.choices[Number(extra)] ?? '');
  else if (kind === 'ob_skip') answer = '(passé)';
  else if (kind === 'ob_rules') answer = 'Règlement accepté';
  else if (kind === 'ob_roles') {
    const picked = (interaction.values || []).filter(id => normalizeIdList((question.choices || []).join(' '), 25).includes(id));
    answer = picked.length ? picked.map(id => `<@&${id}>`).join(', ') : '(aucun rôle)';
  } else {
    return;
  }

  await interaction.update({ components: [] }).catch(() => {});
  await recordAnswer(session, question, answer);
  const channel = interaction.channel || interaction.guild.channels.cache.get(session.channelId);
  await advance(interaction.member, session, cfg, channel);
}

/**
 * Réponse texte envoyée dans le salon du portail.
 * @returns {Promise<boolean>} true si le message était une réponse d'étape
 */
async function handleMemberMessage(message) {
  if (!message.guild || message.author?.bot) return false;

  const cfg = await OnboardingConfig.findOne({ guildId: message.guild.id, enabled: true }).catch(() => null);
  if (!cfg) return false;

  const session = await OnboardingSession.findOne(openSessionFilter(message.guild.id, message.author.id)).catch(() => null);
  if (!session) return false;

  // Le salon doit être celui de la session (privé) ou du portail (partagé).
  const expected = cfg.mode === 'shared' ? cfg.sharedChannelId : session.channelId;
  if (expected && message.channel.id !== expected) return false;

  const question = cfg.questions[session.currentQuestionIdx];
  if (!question) return false;

  if (question.type !== 'text') {
    // Un clic est attendu : on ne consomme pas le message comme réponse.
    await message.react('👆').catch(() => {});
    return true;
  }

  const content = String(message.content || '').trim();
  if (!content) {
    await message.react('❌').catch(() => {});
    return true;
  }

  await recordAnswer(session, question, content.slice(0, 1000));
  await message.react('✅').catch(() => {});
  if (cfg.mode === 'shared') await message.delete().catch(() => {});
  await advance(message.member, session, cfg, message.channel);
  return true;
}

// ─── Captcha ─────────────────────────────────────────────────────────────────

async function isCaptchaPending(member) {
  try {
    const { CaptchaConfig, CaptchaPending } = require('../models/Captcha');
    const gate = await CaptchaConfig.findOne({ guildId: member.guild.id, enabled: true });
    if (!gate) return false;
    const pending = await CaptchaPending.findOne({ userId: member.id, guildId: member.guild.id });
    return !!pending;
  } catch (err) {
    console.warn('[Onboarding] vérification captcha impossible, accès différé :', err.message);
    return true;
  }
}

// ─── Fin de portail : captcha → validation staff → accès ────────────────────

async function completeOnboarding(member, session, cfg, channel) {
  const guild = member.guild;
  channel = channel || guild.channels.cache.get(session.channelId);

  if (await isCaptchaPending(member)) {
    if (!session.awaitingCaptcha) {
      session.awaitingCaptcha = true;
      session.status = 'awaiting_captcha';
      await session.save().catch(() => {});
      await channel?.send({
        embeds: [new EmbedBuilder().setColor(COLORS.warning || 0xFEE75C).setDescription(
          '🔒 **Captcha en attente** — ton portail est complet, mais la vérification humaine n’est pas encore faite.\n'
          + 'Résous le captcha : ton accès sera débloqué automatiquement.',
        )],
      }).catch(() => {});
    }
    return false;
  }

  session.awaitingCaptcha = false;

  if (cfg.reviewEnabled) return submitForReview(member, session, cfg, channel);
  return grantAccess(member, session, cfg, channel);
}

function buildReviewPayload(member, session, cfg) {
  const guild = member.guild;
  const fields = [
    { name: '👤 Membre', value: `${member.user.tag} (\`${member.id}\`)`, inline: true },
    { name: '📅 Compte créé', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
    { name: '⏱️ Arrivé', value: `<t:${Math.floor(new Date(session.createdAt).getTime() / 1000)}:R>`, inline: true },
  ];

  for (const entry of (session.answers || []).slice(0, 8)) {
    fields.push({
      name: `❓ ${String(entry.label || entry.questionId).slice(0, 80)}`,
      value: String(entry.answer || '—').slice(0, 1024),
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning || 0xFEE75C)
    .setTitle('🕓 Demande d’accès à valider')
    .setDescription(`<@${session.userId}> a terminé le portail de **${guild.name}**.`)
    .addFields(fields)
    .setFooter({ text: 'REZO • Portail d’accès — validation staff' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`obreview_ok:${session._id}`).setLabel('✅ Approuver').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`obreview_no:${session._id}`).setLabel('⛔ Refuser').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

async function submitForReview(member, session, cfg, channel) {
  const guild = member.guild;
  session.status = 'pending_review';
  session.submittedAt = new Date();
  session.completed = false;
  await session.save().catch(() => {});

  const reviewChannel = cfg.reviewChannelId
    ? (guild.channels.cache.get(cfg.reviewChannelId) || await guild.channels.fetch(cfg.reviewChannelId).catch(() => null))
    : null;

  if (!reviewChannel) {
    // Configuration incomplète : bloquer tout le monde serait pire que de
    // laisser passer. On journalise et on accorde l'accès normalement.
    console.warn(`[Onboarding] validation staff demandée sans salon valide (${guild.id}) — accès accordé`);
    await logOnboarding(guild, cfg, new EmbedBuilder()
      .setColor(COLORS.error || 0xED4245)
      .setDescription('⚠️ Validation staff activée sans salon valide : l’accès a été accordé sans revue.'));
    return grantAccess(member, session, cfg, channel);
  }

  const content = cfg.reviewPingRoleId ? `<@&${cfg.reviewPingRoleId}>` : undefined;
  const sent = await reviewChannel.send({
    content,
    ...buildReviewPayload(member, session, cfg),
    allowedMentions: cfg.reviewPingRoleId ? { roles: [cfg.reviewPingRoleId] } : { parse: [] },
  }).catch(err => { console.error('[Onboarding] carte de validation:', err.message); return null; });

  if (!sent) return grantAccess(member, session, cfg, channel);

  session.reviewMessageId = sent.id;
  await session.save().catch(() => {});

  if (channel) {
    await channel.send({
      embeds: [new EmbedBuilder().setColor(COLORS.info || 0x5865F2).setDescription(
        '🕓 **Demande envoyée au staff.** Tu recevras un message privé dès que ton accès sera validé.',
      )],
    }).catch(() => {});
    if (cfg.mode !== 'shared') {
      await channel.permissionOverwrites.edit(member.id, { SendMessages: false }).catch(() => {});
    }
  }

  return true;
}

/** Seul point d'entrée qui accorde réellement l'accès. */
async function grantAccess(member, session, cfg, channel, opts = {}) {
  const guild = member?.guild;
  if (!guild) {
    await OnboardingSession.deleteOne({ _id: session._id }).catch(() => {});
    return false;
  }

  if (member) {
    if (cfg.unverifiedRoleId) await member.roles.remove(cfg.unverifiedRoleId).catch(() => {});
    for (const roleId of resolveAccessRoles(cfg)) {
      await member.roles.add(roleId).catch(err => console.error('[Onboarding] rôle d’accès:', err.message));
    }
  }

  session.status = 'approved';
  session.completed = true;
  session.awaitingCaptcha = false;
  session.decidedBy = opts.decidedBy || session.decidedBy || null;
  session.decidedAt = new Date();
  await session.save().catch(() => {});

  cfg.totalCompleted = (cfg.totalCompleted || 0) + 1;
  if (opts.decidedBy) cfg.totalApproved = (cfg.totalApproved || 0) + 1;
  await cfg.save().catch(() => {});

  const message = placeholderMessage(cfg.completionMessage || '', member, guild, channel);
  if (channel) {
    await channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.success || 0x57F287).setDescription(message)] }).catch(() => {});
    if (cfg.deleteChannelOnComplete && cfg.mode !== 'shared') {
      setTimeout(() => channel.delete('Portail terminé').catch(() => {}), 10_000);
    } else if (cfg.mode !== 'shared') {
      await channel.permissionOverwrites.edit(member.id, { SendMessages: false }).catch(() => {});
    }
  }

  if (member) {
    const roles = resolveAccessRoles(cfg).map(id => `<@&${id}>`).join(' ') || '—';
    await member.send({ embeds: [new EmbedBuilder()
      .setColor(COLORS.success || 0x57F287)
      .setTitle('✅ Accès accordé')
      .setDescription(`Ton accès à **${guild.name}** est ouvert.\nRôles : ${roles}\n\nUtilise \`/help\` pour découvrir les commandes.`)
      .setTimestamp()] }).catch(() => {});
  }

  await logOnboarding(guild, cfg, new EmbedBuilder()
    .setColor(COLORS.success || 0x57F287)
    .setTitle('✅ Accès accordé')
    .setDescription(`<@${session.userId}> a terminé le portail.${opts.decidedBy ? ` Validé par <@${opts.decidedBy}>.` : ''}`)
    .setTimestamp());

  await OnboardingSession.deleteOne({ _id: session._id }).catch(() => {});
  return true;
}

/** Refus : le membre reste sur le serveur mais sans accès (sauf config kick). */
async function denyAccess(member, session, cfg, channel, opts = {}) {
  const guild = member?.guild;

  session.status = 'rejected';
  session.completed = false;
  session.decidedBy = opts.decidedBy || null;
  session.decidedAt = new Date();
  await session.save().catch(() => {});

  cfg.totalRejected = (cfg.totalRejected || 0) + 1;
  await cfg.save().catch(() => {});

  if (member) {
    await member.send({ embeds: [new EmbedBuilder()
      .setColor(COLORS.error || 0xED4245)
      .setDescription(placeholderMessage(cfg.rejectionMessage || '', member, guild, channel))] }).catch(() => {});

    if (cfg.reviewRejectAction === 'kick') {
      await member.kick('Portail d’accès : demande refusée par le staff').catch(() => {});
    }
  }

  if (channel) {
    await channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.error || 0xED4245)
      .setDescription('⛔ Demande refusée. Le staff peut te recontacter pour en discuter.')] }).catch(() => {});
    if (cfg.deleteChannelOnComplete && cfg.mode !== 'shared') {
      setTimeout(() => channel.delete('Portail : demande refusée').catch(() => {}), 10_000);
    }
  }

  await logOnboarding(guild, cfg, new EmbedBuilder()
    .setColor(COLORS.error || 0xED4245)
    .setTitle('⛔ Accès refusé')
    .setDescription(`<@${session.userId}> — refusé par <@${opts.decidedBy || 'inconnu'}>.`)
    .setTimestamp());

  await OnboardingSession.deleteOne({ _id: session._id }).catch(() => {});
  return true;
}

// ─── Validation staff ────────────────────────────────────────────────────────

async function handleReviewButton(interaction, client) {
  const staff = interaction.memberPermissions;
  const allowed = staff?.has?.(PermissionFlagsBits.ManageRoles)
    || staff?.has?.(PermissionFlagsBits.ManageGuild)
    || staff?.has?.(PermissionFlagsBits.Administrator);
  if (!allowed) {
    return interaction.reply({
      embeds: [errorEmbed('Accès refusé', 'Seul le staff (Gérer les rôles) peut valider une demande.')],
      ephemeral: true,
    }).catch(() => {});
  }

  const approve = interaction.customId.startsWith('obreview_ok');
  const id = interaction.customId.split(':')[1];
  if (!id) return;

  // Réclamation atomique : deux modérateurs qui cliquent en même temps ne
  // peuvent pas accorder (ou refuser) deux fois la même demande.
  const claimed = await OnboardingSession.findOneAndUpdate(
    { _id: id, status: 'pending_review' },
    { $set: { status: approve ? 'approved' : 'rejected', decidedBy: interaction.user.id, decidedAt: new Date() } },
    { new: true },
  ).catch(() => null);

  if (!claimed) {
    return interaction.reply({
      embeds: [errorEmbed('Déjà traité', 'Cette demande a déjà été validée ou refusée.')],
      ephemeral: true,
    }).catch(() => {});
  }

  await interaction.deferUpdate().catch(() => {});

  const cfg = await OnboardingConfig.findOne({ guildId: claimed.guildId }).catch(() => null);
  const guild = client.guilds.cache.get(claimed.guildId)
    || await client.guilds.fetch(claimed.guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(claimed.userId).catch(() => null) : null;
  const channel = guild ? guild.channels.cache.get(claimed.channelId) : null;

  if (!cfg) {
    await interaction.editReply({ components: [] }).catch(() => {});
    return;
  }

  if (approve) await grantAccess(member, claimed, cfg, channel, { decidedBy: interaction.user.id });
  else await denyAccess(member, claimed, cfg, channel, { decidedBy: interaction.user.id });

  // Verdict sur la carte : plus de boutons, la décision reste lisible.
  try {
    const base = interaction.message?.embeds?.[0];
    const embed = base ? EmbedBuilder.from(base) : new EmbedBuilder();
    embed
      .setColor(approve ? (COLORS.success || 0x57F287) : (COLORS.error || 0xED4245))
      .setTitle(approve ? '✅ Demande approuvée' : '⛔ Demande refusée')
      .addFields({ name: 'Décision', value: `${approve ? 'Approuvée' : 'Refusée'} par <@${interaction.user.id}> <t:${Math.floor(Date.now() / 1000)}:R>`, inline: false });
    await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
  } catch (_) {
    await interaction.editReply({ components: [] }).catch(() => {});
  }
}

// ─── Journal, aperçu et nettoyage ────────────────────────────────────────────

async function logOnboarding(guild, cfg, embed) {
  if (!cfg?.logChannelId) return false;
  const channel = guild.channels.cache.get(cfg.logChannelId)
    || await guild.channels.fetch(cfg.logChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;
  await channel.send({ embeds: [embed] }).catch(() => {});
  return true;
}

async function cancelOnboarding(guild, userId, client) {
  const session = await OnboardingSession.findOne({ guildId: guild.id, userId }).catch(() => null);
  if (!session) return;

  const bot = client || guild.client;
  if (session.reviewMessageId && session.status === 'pending_review') {
    const cfg = await OnboardingConfig.findOne({ guildId: guild.id }).catch(() => null);
    const reviewChannel = cfg?.reviewChannelId
      ? (bot?.channels?.cache?.get?.(cfg.reviewChannelId) || await bot?.channels?.fetch?.(cfg.reviewChannelId).catch(() => null))
      : null;
    const message = reviewChannel ? await reviewChannel.messages.fetch(session.reviewMessageId).catch(() => null) : null;
    await message?.edit({
      embeds: [new EmbedBuilder().setColor(COLORS.muted || 0x95A5A6).setDescription('🚪 Membre parti — demande annulée.')],
      components: [],
    }).catch(() => {});
  }

  const cfg = await OnboardingConfig.findOne({ guildId: guild.id }).catch(() => null);
  const shared = cfg?.mode === 'shared' && cfg.sharedChannelId === session.channelId;
  if (!shared) {
    const channel = guild.channels.cache.get(session.channelId);
    if (channel) await channel.delete('Membre parti avant la fin du portail').catch(() => {});
  }

  await OnboardingSession.deleteOne({ _id: session._id }).catch(() => {});
}

module.exports = {
  // constantes & helpers purs
  MAX_QUESTIONS, TYPES, TYPE_LABEL, progressBar, normalizeType, normalizeIdList,
  validateQuestion, resolveAccessRoles, placeholderMessage,
  // configuration & salons
  ensureUnverifiedRole, lockdownExistingChannels, createOnboardingChannel, ensureSharedChannel,
  // parcours
  buildStepPayload, sendStep, advance, recordAnswer, startOnboarding,
  handleStepInteraction, handleMemberMessage,
  completeOnboarding, grantAccess, denyAccess, cancelOnboarding, isCaptchaPending,
  // validation staff & journal
  buildReviewPayload, submitForReview, handleReviewButton, logOnboarding,
};
