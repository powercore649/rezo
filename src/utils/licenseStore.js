'use strict';
// utils/licenseStore.js — Boutique de licences : de la commande à la clé.
//
// Le site n'est pas décoratif : il encaisse (Stripe) ou attend une validation
// manuelle, puis écrit une **vraie** clé dans la collection que lit le bot
// (`models/License.js`) via `utils/licenseIssuer.js`. Une clé émise ici
// s'active ensuite sur Discord avec `/license`.
//
// Trois règles tenues par ce module :
//   1. une commande impayée ne produit jamais de clé ;
//   2. un paiement rejoué ne produit pas de seconde clé (idempotence) ;
//   3. le seul moyen de lire la clé est le jeton privé de la commande.
//
// Aucune dépendance à Discord ni à Express : tout est testable avec un faux
// modèle et un faux `fetch`.

const crypto = require('crypto');
const LicenseOrder = require('../models/LicenseOrder');
const License = require('../models/License');
const { resolvePlan, formatPrice } = require('./licensePlans');
const { issueKey } = require('./licenseIssuer');

// Auteur enregistré sur les clés émises par le site (License.createdBy est un
// simple identifiant libre : ce n'est pas un ID Discord).
const SITE_ISSUER = 'site';

// Signature Stripe : tolérance de 5 minutes contre le rejeu d'une requête
// capturée.
const SIGNATURE_TOLERANCE = 300;

function stripeConfigured(env = process.env) {
  return Boolean(String(env.STRIPE_SECRET_KEY || '').trim());
}

/** Base publique du site, sans barre finale (vide si non configurée). */
function publicBaseUrl(env = process.env) {
  const raw = String(env.STORE_PUBLIC_URL || '').trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

// ── Commandes ────────────────────────────────────────────────────────────────
/**
 * Crée une commande en attente.
 * @returns {Promise<{ok:true, order:object}|{ok:false, error:string}>}
 */
async function createOrder({ planId, email = null, provider = 'manual', now = new Date() } = {}) {
  const plan = resolvePlan(planId);
  if (!plan) return { ok: false, error: 'offre inconnue' };
  // Un pack sur devis n'a pas de prix : aucune commande ne doit pouvoir être
  // créée (sinon une clé serait émise à 0 €).
  if (plan.quote) return { ok: false, error: 'offre sur devis' };

  const cleanEmail = typeof email === 'string' && /.+@.+\..+/.test(email.trim())
    ? email.trim().slice(0, 190)
    : null;

  try {
    const order = await LicenseOrder.create({
      token: LicenseOrder.newToken(),
      plan: plan.id,
      amountCents: plan.amountCents,
      currency: plan.currency,
      status: 'pending',
      provider,
      email: cleanEmail,
      createdAt: now,
    });
    return { ok: true, order, plan };
  } catch (err) {
    return { ok: false, error: err?.message || 'commande impossible' };
  }
}

async function findOrder(token) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(clean)) return null;
  return LicenseOrder.findOne({ token: clean }).lean();
}

/**
 * Encaisse une commande : passe `paid` **puis** émet la clé.
 *
 * Le passage à `paid` sert de verrou : `findOneAndUpdate` sur
 * `{ token, status: 'pending' }` ne réussit qu'une fois, donc deux webhooks
 * concurrents n'émettent qu'une seule clé.
 *
 * @returns {Promise<{ok:true, order:object, key:string, already?:boolean}|{ok:false, error:string}>}
 */
async function fulfilOrder(token, { providerRef = null, providerEventId = null, now = new Date() } = {}) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(clean)) return { ok: false, error: 'commande inconnue' };

  const existing = await LicenseOrder.findOne({ token: clean }).lean().catch(() => null);
  if (!existing) return { ok: false, error: 'commande inconnue' };

  // Déjà payée : on renvoie la clé existante, sans jamais en créer une autre.
  if (existing.status === 'paid') {
    return { ok: true, already: true, key: existing.key, order: existing };
  }
  if (existing.status === 'refunded' || existing.status === 'cancelled') {
    return { ok: false, error: `commande ${existing.status}` };
  }

  const claimed = await LicenseOrder.findOneAndUpdate(
    { token: clean, status: 'pending' },
    { $set: { status: 'paid', paidAt: now, providerRef, providerEventId } },
    { new: true },
  ).lean().catch(() => null);

  if (!claimed) {
    // Course perdue : un autre appel a encaissé entre-temps.
    const latest = await LicenseOrder.findOne({ token: clean }).lean().catch(() => null);
    if (latest?.status === 'paid') return { ok: true, already: true, key: latest.key, order: latest };
    return { ok: false, error: 'commande non encaissable' };
  }

  const issued = await issueKey({
    planId: claimed.plan,
    createdBy: SITE_ISSUER,
    note: `site:${claimed.plan}:${clean.slice(0, 12)}`,
    now,
  }).catch(err => ({ ok: false, error: err?.message || 'émission impossible' }));

  if (!issued.ok) {
    // Ne jamais laisser une commande « payée » sans clé : on la remet en
    // attente pour qu'un nouvel essai (webhook rejoué, validation manuelle)
    // puisse aboutir.
    await LicenseOrder.updateOne(
      { token: clean },
      { $set: { status: 'pending', paidAt: null, providerRef: null, providerEventId: null } },
    ).catch(() => {});
    return { ok: false, error: issued.error || 'émission impossible' };
  }

  await LicenseOrder.updateOne({ token: clean }, { $set: { key: issued.key } }).catch(() => {});
  return { ok: true, key: issued.key, order: { ...claimed, key: issued.key } };
}

