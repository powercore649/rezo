'use strict';
// utils/economy.js — Le portefeuille virtuel : une seule porte pour faire
// bouger des pièces.
//
// Pourquoi ce module existe : `/balance` (paiement entre membres) et `/give`
// (cadeau) doivent appliquer EXACTEMENT les mêmes règles — mêmes plafonds,
// mêmes refus, même journal. Dupliquées, ces règles finissent toujours par
// diverger : l'une accepte un montant négatif, l'autre crédite sans débiter.
//
// Le débit est atomique : la condition `coins >= montant` est évaluée par
// MongoDB dans la même opération que le `$inc`. Deux paiements simultanés ne
// peuvent donc pas faire passer un solde sous zéro (pas de lecture puis
// écriture). Si le crédit du destinataire échoue, le débit est remboursé.
//
// Testable hors ligne : `transferCoins({ models })` accepte des modèles
// factices (même convention que utils/dbMaintenance.js).

const DEFAULTS = {
  Balance: require('../models/Balance'),
  Transaction: require('../models/Transaction'),
};

const MIN_TRANSFER = 1;
const MAX_TRANSFER = 1_000_000;
const HISTORY_LIMIT = 10;
const MAX_REASON = 140;

// Compte fictif des mouvements sans destinataire humain (achats, remboursements).
const SYSTEM_ID = 'SYSTEM';

const ALL_WORDS = new Set(['all', 'tout', 'max']);

/**
 * Lit un montant saisi par un humain.
 * Accepte « 250 », « 1 000 », « 1_000 », « 250 pièces », « 250 coins »,
 * « tout » (= solde entier) ; renvoie `null` si ce n'est pas un montant.
 * @returns {number|'all'|null}
 */
