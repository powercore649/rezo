'use strict';
// commands/captcha.js — CAPTCHA refondu, 100% fonctionnel
// - Panneau de configuration UNIQUE en un seul écran (5 rangées max, aucun sous-menu à retenir)
// - Anti-OCR renforcé : 3 niveaux de brouillage d'image (normal / dur / extrême avec découpage)
// - S'intègre à l'anti-raid : s'active automatiquement quand une attaque est détectée
// - Image distordue jamais de code en clair (repli texte si canvas indisponible)
// - Vraies tentatives, expiration, régénérations, âge de compte, rôles avant/après/bypass, logs

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, AttachmentBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  PermissionFlagsBits, ChannelType,
} = require('discord.js');
const { CaptchaConfig, CaptchaPending } = require('../../models/Captcha');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { renderCaptchaImage } = require('../../utils/captchaImage');
const { checkAccountAge, checkBypass, compareAnswer, canRegenerate, attemptsExhausted } = require('../../utils/captchaEngine');
const { logAction } = require('../../utils/captchaLogger');
const { bypassVerdict, gateAudit, mustKick } = require('../../utils/captchaGuards');
const { isDoubtful } = require('../../utils/captchaReview');

// ─── Générateurs de code ──────────────────────────────────────────────────────
function generateCode(type, length = 6) {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I/O (ambiguïté visuelle)
  const N = '23456789';                  // sans 0/1 (ambiguïté visuelle)
  const M = L + N;
  if (type === 'letters') return Array.from({ length }, () => L[Math.floor(Math.random() * L.length)]).join('');
  if (type === 'numbers') return Array.from({ length }, () => N[Math.floor(Math.random() * N.length)]).join('');
  if (type === 'math') {
    const a = Math.floor(Math.random() * 20) + 1;
    const b = Math.floor(Math.random() * 20) + 1;
    const ops = ['+', '-', '*'];
    const op  = ops[Math.floor(Math.random() * ops.length)];
    const res = op === '+' ? a + b : op === '-' ? a - b : a * b;
    return { question: `${a} ${op} ${b} =`, answer: String(res) };
  }
  return Array.from({ length }, () => M[Math.floor(Math.random() * M.length)]).join('');
}

function securityLabel(t) {
  return { letters: 'Lettres', numbers: 'Chiffres', mixed: 'Lettres+chiffres', math: 'Calcul math' }[t] || t;
}
function distortionLabel(l) {
  return { normal: 'Normal', hard: 'Dur', extreme: 'Extrême' }[l] || l;
}

// ─── Construit l'image (ou le texte de repli) pour un code donné ────────────
function buildCaptchaVisual(cfg, code, question) {
  if (!cfg.imageMode) {
    return { attachment: null, questionText: question ? `Calcule : **${question} ?**` : `Entrez exactement :\n# \`${code}\`` };
  }
  try {
    const buf = renderCaptchaImage(question || code, { isMath: !!question, level: cfg.imageDistortionLevel || 'normal' });
    return { attachment: new AttachmentBuilder(buf, { name: 'captcha.png' }), questionText: null };
  } catch (err) {
    console.error('[Captcha] Échec génération image, repli en mode texte :', err.message);
    return { attachment: null, questionText: question ? `Calcule : **${question} ?**` : `Entrez exactement :\n# \`${code}\`` };
  }
}

function captchaButtons(cfg, pending, userId) {
  const buttons = [
    new ButtonBuilder().setCustomId(`captcha_answer_${userId}`).setLabel('✍️ Répondre').setStyle(ButtonStyle.Primary),
  ];
  const regensLeft = canRegenerate(pending?.regenerations || 0, cfg.maxRegenerations ?? 2);
  if ((cfg.maxRegenerations ?? 2) > 0 && regensLeft) {
    buttons.push(new ButtonBuilder().setCustomId(`captcha_regen_${userId}`).setLabel('🔄 Nouvelle image').setStyle(ButtonStyle.Secondary));
  }
  return new ActionRowBuilder().addComponents(...buttons);
}

// ─── Porte fermée : quand la vérification ne peut pas être posée ────────────
// Un membre dont le captcha n'a pas pu être délivré ne doit JAMAIS rester
// dans le serveur sans avoir prouvé qu'il est humain : on le prévient puis on
// l'expulse, et l'incident est journalisé dans le salon de logs.
async function failClosed(member, cfg, client, reason) {
  const guild = member.guild;
  await logAction({
    client, guildId: guild.id, userId: member.id,
    action: 'delivery_failed', detail: reason,
  }).catch(() => {});
  if (cfg?.dmOnKick) {
    await member.send({
      embeds: [errorEmbed('🔒 Vérification indisponible',
        `La vérification sur **${guild.name}** est momentanément indisponible.\nRéessaie dans quelques instants.`)],
    }).catch(() => {});
  }
  await member.kick(`Captcha : ${reason}`).catch(() => {});
}

// ─── Auto-rôles « à l'arrivée » différés jusqu'à la vérification ─────────────
// guildMemberAdd ne les pose plus quand la porte est active : sinon un membre
// obtiendrait les rôles d'accès sans avoir résolu le captcha.
async function applyJoinRoles(member) {
  try {
    const AutoRole = require('../../models/AutoRole');
    const query = AutoRole.find({ guildId: member.guild.id, type: 'join', enabled: true });
    const docs = typeof query?.lean === 'function' ? await query.lean() : await query;
    for (const ar of docs || []) {
      await member.roles.add(ar.roleId).catch(() => {});
    }
  } catch (_) { /* sans accès aux auto-rôles, la vérification reste valide */ }
}

// ─── Reprise du portail d'accès (onboarding) après vérification ──────────────
// Le portail a été terminé mais l'accès a été différé le temps du captcha :
// on le clôture maintenant (rôle d'accès, rôle de quarantaine, salon).
async function resumeDeferredOnboarding(member) {
  try {
    const OnboardingSession = require('../../models/OnboardingSession');
    const session = await OnboardingSession.findOne({
      guildId: member.guild.id, userId: member.id, awaitingCaptcha: true,
    });
    if (!session) return false;

    const OnboardingConfig = require('../../models/OnboardingConfig');
    const cfg = await OnboardingConfig.findOne({ guildId: member.guild.id, enabled: true });
    if (!cfg) {
      await OnboardingSession.deleteOne({ _id: session._id }).catch(() => {});
      return false;
    }

    const { completeOnboarding } = require('../../utils/onboardingManager');
    await completeOnboarding(member, session, cfg);
    return true;
  } catch (err) {
    console.error('[Captcha] reprise du portail d\'accès impossible :', err.message);
    return false;
  }
}

