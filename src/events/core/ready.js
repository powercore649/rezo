const { resetWeeklyBumps, resetMonthlyBumps, resetDailyVotes } = require('../../utils/bumpNetwork');
const { applyBotStatus } = require('../../utils/botStatus');
const { isPrimaryShard, shardInfo } = require('../../core/sharding');

const MAX_TIMEOUT_MS = 2_147_483_647;

module.exports = {
  // `clientReady` est le nom actuel de l'événement (discord.js 14 le déprécie
  // sous l'ancien nom `ready`, supprimé en v15).
  name: 'clientReady',
  once: true,
  async execute(client) {
    const where = shardInfo(client);
    // Le shard 0 exécute les tâches globales (une seule fois) ; les tâches qui
    // ont besoin du cache local (bans, quarantaines, invitations…) tournent sur
    // chaque shard, mais uniquement pour les serveurs qu'il voit.
    const primary = isPrimaryShard(client);
    console.log(
      `✅ ${client.user.tag} en ligne sur ${client.guilds.cache.size} serveur(s)`
      + (where.sharded ? ` — shard ${where.current}/${where.count}` : ''),
    );

    // ── Blacklist globale — charge le cache puis expulse les serveurs déjà rejoints ──
    try {
      const blacklist = require('../../utils/blacklist');
      await blacklist.initCache();
      for (const guild of client.guilds.cache.values()) {
        if (blacklist.isBlacklisted(guild.id)) {
          console.warn(`⛔ ${guild.name} (${guild.id}) blacklisté — départ automatique.`);
          await guild.leave().catch(() => {});
        }
      }
    } catch (err) {
      console.error('blacklist init:', err.message);
    }

    // ── Licences — amorce le cache des serveurs licenciés (bump, territoires…) ──
    try {
      const licenseGate = require('../../utils/licenseGate');
      await licenseGate.initCache();

      // Balayage périodique : les licences dont la période de grâce se termine
      // sont réévaluées et les essais expirés marqués. Aucune donnée n'est
      // supprimée — une licence expirée reste prolongeable et transférable.
      const sweep = () => licenseGate.sweepExpired()
        .then(r => {
          if (r.expired || r.grace || r.trials) {
            console.log(`🔐 Licences : ${r.expired} expirée(s), ${r.grace} en grâce, ${r.trials} essai(s) clos`);
          }
        })
        .catch(err => console.error('license sweep:', err.message));
      sweep();
      setInterval(sweep, 6 * 3_600_000).unref?.();
    } catch (err) {
      console.error('licenseGate init:', err.message);
    }

    // ── Devis Pack REZO.net — les demandes du site arrivent en MP de l'owner ──
    // Tâche globale (MP au propriétaire, puis à l'acheteur) : shard 0 seulement,
    // sinon chaque shard enverrait la même carte.
    if (primary) {
      try {
        const { startQuoteNotifier } = require('../../utils/quoteNotifier');
        startQuoteNotifier(client);
      } catch (err) {
        console.error('quoteNotifier init:', err.message);
      }
    }

    // ── Statut du bot — config persistée, modifiable via /status ─────────
    await applyBotStatus(client);

    // ── Rappels de bump — gérés uniquement via cron dans index.js (5 min) ──
    // (auparavant dupliqué ici avec un second setInterval, ce qui causait des
    // rappels envoyés en double à quelques minutes d'écart — supprimé.)

    // ── Unban automatique (tempban) — toutes les minutes ─────────────────
    // Chaque shard ne lève que les bans de SES serveurs (les autres lignes sont
    // laissées en attente, jamais marquées « fait » à tort).
    setInterval(async () => {
      try {
        const { sweepExpiredTempBans } = require('../../utils/tempBanSweep');
        const s = await sweepExpiredTempBans(client, { logger: console });
        if (s.failed) console.warn(`⚠️ Unban auto : ${s.failed} échec(s) (nouvelle tentative au prochain passage)`);
      } catch (err) {
        console.error('unban auto:', err.message);
      }
    }, 60_000);

    // ── Reprendre les rappels utilisateur en attente (survie redémarrage) ─
    // Tâche globale (MP à n'importe quel membre) : shard 0 uniquement, sinon
    // chaque shard enverrait le même rappel.
    if (primary) setTimeout(async () => {
      try {
        const Reminder = require('../../models/Reminder');
        const pending  = await Reminder.find({ done: false, remindAt: { $gt: new Date() } });
        for (const rem of pending) {
          const delay = new Date(rem.remindAt).getTime() - Date.now();
          if (delay <= 0) { rem.done = true; await rem.save(); continue; }
          if (delay > MAX_TIMEOUT_MS) continue;
          setTimeout(async () => {
            try {
              const user = await client.users.fetch(rem.userId);
              await user.send({ content: `⏰ **Rappel :** ${rem.message}` });
            } catch {
              // Le salon peut appartenir à un autre shard : on le résout par
              // REST plutôt que de se fier au cache local du shard 0.
              const ch = client.channels.cache.get(rem.channelId)
                || await client.channels.fetch(rem.channelId).catch(() => null);
              if (ch) ch.send({ content: `<@${rem.userId}> ⏰ Rappel : **${rem.message}**` }).catch(() => {});
            }
            await Reminder.findByIdAndUpdate(rem._id, { done: true });
          }, delay);
        }
        if (pending.length) console.log(`✅ ${pending.length} rappel(s) repris`);
      } catch (err) {
        console.error('reminders reprise:', err.message);
      }
    }, 5_000);

    // ── Territoires : décroissance power — toutes les 30 min ─────────────
    // Écriture globale en base : un seul passage, sur le shard 0.
    if (primary) {
      try {
        const { ensureMapInitialized, decayPower } = require('../../utils/territoryEngine');
        await ensureMapInitialized().catch(console.error);
        setInterval(() => decayPower().catch(console.error), 30 * 60 * 1000);
      } catch (err) {
        console.error('territoryEngine init:', err.message);
      }
    }

    // ── Resets planifiés sans overflow 32-bit (global, shard 0) ───────────
    if (primary) scheduleCron(client);

    // ── Anniversaires — rattrapage au démarrage ───────────────────────────
    // Le cron tourne toutes les heures ; ce passage immédiat évite d'attendre
    // jusqu'à 55 minutes après un redémarrage pour souhaiter un anniversaire.
    setTimeout(() => {
      try {
        const { checkBirthdays } = require('../../utils/birthdayScheduler');
        checkBirthdays(client).catch(err => console.error('anniversaires (démarrage):', err.message));
      } catch (err) {
        console.error('anniversaires (démarrage):', err.message);
      }
    }, 15_000);

    // ── Vanity par statut — rattrapage immédiat au démarrage ──────────────
    // Le cron ne passe que toutes les 10 minutes : sans ce passage, un membre
    // qui affichait déjà le statut attendait jusqu'à 10 min après un
    // redémarrage. Chaque shard ne traite que SES serveurs (cache local).
    setTimeout(() => {
      try {
        const vanity = require('../../utils/vanityEngine');
        vanity.sweepAll(client)
          .then((totals) => {
            if (totals.granted || totals.revoked) {
              console.log(
                `💎 Vanity (démarrage) : ${totals.granted} rôle(s) attribué(s), `
                + `${totals.revoked} retiré(s) sur ${totals.guilds} serveur(s)`,
              );
            }
          })
          .catch(err => console.error('vanity (démarrage):', err.message));
      } catch (err) {
        console.error('vanity (démarrage):', err.message);
      }
    }, 5_000);

    // ── FreeGames — Scheduler autonome (post quotidien + catch-up) ────────
    // Le post s'appuie sur le cache du serveur (salon, permissions) : chaque
    // shard traite ses serveurs, sinon ceux des autres ne reçoivent jamais rien.
    setTimeout(() => {
      try {
        const { startFreeGamesScheduler } = require('../../utils/freeGamesScheduler');
        startFreeGamesScheduler(client);
      } catch (err) {
        console.error('freeGamesScheduler:', err.message);
      }
    }, 10_000); // Attendre 10s que MongoDB soit prêt

    // ── Reddit — plus de planificateur séparé : les subreddits suivis sont
    // fusionnés au flux d'actualités (autoPostNews), donc un seul passage,
    // un seul anti-doublon, un seul jeu de notifications.

    // ── StreamAlerts — Planificateur Twitch (2 min) & YouTube (5 min) ─────
    setTimeout(() => {
      try {
        const { startStreamAlertScheduler } = require('../../utils/streamAlertScheduler');
        startStreamAlertScheduler(client);
      } catch (err) {
        console.error('streamAlertScheduler:', err.message);
      }
    }, 16_000);

    // ── Onboarding — Planificateur du délai limite ─────────────────────────
    // Expulsions via REST → shard 0 uniquement.
    if (primary) setTimeout(() => {
      try {
        const { startOnboardingScheduler } = require('../../utils/onboardingScheduler');
        startOnboardingScheduler(client);
      } catch (err) {
        console.error('onboardingScheduler:', err.message);
      }
    }, 14_000);

    // ── News — vérification toutes les 15 minutes ────────────────────────
    setTimeout(() => {
      const runNews = async () => {
        try {
          const { autoPostNews } = require('../../commands/communaute/news');
          await autoPostNews(client);
        } catch(err) { console.error('[News] scheduler:', err.message); }
      };
      runNews();
      setInterval(runNews, 15 * 60 * 1000);
    }, 20_000);

    // ── Nettoyage des configs pointant vers salons/rôles supprimés ───────
    setTimeout(() => {
      try {
        const { cleanupStaleData } = require('../../utils/startupCleanup');
        cleanupStaleData(client)
          .then((s) => {
            if (s.channelsCleared || s.rolesCleared || s.docsDeleted) {
              console.log(`🧹 Nettoyage démarrage : ${s.channelsCleared} salon(s), ${s.rolesCleared} rôle(s), ${s.docsDeleted} doc(s) obsolète(s)`);
            }
            // Une protection active dont la cible a disparu n'est jamais
            // éteinte en silence : on le dit haut et fort au démarrage.
            if (s.securityAlerts) {
              console.warn(`⛔ ${s.securityAlerts} alerte(s) de sécurité : un module de protection est actif mais incomplet (voir /securite).`);
            }
          })
          .catch((err) => console.error('startupCleanup:', err.message));
      } catch (err) {
        console.error('startupCleanup:', err.message);
      }
    }, 30_000);

    // ── Coffre-fort de permissions — recalage puis veille continue ──────
    // Les modifications faites pendant un arrêt du bot ne produisent aucune
    // entrée d'audit en direct : on compare donc au démarrage, puis toutes les
    // 10 minutes, pour que le coffre ne reste jamais « ouvert en silence ».
    setTimeout(async () => {
      try {
        const { reconcileAll } = require('../../utils/permissionVault');
        const run = async (label) => {
          const r = await reconcileAll(client);
          if (r.reverted || r.missing) {
            console.warn(`🗄️ Coffre-fort ${label} : ${r.checked} cible(s), ${r.drifted} écart(s), ${r.reverted} refermé(s), ${r.missing} disparue(s)`);
          }
          return r;
        };
        await run('au démarrage');
        setInterval(() => run('veille').catch(() => {}), 10 * 60_000);
      } catch (err) {
        console.error('permissionVault reconcile:', err.message);
      }
    }, 36_000);

    // ── Préfixe hybride — amorçage du cache des configs activées ────────
    try {
      const { initCache } = require('../../utils/prefixCommands');
      await initCache(client);
    } catch (err) {
      console.error('prefixCommands init:', err.message);
    }

    // ── Invitations avancées : amorçage du cache pour chaque serveur ─────
    try {
      const { primeGuildCache } = require('../../utils/inviteCache');
      for (const guild of client.guilds.cache.values()) {
        primeGuildCache(guild).catch(err =>
          console.error(`[inviteCache] amorçage échoué pour ${guild.id}:`, err.message));
      }
      console.log(`✅ Cache d'invitations amorcé pour ${client.guilds.cache.size} serveur(s)`);
    } catch (err) {
      console.error('inviteCache amorçage:', err.message);
    }

    // ── Anti-raid — reprise après redémarrage ────────────────────────────────
    // Un redémarrage pendant un raid perdait le minuteur de levée : le rideau
    // DISCON et le verrouillage restaient en place sans fin. On les traite ici.
    try {
      const { recoverRaidState } = require('../../utils/antiraidActions');
      const rec = await recoverRaidState(client);
      if (rec.restored || rec.rearmed || rec.awaiting) {
        console.log(`🛡️ Anti-raid — reprise : ${rec.restored} raid(s) clos, ${rec.rearmed} minuteur(s) réarmé(s), ${rec.awaiting} en attente d’un admin`);
      }
    } catch (err) {
      console.error('recoverRaidState:', err.message);
    }

    // ── Anti-raid — libération automatique des quarantaines échues (2 min) ──
    setInterval(async () => {
      try {
        const { AntiRaid } = require('../../models/AntiRaid');
        const { releaseQuarantine } = require('../../utils/antiraidActions');
        const configs = await AntiRaid.find({ quarantineDurationMin: { $gt: 0 } });
        for (const cfg of configs) {
          const due = (cfg.quarantined || []).filter(q => Date.now() - new Date(q.at).getTime() >= cfg.quarantineDurationMin * 60_000);
          if (!due.length) continue;
          const guild = client.guilds.cache.get(cfg.guildId);
          if (!guild) continue;
          for (const q of due) {
            await releaseQuarantine(client, guild, cfg, q.userId).catch(() => {});
          }
        }
      } catch (err) { console.error('antiraid quarantine timer:', err.message); }
    }, 120_000);

    // ── Giveaways — reprogramme les timers perdus au redémarrage ────────
    // Les timers passent par REST : un seul processus les arme (shard 0).
    if (primary) setTimeout(async () => {
      try {
        const { rescheduleActiveGiveaways } = require('../../commands/communaute/giveaway');
        const { rescheduled, endedImmediately } = await rescheduleActiveGiveaways(client);
        if (rescheduled + endedImmediately > 0) {
          console.log(`🎉 Giveaways repris : ${rescheduled} reprogrammé(s), ${endedImmediately} terminé(s) immédiatement`);
        }
      } catch (err) {
        console.error('rescheduleActiveGiveaways:', err.message);
      }
    }, 8_000); // attendre 8s que MongoDB soit stable

    // ── Salon d'attente — recalage de la file après un redémarrage ───────
    // Les membres présents dans le salon vocal au démarrage sont remis en
    // file ; ceux qui en sont sortis pendant l'arrêt sont retirés (et perdent
    // leur rôle d'attente).
    setTimeout(async () => {
      try {
        const { reconcile } = require('../../utils/waitingRoom');
        const touched = await reconcile(client);
        if (touched) console.log(`🎧 Salon d'attente : file recalée sur ${touched} serveur(s)`);
      } catch (err) {
        console.error('waitingroom reconcile:', err.message);
      }
    }, 18_000);

    console.log(
      `✅ Tâches planifiées démarrées${where.sharded
        ? ` (shard ${where.current}/${where.count}${primary ? ' — tâches globales incluses' : ''})`
        : ''}`,
    );
  },
};

