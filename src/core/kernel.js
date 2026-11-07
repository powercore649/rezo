'use strict';
// core/kernel.js — Noyau v2 du bot.
//
// Regroupe tout ce que faisait src/index.js : validation de l'environnement,
// création du client Discord, chargement modulaire (commandes / événements /
// crons), connexion MongoDB, déploiement des slash commands, gestion des erreurs
// process et arrêt propre. src/index.js ne fait plus qu'appeler boot().
//
// Les parties pures (validateEnv, loadCommands, loadEvents, registerCrons) sont
// testables hors-ligne avec un faux client (voir tests/v2-core.js).

require('dotenv').config();

const path = require('path');
const {
  Client, GatewayIntentBits, Partials, Collection, REST, Routes, Events,
} = require('discord.js');
const mongoose = require('mongoose');
const cron = require('node-cron');

const { createLogger } = require('./logger');
const { loadModules } = require('./registry');
const { shardInfo, isPrimaryShard } = require('./sharding');
const { serialized } = require('../utils/concurrency');
const { installGuildSingletonGuard } = require('../utils/guildSingleton');
const { prepareCanvas } = require('../utils/canvasFallback');

// Installé AVANT le premier `require` de modèle : les configs « une par
// serveur » ne peuvent plus casser en double insertion quand deux actions
// arrivent en même temps (voir utils/guildSingleton.js).
installGuildSingletonGuard(mongoose);

// Même raison pour les visuels : un hôte volontairement sans images
// (MEDIA_CARDS=0) ne doit jamais charger le binaire natif de canvas, donc ne
// peut pas en mourir. Les commandes qui dessinent utilisent alors un rendu
// neutre et restent pilotables.
prepareCanvas();

const log = createLogger('kernel');
const ROOT = path.join(__dirname, '..');

// ── Budget de commandes Discord ─────────────────────────────────────────────
// Discord refuse une application de plus de 100 commandes GLOBALES : au-delà,
// l'appel REST échoue (et une republication ratée laisse le serveur sans
// commandes à jour). On vérifie donc le budget AVANT tout appel réseau.
const MAX_GLOBAL_COMMANDS = 100;

/**
 * Le jeu de commandes tient-il dans la limite Discord ?
 * @param {Array<{name?:string}>} body
 * @returns {{ ok:boolean, count:number, max:number, headroom:number, overflow:string[] }}
 */
function assertCommandBudget(body = [], { max = MAX_GLOBAL_COMMANDS } = {}) {
  const names = (Array.isArray(body) ? body : []).map(c => c?.name).filter(Boolean);
  return {
    ok: names.length <= max,
    count: names.length,
    max,
    headroom: Math.max(0, max - names.length),
    overflow: names.slice(max),
  };
}

/** Noms déclarés en double (Discord n'en garde qu'un, le second disparaît en silence). */
function duplicateCommandNames(names = []) {
  const seen = new Set();
  const dupes = new Set();
  for (const name of names) {
    if (seen.has(name)) dupes.add(name);
    else seen.add(name);
  }
  return [...dupes];
}

// ── Environnement ───────────────────────────────────────────────────────────
function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  if (!env.TOKEN) errors.push('TOKEN manquant dans .env');
  if (!env.MONGODB_URI) errors.push('MONGODB_URI manquant dans .env');
  if (!env.OWNER_IDS) warnings.push('OWNER_IDS non défini dans .env — panneau owner de /license inaccessible.');
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) {
    warnings.push('REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET non définis — /reddit-annonce indisponible.');
  }
  return { errors, warnings };
}

// ── Client Discord ──────────────────────────────────────────────────────────
function createClient() {
  // discord.js lit lui-même `process.env.SHARD_COUNT` dans son constructeur et
  // exige un entier ≥ 1 : une valeur gérée par le noyau (« auto », « off »)
  // ferait planter le Client. On masque donc la variable le temps de la
  // construction — le plan de sharding est calculé par core/sharding.js, et un
  // vrai entier (transmis par le ShardingManager) continue de passer.
  const rawShardCount = process.env.SHARD_COUNT;
  const numericShardCount = /^\d+$/.test(String(rawShardCount ?? '')) && Number(rawShardCount) >= 1;
  const maskShardCount = rawShardCount !== undefined && !numericShardCount;
  if (maskShardCount) delete process.env.SHARD_COUNT;

  try {
    const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,        // anti-nuke — journal d'audit (guildAuditLogEntryCreate)
      GatewayIntentBits.GuildPresences,         // /botwatch
      GatewayIntentBits.DirectMessages,         // ModMail
      GatewayIntentBits.DirectMessageReactions,
      GatewayIntentBits.GuildMessageReactions,  // Starboard
      GatewayIntentBits.GuildVoiceStates,       // /waitingroom
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction],
    });
    client.commands = new Collection();
    return client;
  } finally {
    if (maskShardCount) process.env.SHARD_COUNT = rawShardCount;
  }
}