/**
 * Liste les commandes pour la page d'administration.
 * @returns {Promise<object[]>} triées de la plus récente à la plus ancienne
 */
async function listOrders({ status = null, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const query = status && LicenseOrder.STATUSES?.includes(status) ? { status } : {};
  const rows = await LicenseOrder.find(query)
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .lean()
    .catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

/** Date du dernier envoi d'e-mail réussi pour une commande. */
async function markEmailSent(token, when = new Date()) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(clean)) return false;
  const res = await LicenseOrder.updateOne(
    { token: clean },
    { $set: { emailSentAt: when } },
  ).catch(() => null);
  return Boolean(res && (res.matchedCount ?? res.modifiedCount));
}

/** Annule une commande encore en attente (paiement abandonné). */
async function cancelOrder(token, { reason = 'cancelled' } = {}) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(clean)) return { ok: false, error: 'commande inconnue' };
  const res = await LicenseOrder.findOneAndUpdate(
    { token: clean, status: 'pending' },
    { $set: { status: reason === 'refunded' ? 'refunded' : 'cancelled' } },
    { new: true },
  ).lean().catch(() => null);
  return res ? { ok: true, order: res } : { ok: false, error: 'aucune commande en attente' };
}

/**
 * État lisible d'une clé, sans jamais révéler qui l'a activée.
 * Sert à la page `/verifier`.
 *
 * Le site n'interprète pas la licence lui-même : il interroge les règles
 * pures de `licenseCore` (statut, sièges, grâce), donc une clé réseau ou une
 * licence en période de grâce s'affiche exactement comme le bot la voit.
 */
async function inspectKey(rawKey) {
  const key = String(rawKey || '').trim().toUpperCase();
  const { KEY_PATTERN } = require('./licenseIssuer');
  if (!KEY_PATTERN.test(key)) return { ok: false, error: 'format' };

  const doc = await License.findOne({ key }).lean().catch(() => null);
  if (!doc) return { ok: false, error: 'inconnue' };

  const core = require('./licenseCore');
  const kind = core.kindInfo(doc.kind);
  const seats = core.seatsOf(doc);
  const status = core.computeStatus(doc);
  const expiresAt = doc.expiresAt ? new Date(doc.expiresAt) : null;
  const graceEndsAt = status === 'grace' ? core.accessEndsAt(doc) : null;

  const shared = {
    ok: true,
    key,
    kind: kind.id,
    kindLabel: kind.label,
    seatsUsed: seats.length,
    maxGuilds: core.maxSeatsOf(doc),
    expiresAt,
    daysLeft: core.daysLeft(doc),
    graceEndsAt,
    graceDays: Number(doc.graceDays) || 0,
    activatedAt: doc.activatedAt || null,
  };

  if (status === 'revoked') return { ...shared, state: 'revoked' };
  if (status === 'expired') return { ...shared, state: 'expired' };
  // Aucun siège lié = clé encore disponible ; sinon elle est en service (ou
  // en grâce), ce qui reste un état distinct à l'affichage.
  if (!seats.length) return { ...shared, state: 'available' };
  return { ...shared, state: status };
}

