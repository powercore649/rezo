'use strict';
// scripts/store-server.js — Lance le site seul, sans démarrer le bot.
//
// Utile pour héberger la boutique sur une autre machine que le bot, ou pour
// travailler sur les pages. Le site écrit dans la même base que le bot : les
// clés émises ici sont donc immédiatement activables avec `/license`.
//
//   node scripts/store-server.js          (ou : npm run site)
//
// Variables : MONGODB_URI, STORE_PORT, STORE_HOST, STORE_PUBLIC_URL,
//             STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STORE_ADMIN_TOKEN.

require('dotenv').config();

const { startStoreServer, connectDatabase } = require('../src/web/storeServer');

const env = process.env;
const logger = console;

(async () => {
  if (!env.STORE_PORT && !env.STORE_PUBLIC_URL) {
    logger.error('STORE_PORT manquant : ajoute STORE_PORT=3200 dans .env pour lancer le site.');
    process.exitCode = 1;
    return;
  }

  try {
    await connectDatabase(env.MONGODB_URI, { logger });
  } catch (err) {
    logger.error(`site: base injoignable — ${err.message}`);
    logger.error('La boutique ne peut pas délivrer de clé sans base : arrêt.');
    process.exitCode = 1;
    return;
  }

  const server = await startStoreServer({ client: null, env, logger });
  if (!server) {
    process.exitCode = 1;
    return;
  }

  if (!env.STRIPE_SECRET_KEY) {
    logger.warn('site: STRIPE_SECRET_KEY absent — les commandes passeront par une validation manuelle.');
  }
  if (env.STORE_PUBLIC_URL) logger.info(`site: URL publique ${env.STORE_PUBLIC_URL}`);

  const shutdown = signal => {
    logger.info(`site: arrêt (${signal})`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();
