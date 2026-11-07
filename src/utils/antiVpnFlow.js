'use strict';
// utils/antiVpnFlow.js — Parcours complet de vérification anti-VPN.
//
// Aucune API Discord ne donne l'IP d'un membre. Le parcours est donc :
//   1. à l'arrivée, le bot poste (et/ou envoie en MP) un lien de vérification ;
//   2. le membre l'ouvre dans son navigateur → src/web/verifyServer.js lit son IP ;
//   3. l'IP est interrogée (vpnProviders) et évaluée (vpnEngine) ;
//   4. sanction immédiate ou accès accordé, puis journalisation.
//
// Toutes les décisions sont bornées par le document AntiVPN du serveur ; le
// parcours ne décide jamais à la place de la configuration.

const crypto = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { AntiVPN } = require('../models/AntiVPN');
const VPNVerification = require('../models/VPNVerification');
const { fetchIntel } = require('./vpnProviders');
const { evaluateIntel, describeIntel, isIP, isPrivateIp } = require('./vpnEngine');
const { COLORS } = require('./embeds');
const lock = require('./antiVpnLock');

const MAX_TIMEOUT_MIN = 1440;

async function getConfig(guildId) {
  return AntiVPN.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

// ── Lien public ─────────────────────────────────────────────────────────────
function publicBaseUrl(env = process.env) {
  const configured = String(env.ANTIVPN_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const port = Number(env.ANTIVPN_PORT || 0);
  return port ? `http://127.0.0.1:${port}` : null;
}

function verificationLink(token, env = process.env) {
  const base = publicBaseUrl(env);
  return base ? `${base}/verify/${token}` : null;
}

// ── Divers ──────────────────────────────────────────────────────────────────
function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function randomNonce() { return crypto.randomBytes(16).toString('hex'); }

/** Masque une IP pour les journaux (le staff voit l'origine sans l'exposer). */
function maskIp(ip) {
  if (!isIP(ip)) return 'IP inconnue';
  if (ip.includes(':')) {
    const groups = ip.split(':');
    return `${groups.slice(0, 3).join(':')}:…`;
  }
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.x.x`;
}

function isExempt(member, cfg) {
  if (!member) return true;
  if (cfg?.exemptUsers?.includes(member.id)) return true;
  const roles = cfg?.exemptRoles || [];
  if (!roles.length) return false;
  return roles.some(roleId => member.roles?.cache?.has?.(roleId));
}

function clampTimeout(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 15;
  return Math.min(MAX_TIMEOUT_MIN, Math.max(1, Math.round(value)));
}

/**
 * Remplace les placeholders d'un texte personnalisé du panneau.
 * Placeholders : {serveur}, {raison}, {delai}. Un texte vide renvoie ''. Pour
 * éviter qu'un membre mentionne la planète via {serveur}, le nom est neutralisé.
 */
function renderMessage(template, vars = {}) {
  const text = String(template || '').trim();
  if (!text) return '';
  const safe = name => String(name || '').replace(/@(everyone|here)/gi, '@\u200b$1');
  const values = { serveur: safe(vars.serveur), raison: String(vars.raison || ''), delai: String(vars.delai || '') };
  return text
    .replace(/\{(serveur|raison|delai)\}/gi, (_, key) => {
      const value = values[key.toLowerCase()];
      return value === undefined ? '' : value;
    })
    // Un placeholder inconnu est retiré : le membre ne doit jamais voir « {xyz} ».
    .replace(/\{[a-z][a-z0-9_]{0,23}\}/gi, '')
    .slice(0, 2000);
}

// ── Journalisation ──────────────────────────────────────────────────────────
async function logEvent(client, guildId, cfg, embed) {
  try {
    const guild = client?.guilds?.cache?.get?.(guildId);
    const channelId = cfg?.logChannelId;
    if (!guild || !channelId) return;
    const channel = guild.channels?.cache?.get?.(channelId);
    if (channel?.send) await channel.send({ embeds: [embed] });
  } catch { /* journalisation facultative */ }
}

function logEmbed(guildId, { color = COLORS.primary, title, description }) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'REZO • Anti-VPN' })
    .setTimestamp();
}

// ── Sanctions ───────────────────────────────────────────────────────────────
async function applySanction(member, cfg, reason, { action = null, minutes = null, template = 'refusal' } = {}) {
  const choice = action || cfg?.sanction?.action || 'kick';
  const guild = member?.guild;
  if (!guild) return 'none';

  try {
    switch (choice) {
      case 'kick':
        await member.kick(`Anti-VPN : ${reason}`);
        break;
      case 'ban':
        await member.ban({ reason: `Anti-VPN : ${reason}` });
        break;
      case 'quarantine': {
        const roleId = cfg?.sanction?.quarantineRoleId;
        if (roleId) await member.roles.add(roleId, `Anti-VPN : ${reason}`);
        break;
      }
      case 'timeout': {
        const duration = clampTimeout(minutes || cfg?.sanction?.timeoutMinutes || 1440);
        await member.timeout(duration * 60_000, `Anti-VPN : ${reason}`);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('anti-vpn sanction:', err.message);
    return 'failed';
  }

  if (cfg?.sanction?.dmUser !== false) {
    const custom = renderMessage(cfg?.messages?.[template], { serveur: guild.name, raison: reason });
    const fallback = template === 'expired'
      ? `Vous n'avez pas vérifié votre connexion à temps sur **${guild.name}**.\n\nSi vous pensez qu'il s'agit d'une erreur, contactez le staff du serveur.`
      : `Votre connexion a été refusée sur **${guild.name}**.\nRaison : ${reason}.\n\nSi vous pensez qu'il s'agit d'une erreur, contactez le staff du serveur.`;
    await member.send({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle('🛰️ Vérification anti-VPN')
        .setDescription(custom || fallback)],
    }).catch(() => {});
  }

  return choice;
}