// ─── Envoyer le captcha à un membre arrivant ──────────────────────────────────
// `options.test` = essai lancé par le staff depuis le panneau : la correction
// est réelle, mais rien n'est appliqué (aucun rôle, aucune expulsion).
async function sendCaptcha(member, cfg, client, options = {}) {
  const guild = member.guild;
  const test = options.test === true;
  try {
    // ── 0. Un bot ne peut pas résoudre un captcha : il n'entre jamais ───────
    if (member.user?.bot) {
      await member.kick('Captcha : un compte bot ne peut pas être vérifié').catch(() => {});
      await logAction({ client, guildId: guild.id, userId: member.id, action: 'bot_blocked' });
      return 'kicked';
    }

    // ── 1. Âge minimum du compte — contrôlé AVANT le bypass, jamais sauté ──
    const ageCheck = checkAccountAge(member.user.createdAt, cfg.minAccountAgeDays);
    if (!ageCheck.ok && !test) {
      await logAction({ client, guildId: guild.id, userId: member.id, action: 'blocked_age', detail: `Compte créé il y a ${ageCheck.ageDays}j (min. ${cfg.minAccountAgeDays}j requis)` });
      if (cfg.dmOnKick) {
        await member.send({ embeds: [errorEmbed('🚫 Compte trop récent', `Ton compte Discord doit avoir au moins **${cfg.minAccountAgeDays} jour(s)** pour rejoindre **${member.guild.name}**.`)] }).catch(() => {});
      }
      await member.kick('Captcha : compte trop récent').catch(() => {});
      return 'kicked';
    }

    // ── 2. Rôle « vérifié » déjà porté (auto-rôle, autre bot) → retiré ─────
    // Sans ça, un rôle distribué à l'arrivée vaudrait vérification.
    if (!test && cfg.roleAfter && member.roles.cache.has(cfg.roleAfter)) {
      await member.roles.remove(cfg.roleAfter).catch(() => {});
      await logAction({ client, guildId: guild.id, userId: member.id, action: 'role_stripped', detail: 'Rôle vérifié retiré à l\'arrivée (non mérité)' });
    }

    // ── 3. Bypass : uniquement un rôle que Discord attribue lui-même ───────
    // Un bypass invalide n'ouvre pas la porte : il est ignoré et journalisé.
    if (!test && cfg.bypassRoleId) {
      const bypassRole = guild.roles?.cache?.get?.(cfg.bypassRoleId) || null;
      const verdict = bypassVerdict({
        guildId: guild.id,
        bypassRoleId: cfg.bypassRoleId,
        roleBefore: cfg.roleBefore,
        roleAfter: cfg.roleAfter,
        role: bypassRole,
      });
      const holdsBypass = checkBypass(member.roles.cache.map(r => r.id), cfg.bypassRoleId);

      if (!verdict.ok) {
        await logAction({ client, guildId: guild.id, userId: member.id, action: 'bypass_refused', detail: verdict.text });
      } else if (holdsBypass) {
        if (cfg.roleAfter) await member.roles.add(cfg.roleAfter).catch(() => {});
        await applyJoinRoles(member);
        await resumeDeferredOnboarding(member);
        await logAction({ client, guildId: guild.id, userId: member.id, action: 'bypassed' });
        return 'bypassed';
      }
    }

    // ── 4. Quarantaine posée AVANT l'envoi : un envoi qui échoue ne doit
    //      jamais laisser le membre sans le rôle « non vérifié » ───────────
    if (!test && cfg.roleBefore) {
      await member.roles.add(cfg.roleBefore).catch(e => console.warn('[Captcha] roleBefore:', e.message));
    }

    // ── 5. Salon + permissions — échec = accès refusé, jamais accès libre ───
    const channel = guild.channels.cache.get(cfg.channelId)
      || await guild.channels.fetch(cfg.channelId).catch(() => null);
    // `members.me` peut être vide juste après un démarrage : on le résout
    // plutôt que de conclure à tort à un manque de permissions (et de refuser
    // une arrivée légitime).
    const me = guild.members?.me || await guild.members?.fetchMe?.()?.catch?.(() => null);
    const botPerms = channel?.permissionsFor?.(me);
    const deliverable = !!channel?.isTextBased?.()
      && !!botPerms?.has?.([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles]);

    if (!deliverable) {
      // Un essai n'a aucune raison d'expulser le membre du staff.
      if (test) return 'failed';
      console.error(`[Captcha] Salon de vérification indisponible (${cfg.channelId}) sur ${guild.name}.`);
      await failClosed(member, cfg, client, 'Salon de vérification indisponible (permissions ou salon supprimé)');
      return 'kicked';
    }

    let code, question;
    if (cfg.security === 'math') {
      const gen = generateCode('math');
      code     = gen.answer;
      question = gen.question;
    } else {
      code     = generateCode(cfg.security, cfg.codeLength);
      question = null;
    }

    const expiresAt = new Date(Date.now() + cfg.timeout * 60 * 1000);

    const old = await CaptchaPending.findOneAndDelete({ userId: member.id, guildId: member.guild.id });
    if (old?.messageId && old.channelId) {
      const oldChannel = member.guild.channels.cache.get(old.channelId) || channel;
      oldChannel.messages.delete(old.messageId).catch(() => {});
    }

    const { attachment, questionText } = buildCaptchaVisual(cfg, code, question);

    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('🔒 Vérification humaine requise')
      .setDescription(
        `Bienvenue **${member.user.username}** sur **${member.guild.name}** !\n\n` +
        `Résolvez ce captcha pour accéder au serveur :\n\n` +
        (questionText || 'Regardez l\'image ci-dessous et entrez le code affiché.') + '\n\n' +
        `⏱️ Temps : **${cfg.timeout} min** ・ ❌ Tentatives : **${cfg.attempts}**` +
        (cfg.maxRegenerations > 0 ? ` ・ 🔄 Régénérations : **${cfg.maxRegenerations}**` : '') +
        (test ? '\n\n🧪 **MODE TEST** — la correction est réelle, mais **aucun rôle et aucune expulsion** ne seront appliqués.' : '')
      )
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: `Sécurité : ${securityLabel(cfg.security)} · Image : ${distortionLabel(cfg.imageDistortionLevel)}${cfg.caseSensitive ? ' · Casse exacte' : ''}` })
      .setTimestamp();

    if (attachment) embed.setImage('attachment://captcha.png');

    const sendPayload = {
      content: `<@${member.id}>`,
      embeds: [embed],
      components: [captchaButtons(cfg, null, member.id)],
    };
    if (attachment) sendPayload.files = [attachment];

    const msg = await channel.send(sendPayload);

    try {
      await CaptchaPending.create({
        userId: member.id, guildId: guild.id, code,
        attempts: 0, regenerations: 0, expiresAt, messageId: msg.id, channelId: channel.id,
        test,
      });
    } catch (err) {
      // Sans pending, aucune réponse n'est possible : on ne laisse pas entrer.
      console.error('[Captcha] Enregistrement du pending impossible :', err.message);
      await channel.messages?.delete?.(msg.id)?.catch?.(() => {});
      await failClosed(member, cfg, client, 'Enregistrement du captcha impossible');
      return 'kicked';
    }

    await logAction({ client, guildId: guild.id, userId: member.id, action: test ? 'test_sent' : 'sent' });

    // Expiration déléguée au helper partagé : le même code est appelé par le
    // cron de balayage (crons/captchaExpiry.js), donc le timeout est appliqué
    // même si le bot redémarre entre l'envoi et l'expiration.
    setTimeout(() => {
      expirePending(client, { userId: member.id, guildId: member.guild.id }).catch(() => {});
    }, cfg.timeout * 60 * 1000);

    return 'pending';
  } catch (err) {
    console.error('[sendCaptcha]', err);
    // Un essai ne sanctionne jamais ; une vraie arrivée, si : la porte reste fermée.
    if (test) return 'failed';
    await failClosed(member, cfg, client, 'Erreur inattendue du captcha').catch(() => {});
    return 'kicked';
  }
}

