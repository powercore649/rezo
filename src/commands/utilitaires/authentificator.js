'use strict';
// commands/utilitaires/authentificator.js — /authentificator
// Panneau d'authentification personnel : code PIN · 2FA (TOTP) · codes de secours.
//
// Fonctionnalité réservée aux serveurs licenciés (essai gratuit accepté) :
// `authentificator` figure dans LICENSE_REQUIRED_COMMANDS, le routeur bloque la
// commande, et chaque bouton refait le contrôle (un panneau ouvert pendant
// l'essai se verrouille donc tout seul à l'expiration) — voir handleButton.
//
// Ce fichier a été repris de `auth-profil` avec quatre corrections de fond :
//   1. la 2FA ne peut plus être désactivée sans PIN quand un PIN existe
//      (l'ancien bouton de confirmation contournait la vérification) ;
//   2. une clé `AUTH_ENCRYPTION_KEY` absente affiche un message clair au lieu
//      de laisser l'interaction sans réponse ;
//   3. un code TOTP ne peut plus être rejoué (compteur mémorisé) ;
//   4. plus aucune promesse `update().catch(reply())` non maîtrisée : un seul
//      helper décide entre update / editReply / reply selon l'état réel.
//
// Ajouts : QR code scannable pour la 2FA, statut de verrouillage du PIN affiché,
// code de secours au format 4×4 et journalisation des refus de licence.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const crypto = require('crypto');
const totp = require('../../utils/totp');
const licenseGate = require('../../utils/licenseGate');
const {
  getOrCreateProfile,
  addLog,
  formatLog,
  computeGrade,
  checkPin,
  hashSecret,
  verifySecret,
  isPinWeak,
  isEncryptionAvailable,
  encrypt,
  decrypt,
  MAX_PASSKEYS,
  FORGOT_DELAY_MS,
  PIN_LOCK_THRESHOLD,
} = require('../../utils/authProfileManager');
const { COLORS } = require('../../utils/embeds');
const brand = require('../../utils/brand');

const COMMAND_NAME = 'authentificator';
const PENDING_2FA_TTL_MS = 10 * 60 * 1000; // 10 min pour finaliser l'activation 2FA
const QR_FILENAME = '2fa-qr.png';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

// ─── Réponse robuste ─────────────────────────────────────────────────────────
// Une interaction ne peut être répondue qu'une fois, et `update()` n'existe que
// pour les composants attachés à un message. Ce helper choisit la bonne méthode
// et ne laisse jamais une exception filer jusqu'au routeur (interaction muette).
async function respond(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    if (typeof interaction.isFromMessage === 'function' && interaction.isFromMessage()) {
      return await interaction.update(payload);
    }
    return await interaction.reply({ ...payload, ...EPHEMERAL });
  } catch {
    // Dernier recours : le message d'origine n'existe plus (supprimé) ou
    // l'interaction a expiré. On tente un éphémère, sans casser le bot.
    try {
      return await interaction.followUp({ ...payload, ...EPHEMERAL });
    } catch {
      return null;
    }
  }
}

function simpleEmbed(color, title, description) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

const backRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('auth_back').setLabel('Retour au profil').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
);

