'use strict';
// utils/shopEngine.js — Le moteur de la boutique : achat atomique, stock, remboursement.
//
// Pourquoi ce module existe : la boutique est la seule commande où un membre
// dépense ses pièces sans destinataire. Trois pièges doivent être réglés au
// même endroit, sinon ils divergent entre le bouton d'achat et la commande :
//
//   1. le stock doit être réservé AVANT de débiter (deux acheteurs simultanés
//      sur le dernier article : un seul doit passer) ;
//   2. le débit passe par utils/economy.js, dont la condition `coins >= prix`
//      est évaluée par la base — le solde ne peut jamais devenir négatif ;
//   3. si la livraison échoue (inventaire indisponible, rôle impossible à
//      attribuer), les pièces ET le stock sont rendus.
//
// Testable hors ligne : `purchase()` accepte des modèles et un moteur
// d'économie factices (même convention que utils/economy.js).

const DEFAULTS = {
  ShopItem: require('../models/Shop').ShopItem,
  Inventory: require('../models/Shop').Inventory,
};

const economy = require('./economy');

const TYPE_EMOJI = { role: '🎭', badge: '🏅', perk: '✨' };
const TYPE_LABEL = { role: 'Rôle', badge: 'Badge', perk: 'Avantage' };
const TYPES = Object.keys(TYPE_EMOJI);

const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const MIN_PRICE = 1;
const MAX_PRICE = 1_000_000;
const MAX_STOCK = 100_000;
const UNLIMITED = -1;
const SELECT_LIMIT = 25; // Discord n'accepte pas plus de 25 options par menu

const TYPE_ALIASES = {
  role: 'role', 'rôle': 'role', roles: 'role', 'rôles': 'role',
  badge: 'badge', badges: 'badge',
  perk: 'perk', avantage: 'perk', avantages: 'perk',
};

/** Prix saisi à la main : « 500 », « 1 500 », « 500 pièces ». */
function parsePrice(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= MIN_PRICE && raw <= MAX_PRICE ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase()
    .replace(/[\s\u00a0\u202f_'’]/g, '')
    .replace(/🪙/g, '')
    .replace(/pi[eè]ces?$/, '')
    .replace(/coins?$/, '');
  if (!/^\d{1,12}$/.test(cleaned)) return null;
  const price = Number(cleaned);
  return price >= MIN_PRICE && price <= MAX_PRICE ? price : null;
}

/** Stock saisi à la main : « -1 » / « ∞ » / « illimité » / « 10 ». */
function parseStock(raw, fallback = UNLIMITED) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= UNLIMITED && raw <= MAX_STOCK ? raw : null;
  }
  const cleaned = String(raw).trim().toLowerCase();
  if (['-1', '∞', 'infini', 'illimite', 'illimité', 'unlimited'].includes(cleaned)) return UNLIMITED;
  if (!/^\d{1,7}$/.test(cleaned)) return null;
  const stock = Number(cleaned);
  return stock >= 0 && stock <= MAX_STOCK ? stock : null;
}

/** Type d'article : role / badge / perk (alias français tolérés). */
function parseType(raw) {
  return TYPE_ALIASES[String(raw || '').trim().toLowerCase()] || null;
}

function stockLabel(item) {
  const stock = Number(item?.stock);
  if (stock === UNLIMITED || stock < 0) return '∞';
  return String(stock);
}

function isBuyable(item) {
  return !!item && item.enabled !== false && Number(item.stock) !== 0;
}

/** Articles réellement achetables, triés du moins cher au plus cher. */
function buyableItems(items = []) {
  return [...items]
    .filter(isBuyable)
    .sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
}

/** « 12 500 🪙 » */
function priceLabel(price) {
  return `${economy.formatCoins(price)} 🪙`;
}

/**
 * Réserve une unité de stock de façon atomique.
 * @returns {Promise<object|null>} l'article à jour, ou null si le stock vient de tomber à 0.
 */
async function reserveStock(item, models = DEFAULTS) {
  const { ShopItem } = models;
  const filter = {
    guildId: item.guildId,
    itemId: item.itemId,
    enabled: true,
    ...(Number(item.stock) > 0 ? { stock: { $gt: 0 } } : { stock: { $lt: 0 } }),
  };
  const update = Number(item.stock) > 0
    ? { $inc: { stock: -1, purchases: 1 } }
    : { $inc: { purchases: 1 } };
  return ShopItem.findOneAndUpdate(filter, update, { new: true });
}

/** Rend l'unité réservée (achat annulé). Ne jette jamais. */
async function releaseStock(item, models = DEFAULTS) {
  const { ShopItem } = models;
  const update = Number(item.stock) > 0
    ? { $inc: { stock: 1, purchases: -1 } }
    : { $inc: { purchases: -1 } };
  await ShopItem.updateOne({ guildId: item.guildId, itemId: item.itemId }, update).catch(() => {});
}

const ERROR_TITLES = {
  missing: 'Article introuvable',
  out_of_stock: 'Rupture de stock',
  owned: 'Déjà possédé',
  insufficient: 'Solde insuffisant',
  amount: 'Prix invalide',
  payment: 'Paiement refusé',
  inventory: 'Achat annulé',
  role: 'Rôle impossible',
  db: 'Boutique indisponible',
};