// ─── Expiration d'un captcha (timeout) — partagée avec le cron ───────────────
// Supprime le pending, retire le message, journalise le timeout et, si configuré,
// expulse le membre. Renvoie true si un pending expiré a bien été traité.
// Garde-fou : un pending devenu très vieux (> 6 h, typiquement bot hors-ligne)
// est nettoyé SANS expulsion rétroactive.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

async function expirePending(client, { userId, guildId }) {
  const pending = await CaptchaPending.findOne({ userId, guildId });
  if (!pending) return false;

  const expiresAt = new Date(pending.expiresAt).getTime();
  if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return false; // pas encore expiré

  await CaptchaPending.deleteOne({ _id: pending._id });

  const guild = client?.guilds?.cache?.get(guildId)
    || await client?.guilds?.fetch?.(guildId).catch(() => null);
  const cfg = await CaptchaConfig.findOne({ guildId }).catch(() => null);

  // Essai du staff : jamais d'expulsion, même après un temps écoulé. On se
  // contente de retirer le message et de journaliser l'essai.
  if (pending.test) {
    const testChannel = guild?.channels?.cache?.get?.(pending.channelId);
    testChannel?.messages?.delete?.(pending.messageId)?.catch?.(() => {});
    await logAction({ client, guildId, userId, action: 'test_timeout' });
    return true;
  }

  // Trop ancien : le bot n'était probablement pas en ligne → pas de kick.
  const tooOld = Number.isFinite(expiresAt) && (Date.now() - expiresAt) > STALE_AFTER_MS;
  if (tooOld) {
    await logAction({ client, guildId, userId, action: 'timeout', detail: 'Nettoyage différé (bot hors-ligne)' });
    return true;
  }

  // Kick forcé si aucun rôle « non vérifié » ne garde le membre hors des salons.
  const kickOnFail = mustKick(cfg);

  if (guild) {
    const ch = guild.channels.cache.get(pending.channelId) || guild.channels.cache.get(cfg?.channelId);
    if (ch?.isTextBased?.()) {
      ch.messages?.delete?.(pending.messageId)?.catch?.(() => {});
      const timeoutEmbed = new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle('⏱️ Temps écoulé')
        .setDescription(`<@${userId}> n'a pas complété la vérification à temps.${kickOnFail ? ' Il a été expulsé.' : ''}`)
        .setTimestamp();
      const tm = await ch.send({ embeds: [timeoutEmbed] }).catch(() => null);
      if (tm?.delete) setTimeout(() => tm.delete().catch(() => {}), 10000);
    }
  }

  await logAction({ client, guildId, userId, action: 'timeout' });

  if (kickOnFail && guild) {
    const freshMember = await guild.members.fetch(userId).catch(() => null);
    if (freshMember) {
      if (cfg?.dmOnKick) {
        await freshMember.send({ embeds: [errorEmbed('⏱️ Temps écoulé', `Tu n'as pas complété la vérification sur **${guild.name}** à temps.`)] }).catch(() => {});
      }
      const kicked = await freshMember.kick('Captcha : temps écoulé').then(() => true).catch(() => false);
      if (kicked) await logAction({ client, guildId, userId, action: 'kicked', detail: cfg?.roleBefore ? 'Timeout' : 'Timeout (aucun rôle de quarantaine → expulsion obligatoire)' });
      else console.warn(`[Captcha] Expulsion impossible pour ${userId} (permission KickMembers manquante ?)`);
    }
  }

  return true;
}

// ─── Bouton "Répondre" → ouvrir le modal ─────────────────────────────────────
async function verifyCaptcha(interaction) {
  const targetUserId = interaction.customId.replace('captcha_answer_', '');

  if (interaction.user.id !== targetUserId) {
    return interaction.reply({ content: '❌ Ce captcha ne vous est pas destiné.', ephemeral: true });
  }

  const pending = await CaptchaPending.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
  if (!pending) {
    return interaction.reply({ content: '❌ Aucun captcha actif trouvé.', ephemeral: true });
  }
  if (new Date() > pending.expiresAt) {
    await CaptchaPending.deleteOne({ _id: pending._id });
    return interaction.reply({ content: '⏱️ Ton captcha a expiré. Rejoins le serveur à nouveau.', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`captcha_submit_${interaction.user.id}`)
    .setTitle('🔒 Répondre au captcha');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('captcha_input')
        .setLabel('Votre réponse')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Entrez la réponse exacte…'),
    ),
  );
  return interaction.showModal(modal);
}