// ── Chargement des commandes ────────────────────────────────────────────────
function loadCommands(client, rootDir = ROOT, { logger = log } = {}) {
  const dir = path.join(rootDir, 'commands');
  const { commands, failed } = loadModules(dir, { logger });
  const data = [];
  let v2 = 0;
  for (const entry of commands) {
    const name = entry.mod.data?.name;
    if (!name) { logger.warn(`commande sans nom ignorée : ${entry.file}`); continue; }
    if (client.commands.has(name)) { logger.warn(`commande dupliquée ignorée : /${name}`); continue; }
    // Catégorie réelle (dossier) exposée au module : /help construit son catalogue
    // depuis le bot chargé, jamais depuis une liste écrite à la main.
    try { entry.mod.__category = entry.category; } catch { /* module figé : sans effet */ }
    client.commands.set(name, entry.mod);
    data.push(entry.mod.data.toJSON());
    if (entry.v2) v2++;
    logger.debug(`${entry.v2 ? 'v2 ' : ''}/${name} — ${entry.category}`);
  }
  logger.info(`${client.commands.size} commande(s) chargée(s)${v2 ? ` (dont ${v2} en contrat v2)` : ''}${failed.length ? `, ${failed.length} échec(s)` : ''}`);

  // Discord plafonne à 100 commandes globales : on prévient AVANT de déployer.
  const budget = assertCommandBudget(data);
  if (!budget.ok) {
    logger.error(`limite Discord dépassée : ${budget.count}/${budget.max} commandes — en trop : ${budget.overflow.join(', ')}`);
  } else if (budget.headroom <= 2) {
    logger.warn(`budget de commandes presque atteint : ${budget.count}/${budget.max} (${budget.headroom} emplacement(s) libre(s))`);
  }
  return { data, failed, v2, budget };
}

// ── Chargement des événements ───────────────────────────────────────────────
function loadEvents(client, rootDir = ROOT, { logger = log } = {}) {
  const dir = path.join(rootDir, 'events');
  const { events, failed } = loadModules(dir, { logger });
  const names = new Set();
  for (const { mod } of events) {
    const handler = (...args) => mod.execute(...args, client);
    if (mod.once) client.once(mod.name, handler);
    else client.on(mod.name, handler);
    names.add(mod.name);
  }
  logger.info(`${names.size} type(s) d'événement branché(s)${failed.length ? `, ${failed.length} échec(s)` : ''}`);
  return { names: [...names], failed };
}