/**
 * Achète un article pour un membre.
 *
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.userId
 * @param {string} opts.itemId
 * @param {import('discord.js').GuildMember|null} [opts.member] membre qui reçoit le rôle
 * @param {object} [opts.models] modèles injectables (tests)
 * @param {object} [opts.economyApi] moteur d'économie injectable (tests)
 * @returns {Promise<{ok: true, item: object, inventory: object|null, coinsLeft: number|null, roleAdded: string|null}
 *   | {ok: false, code: string, error: string}>}
 */
async function purchase({
  guildId, userId, itemId, member = null, models = DEFAULTS, economyApi = economy,
} = {}) {
  const { ShopItem, Inventory } = models;

  if (!guildId || !userId || !itemId) {
    return { ok: false, code: 'missing', error: 'Cet article n\'existe pas dans la boutique.' };
  }

  let item;
  try {
    item = await ShopItem.findOne({ guildId, itemId, enabled: true });
  } catch (err) {
    return { ok: false, code: 'db', error: `La boutique est momentanément indisponible (${err.message}).` };
  }
  if (!item) return { ok: false, code: 'missing', error: 'Cet article n\'existe plus dans la boutique.' };
  if (Number(item.stock) === 0) {
    return { ok: false, code: 'out_of_stock', error: 'Cet article est en rupture de stock.' };
  }

  const price = parsePrice(item.price);
  if (price === null) {
    return { ok: false, code: 'amount', error: 'Le prix de cet article est mal configuré : préviens un administrateur.' };
  }

  // Un rôle ne s'achète qu'une fois (sinon on paierait deux fois le même rôle).
  if (item.type === 'role') {
    let owned = null;
    try {
      owned = await Inventory.findOne({ userId, guildId, itemId });
    } catch { owned = null; }
    if (owned) return { ok: false, code: 'owned', error: 'Tu possèdes déjà cet article.' };
  }

  // 1) Réserver le stock avant de toucher au portefeuille.
  let reserved;
  try {
    reserved = await reserveStock(item, models);
  } catch (err) {
    return { ok: false, code: 'db', error: `La boutique est momentanément indisponible (${err.message}).` };
  }
  if (!reserved) {
    return { ok: false, code: 'out_of_stock', error: 'Trop tard : le dernier exemplaire vient d\'être acheté.' };
  }

  // 2) Débiter — conditionnel en base, donc jamais de solde négatif.
  let paid;
  try {
    paid = await economyApi.spendCoins({
      guildId,
      userId,
      amount: price,
      reason: `Achat — ${item.name}`.slice(0, economy.MAX_REASON),
      kind: 'purchase',
    });
  } catch (err) {
    await releaseStock(reserved, models);
    return { ok: false, code: 'db', error: `Paiement interrompu, aucune pièce n'a été débitée (${err.message}).` };
  }

  if (!paid?.ok) {
    await releaseStock(reserved, models);
    return { ok: false, code: paid?.code || 'payment', error: paid?.error || 'Paiement refusé.' };
  }

  // 3) Livrer l'article dans l'inventaire. Un échec rembourse ET remet en stock.
  let inventory = null;
  try {
    inventory = await Inventory.create({
      userId,
      guildId,
      itemId: item.itemId,
      name: item.name,
      type: item.type,
      roleId: item.roleId || null,
      badge: item.badge || null,
    });
  } catch (err) {
    await releaseStock(reserved, models);
    const refund = await economyApi.refundCoins({
      guildId,
      userId,
      amount: price,
      reason: `Achat annulé — ${item.name}`.slice(0, economy.MAX_REASON),
    }).catch(() => null);
    return {
      ok: false,
      code: 'inventory',
      error: refund?.ok === false
        ? 'L\'article n\'a pas pu être enregistré et le remboursement a échoué : contacte un administrateur.'
        : 'Achat annulé : l\'article n\'a pas pu être enregistré, tes pièces ont été rendues.',
    };
  }

  // 4) Attribuer le rôle. Sans le rôle, l'achat n'a aucun intérêt : on annule.
  let roleAdded = null;
  if (item.type === 'role' && item.roleId) {
    const added = member?.roles?.add
      ? await member.roles.add(item.roleId).then(() => true).catch(() => false)
      : false;

    if (!added) {
      if (typeof Inventory.deleteOne === 'function') {
        await Inventory.deleteOne({ _id: inventory?._id }).catch(() => {});
      }
      await releaseStock(reserved, models);
      const refund = await economyApi.refundCoins({
        guildId,
        userId,
        amount: price,
        reason: `Rôle non attribué — ${item.name}`.slice(0, economy.MAX_REASON),
      }).catch(() => null);

      return {
        ok: false,
        code: 'role',
        error: refund?.ok === false
          ? 'Le rôle n\'a pas pu être attribué et le remboursement a échoué : contacte un administrateur.'
          : 'Le rôle n\'a pas pu être attribué (permissions du bot ?) : tes pièces ont été rendues.',
      };
    }
    roleAdded = item.roleId;
  }

  return {
    ok: true,
    item: reserved || item,
    inventory,
    coinsLeft: Number.isFinite(Number(paid.sender?.coins)) ? Number(paid.sender.coins) : null,
    roleAdded,
  };
}

module.exports = {
  DEFAULTS,
  TYPE_EMOJI,
  TYPE_LABEL,
  TYPES,
  MAX_NAME,
  MAX_DESCRIPTION,
  MIN_PRICE,
  MAX_PRICE,
  MAX_STOCK,
  UNLIMITED,
  SELECT_LIMIT,
  ERROR_TITLES,
  parsePrice,
  parseStock,
  parseType,
  stockLabel,
  isBuyable,
  buyableItems,
  priceLabel,
  reserveStock,
  releaseStock,
  purchase,
};
