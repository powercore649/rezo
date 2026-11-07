'use strict';
// utils/antiVpnPanel.js — Panneau de configuration de l'anti-VPN.
//
// Tout se règle ici : détection, sanctions, rôles, salons, listes (pays, ASN,
// IP) et délais. Les composants `avpn_*` sont routés de façon persistante par
// events/core/interactionCreate.js — le panneau reste donc utilisable au-delà
// de la durée d'un collecteur classique.
//
// Aucune décision de filtrage n'est prise ici : le panneau écrit la politique,
// utils/antiVpnFlow.js l'applique.

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder,
  UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
  PermissionFlagsBits, AttachmentBuilder,
} = require('discord.js');
const { AntiVPN, ACTIONS } = require('../models/AntiVPN');
const VPNVerification = require('../models/VPNVerification');
const { COLORS, errorEmbed } = require('./embeds');
const { getConfig, publicBaseUrl } = require('./antiVpnFlow');
const lockMod = require('./antiVpnLock');
const licenseGate = require('./licenseGate');

// Nom du verrou de licence (LICENSE_REQUIRED_COMMANDS dans utils/licenseGate.js).
const FEATURE = 'antivpn';
const { isLoopbackUrl, isTunnelRequested } = require('../web/antiVpnTunnel');
const { PROVIDERS, providerInfo, inspectIp } = require('./vpnProviders');
const { isIP, normalizeAsn } = require('./vpnEngine');

const ACTION_LABELS = {
  kick: '👢 Expulser',
  ban: '🔨 Bannir',
  quarantine: '🚪 Quarantaine',
  timeout: '⏳ Exclure temporairement',
  none: '📝 Ne rien faire',
};

const VIEWS = [
  { key: 'main', label: '📊 Vue d’ensemble' },
  { key: 'detection', label: '🔍 Détection' },
  { key: 'sanction', label: '⚖️ Sanctions' },
  { key: 'places', label: '🏠 Salons & rôles d’accès' },
  { key: 'roles', label: '🎭 Quarantaine & exemptions' },
  { key: 'lists', label: '🌍 Pays, ASN, IP' },
  { key: 'portal', label: '🌐 Portail & réseau' },
  { key: 'messages', label: '✉️ Messages personnalisés' },
  { key: 'history', label: '📜 Historique' },
  { key: 'stats', label: '📈 Statistiques' },
];

// Vus par le panneau mais absents du menu de navigation : la confirmation de
// réinitialisation est atteinte uniquement par le bouton dédié.
const HIDDEN_VIEWS = [{ key: 'reset', label: '🧨 Confirmation de réinitialisation' }];

function viewByKey(key) {
  return VIEWS.find(v => v.key === key) || HIDDEN_VIEWS.find(v => v.key === key) || VIEWS[0];
}

const STATE_LABELS = {
  pending: '⏳ En attente',
  passed: '✅ Validée',
  blocked: '⛔ Refusée',
  expired: '⌛ Expirée',
  error: '⚠️ Erreur',
};

const DEFAULT_MESSAGE_HINTS = {
  verify: 'Bienvenue sur {serveur} ! Vérifie ta connexion pour accéder au serveur.',
  refusal: 'Votre connexion a été refusée sur {serveur}.\nRaison : {raison}.',
  expired: 'Vous n’avez pas vérifié votre connexion à temps sur {serveur}.',
};

function channelMention(id) {
  return id ? `<#${id}>` : '*non défini*';
}

function roleMention(id) {
  return id ? `<@&${id}>` : '*non défini*';
}

function envStatus(env = process.env) {
  const info = providerInfo(env.ANTIVPN_PROVIDER || 'proxycheck');
  const portal = publicBaseUrl(env);
  return {
    provider: info.key,
    providerLabel: info.label,
    needsKey: info.needsKey,
    hasKey: Boolean(env.ANTIVPN_API_KEY),
    portal,
    portalLocal: isLoopbackUrl(portal),
    ephemeral: /\.trycloudflare\.com$/i.test(portal || ''),
    tunnel: isTunnelRequested(env.ANTIVPN_TUNNEL),
    trustProxy: String(env.ANTIVPN_TRUST_PROXY || '') === '1',
    customUrl: Boolean(env.ANTIVPN_PROVIDER_URL),
  };
}

function diagnosticLines(cfg, env = process.env) {
  const status = envStatus(env);
  const lines = [];
  if (!status.portal) lines.push('⛔ **Portail non configuré** : ajoute `ANTIVPN_PORT=3199` dans `.env` — le bot créera automatiquement un tunnel Cloudflare gratuit (aucun domaine requis).');
  else if (status.portalLocal) lines.push('⛔ **Aucune adresse publique** : `127.0.0.1` n’est pas accessible aux membres. Redémarre le bot : le tunnel Cloudflare doit afficher une URL `https://…trycloudflare.com` dans les logs.');
  const lockOn = lockMod.isLockEnabled(cfg);
  if (!cfg.verification?.channelId) lines.push('🟡 Aucun **salon de vérification** : le lien ne partira qu’en message privé.');
  if (!lockOn && !cfg.verification?.roleBefore && !cfg.verification?.roleAfter) lines.push('🟡 Aucun rôle d’accès : le membre garde ses permissions pendant la vérification.');
  if (lockOn) lines.push('ℹ️ **Verrouillage total** : le bot a besoin de **Gérer les salons** et **Gérer les rôles**, avec son rôle au-dessus de ceux des membres.');
  if (cfg.sanction?.action === 'quarantine' && !cfg.sanction?.quarantineRoleId) lines.push('⛔ Sanction **quarantaine** sans rôle de quarantaine : la sanction échouera.');
  if (cfg.sanction?.action === 'timeout' && !cfg.timeoutAction) lines.push('🟡 Action d’expiration vide.');
  if (!cfg.logChannelId) lines.push('🟡 Aucun **salon de logs** : les verdicts ne laissent aucune trace.');
  if (status.needsKey && !status.hasKey) lines.push(`⛔ **Clé API manquante** pour ${status.providerLabel} : renseigne \`ANTIVPN_API_KEY\`.`);
  if (status.provider === 'custom' && !status.customUrl) lines.push('⛔ Fournisseur **custom** sans `ANTIVPN_PROVIDER_URL`.');
  if (!status.trustProxy) lines.push('ℹ️ Derrière un reverse proxy, active `ANTIVPN_TRUST_PROXY=1` pour lire la vraie IP.');
  return lines;
}