// ─── Cron maison — vérifie toutes les minutes, jamais d'overflow 32-bit ──────
function scheduleCron(client) {
  let lastWeeklyReset   = null; // "YYYY-Www"
  let lastMonthlyReset  = null; // "YYYY-MM"
  let lastDailyReset    = null; // "YYYY-MM-DD"

  setInterval(async () => {
    const now  = new Date();
    const h    = now.getUTCHours();
    const m    = now.getUTCMinutes();
    const day  = now.getUTCDay();
    const dom  = now.getUTCDate();

    const weekKey  = `${now.getUTCFullYear()}-W${isoWeek(now)}`;
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const dayKey   = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;

    // ── Reset votes quotidiens — 00:00 UTC ───────────────────────────────
    if (h === 0 && m === 0 && lastDailyReset !== dayKey) {
      lastDailyReset = dayKey;
      console.log('🔄 Reset votes quotidiens...');
      await resetDailyVotes().catch(err => console.error('resetDailyVotes:', err.message));
    }

    // ── Reset bumps hebdomadaires — lundi 00:00 UTC ───────────────────────
    if (day === 1 && h === 0 && m === 0 && lastWeeklyReset !== weekKey) {
      lastWeeklyReset = weekKey;
      console.log('🔄 Reset bumps hebdomadaires...');
      await resetWeeklyBumps().catch(err => console.error('resetWeeklyBumps:', err.message));
    }

    // ── Reset bumps mensuels — 1er du mois 00:00 UTC ─────────────────────
    if (dom === 1 && h === 0 && m === 0 && lastMonthlyReset !== monthKey) {
      lastMonthlyReset = monthKey;
      console.log('🔄 Reset bumps mensuels...');
      await resetMonthlyBumps().catch(err => console.error('resetMonthlyBumps:', err.message));
    }

  }, 60_000); // vérification toutes les 60s — jamais d'overflow 32-bit
}

// ─── Numéro de semaine ISO 8601 ───────────────────────────────────────────────
function isoWeek(date) {
  const d   = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
