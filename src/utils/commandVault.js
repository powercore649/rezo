'use strict';
// utils/commandVault.js — Orchestration Discord du coffre d'accès.
//
// Utilisé par les commandes sensibles : on évalue le droit d'ouvrir, puis, si un
// code est exigé, on le demande dans une modale. Une fois validé, une session de
// 10 minutes évite de redemander le code à chaque clic du panneau.
//
// Aucun rapport avec les licences : c'est une protection locale au serveur.
// Tout est best-effort — une erreur d'accès refuse l'ouverture, jamais l'inverse.

const {
  ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder,
} = require('discord.js');
const CommandVault = require('../models/CommandVault');
const { createBoundedCache } = require('./boundedCache');
const { COLORS } = require('./embeds');
const engine = require('./commandVaultEngine');

// Sessions déverrouillées : bornées, expirées, jamais persistées (un redémarrage
// redemande le code, ce qui est le comportement attendu d'un coffre).
const sessions = createBoundedCache({ max: 10_000, ttl: engine.SESSION_MS, name: 'command-vault-sessions' });

const SESSION_KEY = (guildId, userId) => `${guildId}:${userId}`;

// ─── État ────────────────────────────────────────────────────────────────────
async function getVault(guildId) {
  return CommandVault.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true },
  );
}

function openSession(guildId, userId) {
  sessions.set(SESSION_KEY(guildId, userId), Date.now());
}

function hasSession(guildId, userId) {
  return Boolean(sessions.get(SESSION_KEY(guildId, userId)));
}

function closeSession(guildId, userId) {
  sessions.delete(SESSION_KEY(guildId, userId));
}

/**
 * Le membre peut-il ouvrir le panneau ?
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<{vault:object, decision:object}>}
 */
async function evaluateAccess(guild, member) {
  const vault = await getVault(guild.id);
  if (!vault.enabled) return { vault, decision: { allowed: true, reason: 'disabled', needsCode: false } };
  if (!member) return { vault, decision: { allowed: false, reason: 'denied', needsCode: false } };
  if (hasSession(guild.id, member.id)) return { vault, decision: { allowed: true, reason: 'session', needsCode: false } };

  const failure = (vault.failures || []).find(entry => entry.userId === member.id);
  const roleIds = [...(member.roles?.cache?.keys?.() || [])];

  const decision = engine.decideAccess({
    userId: member.id,
    guildOwnerId: guild.ownerId,
    roleIds,
    authorizedUsers: vault.authorizedUsers || [],
    authorizedRoles: vault.authorizedRoles || [],
    hasCode: Boolean(vault.codeHash && vault.codeSalt),
    lockedUntil: failure?.lockedUntil || 0,
  });
  return { vault, decision };
}

// ─── Code ────────────────────────────────────────────────────────────────────
function codeModal() {
  return new ModalBuilder()
    .setCustomId('vault_code_modal')
    .setTitle('🔐 Code d’accès')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('code')
          .setLabel('Code d’accès du serveur')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(engine.MIN_CODE_LENGTH)
          .setMaxLength(engine.MAX_CODE_LENGTH),
      ),
    );
}

async function recordFailure(vault, userId) {
  const list = vault.failures || [];
  const index = list.findIndex(entry => entry.userId === userId);
  const entry = engine.registerFailure(index >= 0 ? list[index] : { userId });
  if (index >= 0) list[index] = entry;
  else list.push(entry);
  while (list.length > engine.MAX_FAILURES) list.shift();

  vault.stats = vault.stats || {};
  vault.stats.denied = (vault.stats.denied || 0) + 1;
  vault.stats.lastAt = new Date();
  await vault.save().catch(() => {});
  return entry;
}