function previewText(value, fallback) {
  const raw = String(value || '').trim();
  const text = raw || fallback || '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 150 ? `${oneLine.slice(0, 147)}…` : oneLine;
}

function portalFields(status, cfg) {
  return [
    {
      name: '🌐 Portail public',
      value: [
        `Adresse : ${status.portal ? `\`${status.portal}\`` : '*non configurée*'}`,
        `Type : ${status.ephemeral
          ? 'tunnel Cloudflare éphémère (URL renouvelée à chaque démarrage)'
          : status.portalLocal
            ? 'adresse locale — inaccessible aux membres'
            : status.portal ? 'URL publique stable' : '—'}`,
        `Tunnel demandé : **${status.tunnel ? 'oui' : 'non'}**`,
        `Proxy de confiance : **${status.trustProxy ? 'oui' : 'non'}**`,
      ].join('\n'),
      inline: false,
    },
    {
      name: '🛰️ Fournisseur d’intelligence IP',
      value: [
        `Fournisseur : **${status.providerLabel}** (\`${status.provider}\`)`,
        `Clé API : ${status.needsKey ? (status.hasKey ? '✅ présente' : '⛔ manquante') : '*non requise*'}`,
        `URL personnalisée : **${status.customUrl ? 'oui' : 'non'}**`,
        `Panne d’API : **${cfg.apiFailure === 'block' ? 'refuser' : 'laisser entrer'}**`,
      ].join('\n'),
      inline: false,
    },
    {
      name: '🔒 Accès & réglages réseau',
      value: [
        `Verrouillage total : **${lockMod.isLockEnabled(cfg) ? 'oui' : 'non'}**`,
        `Conserver l’IP en base : **${cfg.storeIp ? 'oui' : 'non'}**`,
        `Salon des logs : ${channelMention(cfg.logChannelId)}`,
        '🧪 **Tester le portail** vérifie en direct que la page répond (`/health`) depuis le bot.',
      ].join('\n'),
      inline: false,
    },
  ];
}

function messageFields(cfg) {
  const messages = cfg.messages || {};
  const line = (key, label, fallback) => `**${label}**${String(messages[key] || '').trim() ? '' : ' *(par défaut)*'}\n> ${previewText(messages[key], fallback)}`;
  return [
    {
      name: '✉️ Textes personnalisés',
      value: [
        line('verify', 'Consigne de vérification', DEFAULT_MESSAGE_HINTS.verify),
        line('refusal', 'MP · connexion refusée', DEFAULT_MESSAGE_HINTS.refusal),
        line('expired', 'MP · délai dépassé', DEFAULT_MESSAGE_HINTS.expired),
      ].join('\n\n').slice(0, 1024),
      inline: false,
    },
    {
      name: '🧩 Placeholders disponibles',
      value: '`{serveur}` → nom du serveur\n`{raison}` → motif du refus\n`{delai}` → minutes accordées\n\nUn texte vide réactive le message par défaut ; les mentions `@everyone` sont neutralisées.',
      inline: false,
    },
  ];
}

