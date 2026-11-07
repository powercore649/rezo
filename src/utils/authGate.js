'use strict';
// utils/authGate.js — Verrou générique pour les actions sensibles
// (ban, raidmode, purge, sécurité…) : un seul système d'authentification
// personnel, plusieurs façons de prouver son identité.
//
//   • code PIN              → la méthode par défaut ;
//   • code 2FA (TOTP)       → accepté si la double authentification est active ;
//   • code de secours       → créé via /authentificator, consommé après usage ;
//   • session de confiance  → 5 minutes, pour ne pas redemander le PIN à chaque
//                             action d'une même modération.
//
// Si le membre n'a configuré aucune protection, l'action passe directement :
// ce module ajoute une vérification, il ne bloque jamais un serveur qui n'a
// rien demandé.
//
// Usage :
//   await authGate.protect(interaction, {
//     label: 'Expulser @membre',
//     executor: itx => itx.deferReply().then(() => itx.editReply('fait')),
//   });

const crypto = require('crypto');
const {
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const {
  getOrCreateProfile,
  checkPin,
  consumeTotp,
  consumePasskey,
} = require('./authProfileManager');
const { COLORS } = require('./embeds');

const PENDING_TTL_MS = 3 * 60 * 1000;  // 3 min pour remplir le modal

// ── Commandes à risque ──────────────────────────────────────────────────────
// Toute commande capable de sanctionner un membre, de supprimer du contenu ou
// de désactiver une protection passe par une preuve d'identité (si le membre a
// configuré /authentificator). La liste est centralisée ici : le routeur et le
// système de préfixe s'y réfèrent, donc aucune nouvelle commande de ce type ne
// peut être ajoutée sans être couverte.
const PROTECTED_COMMANDS = new Set([
  // Sanctions / gestion des membres
  // `mod` porte désormais les sanctions et les gestes de modération (ex-/warn).
  // `sanctions` lit les bannissements officiels et peut en lever un depuis la fiche.
  'mod', 'sanctions', 'kick', 'ban', 'unban', 'tempban', 'softban', 'warn', 'unwarn', 'warnings',
  'timeout', 'mute', 'unmute', 'sanction', 'blacklist',
  // Nettoyage / état des salons
  'purge', 'clear', 'lock', 'unlock', 'lockdown',
  // Sécurité et automatisations
  'securite', 'antiraid', 'raidmode', 'antiscam', 'anti-nuke', 'honeypot',
  'automod', 'modlog', 'warn', 'captcha',
  // Contenu et salons sensibles
  'scam', 'modmail', 'ticket', 'resetrescue',
]);

/** Cette commande exige-t-elle une preuve d'identité ? */
function isProtectedCommand(commandName) {
  return PROTECTED_COMMANDS.has(String(commandName || '').toLowerCase());
}
const TRUST_TTL_MS = 5 * 60 * 1000;    // 5 min de confiance après une preuve
const MAX_FAILURES = 5;                // fenêtre glissante anti-spam de modaux

const pending = new Map();   // token -> { userId, executor, payload, label, expiresAt }
const trusted = new Map();   // userId -> expiresAt
const failures = new Map();  // userId -> { count, since }

const errEmbed = (title, description) =>
  new EmbedBuilder().setColor(COLORS.error).setTitle(title).setDescription(description);

function cleanup() {
  const now = Date.now();
  for (const [token, entry] of pending) if (entry.expiresAt < now) pending.delete(token);
  for (const [userId, expiresAt] of trusted) if (expiresAt < now) trusted.delete(userId);
  for (const [userId, entry] of failures) {
    if (now - entry.since > TRUST_TTL_MS) failures.delete(userId);
  }
}

/** Membre déjà authentifié il y a moins de 5 minutes ? */
function isTrusted(userId) {
  const expiresAt = trusted.get(String(userId));
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) { trusted.delete(String(userId)); return false; }
  return true;
}

/** Ouvre (ou renouvelle) la fenêtre de confiance. */
function grantTrust(userId) {
  trusted.set(String(userId), Date.now() + TRUST_TTL_MS);
}

/** Ferme la fenêtre de confiance — appelé au changement de PIN / 2FA. */
function clearTrust(userId) {
  trusted.delete(String(userId));
}

