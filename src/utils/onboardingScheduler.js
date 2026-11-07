'use strict';
// utils/onboardingScheduler.js — Relances, expirations et revues en attente.
//
// Un portail oublié ne doit pas rester ouvert indéfiniment : on relance une
// fois (MP + salon), on applique la limite de temps si elle est configurée, et
// on ferme les demandes de validation staff trop anciennes.

const OnboardingSession = require('../models/OnboardingSession');
const OnboardingConfig  = require('../models/OnboardingConfig');
const { isLicensed }    = require('./licenseGate');
const { serialized }    = require('./concurrency');

let schedulerStarted = false;
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// Statuts encore ouverts (une session sans statut vient de l'ancienne version).
const OPEN_STATUSES = ['in_progress', 'awaiting_captcha', 'pending_review'];

/** Faut-il envoyer la relance ? (pur, testable) */
function shouldRemind(session, cfg, now = Date.now()) {
  if (!cfg?.remindAfterMinutes) return false;
  if (session?.remindedAt) return false;
  if ((session?.status || 'in_progress') !== 'in_progress') return false;
  const started = new Date(session?.createdAt || 0).getTime();
  return Number.isFinite(started) && now - started >= cfg.remindAfterMinutes * 60_000;
}

/** Une demande de validation staff a-t-elle dépassé son délai ? (pur) */
function reviewExpired(session, cfg, now = Date.now()) {
  if (!cfg?.reviewTimeoutMinutes) return false;
  if (session?.status !== 'pending_review') return false;
  const since = new Date(session?.submittedAt || session?.createdAt || 0).getTime();
  return Number.isFinite(since) && now - since >= cfg.reviewTimeoutMinutes * 60_000;
}

async function runCheck(client) {
  const sessions = await OnboardingSession.find({
    completed: { $ne: true },
    status: { $in: [...OPEN_STATUSES, undefined] },
  }).catch(() => []);
  if (!sessions.length) return;

  const configCache  = new Map();
  const licenseCache = new Map();

  for (const session of sessions) {
    try {
      if (!licenseCache.has(session.guildId)) {
        licenseCache.set(session.guildId, await isLicensed(session.guildId).catch(() => false));
      }
      if (!licenseCache.get(session.guildId)) continue;

      let cfg = configCache.get(session.guildId);
      if (cfg === undefined) {
        cfg = await OnboardingConfig.findOne({ guildId: session.guildId, enabled: true });
        configCache.set(session.guildId, cfg);
      }
      if (!cfg) continue;

      const guild = await client.guilds.fetch(session.guildId).catch(() => null);
      if (!guild) continue;

      // ── Demande de validation staff expirée → refus automatique ─────────
      if (reviewExpired(session, cfg)) {
        const member = await guild.members.fetch(session.userId).catch(() => null);
        const channel = guild.channels.cache.get(session.channelId);
        const { denyAccess } = require('./onboardingManager');
        await denyAccess(member, session, cfg, channel, {
          decidedBy: client.user?.id,
          reason: 'délai de validation dépassé',
        }).catch(err => console.error('[Onboarding] refus automatique:', err.message));
        console.log(`⏱️ [Onboarding] Demande expirée — ${session.userId} sur ${session.guildId}`);
        continue;
      }

      if (session.status === 'pending_review') continue; // rien d'autre à faire

      // ── Relance unique ──────────────────────────────────────────────────
      if (shouldRemind(session, cfg)) {
        const member = await guild.members.fetch(session.userId).catch(() => null);
        const channel = guild.channels.cache.get(session.channelId);
        if (member) {
          await member.send({
            embeds: [{
              color: 0xFEE75C,
              description: `⏳ Ton portail d’accès sur **${guild.name}** est toujours ouvert. `
                + 'Réponds aux dernières questions pour recevoir tes rôles.',
            }],
          }).catch(() => {});
        }
        if (channel && cfg.mode !== 'shared') {
          await channel.send({
            embeds: [{ color: 0xFEE75C, description: `⏳ <@${session.userId}> — il reste des étapes pour accéder au serveur.` }],
            allowedMentions: { users: [session.userId] },
          }).catch(() => {});
        }
        session.remindedAt = new Date();
        await session.save().catch(() => {});
        continue;
      }

      // ── Limite de temps ─────────────────────────────────────────────────
      if (cfg.timeoutMinutes <= 0 || cfg.timeoutAction !== 'kick') continue;
      const elapsedMs = Date.now() - new Date(session.createdAt).getTime();
      if (elapsedMs < cfg.timeoutMinutes * 60 * 1000) continue;

      const member = await guild.members.fetch(session.userId).catch(() => null);
      const channel = guild.channels.cache.get(session.channelId);

      if (member?.kickable) {
        await member.kick('Portail d’accès non complété dans le délai imparti').catch(() => {});
      }
      if (channel && !(cfg.mode === 'shared' && cfg.sharedChannelId === channel.id)) {
        await channel.delete('Délai du portail expiré').catch(() => {});
      }

      cfg.totalTimedOut = (cfg.totalTimedOut || 0) + 1;
      await cfg.save().catch(() => {});

      await OnboardingSession.deleteOne({ _id: session._id }).catch(() => {});

      console.log(`⏱️ [Onboarding] Expulsion auto (délai dépassé) — ${session.userId} sur ${session.guildId}`);
    } catch (err) {
      console.error('[Onboarding] Scheduler:', err.message);
    }
  }
}

// Anti-chevauchement : chaque session non terminée provoque un aller-retour
// Discord ; sur un gros parc un passage peut dépasser l'intervalle de 2 minutes.
const runCheckGuarded = serialized(runCheck, {
  name: 'onboarding',
  onSkip: () => console.warn('[Onboarding] passage précédent encore en cours — passage ignoré'),
});

function startOnboardingScheduler(client) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  setTimeout(() => runCheckGuarded(client).catch(err => console.error('[Onboarding] Scheduler:', err.message)), 20 * 1000);
  setInterval(() => runCheckGuarded(client).catch(err => console.error('[Onboarding] Scheduler:', err.message)), CHECK_INTERVAL_MS);

  console.log('🚪 [Onboarding] Planificateur démarré (relances, délais et validations — toutes les 2 minutes).');
}

module.exports = { startOnboardingScheduler, shouldRemind, reviewExpired };