function formatHistory(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return '*Aucune vérification enregistrée pour le moment.*';
  return rows.slice(0, 6).map(row => {
    const state = STATE_LABELS[row.state] || row.state || '—';
    const when = row.createdAt ? `<t:${Math.floor(new Date(row.createdAt).getTime() / 1000)}:R>` : '—';
    const who = row.userTag ? String(row.userTag).replace(/[`*_~|]/g, '') : (row.userId ? `<@${row.userId}>` : '*inconnu*');
    const place = [row.country, row.asn].filter(Boolean).join(' · ');
    const reason = (row.reasons || []).join(' · ').slice(0, 80);
    return `${state} — ${who} — ${when}${place ? ` — ${place}` : ''}${reason ? `\n   ↳ ${reason}` : ''}`;
  }).join('\n').slice(0, 1024);
}

/** Configuration exportable : ni identifiants internes, ni clés d’environnement. */
function exportConfig(cfg) {
  const raw = typeof cfg?.toObject === 'function' ? cfg.toObject({ minimize: false }) : { ...(cfg || {}) };
  const { _id, __v, updatedBy, ...policy } = raw;
  // Un document Mongoose ne contient pas ses méthodes ; un objet de test si.
  const config = Object.fromEntries(Object.entries(policy).filter(([, value]) => typeof value !== 'function'));
  return {
    format: 'rezo-antivpn-config',
    version: 1,
    exportedAt: new Date().toISOString(),
    config,
  };
}

/** Vérifie en direct que la page publique répond (utilisé par le panneau). */
async function probePortal(base, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const url = String(base || '').replace(/\/+$/, '');
  if (!url) return { ok: false, error: 'no_portal' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_indisponible' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(`${url}/health`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const latency = Date.now() - startedAt;
    let payload = null;
    try { payload = await res.json(); } catch { /* réponse non JSON */ }
    return { ok: res.ok && payload?.ok === true, status: res.status, latency, url, publicUrl: url };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return { ok: false, error: aborted ? 'timeout' : (err?.code || err?.message || 'unreachable'), latency: Date.now() - startedAt, url };
  } finally {
    clearTimeout(timer);
  }
}

function probePublicHint(probe, base) {
  if (probe.error === 'timeout') return 'Le portail n’a pas répondu à temps. Vérifie que le bot est démarré et que le tunnel Cloudflare est actif (regarde les logs du démarrage).';
  if (String(base).includes('127.0.0.1') || String(base).includes('localhost')) return 'L’adresse est locale : les membres ne peuvent pas l’ouvrir. Redémarre le bot pour obtenir une URL `https://…trycloudflare.com`.';
  if (probe.status) return `La page a répondu HTTP ${probe.status} au lieu de 200. Le tunnel pointe peut-être vers un autre service, ou le portail a changé de port.`;
  return 'Impossible de joindre la page. Vérifie la connexion Internet, le port (ANTIVPN_PORT) et le tunnel (ANTIVPN_TUNNEL).';
}

function buildEmbed(cfg, { guild = null, view = 'main', env = process.env, history = [] } = {}) {
  const status = envStatus(env);
  const detection = cfg.detection || {};
  const verification = cfg.verification || {};
  const sanction = cfg.sanction || {};
  const stats = cfg.stats || {};

  const flag = (value, label) => `${value ? '🟢' : '🔴'} ${label}`;
  const diag = diagnosticLines(cfg, env);
  const blockError = diag.some(l => l.startsWith('⛔'));
  const focused = ['portal', 'messages', 'history', 'reset'].includes(view);

  const embed = new EmbedBuilder()
    .setColor(view === 'reset' ? COLORS.error : cfg.enabled ? (blockError ? COLORS.warning : COLORS.success) : COLORS.primary)
    .setTitle(`🛰️ Anti-VPN — ${guild?.name || 'ce serveur'}`)
    .setDescription(
      (view === 'reset'
        ? '🧨 **Réinitialisation complète** — la politique repassera à ses valeurs par défaut et le rôle de verrouillage sera supprimé.'
        : cfg.enabled
          ? '🟢 **Actif** — chaque nouvelle arrivée doit vérifier sa connexion.'
          : '🔴 **Désactivé** — aucune vérification n’est demandée.')
      + `\n${viewByKey(view).label}`
      + (status.portal
        ? `\n🌐 Portail : \`${status.portal}\`${status.ephemeral ? ' *(tunnel éphémère)*' : ''}`
        : '\n🌐 Portail : *non configuré*'),
    );

  if (view === 'portal') {
    embed.addFields(...portalFields(status, cfg));
  } else if (view === 'messages') {
    embed.addFields(...messageFields(cfg));
  } else if (view === 'history') {
    embed.addFields({
      name: `📜 Dernières vérifications${Array.isArray(history) && history.length ? ` (${history.length})` : ''}`,
      value: formatHistory(history),
      inline: false,
    });
    embed.addFields({
      name: '🔐 Confidentialité',
      value: 'Les IP ne sont affichées que si « Conserver l’IP » est activé, et toujours masquées. Les sessions expirent automatiquement 30 jours après leur échéance.',
      inline: false,
    });
  } else if (view === 'reset') {
    embed.addFields({
      name: '🧨 Ce qui sera effacé',
      value: [
        '• Toute la politique : détection, sanctions, salons, rôles, listes, messages et exemptions.',
        '• Les statistiques du panneau.',
        '• Le rôle de verrouillage et ses refus d’accès (les membres verrouillés sont libérés).',
        '',
        '**Conservé :** l’historique des vérifications et les journaux Discord.',
      ].join('\n'),
      inline: false,
    });
  } else {
    embed.addFields(
      {
        name: '🔍 Détection',
        value: [
          flag(detection.blockVPN, 'VPN'),
          flag(detection.blockProxy, 'Proxy'),
          flag(detection.blockTor, 'Tor'),
          flag(detection.blockHosting, 'Hébergement / datacenter'),
          `Seuil de risque : **${detection.riskThreshold || 0}/100**${detection.riskThreshold ? '' : ' (ignoré)'}`,
          `Fournisseur : **${status.providerLabel}**${status.hasKey || !status.needsKey ? '' : ' — ⚠️ clé manquante'}`,
          `Panne d’API : **${cfg.apiFailure === 'block' ? 'refuser' : 'laisser entrer'}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: '⚖️ Sanctions',
        value: [
          `Connexion refusée : **${ACTION_LABELS[sanction.action] || sanction.action}**`,
          sanction.action === 'timeout' ? `Durée : **${sanction.timeoutMinutes || 1440} min**` : null,
          sanction.action === 'quarantine' ? `Rôle : ${roleMention(sanction.quarantineRoleId)}` : null,
          `Sans réponse : **${ACTION_LABELS[cfg.timeoutAction] || cfg.timeoutAction}**`,
          `Délai de vérification : **${verification.timeoutMin || 15} min**`,
          `MP au membre : **${sanction.dmUser === false ? 'non' : 'oui'}**`,
        ].filter(Boolean).join('\n'),
        inline: true,
      },
      {
        name: '🎭 Accès',
        value: [
          `Salon : ${channelMention(verification.channelId)}`,
          `Logs : ${channelMention(cfg.logChannelId)}`,
          `Verrouillage total : **${lockMod.isLockEnabled(cfg) ? 'oui — aucun salon visible' : 'non'}**`,
          `Avant vérification : ${roleMention(verification.roleBefore)}`,
          `Après vérification : ${roleMention(verification.roleAfter)}`,
          `MP de vérification : **${verification.dm === false ? 'non' : 'oui'}**`,
          `Conserver l’IP : **${cfg.storeIp ? 'oui' : 'non'}**`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '🌍 Listes',
        value: [
          `Pays bloqués : ${(detection.blockCountries || []).join(', ') || '*aucun*'}`,
          `Pays autorisés : ${(detection.allowCountries || []).join(', ') || '*tous*'}`,
          `ASN bloqués : ${(detection.blockASNs || []).join(', ') || '*aucun*'}`,
          `IP / CIDR autorisés : ${(detection.allowIPs || []).length ? `${(detection.allowIPs || []).length} entrée(s)` : '*aucun*'}`,
          `Exemptions : ${(cfg.exemptRoles || []).length} rôle(s), ${(cfg.exemptUsers || []).length} membre(s)`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '📈 Statistiques',
        value: [
          `Vérifications lancées : **${stats.started || 0}**`,
          `Validées : **${stats.passed || 0}** · Refusées : **${stats.blocked || 0}** · Expirées : **${stats.expired || 0}**`,
          `Erreurs d’API : **${stats.apiErrors || 0}**`,
          stats.lastCheckAt ? `Dernier contrôle : <t:${Math.floor(new Date(stats.lastCheckAt).getTime() / 1000)}:R>` : 'Aucun contrôle effectué',
        ].join('\n'),
        inline: false,
      },
    );
  }

  if (diag.length && !focused) {
    embed.addFields({ name: blockError ? '⚠️ À corriger' : '✅ Diagnostic', value: diag.join('\n').slice(0, 1024), inline: false });
  }

  return embed.setFooter({ text: 'REZO • Anti-VPN — Vérification par portail web' }).setTimestamp();
}

// ── Composants ───────────────────────────────────────────────────────────────
function viewRow(current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('avpn_view')
      .setPlaceholder('🛰️ Section du panneau Anti-VPN…')
      .addOptions(VIEWS.map(v => ({
        label: v.label,
        value: v.key,
        default: v.key === current,
      }))),
  );
}

function toggleButton(id, label, value, emoji) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(`${value ? '🟢' : '🔴'} ${label}`)
    .setEmoji(emoji)
    .setStyle(value ? ButtonStyle.Success : ButtonStyle.Secondary);
}

function buildComponents(cfg, { view = 'main', env = process.env } = {}) {
  const rows = [viewRow(view)];
  const status = envStatus(env);
  const detection = cfg.detection || {};
  const verification = cfg.verification || {};
  const sanction = cfg.sanction || {};

  if (view === 'main') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('avpn_toggle')
        .setLabel(cfg.enabled ? 'Désactiver' : 'Activer')
        .setEmoji(cfg.enabled ? '⏸️' : '▶️')
        .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('avpn_modal_test').setLabel('Tester une IP').setEmoji('🧪').setStyle(ButtonStyle.Primary),
      toggleButton('avpn_lock_toggle', 'Verrouillage total', lockMod.isLockEnabled(cfg), '🔒'),
      new ButtonBuilder().setCustomId('avpn_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ));
    if (status.portal) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Ouvrir le portail').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(status.portal),
      ));
    }
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_export').setLabel('Exporter la config').setEmoji('📤').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('avpn_reset_request').setLabel('Réinitialiser').setEmoji('🧨').setStyle(ButtonStyle.Danger),
    ));
  }

  if (view === 'portal') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_portal_test').setLabel('Tester le portail').setEmoji('🧪').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('avpn_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ));
    if (status.portal) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Ouvrir le portail').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(status.portal),
      ));
    }
  }

  if (view === 'messages') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_modal_msg_verify').setLabel('Consigne de vérification').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('avpn_modal_msg_refusal').setLabel('MP de refus').setEmoji('⛔').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('avpn_modal_msg_expired').setLabel('MP d’expiration').setEmoji('⌛').setStyle(ButtonStyle.Secondary),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_msg_clear').setLabel('Rétablir les textes par défaut').setEmoji('🧹').setStyle(ButtonStyle.Danger),
    ));
  }

  if (view === 'history') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_history_refresh').setLabel('Rafraîchir l’historique').setEmoji('🔄').setStyle(ButtonStyle.Primary),
    ));
  }

  if (view === 'reset') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_reset_confirm').setLabel('Oui, tout réinitialiser').setEmoji('🧨').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('avpn_reset_cancel').setLabel('Annuler').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
    ));
  }

  if (view === 'detection') {
    rows.push(new ActionRowBuilder().addComponents(
      toggleButton('avpn_flag_vpn', 'VPN', detection.blockVPN, '🛡️'),
      toggleButton('avpn_flag_proxy', 'Proxy', detection.blockProxy, '🔀'),
      toggleButton('avpn_flag_tor', 'Tor', detection.blockTor, '🧅'),
      toggleButton('avpn_flag_hosting', 'Hébergement', detection.blockHosting, '🏢'),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_modal_risk').setLabel('Seuil de risque').setEmoji('🎯').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('avpn_failmode')
        .setLabel(`Panne API : ${cfg.apiFailure === 'block' ? 'refuser' : 'laisser entrer'}`)
        .setEmoji('⚡')
        .setStyle(cfg.apiFailure === 'block' ? ButtonStyle.Danger : ButtonStyle.Secondary),
      toggleButton('avpn_store_ip', 'Conserver l’IP', cfg.storeIp, '💾'),
    ));
  }

  if (view === 'sanction') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('avpn_action')
        .setLabel(`Si refusé : ${(ACTION_LABELS[sanction.action] || sanction.action || 'kick').replace(/^[^ ]+ /, '')}`)
        .setEmoji('⚖️')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('avpn_timeout_action')
        .setLabel(`Sans réponse : ${(ACTION_LABELS[cfg.timeoutAction] || cfg.timeoutAction || 'kick').replace(/^[^ ]+ /, '')}`)
        .setEmoji('⌛')
        .setStyle(ButtonStyle.Secondary),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_modal_verify_timeout').setLabel('Délai de vérification').setEmoji('⏱️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('avpn_modal_sanction_timeout').setLabel('Durée d’exclusion').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('avpn_dm_toggle').setLabel(`MP : ${sanction.dmUser === false ? 'non' : 'oui'}`).setEmoji('✉️').setStyle(ButtonStyle.Secondary),
    ));
  }

  if (view === 'places') {
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('avpn_channel_verify')
        .setPlaceholder('🏠 Salon de vérification…')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('avpn_channel_log')
        .setPlaceholder('📋 Salon des logs anti-VPN…')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('avpn_role_before').setPlaceholder('🔒 Rôle « non vérifié » (avant)…'),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('avpn_role_after').setPlaceholder('✅ Rôle donné après vérification…'),
    ));
  }

  if (view === 'roles') {
    rows.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('avpn_role_quarantine').setPlaceholder('🚪 Rôle de quarantaine…'),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId('avpn_role_exempt').setPlaceholder('🎭 Ajouter un rôle exempté…'),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId('avpn_user_exempt').setPlaceholder('👤 Ajouter un membre exempté…').setMaxValues(1),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_exempt_clear').setLabel('Vider les exemptions').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
    ));
  }

  if (view === 'lists') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_modal_countries').setLabel('Pays bloqués').setEmoji('⛔').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('avpn_modal_allow_countries').setLabel('Pays autorisés').setEmoji('✅').setStyle(ButtonStyle.Secondary),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_modal_asn').setLabel('ASN bloqués').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('avpn_modal_ips').setLabel('IP autorisées').setEmoji('📮').setStyle(ButtonStyle.Secondary),
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_lists_clear').setLabel('Vider les listes').setEmoji('🧹').setStyle(ButtonStyle.Danger),
    ));
  }

  if (view === 'stats') {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('avpn_refresh').setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('avpn_reset_stats').setLabel('Remettre à zéro').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
    ));
  }

  return rows.slice(0, 5);
}

function buildPayload(cfg, { guild = null, view = 'main', env = process.env, history = [] } = {}) {
  return {
    embeds: [buildEmbed(cfg, { guild, view, env, history })],
    components: buildComponents(cfg, { view, env }),
  };
}

// ── Verrou de licence ───────────────────────────────────────────────────────
// Le routeur bloque déjà /antivpn, mais le panneau s’ouvre aussi depuis /setting
// et reste utilisable via ses boutons persistants : on revérifie donc ici.
async function replyLocked(interaction, access = null) {
  const payload = { embeds: [licenseGate.lockEmbed(FEATURE, { access })], ephemeral: true };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
  return interaction.reply(payload).catch(() => {});
}

async function ensureLicensed(interaction) {
  const guildId = interaction.guildId || interaction.guild?.id;
  if (!guildId) return false;
  const access = await licenseGate.checkAccessBounded(guildId, FEATURE);
  if (!access) {
    const payload = { embeds: [licenseGate.unavailableEmbed(FEATURE)], ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
    return false;
  }
  if (!access.ok) {
    await replyLocked(interaction, access);
    return false;
  }
  return true;
}

// ── Ouverture ───────────────────────────────────────────────────────────────
async function open(interaction, { env = process.env } = {}) {
  const perms = interaction.memberPermissions;
  if (perms && typeof perms.has === 'function' && !perms.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur** pour configurer l’anti-VPN.')],
      ephemeral: true,
    }).catch(() => {});
  }
  if (!(await ensureLicensed(interaction))) return;
  const cfg = await getConfig(interaction.guildId || interaction.guild?.id);
  const payload = buildPayload(cfg, { guild: interaction.guild, view: 'main', env });
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  return interaction.editReply(payload);
}

// ── Validation des listes ───────────────────────────────────────────────────
function parseCountries(input) {
  const values = String(input || '').split(/[\s,;]+/).map(v => v.trim().toUpperCase()).filter(Boolean);
  const valid = values.filter(v => /^[A-Z]{2}$/.test(v));
  return { values: [...new Set(valid)], rejected: values.filter(v => !/^[A-Z]{2}$/.test(v)) };
}

function parseAsns(input) {
  const values = String(input || '').split(/[\s,;]+/).map(v => normalizeAsn(v)).filter(Boolean);
  const valid = values.filter(v => /^AS\d{1,10}$/.test(v));
  return { values: [...new Set(valid)], rejected: values.filter(v => !/^AS\d{1,10}$/.test(v)) };
}

function parseIps(input) {
  const values = String(input || '').split(/[\s,;]+/).map(v => v.trim()).filter(Boolean);
  const valid = [];
  const rejected = [];
  for (const value of values) {
    if (value.includes('/')) {
      const [network, bits] = value.split('/');
      const n = Number(bits);
      if (isIP(network) && Number.isInteger(n) && n >= 0 && n <= 32) valid.push(value);
      else rejected.push(value);
    } else if (isIP(value)) valid.push(value);
    else rejected.push(value);
  }
  return { values: [...new Set(valid)], rejected };
}

// ── Routage des composants ──────────────────────────────────────────────────
function modal(customId, title, inputs) {
  const m = new ModalBuilder().setCustomId(customId).setTitle(title);
  m.addComponents(inputs.map(input => new ActionRowBuilder().addComponents(input)));
  return m;
}

function textInput(id, label, value = '', { placeholder = '', max = 400, required = false } = {}) {
  return new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(placeholder)
    .setValue(String(value ?? '').slice(0, max))
    .setMaxLength(max)
    .setRequired(required);
}

async function updatePanel(interaction, cfg, { view = 'main', env = process.env, history = [] } = {}) {
  const payload = buildPayload(cfg, { guild: interaction.guild, view, env, history });
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
  return interaction.update(payload).catch(() => {});
}

// ── Historique ──────────────────────────────────────────────────────────────
async function fetchHistory(guildId, limit = 8) {
  try {
    let query = VPNVerification.find({ guildId });
    if (query && typeof query.sort === 'function') query = query.sort({ createdAt: -1 });
    if (query && typeof query.limit === 'function') query = query.limit(limit);
    if (query && typeof query.lean === 'function') query = query.lean();
    const rows = await query;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function handleComponent(interaction, client, { env = process.env } = {}) {
  const id = interaction.customId;
  if (!id.startsWith('avpn_')) return;

  const isModal = typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit();
  const guildId = interaction.guildId || interaction.guild?.id;
  if (!guildId) return;

  // Contrôle d'accès : le panneau reste réservé au staff, quel que soit le
  // chemin d'ouverture (commande, panel central, bouton).
  if (!interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur** pour configurer l’anti-VPN.')],
      ephemeral: true,
    }).catch(() => {});
  }

  // Un panneau ouvert avant l’expiration de la licence ne doit plus répondre.
  if (!(await ensureLicensed(interaction))) return;

  const cfg = await getConfig(guildId);
  const save = async patch => {
    Object.assign(cfg, patch);
    await cfg.save?.();
    return cfg;
  };

  try {
    // ── Navigation ────────────────────────────────────────────────────────
    if (id === 'avpn_view') {
      const view = interaction.values[0];
      const history = view === 'history' ? await fetchHistory(guildId) : [];
      return updatePanel(interaction, cfg, { view, env, history });
    }
    if (id === 'avpn_refresh') {
      await interaction.deferUpdate?.();
      return updatePanel(interaction, await getConfig(guildId), { view: 'main', env });
    }

    // ── Portail & réseau ──────────────────────────────────────────────────
    if (id === 'avpn_portal_test') {
      await interaction.deferReply({ ephemeral: true });
      const base = publicBaseUrl(env);
      if (!base) {
        return interaction.editReply({ embeds: [errorEmbed('Portail non configuré', 'Ajoute `ANTIVPN_PORT=3199` dans `.env` puis redémarre : le bot crée automatiquement un tunnel Cloudflare gratuit.')] });
      }
      const probe = await probePortal(base);
      const hint = probe.ok
        ? 'Le portail répond : les membres peuvent ouvrir leur lien de vérification.'
        : probePublicHint(probe, base);
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(probe.ok ? COLORS.success : COLORS.error)
          .setTitle(probe.ok ? '✅ Portail joignable' : '⛔ Portail injoignable')
          .setDescription(`Adresse testée : \`${base}/health\`${probe.status ? ` — HTTP ${probe.status}` : ''}${probe.latency != null ? ` en ${probe.latency} ms` : ''}`)
          .addFields(
            { name: probe.ok ? 'Résultat' : 'Erreur', value: probe.ok ? 'La page de vérification est en ligne et répond correctement.' : `\`${probe.error || 'inconnue'}\``, inline: false },
            { name: 'Que faire ?', value: hint, inline: false },
          )
          .setFooter({ text: 'Test à blanc : aucune vérification consommée' })],
      });
    }

    // ── Historique ────────────────────────────────────────────────────────
    if (id === 'avpn_history_refresh') {
      await interaction.deferUpdate?.();
      const history = await fetchHistory(guildId);
      return updatePanel(interaction, cfg, { view: 'history', env, history });
    }

    // ── Export & réinitialisation ─────────────────────────────────────────
    if (id === 'avpn_export') {
      const payload = exportConfig(cfg);
      const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
      return interaction.reply({
        content: '📤 Configuration anti-VPN exportée — aucune clé d’API n’est incluse.',
        files: [new AttachmentBuilder(buffer, { name: `antivpn-${guildId}.json` })],
        ephemeral: true,
      }).catch(() => {});
    }
    if (id === 'avpn_reset_request') {
      return updatePanel(interaction, cfg, { view: 'reset', env });
    }
    if (id === 'avpn_reset_cancel') {
      return updatePanel(interaction, cfg, { view: 'main', env });
    }
    if (id === 'avpn_reset_confirm') {
      await interaction.deferUpdate?.();
      await lockMod.teardownGuild(interaction.guild, cfg).catch(err => {
        console.error('anti-vpn reset:', err.message);
      });
      await AntiVPN.deleteOne({ guildId }).catch(() => {});
      const fresh = await getConfig(guildId);
      return updatePanel(interaction, fresh, { view: 'main', env });
    }

    // ── Interrupteurs ─────────────────────────────────────────────────────
    if (id === 'avpn_toggle') {
      const portal = envStatus(env);
      if (!cfg.enabled && (!portal.portal || portal.portalLocal)) {
        return interaction.reply({
          embeds: [errorEmbed('Portail sans adresse publique', portal.portalLocal
            ? 'Le portail n’écoute que sur `127.0.0.1` : les membres ne peuvent pas l’ouvrir. Vérifie les logs du démarrage — le tunnel Cloudflare doit y afficher une URL `https://…trycloudflare.com` (aucun domaine ni VPS nécessaire). S’il n’apparaît pas, contrôle la connexion Internet puis redémarre le bot.'
            : 'Ajoute `ANTIVPN_PORT=3199` dans `.env` puis redémarre : le bot crée automatiquement un tunnel Cloudflare gratuit. Tu peux aussi renseigner `ANTIVPN_PUBLIC_URL` si tu as un domaine.')],
          ephemeral: true,
        });
      }
      const next = !cfg.enabled;
      await save({ enabled: next });
      // Les opérations suivantes touchent des salons et des rôles : on prend
      // le temps de réponse long avant de les lancer.
      await interaction.deferUpdate?.();
      if (!next) {
        // Désactivation : on rend tout comme avant (rôles restaurés, rôle
        // « mur » supprimé, ses refus d’accès effacés avec lui).
        await lockMod.teardownGuild(interaction.guild, cfg).catch(err => {
          console.error('anti-vpn teardown:', err.message);
        });
      } else if (lockMod.isLockEnabled(cfg)) {
        const sync = await lockMod.syncGuild(interaction.guild, cfg).catch(err => {
          console.error('anti-vpn lock sync:', err.message);
          return null;
        });
        if (sync?.channels?.failed) {
          console.warn(`[anti-vpn] ${sync.channels.failed} salon(s) non verrouillé(s) — vérifie la permission « Gérer les salons ».`);
        }
      }
      return updatePanel(interaction, cfg, { env });
    }

    if (id === 'avpn_lock_toggle') {
      const next = !lockMod.isLockEnabled(cfg);
      cfg.verification.lockAll = next;
      await cfg.save?.();
      await interaction.deferUpdate?.();
      if (!next) {
        await lockMod.teardownGuild(interaction.guild, cfg).catch(err => {
          console.error('anti-vpn teardown:', err.message);
        });
      } else if (cfg.enabled) {
        await lockMod.syncGuild(interaction.guild, cfg).catch(err => {
          console.error('anti-vpn lock sync:', err.message);
        });
      }
      return updatePanel(interaction, cfg, { view: 'roles', env });
    }

    if (id.startsWith('avpn_flag_')) {
      const key = {
        avpn_flag_vpn: 'blockVPN',
        avpn_flag_proxy: 'blockProxy',
        avpn_flag_tor: 'blockTor',
        avpn_flag_hosting: 'blockHosting',
      }[id];
      if (!key) return;
      cfg.detection[key] = !cfg.detection[key];
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'detection', env });
    }

    if (id === 'avpn_failmode') {
      cfg.apiFailure = cfg.apiFailure === 'block' ? 'allow' : 'block';
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'detection', env });
    }

    if (id === 'avpn_store_ip') {
      cfg.storeIp = !cfg.storeIp;
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'detection', env });
    }

    if (id === 'avpn_dm_toggle') {
      cfg.sanction.dmUser = cfg.sanction.dmUser === false;
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'sanction', env });
    }

    if (id === 'avpn_action' || id === 'avpn_timeout_action') {
      const cycle = ACTIONS;
      if (id === 'avpn_action') {
        const index = cycle.indexOf(cfg.sanction.action);
        cfg.sanction.action = cycle[(index + 1) % cycle.length];
      } else {
        const index = cycle.indexOf(cfg.timeoutAction);
        cfg.timeoutAction = cycle[(index + 1) % cycle.length];
      }
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'sanction', env });
    }

    // ── Listes ────────────────────────────────────────────────────────────
    if (id === 'avpn_exempt_clear') {
      cfg.exemptRoles = [];
      cfg.exemptUsers = [];
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'roles', env });
    }
    if (id === 'avpn_lists_clear') {
      cfg.detection.blockCountries = [];
      cfg.detection.allowCountries = [];
      cfg.detection.blockASNs = [];
      cfg.detection.allowIPs = [];
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'lists', env });
    }
    if (id === 'avpn_reset_stats') {
      cfg.stats = { started: 0, passed: 0, blocked: 0, expired: 0, apiErrors: 0, lastCheckAt: null };
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'stats', env });
    }
    if (id === 'avpn_msg_clear') {
      cfg.messages = { verify: '', refusal: '', expired: '' };
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'messages', env });
    }

    // ── Sélecteurs salon / rôle ───────────────────────────────────────────
    if (id === 'avpn_channel_verify' || id === 'avpn_channel_log') {
      const value = interaction.values[0] || null;
      if (id === 'avpn_channel_verify') cfg.verification.channelId = value;
      else cfg.logChannelId = value;
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'places', env });
    }
    if (id === 'avpn_role_before' || id === 'avpn_role_after') {
      const value = interaction.values[0] || null;
      if (id === 'avpn_role_before') cfg.verification.roleBefore = value;
      else cfg.verification.roleAfter = value;
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'places', env });
    }
    if (id === 'avpn_role_quarantine') {
      cfg.sanction.quarantineRoleId = interaction.values[0] || null;
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'roles', env });
    }
    if (id === 'avpn_role_exempt') {
      const roleId = interaction.values[0];
      if (roleId && !cfg.exemptRoles.includes(roleId)) cfg.exemptRoles.push(roleId);
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'roles', env });
    }
    if (id === 'avpn_user_exempt') {
      const userId = interaction.values[0];
      if (userId && !cfg.exemptUsers.includes(userId)) cfg.exemptUsers.push(userId);
      await cfg.save?.();
      return updatePanel(interaction, cfg, { view: 'roles', env });
    }

    // ── Modales ───────────────────────────────────────────────────────────
    if (!isModal) {
      if (id.startsWith('avpn_modal_msg_')) {
        const key = id.slice('avpn_modal_msg_'.length);
        const meta = {
          verify: ['📝 Consigne de vérification', 'Texte affiché avec le lien de vérification', DEFAULT_MESSAGE_HINTS.verify],
          refusal: ['⛔ MP de connexion refusée', 'Texte envoyé quand la connexion est refusée', DEFAULT_MESSAGE_HINTS.refusal],
          expired: ['⌛ MP de délai dépassé', 'Texte envoyé si le délai expire', DEFAULT_MESSAGE_HINTS.expired],
        }[key];
        if (!meta) return;
        return interaction.showModal(modal(id, meta[0], [
          textInput('value', meta[1], cfg.messages?.[key] || '', { placeholder: meta[2].slice(0, 100), max: 1000 }),
        ]));
      }
      if (id === 'avpn_modal_risk') {
        return interaction.showModal(modal('avpn_modal_risk', '🎯 Seuil de risque', [
          textInput('value', 'Score minimal pour refuser (0-100, 0 = ignoré)', cfg.detection.riskThreshold || 0, { placeholder: '70', max: 3 }),
        ]));
      }
      if (id === 'avpn_modal_verify_timeout') {
        return interaction.showModal(modal('avpn_modal_verify_timeout', '⏱️ Délai de vérification', [
          textInput('value', 'Minutes accordées (1-1440)', cfg.verification.timeoutMin || 15, { placeholder: '15', max: 4 }),
        ]));
      }
      if (id === 'avpn_modal_sanction_timeout') {
        return interaction.showModal(modal('avpn_modal_sanction_timeout', '⏳ Durée d’exclusion', [
          textInput('value', 'Minutes (action « timeout »)', cfg.sanction.timeoutMinutes || 1440, { placeholder: '1440', max: 5 }),
        ]));
      }
      if (id === 'avpn_modal_countries' || id === 'avpn_modal_allow_countries') {
        const allow = id === 'avpn_modal_allow_countries';
        return interaction.showModal(modal(id, allow ? '✅ Pays autorisés' : '⛔ Pays bloqués', [
          textInput('value', 'Codes ISO2 séparés par des virgules', (allow ? cfg.detection.allowCountries : cfg.detection.blockCountries).join(', '), { placeholder: 'FR, BE, CH', max: 400 }),
        ]));
      }
      if (id === 'avpn_modal_asn') {
        return interaction.showModal(modal('avpn_modal_asn', '🏷️ ASN bloqués', [
          textInput('value', 'ASN séparés par des virgules', cfg.detection.blockASNs.join(', '), { placeholder: 'AS16276, AS14061', max: 400 }),
        ]));
      }
      if (id === 'avpn_modal_ips') {
        return interaction.showModal(modal('avpn_modal_ips', '📮 IP / CIDR autorisés', [
          textInput('value', 'Une IP ou un CIDR par entrée', cfg.detection.allowIPs.join(', '), { placeholder: '203.0.113.10, 198.51.100.0/24', max: 400 }),
        ]));
      }
      if (id === 'avpn_modal_test') {
        return interaction.showModal(modal('avpn_modal_test', '🧪 Tester une IP', [
          textInput('value', 'Adresse IP à tester', '', { placeholder: '203.0.113.10', max: 64, required: true }),
        ]));
      }
      return;
    }

    // ── Traitement des modales ────────────────────────────────────────────
    const raw = interaction.fields.getTextInputValue('value').trim();

    if (id.startsWith('avpn_modal_msg_')) {
      const key = id.slice('avpn_modal_msg_'.length);
      if (!['verify', 'refusal', 'expired'].includes(key)) return;
      cfg.messages = cfg.messages || {};
      cfg.messages[key] = raw.slice(0, 1000);
      await cfg.save?.();
      await interaction.deferUpdate?.();
      return updatePanel(interaction, cfg, { view: 'messages', env });
    }

    if (id === 'avpn_modal_risk') {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Le seuil doit être un entier entre 0 et 100.')], ephemeral: true });
      }
      cfg.detection.riskThreshold = value;
      await cfg.save?.();
      await interaction.deferUpdate?.();
      return updatePanel(interaction, cfg, { view: 'detection', env });
    }

    if (id === 'avpn_modal_verify_timeout' || id === 'avpn_modal_sanction_timeout') {
      const value = Number(raw);
      const max = id === 'avpn_modal_verify_timeout' ? 1440 : 525600;
      if (!Number.isInteger(value) || value < 1 || value > max) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', `Indique un nombre de minutes entre 1 et ${max}.`)], ephemeral: true });
      }
      if (id === 'avpn_modal_verify_timeout') cfg.verification.timeoutMin = value;
      else cfg.sanction.timeoutMinutes = value;
      await cfg.save?.();
      await interaction.deferUpdate?.();
      return updatePanel(interaction, cfg, { view: 'sanction', env });
    }

    if (id === 'avpn_modal_countries' || id === 'avpn_modal_allow_countries') {
      const parsed = parseCountries(raw);
      if (parsed.rejected.length) {
        return interaction.reply({ embeds: [errorEmbed('Codes refusés', `Ignorés : ${parsed.rejected.join(', ')}. Utilise des codes pays à 2 lettres.`)], ephemeral: true });
      }
      if (id === 'avpn_modal_countries') cfg.detection.blockCountries = parsed.values;
      else cfg.detection.allowCountries = parsed.values;
      await cfg.save?.();
      await interaction.deferUpdate?.();
      return updatePanel(interaction, cfg, { view: 'lists', env });
    }

    if (id === 'avpn_modal_asn') {
      const parsed = parseAsns(raw);
      if (parsed.rejected.length) {
        return interaction.reply({ embeds: [errorEmbed('ASN refusés', `Ignorés : ${parsed.rejected.join(', ')}. Format attendu : AS12345.`)], ephemeral: true });
      }
      cfg.detection.blockASNs = parsed.values;
      await cfg.save?.();
      await interaction.deferUpdate?.();
      return updatePanel(interaction, cfg, { view: 'lists', env });
    }

    if (id === 'avpn_modal_ips') {
      const parsed = parseIps(raw);
      if (parsed.rejected.length) {
        return interaction.reply({ embeds: [errorEmbed('Entrées refusées', `Ignorées : ${parsed.rejected.join(', ')}. Utilise une IP ou un CIDR IPv4 valide.`)], ephemeral: true });
      }
      cfg.detection.allowIPs = parsed.values;
      await cfg.save?.();
      await interaction.deferUpdate?.();
      return updatePanel(interaction, cfg, { view: 'lists', env });
    }

    if (id === 'avpn_modal_test') {
      if (!isIP(raw)) {
        return interaction.reply({ embeds: [errorEmbed('IP invalide', 'Indique une adresse IPv4 ou IPv6 valide.')], ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const result = await inspectIp(raw, cfg, {
        provider: env.ANTIVPN_PROVIDER || 'proxycheck',
        apiKey: env.ANTIVPN_API_KEY,
        env,
      });
      if (!result.ok) {
        return interaction.editReply({ embeds: [errorEmbed('Test impossible', result.error || 'Fournisseur injoignable.')] });
      }
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(result.verdict.blocked ? COLORS.error : COLORS.success)
          .setTitle(result.verdict.blocked ? '⛔ Cette IP serait refusée' : '✅ Cette IP serait acceptée')
          .setDescription(`\`${raw}\`\n${result.summary}\n\n**Fournisseur :** ${result.provider}${result.cached ? ' (cache)' : ''}`)
          .addFields({ name: 'Raisons', value: result.verdict.reasons?.length ? result.verdict.reasons.map(r => `• ${r}`).join('\n') : '*aucune*' })
          .setFooter({ text: 'Test à blanc : aucune sanction appliquée' })],
      });
    }
  } catch (err) {
    console.error('anti-vpn panel:', err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ embeds: [errorEmbed('Erreur', 'Action impossible pour le moment.')], ephemeral: true }).catch(() => {});
    }
  }
}

module.exports = {
  FEATURE,
  VIEWS,
  HIDDEN_VIEWS,
  ACTION_LABELS,
  DEFAULT_MESSAGE_HINTS,
  envStatus,
  diagnosticLines,
  buildEmbed,
  buildComponents,
  buildPayload,
  open,
  handleComponent,
  parseCountries,
  parseAsns,
  parseIps,
  formatHistory,
  exportConfig,
  probePortal,
  previewText,
  PROVIDERS,
};
