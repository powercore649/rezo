'use strict';
// core/errors.js — Hiérarchie d'erreurs du noyau v2 + réponse d'erreur uniforme.
//
// Objectif : un commandement v2 ne lève jamais une erreur brute à l'utilisateur.
//   • BotError            — erreur typée avec code machine + message utilisateur optionnel
//   • UserFacingError     — erreur dont le message PEUT être montré à l'utilisateur
//   • PermissionError / LicenseError / ValidationError / NotFoundError — variantes
// handleInteractionError() répond proprement, quel que soit l'état de l'interaction
// (jamais répondu / deferred / déjà répondu), et journalise toujours la cause.

const { errorEmbed } = require('../utils/embeds');

const GENERIC_MESSAGE = 'Une erreur est survenue. Réessaie dans quelques instants.';

class BotError extends Error {
  constructor(message, { code = 'BOT_ERROR', userMessage = null, expose = false, cause = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.userMessage = userMessage;
    this.expose = expose; // expose=true → message sûr à montrer
    if (cause) this.cause = cause;
  }
}

class UserFacingError extends BotError {
  constructor(message, opts = {}) { super(message, { code: 'USER', expose: true, ...opts }); }
}
class ValidationError extends UserFacingError { constructor(m, o = {}) { super(m, { code: 'VALIDATION', ...o }); } }
class PermissionError extends UserFacingError { constructor(m, o = {}) { super(m, { code: 'PERMISSION', ...o }); } }
class LicenseError   extends UserFacingError { constructor(m, o = {}) { super(m, { code: 'LICENSE', ...o }); } }
class NotFoundError  extends UserFacingError { constructor(m, o = {}) { super(m, { code: 'NOT_FOUND', ...o }); } }

// Message affichable pour une erreur quelconque (jamais de fuite technique).
function toUserMessage(err) {
  if (err instanceof BotError && err.expose) return err.userMessage || err.message || GENERIC_MESSAGE;
  return GENERIC_MESSAGE;
}

// Répond à une interaction en erreur sans jamais relancer d'exception.
async function handleInteractionError(interaction, err, { logger = null } = {}) {
  const label = interaction?.commandName || interaction?.customId || 'inconnu';
  if (logger?.error) logger.error(`interaction ${label} : ${err?.message}`);
  else console.error(`[interaction ${label}]`, err);

  if (!interaction || typeof interaction.reply !== 'function') return;

  const embed = errorEmbed('Une erreur est survenue', toUserMessage(err));
  try {
    if (interaction.deferred && !interaction.replied) await interaction.editReply({ embeds: [embed] });
    else if (interaction.replied) await interaction.followUp({ embeds: [embed], ephemeral: true });
    else await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch { /* dernier recours : on n'a plus rien à faire */ }
}

module.exports = {
  BotError,
  UserFacingError,
  ValidationError,
  PermissionError,
  LicenseError,
  NotFoundError,
  GENERIC_MESSAGE,
  toUserMessage,
  handleInteractionError,
};
