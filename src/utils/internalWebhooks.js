'use strict';
// utils/internalWebhooks.js — Registre des webhooks créés par REZO lui-même.
//
// Pourquoi c'est indispensable : l'anti-spam webhook supprime les messages d'un
// webhook qui inonde un salon. Or le pont inter-serveurs (utils/bridgeEngine.js)
// relaie les messages via un webhook — un pont actif ressemble donc, vu de
// l'anti-spam, à un webhook spammeur. Sans ce registre, relayer 12 messages en
// 5 secondes ferait supprimer la conversation.
//
// Le registre est borné et expire : un webhook supprimé/recréé n'y reste pas
// éternellement, et un bot multi-milliers de serveurs ne fuit pas.

const { createBoundedCache } = require('./boundedCache');

const ownWebhooks = createBoundedCache({ max: 20_000, ttl: 6 * 3600_000, name: 'own-webhooks' });

/** Déclare un webhook comme appartenant au bot (appelé à la création/au chargement). */
function markOwn(webhookId) {
  if (!webhookId) return;
  ownWebhooks.set(String(webhookId), true);
}

/** Ce webhook est-il un webhook interne du bot ? */
function isOwn(webhookId) {
  return Boolean(webhookId && ownWebhooks.has(String(webhookId)));
}

function forget(webhookId) {
  if (webhookId) ownWebhooks.delete(String(webhookId));
}

module.exports = { markOwn, isOwn, forget, _cache: ownWebhooks };
