'use strict';
// utils/quoteNotifier.js — Devis Pack REZO.net : du site au MP du propriétaire.
//
// Le site n'a pas de client Discord : il écrit la demande en base. Ce module
// la relève toutes les minutes, l'envoie en message privé à l'owner, puis
// exécute sa décision :
//   ✅ Approuver → clé émise (sièges = serveurs demandés, durée = durée
//                    demandée) et envoyée en MP à l'acheteur ;
//   ⛔ Refuser    → demande close, aucune clé.
//
// Rien n'est émis avant le clic, et un clic ne peut produire qu'une clé
// (`quoteStore.approveRequest` revendique la demande atomiquement).

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const QuoteRequest = require('../models/QuoteRequest');
const quoteStore = require('./quoteStore');
const licenseGate = require('./licenseGate');
const { COLORS } = require('./embeds');

const CHECK_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 3_000;
const MAX_NOTIFY_ATTEMPTS = 10;

let started = false;
let running = false;

function owners() {
  return licenseGate.getOwnerIds();
}

function ts(date) {
  if (!date) return '—';
  const ms = new Date(date).getTime();
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:f>` : '—';
}

function val(text, fallback = '*non renseigné*') {
  const s = String(text ?? '').trim();
  return s || fallback;
}

function clip(text, max = 1024) {
  const s = String(text ?? '').trim();
  if (!s) return '*non renseigné*';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── Carte envoyée à l'owner ──────────────────────────────────────────────────
function buildQuoteEmbed(quote, { state = null } = {}) {
  const color = state === 'approved' ? COLORS.success
    : state === 'rejected' ? COLORS.error
      : COLORS.warning;
  const title = state === 'approved' ? '✅ Devis approuvé — clé émise'
    : state === 'rejected' ? '⛔ Devis refusé'
      : '📝 Nouvelle demande de devis — Pack REZO.net';

  const demandeur = [
    `**${val(quote.name)}**`,
    quote.discordTag || quote.discord ? `Pseudo : ${val(quote.discordTag || quote.discord)}` : null,
    quote.discordId ? `MP : <@${quote.discordId}> (\`${quote.discordId}\`)` : null,
    quote.email ? `E-mail : ${val(quote.email)}` : null,
  ].filter(Boolean).join('\n');

  const seats = quote.seats || quoteStore.seatsFor(quote.servers);
  const days = quote.days || quoteStore.daysFor(quote.duration);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`Demande de **${val(quote.name)}** — reçue ${ts(quote.createdAt)}.`)
    .addFields(
      { name: '👤 Demandeur', value: demandeur, inline: false },
      { name: '🏠 Serveur principal', value: `**${val(quote.guildName)}**\n\`${val(quote.guildId)}\``, inline: true },
      { name: '🌐 Réseau', value: `**${val(quote.servers)}** serveur(s)\n**${val(quote.members)}** membres`, inline: true },
      { name: '⏳ Durée demandée', value: `**${val(quote.duration)}** → ${days} jours`, inline: true },
      { name: '📅 Mise en service', value: val(quote.startDate), inline: true },
      { name: '💰 Budget', value: val(quote.budget), inline: true },
      { name: '🔑 Clé si tu approuves', value: `**${seats}** siège(s), **${days}** jours`, inline: true },
      { name: '🧩 Modules prioritaires', value: clip(quote.modules), inline: false },
      { name: '💬 Contexte', value: clip(quote.message), inline: false },
    )
    .setFooter({ text: `Devis ${String(quote._id || '').slice(-8)} • approuver émet la clé et l’envoie en MP à l’acheteur` })
    .setTimestamp(new Date());
}

function buildQuoteRows(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`quote_ok_${id}`)
      .setLabel('Approuver et envoyer la clé')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`quote_no_${id}`)
      .setLabel('Refuser')
      .setEmoji('⛔')
      .setStyle(ButtonStyle.Danger),
  )];
}

// ── Transmission à l'owner ───────────────────────────────────────────────────
/**
 * Envoie les demandes en attente en MP à chaque owner.
 * Une demande n'est marquée transmise que si au moins un MP est parti ;
 * sinon elle est retentée (bornée par `MAX_NOTIFY_ATTEMPTS`), pour ne jamais
 * la perdre silencieusement si les MP de l'owner sont fermés.
 */
async function notifyOwners(client) {
  const pending = await quoteStore.pendingToNotify({ maxAttempts: MAX_NOTIFY_ATTEMPTS });
  if (!pending.length) return 0;

  const ids = owners();
  if (!ids.length) {
    console.warn('devis : OWNER_IDS absent du .env — aucune demande ne peut être transmise.');
    return 0;
  }

  let delivered = 0;
  for (const quote of pending) {
    const sent = [];
    for (const ownerId of ids) {
      const user = await client.users.fetch(ownerId).catch(() => null);
      if (!user) continue;
      const msg = await user
        .send({ embeds: [buildQuoteEmbed(quote)], components: buildQuoteRows(quote._id) })
        .catch(() => null);
      if (msg) sent.push({ userId: ownerId, messageId: msg.id });
    }

    if (sent.length) {
      delivered++;
      await quoteStore.markNotified(quote._id, sent);
    } else {
      await quoteStore.countNotifyAttempt(quote._id);
      console.warn(`devis ${String(quote._id).slice(-8)} : aucun MP délivré (MP fermés ?) — nouvelle tentative plus tard.`);
    }
  }
  return delivered;
}