// ── Stripe (API REST, sans SDK) ──────────────────────────────────────────────
/** Encode un objet en `application/x-www-form-urlencoded` façon Stripe. */
function toStripeForm(params, prefix = '', out = []) {
  for (const [rawKey, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const key = prefix ? `${prefix}[${rawKey}]` : rawKey;
    if (typeof value === 'object' && !Array.isArray(value)) toStripeForm(value, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return out.join('&');
}

/**
 * Crée une session Stripe Checkout et renvoie l'URL de paiement.
 * @returns {Promise<{ok:true,url:string,id:string}|{ok:false,error:string}>}
 */
async function createCheckoutSession({
  order, plan, origin, secretKey, fetchImpl = globalThis.fetch, currency = 'EUR',
  productName = 'Licence REZO', now = Date.now(),
} = {}) {
  if (!order?.token) return { ok: false, error: 'commande manquante' };
  if (!secretKey) return { ok: false, error: 'Stripe non configuré' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch indisponible' };

  const base = String(origin || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'origine du site inconnue' };

  const label = `${productName} ${plan?.label || order.plan}`;
  const body = toStripeForm({
    mode: 'payment',
    // `{CHECKOUT_SESSION_ID}` est remplacé par Stripe : il permet de confirmer
    // le paiement côté serveur au retour du client, sans attendre le webhook.
    success_url: `${base}/commande/${order.token}?paiement=ok&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/commande/${order.token}?paiement=annule`,
    client_reference_id: order.token,
    metadata: { token: order.token, plan: order.plan },
    customer_email: order.email || undefined,
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: String(currency || 'EUR').toLowerCase(),
          unit_amount: order.amountCents,
          product_data: {
            name: label,
            description: plan?.days === null
              ? 'Licence illimitée pour un serveur'
              : `Licence ${plan?.days || 30} jours pour un serveur`,
          },
        },
      },
    },
    // Une clé est un bien numérique : aucune adresse de livraison à demander.
    payment_intent_data: { description: label },
  });

  let res;
  try {
    res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Clé d'idempotence : un double clic ne crée pas deux sessions.
        'Idempotency-Key': `${order.token}:${Math.floor(now / 60_000)}`,
      },
      // Stripe ne substitue le jeton de session que s'il est littéral : on
      // rétablit les accolades que l'encodage du formulaire a échappées.
      body: body.replace(/%7BCHECKOUT_SESSION_ID%7D/gi, '{CHECKOUT_SESSION_ID}'),
    });
  } catch (err) {
    return { ok: false, error: err?.message || 'Stripe injoignable' };
  }

  const text = await res.text().catch(() => '');
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* réponse non JSON */ }

  if (!res.ok || !payload?.url) {
    const detail = payload?.error?.message || `HTTP ${res.status}`;
    return { ok: false, error: detail };
  }
  return { ok: true, url: payload.url, id: payload.id || null };
}

/**
 * Vérifie l'en-tête `Stripe-Signature` (schéma `t=…,v1=…`).
 * Comparaison à temps constant, tolérance anti-rejeu.
 */
function verifyStripeSignature({
  payload, header, secret, toleranceSeconds = SIGNATURE_TOLERANCE, nowMs = Date.now(),
} = {}) {
  if (!header || !secret) return false;

  const parts = String(header).split(',').map(p => p.trim());
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!timestamp || !signatures.length) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (toleranceSeconds > 0) {
    const age = Math.abs(nowMs / 1000 - ts);
    if (age > toleranceSeconds) return false;
  }

  const expected = crypto
    .createHmac('sha256', String(secret))
    .update(`${timestamp}.${String(payload ?? '')}`, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  return signatures.some(sig => {
    const got = Buffer.from(sig, 'utf8');
    return got.length === expectedBuf.length && crypto.timingSafeEqual(got, expectedBuf);
  });
}

/**
 * Relit une session Checkout chez Stripe.
 * @returns {Promise<{ok:true, session:object}|{ok:false, error:string}>}
 */
async function fetchCheckoutSession({ sessionId, secretKey, fetchImpl = globalThis.fetch } = {}) {
  if (!sessionId || !secretKey) return { ok: false, error: 'session ou clé manquante' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch indisponible' };

  let res;
  try {
    res = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${secretKey}` },
    });
  } catch (err) {
    return { ok: false, error: err?.message || 'Stripe injoignable' };
  }

  const text = await res.text().catch(() => '');
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* réponse non JSON */ }
  if (!res.ok || !payload?.id) {
    return { ok: false, error: payload?.error?.message || `HTTP ${res.status}` };
  }
  return { ok: true, session: payload };
}

/**
 * Confirme une commande au retour du client, directement auprès de Stripe.
 *
 * Filet de sécurité du webhook : si le client revient avant l'événement, ou si
 * le webhook n'est pas configuré, la clé est tout de même délivrée — à condition
 * que Stripe confirme lui-même le paiement de **cette** commande.
 */
async function confirmFromSession({ token, sessionId, secretKey, fetchImpl = globalThis.fetch } = {}) {
  const clean = String(token || '').trim();
  if (!/^[a-f0-9]{64}$/.test(clean)) return { ok: false, error: 'commande inconnue' };

  const fetched = await fetchCheckoutSession({ sessionId, secretKey, fetchImpl });
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const session = fetched.session;
  const sessionToken = session.client_reference_id || session.metadata?.token || null;
  if (sessionToken !== clean) return { ok: false, error: 'session d’une autre commande' };
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return { ok: false, error: 'paiement non confirmé' };
  }

  return fulfilOrder(clean, { providerRef: session.id || null, providerEventId: 'session-verify' });
}

/** Extrait le jeton de commande d'un événement Stripe, si pertinent. */
function orderTokenFromEvent(event) {
  const object = event?.data?.object;
  if (!object) return null;
  return object.client_reference_id || object.metadata?.token || null;
}

module.exports = {
  SITE_ISSUER,
  SIGNATURE_TOLERANCE,
  stripeConfigured,
  publicBaseUrl,
  createOrder,
  findOrder,
  listOrders,
  markEmailSent,
  fulfilOrder,
  cancelOrder,
  inspectKey,
  toStripeForm,
  createCheckoutSession,
  fetchCheckoutSession,
  confirmFromSession,
  verifyStripeSignature,
  orderTokenFromEvent,
  formatPrice,
};