/** Moyens réellement disponibles pour ce profil. */
function availableFactors(profile) {
  return {
    pin: !!profile.pin?.isSet,
    totp: !!profile.twoFA?.enabled,
    recovery: (profile.passkeys || []).some(p => !p.used),
  };
}

/**
 * Protège une action sensible derrière le profil d'authentification du membre.
 *
 * @param {Interaction} interaction - interaction d'origine, pas encore répondue.
 * @param {Object} opts
 * @param {string} opts.label - libellé affiché dans le modal (« Expulser X »).
 * @param {Object} [opts.payload] - données transmises à l'exécuteur.
 * @param {(itx: Interaction, payload: Object) => Promise<void>} opts.executor
 *   Exécute l'action réelle. `itx` est l'interaction d'origine si aucune preuve
 *   n'est demandée, sinon celle du modal — dans les deux cas non acquittée.
 * @returns {Promise<void>}
 */
async function protect(interaction, { label, payload = {}, executor }) {
  if (typeof executor !== 'function') throw new TypeError('authGate.protect: executor requis');

  const profile = await getOrCreateProfile(interaction.user.id);
  const factors = availableFactors(profile);

  // Rien de configuré, ou confiance encore valide : aucune friction inutile.
  if (!factors.pin && !factors.totp && !factors.recovery) return executor(interaction, payload);
  if (isTrusted(interaction.user.id)) return executor(interaction, payload);

  cleanup();
  const token = crypto.randomBytes(8).toString('hex');
  pending.set(token, {
    userId: interaction.user.id,
    executor,
    payload,
    label,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  return interaction.showModal(buildAuthModal(token, label, factors));
}

/** Construit le modal de preuve d'identité, adapté aux moyens disponibles. */
function buildAuthModal(token, label, factors) {
  const modal = new ModalBuilder()
    .setCustomId(`authgate_confirm_${token}`)
    .setTitle(`🔐 Confirmer : ${label}`.slice(0, 45));

  const alternatives = [factors.pin, factors.totp, factors.recovery].filter(Boolean).length > 1;
  const rows = [];

  if (factors.pin) {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('pin')
        .setLabel(alternatives ? 'Code PIN (ou utilisez un autre moyen)' : 'Votre code PIN')
        .setStyle(TextInputStyle.Short)
        .setRequired(!alternatives)
        .setMinLength(4)
        .setMaxLength(8),
    ));
  }
  if (factors.totp) {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('code')
        .setLabel('Code 2FA à 6 chiffres')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMinLength(6)
        .setMaxLength(6),
    ));
  }
  if (factors.recovery) {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('recovery')
        .setLabel('Code de secours (XXXX-XXXX-XXXX-XXXX)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(24),
    ));
  }
  modal.addComponents(rows.slice(0, 5));
  return modal;
}

/**
 * À appeler depuis interactionCreate.js pour tout customId commençant par
 * `authgate_confirm_`. Retourne true si l'interaction a été prise en charge.
 */