// ── Livraison de la clé à l'acheteur ─────────────────────────────────────────
async function sendKeyToBuyer(client, quote) {
  const userId = String(quote.discordId || '').trim();
  if (!/^\d{17,20}$/.test(userId)) return { ok: false, error: 'ID Discord de l’acheteur invalide' };

  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return { ok: false, error: 'compte Discord introuvable' };

  const seats = quote.seats || quoteStore.seatsFor(quote.servers);
  const days = quote.days || quoteStore.daysFor(quote.duration);
  const expires = new Date(Date.now() + days * 86_400_000);

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('🔑 Ta licence REZO — Pack REZO.net')
    .setDescription(`Bonjour **${val(quote.name, 'à toi')}**,\n\nTon devis est accepté. Voici ta clé de licence :\n\n\`${quote.key}\``)
    .addFields(
      { name: '🏷️ Licence', value: `Réseau — **${seats}** serveur(s)`, inline: true },
      { name: '⏳ Validité', value: `${days} jours\njusqu’au ${expires.toLocaleDateString('fr-FR')}`, inline: true },
      {
        name: '🚀 Activation',
        value: 'Sur chaque serveur : `/license` → **🔑 Activer une clé** → colle la clé.\nRéservé aux administrateurs du serveur.',
        inline: false,
      },
    )
    .setFooter({ text: 'REZO • garde ce message : la clé n’est pas réaffichée ailleurs' })
    .setTimestamp(new Date());

  const msg = await user.send({ embeds: [embed] }).catch(() => null);
  if (!msg) return { ok: false, error: 'MP fermés côté acheteur' };
  return { ok: true };
}

// ── Clic sur Approuver / Refuser ─────────────────────────────────────────────
async function handleQuoteButton(interaction, client) {
  const id = String(interaction.customId || '');
  if (!id.startsWith('quote_ok_') && !id.startsWith('quote_no_')) return;

  if (!licenseGate.isOwner(interaction.user.id)) {
    return interaction.reply({
      content: '⛔ Seul le propriétaire du bot peut traiter les demandes de devis.',
      ephemeral: true,
    }).catch(() => {});
  }

  const approve = id.startsWith('quote_ok_');
  const quoteId = id.replace(/^quote_(?:ok|no)_/, '');
  const quote = await quoteStore.findById(quoteId);
  if (!quote) {
    return interaction.reply({ content: 'Demande introuvable ou supprimée.', ephemeral: true }).catch(() => {});
  }

  if (quote.status !== 'pending') {
    return interaction.update({
      embeds: [buildQuoteEmbed(quote, { state: quote.status === 'approved' ? 'approved' : 'rejected' })],
      components: [],
    }).catch(() => {});
  }

  await interaction.deferUpdate().catch(() => {});

  // ── Refus ──
  if (!approve) {
    const refused = await quoteStore.rejectRequest({ id: quoteId, ownerId: interaction.user.id });
    if (!refused.ok) {
      return interaction.editReply({
        content: `⚠️ Refus impossible : ${refused.error}.`,
        embeds: [buildQuoteEmbed(quote)],
        components: buildQuoteRows(quoteId),
      }).catch(() => {});
    }
    return interaction.editReply({
      embeds: [buildQuoteEmbed({ ...quote, ...refused.quote }, { state: 'rejected' })],
      components: [],
    }).catch(() => {});
  }

  // ── Approbation : clé émise puis envoyée en MP ──
  const approved = await quoteStore.approveRequest({ id: quoteId, ownerId: interaction.user.id });
  if (!approved.ok) {
    return interaction.editReply({
      content: `⚠️ Approbation impossible : ${approved.error}. La demande reste en attente.`,
      embeds: [buildQuoteEmbed(quote)],
      components: buildQuoteRows(quoteId),
    }).catch(() => {});
  }

  const delivery = await sendKeyToBuyer(client, approved.quote).catch(err => ({ ok: false, error: err?.message }));
  await quoteStore.markKeyDelivered(quoteId, { ok: delivery.ok, error: delivery.error });

  const embed = buildQuoteEmbed({ ...quote, ...approved.quote }, { state: 'approved' });
  if (!delivery.ok) {
    // La clé existe : on la montre à l'owner pour qu'il la transmette lui-même
    // plutôt que de laisser l'acheteur sans réponse.
    embed.addFields({
      name: '⚠️ Clé non délivrée en MP',
      value: `Raison : ${val(delivery.error, 'inconnue')}\nClé à transmettre manuellement : \`${approved.key}\``
        + (quote.email ? `\nE-mail du client : ${val(quote.email)}` : ''),
      inline: false,
    });
  }

  return interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
}

// ── Démarrage (une seule fois, shard principal) ───────────────────────────────
function startQuoteNotifier(client, { intervalMs = CHECK_INTERVAL_MS } = {}) {
  if (started) return { started: false };
  started = true;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const count = await notifyOwners(client);
      if (count) console.log(`📝 ${count} demande(s) de devis transmise(s) en MP à l’owner.`);
    } catch (err) {
      console.error('devis :', err.message);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
  setInterval(tick, intervalMs).unref?.();
  return { started: true };
}

module.exports = {
  CHECK_INTERVAL_MS,
  MAX_NOTIFY_ATTEMPTS,
  buildQuoteEmbed,
  buildQuoteRows,
  notifyOwners,
  sendKeyToBuyer,
  handleQuoteButton,
  startQuoteNotifier,
};