async function grantAccess(member, cfg, session = null) {
  // Verrouillage total : les rôles d'origine reviennent AVANT le rôle d'accès,
  // pour ne pas perdre un rôle que le membre avait déjà.
  if (session) await lock.releaseMember(member, cfg, session).catch(() => {});
  const before = cfg?.verification?.roleBefore;
  const after = cfg?.verification?.roleAfter;
  if (before) await member.roles.remove(before, 'Anti-VPN : vérification réussie').catch(() => {});
  if (after) await member.roles.add(after, 'Anti-VPN : vérification réussie').catch(() => {});
}

// ── Démarrage ───────────────────────────────────────────────────────────────
/**
 * Crée la session et envoie le lien de vérification.
 * @returns {Promise<{ok:boolean, reason?:string, session?:object, link?:string, delivered?:number}>}
 */
async function startVerification(member, cfg, client, env = process.env) {
  if (!member || member.user?.bot) return { ok: false, reason: 'bot' };
  if (!cfg?.enabled) return { ok: false, reason: 'disabled' };
  if (isExempt(member, cfg)) return { ok: false, reason: 'exempt' };

  const base = publicBaseUrl(env);
  if (!base) return { ok: false, reason: 'no_portal' };

  const guild = member.guild;
  const timeoutMin = clampTimeout(cfg.verification?.timeoutMin);
  const token = randomToken();
  const nonce = randomNonce();

  // Une seule session en attente par membre : sinon, après un départ/retour,
  // l'ancienne expiration pourrait appliquer une sanction sur la nouvelle.
  try {
    const previous = await VPNVerification.find({ guildId: guild.id, userId: member.id, state: 'pending' });
    for (const old of previous || []) {
      old.state = 'expired';
      old.actionTaken = 'superseded';
      // Le membre a quitté puis rejoint : ses anciens rôles n'existent plus.
      old.lockApplied = false;
      old.lockedRoles = [];
      await old.save?.();
    }
  } catch { /* nettoyage facultatif */ }

  const session = await VPNVerification.create({
    guildId: guild.id,
    userId: member.id,
    userTag: member.user?.tag || null,
    token,
    nonce,
    state: 'pending',
    expiresAt: new Date(Date.now() + timeoutMin * 60_000),
  });

  // ── Verrouillage total ──────────────────────────────────────────────────
  // Aucun salon visible tant que la vérification n'est pas terminée. Le rôle
  // « avant » devient inutile : le rôle de verrouillage remplace tous les
  // autres, donc il ne peut plus exister de permission « autoriser ».
  let locked = { locked: false };
  if (lock.isLockEnabled(cfg)) {
    try {
      locked = await lock.lockMember(member, cfg, session);
    } catch (err) {
      locked = { locked: false, reason: err.message };
    }
    if (!locked.locked && locked.reason !== 'disabled' && guild?.roles?.cache) {
      console.warn(`[anti-vpn] verrouillage total indisponible (${locked.reason}) pour ${member.user?.tag || member.id} — ses salons restent visibles`);
    }
  }

  if (!locked.locked && cfg.verification?.roleBefore) {
    await member.roles.add(cfg.verification.roleBefore, 'Anti-VPN : en attente de vérification').catch(() => {});
  }

  const link = verificationLink(token, env);
  const custom = renderMessage(cfg.messages?.verify, { serveur: guild.name, delai: timeoutMin });
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🛰️ Vérification anti-VPN')
    .setDescription(
      custom
        ? custom + '\n\n' + (locked.locked ? '🔒 Tant que tu n’es pas vérifié, tu ne vois **aucun salon** du serveur.\n\n' : '') + `⏳ Tu as **${timeoutMin} minute(s)** pour te vérifier.`
        : `Bienvenue sur **${guild.name}** !\n\n`
          + 'Pour protéger le serveur, nous vérifions que tu ne te connectes pas via un **VPN, un proxy ou Tor**.\n'
          + 'Clique sur le bouton ci-dessous : la vérification prend quelques secondes et se fait automatiquement.\n\n'
          + (locked.locked ? '🔒 Tant que tu n’es pas vérifié, tu ne vois **aucun salon** du serveur.\n\n' : '')
          + `⏳ Tu as **${timeoutMin} minute(s)** pour te vérifier.`,
    )
    .setFooter({ text: 'REZO • Vérification de connexion' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Vérifier ma connexion').setEmoji('🔗').setStyle(ButtonStyle.Link).setURL(link),
  );

  let delivered = 0;

  if (cfg.verification?.channelId) {
    const channel = guild.channels?.cache?.get?.(cfg.verification.channelId);
    if (channel?.send) {
      const message = await channel.send({
        content: `<@${member.id}>`,
        embeds: [embed],
        components: [row],
        allowedMentions: { users: [member.id] },
      }).catch(() => null);
      if (message) {
        session.channelId = channel.id;
        session.messageId = message.id;
        delivered++;
      }
    }
  }

  // Avec le verrouillage total, les salons sont invisibles : le message privé
  // devient le seul moyen de récupérer le lien, on l'envoie donc toujours.
  if (cfg.verification?.dm !== false || locked.locked) {
    const dm = await member.send({ embeds: [embed], components: [row] }).catch(() => null);
    if (dm) delivered++;
  }

  await session.save().catch(() => {});
  await AntiVPN.updateOne({ guildId: guild.id }, { $inc: { 'stats.started': 1 } }).catch(() => {});

  await logEvent(client, guild.id, cfg, logEmbed(guild.id, {
    title: '🛰️ Vérification anti-VPN demandée',
    description: `${member.user?.tag || member.id} doit vérifier sa connexion.\nExpire <t:${Math.floor(session.expiresAt.getTime() / 1000)}:R>.`
      + (delivered ? '' : '\n⚠️ Aucun message n’a pu être envoyé (salon/MP inaccessibles).'),
  }));

  return { ok: true, session, link, delivered };
}

// ── Vérification (appelée par le portail) ───────────────────────────────────
/**
 * Traite la vérification d'un jeton depuis une IP.
 * @returns {Promise<{ok:boolean, state?:string, reasons?:string[], summary?:string, error?:string}>}
 */
async function verifySession(token, { client, ip, env = process.env, lookup = fetchIntel } = {}) {
  const session = await VPNVerification.findOne({ token });
  if (!session) return { ok: false, error: 'unknown' };
  if (session.state !== 'pending') return { ok: false, error: 'already', state: session.state };

  if (!isIP(ip) || isPrivateIp(ip)) return { ok: false, error: 'bad_ip' };

  if (session.expiresAt.getTime() <= Date.now()) {
    await expireSession(session, client);
    return { ok: false, error: 'expired' };
  }

  const guild = client?.guilds?.cache?.get?.(session.guildId)
    || await client?.guilds?.fetch?.(session.guildId).catch(() => null);
  if (!guild) {
    session.state = 'error';
    session.reasons = ['serveur introuvable'];
    await session.save().catch(() => {});
    return { ok: false, error: 'guild_missing' };
  }

  const member = await guild.members?.fetch?.(session.userId).catch(() => null);
  if (!member) {
    session.state = 'error';
    session.reasons = ['membre parti avant la vérification'];
    await session.save().catch(() => {});
    return { ok: false, error: 'member_missing' };
  }

  const cfg = await getConfig(guild.id);

  // La vérification a été désactivée pendant que le lien était ouvert : on
  // n'applique pas une politique que le staff a retirée entre-temps.
  if (!cfg.enabled) {
    await grantAccess(member, cfg, session);
    session.state = 'passed';
    session.actionTaken = 'accepted';
    session.reasons = ['anti-VPN désactivé pendant la vérification'];
    session.verifiedAt = new Date();
    await session.save().catch(() => {});
    return { ok: true, state: 'passed', reasons: session.reasons, summary: 'vérification désactivée' };
  }

  const fetched = await lookup(ip, {
    provider: env.ANTIVPN_PROVIDER || 'proxycheck',
    apiKey: env.ANTIVPN_API_KEY,
    env,
  });

  let blocked = false;
  let reasons = [];
  let summary = 'fournisseur indisponible';
  let provider = fetched.provider || null;

  if (!fetched.ok) {
    await AntiVPN.updateOne({ guildId: guild.id }, { $inc: { 'stats.apiErrors': 1 } }).catch(() => {});
    if (cfg.apiFailure === 'block') {
      blocked = true;
      reasons = [`Vérification impossible (${fetched.error}) et serveur configuré pour refuser dans ce cas`];
    } else {
      reasons = [`Vérification impossible (${fetched.error}) — accès laissé ouvert par politique`];
    }
  } else {
    provider = fetched.provider;
    const intel = fetched.intel;
    summary = describeIntel(intel);
    const verdict = evaluateIntel(intel, cfg);
    blocked = Boolean(verdict.blocked);
    reasons = verdict.reasons || [];
    if (verdict.whitelisted) reasons = ['IP en liste blanche'];

    session.country = intel.country || null;
    session.asn = intel.asn || null;
    session.isp = intel.isp || null;
    session.riskScore = Number.isFinite(Number(intel.riskScore)) ? Number(intel.riskScore) : null;
    session.flags = {
      vpn: Boolean(intel.vpn),
      proxy: Boolean(intel.proxy),
      tor: Boolean(intel.tor),
      hosting: Boolean(intel.hosting),
    };
  }

  session.provider = provider;
  session.reasons = reasons;
  session.ip = cfg.storeIp ? ip : null;

  if (blocked) {
    const action = await applySanction(member, cfg, reasons.join(' · ') || 'connexion refusée');
    session.state = 'blocked';
    session.actionTaken = action;
    session.verifiedAt = new Date();
    await session.save().catch(() => {});
    await AntiVPN.updateOne({ guildId: guild.id }, {
      $inc: { 'stats.blocked': 1, 'stats.checked': 1 },
      $set: { 'stats.lastCheckAt': new Date() },
    }).catch(() => {});

    await logEvent(client, guild.id, cfg, logEmbed(guild.id, {
      color: COLORS.error,
      title: `⛔ Connexion refusée — ${action === 'failed' ? 'sanction impossible' : action}`,
      description: `**${member.user?.tag || member.id}**\nIP : ${maskIp(ip)}\n${summary}\n\n**Raisons :** ${reasons.map(r => `• ${r}`).join('\n')}`
        + (session.lockApplied ? '\n🔒 Accès aux salons toujours verrouillé.' : '')
        + (action === 'failed' ? '\n\n⚠️ La sanction n’a pas pu être appliquée (permissions ou hiérarchie).' : ''),
    }));

    return { ok: true, state: 'blocked', reasons, summary, action };
  }

  await grantAccess(member, cfg, session);
  session.state = 'passed';
  session.actionTaken = 'accepted';
  session.verifiedAt = new Date();
  await session.save().catch(() => {});
  await AntiVPN.updateOne({ guildId: guild.id }, {
    $inc: { 'stats.passed': 1, 'stats.checked': 1 },
    $set: { 'stats.lastCheckAt': new Date() },
  }).catch(() => {});

  await logEvent(client, guild.id, cfg, logEmbed(guild.id, {
    color: COLORS.success,
    title: '✅ Connexion validée',
    description: `**${member.user?.tag || member.id}**\nIP : ${maskIp(ip)}\n${summary}`,
  }));

  return { ok: true, state: 'passed', reasons, summary };
}

// ── Expiration ──────────────────────────────────────────────────────────────
async function expireSession(session, client, cfg = null) {
  if (!session || session.state !== 'pending') return null;

  const guild = client?.guilds?.cache?.get?.(session.guildId)
    || await client?.guilds?.fetch?.(session.guildId).catch(() => null);
  const member = guild ? await guild.members?.fetch?.(session.userId).catch(() => null) : null;
  const config = cfg || (guild ? await getConfig(guild.id).catch(() => null) : null);

  let action = 'none';
  // Si la protection a été désactivée, on clôt la session sans sanction :
  // désactiver l'anti-VPN doit arrêter aussi les sanctions en attente, et
  // rendre au membre ses salons et ses rôles.
  if (member && config?.enabled) action = await applySanction(member, config, 'délai de vérification dépassé', {
    action: config.timeoutAction,
    template: 'expired',
  });
  else if (member && config && !config.enabled) await lock.releaseMember(member, config, session).catch(() => {});

  session.state = 'expired';
  session.actionTaken = action;
  await session.save().catch(() => {});
  if (guild) await AntiVPN.updateOne({ guildId: guild.id }, { $inc: { 'stats.expired': 1 } }).catch(() => {});

  if (guild && config) {
    await logEvent(client, guild.id, config, logEmbed(guild.id, {
      color: COLORS.warning,
      title: '⌛ Vérification expirée',
      description: `<@${session.userId}> n’a pas vérifié sa connexion à temps.\nSanction : **${action}**`,
    }));
  }

  return action;
}

async function expirePending(client, { now = Date.now(), limit = 50 } = {}) {
  const due = await VPNVerification.find({ state: 'pending', expiresAt: { $lte: new Date(now) } })
    .limit(limit)
    .catch(() => []);
  let processed = 0;
  for (const session of due) {
    const action = await expireSession(session, client).catch(() => null);
    if (action !== null) processed++;
  }
  return processed;
}

module.exports = {
  getConfig,
  publicBaseUrl,
  verificationLink,
  randomToken,
  randomNonce,
  maskIp,
  isExempt,
  clampTimeout,
  renderMessage,
  applySanction,
  grantAccess,
  startVerification,
  verifySession,
  expireSession,
  expirePending,
  MAX_TIMEOUT_MIN,
};
