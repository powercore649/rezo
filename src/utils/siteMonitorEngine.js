'use strict';
// utils/siteMonitorEngine.js — Décisions et alertes de la surveillance de sites.
//
// Séparé du modèle et du réseau pour rester testable : `evaluateSite` est une
// fonction pure (état précédent + résultat → nouvel état + alerte), et
// `checkConfig` accepte un `fetchImpl` ainsi qu'un `notify` injectables.

const { Types } = require('mongoose');
const SiteMonitor = require('../models/SiteMonitor');
const { visibleGuildIds } = require('../core/sharding');
const {
  DEFAULT_MAINTENANCE_KEYWORDS,
  MAX_SITES,
  MAX_CHECKS_PER_RUN,
  DEFAULT_FAILURE_THRESHOLD,
  checkSite,
  validateSiteUrl,
  formatResponseMs,
  formatAgo,
  formatDuration,
  availability,
  statusMeta,
} = require('./siteStatus');

// ─── Délais ─────────────────────────────────────────────────────────────────
/** Un site est vérifié si son dernier contrôle dépasse l'intervalle configuré. */
function siteIsDue(site, intervalMinutes, now = Date.now()) {
  if (!site?.lastCheckedAt) return true;
  const interval = Math.max(1, Number(intervalMinutes) || 15) * 60_000;
  const last = new Date(site.lastCheckedAt).getTime();
  if (!Number.isFinite(last)) return true;
  // Marge de 5 s : le cron tourne à la minute, sans elle un intervalle de 5 min
  // serait vérifié à 6 minutes d'écart une fois sur deux.
  return new Date(now).getTime() - last >= interval - 5000;
}

/**
 * Calcule le nouvel état d'un site après un contrôle.
 * Fonction PURE : aucun accès base, aucune mutation de `site`.
 *
 * @param {object} site état actuel (document ou objet simple)
 * @param {{status:string,statusCode:number|null,responseMs:number|null,error:string|null}} probe
 * @param {{failureThreshold?:number, now?:Date}} [options]
 * @returns {{next:object, alert:('down'|'maintenance'|'recovered'|null), previous:string}}
 */
function evaluateSite(site = {}, probe = {}, { failureThreshold = DEFAULT_FAILURE_THRESHOLD, now = new Date() } = {}) {
  const previous = site.status || 'unknown';
  const threshold = Math.max(1, Number(failureThreshold) || DEFAULT_FAILURE_THRESHOLD);
  const status = probe.status || 'down';

  const next = {
    status,
    statusCode: probe.statusCode ?? null,
    responseMs: probe.responseMs ?? null,
    error: probe.error ? String(probe.error).slice(0, 300) : null,
    lastCheckedAt: now,
    checks: Number(site.checks || 0) + 1,
    upChecks: Number(site.upChecks || 0) + (status === 'online' ? 1 : 0),
    failures: status === 'online' ? 0 : Number(site.failures || 0) + 1,
    lastChangeAt: site.lastChangeAt ? new Date(site.lastChangeAt) : null,
    since: site.since ? new Date(site.since) : null,
  };

  if (status !== previous) {
    next.lastChangeAt = now;
    next.since = now;
  }

  let alertedStatus = site.alertedStatus || null;
  let alert = null;

  if (status === 'online') {
    if (alertedStatus && alertedStatus !== 'online') alert = 'recovered';
    alertedStatus = 'online';
  } else if (status === 'maintenance') {
    // La maintenance est un état volontaire : signalée dès qu'elle apparaît.
    if (alertedStatus !== 'maintenance') alert = 'maintenance';
    alertedStatus = 'maintenance';
  } else {
    // Hors ligne : on attend le seuil d'échecs consécutifs pour éviter le bruit
    // d'un simple pic réseau.
    if (alertedStatus !== 'down' && next.failures >= threshold) {
      alert = 'down';
      alertedStatus = 'down';
    }
  }

  next.alertedStatus = alertedStatus;
  return { next, alert, previous };
}

/** Applique le résultat au document/objet `site` et renvoie l'alerte éventuelle. */
function applyEvaluation(site, probe, options = {}) {
  const { next, alert } = evaluateSite(site, probe, options);
  Object.assign(site, next);
  return alert;
}

// ─── Configuration ──────────────────────────────────────────────────────────
function siteDisplayName(site) {
  if (site?.label) return site.label;
  try {
    return new URL(site.url).hostname;
  } catch {
    return site?.url || 'site';
  }
}

function normalizeUrlKey(url) {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

/** Mots-clés saisis par l'utilisateur (virgules ou retours à la ligne). */
function parseKeywords(raw, { max = 20, maxLength = 40 } = {}) {
  const parts = String(raw || '')
    .split(/[,\n;]/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.slice(0, maxLength));

  const seen = new Set();
  const keywords = [];
  for (const keyword of parts) {
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= max) break;
  }
  return keywords;
}