function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    .trim()
    .toLowerCase()
    // On n'enlève PAS la virgule : en français « 1,5 » est un décimal, pas 15.
    .replace(/[\s\u00a0\u202f_'’]/g, '')
    .replace(/🪙/g, '')
    .replace(/pi[eè]ces?$/, '')
    .replace(/coins?$/, '');

  if (!cleaned) return null;
  if (ALL_WORDS.has(cleaned)) return 'all';
  if (!/^\d{1,12}$/.test(cleaned)) return null;

  const amount = Number(cleaned);
  return Number.isSafeInteger(amount) ? amount : null;
}

/**
 * Règles d'un virement, sans aucune I/O.
 * @returns {{ok: true}|{ok: false, code: string, error: string}}
 */
function validateTransfer({ fromId, toId, amount, targetIsBot = false, sourceIsBot = false } = {}) {
  if (!Number.isSafeInteger(amount)) {
    return { ok: false, code: 'amount', error: 'Le montant doit être un nombre entier de pièces.' };
  }
  if (amount < MIN_TRANSFER) {
    return { ok: false, code: 'amount', error: `Le montant minimum est de **${MIN_TRANSFER}** pièce.` };
  }
  if (amount > MAX_TRANSFER) {
    return { ok: false, code: 'amount', error: `Le montant maximum est de **${MAX_TRANSFER}** pièces par paiement.` };
  }
  if (!fromId || !toId) {
    return { ok: false, code: 'target', error: 'Destinataire introuvable sur ce serveur.' };
  }
  if (fromId === toId) {
    return { ok: false, code: 'self', error: 'Tu ne peux pas te payer toi-même.' };
  }
  if (targetIsBot) {
    return { ok: false, code: 'bot', error: 'Les bots ne peuvent pas recevoir de pièces.' };
  }
  if (sourceIsBot) {
    return { ok: false, code: 'bot', error: 'Un bot ne peut pas payer.' };
  }
  return { ok: true };
}

/** Nombre lisible : 12345 → « 12 345 ». */
function formatCoins(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString('fr-FR') : '0';
}

/**
 * Solde d'un membre, créé à zéro au premier regard.
 * Ne jette jamais : un souci de base renvoie un solde à 0 plutôt que de casser
 * l'affichage de /balance.
 */
async function getBalance(guildId, userId, { models = DEFAULTS } = {}) {
  const { Balance } = models;
  try {
    return await Balance.findOneAndUpdate(
      { userId, guildId },
      { $setOnInsert: { coins: 0 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch {
    const doc = await Balance.findOne({ userId, guildId }).catch(() => null);
    return doc || { userId, guildId, coins: 0, lastDaily: null };
  }
}

/**
 * Virement de pièces : débite, crédite, journalise.
 * @returns {Promise<{ok: true, amount: number, sender: object, receiver: object, transaction: object|null}
 *   | {ok: false, code: string, error: string, balance?: number}>}
 */
async function transferCoins({
  guildId,
  fromId,
  toId,
  amount,
  reason = '',
  targetIsBot = false,
  sourceIsBot = false,
  models = DEFAULTS,
} = {}) {
  const { Balance, Transaction } = models;

  if (!guildId) {
    return { ok: false, code: 'guild', error: 'Le paiement n\'est possible que dans un serveur.' };
  }

  const check = validateTransfer({ fromId, toId, amount, targetIsBot, sourceIsBot });
  if (!check.ok) return check;

  // 1) Débit conditionnel : la base refuse d'elle-même de descendre sous zéro.
  let sender;
  try {
    sender = await Balance.findOneAndUpdate(
      { userId: fromId, guildId, coins: { $gte: amount } },
      { $inc: { coins: -amount } },
      { new: true },
    );
  } catch (err) {
    return { ok: false, code: 'db', error: `Base indisponible, aucun paiement effectué : ${err.message}` };
  }

  if (!sender) {
    const current = await Balance.findOne({ userId: fromId, guildId }).catch(() => null);
    const have = Math.max(0, Number(current?.coins) || 0);
    return {
      ok: false,
      code: 'insufficient',
      balance: have,
      error: `Solde insuffisant : tu as **${formatCoins(have)}** pièce(s), il en faut **${formatCoins(amount)}**.`,
    };
  }

  // 2) Crédit du destinataire (compte créé au besoin).
  let receiver;
  try {
    receiver = await Balance.findOneAndUpdate(
      { userId: toId, guildId },
      { $inc: { coins: amount } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    // Le débit ne doit jamais rester sans crédit : on rend les pièces.
    const refunded = await Balance
      .updateOne({ userId: fromId, guildId }, { $inc: { coins: amount } })
      .then(() => true)
      .catch(() => false);
    return {
      ok: false,
      code: 'credit_failed',
      error: refunded
        ? 'Le destinataire n\'a pas pu être crédité : le paiement a été annulé et tes pièces rendues.'
        : `Paiement interrompu **et remboursement impossible** (${err.message}). Contacte un administrateur.`,
    };
  }

  // 3) Journal. Un échec d'écriture ne doit pas annuler un virement déjà fait.
  const cleanReason = String(reason || '').trim().slice(0, MAX_REASON);
  let transaction = null;
  if (Transaction?.create) {
    try {
      transaction = await Transaction.create({ guildId, fromId, toId, amount, reason: cleanReason, kind: 'transfer' });
    } catch (err) {
      console.warn('[Economy] paiement non journalisé :', err.message);
    }
  }

  return { ok: true, amount, reason: cleanReason, sender, receiver, transaction };
}

/**
 * Débit pur : les pièces quittent le membre sans destinataire (achat d'une
 * licence, amende...). Même garantie que transferCoins : la condition
 * `coins >= montant` est évaluée par la base, donc jamais de solde négatif.
 *
 * @returns {Promise<{ok: true, amount: number, sender: object, transaction: object|null}
 *   | {ok: false, code: string, error: string, balance?: number}>}
 */
async function spendCoins({ guildId, userId, amount, reason = '', kind = 'purchase', models = DEFAULTS } = {}) {
  const { Balance, Transaction } = models;

  if (!guildId) return { ok: false, code: 'guild', error: 'L\'achat n\'est possible que dans un serveur.' };
  if (!Number.isSafeInteger(amount) || amount < MIN_TRANSFER || amount > MAX_TRANSFER) {
    return { ok: false, code: 'amount', error: `Le montant doit être un entier entre ${MIN_TRANSFER} et ${formatCoins(MAX_TRANSFER)}.` };
  }

  let sender;
  try {
    sender = await Balance.findOneAndUpdate(
      { userId, guildId, coins: { $gte: amount } },
      { $inc: { coins: -amount } },
      { new: true },
    );
  } catch (err) {
    return { ok: false, code: 'db', error: `Base indisponible, aucun débit effectué : ${err.message}` };
  }

  if (!sender) {
    const current = await Balance.findOne({ userId, guildId }).catch(() => null);
    const have = Math.max(0, Number(current?.coins) || 0);
    return {
      ok: false,
      code: 'insufficient',
      balance: have,
      error: `Solde insuffisant : tu as **${formatCoins(have)}** pièce(s), il en faut **${formatCoins(amount)}**.`,
    };
  }

  const cleanReason = String(reason || '').trim().slice(0, MAX_REASON);
  let transaction = null;
  if (Transaction?.create) {
    try {
      transaction = await Transaction.create({ guildId, fromId: userId, toId: SYSTEM_ID, amount, reason: cleanReason, kind });
    } catch (err) {
      console.warn('[Economy] débit non journalisé :', err.message);
    }
  }

  return { ok: true, amount, reason: cleanReason, sender, transaction };
}

/**
 * Rembourse un débit (achat qui n'a pas pu aboutir). Crédite le membre et
 * journalise l'opération ; ne jette jamais.
 */
async function refundCoins({ guildId, userId, amount, reason = '', models = DEFAULTS } = {}) {
  const { Balance, Transaction } = models;
  if (!guildId || !Number.isSafeInteger(amount) || amount < MIN_TRANSFER) {
    return { ok: false, code: 'amount', error: 'Remboursement invalide.' };
  }

  let receiver;
  try {
    receiver = await Balance.findOneAndUpdate(
      { userId, guildId },
      { $inc: { coins: amount } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    console.error('[Economy] remboursement impossible :', err.message);
    return { ok: false, code: 'db', error: 'Remboursement impossible : contacte un administrateur.' };
  }

  const cleanReason = String(reason || '').trim().slice(0, MAX_REASON);
  if (Transaction?.create) {
    await Transaction.create({ guildId, fromId: SYSTEM_ID, toId: userId, amount, reason: cleanReason, kind: 'refund' })
      .catch((err) => console.warn('[Economy] remboursement non journalisé :', err.message));
  }

  return { ok: true, amount, receiver };
}

function normalizeTransaction(row) {
  return {
    fromId: String(row?.fromId || ''),
    toId: String(row?.toId || ''),
    amount: Math.max(0, Number(row?.amount) || 0),
    reason: typeof row?.reason === 'string' ? row.reason : '',
    createdAt: row?.createdAt || null,
  };
}

/** Derniers mouvements d'un membre (envoyés et reçus), du plus récent au plus ancien. */
async function getHistory(guildId, userId, { models = DEFAULTS, limit = HISTORY_LIMIT } = {}) {
  const { Transaction } = models;
  if (!Transaction?.find) return [];

  try {
    const query = Transaction.find({ guildId, $or: [{ fromId: userId }, { toId: userId }] });
    if (typeof query.sort === 'function') query.sort({ createdAt: -1 });
    if (typeof query.limit === 'function') query.limit(Math.min(Math.max(1, limit), 25));
    const rows = await query;
    return (rows || []).map(normalizeTransaction);
  } catch {
    return [];
  }
}

/** Une ligne d'historique lisible dans un embed. */
function formatTransactionLine(row, userId, coin = '🪙') {
  const tx = normalizeTransaction(row);
  const outgoing = tx.fromId === userId;
  const other = outgoing ? tx.toId : tx.fromId;
  const sign = outgoing ? '➖' : '➕';
  const when = tx.createdAt ? ` <t:${Math.floor(new Date(tx.createdAt).getTime() / 1000)}:R>` : '';
  const reason = tx.reason ? ` · *${tx.reason}*` : '';

  if (other === SYSTEM_ID) {
    const label = outgoing ? 'à la **boutique**' : 'remboursement de la **boutique**';
    return `${sign} **${formatCoins(tx.amount)}** ${coin} ${label}${when}${reason}`;
  }

  const direction = outgoing ? 'à' : 'de';
  return `${sign} **${formatCoins(tx.amount)}** ${coin} ${direction} <@${other}>${when}${reason}`;
}

module.exports = {
  MIN_TRANSFER,
  MAX_TRANSFER,
  HISTORY_LIMIT,
  MAX_REASON,
  SYSTEM_ID,
  parseAmount,
  validateTransfer,
  formatCoins,
  getBalance,
  transferCoins,
  spendCoins,
  refundCoins,
  getHistory,
  formatTransactionLine,
  __DEFAULTS: DEFAULTS,
};
