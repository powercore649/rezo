'use strict';
// crons/captchaExpiry.js — Applique les expirations de captcha en continu.
//
// Pourquoi ce cron : le timeout d'un captcha était auparavant géré uniquement
// par un setTimeout en mémoire. Si le bot redémarrait entre l'envoi et
// l'expiration, le membre n'était jamais expulsé ni journalisé. Ce balayage
// (toutes les minutes) appelle le même helper que le setTimeout immédiat, donc
// le comportement est identique et survit aux redémarrages.
//
// Il retire aussi, une seule fois, un éventuel index TTL hérité sur `expiresAt` :
// un TTL supprimerait le document avant que le balayage ne puisse le traiter.

const { CaptchaPending } = require('../models/Captcha');
const { expirePending } = require('../commands/configuration/captcha');

let indexChecked = false;

async function dropLegacyTtlIndex() {
  if (indexChecked) return;
  indexChecked = true;
  try {
    const indexes = await CaptchaPending.collection.indexes();
    for (const ix of indexes) {
      if (ix.key && ix.key.expiresAt === 1 && ix.expireAfterSeconds !== undefined) {
        await CaptchaPending.collection.dropIndex(ix.name);
      }
    }
  } catch (_) {
    // Collection pas encore créée, ou droits insuffisants : on réessaiera au prochain tick.
    indexChecked = false;
  }
}

async function sweepExpired(client) {
  const expired = await CaptchaPending.find({ expiresAt: { $lt: new Date() } }).limit(100).catch(() => []);
  let handled = 0;
  for (const pending of expired) {
    // eslint-disable-next-line no-await-in-loop
    const done = await expirePending(client, { userId: pending.userId, guildId: pending.guildId }).catch(() => false);
    if (done) handled++;
  }
  return handled;
}

module.exports = {
  name: 'captcha-expiry',
  schedule: '* * * * *', // chaque minute
  async execute(client) {
    await dropLegacyTtlIndex();
    const handled = await sweepExpired(client);
    if (handled > 0) console.log(`⏱️ [captcha] ${handled} vérification(s) expirée(s) traitée(s).`);
    return handled;
  },
  // Exposé pour les tests / le boot.
  sweepExpired,
  dropLegacyTtlIndex,
};