// ─── Bouton "Nouvelle image" — régénère un code différent, capé ─────────────────
async function handleRegenerate(interaction) {
  const targetUserId = interaction.customId.replace('captcha_regen_', '');
  if (interaction.user.id !== targetUserId) {
    return interaction.reply({ content: '❌ Ce captcha ne vous est pas destiné.', ephemeral: true });
  }

  const pending = await CaptchaPending.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
  if (!pending) return interaction.reply({ content: '❌ Aucun captcha actif trouvé.', ephemeral: true });
  if (new Date() > pending.expiresAt) {
    await CaptchaPending.deleteOne({ _id: pending._id });
    return interaction.reply({ content: '⏱️ Ton captcha a expiré. Rejoins le serveur à nouveau.', ephemeral: true });
  }

  const cfg = await CaptchaConfig.findOne({ guildId: interaction.guild.id });
  if (!canRegenerate(pending.regenerations, cfg?.maxRegenerations ?? 0)) {
    return interaction.reply({ content: `❌ Tu as atteint la limite de régénérations (**${cfg?.maxRegenerations ?? 0}**).`, ephemeral: true });
  }

  let code, question;
  if (cfg.security === 'math') {
    const gen = generateCode('math');
    code = gen.answer; question = gen.question;
  } else {
    code = generateCode(cfg.security, cfg.codeLength); question = null;
  }

  pending.code = code;
  pending.regenerations += 1;
  await pending.save();

  const { attachment, questionText } = buildCaptchaVisual(cfg, code, question);
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🔒 Vérification humaine requise')
    .setDescription(
      `Nouvelle image générée. Résolvez ce captcha pour accéder au serveur :\n\n` +
      (questionText || 'Regardez l\'image ci-dessous et entrez le code affiché.') + '\n\n' +
      `⏱️ Temps restant jusqu'à <t:${Math.floor(pending.expiresAt.getTime() / 1000)}:R> ・ ❌ Tentatives restantes : **${Math.max(0, cfg.attempts - pending.attempts)}**`
    )
    .setThumbnail(interaction.user.displayAvatarURL())
    .setFooter({ text: `Sécurité : ${securityLabel(cfg.security)} · Image : ${distortionLabel(cfg.imageDistortionLevel)} · Régénérations restantes : ${Math.max(0, cfg.maxRegenerations - pending.regenerations)}` })
    .setTimestamp();
  if (attachment) embed.setImage('attachment://captcha.png');

  const updatePayload = { embeds: [embed], components: [captchaButtons(cfg, pending, interaction.user.id)] };
  if (attachment) updatePayload.files = [attachment];

  await interaction.update(updatePayload);
  await logAction({ client: interaction.client, guildId: interaction.guild.id, userId: interaction.user.id, action: 'regenerated' });
}

// ─── Soumission du modal captcha ──────────────────────────────────────────────
async function handleCaptchaSubmit(interaction) {
  const targetUserId = interaction.customId.replace('captcha_submit_', '');
  if (interaction.user.id !== targetUserId) return;

  const pending = await CaptchaPending.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
  if (!pending) return interaction.reply({ content: '❌ Captcha introuvable.', ephemeral: true });
  if (!interaction.member) {
    return interaction.reply({ content: '❌ Tu n\'es plus membre du serveur.', ephemeral: true });
  }

  if (new Date() > pending.expiresAt) {
    await CaptchaPending.deleteOne({ _id: pending._id });
    return interaction.reply({ content: '⏱️ Ton captcha a expiré.', ephemeral: true });
  }

  const cfg    = await CaptchaConfig.findOne({ guildId: interaction.guild.id });
  const answer = interaction.fields.getTextInputValue('captcha_input');
  const isOK   = compareAnswer(answer, pending.code, cfg?.caseSensitive);
  const isTest = pending.test === true;
  // Sans date de départ exploitable, on ne conclut rien sur la vitesse : mieux
  // vaut ne pas alert le staff que de signaler tous les membres.
  const startedAt = new Date(pending.createdAt || 0).getTime();
  const elapsedMs = Number.isFinite(startedAt) && startedAt > 0 ? Date.now() - startedAt : undefined;

  if (isOK) {
    await CaptchaPending.deleteOne({ _id: pending._id });
    const member = interaction.member;

    if (isTest) {
      const testChannel = interaction.guild.channels.cache.get(pending.channelId);
      testChannel?.messages?.delete?.(pending.messageId)?.catch?.(() => {});
      await logAction({ client: interaction.client, guildId: interaction.guild.id, userId: interaction.user.id, action: 'test_success' });
      return interaction.reply({
        embeds: [successEmbed('✅ Mode test réussi', 'Bonne réponse ! **Aucun rôle n’a été ajouté et aucune expulsion n’a été appliquée** : cet essai ne valide aucune arrivée.')],
        ephemeral: true,
      });
    }

    if (cfg?.roleBefore) {
      // Retrait inconditionnel (best-effort) : le rôle peut ne pas être en cache.
      await member.roles.remove(cfg.roleBefore).catch(() => {});
    }
    if (cfg?.roleAfter) {
      await member.roles.add(cfg.roleAfter).catch(e => console.warn('[Captcha] roleAfter:', e.message));
    }
    const ch = interaction.guild.channels.cache.get(pending.channelId);
    if (ch) ch.messages.delete(pending.messageId).catch(() => {});

    await logAction({ client: interaction.client, guildId: interaction.guild.id, userId: interaction.user.id, action: 'success' });

    const successMsg = await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('✅ Vérification réussie !')
        .setDescription(`Bienvenue **${interaction.user.username}** ! Tu as maintenant accès au serveur. 🎉`)
        .setTimestamp()],
      fetchReply: true,
    });
    setTimeout(() => successMsg.delete().catch(() => {}), 8000);

    // Après la réponse, jamais avant : le membre n'attend pas la base de
    // données. Les auto-rôles « à l'arrivée » ont été différés par
    // guildMemberAdd le temps de la vérification, et le portail d'accès
    // (onboarding) encore en attente est clôturé ici.
    await applyJoinRoles(member).catch(() => {});
    await resumeDeferredOnboarding(member);

    // Vérification réussie mais douteuse (trop rapide, échecs, régénérations) :
    // le staff reçoit un rapport et garde la main pour expulser.
    if (cfg?.reportDoubtful !== false) {
      const doubt = isDoubtful({
        elapsedMs,
        attempts: pending.attempts,
        regenerations: pending.regenerations,
      });
      if (doubt.doubtful) await reportDoubtful(interaction, doubt).catch(() => {});
    }

  } else {
    pending.attempts += 1;
    await pending.save();
    const maxAttempts = cfg?.attempts ?? 3;

    await logAction({ client: interaction.client, guildId: interaction.guild.id, userId: interaction.user.id, action: 'fail', detail: `Tentative ${pending.attempts}/${maxAttempts}` });

    if (attemptsExhausted(pending.attempts, maxAttempts)) {
      await CaptchaPending.deleteOne({ _id: pending._id });
      const ch = interaction.guild.channels.cache.get(pending.channelId);
      if (ch) ch.messages.delete(pending.messageId).catch(() => {});

      const willKick = !isTest && mustKick(cfg);
      await interaction.reply({
        embeds: [errorEmbed('❌ Trop de tentatives',
          isTest
            ? `Tu as échoué ${maxAttempts} fois. **Mode test : rien n’est appliqué.**`
            : `Tu as échoué ${maxAttempts} fois.${willKick ? ' Tu vas être expulsé.' : ''}`)],
        ephemeral: true,
      });

      if (willKick) {
        if (cfg?.dmOnKick) await interaction.user.send({ embeds: [errorEmbed('❌ Vérification échouée', `Tu as épuisé tes tentatives sur **${interaction.guild.name}**.`)] }).catch(() => {});
        setTimeout(() => {
          interaction.member.kick('Captcha : trop de tentatives').catch(() => {});
          logAction({ client: interaction.client, guildId: interaction.guild.id, userId: interaction.user.id, action: 'kicked', detail: 'Tentatives épuisées' }).catch(() => {});
        }, 2000);
      }
    } else {
      const remaining = maxAttempts - pending.attempts;
      await interaction.reply({
        embeds: [errorEmbed('❌ Réponse incorrecte', `Il te reste **${remaining}** tentative(s). Clique à nouveau sur "Répondre".`)],
        ephemeral: true,
      });
    }
  }
}

