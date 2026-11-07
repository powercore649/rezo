'use strict';
// utils/tosGate.js — Acceptation obligatoire des conditions d'utilisation.
//
// Règle : tant qu'un membre n'a pas accepté la version courante des conditions
// (utils/tosDocument.js), **aucune commande ne s'exécute** pour son compte.
// Le garde est branché à deux endroits seulement, ce qui couvre tout le bot :
//   • events/core/interactionCreate.js — commandes slash + boutons du prompt ;
//   • utils/prefixCommands.js          — commandes texte (préfixe du serveur).
//
// Choix assumés :
//   • Aucune commande n'est exemptée — pas même /help. La sortie de secours est
//     l'invite elle-même : elle est renvoyée à chaque tentative de commande et
//     contient le bouton « Lire en entier » + « J'accepte ». Le bot est déjà à
//     100 commandes (limite Discord), donc pas de `/tos` dédiée.
//   • Une lecture en base ratée ne bloque pas le bot : si Mongo est injoignable,
//     le garde laisse passer (il n'y a de toute façon rien à vérifier ni à
//     faire), et l'erreur est signalée en console. Un refus systématique
//     rendrait le bot inutilisable pendant une panne de base.
//   • Le résultat est mis en cache 10 min (60 s pour un refus) : une commande
//     ordinaire ne coûte pas une requête en base.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { COLORS } = require('./embeds');
const doc = require('./tosDocument');

const ACCEPT_TTL = 10 * 60 * 1000; // acceptation en cache : 10 min
const MISS_TTL   = 60 * 1000;      // refus en cache : 1 min

const { createBoundedCache } = require('./boundedCache');
// BORNÉ : une entrée par utilisateur ; l'expiration est portée par `expiresAt`.
const cache = createBoundedCache({ max: 50_000, ttl: 0, name: 'tos' });
let storeOverride = null;
let warnedOffline = false;

// ── Magasin réel (Mongo) ─────────────────────────────────────────────────────
function databaseReady() {
  try { return require('mongoose').connection?.readyState === 1; }
  catch { return false; }
}

const defaultStore = {
  ready: () => databaseReady(),

  async findOne(userId, version) {
    const TosAcceptance = require('../models/TosAcceptance');
    return TosAcceptance.findOne({ userId: String(userId), version }).lean();
  },

  async accept({ userId, version, guildId = null, source = 'button' }) {
    const TosAcceptance = require('../models/TosAcceptance');
    const acceptedAt = new Date();
    return TosAcceptance.updateOne(
      { userId: String(userId) },
      {
        $set:  { version, acceptedAt, source, guildId },
        $push: { history: { $each: [{ version, acceptedAt, source }], $slice: -10 } },
      },
      { upsert: true },
    );
  },
};

function getStore() { return storeOverride || defaultStore; }

/** Remplace le magasin (tests uniquement). */
function setStore(store) {
  storeOverride = store || null;
  cache.clear();
  warnedOffline = false;
}

/** Vide les caches — acceptation, refus et avertissement de panne. */
function reset() {
  cache.clear();
  warnedOffline = false;
}

function warnOnce(reason) {
  if (warnedOffline) return;
  warnedOffline = true;
  console.warn(`[tosGate] base indisponible (${reason}) — vérification des CGU ignorée jusqu’au retour de Mongo.`);
}

// ── Vérification ─────────────────────────────────────────────────────────────
/**
 * Le membre a-t-il accepté la version courante ?
 *
 * @param {string} userId
 * @param {Object} [opts]
 * @param {Object} [opts.store] - magasin injecté (tests).
 * @returns {Promise<boolean>} `true` si la commande peut s'exécuter.
 */
async function isAccepted(userId, { store } = {}) {
  const id = String(userId || '');
  if (!id) return true; // aucun identifiant : rien à vérifier

  const now = Date.now();
  const hit = cache.get(id);
  if (hit && hit.version === doc.VERSION && hit.expiresAt > now) return hit.accepted;

  const db = store || getStore();
  if (typeof db.ready === 'function' && !db.ready()) { warnOnce('readyState'); return true; }

  let record;
  try {
    record = await db.findOne(id, doc.VERSION);
  } catch (err) {
    warnOnce(err?.message || 'lecture impossible');
    return true;
  }

  const accepted = Boolean(record);
  cache.set(id, {
    accepted,
    version: doc.VERSION,
    expiresAt: now + (accepted ? ACCEPT_TTL : MISS_TTL),
  });
  return accepted;
}

/** Enregistre l'acceptation et ouvre immédiatement le cache. */
async function accept(userId, { source = 'button', guildId = null, store } = {}) {
  const id = String(userId || '');
  if (!id) throw new Error('tosGate.accept: userId requis');
  const db = store || getStore();
  await db.accept({ userId: id, version: doc.VERSION, guildId, source });
  cache.set(id, { accepted: true, version: doc.VERSION, expiresAt: Date.now() + ACCEPT_TTL });
  return true;
}

// ── Rendu ────────────────────────────────────────────────────────────────────
/** Embed résumé affiché avant acceptation. */
function buildSummaryEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(doc.TITLE)
    .setDescription([
      `**Version ${doc.VERSION}**`,
      '',
      doc.INTRO,
      '',
      ...doc.SUMMARY,
      '',
      '👉 Cliquez sur **J’accepte** pour débloquer les commandes, ou sur **Lire en entier** pour le texte complet.',
    ].join('\n'))
    .setFooter({ text: 'REZO • Acceptation obligatoire avant toute commande' });
}