async function alertDenial(guild, { userId, reason, locked }) {
  try {
    const { sendModLog } = require('../commands/moderation/modlog');
    await sendModLog(guild.client, guild.id, new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle(locked ? '🔒 Coffre d’accès — verrouillé' : '🔐 Coffre d’accès — code incorrect')
      .setDescription(
        `<@${userId}> ${locked ? 'a dépassé ses tentatives sur' : 'a saisi un code incorrect sur'} `
        + 'un panneau protégé.\n'
        + (locked ? `Accès bloqué **${Math.round(engine.LOCK_MS / 60_000)} minutes**.` : 'Le code d’accès n’a pas été communiqué.'),
      )
      .setTimestamp());
  } catch (_) { /* pas de salon de logs : l'événement reste dans le modèle */ }
}

/**
 * Demande le code dans une modale et le vérifie.
 * @returns {Promise<{ok:boolean, interaction:object|null, replied:boolean}>}
 *   ok        — code correct, `interaction` est la soumission à utiliser pour répondre ;
 *   replied   — une réponse a déjà été envoyée (ne pas répondre une seconde fois).
 */
async function promptCode(interaction, vault, { label = 'ce panneau' } = {}) {
  const guild = interaction.guild;
  try {
    await interaction.showModal(codeModal());
  } catch (_) {
    return { ok: false, interaction: null, replied: false };
  }

  const submitted = await interaction.awaitModalSubmit({
    time: 90_000,
    filter: s => s.user.id === interaction.user.id && s.customId === 'vault_code_modal',
  }).catch(() => null);
  if (!submitted) return { ok: false, interaction: null, replied: false };

  const code = submitted.fields.getTextInputValue('code');
  if (engine.verifyCode(code, { salt: vault.codeSalt, hash: vault.codeHash })) {
    openSession(guild.id, interaction.user.id);
    vault.stats = vault.stats || {};
    vault.stats.opens = (vault.stats.opens || 0) + 1;
    vault.stats.lastAt = new Date();
    await vault.save().catch(() => {});
    return { ok: true, interaction: submitted, replied: false };
  }

  const entry = await recordFailure(vault, interaction.user.id);
  const locked = engine.remainingLockMs(entry.lockedUntil) > 0;
  const remaining = engine.remainingAttempts(entry.count);
  const content = locked
    ? `⛔ Code incorrect — **${label}** est verrouillé pendant ${Math.round(engine.LOCK_MS / 60_000)} min.`
    : `❌ Code incorrect. ${remaining} tentative(s) restante(s) avant un verrouillage de ${Math.round(engine.LOCK_MS / 60_000)} min.`;

  await submitted.reply({ content, ephemeral: true }).catch(() => {});
  await alertDenial(guild, { userId: interaction.user.id, reason: 'code-required', locked });
  return { ok: false, interaction: submitted, replied: true };
}

/**
 * Vérifie et déverrouille une commande protégée.
 * @param {object} interaction interaction slash
 * @param {{label?:string}} [options]
 * @returns {Promise<{allowed:boolean, replyTo:object|null, reason:string}>}
 *   `replyTo` est l'interaction à utiliser pour envoyer la réponse (la slash,
 *   ou la soumission de modale quand un code vient d'être validé).
 */
async function guardCommand(interaction, { label = 'ce panneau' } = {}) {
  const guild = interaction.guild;
  if (!guild) return { allowed: false, replyTo: null, reason: 'denied' };

  const { vault, decision } = await evaluateAccess(guild, interaction.member);
  if (decision.allowed) return { allowed: true, replyTo: interaction, reason: decision.reason };

  if (decision.needsCode) {
    const attempt = await promptCode(interaction, vault, { label });
    if (attempt.ok) return { allowed: true, replyTo: attempt.interaction, reason: 'code' };
    // Un code incorrect a déjà reçu sa réponse (tentatives restantes ou
    // verrouillage) : le panneau reste fermé, sans second message.
    return { allowed: false, replyTo: null, reason: 'code' };
  }

  await interaction.reply({ content: engine.describeDenial(decision), ephemeral: true }).catch(() => {});
  return { allowed: false, replyTo: null, reason: decision.reason };
}

module.exports = {
  getVault,
  openSession,
  hasSession,
  closeSession,
  evaluateAccess,
  promptCode,
  guardCommand,
  recordFailure,
  sessions,
};