// ─── Rapport au staff : vérification réussie mais douteuse ──────────────────
// Le membre est déjà entré (on ne bloque jamais un humain sur une intuition),
// mais l'équipe peut l'expulser d'un clic si le rapport confirme un robot.
async function reportDoubtful(interaction, doubt) {
  const guild = interaction.guild;
  await logAction({
    client: interaction.client, guildId: guild.id, userId: interaction.user.id,
    action: 'review_reported', detail: doubt.reasons.join(' · ').slice(0, 200),
  }).catch(() => {});

  const cfg = await CaptchaConfig.findOne({ guildId: guild.id }).catch(() => null);
  const channelId = cfg?.reviewChannelId || cfg?.logChannelId;
  if (!channelId) return false;

  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;

  const accountAge = Math.floor((Date.now() - (interaction.user.createdTimestamp || Date.now())) / 86_400_000);
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('🤔 Vérification douteuse')
      .setDescription(
        `<@${interaction.user.id}> (\`${interaction.user.username}\`) a réussi le captcha, mais le résultat est douteux.\n\n` +
        doubt.reasons.map(r => `• ${r}`).join('\n') +
        '\n\n**L’accès a été accordé.** Si c’est un robot, expulse-le d’un clic.',
      )
      .addFields({ name: 'Compte', value: `Âge : **${accountAge} j** · ID : \`${interaction.user.id}\``, inline: false })
      .setThumbnail(interaction.user.displayAvatarURL())
      .setFooter({ text: 'REZO • Captcha — rapport au staff' })
      .setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cap_report_ok_${interaction.user.id}`).setLabel('✅ Laisser entrer').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cap_report_deny_${interaction.user.id}`).setLabel('👢 Expulser').setStyle(ButtonStyle.Danger),
    )],
  }).catch(() => {});
  return true;
}

// ─── Boutons du rapport : décision du staff ─────────────────────────────────
async function handleReportButton(interaction) {
  const match = /^cap_report_(ok|deny)_(\d{3,25})$/.exec(interaction.customId || '');
  if (!match) return;
  const [, verdict, userId] = match;

  const isStaff = interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
    || interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild);
  if (!isStaff) {
    return interaction.reply({ content: '❌ Seul le staff (Gérer le serveur) peut trancher ce rapport.', ephemeral: true });
  }

  const base = new EmbedBuilder()
    .setColor(verdict === 'deny' ? COLORS.error : COLORS.success)
    .setTitle(verdict === 'deny' ? '👢 Rapport — membre expulsé' : '✅ Rapport — membre laissé en place')
    .setDescription(`<@${userId}> · décision prise par <@${interaction.user.id}>`)
    .setFooter({ text: 'REZO • Captcha — rapport traité' })
    .setTimestamp();

  if (verdict === 'deny') {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return interaction.update({
        embeds: [base.setDescription(`<@${userId}> n’est plus sur le serveur — rien à expulser.`)],
        components: [],
      });
    }
    const kicked = await member.kick(`Captcha : vérification jugée suspecte par ${interaction.user.tag || interaction.user.id}`)
      .then(() => true).catch(() => false);
    await logAction({
      client: interaction.client, guildId: interaction.guild.id, userId,
      action: kicked ? 'review_kicked' : 'review_kick_failed',
      detail: `par ${interaction.user.tag || interaction.user.id}`,
    }).catch(() => {});
    return interaction.update({
      embeds: [base.setDescription(kicked
        ? `<@${userId}> a été expulsé (vérification suspecte). Décision de <@${interaction.user.id}>.`
        : `Expulsion de <@${userId}> impossible — permissions insuffisantes ?`)],
      components: [],
    });
  }

  await logAction({
    client: interaction.client, guildId: interaction.guild.id, userId,
    action: 'review_allowed', detail: `par ${interaction.user.tag || interaction.user.id}`,
  }).catch(() => {});
  return interaction.update({ embeds: [base], components: [] });
}

// ═════════════════════════════════════════════════════════════════════════════
//  PANNEAU DE CONFIGURATION UNIQUE
// ═════════════════════════════════════════════════════════════════════════════
function buildCaptchaEmbed(cfg, guild = null) {
  // Le rôle de bypass n'est vérifiable qu'avec le cache du serveur ; sans lui
  // (appel depuis /securite), on n'invente pas de faille.
  const canResolve = !!guild?.roles?.cache?.get;
  const bypassRole = canResolve && cfg?.bypassRoleId
    ? (guild.roles.cache.get(cfg.bypassRoleId) || null)
    : undefined;
  const audit = gateAudit(cfg || {}, { guildId: guild?.id, role: bypassRole });
  const integrity = !cfg?.enabled
    ? '⚪ Désactivé'
    : audit.problems.length ? `⚠️ ${audit.problems.length} faille(s)` : '🔒 Inviolable';

  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🔒 Configuration — Captcha')
    .setDescription('Panneau unique : tout se règle ici en un seul écran. Le captcha s\'affiche à l\'arrivée de chaque membre et bloque les bots.\n*La porte ne peut pas être contournée : les rôles distribués à l\'arrivée sont déposés après vérification, et un captcha non délivrable ferme l\'accès.*')
    .addFields(
      { name: '📢 Statut',            value: cfg?.enabled    ? '🟢 Activé'           : '🔴 Désactivé',                  inline: true },
      { name: '📝 Salon',             value: cfg?.channelId  ? `<#${cfg.channelId}>` : '*Non défini*',                  inline: true },
      { name: '📋 Salon de logs',     value: cfg?.logChannelId ? `<#${cfg.logChannelId}>` : '*Aucun*',                   inline: true },
      { name: '🛡️ Anti-OCR (image)',  value: cfg?.imageMode ? `🖼️ ${distortionLabel(cfg?.imageDistortionLevel)}` : '📝 Texte brut', inline: true },
      { name: '🚨 Auto sur raid',     value: cfg?.activeOnRaid ? '🟢 Activé' : '🔴 Désactivé',                          inline: true },
      { name: '⏳ Rôle avant',        value: cfg?.roleBefore ? `<@&${cfg.roleBefore}>` : '*Aucun*',                      inline: true },
      { name: '✅ Rôle après',        value: cfg?.roleAfter  ? `<@&${cfg.roleAfter}>`  : '*Aucun*',                      inline: true },
      { name: '🛡️ Bypass',            value: cfg?.bypassRoleId ? `<@&${cfg.bypassRoleId}>${audit.bypass.ok ? '' : ' ⚠️'}` : '*Aucun*', inline: true },
      { name: '🧱 Étanchéité',        value: integrity,                                                                  inline: true },
      { name: '🔒 Type de code',      value: securityLabel(cfg?.security || 'mixed'),                                    inline: true },
      { name: '❌ Tentatives max',    value: String(cfg?.attempts  ?? 3),                                                inline: true },
      { name: '⏱️ Expiration',        value: `${cfg?.timeout ?? 10} min`,                                                inline: true },
      { name: '🔄 Régénérations max', value: String(cfg?.maxRegenerations ?? 2),                                         inline: true },
      { name: '🎂 Âge de compte min.',value: cfg?.minAccountAgeDays > 0 ? `${cfg.minAccountAgeDays} jour(s)` : '*Désactivé*', inline: true },
      { name: '🔤 Casse exacte',      value: cfg?.caseSensitive ? '✅ Requise' : '❌ Non',        inline: true },
      { name: '👢 Kick si échec',     value: cfg?.kickOnFail ? '✅ Oui' : '❌ Non',               inline: true },
      { name: '📩 DM avant kick',     value: cfg?.dmOnKick ? '✅ Oui' : '❌ Non',                 inline: true },
      { name: '🤔 Rapport douteux',   value: cfg?.reportDoubtful === false ? '🔴 Désactivé' : '🟢 Activé', inline: true },
      { name: '🧪 Mode test',         value: 'Bouton **Tester** — rien n’est appliqué',            inline: true },
    )
    .addFields(...(cfg?.enabled && audit.problems.length
      ? [{ name: '⚠️ Failles détectées', value: audit.problems.map(p => `• ${p}`).join('\n').slice(0, 1024) }]
      : []))
    .setFooter({ text: 'REZO • Captcha v2 — panneau unique' })
    .setTimestamp();
}