/** Embed complet (les 7 sections) — affiché par « Lire en entier ». */
function buildFullEmbed({ acceptedAt = null } = {}) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(doc.TITLE)
    .setDescription([
      `**Version ${doc.VERSION}**`,
      '',
      doc.INTRO,
      '',
      acceptedAt
        ? `✅ Vous avez accepté cette version le **${new Date(acceptedAt).toLocaleString('fr-FR')}**.`
        : '⚠️ Vous n’avez pas encore accepté cette version : les commandes du bot restent bloquées.',
    ].join('\n'))
    .addFields(doc.SECTIONS.map(s => ({ name: s.title, value: s.body, inline: false })))
    .setFooter({ text: 'REZO • Conditions d’utilisation' });
  return embed;
}

/** Ligne de boutons du prompt. */
function promptRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tos_accept').setLabel('J’accepte').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('tos_read').setLabel('Lire en entier').setStyle(ButtonStyle.Secondary).setEmoji('📖'),
    new ButtonBuilder().setCustomId('tos_decline').setLabel('Je refuse').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
  );
}

/** Ligne réduite (texte complet déjà affiché) : il ne reste qu'à accepter. */
function acceptRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tos_accept').setLabel('J’accepte').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('tos_decline').setLabel('Je refuse').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
  );
}

function promptPayload() {
  return { embeds: [buildSummaryEmbed()], components: [promptRow()] };
}

// ── Points d'entrée ──────────────────────────────────────────────────────────
/**
 * Garde des commandes slash. Répond l'invite d'acceptation et renvoie `false`
 * quand la commande doit être bloquée.
 *
 * @returns {Promise<boolean>} `true` si la commande peut s'exécuter.
 */
async function ensureAccepted(interaction, { store } = {}) {
  if (!interaction?.user?.id) return true;

  const allowed = await isAccepted(interaction.user.id, { store });
  if (allowed) return true;

  // Déjà répondu (cas limite) : on ne peut pas afficher l'invite, mais on
  // bloque quand même — c'est la règle, pas un effet de bord.
  if (interaction.deferred || interaction.replied) return false;

  await interaction.reply({ ...promptPayload(), ephemeral: true }).catch(() => {});
  return false;
}

/**
 * Garde des commandes texte (préfixe). Les messages ne peuvent pas répondre en
 * éphémère : l'invite est postée dans le salon, sans mentionner l'auteur.
 *
 * @returns {Promise<boolean>} `true` si la commande peut s'exécuter.
 */
async function ensurePrefixAccepted(message, { store } = {}) {
  if (!message?.author?.id) return true;

  const allowed = await isAccepted(message.author.id, { store });
  if (allowed) return true;

  await message.reply({ ...promptPayload(), allowedMentions: { repliedUser: false } }).catch(() => {});
  return false;
}

/**
 * Boutons du prompt — à router depuis interactionCreate avant tout autre
 * gestionnaire. Renvoie `true` si l'interaction a été prise en charge.
 */
async function handleButton(interaction, { store } = {}) {
  const id = interaction?.customId;
  if (!id || !id.startsWith('tos_')) return false;

  const userId = interaction.user?.id;
  const guildId = interaction.guildId || interaction.guild?.id || null;

  if (id === 'tos_read') {
    await interaction.reply({ embeds: [buildFullEmbed()], components: [acceptRow()], ephemeral: true }).catch(() => {});
    return true;
  }

  if (id === 'tos_decline') {
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle('❌ Conditions refusées')
        .setDescription([
          'Sans acceptation, **aucune commande de REZO ne s’exécutera pour votre compte**.',
          '',
          'Rien n’est supprimé sur le serveur et votre refus n’est pas enregistré.',
          'Vous pouvez changer d’avis à tout moment avec `/tos` ou en relançant une commande.',
        ].join('\n'))
        .setFooter({ text: 'REZO • Conditions d’utilisation' })],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  if (id === 'tos_accept') {
    try {
      await accept(userId, { source: guildId ? 'command' : 'dm', guildId, store });
    } catch (err) {
      console.error('[tosGate] enregistrement de l’acceptation:', err?.message || err);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle('❌ Acceptation non enregistrée')
          .setDescription('La base de données n’a pas confirmé l’enregistrement.\nRéessayez dans quelques instants, puis relancez votre commande.')
          .setFooter({ text: 'REZO • Conditions d’utilisation' })],
        ephemeral: true,
      }).catch(() => {});
      return true;
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('✅ Conditions acceptées')
        .setDescription([
          `Version **${doc.VERSION}** acceptée. Vous pouvez maintenant utiliser les commandes de REZO.`,
          '',
          'Relancez la commande que vous vouliez exécuter. Cette acceptation vaut pour tous les serveurs du bot.',
        ].join('\n'))
        .setFooter({ text: 'REZO • Conditions d’utilisation' })],
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  return false;
}

module.exports = {
  VERSION: doc.VERSION,
  ACCEPT_TTL,
  MISS_TTL,
  isAccepted,
  accept,
  ensureAccepted,
  ensurePrefixAccepted,
  handleButton,
  buildSummaryEmbed,
  buildFullEmbed,
  promptRow,
  acceptRow,
  promptPayload,
  setStore,
  reset,
  __testables: { cache, databaseReady, defaultStore },
};
