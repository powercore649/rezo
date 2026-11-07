'use strict';
// utils/quoteStore.js — Cycle de vie d'une demande de devis.
//
// Séparation stricte des rôles :
//   • le site crée la demande (`createRequest`) ;
//   • le bot la relève (`pendingToNotify`) puis la clôt (`approveRequest` /
//     `rejectRequest`) après le clic du propriétaire.
//
// Deux garanties :
//   1. aucune clé n'existe avant `approveRequest` ;
//   2. l'approbation revendique la demande en une écriture atomique
//      (`status: 'pending'` → `'approved'`), donc deux clics simultanés
//      n'émettent qu'une seule clé. Si l'émission échoue, la demande repasse
//      en attente au lieu d'être perdue.

const QuoteRequest = require('../models/QuoteRequest');
const { issueKey } = require('./licenseIssuer');
const { daysFor, seatsFor } = require('./quoteRequest');

const QUOTE_PLAN = 'pack-rezo-net';

/**
 * Enregistre une demande validée (voir `quoteRequest.validateQuote`).
 * @returns {Promise<{ok:true, quote:object}|{ok:false, error:string}>}
 */
async function createRequest(values = {}, { now = new Date() } = {}) {
  try {
    const quote = await QuoteRequest.create({
      token: QuoteRequest.newToken(),
      plan: QUOTE_PLAN,
      name: values.name || '',
      email: values.email || '',
      discord: values.discord || '',
      discordId: values.discordId || '',
      guildId: values.guildId || '',
      guildName: values.guildName || '',
      servers: seatsFor(values.servers),
      members: Number(values.members) || 0,
      duration: values.duration || '',
      startDate: values.startDate || '',
      budget: values.budget || '',
      modules: values.modules || '',
      message: values.message || '',
      consent: Boolean(values.consent),
      status: 'pending',
      createdAt: now,
    });
    return { ok: true, quote };
  } catch (err) {
    return { ok: false, error: err?.message || 'enregistrement impossible' };
  }
}

/** Demandes en attente qui n'ont pas encore été transmises à l'owner. */
async function pendingToNotify({ limit = 10, maxAttempts = 10 } = {}) {
  const rows = await QuoteRequest.find({
    status: 'pending',
    notifiedAt: null,
    notifyAttempts: { $lt: maxAttempts },
  })
    .sort({ createdAt: 1 })
    .limit(Math.min(Math.max(Number(limit) || 10, 1), 25))
    .lean()
    .catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function findById(id) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) return null;
  return QuoteRequest.findById(id).lean().catch(() => null);
}

/** Marque la demande comme transmise (un ou plusieurs MP partis). */
async function markNotified(id, messages = [], { now = new Date() } = {}) {
  await QuoteRequest.updateOne(
    { _id: id },
    { $set: { notifiedAt: now, ownerMessages: messages } },
  ).catch(() => {});
}

/** Comptabilise une tentative sans MP délivré (owner injoignable). */
async function countNotifyAttempt(id) {
  await QuoteRequest.updateOne({ _id: id }, { $inc: { notifyAttempts: 1 } }).catch(() => {});
}

/**
 * Approuve la demande : réserve la décision, puis émet la clé.
 * `seats` et `days` viennent de la demande, mais restent bornés.
 *
 * @returns {Promise<{ok:true, key:string, quote:object}|{ok:false, error:string}>}
 */
async function approveRequest({ id, ownerId, seats = null, days = null, now = new Date() } = {}) {
  const quote = await findById(id);
  if (!quote) return { ok: false, error: 'demande introuvable' };
  if (quote.status !== 'pending') return { ok: false, error: 'demande déjà traitée' };

  const grantedSeats = Math.max(1, Math.min(25, Number(seats) || seatsFor(quote.servers)));
  const grantedDays = Math.max(1, Math.min(1095, Number(days) || daysFor(quote.duration)));

  const claimed = await QuoteRequest.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'approved', decidedAt: now, decidedBy: ownerId, seats: grantedSeats, days: grantedDays } },
    { new: true },
  ).lean().catch(() => null);

  if (!claimed) return { ok: false, error: 'demande déjà traitée' };

  const issued = await issueKey({
    planId: claimed.plan || QUOTE_PLAN,
    createdBy: ownerId,
    expiresAt: new Date(now.getTime() + grantedDays * 86_400_000),
    maxGuilds: grantedSeats,
    note: `devis:${String(claimed._id).slice(-8)}`,
    allowQuote: true,
    now,
  }).catch(err => ({ ok: false, error: err?.message || 'émission impossible' }));

  if (!issued.ok) {
    // Une approbation sans clé serait un mensonge au client : on remet la
    // demande en attente pour qu'un nouvel essai aboutisse.
    await QuoteRequest.updateOne(
      { _id: id, status: 'approved' },
      { $set: { status: 'pending', decidedAt: null, decidedBy: null, seats: null, days: null } },
    ).catch(() => {});
    return { ok: false, error: issued.error || 'émission impossible' };
  }

  await QuoteRequest.updateOne({ _id: id }, { $set: { key: issued.key } }).catch(() => {});
  return {
    ok: true,
    key: issued.key,
    quote: { ...claimed, key: issued.key, seats: grantedSeats, days: grantedDays, status: 'approved' },
  };
}

/** Refuse la demande : aucune clé n'est créée. */
async function rejectRequest({ id, ownerId, now = new Date() } = {}) {
  const res = await QuoteRequest.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status: 'rejected', decidedAt: now, decidedBy: ownerId } },
    { new: true },
  ).lean().catch(() => null);
  return res ? { ok: true, quote: res } : { ok: false, error: 'demande déjà traitée' };
}

/** Trace du dernier envoi de la clé à l'acheteur. */
async function markKeyDelivered(id, { ok, error = null, now = new Date() } = {}) {
  await QuoteRequest.updateOne(
    { _id: id },
    { $set: ok ? { keySentAt: now, keyError: null } : { keyError: String(error || 'envoi impossible').slice(0, 200) } },
  ).catch(() => {});
}

/** Dernières demandes, pour un éventuel suivi côté owner. */
async function listRecent({ limit = 20 } = {}) {
  const rows = await QuoteRequest.find({})
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 20, 1), 50))
    .lean()
    .catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  QUOTE_PLAN,
  createRequest,
  pendingToNotify,
  findById,
  markNotified,
  countNotifyAttempt,
  approveRequest,
  rejectRequest,
  markKeyDelivered,
  listRecent,
  daysFor,
  seatsFor,
};
