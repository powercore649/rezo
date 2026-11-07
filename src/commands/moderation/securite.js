// commands/securite.js — Panneau de contrôle sécurité REZO
// Couvre : Captcha · Anti-Spam · Anti-Raid · Anti-Liens · Anti-Caps · Filtre de mots · Mode Raid d'urgence
// 100% autonome — ne dépend d'aucun autre handler externe via fakeInteraction.
// Chaque modification est sauvegardée directement en BDD depuis ce panneau.
'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ChannelType,
} = require('discord.js');

const AutoMod       = require('../../models/AutoMod');
const AutoModAdvanced = require('../../models/AutoModAdvanced');
const { CaptchaConfig } = require('../../models/Captcha');
const { COLORS }   = require('../../utils/embeds');
const { saveDoc }  = require('../../utils/safeSave');
const { gateAudit } = require('../../utils/captchaGuards');
const { getConfig: getVault } = require('../../utils/permissionVault');
const {
  buildVaultEmbed,
  buildVaultComponents,
  handleVaultComponent,
} = require('../../utils/permissionVaultPanel');

// ─── Constantes ───────────────────────────────────────────────────────────────
const TIMEOUT_MS  = 10 * 60 * 1000; // 10 min d'inactivité → collecteur fermé
const OK  = v => v ? '🟢' : '🔴';
const fmt = v => v != null ? String(v) : '—';

// ─── Helpers BDD ─────────────────────────────────────────────────────────────
async function getAutoMod(guildId) {
  return AutoMod.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true }
  );
}
async function getAdvanced(guildId) {
  return AutoModAdvanced.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true }
  );
}
async function getCaptcha(guildId) {
  let cfg = await CaptchaConfig.findOne({ guildId });
  if (!cfg) cfg = await CaptchaConfig.create({ guildId });
  return cfg;
}


// ─── Construire l'embed du tableau de bord principal ────────────────────────
async function buildDashEmbed(guild) {
  const [am, adv, cap, vault] = await Promise.all([
    getAutoMod(guild.id),
    getAdvanced(guild.id),
    getCaptcha(guild.id),
    getVault(guild.id),
  ]);

  const lines = {
    captcha: [
      `${OK(cap.enabled)} Captcha : **${cap.enabled ? 'Activé' : 'Désactivé'}**`,
      cap.channelId ? `  └ Salon: <#${cap.channelId}>` : `  └ Salon: *Non défini*`,
      `  └ Mode: \`${cap.security || 'mixed'}\` · ${cap.attempts || 3} tentatives · ${cap.timeout || 10} min`,
    ].join('\n'),

    antispam: [
      `${OK(am.spamEnabled)} Anti-Spam : **${am.spamEnabled ? 'Activé' : 'Désactivé'}**`,
      `  └ Seuil: **${am.spamThreshold}** msg / **${Math.round(am.spamWindow / 1000)}s** → \`${am.spamAction}\``,
      `  └ Doublons: ${OK(am.duplicateEnabled)} **${am.duplicateThreshold}** · Mentions: ${OK(am.mentionEnabled)} **${am.mentionLimit}**`,
    ].join('\n'),

    webhook: [
      `${OK(am.webhookGuardEnabled)} Anti-Spam Webhooks : **${am.webhookGuardEnabled ? 'Activé' : 'Désactivé'}**`,
      `  └ Seuil: **${am.webhookThreshold}** msg / **${Math.round(am.webhookWindow / 1000)}s** → \`${am.webhookAction}\``,
      `  └ Portée: \`${am.webhookScope}\` · Whitelist: **${(am.webhookAllowlist || []).length}** webhook(s)`,
    ].join('\n'),

    antiraid: [
      `${OK(am.raidEnabled)} Anti-Raid : **${am.raidEnabled ? 'Activé' : 'Désactivé'}**`,
      `  └ Seuil: **${am.raidThreshold}** joins / **${Math.round(am.raidWindow / 1000)}s** → \`${am.raidAction}\``,
      `  └ Déclencher raid auto: ${OK(am.raidAutoTrigger)} · Action: \`${am.raidAutoAction}\``,
      am.raidModeActive ? `  └ 🚨 **MODE RAID ACTIF** depuis <t:${Math.floor(new Date(am.raidModeActivatedAt).getTime() / 1000)}:R>` : '',
    ].filter(Boolean).join('\n'),

    antiliens: [
      `${OK(am.linksEnabled)} Anti-Liens : **${am.linksEnabled ? 'Activé' : 'Désactivé'}**`,
      `  └ Action: \`${am.linksAction}\` · Whitelist: **${am.linksWhitelist.length}** domaine(s)`,
    ].join('\n'),

    anticaps: [
      `${OK(am.capsEnabled)} Anti-Caps : **${am.capsEnabled ? 'Activé' : 'Désactivé'}**`,
      `  └ Seuil: **${am.capsThreshold}%** · Min. **${am.capsMinLength}** caractères`,
    ].join('\n'),

    wordfilter: [
      `${OK(adv.wordFilter?.low?.length > 0 || adv.wordFilter?.medium?.length > 0 || adv.wordFilter?.high?.length > 0)} Filtre de mots`,
      `  └ Bas: **${adv.wordFilter?.low?.length || 0}** · Moyen: **${adv.wordFilter?.medium?.length || 0}** · Haut: **${adv.wordFilter?.high?.length || 0}**`,
    ].join('\n'),

    antispamadv: [
      `${OK(adv.antiSpam?.enabled)} Anti-Spam Avancé`,
      `  └ **${adv.antiSpam?.maxMessages || 5}** msg / **${adv.antiSpam?.perSeconds || 5}s** → mute **${Math.round((adv.antiSpam?.muteDurationSeconds || 600) / 60)} min**`,
    ].join('\n'),

    antimention: [
      `${OK(adv.antiMassMention?.enabled)} Anti-Mention de masse`,
      `  └ Max **${adv.antiMassMention?.maxMentions || 5}** mentions → \`${adv.antiMassMention?.action || 'mute'}\``,
    ].join('\n'),

    graduated: [
      `${OK(adv.graduated?.enabled)} Sanctions graduelles`,
      `  └ **${adv.graduated?.thresholds?.length || 0}** seuil(s) configuré(s)`,
    ].join('\n'),

    coffre: [
      `${OK(vault.enabled)} Coffre-fort de permissions : **${vault.enabled ? 'Actif' : 'Désactivé'}**`,
      `  └ Mode: \`${vault.mode || 'revert'}\` · **${(vault.protectedChannels || []).length}** salon(s) · **${(vault.protectedRoles || []).length}** rôle(s)`,
      `  └ Réparations: **${vault.stats?.reverted || 0}** · Alertes: **${vault.stats?.alerts || 0}**`,
    ].join('\n'),
  };

  const exemptRolesStr  = am.exemptRoles.length  > 0 ? am.exemptRoles.map(r => `<@&${r}>`).join(' ')  : '*Aucun*';
  const exemptChansStr  = am.exemptChannels.length > 0 ? am.exemptChannels.map(c => `<#${c}>`).join(' ') : '*Aucun*';
  const logStr          = am.logChannelId ? `<#${am.logChannelId}>` : '*Non défini*';

  return new EmbedBuilder()
    .setColor(am.raidModeActive ? COLORS.error : COLORS.primary)
    .setTitle(`🛡️ Panneau de Sécurité — ${guild.name}`)
    .setDescription(am.raidModeActive
      ? '> 🚨 **MODE RAID D\'URGENCE ACTIF** — Tous les salons sont verrouillés !'
      : '> Vue d\'ensemble de la protection du serveur. Sélectionnez une section pour configurer.')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .addFields(
      { name: '🔒 Vérification',    value: lines.captcha,     inline: true },
      { name: '🚫 Anti-Spam',       value: lines.antispam,    inline: true },
      { name: '🪝 Webhooks',        value: lines.webhook,     inline: true },
      { name: '⚔️ Anti-Raid',       value: lines.antiraid,    inline: false },
      { name: '🔗 Anti-Liens',      value: lines.antiliens,   inline: true },
      { name: '🔡 Anti-Caps',       value: lines.anticaps,    inline: true },
      { name: '🤬 Filtre de mots',  value: lines.wordfilter,  inline: false },
      { name: '⚡ Anti-Spam Avancé',value: lines.antispamadv, inline: true },
      { name: '📣 Anti-Mention',    value: lines.antimention, inline: true },
      { name: '📈 Sanctions grad.', value: lines.graduated,   inline: true },
      { name: '🗄️ Coffre-fort',     value: lines.coffre,      inline: false },
      { name: '🔕 Rôles exempts',   value: exemptRolesStr,    inline: true },
      { name: '🔕 Salons exempts',  value: exemptChansStr,    inline: true },
      { name: '📋 Logs AutoMod',    value: logStr,            inline: true },
    )
    .setFooter({ text: 'REZO • Panneau Sécurité · Se ferme après 10 min d\'inactivité' })
    .setTimestamp();
}