/** Mots de maintenance réellement appliqués à un site (le site prime). */
function effectiveKeywords(config, site) {
  if (site?.maintenanceKeywords?.length) return site.maintenanceKeywords;
  if (config?.maintenanceKeywords?.length) return config.maintenanceKeywords;
  return DEFAULT_MAINTENANCE_KEYWORDS;
}

/**
 * Ajoute un site à la configuration (validation + doublon + quota).
 * @returns {{ok:boolean,error?:string,site?:object}}
 */
function addSite(config, { url, label = null, keywords = [] } = {}) {
  const validation = validateSiteUrl(url);
  if (!validation.ok) return { ok: false, error: validation.error };

  const sites = config.sites || [];
  if (sites.length >= MAX_SITES) {
    return { ok: false, error: `Limite atteinte : ${MAX_SITES} sites maximum par serveur.` };
  }
  const key = normalizeUrlKey(validation.url);
  if (sites.some(site => normalizeUrlKey(site.url) === key)) {
    return { ok: false, error: 'Ce site est déjà surveillé.' };
  }

  const site = {
    // Identifiant stable même hors Mongoose : le panel et les tests ciblent un site
    // précis (vérifier, mettre en pause, supprimer).
    _id: new Types.ObjectId(),
    url: validation.url,
    label: label ? String(label).trim().slice(0, 80) : null,
    enabled: true,
    status: 'unknown',
    statusCode: null,
    responseMs: null,
    error: null,
    lastCheckedAt: null,
    lastChangeAt: null,
    since: null,
    failures: 0,
    checks: 0,
    upChecks: 0,
    alertedStatus: null,
    maintenanceKeywords: Array.isArray(keywords) ? keywords.slice(0, 20) : [],
  };
  config.sites = [...sites, site];
  return { ok: true, site };
}

function findSite(config, siteId) {
  return (config?.sites || []).find(site => String(site._id) === String(siteId)) || null;
}

function removeSite(config, siteId) {
  const site = findSite(config, siteId);
  if (!site) return { ok: false, error: 'Site introuvable.' };
  config.sites = config.sites.filter(item => String(item._id) !== String(siteId));
  return { ok: true, site };
}

// ─── Alertes ────────────────────────────────────────────────────────────────
const ALERT_HEADLINE = {
  down:        '🔴 **{site}** ne répond plus.',
  maintenance: '🟠 **{site}** est en maintenance.',
  recovered:   '🟢 **{site}** est de nouveau en ligne (indisponible {durée}).',
};

function renderTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

function alertVars(config, site, probeStatus = null) {
  const status = probeStatus || site.status;
  const meta = statusMeta(status);
  return {
    site: siteDisplayName(site),
    url: site.url,
    statut: meta.label,
    code: site.statusCode ?? '—',
    temps: formatResponseMs(site.responseMs),
    durée: formatDuration(site.since),
    serveur: config?.guildId || '',
  };
}

/** Embed d'alerte (transition d'état) — partagé par le planificateur et la commande. */
function buildAlertEmbed(config, site, alert, { now = new Date() } = {}) {
  const meta = statusMeta(site.status);
  const { EmbedBuilder } = require('discord.js');
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${siteDisplayName(site)} — ${meta.label}`)
    .addFields(
      { name: 'URL', value: `[${site.url}](${site.url})`.slice(0, 1024), inline: false },
      { name: 'Code HTTP', value: site.statusCode ? `\`${site.statusCode}\`` : '*aucun*', inline: true },
      { name: 'Temps de réponse', value: formatResponseMs(site.responseMs), inline: true },
      { name: 'Disponibilité', value: availability(site) === null ? '—' : `${availability(site)} %`, inline: true },
    );

  if (alert === 'recovered') {
    embed.addFields({ name: 'Indisponible pendant', value: formatDuration(site.since, now), inline: true });
  } else {
    embed.addFields({ name: 'Depuis', value: site.since ? formatAgo(site.since, now) : '—', inline: true });
  }
  if (site.error) embed.addFields({ name: 'Détail', value: site.error.slice(0, 300), inline: false });

  embed.setFooter({ text: `Surveillance de sites • vérifié ${formatAgo(site.lastCheckedAt, now)}` }).setTimestamp(now);
  return embed;
}

/** Contenu textuel de l'alerte : message personnalisé du serveur, sinon modèle par défaut. */
function buildAlertContent(config, site, alert, now = new Date()) {
  const vars = alertVars(config, site);
  if (config?.alertMessage) return renderTemplate(config.alertMessage, vars).slice(0, 2000);
  return renderTemplate(ALERT_HEADLINE[alert] || ALERT_HEADLINE.down, vars).slice(0, 2000);
}