function buildCaptchaComponents(cfg) {
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('captcha_toggle').setLabel(cfg?.enabled ? '🔴 Désactiver' : '🟢 Activer').setStyle(cfg?.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('captcha_set_channel').setLabel('# Salon').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('captcha_set_logs').setLabel('📋 Logs').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('captcha_toggle_image').setLabel(cfg?.imageMode ? '🖼️ Image : ON' : '📝 Image : OFF').setStyle(cfg?.imageMode ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('captcha_toggle_raid').setLabel(cfg?.activeOnRaid ? '🚨 Auto raid : ON' : '🚨 Auto raid : OFF').setStyle(cfg?.activeOnRaid ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('captcha_set_role_before').setLabel('⏳ Rôle avant').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('captcha_set_role_after').setLabel('✅ Rôle après').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('captcha_set_bypass').setLabel('🛡️ Bypass').setStyle(ButtonStyle.Secondary),
  );
  const r3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('captcha_set_security').setLabel('🔒 Type de code').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('captcha_set_distortion').setLabel('🛡️ Anti-OCR').setStyle(ButtonStyle.Secondary),
  );
  const r4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('captcha_advanced').setLabel('⚙️ Paramètres').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('captcha_antibot').setLabel('🤖 Anti-bot avancé').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('captcha_test').setLabel('🧪 Tester').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('captcha_toggle_report')
      .setLabel(cfg?.reportDoubtful === false ? '🤔 Rapport : OFF' : '🤔 Rapport : ON')
      .setStyle(cfg?.reportDoubtful === false ? ButtonStyle.Secondary : ButtonStyle.Success),
  );
  return [r1, r2, r3, r4];
}

// ─── Vues de sélection (remplacent le panneau le temps du choix) ─────────────
function selectView({ title, description, row, clearId = null }) {
  const components = [row];
  const back = new ButtonBuilder().setCustomId('captcha_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary);
  if (clearId) {
    components.push(new ActionRowBuilder().addComponents(
      back,
      new ButtonBuilder().setCustomId(clearId).setLabel('🗑️ Retirer').setStyle(ButtonStyle.Danger),
    ));
  } else {
    components.push(new ActionRowBuilder().addComponents(back));
  }
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(title).setDescription(description)],
    components,
  };
}