async function handleModal(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('authgate_confirm_')) return false;

  const token = id.slice('authgate_confirm_'.length);
  const entry = pending.get(token);
  pending.delete(token); // usage unique, même en cas d'échec

  if (!entry || entry.expiresAt < Date.now()) {
    await interaction.reply({
      embeds: [errEmbed('❌ Session expirée', 'Relancez la commande ou l’action depuis le début.')],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }
  if (entry.userId !== interaction.user.id) {
    await interaction.reply({
      embeds: [errEmbed('❌ Non autorisé', 'Cette confirmation ne vous appartient pas.')],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  cleanup();
  const userId = interaction.user.id;
  const spam = failures.get(userId);
  if (spam && spam.count >= MAX_FAILURES) {
    await interaction.reply({
      embeds: [errEmbed('⏳ Trop de tentatives', 'Patientez quelques minutes avant de réessayer une action protégée.')],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  const field = name => {
    try { return String(interaction.fields.getTextInputValue(name) || '').trim(); }
    catch { return ''; }
  };
  const pinValue = field('pin');
  const codeValue = field('code');
  const recoveryValue = field('recovery');

  if (!pinValue && !codeValue && !recoveryValue) {
    await interaction.reply({
      embeds: [errEmbed('❌ Aucun code fourni', 'Saisissez votre PIN, votre code 2FA ou un code de secours.')],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  const profile = await getOrCreateProfile(userId);
  const factors = availableFactors(profile);
  let failure = null;

  // ── Code de secours d'abord : il doit rester utilisable même si le PIN est
  //    verrouillé (c'est précisément son rôle).
  if (recoveryValue && factors.recovery) {
    const passkey = await consumePasskey(profile, recoveryValue);
    if (passkey) {
      grantTrust(userId);
      failures.delete(userId);
      return run(interaction, entry);
    }
    failure = 'recovery';
  }

  if (codeValue && factors.totp) {
    const check = await consumeTotp(profile, codeValue);
    if (check.ok) {
      grantTrust(userId);
      failures.delete(userId);
      return run(interaction, entry);
    }
    failure = check.reason === 'replay' ? 'replay' : 'totp';
  }

  if (pinValue && factors.pin) {
    const check = await checkPin(profile, pinValue);
    if (check.locked) {
      failure = 'locked';
    } else if (check.ok) {
      grantTrust(userId);
      failures.delete(userId);
      return run(interaction, entry);
    } else if (!failure) {
      failure = 'pin';
    }
  }

  // Aucun facteur n'a validé : on compte l'échec et on explique.
  const now = Date.now();
  const current = failures.get(userId);
  const count = current && now - current.since < TRUST_TTL_MS ? current.count + 1 : 1;
  failures.set(userId, { count, since: current && now - current.since < TRUST_TTL_MS ? current.since : now });

  // Aucun moyen fourni n'a abouti : le message doit dire lequel a échoué.
  if (!failure) {
    if (recoveryValue) failure = 'recovery';
    else if (codeValue) failure = 'totp';
    else failure = 'pin';
  }

  const message = {
    locked: ['🔒 Compte verrouillé', 'Trop de tentatives échouées. Utilisez un code de secours ou réessayez plus tard. Action annulée.'],
    replay: ['❌ Code déjà utilisé', 'Ce code 2FA a déjà servi. Attendez le suivant dans votre application. Action annulée.'],
    totp: ['❌ Code 2FA incorrect', 'Le code saisi est invalide ou expiré. Action annulée.'],
    recovery: ['❌ Code de secours invalide', 'Ce code est inconnu, déjà utilisé ou expiré. Action annulée.'],
    pin: ['❌ PIN incorrect', 'Action annulée par sécurité.'],
  }[failure];

  await interaction.reply({ embeds: [errEmbed(...message)], ephemeral: true }).catch(() => {});
  return true;
}

// ── Boutons, menus et formulaires des panneaux ─────────────────────────────
// Un clic ne peut pas être rejoué après coup : on demande donc la preuve
// d'identité AVANT de laisser le gestionnaire du panneau s'exécuter. Le membre
// reclique ensuite : la session est ouverte, l'action part immédiatement.
function databaseReady() {
  try { return require('mongoose').connection?.readyState === 1; }
  catch { return false; }
}

/**
 * Vérifie qu'un composant (bouton, menu, modal) peut s'exécuter.
 *
 * @returns {Promise<boolean>} `true` si le gestionnaire doit continuer,
 *   `false` si l'interaction a été consommée par la demande d'authentification.
 */
async function authorizeComponent(interaction, { label = 'Action du panneau' } = {}) {
  // Base injoignable : les panneaux eux-mêmes ne peuvent rien lire ni écrire,
  // et bloquer ici rendrait le bot inutilisable. On rend la main au
  // gestionnaire, qui échouera ou fonctionnera comme avant cette protection.
  if (!databaseReady()) return true;

  const profile = await getOrCreateProfile(interaction.user.id).catch(() => null);
  if (!profile) return true; // profil illisible : même raison
  const factors = availableFactors(profile);

  if (!factors.pin && !factors.totp && !factors.recovery) return true; // rien à prouver
  if (isTrusted(interaction.user.id)) return true; // session de confiance

  cleanup();
  const token = crypto.randomBytes(8).toString('hex');
  pending.set(token, {
    userId: interaction.user.id,
    payload: {},
    label,
    executor: async submit => submit.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.success)
        .setTitle('✅ Identité confirmée')
        .setDescription('Votre session est ouverte pour **5 minutes**. Cliquez à nouveau sur le bouton : l’action sera appliquée immédiatement.')],
      ephemeral: true,
    }).catch(() => {}),
    expiresAt: Date.now() + PENDING_TTL_MS,
  });

  if (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit()) {
    // Un modal ne peut pas en ouvrir un autre : on passe par un bouton.
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.warning)
        .setTitle('🔐 Authentification requise')
        .setDescription('Ce formulaire agit sur la sécurité du serveur.\nConfirmez votre identité, puis rouvrez-le : vos changements seront appliqués.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`authgate_auth_${token}`)
          .setLabel('S’authentifier')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔐'),
      )],
      ephemeral: true,
    }).catch(() => {});
    return false;
  }

  try {
    await interaction.showModal(buildAuthModal(token, label, factors));
  } catch (err) {
    console.error('authGate authorizeComponent:', err?.message || err);
  }
  return false;
}

/**
 * Bouton « S’authentifier » affiché quand un formulaire protégé a été soumis
 * (un modal submit ne peut pas ouvrir un modal).
 */
async function handleAuthButton(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('authgate_auth_')) return false;

  const token = id.slice('authgate_auth_'.length);
  const entry = pending.get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    await interaction.reply({
      embeds: [errEmbed('❌ Session expirée', 'Rouvrez le panneau et réessayez.')],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }
  if (entry.userId !== interaction.user.id) {
    await interaction.reply({
      embeds: [errEmbed('❌ Non autorisé', 'Cette authentification ne vous appartient pas.')],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  const profile = await getOrCreateProfile(interaction.user.id).catch(() => null);
  const factors = profile ? availableFactors(profile) : { pin: true, totp: false, recovery: false };
  try {
    await interaction.showModal(buildAuthModal(token, entry.label || 'Confirmer', factors));
  } catch (err) {
    console.error('authGate handleAuthButton:', err?.message || err);
  }
  return true;
}

/**
 * Fait dialoguer deux interactions : la commande d'origine (qui porte les
 * `options`, `commandName`, `guild`, `member`…) et la soumission du modal (qui
 * porte les méthodes de réponse). Sans ce pont, une commande protégée devrait
 * être réécrite pour lire ses options depuis un cache.
 */
function bridgeInteraction(original, submit) {
  if (original === submit) return original;
  return new Proxy(submit, {
    get(target, prop) {
      if (prop in target) {
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const value = original?.[prop];
      return typeof value === 'function' ? value.bind(original) : value;
    },
    has: (target, prop) => prop in target || prop in original,
  });
}

/**
 * Protège une commande slash à risque, sans toucher à son code : le routeur
 * l'enveloppe, la preuve d'identité est demandée une fois, puis la commande
 * s'exécute réellement avec ses options d'origine.
 *
 * @param {ChatInputCommandInteraction} interaction
 * @param {Object} opts
 * @param {Object} opts.command - commande (module) à exécuter.
 * @param {Object} [opts.client] - client Discord transmis à execute().
 * @param {string} [opts.label] - libellé du modal.
 */
async function protectCommand(interaction, { command, client, label } = {}) {
  if (!command || typeof command.execute !== 'function') {
    throw new TypeError('authGate.protectCommand: command.execute requis');
  }
  if (!isProtectedCommand(interaction.commandName)) {
    return command.execute(interaction, client);
  }

  return protect(interaction, {
    label: label || `/${interaction.commandName}`,
    payload: { command, client, original: interaction },
    executor: (submit, payload) => payload.command.execute(bridgeInteraction(payload.original, submit), payload.client),
  });
}

/** Exécute l'action protégée et transforme une erreur en message lisible. */
async function run(interaction, entry) {
  try {
    await entry.executor(interaction, entry.payload);
  } catch (err) {
    console.error('❌ authGate executor:', err);
    const embed = errEmbed('❌ Erreur', 'L’action a échoué après confirmation de votre identité.');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [embed] }).catch(() => {});
    } else {
      await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    }
  }
  return true;
}

module.exports = {
  protect,
  protectCommand,
  authorizeComponent,
  handleAuthButton,
  buildAuthModal,
  bridgeInteraction,
  handleModal,
  isTrusted,
  grantTrust,
  clearTrust,
  availableFactors,
  isProtectedCommand,
  PROTECTED_COMMANDS,
  PENDING_TTL_MS,
  TRUST_TTL_MS,
};