/** Envoie l'alerte dans le salon configuré. Ne lève jamais : une alerte ne doit pas casser le cron. */
async function sendAlert(client, { config, site, alert }) {
  if (!config?.channelId) return false;
  const guild = client?.guilds?.cache?.get(config.guildId)
    || await client?.guilds?.fetch?.(config.guildId).catch(() => null);
  if (!guild) return false;

  let channel = guild.channels?.cache?.get(config.channelId);
  if (!channel?.isTextBased?.()) channel = await guild.channels?.fetch?.(config.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    console.warn(`[SiteMonitor] salon d'alerte introuvable (${config.guildId}/${config.channelId})`);
    return false;
  }

  const permissions = channel.permissionsFor?.(guild.members?.me);
  if (permissions && !permissions.has(['SendMessages', 'EmbedLinks'])) return false;

  try {
    await channel.send({
      content: buildAlertContent(config, site, alert),
      embeds: [buildAlertEmbed(config, site, alert)],
    });
    return true;
  } catch (err) {
    console.warn(`[SiteMonitor] envoi de l'alerte impossible : ${err.message}`);
    return false;
  }
}

// ─── Exécution ──────────────────────────────────────────────────────────────
/**
 * Vérifie les sites dus d'une configuration, met à jour l'état et signale les
 * transitions via `notify` (injecté pour les tests).
 */
async function checkConfig(config, {
  fetchImpl = fetch,
  now = new Date(),
  force = false,
  only = null,
  notify = null,
  allowPrivate = false,
} = {}) {
  const onlyIds = only ? new Set((Array.isArray(only) ? only : [only]).map(String)) : null;

  const targets = (config?.sites || [])
    // En vérification ciblée, on vérifie aussi un site mis en pause (contrôle manuel).
    .filter(site => (onlyIds ? onlyIds.has(String(site._id)) : site.enabled !== false))
    .filter(site => (force ? true : siteIsDue(site, config.intervalMinutes, now)))
    .slice(0, MAX_CHECKS_PER_RUN);

  const alerts = [];
  for (const site of targets) {
    let probe;
    try {
      probe = await checkSite(site, {
        fetchImpl,
        keywords: effectiveKeywords(config, site),
        allowPrivate,
      });
    } catch (err) {
      probe = { status: 'down', statusCode: null, responseMs: null, error: err?.message || 'Erreur inattendue.' };
    }

    const alert = applyEvaluation(site, probe, { failureThreshold: config.failureThreshold, now });
    if (alert) {
      alerts.push({ site, alert });
      if (typeof notify === 'function') {
        await notify({ config, site, alert }).catch(err => console.warn('[SiteMonitor] notify:', err.message));
      }
    }
  }

  if (targets.length && typeof config?.save === 'function') {
    await config.save();
  }

  return { checked: targets.length, alerts };
}

let running = false;
/** Réinitialise le verrou (tests uniquement). */
function resetRunning() { running = false; }
function isRunning() { return running; }

/**
 * Contrôle tous les serveurs activés. Un seul passage à la fois : si une
 * vérification est encore en cours (site très lent), on saute ce tour.
 */
async function runSiteChecks(client, { fetchImpl = fetch, now = new Date(), allowPrivate = false } = {}) {
  if (running) return { skipped: true, guilds: 0, checked: 0, alerts: 0 };
  running = true;
  let guilds = 0;
  let checked = 0;
  let alertCount = 0;

  try {
    // En mode shardé, seuls les sites des serveurs visibles par ce processus :
    // sinon N shards vérifieraient les mêmes URL et enverraient N alertes.
    const ids = visibleGuildIds(client);
    const query = { enabled: true, 'sites.0': { $exists: true } };
    if (ids !== null) query.guildId = { $in: ids };
    const configs = await SiteMonitor.find(query);
    for (const config of configs) {
      // Un serveur sans salon configuré continue d'être vérifié : l'état reste
      // consultable dans le panel, seule la notification manque.
      const result = await checkConfig(config, {
        fetchImpl,
        now,
        allowPrivate,
        notify: async payload => {
          const sent = await sendAlert(client, payload);
          if (sent) alertCount++;
        },
      }).catch(err => {
        console.error(`[SiteMonitor] ${config.guildId}:`, err.message);
        return { checked: 0, alerts: [] };
      });
      guilds++;
      checked += result.checked;
    }
  } finally {
    running = false;
  }

  return { skipped: false, guilds, checked, alerts: alertCount };
}

module.exports = {
  ALERT_HEADLINE,
  siteIsDue,
  evaluateSite,
  applyEvaluation,
  siteDisplayName,
  normalizeUrlKey,
  parseKeywords,
  effectiveKeywords,
  addSite,
  findSite,
  removeSite,
  renderTemplate,
  alertVars,
  buildAlertEmbed,
  buildAlertContent,
  sendAlert,
  checkConfig,
  runSiteChecks,
  resetRunning,
  isRunning,
};