// ─── Commande slash ───────────────────────────────────────────────────────────
module.exports = {
  sendCaptcha,
  expirePending,
  verifyCaptcha,
  handleCaptchaSubmit,
  handleRegenerate,
  handleReportButton,
  reportDoubtful,
  resumeDeferredOnboarding,

  data: new SlashCommandBuilder()
    .setName('captcha')
    .setDescription('🔒 Configurer le système de vérification Captcha')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    let cfg = await CaptchaConfig.findOne({ guildId: interaction.guildId });
    if (!cfg) cfg = await CaptchaConfig.create({ guildId: interaction.guildId });

    const reply = await interaction.reply({
      embeds:     [buildCaptchaEmbed(cfg, interaction.guild)],
      components: buildCaptchaComponents(cfg),
      ephemeral:  true,
      fetchReply: true,
    });

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time:   10 * 60 * 1000,
    });

    const refresh = async (i) => {
      cfg = await CaptchaConfig.findOne({ guildId: interaction.guildId });
      return i.update({ embeds: [buildCaptchaEmbed(cfg, interaction.guild)], components: buildCaptchaComponents(cfg) });
    };

    col.on('collect', async i => {
      cfg = await CaptchaConfig.findOne({ guildId: interaction.guildId });

      // ── Toggles directs ──
      if (i.customId === 'captcha_toggle') {
        // On n'active pas une porte incomplète : sans salon elle refuserait
        // toutes les arrivées, sans rôle vérifié elle ne débloquerait rien.
        if (!cfg.enabled && (!cfg.channelId || !cfg.roleAfter)) {
          return i.reply({ embeds: [errorEmbed('Configuration incomplète',
            'Définis d\'abord un **salon de vérification** (`# Salon`) et un **rôle vérifié** (`✅ Rôle après`) : sans eux, la porte ne peut ni poser le captcha ni débloquer l\'accès.')], ephemeral: true });
        }
        cfg.enabled = !cfg.enabled;
        await cfg.save();
        // Désactiver une protection est un acte de sécurité : il est journalisé.
        await logAction({
          client: interaction.client, guildId: interaction.guildId, userId: i.user.id,
          action: cfg.enabled ? 'gate_on' : 'gate_off',
          detail: `par ${i.user.username || i.user.id}`,
        });
        return refresh(i);
      }
      if (i.customId === 'captcha_toggle_image')  { cfg.imageMode  = !cfg.imageMode;  await cfg.save(); return refresh(i); }
      if (i.customId === 'captcha_toggle_raid')   { cfg.activeOnRaid = !cfg.activeOnRaid; await cfg.save(); return refresh(i); }
      if (i.customId === 'captcha_toggle_report') {
        cfg.reportDoubtful = cfg.reportDoubtful === false;
        await cfg.save();
        return refresh(i);
      }
      // ── Essai : la correction est réelle, rien n'est appliqué ─────────────
      if (i.customId === 'captcha_test') {
        if (!cfg.channelId) {
          return i.reply({ embeds: [errorEmbed('Salon manquant',
            'Choisis d’abord un **salon de vérification** (`# Salon`) : c’est là que le captcha d’essai sera envoyé.')], ephemeral: true });
        }
        await i.reply({ embeds: [infoEmbed('🧪 Essai lancé',
          'Le captcha de test t’a été envoyé dans le salon de vérification. **Aucun rôle ni expulsion** ne sera appliqué : c’est un essai.')], ephemeral: true }).catch(() => {});
        const outcome = await sendCaptcha(i.member, cfg, interaction.client, { test: true }).catch(() => 'failed');
        if (outcome !== 'pending') {
          console.warn(`[Captcha] Essai impossible (${outcome}) sur ${interaction.guild?.name || 'serveur inconnu'}`);
        }
        return;
      }
      if (i.customId === 'captcha_back')          return refresh(i);

      // ── Vues de sélection ──
      if (i.customId === 'captcha_set_channel') {
        return i.update(selectView({
          title: '# Salon du captcha',
          description: `Le captcha sera envoyé ici à chaque arrivée.\nActuel : ${cfg.channelId ? `<#${cfg.channelId}>` : '*Aucun*'}`,
          row: new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId('captcha_channel_select').setPlaceholder('Choisir un salon…').addChannelTypes(ChannelType.GuildText),
          ),
        }));
      }
      if (i.customId === 'captcha_set_logs') {
        return i.update(selectView({
          title: '📋 Salon de logs',
          description: `Chaque évènement (envoi, réussite, échec, régénération, expulsion…) y sera relayé en direct.\nActuel : ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*Aucun*'}`,
          row: new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId('captcha_log_channel_select').setPlaceholder('Choisir un salon de logs…').addChannelTypes(ChannelType.GuildText),
          ),
          clearId: 'captcha_clear_logs',
        }));
      }
      if (i.customId === 'captcha_set_bypass') {
        return i.update(selectView({
          title: '🛡️ Rôle de bypass',
          description: 'Les membres qui portent déjà ce rôle sautent la vérification.\n\n'
            + '**Seuls les rôles attribués par Discord lui-même** (boost du serveur, abonnement, intégration) sont acceptés : '
            + 'un rôle qu\'un bot, un auto-rôle ou un membre peut donner à l\'arrivée serait un contournement direct du captcha. '
            + '@everyone et les rôles avant/après sont refusés.\n\n'
            + `Actuel : ${cfg.bypassRoleId ? `<@&${cfg.bypassRoleId}>` : '*Aucun*'}`,
          row: new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('captcha_bypass_role_select').setPlaceholder('Rôle de bypass (rôle géré par Discord)…')),
          clearId: 'captcha_clear_bypass',
        }));
      }
      if (i.customId === 'captcha_set_role_before') {
        return i.update(selectView({
          title: '⏳ Rôle avant le captcha',
          description: `Attribué dès l'arrivée, **avant** la vérification — c'est lui qui garde le membre hors des salons tant qu'il n'a pas résolu.\nActuel : ${cfg.roleBefore ? `<@&${cfg.roleBefore}>` : '*Aucun*'}`,
          row: new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('captcha_role_before_select').setPlaceholder('Rôle non-vérifié…')),
          clearId: 'captcha_clear_role_before',
        }));
      }
      if (i.customId === 'captcha_set_role_after') {
        return i.update(selectView({
          title: '✅ Rôle après le captcha',
          description: `Attribué **après** la vérification réussie.\nActuel : ${cfg.roleAfter ? `<@&${cfg.roleAfter}>` : '*Aucun*'}`,
          row: new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('captcha_role_after_select').setPlaceholder('Rôle vérifié…')),
          clearId: 'captcha_clear_role_after',
        }));
      }
      if (i.customId === 'captcha_set_security') {
        return i.update(selectView({
          title: '🔒 Type de code',
          description: `Actuel : **${securityLabel(cfg.security)}**\n\nTous les types sont rendus en **image distordue** (si le mode image est activé) — aucun code n'est jamais exposé en texte lisible par un bot.`,
          row: new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('captcha_security_select').setPlaceholder('Type de captcha…').addOptions([
              { label: 'Lettres uniquement',     value: 'letters', emoji: '🔤', description: 'Code en majuscules seulement' },
              { label: 'Chiffres uniquement',    value: 'numbers', emoji: '🔢', description: 'Code numérique' },
              { label: 'Lettres et chiffres',    value: 'mixed',   emoji: '🔣', description: 'Mélange (recommandé)' },
              { label: 'Calcul mathématique',    value: 'math',    emoji: '➕', description: 'Opération simple à calculer' },
            ]),
          ),
        }));
      }
      if (i.customId === 'captcha_set_distortion') {
        return i.update(selectView({
          title: '🛡️ Niveau anti-OCR',
          description: `Actuel : **${distortionLabel(cfg.imageDistortionLevel)}**\n\n**Normal** — distorsion standard.\n**Dur** — brouillage doublé + découpage horizontal.\n**Extrême** — découpage fort + triple bruit (illisible pour les bots, reste humain).`,
          row: new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('captcha_distortion_select').setPlaceholder('Niveau anti-OCR…').addOptions([
              { label: 'Normal',  value: 'normal',  emoji: '🟢', description: 'Distorsion standard' },
              { label: 'Dur',     value: 'hard',    emoji: '🟠', description: 'Brouillage doublé + découpage' },
              { label: 'Extrême', value: 'extreme', emoji: '🔴', description: 'Résistance maximale aux bots' },
            ]),
          ),
        }));
      }

      // ── Sélections ──
      if (i.customId === 'captcha_channel_select')      { cfg.channelId    = i.values[0]; await cfg.save(); return refresh(i); }
      if (i.customId === 'captcha_log_channel_select')  { cfg.logChannelId = i.values[0]; await cfg.save(); return refresh(i); }

      if (i.customId === 'captcha_bypass_role_select') {
        const roleId = i.values[0];
        const role   = i.guild?.roles?.cache?.get?.(roleId) || null;
        const verdict = bypassVerdict({
          guildId: i.guildId, bypassRoleId: roleId,
          roleBefore: cfg.roleBefore, roleAfter: cfg.roleAfter, role,
        });
        if (!verdict.ok) {
          return i.reply({ embeds: [errorEmbed('🛡️ Bypass refusé', verdict.text)], ephemeral: true });
        }
        cfg.bypassRoleId = roleId;
        await cfg.save();
        await logAction({
          client: interaction.client, guildId: interaction.guildId, userId: i.user.id,
          action: 'bypass_set', detail: `<@&${roleId}> par ${i.user.username || i.user.id}`,
        });
        return refresh(i);
      }

      if (i.customId === 'captcha_role_before_select') {
        const roleId = i.values[0];
        if (roleId === cfg.roleAfter || roleId === cfg.bypassRoleId) {
          return i.reply({ embeds: [errorEmbed('Rôle invalide',
            'Ce rôle est déjà le rôle « vérifié » ou le bypass : il ne peut pas aussi servir de quarantaine.')], ephemeral: true });
        }
        cfg.roleBefore = roleId; await cfg.save(); return refresh(i);
      }

      if (i.customId === 'captcha_role_after_select') {
        const roleId = i.values[0];
        if (roleId === cfg.roleBefore || roleId === cfg.bypassRoleId) {
          return i.reply({ embeds: [errorEmbed('Rôle invalide',
            'Ce rôle est déjà le rôle « non vérifié » ou le bypass : l\'utiliser comme rôle vérifié ouvrirait la porte sans captcha.')], ephemeral: true });
        }
        cfg.roleAfter = roleId; await cfg.save(); return refresh(i);
      }
      if (i.customId === 'captcha_security_select')     { cfg.security     = i.values[0]; await cfg.save(); return refresh(i); }
      if (i.customId === 'captcha_distortion_select')   { cfg.imageDistortionLevel = i.values[0]; await cfg.save(); return refresh(i); }
      if (i.customId === 'captcha_clear_logs')          { cfg.logChannelId = null; await cfg.save(); return refresh(i); }
      if (i.customId === 'captcha_clear_bypass')        { cfg.bypassRoleId = null; await cfg.save(); return refresh(i); }
      if (i.customId === 'captcha_clear_role_before')   { cfg.roleBefore   = null; await cfg.save(); return refresh(i); }
      if (i.customId === 'captcha_clear_role_after')    { cfg.roleAfter    = null; await cfg.save(); return refresh(i); }

      // ── Modaux ──
      if (i.customId === 'captcha_advanced') {
        const modal = new ModalBuilder().setCustomId('captcha_advanced_modal').setTitle('⚙️ Paramètres');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('captcha_attempts').setLabel('Tentatives max (1–10)').setStyle(TextInputStyle.Short).setValue(String(cfg.attempts)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('captcha_timeout').setLabel('Expiration en minutes (1–60)').setStyle(TextInputStyle.Short).setValue(String(cfg.timeout)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('captcha_length').setLabel('Longueur du code (4–10)').setStyle(TextInputStyle.Short).setValue(String(cfg.codeLength)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('captcha_kick').setLabel('Kick si échec ou timeout ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.kickOnFail ? 'oui' : 'non').setRequired(true)),
        );
        return i.showModal(modal);
      }

      if (i.customId === 'captcha_antibot') {
        const modal = new ModalBuilder().setCustomId('captcha_antibot_modal').setTitle('🤖 Anti-bot avancé');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('captcha_regens').setLabel('Régénérations max (0–5)').setStyle(TextInputStyle.Short).setValue(String(cfg.maxRegenerations)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('captcha_min_age').setLabel('Âge min. du compte en jours (0=off)').setStyle(TextInputStyle.Short).setValue(String(cfg.minAccountAgeDays)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('captcha_case').setLabel('Casse exacte requise ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.caseSensitive ? 'oui' : 'non').setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('captcha_dm').setLabel('Prévenir en DM avant expulsion ? (oui/non)').setStyle(TextInputStyle.Short).setValue(cfg.dmOnKick ? 'oui' : 'non').setRequired(true)),
        );
        return i.showModal(modal);
      }
    });

    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  async handleAdvancedModal(interaction) {
    const cfg = await CaptchaConfig.findOne({ guildId: interaction.guildId });
    if (!cfg) return;
    cfg.attempts   = Math.min(10, Math.max(1, parseInt(interaction.fields.getTextInputValue('captcha_attempts'))   || 3));
    cfg.timeout    = Math.min(60, Math.max(1, parseInt(interaction.fields.getTextInputValue('captcha_timeout'))    || 10));
    cfg.codeLength = Math.min(10, Math.max(4, parseInt(interaction.fields.getTextInputValue('captcha_length'))     || 6));
    cfg.kickOnFail = rawTrue(interaction.fields.getTextInputValue('captcha_kick'));
    await cfg.save();
    return interaction.reply({
      embeds: [successEmbed('✅ Paramètres mis à jour',
        `Tentatives : **${cfg.attempts}** ・ Expiration : **${cfg.timeout} min** ・ Code : **${cfg.codeLength} caractères** ・ Kick : **${cfg.kickOnFail ? 'Oui' : 'Non'}**`)],
      ephemeral: true,
    });
  },

  async handleAntiBotModal(interaction) {
    const cfg = await CaptchaConfig.findOne({ guildId: interaction.guildId });
    if (!cfg) return;

    const regens = parseInt(interaction.fields.getTextInputValue('captcha_regens'));
    const minAge = parseInt(interaction.fields.getTextInputValue('captcha_min_age'));
    if (isNaN(regens) || isNaN(minAge) || regens < 0 || regens > 5 || minAge < 0) {
      return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Régénérations : 0 à 5. Âge minimum : nombre positif de jours (0 pour désactiver).')], ephemeral: true });
    }

    cfg.maxRegenerations = regens;
    cfg.minAccountAgeDays = minAge;
    const caseRaw = interaction.fields.getTextInputValue('captcha_case').toLowerCase().trim();
    cfg.caseSensitive = rawTrue(caseRaw);
    const dmRaw = interaction.fields.getTextInputValue('captcha_dm').toLowerCase().trim();
    cfg.dmOnKick = rawTrue(dmRaw);
    await cfg.save();

    return interaction.reply({
      embeds: [successEmbed('✅ Anti-bot mis à jour',
        `Régénérations max : **${cfg.maxRegenerations}** ・ Âge min. du compte : **${cfg.minAccountAgeDays > 0 ? cfg.minAccountAgeDays + 'j' : 'désactivé'}** ・ Casse exacte : **${cfg.caseSensitive ? 'Oui' : 'Non'}** ・ DM avant kick : **${cfg.dmOnKick ? 'Oui' : 'Non'}**`)],
      ephemeral: true,
    });
  },
};

function rawTrue(v) {
  return ['oui', 'yes', '1', 'true', 'on'].includes(String(v || '').toLowerCase().trim());
}