// ── Crons modulaires (src/crons/<nom>.js → { name, schedule, execute, scope }) ─
//
// Deux portées, et c'est ce qui rend le sharding correct :
//   • `scope: 'primary'` (défaut) — travail global (entretien de la base, resets,
//     envois faits par l'API REST) : le shard 0 seul l'exécute, sinon N passages.
//   • `scope: 'guilds'` — travail qui a besoin du cache local du serveur
//     (anniversaires, trésors, alertes YouTube, sites surveillés) : CHAQUE shard
//     l'exécute, et le moteur ne traite que les serveurs qu'il voit.
//
// Sans cette distinction, soit les serveurs des autres shards ne recevaient rien
// (crons réservés au shard 0), soit le même envoi partait N fois.
function registerCrons(client, rootDir = ROOT, { logger = log, scheduler = cron, primary = null } = {}) {
  const isPrimary = primary === null ? isPrimaryShard(client) : primary;

  const dir = path.join(rootDir, 'crons');
  const { crons, failed } = loadModules(dir, { logger });
  const tasks = [];
  const reserved = [];

  for (const { mod } of crons) {
    const scope = mod.scope === 'guilds' ? 'guilds' : 'primary';
    if (scope === 'primary' && !isPrimary) {
      reserved.push(mod.name);
      continue;
    }
    if (!scheduler.validate(mod.schedule)) {
      logger.warn(`cron ignoré (expression invalide) : ${mod.name} « ${mod.schedule} »`);
      continue;
    }
    // Anti-chevauchement : un passage qui dure plus longtemps que son intervalle
    // voyait le suivant démarrer par-dessus — travail doublé, mémoire qui grimpe
    // et, à terme, envois en double. Ici, le nouveau passage est simplement
    // ignoré (et signalé) tant que le précédent tourne.
    const execute = serialized(mod.execute, {
      name: mod.name,
      onSkip: name => logger.warn(`cron ${name} ignoré : le passage précédent tourne encore`),
    });
    const task = scheduler.schedule(mod.schedule, () => {
      Promise.resolve()
        .then(() => execute(client))
        .catch(err => logger.error(`cron ${mod.name} : ${err.message}`));
    });
    tasks.push({ name: mod.name, schedule: mod.schedule, scope, task });
  }

  if (isPrimary) {
    logger.info(`${tasks.length} tâche(s) planifiée(s)${failed.length ? `, ${failed.length} échec(s)` : ''}`);
  } else {
    logger.info(`shard ${shardInfo(client).current} : ${tasks.length} tâche(s) de ce shard, ${reserved.length} globale(s) réservée(s) au shard 0`);
  }

  return {
    tasks,
    failed,
    reserved,
    skipped: isPrimary ? null : 'crons globaux réservés au shard 0',
  };
}

// ── MongoDB ─────────────────────────────────────────────────────────────────
//
// Un bot multi-serveurs tient ou tombe avec sa connexion à la base. Trois
// réglages décident de la tenue en charge :
//
//   • le POOL est borné — en mode shardé chaque processus ouvre le sien, et sans
//     limite N shards × 100 connexions (défaut du driver) saturent le serveur :
//     toutes les requêtes se mettent à expirer en même temps ;
//   • les DÉLAIS sont explicites — par défaut une base injoignable laisse chaque
//     requête pendre longuement et s'empiler en mémoire ;
//   • la FILE D'ATTENTE est bornée (`waitQueueTimeoutMS`) — au-delà, une requête
//     échoue vite au lieu de grossir sans fin. C'est ce qui évite le « ça marche
//     puis ça plante » des pics de trafic.
//
// Tout est réglable dans `.env` (voir .env.example) et testable hors ligne via
// `mongoOptions()` (voir tests/scale-smoke.js).

