'use strict';
// utils/licenseIssuer.js — Génère de vraies clés de licence REZO.
//
// Une clé doit être **acceptée par le bot** : même format que
// `models/License.js` (`REZO-XXXX-XXXX-XXXX-XXXX`), même collection, même
// index unique. Le site n'a donc pas son propre registre : il écrit dans celui
// que `/license activer` consulte.
//
// Deux exigences de sécurité :
//   • l'aléa vient de `crypto.randomInt`, jamais de `Math.random` ;
//   • les caractères ambigus (0/O, 1/I) sont exclus, pour qu'une clé recopiée
//     à la main depuis un e-mail ne devienne pas invalide.
//
// Le format accepte A-Z et 0-9 : retirer deux lettres et deux chiffres ne
// change rien au regard de la validation du bot.

const crypto = require('crypto');
const License = require('../models/License');
const { resolvePlan } = require('./licensePlans');
const masterLicense = require('./masterLicense');

const KEY_PATTERN = /^REZO-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ni O, ni I, ni 0, ni 1
const GROUPS = 4;
const GROUP_SIZE = 4;
const MAX_ATTEMPTS = 8;

/** Une suite de 4 caractères non ambigus. */
function randomGroup(size = GROUP_SIZE) {
  let out = '';
  for (let i = 0; i < size; i++) out += CHARSET[crypto.randomInt(0, CHARSET.length)];
  return out;
}

/** Construit une clé à partir de groupes déjà tirés (testable sans aléa). */
function formatKey(groups) {
  const list = Array.isArray(groups) ? groups : String(groups || '').match(/.{1,4}/g) || [];
  if (list.length !== GROUPS) throw new Error('formatKey : 4 groupes de 4 caractères attendus');
  return `REZO-${list.join('-')}`;
}

/** Clé neuve, jamais encore utilisée en base. */
function generateKey() {
  return formatKey(Array.from({ length: GROUPS }, () => randomGroup()));
}

/** Date d'expiration selon l'offre (null = illimitée). */
function expiryFor(planId, now = new Date()) {
  const plan = resolvePlan(planId);
  if (!plan || plan.days === null) return null;
  return new Date(now.getTime() + plan.days * 24 * 3600_000);
}

/**
 * Crée une licence en base, avec réessai si la clé tirée existe déjà.
 *
 * @returns {Promise<{ ok:true, key:string, doc:object } | { ok:false, error:string }>}
 */
async function issueKey({
  planId, createdBy, note = '', expiresAt = null, now = new Date(),
  // Surcharges réservées aux devis : un pack sur devis se chiffre avec le
  // client (sièges, durée), donc la clé doit pouvoir s'écarter du catalogue.
  maxGuilds = null, graceDays = null, extras = null, allowQuote = false,
} = {}) {
  if (!createdBy) return { ok: false, error: 'createdBy requis' };

  // ── Licence maître ────────────────────────────────────────────────────────
  // Le dépôt est public : sans jeton maître signé, une copie du bot ne doit pas
  // pouvoir fabriquer de clés. Ce module est le point d'émission du site et des
  // devis ; `licenseGate.createLicense` garde celui du bot.
  const master = masterLicense.guard();
  if (!master.ok) {
    return { ok: false, code: 'master_locked', reason: master.reason, error: master.message };
  }

  const plan = resolvePlan(planId);
  if (!plan) return { ok: false, error: `offre inconnue : ${planId}` };
  // Un pack sur devis se chiffre avec le client : sa clé est créée à la main
  // par l'owner, jamais par le tunnel d'achat.
  // Le tunnel d'achat ne doit jamais émettre un pack sur devis ; l'approbation
  // explicite du propriétaire (`allowQuote`) est le seul chemin autorisé.
  if (plan.quote && !allowQuote) return { ok: false, error: 'offre sur devis — clé à émettre manuellement' };

  const expiry = expiresAt || expiryFor(planId, now);
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const key = generateKey();
    try {
      const doc = await License.create({
        key,
        guildId: null,
        guildIds: [],
        seatsUsed: 0,
        createdBy,
        planId: plan.id,
        kind: plan.kind || 'standard',
        // Un pack transporte les modules qu'il ajoute au palier ; une offre
        // individuelle n'en a aucun.
        extras: Array.isArray(extras) ? extras : (Array.isArray(plan.extras) ? plan.extras : []),
        maxGuilds: Math.max(1, Math.min(25, Number(maxGuilds) || plan.maxGuilds || 1)),
        graceDays: Number.isFinite(graceDays)
          ? Math.max(0, Math.min(60, graceDays))
          : (Number.isFinite(plan.graceDays) ? plan.graceDays : 3),
        expiresAt: expiry,
        note: String(note || `site:${plan.id}`).slice(0, 200),
      });
      return { ok: true, key, doc };
    } catch (err) {
      lastError = err;
      // 11000 = collision sur l'index unique : on retire une autre clé.
      if (err?.code !== 11000) return { ok: false, error: err?.message || 'création impossible' };
    }
  }

  return { ok: false, error: `collision répétée (${lastError?.message || 'inconnue'})` };
}

module.exports = {
  KEY_PATTERN,
  CHARSET,
  GROUPS,
  GROUP_SIZE,
  MAX_ATTEMPTS,
  randomGroup,
  formatKey,
  generateKey,
  expiryFor,
  issueKey,
};