// ─── Menus de navigation ──────────────────────────────────────────────────────
function buildMainMenu(raidActive) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('sec_menu')
    .setPlaceholder('🛡️ Choisir une section...')
    .addOptions([
      { label: '🔒 Captcha / Vérification',  value: 'captcha',    description: 'Vérification à l\'arrivée des membres',       emoji: '🔒' },
      { label: '🚫 Anti-Spam',               value: 'spam',       description: 'Limiter les messages répétitifs',              emoji: '🚫' },
      { label: '🪝 Anti-Spam Webhooks',      value: 'webhook',    description: 'Bloquer les webhooks qui spamment',            emoji: '🪝' },
      { label: '⚔️ Anti-Raid',               value: 'raid',       description: 'Protéger contre les raids et floods de joins', emoji: '⚔️' },
      { label: '🔗 Anti-Liens',              value: 'links',      description: 'Bloquer les liens non autorisés',              emoji: '🔗' },
      { label: '🔡 Anti-Caps',               value: 'caps',       description: 'Limiter les messages en majuscules',           emoji: '🔡' },
      { label: '🤬 Filtre de mots',          value: 'wordfilter', description: 'Bloquer des mots ou expressions',              emoji: '🤬' },
      { label: '⚡ Anti-Spam Avancé',        value: 'spamadv',    description: 'Anti-spam plus précis avec fenêtre glissante', emoji: '⚡' },
      { label: '📣 Anti-Mention de masse',   value: 'mention',    description: 'Bloquer les mentions en masse',                 emoji: '📣' },
      { label: '📈 Sanctions graduelles',    value: 'graduated',  description: 'Escalade automatique des sanctions',           emoji: '📈' },
      { label: '🗄️ Coffre-fort de permissions', value: 'vault',   description: 'Refermer tout accès élargi sur salons/rôles sensibles', emoji: '🗄️' },
      { label: '🔕 Exemptions',              value: 'exempt',     description: 'Rôles et salons exemptés de l\'auto-mod',       emoji: '🔕' },
      { label: '📋 Salon de logs',           value: 'logs',       description: 'Où envoyer les alertes de modération',         emoji: '📋' },
    ]);

  const raidBtn = new ButtonBuilder()
    .setCustomId('sec_raidmode_toggle')
    .setLabel(raidActive ? '✅ Désactiver Mode Raid' : '🚨 MODE RAID D\'URGENCE')
    .setStyle(raidActive ? ButtonStyle.Success : ButtonStyle.Danger);

  const refreshBtn = new ButtonBuilder()
    .setCustomId('sec_refresh')
    .setLabel('🔄 Actualiser')
    .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(raidBtn, refreshBtn),
  ];
}

