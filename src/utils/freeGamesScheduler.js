'use strict';
// utils/freeGamesScheduler.js — Planificateur robuste pour les jeux gratuits
// Indépendant du cron de ready.js — tourne en boucle toutes les minutes.

const { FreeGamesConfig, PostedGame } = require('../models/FreeGames');
const { COLORS } = require('./embeds');
const { guildScope, ownsGuild } = require('../core/sharding');

let schedulerStarted = false;

// ─── Clé du jour courant UTC ──────────────────────────────────────────────────
function todayUTC() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth()+1).padStart(2,'0')}-${String(n.getUTCDate()).padStart(2,'0')}`;
}

// ─── Heure UTC actuelle ───────────────────────────────────────────────────────
function nowUTC() {
  const n = new Date();
  return { h: n.getUTCHours(), m: n.getUTCMinutes() };
}

// ─── Poster pour un serveur ───────────────────────────────────────────────────
async function postForGuild(client, config) {
  try {
    // Ceinture de sécurité : ne jamais marquer « posté aujourd'hui » depuis un
    // processus qui ne voit pas le serveur (le vrai shard sauterait le tour).
    if (!ownsGuild(client, config.guildId)) return 0;
    const { postFreeGames } = require('../commands/communaute/freegames');
    const result = await postFreeGames(client, config.guildId, config.channelId, {
      roleId:            config.roleId,
      epicEnabled:       config.epicEnabled,
      steamEnabled:      config.steamEnabled,
      gamerPowerEnabled: config.gamerPowerEnabled,
      checkDuplicates:   true,
    });

    // Marquer comme posté en BDD
    await FreeGamesConfig.findOneAndUpdate(
      { guildId: config.guildId },
      { lastAutoPost: todayUTC() }
    );

    if (result.posted > 0) {
      console.log(`✅ [FreeGames] ${result.posted} jeu(x) posté(s) → ${config.guildId}`);

      // Notifier les abonnés
      try {
        const { sendNotification } = require('./notificationManager');
        const { EmbedBuilder }     = require('discord.js');
        const embed = new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(`🎮 ${result.posted} nouveau(x) jeu(x) gratuit(s) !`)
          .setDescription('De nouveaux jeux gratuits sont disponibles !\n\nUtilisez `/freegames voir` pour les découvrir.')
          .setTimestamp();
        await sendNotification(client, config.guildId, 'freeGames', embed, `${result.posted} jeux gratuits`);
      } catch (_) {}
    }

    return result.posted;
  } catch (err) {
    console.error(`[FreeGames] Erreur post ${config.guildId}:`, err.message);
    return 0;
  }
}

// ─── Vérifier si un serveur doit être posté maintenant ───────────────────────
function shouldPost(config) {
  const today = todayUTC();
  const { h }  = nowUTC();

  // Déjà posté aujourd'hui ?
  if (config.lastAutoPost === today) return false;

  // L'heure de post configurée (format "HH:MM", défaut "10:00")
  const [targetH] = (config.postTime || '10:00').split(':').map(Number);

  // On peut poster si on est >= à l'heure configurée
  return h >= targetH;
}

// ─── Lancer le scheduler ──────────────────────────────────────────────────────
function startFreeGamesScheduler(client) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  console.log('🎮 [FreeGames] Scheduler démarré');

  // Anti-chevauchement : un parc de plusieurs milliers de serveurs peut faire
  // durer un passage plus longtemps que l'intervalle de 5 minutes.
  const run = serialized(async () => {
    try {
      // Récupérer tous les serveurs avec auto-post activé
      // Chaque shard ne poste que pour ses serveurs (le post utilise le cache).
      const configs = await FreeGamesConfig.find(guildScope(client, {
        enabled:   true,
        autoPost:  true,
        channelId: { $ne: null },
      }));

      for (const config of configs) {
        if (shouldPost(config)) {
          await postForGuild(client, config);
        }
      }
    } catch (err) {
      console.error('[FreeGames] Scheduler error:', err.message);
    }
  }, {
    name: 'free-games',
    onSkip: () => console.warn('[FreeGames] passage précédent encore en cours — passage ignoré'),
  });

  // Vérifier immédiatement au démarrage (catch-up)
  setTimeout(run, 10_000);

  // Puis toutes les 5 minutes (plus fiable que 60s)
  setInterval(run, 5 * 60 * 1000);
}

module.exports = { startFreeGamesScheduler };