/** Entier lu dans `.env`, sinon valeur par défaut. */
function envMs(env, name, fallback) {
  const raw = Number(env?.[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Options de connexion Mongo déduites de l'environnement (fonction pure). */
function mongoOptions(env = process.env) {
  const pool = Number(env.MONGO_MAX_POOL);
  return {
    ...(Number.isFinite(pool) && pool > 0 ? { maxPoolSize: pool } : {}),
    serverSelectionTimeoutMS: envMs(env, 'MONGO_SERVER_SELECTION_MS', 15_000),
    connectTimeoutMS: envMs(env, 'MONGO_CONNECT_TIMEOUT_MS', 15_000),
    socketTimeoutMS: envMs(env, 'MONGO_SOCKET_TIMEOUT_MS', 45_000),
    maxIdleTimeMS: envMs(env, 'MONGO_MAX_IDLE_MS', 120_000),
    waitQueueTimeoutMS: envMs(env, 'MONGO_WAIT_QUEUE_MS', 10_000),
    retryWrites: true,
    retryReads: true,
  };
}

/**
 * Construction des index déclarés au démarrage. Mongoose la fait par défaut ;
 * sur un très gros parc, `MONGO_AUTO_INDEX=false` la déplace dans l'entretien
 * quotidien (cron db-maintenance) pour ne pas ralentir chaque redémarrage.
 */
function autoIndexEnabled(env = process.env) {
  const raw = String(env.MONGO_AUTO_INDEX ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'non', 'no'].includes(raw);
}

async function connectDatabase(uri, { logger = log, env = process.env, retries = 3, retryMs = 5_000 } = {}) {
  if (!uri) throw new Error('MONGODB_URI manquant');
  const options = mongoOptions(env);
  const autoIndex = autoIndexEnabled(env);
  if (!autoIndex) mongoose.set('autoIndex', false);

  // Une base momentanément indisponible au démarrage (redémarrage du cluster,
  // VM qui boote) ne doit pas tuer le bot : on réessaie avant d'abandonner.
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(uri, options);
      break;
    } catch (err) {
      if (attempt >= retries) {
        logger.error(`MongoDB injoignable après ${attempt} tentative(s) : ${err.message}`);
        throw err;
      }
      logger.warn(`MongoDB injoignable (${err.message}) — nouvelle tentative ${attempt + 1}/${retries} dans ${retryMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }

  // Rattrapage : des modèles peuvent avoir été compilés avant l'installation.
  installGuildSingletonGuard(mongoose);

  logger.info(
    `MongoDB connecté${options.maxPoolSize ? ` (pool max ${options.maxPoolSize})` : ''} — `
    + `sélection ${options.serverSelectionTimeoutMS} ms, socket ${options.socketTimeoutMS} ms, `
    + `file d'attente ${options.waitQueueTimeoutMS} ms`
    + (autoIndex ? '' : ' — index automatiques désactivés (MONGO_AUTO_INDEX=false)'),
  );
  return mongoose.connection;
}

// ── Déploiement des slash commands ──────────────────────────────────────────
async function deployCommands(client, { env = process.env, logger = log, rest = null } = {}) {
  logger.info(`Connecté en tant que ${client.user?.tag ?? '?'}`);

  // Un seul PUT : en mode shardé, tous les processus reçoivent l'événement
  // `ready`. Publier depuis chacun multiplierait les appels et les 429.
  if (!isPrimaryShard(client)) {
    logger.info(`shard ${shardInfo(client).current} : déploiement ignoré (réservé au shard 0)`);
    return { deployed: false, skipped: 'shard secondaire' };
  }

  const api = rest || new REST({ version: '10' }).setToken(env.TOKEN);
  const body = [...client.commands.values()].map(c => c.data.toJSON());

  // Garde-fou : au-delà de la limite Discord, on ne tente RIEN (le jeu de
  // commandes déjà en ligne reste intact) et on dit précisément ce qui dépasse.
  const budget = assertCommandBudget(body);
  if (!budget.ok) {
    logger.error(
      `déploiement refusé : ${budget.count} commandes > limite Discord de ${budget.max}. ` +
      `Commandes en trop : ${budget.overflow.join(', ')}. ` +
      'Retirez ou fusionnez des commandes (voir tests/command-limit.js) : les commandes en ligne restent inchangées.',
    );
    return { deployed: false, ...budget };
  }
  logger.info(`budget de commandes : ${budget.count}/${budget.max} (${budget.headroom} emplacement(s) libre(s))`);

  try {
    await api.put(Routes.applicationCommands(client.user.id), { body });
    logger.info(`${body.length} commande(s) déployée(s) (global — visible sous ~1 h)`);
  } catch (err) {
    logger.error(`déploiement global : ${err.message}`);
  }

  // ── Serveur de test : on nettoie, on ne duplique pas ──────────────────────
  // Une commande enregistrée à la fois en global et sur un serveur apparaît
  // DEUX FOIS dans la liste Discord de ce serveur. Le serveur de test ne
  // recevait qu'une copie dans le but d'un déploiement instantané : cette copie
  // est donc supprimée ici, et le jeu global reste seul visible.
  // Pour un test instantané sans attendre la propagation globale :
  //   node scripts/deploy-commands.js --guild <ID>
  if (env.DEV_GUILD_ID) {
    try {
      const local = await api.get(Routes.applicationGuildCommands(client.user.id, env.DEV_GUILD_ID));
      if (Array.isArray(local) && local.length) {
        await api.put(Routes.applicationGuildCommands(client.user.id, env.DEV_GUILD_ID), { body: [] });
        logger.info(
          `${local.length} commande(s) locale(s) retirée(s) du serveur de test (${env.DEV_GUILD_ID}) : `
          + 'plus de doublons, les commandes globales restent seules visibles',
        );
      } else {
        logger.info(`serveur de test (${env.DEV_GUILD_ID}) : aucune copie locale, aucun doublon`);
      }
    } catch (err) {
      logger.warn(`nettoyage des commandes du serveur de test : ${err.message}`);
    }
  }
}

// ── Connexion Discord avec réessai ──────────────────────────────────────────
async function loginWithRetry(client, token, { logger = log, retryMs = 5000 } = {}) {
  try {
    await client.login(token);
  } catch (err) {
    logger.error(`échec de connexion Discord (${err.code || err.message}) — nouvelle tentative dans ${retryMs / 1000}s`);
    await new Promise(r => setTimeout(r, retryMs));
    return loginWithRetry(client, token, { logger, retryMs });
  }
}

// ── Arrêt propre ────────────────────────────────────────────────────────────
async function shutdown(client, { signal = 'SIGTERM', logger = log } = {}) {
  const where = shardInfo(client);
  logger.warn(`arrêt demandé (${signal})${where.sharded ? ` — shard ${where.current}/${where.count}` : ''} — fermeture en cours…`);
  try { require('../web/antiVpnTunnel').stopQuickTunnel(); } catch { /* ignore */ }
  try { await require('../web/verifyServer').stopVerifyServer(); } catch { /* ignore */ }
  try { await client?.destroy(); } catch { /* ignore */ }
  try { await mongoose.connection.close(); } catch { /* ignore */ }
  logger.info('arrêt terminé');
}

// ── Erreurs process + signaux ───────────────────────────────────────────────
function attachProcessGuards(client, { logger = log } = {}) {
  process.on('unhandledRejection', err => {
    if (err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.name === 'AggregateError') {
      logger.warn(`perturbation réseau temporaire (${err.code || err.name}) — nouvelle tentative automatique`);
      return;
    }
    logger.error('UnhandledRejection :', err);
  });
  process.on('uncaughtException', err => logger.error('UncaughtException :', err));

  const bye = sig => { shutdown(client, { signal: sig }).finally(() => process.exit(0)); };
  process.once('SIGINT', () => bye('SIGINT'));
  process.once('SIGTERM', () => bye('SIGTERM'));
}

// ── Démarrage complet ───────────────────────────────────────────────────────
async function boot({
  rootDir = ROOT,
  env = process.env,
  client = null,
  connect = true,
  login = true,
  guards = true,
  deploy = true,
  logger = log,
} = {}) {
  // ── Refonte visuelle ──────────────────────────────────────────────────
  // Un seul branchement : tous les embeds du bot (plus de 500) sont
  // normalisés à l'envoi — palette, signature, limites Discord.
  require('../utils/ui').installGlobalTheme();

  const { errors, warnings } = validateEnv(env);
  warnings.forEach(w => logger.warn(w));
  if (errors.length) {
    errors.forEach(e => logger.error(e));
    if (env.NODE_ENV !== 'test') process.exit(1);
    return { ok: false, errors };
  }

  const discord = client || createClient();
  const where = shardInfo(discord);
  if (where.sharded) logger.info(`démarrage du shard ${where.current}/${where.count}`);
  const commands = loadCommands(discord, rootDir, { logger });
  loadEvents(discord, rootDir, { logger });
  const crons = registerCrons(discord, rootDir, { logger });

  if (guards) attachProcessGuards(discord, { logger });
  if (connect) await connectDatabase(env.MONGODB_URI, { logger, env });

  if (login) {
    // ── Portail de vérification anti-VPN ──────────────────────────────────
    // Discord ne transmet jamais l'IP d'un membre : la vérification passe par
    // un petit serveur HTTP que le membre ouvre dans son navigateur. Il ne
    // démarre que si ANTIVPN_PORT (ou ANTIVPN_PUBLIC_URL) est configuré, et
    // sur le shard 0 uniquement pour ne pas multiplier les écouteurs.
    //
    // Sans VPS ni domaine, un tunnel Cloudflare gratuit fournit une URL HTTPS
    // publique éphémère vers le port local. Il démarre automatiquement dès que
    // le portail est configuré sans URL publique utilisable ; cloudflared est
    // téléchargé une seule fois dans tools/ s'il est absent.
    const tunnelMod = require('../web/antiVpnTunnel');
    const staticUrl = String(env.ANTIVPN_PUBLIC_URL || '').trim();
    const usableStaticUrl = staticUrl && !tunnelMod.isLoopbackUrl(staticUrl);
    const tunnelSetting = env.ANTIVPN_TUNNEL;
    const tunnelRequested = tunnelMod.isTunnelRequested(tunnelSetting);
    const tunnelDisabled = tunnelMod.isTunnelDisabled(tunnelSetting);
    const portalConfigured = Boolean(env.ANTIVPN_PORT || staticUrl);
    const tunnelWanted = !tunnelDisabled && !usableStaticUrl && (tunnelRequested || portalConfigured);

    if (staticUrl && !usableStaticUrl) {
      logger.warn('ANTIVPN_PUBLIC_URL est une adresse locale : les membres ne peuvent pas l’ouvrir, un tunnel sera utilisé.');
    }
    if (tunnelRequested && usableStaticUrl) {
      logger.warn('ANTIVPN_TUNNEL est activé mais ANTIVPN_PUBLIC_URL est publique : tunnel ignoré.');
    }
    if (tunnelWanted) {
      if (!env.ANTIVPN_PORT) env.ANTIVPN_PORT = '3199';
      // Le tunnel arrive par la boucle locale et transmet l'IP réelle dans
      // CF-Connecting-IP : on écoute en local et on fait confiance à cet en-tête.
      if (!env.ANTIVPN_HOST) env.ANTIVPN_HOST = '127.0.0.1';
      env.ANTIVPN_TRUST_PROXY = '1';
    }

    if (((env.ANTIVPN_PORT || staticUrl) && isPrimaryShard(discord))) {
      let portalServer = null;
      try {
        const { startVerifyServer } = require('../web/verifyServer');
        portalServer = await startVerifyServer({ client: discord, env, logger });
      } catch (err) {
        logger.error(`portail anti-VPN : ${err.message}`);
      }
      if (tunnelWanted && !portalServer) {
        logger.error('tunnel anti-VPN annulé : le portail local n’a pas démarré (port occupé ?).');
      }
      if (tunnelWanted && portalServer) {
        try {
          // `rootDir` pointe sur src/ : le binaire vit dans <projet>/tools.
          const binary = await tunnelMod.ensureCloudflared({ rootDir: path.join(rootDir, '..'), env, logger });
          const tunnel = await tunnelMod.startQuickTunnel({
            port: Number(env.ANTIVPN_PORT),
            binary,
            logger,
            onExit: code => {
              env.ANTIVPN_PUBLIC_URL = '';
              logger.error(`tunnel anti-VPN interrompu (code ${code}) — redémarre le bot pour obtenir une nouvelle URL.`);
            },
          });
          env.ANTIVPN_PUBLIC_URL = tunnel.url;
          // Un tunnel rapide vient d'être créé : son DNS peut mettre une minute
          // à répondre. On attend avant de connecter Discord, sinon les premiers
          // membres recevraient un lien encore injoignable.
          const reachable = await tunnelMod.waitForDns(tunnel.url, { logger }).catch(() => false);
          logger.info(`🛰️ Anti-VPN prêt : portail public ${tunnel.url}`);
          if (!reachable) logger.warn('Portail anti-VPN : DNS du tunnel pas encore propagé — les liens peuvent échouer quelques instants.');
          logger.warn('Tunnel éphémère : l’URL change à chaque redémarrage, les liens déjà envoyés cessent de fonctionner.');
        } catch (err) {
          logger.error(`tunnel anti-VPN : ${err.message}`);
        }
      }
    }

    // ── Site marchand (STORE_PORT) ──────────────────────────────────────
    // Pages rendues à la requête et clés écrites dans la base du bot. Démarre
    // uniquement si le port est configuré, et sur un seul shard pour ne pas
    // ouvrir plusieurs écouteurs sur la même machine.
    if (env.STORE_PORT && isPrimaryShard(discord)) {
      try {
        const { startStoreServer } = require('../web/storeServer');
        await startStoreServer({ client: discord, env, logger });
      } catch (err) {
        logger.error(`site : ${err.message}`);
      }
    }

    // `clientReady` : nom actuel de l'événement (l'ancien `ready` est déprécié
    // et disparaîtra en discord.js v15).
    if (deploy) discord.once(Events.ClientReady, () => deployCommands(discord, { env, logger }).catch(() => {}));
    await loginWithRetry(discord, env.TOKEN, { logger });
  }

  return { ok: true, client: discord, commandData: commands.data, commands, crons };
}

module.exports = {
  ROOT,
  MAX_GLOBAL_COMMANDS,
  assertCommandBudget,
  duplicateCommandNames,
  validateEnv,
  createClient,
  loadCommands,
  loadEvents,
  registerCrons,
  connectDatabase,
  mongoOptions,
  autoIndexEnabled,
  deployCommands,
  loginWithRetry,
  shutdown,
  attachProcessGuards,
  boot,
  shardInfo,
  isPrimaryShard,
};