// ── CAPTCHA ──
function buildCaptchaEmbed(cap, guild = null) {
  // Le rôle de bypass n'est vérifiable qu'avec le cache du serveur.
  const bypassRole = guild?.roles?.cache?.get && cap.bypassRoleId
    ? (guild.roles.cache.get(cap.bypassRoleId) || null)
    : undefined;
  const audit = gateAudit(cap, { guildId: guild?.id, role: bypassRole });
  const integrity = !cap.enabled
    ? '⚪ Désactivé'
    : audit.problems.length ? `⚠️ ${audit.problems.length} faille(s)` : '🔒 Inviolable';

  return new EmbedBuilder()
    .setColor(cap.enabled ? COLORS.success : COLORS.warning)
    .setTitle('🔒 Captcha — Vérification à l\'arrivée')
    .setDescription('Force les nouveaux membres à résoudre un code avant d\'accéder au serveur.\n*Non contournable : bypass réservé aux rôles gérés par Discord, auto-rôles différés après vérification, captcha non délivrable = accès refusé.*')
    .addFields(
      { name: 'Statut',        value: cap.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Salon',         value: cap.channelId ? `<#${cap.channelId}>` : '*Non défini*', inline: true },
      { name: 'Mode',          value: fmt(cap.security),     inline: true },
      { name: 'Longueur code', value: fmt(cap.codeLength),   inline: true },
      { name: 'Tentatives',    value: fmt(cap.attempts),     inline: true },
      { name: 'Timeout',       value: `${fmt(cap.timeout)} min`, inline: true },
      { name: 'Kick si échoué',value: cap.kickOnFail ? '✅ Oui' : '❌ Non', inline: true },
      { name: 'Rôle avant',    value: cap.roleBefore ? `<@&${cap.roleBefore}>` : '*Aucun*', inline: true },
      { name: 'Rôle après',    value: cap.roleAfter  ? `<@&${cap.roleAfter}>` : '*Aucun*', inline: true },
      { name: 'Bypass',        value: cap.bypassRoleId ? `<@&${cap.bypassRoleId}>${audit.bypass.ok ? '' : ' ⚠️'}` : '*Aucun*', inline: true },
      { name: 'Étanchéité',    value: integrity, inline: true },
    )
    .addFields(...(cap.enabled && audit.problems.length
      ? [{ name: '⚠️ Failles détectées', value: audit.problems.map(p => `• ${p}`).join('\n').slice(0, 1024) }]
      : []))
    .setFooter({ text: 'REZO • Sécurité · Captcha' });
}
function buildCaptchaComponents(cap) {
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_cap_toggle')
    .setLabel(cap.enabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(cap.enabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const configBtn = new ButtonBuilder()
    .setCustomId('sec_cap_config')
    .setLabel('⚙️ Configurer')
    .setStyle(ButtonStyle.Primary);
  const backBtn   = backButton();
  return [
    new ActionRowBuilder().addComponents(toggleBtn, configBtn, backBtn),
  ];
}

// ── ANTI-SPAM ──
function buildSpamEmbed(am) {
  return new EmbedBuilder()
    .setColor(am.spamEnabled ? COLORS.success : COLORS.warning)
    .setTitle('🚫 Anti-Spam')
    .setDescription('Détecte et sanctionne les messages envoyés trop rapidement.')
    .addFields(
      { name: 'Statut',    value: am.spamEnabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Seuil',     value: `${am.spamThreshold} messages`, inline: true },
      { name: 'Fenêtre',   value: `${Math.round(am.spamWindow / 1000)}s`, inline: true },
      { name: 'Action',    value: `\`${am.spamAction}\``, inline: true },
      { name: 'Mute durée',value: `${am.spamMuteDuration} min`, inline: true },
      // Deux vecteurs que l'anti-spam de messages ne voyait pas du tout :
      // une rafale de commandes ne produit aucun message à compter.
      { name: '⌨️ Commandes slash', value: `${am.commandSpamEnabled === false ? '🔴' : '🟢'} ${am.commandSpamThreshold ?? 6} en ${Math.round((am.commandSpamWindow ?? 10000) / 1000)} s`, inline: true },
      { name: '🤖 Commandes externes', value: `${am.externalCmdEnabled === false ? '🔴' : '🟢'} ${am.externalCmdThreshold ?? 5} en ${Math.round((am.externalCmdWindow ?? 15000) / 1000)} s`, inline: true },
    )
    .setFooter({ text: 'REZO • Sécurité · Anti-Spam' });
}
function buildSpamComponents(am) {
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_spam_toggle')
    .setLabel(am.spamEnabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(am.spamEnabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const configBtn = new ButtonBuilder()
    .setCustomId('sec_spam_config')
    .setLabel('⚙️ Configurer')
    .setStyle(ButtonStyle.Primary);
  // Seconde rangée : les garde-fous de COMMANDES. Ils ne s'activent que si
  // l'anti-spam ci-dessus est actif (l'interrupteur maître reste unique),
  // mais chacun peut être coupé séparément.
  const slashBtn = new ButtonBuilder()
    .setCustomId('sec_cmdspam_toggle')
    .setLabel(am.commandSpamEnabled === false ? '⌨️ Slash : off' : '⌨️ Slash : on')
    .setStyle(am.commandSpamEnabled === false ? ButtonStyle.Secondary : ButtonStyle.Success);
  const extBtn = new ButtonBuilder()
    .setCustomId('sec_extcmd_toggle')
    .setLabel(am.externalCmdEnabled === false ? '🤖 Externes : off' : '🤖 Externes : on')
    .setStyle(am.externalCmdEnabled === false ? ButtonStyle.Secondary : ButtonStyle.Success);
  const cmdConfigBtn = new ButtonBuilder()
    .setCustomId('sec_cmdspam_config')
    .setLabel('⚙️ Seuils commandes')
    .setStyle(ButtonStyle.Primary);
  return [
    new ActionRowBuilder().addComponents(toggleBtn, configBtn, backButton()),
    new ActionRowBuilder().addComponents(slashBtn, extBtn, cmdConfigBtn),
  ];
}

// ── ANTI-SPAM WEBHOOKS ──
// Un webhook est un « bot » : il échappe complètement au filtre d'auteur et
// était donc le vecteur de spam le plus facile à exploiter.
function buildWebhookEmbed(am) {
  const allow = am.webhookAllowlist || [];
  const actionLabel = { delete: 'Supprimer les messages', disable: 'Supprimer le webhook', quarantine: 'Quarantaine (webhook + messages)' };
  return new EmbedBuilder()
    .setColor(am.webhookGuardEnabled ? COLORS.success : COLORS.warning)
    .setTitle('🪝 Anti-Spam Webhooks')
    .setDescription(
      'Surveille les messages envoyés par des **webhooks** (annonces, intégrations, bots tiers…).\n'
      + 'Un webhook compromis peut inonder un salon sans qu\'aucun membre ne soit sanctionnable : '
      + 'le bot bloque alors la source.'
    )
    .addFields(
      { name: 'Statut',        value: am.webhookGuardEnabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Seuil',         value: `${am.webhookThreshold} messages`, inline: true },
      { name: 'Fenêtre',       value: `${Math.round(am.webhookWindow / 1000)}s`, inline: true },
      { name: 'Doublons',      value: `${am.webhookDuplicateLimit} fois le même contenu`, inline: true },
      { name: 'Mentions',      value: `${am.webhookMentionLimit} par message`, inline: true },
      { name: 'Portée',        value: am.webhookScope === 'guild' ? 'Tout le serveur' : 'Par salon', inline: true },
      { name: 'Action',        value: `\`${am.webhookAction}\` — ${actionLabel[am.webhookAction] || am.webhookAction}`, inline: true },
      { name: '⚡ Rafale',     value: '5 messages en 2 s → blocage immédiat', inline: true },
      { name: '🔒 Quarantaine', value: 'Tout ce que ce webhook publie est effacé pendant 60 s, sans nouvelle alerte.', inline: false },
      { name: '✅ Webhooks de confiance', value: allow.length ? allow.map(id => `\`${id}\``).join(' ').slice(0, 1024) : '*Aucun*', inline: false },
    )
    .setFooter({ text: 'REZO • Sécurité · Webhooks' });
}
function buildWebhookComponents(am) {
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_webhook_toggle')
    .setLabel(am.webhookGuardEnabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(am.webhookGuardEnabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const configBtn = new ButtonBuilder()
    .setCustomId('sec_webhook_config')
    .setLabel('⚙️ Configurer')
    .setStyle(ButtonStyle.Primary);
  const trustBtn = new ButtonBuilder()
    .setCustomId('sec_webhook_trust')
    .setLabel('✅ Webhook de confiance')
    .setStyle(ButtonStyle.Secondary);
  return [new ActionRowBuilder().addComponents(toggleBtn, configBtn, trustBtn, backButton())];
}

// ── ANTI-RAID ──
function buildRaidEmbed(am) {
  return new EmbedBuilder()
    .setColor(am.raidEnabled ? COLORS.success : COLORS.warning)
    .setTitle('⚔️ Anti-Raid')
    .setDescription('Détecte les raids (afflux soudain de joins) et applique une action automatique.')
    .addFields(
      { name: 'Statut',         value: am.raidEnabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Seuil',          value: `${am.raidThreshold} joins`, inline: true },
      { name: 'Fenêtre',        value: `${Math.round(am.raidWindow / 1000)}s`, inline: true },
      { name: 'Action',         value: `\`${am.raidAction}\``, inline: true },
      { name: 'Déclench. auto', value: am.raidAutoTrigger ? '🟢 Oui' : '🔴 Non', inline: true },
      { name: 'Action auto',    value: `\`${am.raidAutoAction}\``, inline: true },
      { name: 'Âge min compte', value: am.raidMinAccountAge > 0 ? `${am.raidMinAccountAge} jours` : 'Désactivé', inline: true },
      { name: 'Auto-désact.',   value: am.raidAutoDisableMin > 0 ? `${am.raidAutoDisableMin} min` : 'Manuel', inline: true },
      { name: 'Mode Raid',      value: am.raidModeActive ? '🚨 ACTIF' : '✅ Inactif', inline: true },
    )
    .setFooter({ text: 'REZO • Sécurité · Anti-Raid' });
}
function buildRaidComponents(am) {
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_raid_toggle')
    .setLabel(am.raidEnabled ? '🔴 Désactiver détection' : '🟢 Activer détection')
    .setStyle(am.raidEnabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const configBtn = new ButtonBuilder()
    .setCustomId('sec_raid_config')
    .setLabel('⚙️ Configurer')
    .setStyle(ButtonStyle.Primary);
  const autoBtn = new ButtonBuilder()
    .setCustomId('sec_raid_auto_toggle')
    .setLabel(am.raidAutoTrigger ? '⚡ Auto-trigger: ON' : '⚡ Auto-trigger: OFF')
    .setStyle(am.raidAutoTrigger ? ButtonStyle.Success : ButtonStyle.Secondary);
  return [new ActionRowBuilder().addComponents(toggleBtn, configBtn, autoBtn, backButton())];
}

// ── ANTI-LIENS ──
function buildLinksEmbed(am) {
  return new EmbedBuilder()
    .setColor(am.linksEnabled ? COLORS.success : COLORS.warning)
    .setTitle('🔗 Anti-Liens')
    .setDescription('Bloque les liens non autorisés. Vous pouvez définir une whitelist de domaines.')
    .addFields(
      { name: 'Statut',     value: am.linksEnabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Action',     value: `\`${am.linksAction}\``, inline: true },
      { name: 'Whitelist',  value: am.linksWhitelist.length > 0
          ? am.linksWhitelist.map(d => `\`${d}\``).join(', ')
          : '*Aucun domaine autorisé*', inline: false },
    )
    .setFooter({ text: 'REZO • Sécurité · Anti-Liens' });
}
function buildLinksComponents(am) {
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_links_toggle')
    .setLabel(am.linksEnabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(am.linksEnabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const wlBtn = new ButtonBuilder()
    .setCustomId('sec_links_whitelist')
    .setLabel('📝 Gérer la whitelist')
    .setStyle(ButtonStyle.Primary);
  const actionMenu = new StringSelectMenuBuilder()
    .setCustomId('sec_links_action')
    .setPlaceholder(`Action actuelle: ${am.linksAction}`)
    .addOptions([
      { label: '🗑️ Supprimer le message', value: 'delete', default: am.linksAction === 'delete' },
      { label: '⚠️ Avertir',              value: 'warn',   default: am.linksAction === 'warn'   },
      { label: '🔇 Mute',                  value: 'mute',   default: am.linksAction === 'mute'   },
    ]);
  return [
    new ActionRowBuilder().addComponents(actionMenu),
    new ActionRowBuilder().addComponents(toggleBtn, wlBtn, backButton()),
  ];
}

// ── ANTI-CAPS ──
function buildCapsEmbed(am) {
  return new EmbedBuilder()
    .setColor(am.capsEnabled ? COLORS.success : COLORS.warning)
    .setTitle('🔡 Anti-Caps')
    .setDescription('Supprime les messages contenant trop de majuscules.')
    .addFields(
      { name: 'Statut',        value: am.capsEnabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Seuil',         value: `${am.capsThreshold}% de majuscules`, inline: true },
      { name: 'Longueur min.', value: `${am.capsMinLength} caractères`, inline: true },
    )
    .setFooter({ text: 'REZO • Sécurité · Anti-Caps' });
}
function buildCapsComponents(am) {
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_caps_toggle')
    .setLabel(am.capsEnabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(am.capsEnabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const configBtn = new ButtonBuilder()
    .setCustomId('sec_caps_config')
    .setLabel('⚙️ Configurer')
    .setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder().addComponents(toggleBtn, configBtn, backButton())];
}

// ── FILTRE DE MOTS ──
function buildWordFilterEmbed(adv) {
  const wf = adv.wordFilter || {};
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🤬 Filtre de mots')
    .setDescription('Bloque des mots interdits avec 3 niveaux de sévérité et actions différentes.')
    .addFields(
      { name: '🟡 Bas → ' + (wf.lowAction || 'warn'),
        value: wf.low?.length > 0 ? wf.low.map(w => `\`${w}\``).join(', ').slice(0, 300) : '*Aucun*', inline: false },
      { name: '🟠 Moyen → ' + (wf.mediumAction || 'mute'),
        value: wf.medium?.length > 0 ? wf.medium.map(w => `\`${w}\``).join(', ').slice(0, 300) : '*Aucun*', inline: false },
      { name: '🔴 Haut → ' + (wf.highAction || 'kick'),
        value: wf.high?.length > 0 ? wf.high.map(w => `\`${w}\``).join(', ').slice(0, 300) : '*Aucun*', inline: false },
    )
    .setFooter({ text: 'REZO • Sécurité · Filtre de mots' });
}
function buildWordFilterComponents() {
  const levelMenu = new StringSelectMenuBuilder()
    .setCustomId('sec_wf_level')
    .setPlaceholder('📝 Modifier un niveau...')
    .addOptions([
      { label: '🟡 Niveau Bas',    value: 'low',    description: 'Avertissement par défaut'          },
      { label: '🟠 Niveau Moyen',  value: 'medium', description: 'Mute par défaut'                   },
      { label: '🔴 Niveau Haut',   value: 'high',   description: 'Kick par défaut'                   },
    ]);
  return [
    new ActionRowBuilder().addComponents(levelMenu),
    new ActionRowBuilder().addComponents(backButton()),
  ];
}

// ── ANTI-SPAM AVANCÉ ──
function buildSpamAdvEmbed(adv) {
  const as = adv.antiSpam || {};
  return new EmbedBuilder()
    .setColor(as.enabled ? COLORS.success : COLORS.warning)
    .setTitle('⚡ Anti-Spam Avancé')
    .setDescription('Utilise une fenêtre glissante plus précise que l\'anti-spam de base.')
    .addFields(
      { name: 'Statut',     value: as.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Max msgs',   value: `${as.maxMessages || 5}`, inline: true },
      { name: 'Par',        value: `${as.perSeconds || 5}s`, inline: true },
      { name: 'Mute durée', value: `${Math.round((as.muteDurationSeconds || 600) / 60)} min`, inline: true },
    )
    .setFooter({ text: 'REZO • Sécurité · Anti-Spam Avancé' });
}
function buildSpamAdvComponents(adv) {
  const enabled = adv.antiSpam?.enabled;
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_spamadv_toggle')
    .setLabel(enabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const configBtn = new ButtonBuilder()
    .setCustomId('sec_spamadv_config')
    .setLabel('⚙️ Configurer')
    .setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder().addComponents(toggleBtn, configBtn, backButton())];
}

// ── ANTI-MENTION ──
function buildMentionEmbed(adv) {
  const am = adv.antiMassMention || {};
  return new EmbedBuilder()
    .setColor(am.enabled ? COLORS.success : COLORS.warning)
    .setTitle('📣 Anti-Mention de masse')
    .setDescription('Bloque les messages contenant trop de mentions.')
    .addFields(
      { name: 'Statut',     value: am.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Max mentions', value: `${am.maxMentions || 5}`, inline: true },
      { name: 'Action',     value: `\`${am.action || 'mute'}\``, inline: true },
    )
    .setFooter({ text: 'REZO • Sécurité · Anti-Mention' });
}
function buildMentionComponents(adv) {
  const enabled = adv.antiMassMention?.enabled;
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_mention_toggle')
    .setLabel(enabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const configBtn = new ButtonBuilder()
    .setCustomId('sec_mention_config')
    .setLabel('⚙️ Configurer')
    .setStyle(ButtonStyle.Primary);
  const actionMenu = new StringSelectMenuBuilder()
    .setCustomId('sec_mention_action')
    .setPlaceholder(`Action: ${adv.antiMassMention?.action || 'mute'}`)
    .addOptions([
      { label: '⚠️ Avertir', value: 'warn', default: adv.antiMassMention?.action === 'warn' },
      { label: '🔇 Mute',    value: 'mute', default: (!adv.antiMassMention?.action || adv.antiMassMention?.action === 'mute') },
      { label: '👢 Kick',    value: 'kick', default: adv.antiMassMention?.action === 'kick' },
      { label: '🔨 Ban',     value: 'ban',  default: adv.antiMassMention?.action === 'ban'  },
    ]);
  return [
    new ActionRowBuilder().addComponents(actionMenu),
    new ActionRowBuilder().addComponents(toggleBtn, configBtn, backButton()),
  ];
}

// ── SANCTIONS GRADUELLES ──
function buildGraduatedEmbed(adv) {
  const g = adv.graduated || {};
  const thLines = (g.thresholds || []).map((t, i) => `**${i + 1}.** ${t.count} infraction(s) → \`${t.action}\``);
  return new EmbedBuilder()
    .setColor(g.enabled ? COLORS.success : COLORS.warning)
    .setTitle('📈 Sanctions graduelles')
    .setDescription('Escalade automatiquement les sanctions selon le nombre d\'infractions accumulées.')
    .addFields(
      { name: 'Statut',        value: g.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Fenêtre',       value: `${g.windowSeconds || 3600}s`, inline: true },
      { name: 'Seuils configurés', value: thLines.length > 0 ? thLines.join('\n') : '*Aucun seuil défini*', inline: false },
    )
    .setFooter({ text: 'REZO • Sécurité · Sanctions graduelles' });
}
function buildGraduatedComponents(adv) {
  const enabled = adv.graduated?.enabled;
  const toggleBtn = new ButtonBuilder()
    .setCustomId('sec_grad_toggle')
    .setLabel(enabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const configBtn = new ButtonBuilder()
    .setCustomId('sec_grad_config')
    .setLabel('⚙️ Configurer les seuils')
    .setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder().addComponents(toggleBtn, configBtn, backButton())];
}

// ── EXEMPTIONS ──
function buildExemptEmbed(am) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🔕 Exemptions Auto-Mod')
    .setDescription('Les rôles et salons exemptés ne sont pas soumis à l\'auto-modération.')
    .addFields(
      { name: '🎭 Rôles exempts',   value: am.exemptRoles.length  > 0 ? am.exemptRoles.map(r => `<@&${r}>`).join('\n')  : '*Aucun*', inline: true },
      { name: '📁 Salons exempts',  value: am.exemptChannels.length > 0 ? am.exemptChannels.map(c => `<#${c}>`).join('\n') : '*Aucun*', inline: true },
    )
    .setFooter({ text: 'REZO • Sécurité · Exemptions' });
}
function buildExemptComponents() {
  const addRoleBtn   = new ButtonBuilder().setCustomId('sec_exempt_add_role').setLabel('➕ Rôle exempt').setStyle(ButtonStyle.Primary);
  const addChanBtn   = new ButtonBuilder().setCustomId('sec_exempt_add_chan').setLabel('➕ Salon exempt').setStyle(ButtonStyle.Primary);
  const clearRoleBtn = new ButtonBuilder().setCustomId('sec_exempt_clear_roles').setLabel('🗑️ Vider rôles').setStyle(ButtonStyle.Danger);
  const clearChanBtn = new ButtonBuilder().setCustomId('sec_exempt_clear_chans').setLabel('🗑️ Vider salons').setStyle(ButtonStyle.Danger);
  return [new ActionRowBuilder().addComponents(addRoleBtn, addChanBtn, clearRoleBtn, clearChanBtn, backButton())];
}

// ── LOGS ──
function buildLogsEmbed(am) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📋 Logs Auto-Mod')
    .setDescription('Choisissez le salon où seront envoyées les alertes de modération automatique.')
    .addFields(
      { name: 'Salon actuel', value: am.logChannelId ? `<#${am.logChannelId}>` : '*Non défini*', inline: true },
    )
    .setFooter({ text: 'REZO • Sécurité · Logs' });
}
function buildLogsComponents() {
  const chanSelect = new ChannelSelectMenuBuilder()
    .setCustomId('sec_logs_channel')
    .setPlaceholder('📋 Choisir le salon de logs...')
    .setChannelTypes(ChannelType.GuildText);
  const clearBtn = new ButtonBuilder()
    .setCustomId('sec_logs_clear')
    .setLabel('🗑️ Supprimer le salon de logs')
    .setStyle(ButtonStyle.Danger);
  return [
    new ActionRowBuilder().addComponents(chanSelect),
    new ActionRowBuilder().addComponents(clearBtn, backButton()),
  ];
}

// ─── Bouton retour ───────────────────────────────────────────────────────────
function backButton() {
  return new ButtonBuilder()
    .setCustomId('sec_back')
    .setLabel('↩️ Retour')
    .setStyle(ButtonStyle.Secondary);
}

// ─── Modaux ──────────────────────────────────────────────────────────────────
function spamModal(am) {
  const m = new ModalBuilder().setCustomId('sec_modal_spam').setTitle('⚙️ Configurer Anti-Spam');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('seuil').setLabel('Messages avant action (2-20)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.spamThreshold)).setMaxLength(2)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fenetre').setLabel('Fenêtre en secondes (ex: 5)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(Math.round(am.spamWindow / 1000))).setMaxLength(4)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('mute_duree').setLabel('Durée mute en minutes (si mute)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.spamMuteDuration)).setMaxLength(4)
    ),
  );
  return m;
}

// Seuils des deux garde-fous de COMMANDES : les slash lancées en rafale, et les
// commandes d'autres bots (`!play`, `?rank`…) qui ne sont que du texte pour nous.
function cmdSpamModal(am) {
  const field = (customId, label, value, maxLength) => new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(value)
      .setMaxLength(maxLength),
  );
  const m = new ModalBuilder().setCustomId('sec_modal_cmdspam').setTitle('⌨️ Anti-spam de commandes');
  m.addComponents(
    field('slash_seuil', 'Commandes slash avant blocage (2-30)', String(am.commandSpamThreshold ?? 6), 2),
    field('slash_fenetre', 'Fenêtre slash en secondes (1-120)', String(Math.round((am.commandSpamWindow ?? 10000) / 1000)), 3),
    field('ext_seuil', 'Commandes externes avant blocage (2-30)', String(am.externalCmdThreshold ?? 5), 2),
    field('ext_fenetre', 'Fenêtre externes en secondes (1-120)', String(Math.round((am.externalCmdWindow ?? 15000) / 1000)), 3),
  );
  return m;
}

function webhookModal(am) {
  const m = new ModalBuilder().setCustomId('sec_modal_webhook').setTitle('🪝 Anti-Spam Webhooks');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('seuil').setLabel('Messages avant blocage (3-200)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.webhookThreshold)).setMaxLength(3)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fenetre').setLabel('Fenêtre en secondes (1-120)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(Math.round(am.webhookWindow / 1000))).setMaxLength(3)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('doublons').setLabel('Doublons avant blocage (2-50)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.webhookDuplicateLimit)).setMaxLength(2)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('mentions').setLabel('Mentions max par message (1-50)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.webhookMentionLimit)).setMaxLength(2)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('action').setLabel('Action : delete / disable / quarantine').setStyle(TextInputStyle.Short).setRequired(true).setValue(am.webhookAction).setMaxLength(10)
    ),
  );
  return m;
}

function raidModal(am) {
  const m = new ModalBuilder().setCustomId('sec_modal_raid').setTitle('⚙️ Configurer Anti-Raid');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('seuil').setLabel('Joins avant déclenchement (ex: 10)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.raidThreshold)).setMaxLength(3)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('fenetre').setLabel('Fenêtre en secondes (ex: 10)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(Math.round(am.raidWindow / 1000))).setMaxLength(4)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('age_min').setLabel('Âge min. du compte (jours, 0=off)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.raidMinAccountAge)).setMaxLength(4)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('auto_disable').setLabel('Auto-désactivation (minutes, 0=non)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.raidAutoDisableMin)).setMaxLength(4)
    ),
  );
  return m;
}

function capsModal(am) {
  const m = new ModalBuilder().setCustomId('sec_modal_caps').setTitle('⚙️ Configurer Anti-Caps');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('seuil').setLabel('% de majuscules (ex: 70)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.capsThreshold)).setMaxLength(3)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('min_length').setLabel('Longueur minimale du message').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.capsMinLength)).setMaxLength(4)
    ),
  );
  return m;
}

function linksWhitelistModal(am) {
  const m = new ModalBuilder().setCustomId('sec_modal_links_wl').setTitle('📝 Whitelist de domaines');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('domains')
        .setLabel('Domaines autorisés (un par ligne)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue(am.linksWhitelist.join('\n'))
        .setPlaceholder('exemple.com\ndiscord.com\nyoutube.com')
        .setMaxLength(1000)
    ),
  );
  return m;
}

function captchaConfigModal(cap) {
  const m = new ModalBuilder().setCustomId('sec_modal_cap_config').setTitle('⚙️ Configurer Captcha');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('longueur').setLabel('Longueur du code (4-10)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cap.codeLength)).setMaxLength(2)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('tentatives').setLabel('Tentatives avant kick (1-10)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cap.attempts)).setMaxLength(2)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('timeout').setLabel('Timeout en minutes (1-60)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(cap.timeout)).setMaxLength(2)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('security').setLabel('Mode (letters/numbers/mixed/math)').setStyle(TextInputStyle.Short).setRequired(true).setValue(cap.security || 'mixed').setMaxLength(8)
    ),
  );
  return m;
}

function spamAdvModal(adv) {
  const as = adv.antiSpam || {};
  const m  = new ModalBuilder().setCustomId('sec_modal_spamadv').setTitle('⚙️ Anti-Spam Avancé');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('max_msgs').setLabel('Max messages').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(as.maxMessages || 5)).setMaxLength(3)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('per_secs').setLabel('Par combien de secondes').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(as.perSeconds || 5)).setMaxLength(4)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('mute_secs').setLabel('Durée mute (secondes)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(as.muteDurationSeconds || 600)).setMaxLength(6)
    ),
  );
  return m;
}

function mentionModal(adv) {
  const am = adv.antiMassMention || {};
  const m  = new ModalBuilder().setCustomId('sec_modal_mention').setTitle('⚙️ Anti-Mention de masse');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('max_mentions').setLabel('Max mentions par message (1-25)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(am.maxMentions || 5)).setMaxLength(2)
    ),
  );
  return m;
}

function graduatedModal(adv) {
  const g = adv.graduated || {};
  const existing = (g.thresholds || []).map(t => `${t.count}:${t.action}`).join('\n');
  const m = new ModalBuilder().setCustomId('sec_modal_graduated').setTitle('⚙️ Sanctions graduelles');
  m.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('seuils')
        .setLabel('Format: "count:action" (une par ligne)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue(existing)
        .setPlaceholder('3:warn\n5:mute\n7:kick\n10:ban')
        .setMaxLength(500)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('fenetre')
        .setLabel('Fenêtre en secondes (ex: 3600 = 1h)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(g.windowSeconds || 3600))
        .setMaxLength(6)
    ),
  );
  return m;
}

// ─── Helpers de parsing ───────────────────────────────────────────────────────
function safeInt(val, fallback, min = -Infinity, max = Infinity) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ─── Commande principale ──────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('securite')
    .setDescription('🛡️ Ouvre le panneau de sécurité interactif de REZO')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    const { guild, user } = interaction;

    const am  = await getAutoMod(guild.id);
    const embed = await buildDashEmbed(guild);
    const components = buildMainMenu(am.raidModeActive);

    const msg = await interaction.reply({
      embeds: [embed],
      components,
      fetchReply: true,
    });

    const collector = msg.createMessageComponentCollector({
      filter: i => i.user.id === user.id,
      time: TIMEOUT_MS,
    });

    collector.on('collect', async i => {
      try {
        // Protection : le panneau peut verrouiller le serveur, désactiver des
        // protections ou changer des permissions. Une preuve d'identité est
        // exigée dès que le membre a configuré /authentificator (une fois par
        // session de 5 minutes — la commande /securite en ouvre déjà une).
        const { authorizeComponent } = require('../../utils/authGate');
        if (!(await authorizeComponent(i, { label: 'Panneau de sécurité' }))) return;

        const id = i.customId;

        // --- RETOUR AUCUN PANNEAU ---
        if (id === 'sec_back') {
          return await showSection(i, 'main');
        }

        // --- REFRESH ---
        if (id === 'sec_refresh') {
          return await showSection(i, 'main');
        }

        // --- NAVIGATION MENU PRINCIPAL ---
        if (id === 'sec_menu') {
          // L'anti-VPN a sa propre commande (/antivpn) et son propre panneau.
          return await showSection(i, i.values[0]);
        }

        // --- MODE RAID D'URGENCE ---
        if (id === 'sec_raidmode_toggle') {
          const doc = await getAutoMod(guild.id);
          const enable = !doc.raidModeActive;
          // Verrouillage RÉEL de tous les salons : le bouton promettait un
          // verrouillage qui n'était jamais appliqué au serveur.
          const { lockAll } = require('../../utils/antiraidActions');
          const locked = await lockAll(guild, enable);
          doc.raidModeActive = enable;
          doc.raidModeActivatedAt = enable ? new Date() : null;
          await saveDoc(doc);
          await i.followUp({
            content: enable
              ? `🚨 **Mode raid activé** — ${locked} salon(s) verrouillé(s). Personne ne peut écrire sauf le staff.`
              : `✅ **Mode raid levé** — ${locked} salon(s) déverrouillé(s).`,
            ephemeral: true,
          }).catch(() => {});
          return await showSection(i, 'main');
        }

        // --- COFFRE-FORT DE PERMISSIONS ---
        // Le panneau et ses handlers vivent dans utils/permissionVaultPanel.js
        // pour être testables hors-ligne (aucune dépendance au collecteur).
        if (id.startsWith('sec_vault_')) {
          const cfg = await getVault(guild.id);
          await handleVaultComponent(i, { guild, cfg });
          return;
        }

        // --- CAPTCHA ---
        if (id === 'sec_cap_toggle') {
          const cap = await getCaptcha(guild.id);
          // Même garde que /captcha : pas de porte activée sans salon ni rôle
          // vérifié, et toute bascule est journalisée (acte de sécurité).
          if (!cap.enabled && (!cap.channelId || !cap.roleAfter)) {
            return await i.reply({
              content: '⛔ Impossible d\'activer le captcha sans **salon de vérification** et **rôle vérifié** : ouvre `/captcha` pour les définir.',
              ephemeral: true,
            }).catch(() => {});
          }
          cap.enabled = !cap.enabled;
          await saveDoc(cap);
          const { logAction } = require('../../utils/captchaLogger');
          await logAction({
            client: i.client, guildId: guild.id, userId: i.user.id,
            action: cap.enabled ? 'gate_on' : 'gate_off',
            detail: `par ${i.user.username || i.user.id} (via /securite)`,
          }).catch(() => {});
          return await showSection(i, 'captcha');
        }
        if (id === 'sec_cap_config') {
          const cap = await getCaptcha(guild.id);
          await i.showModal(captchaConfigModal(cap));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            cap.codeLength = safeInt(submitted.fields.getTextInputValue('longueur'), 6, 4, 10);
            cap.attempts   = safeInt(submitted.fields.getTextInputValue('tentatives'), 3, 1, 10);
            cap.timeout    = safeInt(submitted.fields.getTextInputValue('timeout'), 10, 1, 60);
            cap.security   = submitted.fields.getTextInputValue('security') || 'mixed';
            await saveDoc(cap);
            return await showSection(submitted, 'captcha');
          }
          return;
        }

        // --- ANTI-SPAM ---
        if (id === 'sec_spam_toggle') {
          const doc = await getAutoMod(guild.id);
          doc.spamEnabled = !doc.spamEnabled;
          await saveDoc(doc);
          return await showSection(i, 'spam');
        }
        if (id === 'sec_spam_config') {
          const doc = await getAutoMod(guild.id);
          await i.showModal(spamModal(doc));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            doc.spamThreshold    = safeInt(submitted.fields.getTextInputValue('seuil'), 5, 2, 20);
            doc.spamWindow       = safeInt(submitted.fields.getTextInputValue('fenetre'), 5, 1, 60) * 1000;
            doc.spamMuteDuration = safeInt(submitted.fields.getTextInputValue('mute_duree'), 10, 1, 1440);
            await saveDoc(doc);
            return await showSection(submitted, 'spam');
          }
          return;
        }

        // --- ANTI-SPAM DE COMMANDES ---
        if (id === 'sec_cmdspam_toggle') {
          const doc = await getAutoMod(guild.id);
          doc.commandSpamEnabled = doc.commandSpamEnabled === false;
          await saveDoc(doc);
          return await showSection(i, 'spam');
        }
        if (id === 'sec_extcmd_toggle') {
          const doc = await getAutoMod(guild.id);
          doc.externalCmdEnabled = doc.externalCmdEnabled === false;
          await saveDoc(doc);
          return await showSection(i, 'spam');
        }
        if (id === 'sec_cmdspam_config') {
          const doc = await getAutoMod(guild.id);
          await i.showModal(cmdSpamModal(doc));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            doc.commandSpamThreshold = safeInt(submitted.fields.getTextInputValue('slash_seuil'), 6, 2, 30);
            doc.commandSpamWindow    = safeInt(submitted.fields.getTextInputValue('slash_fenetre'), 10, 1, 120) * 1000;
            doc.externalCmdThreshold = safeInt(submitted.fields.getTextInputValue('ext_seuil'), 5, 2, 30);
            doc.externalCmdWindow    = safeInt(submitted.fields.getTextInputValue('ext_fenetre'), 15, 1, 120) * 1000;
            await saveDoc(doc);
            return await showSection(submitted, 'spam');
          }
          return;
        }

        // --- ANTI-SPAM WEBHOOKS ---
        if (id === 'sec_webhook_toggle') {
          const doc = await getAutoMod(guild.id);
          doc.webhookGuardEnabled = !doc.webhookGuardEnabled;
          await saveDoc(doc);
          return await showSection(i, 'webhook');
        }
        if (id === 'sec_webhook_config') {
          const doc = await getAutoMod(guild.id);
          await i.showModal(webhookModal(doc));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            doc.webhookThreshold      = safeInt(submitted.fields.getTextInputValue('seuil'), 12, 3, 200);
            doc.webhookWindow         = safeInt(submitted.fields.getTextInputValue('fenetre'), 5, 1, 120) * 1000;
            doc.webhookDuplicateLimit = safeInt(submitted.fields.getTextInputValue('doublons'), 4, 2, 50);
            doc.webhookMentionLimit   = safeInt(submitted.fields.getTextInputValue('mentions'), 8, 1, 50);
            const action = String(submitted.fields.getTextInputValue('action') || '').toLowerCase().trim();
            doc.webhookAction = ['delete', 'disable', 'quarantine'].includes(action) ? action : doc.webhookAction;
            await saveDoc(doc);
            return await showSection(submitted, 'webhook');
          }
          return;
        }
        if (id === 'sec_webhook_trust') {
          const doc = await getAutoMod(guild.id);
          await i.showModal(new ModalBuilder().setCustomId('sec_modal_webhook_trust').setTitle('✅ Webhooks de confiance').addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('ids')
                .setLabel('IDs de webhooks, un par ligne')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue((doc.webhookAllowlist || []).join('\n'))
                .setPlaceholder('123456789012345678')
                .setMaxLength(1000),
            ),
          ));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            doc.webhookAllowlist = String(submitted.fields.getTextInputValue('ids') || '')
              .split(/[\s,]+/)
              .map(v => v.replace(/[^0-9]/g, ''))
              .filter(Boolean)
              .slice(0, 25);
            await saveDoc(doc);
            return await showSection(submitted, 'webhook');
          }
          return;
        }

        // --- ANTI-RAID ---
        if (id === 'sec_raid_toggle') {
          const doc = await getAutoMod(guild.id);
          doc.raidEnabled = !doc.raidEnabled;
          await saveDoc(doc);
          return await showSection(i, 'raid');
        }
        if (id === 'sec_raid_auto_toggle') {
          const doc = await getAutoMod(guild.id);
          doc.raidAutoTrigger = !doc.raidAutoTrigger;
          await saveDoc(doc);
          return await showSection(i, 'raid');
        }
        if (id === 'sec_raid_config') {
          const doc = await getAutoMod(guild.id);
          await i.showModal(raidModal(doc));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            doc.raidThreshold      = safeInt(submitted.fields.getTextInputValue('seuil'), 10, 2, 100);
            doc.raidWindow         = safeInt(submitted.fields.getTextInputValue('fenetre'), 10, 1, 300) * 1000;
            doc.raidMinAccountAge  = safeInt(submitted.fields.getTextInputValue('age_min'), 0, 0, 365);
            doc.raidAutoDisableMin = safeInt(submitted.fields.getTextInputValue('auto_disable'), 0, 0, 1440);
            await saveDoc(doc);
            return await showSection(submitted, 'raid');
          }
          return;
        }

        // --- ANTI-LIENS ---
        if (id === 'sec_links_toggle') {
          const doc = await getAutoMod(guild.id);
          doc.linksEnabled = !doc.linksEnabled;
          await saveDoc(doc);
          return await showSection(i, 'links');
        }
        if (id === 'sec_links_action') {
          const doc = await getAutoMod(guild.id);
          doc.linksAction = i.values[0];
          await saveDoc(doc);
          return await showSection(i, 'links');
        }
        if (id === 'sec_links_whitelist') {
          const doc = await getAutoMod(guild.id);
          await i.showModal(linksWhitelistModal(doc));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            const raw = submitted.fields.getTextInputValue('domains') || '';
            doc.linksWhitelist = raw.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
            await saveDoc(doc);
            return await showSection(submitted, 'links');
          }
          return;
        }

        // --- ANTI-CAPS ---
        if (id === 'sec_caps_toggle') {
          const doc = await getAutoMod(guild.id);
          doc.capsEnabled = !doc.capsEnabled;
          await saveDoc(doc);
          return await showSection(i, 'caps');
        }
        if (id === 'sec_caps_config') {
          const doc = await getAutoMod(guild.id);
          await i.showModal(capsModal(doc));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            doc.capsThreshold = safeInt(submitted.fields.getTextInputValue('seuil'), 70, 10, 100);
            doc.capsMinLength = safeInt(submitted.fields.getTextInputValue('min_length'), 10, 1, 500);
            await saveDoc(doc);
            return await showSection(submitted, 'caps');
          }
          return;
        }

        // --- FILTRE DE MOTS ---
        if (id === 'sec_wf_level') {
          const level = i.values[0];
          const adv = await getAdvanced(guild.id);
          const currentWords = (adv.wordFilter?.[level] || []).join('\n');

          const modal = new ModalBuilder()
            .setCustomId(`sec_modal_wf_${level}`)
            .setTitle(`🤬 Filtre de mots (${level.toUpperCase()})`);

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('words')
                .setLabel('Mots interdits (un par ligne)')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue(currentWords)
                .setMaxLength(1000)
            )
          );

          await i.showModal(modal);
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            const raw = submitted.fields.getTextInputValue('words') || '';
            const list = raw.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
            if (!adv.wordFilter) adv.wordFilter = {};
            adv.wordFilter[level] = list;
            await saveDoc(adv);
            return await showSection(submitted, 'wordfilter');
          }
          return;
        }

        // --- ANTI-SPAM AVANCÉ ---
        if (id === 'sec_spamadv_toggle') {
          const adv = await getAdvanced(guild.id);
          if (!adv.antiSpam) adv.antiSpam = {};
          adv.antiSpam.enabled = !adv.antiSpam.enabled;
          await saveDoc(adv);
          return await showSection(i, 'spamadv');
        }
        if (id === 'sec_spamadv_config') {
          const adv = await getAdvanced(guild.id);
          await i.showModal(spamAdvModal(adv));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            if (!adv.antiSpam) adv.antiSpam = {};
            adv.antiSpam.maxMessages        = safeInt(submitted.fields.getTextInputValue('max_msgs'), 5, 2, 50);
            adv.antiSpam.perSeconds         = safeInt(submitted.fields.getTextInputValue('per_secs'), 5, 1, 60);
            adv.antiSpam.muteDurationSeconds = safeInt(submitted.fields.getTextInputValue('mute_secs'), 600, 10, 86400);
            await saveDoc(adv);
            return await showSection(submitted, 'spamadv');
          }
          return;
        }

        // --- ANTI-MENTION ---
        if (id === 'sec_mention_toggle') {
          const adv = await getAdvanced(guild.id);
          if (!adv.antiMassMention) adv.antiMassMention = {};
          adv.antiMassMention.enabled = !adv.antiMassMention.enabled;
          await saveDoc(adv);
          return await showSection(i, 'mention');
        }
        if (id === 'sec_mention_action') {
          const adv = await getAdvanced(guild.id);
          if (!adv.antiMassMention) adv.antiMassMention = {};
          adv.antiMassMention.action = i.values[0];
          await saveDoc(adv);
          return await showSection(i, 'mention');
        }
        if (id === 'sec_mention_config') {
          const adv = await getAdvanced(guild.id);
          await i.showModal(mentionModal(adv));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            if (!adv.antiMassMention) adv.antiMassMention = {};
            adv.antiMassMention.maxMentions = safeInt(submitted.fields.getTextInputValue('max_mentions'), 5, 1, 25);
            await saveDoc(adv);
            return await showSection(submitted, 'mention');
          }
          return;
        }

        // --- SANCTIONS GRADUELLES ---
        if (id === 'sec_grad_toggle') {
          const adv = await getAdvanced(guild.id);
          if (!adv.graduated) adv.graduated = {};
          adv.graduated.enabled = !adv.graduated.enabled;
          await saveDoc(adv);
          return await showSection(i, 'graduated');
        }
        if (id === 'sec_grad_config') {
          const adv = await getAdvanced(guild.id);
          await i.showModal(graduatedModal(adv));
          const submitted = await i.awaitModalSubmit({ time: 60000 }).catch(() => null);
          if (submitted) {
            if (!adv.graduated) adv.graduated = {};
            const rawSeuils = submitted.fields.getTextInputValue('seuils') || '';
            const thresholds = rawSeuils.split('\n').map(line => {
              const [countStr, action] = line.split(':');
              const count = parseInt(countStr, 10);
              if (!count || !action) return null;
              return { count, action: action.trim().toLowerCase() };
            }).filter(Boolean);

            adv.graduated.thresholds = thresholds;
            adv.graduated.windowSeconds = safeInt(submitted.fields.getTextInputValue('fenetre'), 3600, 60, 604800);
            await saveDoc(adv);
            return await showSection(submitted, 'graduated');
          }
          return;
        }

        // --- EXEMPTIONS ---
        if (id === 'sec_exempt_clear_roles') {
          const doc = await getAutoMod(guild.id);
          doc.exemptRoles = [];
          await saveDoc(doc);
          return await showSection(i, 'exempt');
        }
        if (id === 'sec_exempt_clear_chans') {
          const doc = await getAutoMod(guild.id);
          doc.exemptChannels = [];
          await saveDoc(doc);
          return await showSection(i, 'exempt');
        }
        if (id === 'sec_exempt_add_role') {
          const menu = new RoleSelectMenuBuilder().setCustomId('sec_select_exempt_role').setPlaceholder('Sélectionner un rôle...');
          await i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
          const sel = await msg.channel.awaitMessageComponent({ filter: sub => sub.customId === 'sec_select_exempt_role' && sub.user.id === user.id, time: 30000 }).catch(() => null);
          if (sel) {
            const doc = await getAutoMod(guild.id);
            const roleId = sel.values[0];
            if (!doc.exemptRoles.includes(roleId)) doc.exemptRoles.push(roleId);
            await saveDoc(doc);
            await sel.deferUpdate();
            await i.deleteReply().catch(() => null);
            return await showSection(i, 'exempt');
          }
          return;
        }
        if (id === 'sec_exempt_add_chan') {
          const menu = new ChannelSelectMenuBuilder().setCustomId('sec_select_exempt_chan').setPlaceholder('Sélectionner un salon...');
          await i.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
          const sel = await msg.channel.awaitMessageComponent({ filter: sub => sub.customId === 'sec_select_exempt_chan' && sub.user.id === user.id, time: 30000 }).catch(() => null);
          if (sel) {
            const doc = await getAutoMod(guild.id);
            const chanId = sel.values[0];
            if (!doc.exemptChannels.includes(chanId)) doc.exemptChannels.push(chanId);
            await saveDoc(doc);
            await sel.deferUpdate();
            await i.deleteReply().catch(() => null);
            return await showSection(i, 'exempt');
          }
          return;
        }

        // --- LOGS ---
        if (id === 'sec_logs_channel') {
          const doc = await getAutoMod(guild.id);
          doc.logChannelId = i.values[0];
          await saveDoc(doc);
          return await showSection(i, 'logs');
        }
        if (id === 'sec_logs_clear') {
          const doc = await getAutoMod(guild.id);
          doc.logChannelId = null;
          await saveDoc(doc);
          return await showSection(i, 'logs');
        }

      } catch (err) {
        console.error('Erreur collecteur securite:', err);
      }
    });

    collector.on('end', async () => {
      await interaction.editReply({ components: [] }).catch(() => null);
    });

    // ─── Fonction d'affichage dynamique adaptative ───────────────────────────
    async function showSection(targetInteraction, section) {
      const am  = await getAutoMod(guild.id);
      const adv = await getAdvanced(guild.id);
      const cap = await getCaptcha(guild.id);

      let embed, components;

      switch (section) {
        case 'captcha':
          embed = buildCaptchaEmbed(cap, guild);
          components = buildCaptchaComponents(cap);
          break;
        case 'spam':
          embed = buildSpamEmbed(am);
          components = buildSpamComponents(am);
          break;
        case 'webhook':
          embed = buildWebhookEmbed(am);
          components = buildWebhookComponents(am);
          break;
        case 'raid':
          embed = buildRaidEmbed(am);
          components = buildRaidComponents(am);
          break;
        case 'links':
          embed = buildLinksEmbed(am);
          components = buildLinksComponents(am);
          break;
        case 'caps':
          embed = buildCapsEmbed(am);
          components = buildCapsComponents(am);
          break;
        case 'wordfilter':
          embed = buildWordFilterEmbed(adv);
          components = buildWordFilterComponents();
          break;
        case 'spamadv':
          embed = buildSpamAdvEmbed(adv);
          components = buildSpamAdvComponents(adv);
          break;
        case 'mention':
          embed = buildMentionEmbed(adv);
          components = buildMentionComponents(adv);
          break;
        case 'graduated':
          embed = buildGraduatedEmbed(adv);
          components = buildGraduatedComponents(adv);
          break;
        case 'vault': {
          const vault = await getVault(guild.id);
          embed = buildVaultEmbed(vault, guild);
          components = buildVaultComponents(vault);
          break;
        }
        case 'exempt':
          embed = buildExemptEmbed(am);
          components = buildExemptComponents();
          break;
        case 'logs':
          embed = buildLogsEmbed(am);
          components = buildLogsComponents();
          break;
        case 'main':
        default:
          embed = await buildDashEmbed(guild);
          components = buildMainMenu(am.raidModeActive);
          break;
      }

      // ⚠️ Correction essentielle : On vérifie si l'interaction a déjà été répondue/différée
      if (targetInteraction.replied || targetInteraction.deferred) {
        return await targetInteraction.editReply({ embeds: [embed], components }).catch(() => null);
      } else {
        return await targetInteraction.update({ embeds: [embed], components }).catch(() => null);
      }
    }
  },
};