// ─── Panneau principal ──────────────────────────────────────────────────────
function buildPanel(user, profile, { note = null } = {}) {
  const { grade, emoji, color, tip } = computeGrade(profile);

  const pinLine = profile.pin.isSet
    ? `🟢 **Défini** ${profile.pin.weak ? '· ⚠️ Simple' : '· Robuste'}`
    : '🔴 **Non défini**';
  const twofaLine = profile.twoFA.enabled ? '🟢 **Activée**' : '🔴 **Désactivée**';
  const activePasskeys = (profile.passkeys || []).filter(p => !p.used);
  const passkeyLine = activePasskeys.length > 0 ? `🟢 **${activePasskeys.length}** active(s)` : '🔴 **Aucune**';

  const recentLogs = (profile.logs || []).slice(0, 3);
  const logsLine = recentLogs.length > 0 ? recentLogs.map(formatLog).join('\n') : '*Aucune activité récente*';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `@${user.username}`, iconURL: user.displayAvatarURL() })
    .setTitle('🔐 Profil d’authentification')
    .setDescription(note || 'Sécurisez vos actions sensibles avec un code PIN, la 2FA et des codes de secours.')
    .addFields(
      { name: '🔢 Code PIN', value: pinLine, inline: true },
      { name: '⏱️ Code 2FA', value: twofaLine, inline: true },
      { name: '🔑 Codes de secours', value: passkeyLine, inline: true },
      { name: '📋 Activité récente', value: logsLine, inline: false },
    )
    .setFooter({ text: brand.footer(`Sécurité ${emoji} ${grade} — ${tip}`) })
    .setTimestamp();

  // Verrouillage anti-bruteforce : l'utilisateur doit voir pourquoi son PIN est
  // refusé, sinon il réessaie et prolonge le verrou.
  const lockedUntil = profile.pin?.lockedUntil ? new Date(profile.pin.lockedUntil) : null;
  if (lockedUntil && lockedUntil > new Date()) {
    embed.addFields({
      name: '🔒 PIN verrouillé',
      value: `Trop de tentatives échouées. Réessayez <t:${Math.floor(lockedUntil.getTime() / 1000)}:R>.\nUn code de secours reste utilisable pour les actions protégées.`,
    });
  }

  if (profile.forgot?.pending) {
    const ready = profile.forgot.unlockAt && new Date(profile.forgot.unlockAt) <= new Date();
    embed.addFields({
      name: '🆘 Réinitialisation en cours',
      value: ready
        ? 'Le délai de sûreté est écoulé — vous pouvez finaliser la réinitialisation.'
        : `Disponible <t:${Math.floor(new Date(profile.forgot.unlockAt).getTime() / 1000)}:R>`,
    });
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('auth_pin_modify').setLabel(profile.pin.isSet ? 'Modifier le PIN' : 'Définir un PIN').setStyle(ButtonStyle.Primary).setEmoji('🔢'),
    profile.twoFA.enabled
      ? new ButtonBuilder().setCustomId('auth_2fa_disable').setLabel('Désactiver la 2FA').setStyle(ButtonStyle.Danger).setEmoji('⏱️')
      : new ButtonBuilder().setCustomId('auth_2fa_start').setLabel('Activer la 2FA').setStyle(ButtonStyle.Success).setEmoji('⏱️'),
    new ButtonBuilder()
      .setCustomId('auth_passkey_add')
      .setLabel('Nouveau code de secours')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🔑')
      .setDisabled(activePasskeys.length >= MAX_PASSKEYS),
  );

  const row2Buttons = [];
  if (activePasskeys.length > 0) {
    row2Buttons.push(new ButtonBuilder().setCustomId('auth_passkey_manage').setLabel('Gérer mes codes').setStyle(ButtonStyle.Secondary).setEmoji('🗂️'));
  }
  row2Buttons.push(
    new ButtonBuilder().setCustomId('auth_logs_all').setLabel('Voir tous les logs').setStyle(ButtonStyle.Secondary).setEmoji('📋'),
    new ButtonBuilder().setCustomId('auth_refresh').setLabel('Actualiser').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
  );
  const row2 = new ActionRowBuilder().addComponents(...row2Buttons);

  const forgotReady = profile.forgot?.pending
    && profile.forgot.unlockAt
    && new Date(profile.forgot.unlockAt) <= new Date();

  const row3 = new ActionRowBuilder().addComponents(
    profile.forgot?.pending
      ? (forgotReady
          ? new ButtonBuilder().setCustomId('auth_forgot_finalize').setLabel('Finaliser la réinitialisation').setStyle(ButtonStyle.Danger).setEmoji('🆘')
          : new ButtonBuilder().setCustomId('auth_forgot_cancel').setLabel('Annuler la réinitialisation').setStyle(ButtonStyle.Secondary).setEmoji('✖️'))
      : new ButtonBuilder().setCustomId('auth_forgot').setLabel('J’ai perdu mes accès').setStyle(ButtonStyle.Danger).setEmoji('🆘'),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

async function render(interaction, profile, options = {}) {
  return respond(interaction, buildPanel(interaction.user, profile, options));
}

// ─── Contrôle de licence (refait à chaque interaction) ──────────────────────
async function licenceRefusal(interaction) {
  if (!licenseGate.isLicenseRequired(COMMAND_NAME)) return null;
  if (!interaction.inGuild?.()) return null;

  const access = await licenseGate.checkAccessBounded(interaction.guildId, COMMAND_NAME);
  if (!access) return { embed: licenseGate.unavailableEmbed(COMMAND_NAME), reason: 'unavailable' };
  if (!access.ok) return { embed: licenseGate.lockEmbed(COMMAND_NAME, { access }), reason: access.reason };
  return null;
}

/** Code de secours : 16 caractères hexadécimaux, présentés en 4 groupes. */
function generateRecoveryCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g).join('-');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription('🔐 Gérer votre authentification personnelle (PIN, 2FA, codes de secours)'),

  async execute(interaction) {
    const refusal = await licenceRefusal(interaction);
    if (refusal) return interaction.reply({ embeds: [refusal.embed], ...EPHEMERAL }).catch(() => {});

    const profile = await getOrCreateProfile(interaction.user.id);
    const note = isEncryptionAvailable()
      ? null
      : '⚠️ La 2FA est indisponible sur ce bot : `AUTH_ENCRYPTION_KEY` n’est pas configurée. Le PIN et les codes de secours, eux, fonctionnent.';
    return respond(interaction, buildPanel(interaction.user, profile, { note }));
  },

  // ─── Boutons ──────────────────────────────────────────────────────────────
  async handleButton(interaction) {
    const refusal = await licenceRefusal(interaction);
    if (refusal) {
      return interaction.reply({ embeds: [refusal.embed], ...EPHEMERAL }).catch(() => {});
    }

    const id = interaction.customId;
    const profile = await getOrCreateProfile(interaction.user.id);

    if (id === 'auth_back' || id === 'auth_refresh') return render(interaction, profile);

    // ── PIN ──
    if (id === 'auth_pin_modify') {
      const modal = new ModalBuilder()
        .setCustomId('auth_pin_modal')
        .setTitle(profile.pin.isSet ? 'Modifier votre code PIN' : 'Définir votre code PIN');
      const oldPin = new TextInputBuilder()
        .setCustomId('old_pin').setLabel('PIN actuel (vide si aucun)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(8);
      const newPin = new TextInputBuilder()
        .setCustomId('new_pin').setLabel('Nouveau PIN (4 à 8 chiffres)')
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(8);
      const confirmPin = new TextInputBuilder()
        .setCustomId('confirm_pin').setLabel('Confirmez le nouveau PIN')
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(8);
      modal.addComponents(
        new ActionRowBuilder().addComponents(oldPin),
        new ActionRowBuilder().addComponents(newPin),
        new ActionRowBuilder().addComponents(confirmPin),
      );
      return interaction.showModal(modal);
    }

    // ── 2FA : démarrage ──
    if (id === 'auth_2fa_start') {
      if (profile.twoFA.enabled) return render(interaction, profile);

      if (!isEncryptionAvailable()) {
        const embed = simpleEmbed(
          COLORS.error,
          '⏱️ 2FA indisponible',
          'Le bot n’a pas de clé de chiffrement (`AUTH_ENCRYPTION_KEY`) : impossible de stocker un secret 2FA en sécurité.\nUn administrateur doit la générer et la placer dans le `.env`, puis redémarrer le bot.\n\n```\nnode -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n```',
        );
        return respond(interaction, { embeds: [embed], components: [backRow] });
      }

      const secret = totp.generateSecret();
      try {
        profile.twoFA.pendingSecretEnc = encrypt(secret);
      } catch (err) {
        console.error('2FA: chiffrement impossible —', err.message);
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '⏱️ 2FA indisponible', err.message)],
          components: [backRow],
        });
      }
      profile.twoFA.pendingCreatedAt = new Date();
      await profile.save();

      const uri = totp.generateURI(secret, interaction.user.username, 'REZO');
      const embed = simpleEmbed(
        COLORS.info,
        '⏱️ Activer la double authentification (2FA)',
        [
          '**1.** Ouvrez une application d’authentification (Google Authenticator, Authy, 1Password…).',
          '**2.** Scannez le QR code ci-dessous — ou ajoutez le compte manuellement avec la clé :',
          `\`\`\`${secret}\`\`\``,
          `Lien \`otpauth://\` si votre application l’accepte :\n\`${uri}\``,
          '**3.** Cliquez sur **Vérifier le code** et saisissez le code à 6 chiffres affiché.',
          '',
          `⚠️ Ce secret expire dans ${Math.round(PENDING_2FA_TTL_MS / 60000)} minutes s’il n’est pas confirmé.`,
        ].join('\n'),
      ).setFooter({ text: brand.footer('2FA • un seul secret à la fois') });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('auth_2fa_verify_open').setLabel('Vérifier le code').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('auth_back').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('✖️'),
      );

      const payload = { embeds: [embed], components: [row] };
      try {
        const QRCode = require('qrcode');
        const qr = await QRCode.toBuffer(uri, { type: 'png', margin: 1, width: 320, color: { dark: '#ffffffff', light: '#00000000' } });
        embed.setImage(`attachment://${QR_FILENAME}`);
        payload.files = [new AttachmentBuilder(qr, { name: QR_FILENAME })];
      } catch (err) {
        // Un QR en échec ne doit pas empêcher l'activation : la clé reste affichée.
        console.warn('2FA: QR code non généré —', err?.message || err);
      }

      return respond(interaction, payload);
    }

    // ── 2FA : ouvrir le modal de vérification ──
    if (id === 'auth_2fa_verify_open') {
      const pendingAt = profile.twoFA.pendingCreatedAt ? new Date(profile.twoFA.pendingCreatedAt).getTime() : 0;
      if (!profile.twoFA.pendingSecretEnc || Date.now() - pendingAt > PENDING_2FA_TTL_MS) {
        profile.twoFA.pendingSecretEnc = null;
        profile.twoFA.pendingCreatedAt = null;
        await profile.save();
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '❌ Session expirée', 'Relancez l’activation de la 2FA depuis le profil.')],
          components: [backRow],
        });
      }
      const modal = new ModalBuilder().setCustomId('auth_2fa_modal').setTitle('Vérification du code 2FA');
      const code = new TextInputBuilder()
        .setCustomId('code').setLabel('Code à 6 chiffres')
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(6).setMaxLength(6);
      modal.addComponents(new ActionRowBuilder().addComponents(code));
      return interaction.showModal(modal);
    }

    // ── 2FA : désactivation ──
    if (id === 'auth_2fa_disable') {
      if (!profile.pin.isSet) {
        // Sans PIN, il n'y a rien à vérifier : on demande une confirmation explicite.
        const embed = simpleEmbed(COLORS.warning, '⚠️ Confirmer la désactivation', 'La 2FA protège votre profil : confirmez-vous sa désactivation ?');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('auth_2fa_disable_confirm').setLabel('Confirmer').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('auth_back').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
        );
        return respond(interaction, { embeds: [embed], components: [row] });
      }
      const modal = new ModalBuilder().setCustomId('auth_2fa_disable_modal').setTitle('Désactiver la 2FA');
      const pin = new TextInputBuilder()
        .setCustomId('pin').setLabel('Confirmez avec votre code PIN')
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(8);
      modal.addComponents(new ActionRowBuilder().addComponents(pin));
      return interaction.showModal(modal);
    }

    if (id === 'auth_2fa_disable_confirm') {
      // Correctif : ce bouton pouvait désactiver la 2FA sans PIN si un message
      // ancien était encore cliquable. Le PIN est désormais exigé dès qu'il existe.
      if (profile.pin.isSet) return render(interaction, profile, { note: '🔐 Saisissez votre PIN via **Désactiver la 2FA** pour confirmer.' });

      profile.twoFA.enabled = false;
      profile.twoFA.secretEnc = null;
      profile.twoFA.enabledAt = null;
      profile.twoFA.lastCounter = -1;
      await profile.save();
      await addLog(profile, 'twofa_disabled');
      return render(interaction, profile);
    }

    // ── Codes de secours : création ──
    if (id === 'auth_passkey_add') {
      const activePasskeys = (profile.passkeys || []).filter(p => !p.used);
      if (activePasskeys.length >= MAX_PASSKEYS) {
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.warning, '⚠️ Limite atteinte', `Vous ne pouvez pas avoir plus de **${MAX_PASSKEYS}** codes de secours actifs. Révoquez-en un avant d’en créer un nouveau.`)],
          components: [backRow],
        });
      }

      const rawCode = generateRecoveryCode();
      const { hash, salt } = hashSecret(rawCode.replace(/-/g, ''));
      const passkeyId = crypto.randomBytes(4).toString('hex');
      const label = `Code #${(profile.passkeys || []).length + 1}`;
      profile.passkeys.push({ id: passkeyId, label, codeHash: hash, salt, createdAt: new Date() });
      await profile.save();
      await addLog(profile, 'passkey_added', label);

      const embed = simpleEmbed(
        COLORS.success,
        '🔑 Code de secours créé',
        [
          `Votre code **${label}** :`,
          `\`\`\`${rawCode}\`\`\``,
          '⚠️ **Notez-le maintenant** — il ne sera plus jamais affiché.',
          'Il sert de clé de secours : il remplace le PIN pour une action protégée, puis il est consommé.',
        ].join('\n'),
      );
      // Copie en DM : un code affiché une seule fois se perd vite.
      await interaction.user.send({
        embeds: [simpleEmbed(COLORS.success, '🔑 Code de secours — copie de sauvegarde', `Code **${label}** :\n\`\`\`${rawCode}\`\`\``)],
      }).catch(() => {});

      return respond(interaction, { embeds: [embed], components: [backRow] });
    }

    // ── Codes de secours : gestion ──
    if (id === 'auth_passkey_manage') {
      const activePasskeys = (profile.passkeys || []).filter(p => !p.used);
      if (activePasskeys.length === 0) return render(interaction, profile);

      const menu = new StringSelectMenuBuilder()
        .setCustomId('auth_passkey_select_revoke')
        .setPlaceholder('Sélectionner un code de secours à révoquer…')
        .addOptions(activePasskeys.slice(0, 25).map(p => ({
          label: p.label,
          value: p.id,
          description: `Créé le ${new Date(p.createdAt).toLocaleDateString('fr-FR')}`,
          emoji: '🔑',
        })));
      const embed = simpleEmbed(COLORS.info, '🗂️ Mes codes de secours', 'Sélectionnez un code ci-dessous pour le révoquer définitivement.');
      return respond(interaction, { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), backRow] });
    }

    // ── Logs ──
    if (id === 'auth_logs_all') {
      const logs = (profile.logs || []).slice(0, 25);
      const description = logs.length > 0 ? logs.map(formatLog).join('\n') : '*Aucune activité enregistrée.*';
      return respond(interaction, {
        embeds: [simpleEmbed(COLORS.info, '📋 Historique complet', description.slice(0, 4000))],
        components: [backRow],
      });
    }

    // ── J'ai perdu mes accès ──
    if (id === 'auth_forgot') {
      const embed = simpleEmbed(
        COLORS.warning,
        '🆘 Réinitialiser tous mes moyens d’authentification',
        [
          'Cette action va **supprimer votre PIN, votre 2FA et tous vos codes de secours**.',
          `Un délai de sûreté de **${Math.round(FORGOT_DELAY_MS / 60000)} minutes** s’applique avant de pouvoir finaliser, pour votre sécurité.`,
          '',
          'Confirmez-vous cette demande ?',
        ].join('\n'),
      );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('auth_forgot_confirm').setLabel('Oui, réinitialiser').setStyle(ButtonStyle.Danger).setEmoji('🆘'),
        new ButtonBuilder().setCustomId('auth_back').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
      );
      return respond(interaction, { embeds: [embed], components: [row] });
    }

    if (id === 'auth_forgot_confirm') {
      profile.forgot.pending = true;
      profile.forgot.requestedAt = new Date();
      profile.forgot.unlockAt = new Date(Date.now() + FORGOT_DELAY_MS);
      await profile.save();
      await addLog(profile, 'forgot_requested');

      await interaction.user.send({
        embeds: [simpleEmbed(COLORS.warning, '🆘 Demande de réinitialisation reçue', 'Si vous n’êtes pas à l’origine de cette demande, annulez-la depuis `/authentificator` et changez votre mot de passe Discord.')],
      }).catch(() => {});

      return render(interaction, profile);
    }

    if (id === 'auth_forgot_cancel') {
      profile.forgot.pending = false;
      profile.forgot.requestedAt = null;
      profile.forgot.unlockAt = null;
      await profile.save();
      await addLog(profile, 'forgot_cancelled');
      return render(interaction, profile);
    }

    if (id === 'auth_forgot_finalize') {
      const unlockAt = profile.forgot?.unlockAt ? new Date(profile.forgot.unlockAt) : null;
      if (!profile.forgot?.pending || !unlockAt || unlockAt > new Date()) {
        return render(interaction, profile, { note: '⏳ Le délai de sûreté n’est pas encore écoulé.' });
      }
      profile.pin = { hash: null, salt: null, isSet: false, weak: false, updatedAt: null, failedAttempts: 0, lockedUntil: null };
      profile.twoFA = { enabled: false, secretEnc: null, enabledAt: null, pendingSecretEnc: null, pendingCreatedAt: null, lastCounter: -1 };
      profile.passkeys = [];
      profile.forgot = { pending: false, requestedAt: null, unlockAt: null };
      await profile.save();
      await addLog(profile, 'forgot_completed');
      return respond(interaction, {
        embeds: [simpleEmbed(COLORS.success, '✅ Réinitialisation terminée', 'Tous vos moyens d’authentification ont été supprimés. Vous pouvez en configurer de nouveaux dès maintenant.')],
        components: [backRow],
      });
    }

    return render(interaction, profile);
  },

  // ─── Menu : révocation d'un code de secours ──────────────────────────────
  async handleSelectMenu(interaction) {
    if (interaction.customId !== 'auth_passkey_select_revoke') return;

    const refusal = await licenceRefusal(interaction);
    if (refusal) return interaction.reply({ embeds: [refusal.embed], ...EPHEMERAL }).catch(() => {});

    const profile = await getOrCreateProfile(interaction.user.id);
    const targetId = interaction.values?.[0];
    const passkey = (profile.passkeys || []).find(p => p.id === targetId);
    if (!passkey) return render(interaction, profile);

    passkey.used = true;
    await profile.save();
    await addLog(profile, 'passkey_revoked', passkey.label);
    return render(interaction, profile);
  },

  // ─── Modaux ──────────────────────────────────────────────────────────────
  async handleModal(interaction) {
    const refusal = await licenceRefusal(interaction);
    if (refusal) return interaction.reply({ embeds: [refusal.embed], ...EPHEMERAL }).catch(() => {});

    const id = interaction.customId;
    const profile = await getOrCreateProfile(interaction.user.id);

    // ── PIN : définir / modifier ──
    if (id === 'auth_pin_modal') {
      const oldPin = interaction.fields.getTextInputValue('old_pin')?.trim();
      const newPin = interaction.fields.getTextInputValue('new_pin')?.trim();
      const confirmPin = interaction.fields.getTextInputValue('confirm_pin')?.trim();

      if (profile.pin.isSet) {
        if (!oldPin) {
          return respond(interaction, {
            embeds: [simpleEmbed(COLORS.error, '❌ PIN actuel requis', 'Vous devez saisir votre PIN actuel pour le modifier.')],
            components: [backRow],
          });
        }
        const check = await checkPin(profile, oldPin);
        if (check.locked) {
          return respond(interaction, {
            embeds: [simpleEmbed(COLORS.error, '🔒 Compte verrouillé', `Trop de tentatives échouées. Réessayez dans **${check.remainingMinutes} min**.`)],
            components: [backRow],
          });
        }
        if (!check.ok) {
          return respond(interaction, {
            embeds: [simpleEmbed(COLORS.error, '❌ PIN incorrect', `Le PIN actuel est incorrect.${check.remainingAttempts ? ` Il reste **${check.remainingAttempts}** tentative(s) avant verrouillage.` : ''}`)],
            components: [backRow],
          });
        }
      }

      if (!/^\d{4,8}$/.test(newPin || '')) {
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '❌ Format invalide', 'Le nouveau PIN doit contenir entre 4 et 8 chiffres.')],
          components: [backRow],
        });
      }
      if (newPin !== confirmPin) {
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '❌ Les PIN ne correspondent pas', 'Les deux champs doivent être identiques.')],
          components: [backRow],
        });
      }
      if (profile.pin.isSet && verifySecret(newPin, profile.pin.hash, profile.pin.salt)) {
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.warning, 'ℹ️ PIN identique', 'Ce PIN est déjà le vôtre. Choisissez-en un différent pour réellement le changer.')],
          components: [backRow],
        });
      }

      const wasSet = profile.pin.isSet;
      const weak = isPinWeak(newPin);
      const { hash, salt } = hashSecret(newPin);
      profile.pin.hash = hash;
      profile.pin.salt = salt;
      profile.pin.isSet = true;
      profile.pin.weak = weak;
      profile.pin.updatedAt = new Date();
      profile.pin.failedAttempts = 0;
      profile.pin.lockedUntil = null;
      await profile.save();
      await addLog(profile, wasSet ? 'pin_changed' : 'pin_set');

      return respond(interaction, {
        embeds: [simpleEmbed(
          COLORS.success,
          '✅ Code PIN enregistré',
          weak
            ? `⚠️ Ce PIN est simple à deviner (${PIN_LOCK_THRESHOLD} essais ratés = 15 min de verrou). Pensez à un code plus robuste.`
            : 'Votre code PIN a été mis à jour avec succès.',
        )],
        components: [backRow],
      });
    }

    // ── 2FA : confirmation de l'activation ──
    if (id === 'auth_2fa_modal') {
      const pendingAt = profile.twoFA.pendingCreatedAt ? new Date(profile.twoFA.pendingCreatedAt).getTime() : 0;
      if (!profile.twoFA.pendingSecretEnc || Date.now() - pendingAt > PENDING_2FA_TTL_MS) {
        profile.twoFA.pendingSecretEnc = null;
        profile.twoFA.pendingCreatedAt = null;
        await profile.save();
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '❌ Session expirée', 'Relancez l’activation de la 2FA depuis le profil.')],
          components: [backRow],
        });
      }

      let secret;
      try {
        secret = decrypt(profile.twoFA.pendingSecretEnc);
      } catch (err) {
        console.error('2FA: déchiffrement impossible —', err.message);
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '⏱️ 2FA indisponible', err.message)],
          components: [backRow],
        });
      }

      const counter = totp.matchCounter(secret, interaction.fields.getTextInputValue('code'), { window: 1 });
      if (counter === null) {
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '❌ Code invalide', 'Le code saisi est incorrect ou expiré. Utilisez le code affiché à l’instant par votre application.')],
          components: [backRow],
        });
      }

      profile.twoFA.enabled = true;
      profile.twoFA.secretEnc = profile.twoFA.pendingSecretEnc;
      profile.twoFA.enabledAt = new Date();
      profile.twoFA.pendingSecretEnc = null;
      profile.twoFA.pendingCreatedAt = null;
      // Le code qui vient d'être utilisé est consommé : impossible de le rejouer.
      profile.twoFA.lastCounter = counter;
      await profile.save();
      await addLog(profile, 'twofa_enabled');

      return respond(interaction, {
        embeds: [simpleEmbed(COLORS.success, '✅ 2FA activée', 'La double authentification protège désormais votre profil. Conservez aussi un code de secours.')],
        components: [backRow],
      });
    }

    // ── 2FA : désactivation confirmée par PIN ──
    if (id === 'auth_2fa_disable_modal') {
      const check = await checkPin(profile, interaction.fields.getTextInputValue('pin'));
      if (check.locked) {
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '🔒 Compte verrouillé', `Trop de tentatives échouées. Réessayez dans **${check.remainingMinutes} min**.`)],
          components: [backRow],
        });
      }
      if (!check.ok) {
        return respond(interaction, {
          embeds: [simpleEmbed(COLORS.error, '❌ PIN incorrect', 'Impossible de désactiver la 2FA.')],
          components: [backRow],
        });
      }

      profile.twoFA.enabled = false;
      profile.twoFA.secretEnc = null;
      profile.twoFA.enabledAt = null;
      profile.twoFA.lastCounter = -1;
      await profile.save();
      await addLog(profile, 'twofa_disabled');

      return respond(interaction, {
        embeds: [simpleEmbed(COLORS.success, '✅ 2FA désactivée', 'La double authentification a été désactivée.')],
        components: [backRow],
      });
    }
  },

  __testables: {
    COMMAND_NAME,
    PENDING_2FA_TTL_MS,
    QR_FILENAME,
    buildPanel,
    render,
    respond,
    simpleEmbed,
    generateRecoveryCode,
    licenceRefusal,
  },
};
