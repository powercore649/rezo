'use strict';
// utils/antiSpam.js — Anti-spam v2 (membres + webhooks).
//
// Pourquoi ce module : l'ancien anti-spam comptait uniquement des messages par
// membre, dans une `Map` nue (fuite mémoire sur un bot multi-serveurs), et il
// était **totalement contourné par les webhooks**. Or un webhook est le vecteur
// de spam le plus courant : n'importe qui ayant « Gérer les webhooks » peut
// faire poster un flux à sa place, sans appartenir au serveur, sans compte à
// sanctionner, et sans jamais passer par le filtre « auteur = bot ».
//
// Ici, deux familles de détection :
//   • MEMBRES   — flood, doublons (même contenu répété), mentions de masse,
//                 avec escalade de la sanction ;
//   • WEBHOOKS  — flood par webhook (par salon ou par serveur), doublons,
//                 mentions de masse, lien suspect ; action = suppression des
//                 messages, suppression du webhook, ou quarantaine (les deux).
//
// Tout est borné (`createBoundedCache`), testable hors-ligne (les helpers purs
// sont exportés) et ne lève jamais : un souci d'auto-modération ne doit jamais
// casser messageCreate.

const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { createBoundedCache } = require('./boundedCache');
const AutoMod = require('../models/AutoMod');
const readAutoMod = require('./guildConfigCache').registerModel(AutoMod);
const { sendModLog } = require('../commands/moderation/modlog');
const { isOwn } = require('./internalWebhooks');

const MAX_WINDOWS = 20_000;

// Fenêtres glissantes par cible. `ttl` évite qu'une clé inutilisée — un membre
// qui a parlé une fois il y a trois mois — reste en mémoire indéfiniment.
const memberWindows  = createBoundedCache({ max: MAX_WINDOWS, ttl: 15 * 60_000, name: 'antispam-members' });
const webhookWindows = createBoundedCache({ max: MAX_WINDOWS, ttl: 15 * 60_000, name: 'antispam-webhooks' });
const memberStrikes  = createBoundedCache({ max: MAX_WINDOWS, ttl: 60 * 60_000, name: 'antispam-strikes' });
// Fenêtre des COMMANDES (slash et commandes d'autres bots) : distincte de celle
// des messages, parce qu'une rafale de `/ping` n'est pas une rafale de texte et
// que les deux seuils n'ont aucune raison d'être identiques.
const commandWindows = createBoundedCache({ max: MAX_WINDOWS, ttl: 15 * 60_000, name: 'antispam-commands' });

// ─── Rafale « machine » et quarantaine de la source ──────────────────────────
// Un webhook n'est pas un humain : aucune intégration légitime ne poste 5
// messages en 2 secondes dans un même salon. Ce seuil court attrape le flood
// dès le premier souffle, au lieu d'attendre tranquillement le 12e message —
// c'était la raison pour laquelle le garde-fou semblait « ne rien faire » face
// à un vrai spam. Il ne dépend d'AUCUNE configuration : un serveur qui n'a
// jamais ouvert /securite reste protégé.
const BURST = { count: 5, window: 2000 };

// Une fois la source identifiée, on ne rend pas la main message par message :
// sinon un message sur douze est supprimé et le reste du flood passe. Tout ce
// que ce webhook publie est effacé pendant cette durée, sans nouvelle alerte
// (un seul embed par minute au lieu d'un par message).
const LOCK_MS = 60_000;
const webhookLocks = createBoundedCache({ max: MAX_WINDOWS, ttl: LOCK_MS, name: 'antispam-webhook-locks' });

// ─── Réglages (repli + bornes : un document abîmé ne doit pas désactiver la) ─
// ─── protection ni produire une fenêtre de 0 ms (division par zéro).         ─
function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

const MEMBER_DEFAULTS = {
  spamThreshold: 5, spamWindow: 5000, spamAction: 'delete', spamMuteDuration: 10,
  duplicateThreshold: 3, duplicateWindow: 15000,
  mentionLimit: 6, spamEscalate: true,
};

function memberSettings(cfg = {}) {
  return {
    spamThreshold:      boundedInt(cfg.spamThreshold, MEMBER_DEFAULTS.spamThreshold, 2, 50),
    spamWindow:         boundedInt(cfg.spamWindow, MEMBER_DEFAULTS.spamWindow, 500, 120_000),
    spamAction:         String(cfg.spamAction || MEMBER_DEFAULTS.spamAction),
    spamMuteDuration:   boundedInt(cfg.spamMuteDuration, MEMBER_DEFAULTS.spamMuteDuration, 1, 40_320),
    duplicateThreshold: boundedInt(cfg.duplicateThreshold, MEMBER_DEFAULTS.duplicateThreshold, 2, 20),
    duplicateWindow:    boundedInt(cfg.duplicateWindow, MEMBER_DEFAULTS.duplicateWindow, 1000, 300_000),
    mentionLimit:       boundedInt(cfg.mentionLimit, MEMBER_DEFAULTS.mentionLimit, 2, 50),
    spamEscalate:       cfg.spamEscalate !== false,
  };
}

const WEBHOOK_DEFAULTS = {
  threshold: 12, window: 5000, duplicateLimit: 4, mentionLimit: 8,
  action: 'delete', scope: 'channel',
};

function webhookSettings(cfg = {}) {
  const action = ['delete', 'disable', 'quarantine'].includes(cfg.webhookAction)
    ? cfg.webhookAction : WEBHOOK_DEFAULTS.action;
  return {
    enabled:        cfg.webhookGuardEnabled !== false,
    threshold:      boundedInt(cfg.webhookThreshold, WEBHOOK_DEFAULTS.threshold, 3, 200),
    window:         boundedInt(cfg.webhookWindow, WEBHOOK_DEFAULTS.window, 500, 120_000),
    duplicateLimit: boundedInt(cfg.webhookDuplicateLimit, WEBHOOK_DEFAULTS.duplicateLimit, 2, 50),
    mentionLimit:   boundedInt(cfg.webhookMentionLimit, WEBHOOK_DEFAULTS.mentionLimit, 1, 50),
    action,
    scope:          cfg.webhookScope === 'guild' ? 'guild' : 'channel',
    allowlist:      Array.isArray(cfg.webhookAllowlist) ? cfg.webhookAllowlist.map(String) : [],
  };
}

// ─── Commandes : deux familles, un seul interrupteur maître ─────────────────
// `spamEnabled` reste LE bouton de l'anti-spam : ces garde-fous ne s'activent
// jamais seuls, sinon un serveur ayant coupé l'anti-spam verrait quand même ses
// commandes bloquées. Les deux sous-réglages permettent seulement de préciser.
const COMMAND_DEFAULTS = {
  slashThreshold: 6, slashWindow: 10_000,
  externalThreshold: 5, externalWindow: 15_000,
};

function commandSettings(cfg = {}) {
  return {
    master:            cfg.spamEnabled === true,
    slashEnabled:      cfg.commandSpamEnabled !== false,
    slashThreshold:    boundedInt(cfg.commandSpamThreshold, COMMAND_DEFAULTS.slashThreshold, 2, 30),
    slashWindow:       boundedInt(cfg.commandSpamWindow, COMMAND_DEFAULTS.slashWindow, 1000, 120_000),
    externalEnabled:   cfg.externalCmdEnabled !== false,
    externalThreshold: boundedInt(cfg.externalCmdThreshold, COMMAND_DEFAULTS.externalThreshold, 2, 30),
    externalWindow:    boundedInt(cfg.externalCmdWindow, COMMAND_DEFAULTS.externalWindow, 1000, 120_000),
  };
}

// ─── Helpers purs ─────────────────────────────────────────────────────────────

/** Normalise un contenu pour comparer deux messages « identiques ». */
function normalizeContent(text) {
  return String(text || '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '') // caractères invisibles
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 500);
}

/** Empreinte FNV-1a 32 bits : assez stable pour détecter un doublon, sans stocker le texte. */
function hashContent(text) {
  const value = normalizeContent(text);
  if (!value) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/** Mentions réelles d'un message (utilisateurs, rôles, @everyone/@here). */
function countMentions(message) {
  const mentions = message?.mentions || {};
  const users = mentions.users?.size ?? (Array.isArray(mentions.users) ? mentions.users.length : 0);
  const roles = mentions.roles?.size ?? (Array.isArray(mentions.roles) ? mentions.roles.length : 0);
  const content = String(message?.content || '');
  const raw = (content.match(/<@[!&]?\d+>/g) || []).length;
  const everyone = /@everyone|@here/i.test(content) ? 1 : 0;
  return {
    users,
    roles,
    everyone,
    total: Math.max(users + roles + raw, users + roles) + everyone,
  };
}

function containsLink(content) {
  return /(https?:\/\/|www\.)[^\s<]+/i.test(String(content || ''));
}

// Un préfixe de commande « d'ailleurs » : `!`, `?`, `.`, `$`, `%`, `+`, `-`, `~`
// suivi d'une lettre, d'un chiffre ou d'un crochet (les commandes d'autres bots
// sont presque toujours de cette forme). Volontairement strict : un message qui
// commence par une ponctuation isolée (« … bonjour ») n'est pas une commande.
const EXTERNAL_COMMAND_RE = /^[!?$%+\-~.](?=[\p{L}\p{N}_\[])/u;

/**
 * Vrai quand le message ressemble à une commande destinée à un AUTRE bot.
 * Le préfixe du bot lui-même est exclu : nos propres commandes ne sont pas du
 * spam « externe » (elles ont déjà leur propre voie de traitement).
 */
function isExternalCommand(content, { ownPrefix = null } = {}) {
  const text = String(content || '').trim();
  if (!text || text.length > 200) return false;
  if (ownPrefix && text.startsWith(ownPrefix)) return false;
  if (/^<@[!&]?\d+>/.test(text)) return false; // mention, pas une commande
  if (/^https?:\/\//i.test(text)) return false;
  return EXTERNAL_COMMAND_RE.test(text);
}

/**
 * Un membre du staff (ou un rôle exempté) n'est jamais bloqué par ces
 * garde-fous : un modérateur qui enchaîne `/mod lock` puis `/mod slowmode`
 * travaille, il ne spamme pas.
 */
function isCommandGuardExempt(member, cfg = {}) {
  if (!member) return false;
  try {
    if (member.permissions?.has?.(PermissionFlagsBits.ManageMessages)) return true;
    if (member.permissions?.has?.('ManageMessages')) return true;
    if (cfg.exemptRoles?.some?.(roleId => member.roles?.cache?.has?.(roleId))) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Ajoute un événement à une fenêtre glissante et renvoie les compteurs.
 *
 * @returns {{ count: number, duplicates: number, hits: Array<{t:number,h:string|null}> }}
 */
function pushHit(store, key, { windowMs, content = '', now = Date.now() } = {}) {
  const since = now - Math.max(1, Number(windowMs) || 1);
  const previous = (store.get(key) || []).filter(hit => hit && hit.t > since);
  const hash = hashContent(content);
  const hits = previous.concat({ t: now, h: hash });
  store.set(key, hits);
  return {
    count: hits.length,
    duplicates: hash ? hits.filter(hit => hit.h === hash).length : 0,
    hits,
  };
}

/**
 * Traduit des compteurs en infractions lisibles. Fonction pure : c'est elle que
 * les tests vérifient, sans Discord ni base de données.
 *
 * @returns {Array<{code:string,label:string,detail:string}>}
 */
function evaluateSignals({ count = 0, duplicates = 0, mentions = 0 } = {}, settings = {}) {
  const s = { ...WEBHOOK_DEFAULTS, ...settings };
  const duplicateLimit = s.duplicateLimit ?? s.duplicateThreshold ?? 4;
  const reasons = [];
  if (count >= s.threshold) {
    reasons.push({ code: 'burst', label: 'Flood de messages', detail: `${count} messages en ${Math.round(s.window / 1000)} s` });
  }
  if (duplicates >= duplicateLimit && duplicates > 1) {
    reasons.push({ code: 'duplicate', label: 'Messages identiques répétés', detail: `${duplicates} fois le même contenu` });
  }
  if (s.mentionLimit > 0 && mentions >= s.mentionLimit) {
    reasons.push({ code: 'mention', label: 'Mentions de masse', detail: `${mentions} mentions dans un message` });
  }
  return reasons;
}

function isAllowlistedWebhook(message, settings) {
  if (!message?.webhookId) return false;
  return (settings.allowlist || []).includes(String(message.webhookId));
}

function windowKey(message, settings) {
  const scope = settings.scope === 'guild' ? 'g' : message.channelId;
  return `${message.guild?.id || message.guildId}:${scope}:${message.webhookId}`;
}

// ─── Effets Discord ───────────────────────────────────────────────────────────

/** Journalise dans le salon de logs AutoMod, avec repli sur le modlog général. */
async function sendAntiSpamLog(client, guildId, cfg, embed) {
  try {
    const guild = client?.guilds?.cache?.get(guildId);
    const channel = cfg?.logChannelId && guild?.channels?.cache?.get(cfg.logChannelId);
    if (channel?.isTextBased?.()) {
      const perms = channel.permissionsFor?.(guild.members.me);
      if (!perms || perms.has(PermissionFlagsBits.SendMessages)) {
        await channel.send({ embeds: [embed] }).catch(() => {});
        return true;
      }
    }
    await sendModLog(client, guildId, embed).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Supprime le webhook fautif (nécessite « Gérer les webhooks »). */
async function removeWebhook(message) {
  try {
    const guild = message.guild;
    if (!guild?.members?.me?.permissions?.has(PermissionFlagsBits.ManageWebhooks)) return false;
    const hooks = await guild.fetchWebhooks().catch(() => null);
    const hook = hooks?.find?.(h => h.id === message.webhookId) || null;
    if (!hook) return false;
    await hook.delete(`Anti-spam — webhook bloqué (${message.author?.username || message.webhookId})`).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Best effort : efface les derniers messages du webhook dans le salon. */
async function purgeWebhookMessages(message) {
  try {
    const channel = message.channel;
    if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) return 0;
    const me = message.guild?.members?.me;
    if (!me?.permissions?.has(PermissionFlagsBits.ManageMessages)) return 0;
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!recent?.size) return 0;
    const targets = recent.filter(m => m.webhookId === message.webhookId && Date.now() - m.createdTimestamp < 13.5 * 24 * 3600_000);
    if (targets.size === 0) return 0;
    await channel.bulkDelete(targets, true).catch(async () => {
      for (const m of targets.values()) await m.delete().catch(() => {});
    });
    return targets.size;
  } catch {
    return 0;
  }
}

/**
 * Point d'entrée : traite un message publié par un webhook.
 *
 * Ne fait rien (et ne coûte aucune requête) si le message n'est pas un webhook,
 * si le garde-fou est désactivé, ou si le webhook est dans l'allowlist.
 *
 * @returns {Promise<{handled:boolean, reasons?:Array, action?:string, deletedWebhook?:boolean, purged?:number}>}
 */
async function handleWebhookMessage(message, client, { now = Date.now(), cfg = undefined } = {}) {
  try {
    if (!message?.webhookId || !message.guild) return { handled: false };

    // Aucun document AutoMod ? On applique les DÉFAUTS du schéma au lieu de
    // rendre les armes. Avant, un serveur qui n'avait jamais ouvert /securite
    // n'était pas protégé du tout — alors que le schéma annonce le garde-fou
    // actif par défaut. La protection ne dépend plus d'une visite du panel.
    const config = (cfg !== undefined ? cfg : await readAutoMod({ guildId: message.guild.id })) || {};

    const settings = webhookSettings(config);
    if (!settings.enabled) return { handled: false };
    // Webhook créé par le bot (pont inter-serveurs) : jamais traité comme spam.
    if (isOwn(message.webhookId)) return { handled: false };
    if (isAllowlistedWebhook(message, settings)) return { handled: false };
    if (Array.isArray(config.exemptChannels) && config.exemptChannels.includes(message.channelId)) {
      return { handled: false };
    }

    const key = windowKey(message, settings);

    // Source déjà identifiée comme spammeuse : on efface sans re-alerter.
    if (webhookLocks.has(key)) {
      await message.delete().catch(() => {});
      return { handled: true, quiet: true, reasons: [], action: settings.action };
    }

    // Une seule fenêtre en mémoire, assez large pour porter les deux mesures
    // (seuil configuré + rafale courte) : on compte ensuite par sous-fenêtre.
    const { hits } = pushHit(webhookWindows, key, {
      windowMs: Math.max(settings.window, BURST.window),
      content: message.content,
      now,
    });
    const within = ms => hits.filter(hit => hit && hit.t > now - ms).length;

    const count = within(settings.window);
    const burst = within(BURST.window);
    const mentions = countMentions(message);

    // Un webhook qui répète un contenu très court (emoji, « ok ») n'est pas
    // forcément un spam : on exige un minimum de matière pour les doublons.
    const hash = hashContent(message.content);
    const meaningfulDuplicate = normalizeContent(message.content).length >= 4;
    const duplicates = meaningfulDuplicate && hash
      ? hits.filter(hit => hit.h === hash && hit.t > now - settings.window).length
      : 0;

    const reasons = evaluateSignals({ count, duplicates, mentions: mentions.total }, settings);
    if (burst >= BURST.count) {
      reasons.push({
        code: 'burst-fast',
        label: 'Rafale instantanée',
        detail: `${burst} messages en ${BURST.window / 1000} s`,
      });
    }

    if (!reasons.length) return { handled: false };

    // Verrou + remise à zéro : les messages suivants de cette source seront
    // effacés tranquillement, sans une alerte chacun.
    webhookWindows.set(key, []);
    webhookLocks.set(key, true);

    // Une suppression qui échoue (permission « Gérer les messages » absente) ne
    // doit pas être invisible : sans trace, le panel affirme bloquer alors que
    // les messages restent en place.
    let deletedMessage = true;
    await message.delete().catch(err => {
      deletedMessage = false;
      console.warn(`[anti-spam] webhook ${message.webhookId} : suppression impossible (${err?.code || err?.message || 'inconnu'}) — permission « Gérer les messages » ?`);
    });

    let deletedWebhook = false;
    let purged = 0;
    if (settings.action === 'disable') {
      deletedWebhook = await removeWebhook(message);
    } else if (settings.action === 'quarantine') {
      deletedWebhook = await removeWebhook(message);
      purged = await purgeWebhookMessages(message);
    }

    const fields = [
      { name: '🆔 Webhook', value: `\`${message.webhookId}\``, inline: true },
      { name: '⚡ Action', value: `\`${settings.action}\``, inline: true },
      { name: '🧹 Messages', value: `\`${count}\` en ${Math.round(settings.window / 1000)} s`, inline: true },
      { name: '🚨 Détection', value: reasons.map(r => `• **${r.label}** — ${r.detail}`).join('\n').slice(0, 1024), inline: false },
      { name: '🔒 Quarantaine', value: `Tout ce que ce webhook publie est effacé pendant ${Math.round(LOCK_MS / 1000)} s.`, inline: false },
    ];
    if (!deletedMessage) {
      fields.push({
        name: '⚠️ Suppression impossible',
        value: 'Le bot n’a pas la permission **Gérer les messages** (ou le message est trop ancien). Donnez-la lui, sinon les alertes partent sans effet.',
        inline: false,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('🪝 Anti-spam — webhook bloqué')
      .setDescription(`Webhook **${message.author?.username || 'inconnu'}** dans <#${message.channelId}>.`)
      .addFields(fields)
      .setFooter({ text: deletedWebhook ? 'REZO • Webhook supprimé' : 'REZO • Anti-spam webhook' })
      .setTimestamp(new Date(now));

    await sendAntiSpamLog(client, message.guild.id, config, embed);

    return { handled: true, reasons, action: settings.action, deletedWebhook, purged, deletedMessage };
  } catch (err) {
    // Jamais d'exception vers messageCreate.
    console.error('[anti-spam] webhook:', err?.message || err);
    return { handled: false };
  }
}

// ─── Effets : commandes en rafale ──────────────────────────────────────────

/**
 * Compte une commande slash dans la fenêtre du membre.
 * Fonction pure côté Discord : elle ne répond à rien, elle mesure.
 */
function detectCommandSpam(interaction, cfg, { now = Date.now() } = {}) {
  const settings = commandSettings(cfg);
  const guildId = interaction?.guildId || interaction?.guild?.id;
  const userId = interaction?.user?.id;
  if (!settings.master || !settings.slashEnabled || !guildId || !userId) {
    return { spam: false, count: 0, settings };
  }
  const { count } = pushHit(commandWindows, `slash:${guildId}:${userId}`, {
    windowMs: settings.slashWindow,
    content: interaction.commandName || '',
    now,
  });
  return { spam: count >= settings.slashThreshold, count, settings };
}

/**
 * Bloque une commande slash lancée en rafale.
 *
 * Ne mute ni n'expulse : une rafale de commandes est une nuisance, pas une
 * attaque — la bonne réponse est de refuser la commande et de laisser une trace.
 *
 * @returns {Promise<{blocked:boolean, count?:number}>}
 */
async function guardSlashCommand(interaction, client, { cfg = undefined, now = Date.now() } = {}) {
  try {
    if (!interaction?.isChatInputCommand?.() || !interaction.inGuild?.()) return { blocked: false };
    const config = cfg !== undefined ? cfg : await readAutoMod({ guildId: interaction.guildId });
    if (!config?.spamEnabled) return { blocked: false };
    if (isCommandGuardExempt(interaction.member, config)) return { blocked: false };

    const { spam, count, settings } = detectCommandSpam(interaction, config, { now });
    if (!spam) return { blocked: false, count };

    // Remise à zéro : sans ça, la commande suivante re-déclencherait l'alerte.
    commandWindows.set(`slash:${interaction.guildId}:${interaction.user.id}`, []);

    if (interaction.isRepliable?.() && !interaction.deferred && !interaction.replied) {
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setTitle('🚫 Anti-spam — commandes en rafale')
          .setDescription(`Tu as lancé **${count}** commandes en ${Math.round(settings.slashWindow / 1000)} s.\nPatiente quelques secondes avant de réessayer.`)],
        ephemeral: true,
      }).catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('🚫 Anti-spam — commandes bloquées')
      .setDescription(`<@${interaction.user.id}> a enchaîné **${count}** commandes en ${Math.round(settings.slashWindow / 1000)} s.`)
      .addFields(
        { name: '⚡ Action', value: 'Commandes refusées', inline: true },
        { name: '📛 Dernière', value: `\`/${interaction.commandName || 'inconnue'}\``, inline: true },
      )
      .setTimestamp(new Date(now));
    await sendAntiSpamLog(client, interaction.guildId, config, embed);

    return { blocked: true, count };
  } catch (err) {
    console.error('[anti-spam] commande slash:', err?.message || err);
    return { blocked: false };
  }
}

/**
 * Bloque les commandes d'AUTRES bots lancées en rafale (`!play`, `?rank`…).
 *
 * Le message est supprimé ; rien d'autre n'est appliqué, car l'auteur n'a fait
 * qu'utiliser un autre bot — le flood de texte reste du ressort de l'anti-spam
 * classique, qui s'exécute ensuite si ce garde-fou n'a rien fait.
 *
 * @returns {Promise<{handled:boolean, count?:number}>}
 */
async function guardExternalCommand(message, client, {
  cfg = undefined, ownPrefix = null, now = Date.now(),
} = {}) {
  try {
    if (!message?.guild || !message.author || message.author.bot) return { handled: false };
    if (!isExternalCommand(message.content, { ownPrefix })) return { handled: false };

    const config = cfg !== undefined ? cfg : await readAutoMod({ guildId: message.guild.id });
    const settings = commandSettings(config || {});
    if (!settings.master || !settings.externalEnabled) return { handled: false };
    if (isCommandGuardExempt(message.member, config || {})) return { handled: false };
    if (Array.isArray(config?.exemptChannels) && config.exemptChannels.includes(message.channelId)) {
      return { handled: false };
    }

    const key = `ext:${message.guild.id}:${message.author.id}`;
    const { count } = pushHit(commandWindows, key, { windowMs: settings.externalWindow, now });
    if (count < settings.externalThreshold) return { handled: false, count };

    commandWindows.set(key, []);
    await message.delete().catch(() => {});

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle('🚫 Anti-spam — commandes externes')
      .setDescription(`<@${message.author.id}> a lancé **${count}** commandes d'autres bots en ${Math.round(settings.externalWindow / 1000)} s dans <#${message.channelId}>.`)
      .addFields({ name: '⚡ Action', value: 'Message supprimé', inline: true })
      .setTimestamp(new Date(now));
    await sendAntiSpamLog(client, message.guild.id, config, embed);

    return { handled: true, count };
  } catch (err) {
    console.error('[anti-spam] commande externe:', err?.message || err);
    return { handled: false };
  }
}

/**
 * Détection membre (flood + doublons + mentions). Ne supprime rien : l'appelant
 * (commands/moderation/automod.js) applique la sanction configurée.
 *
 * @returns {{ flood:boolean, duplicate:boolean, mention:boolean, count:number, duplicates:number, mentions:number }}
 */
function detectMemberSpam(message, cfg, { now = Date.now() } = {}) {
  const settings = memberSettings(cfg);
  const key = `${message.guild?.id || message.guildId}:${message.author?.id || message.id}`;
  const widest = Math.max(settings.spamWindow, settings.duplicateWindow);
  const { hits } = pushHit(memberWindows, key, { windowMs: widest, content: message.content, now });

  const count = hits.filter(hit => now - hit.t < settings.spamWindow).length;
  const hash = hashContent(message.content);
  const duplicates = hash
    ? hits.filter(hit => hit.h === hash && now - hit.t < settings.duplicateWindow).length
    : 0;
  const mentions = countMentions(message).total;
  // Les messages très courts (« mdr », « ok ») ne comptent pas comme doublons :
  // une conversation rapide ne doit pas être prise pour du spam.
  const meaningful = normalizeContent(message.content).length >= 6;

  return {
    flood:      count >= settings.spamThreshold,
    duplicate:  meaningful && settings.duplicateThreshold > 0 && duplicates >= settings.duplicateThreshold,
    mention:    settings.mentionLimit > 0 && mentions >= settings.mentionLimit,
    count,
    duplicates,
    mentions,
    settings,
  };
}

/** Compte une infraction et renvoie la durée de mute escaladée (minutes). */
function nextMuteDuration(guildId, userId, baseMinutes, { escalate = true, max = 1440 } = {}) {
  const key = `${guildId}:${userId}`;
  const strikes = (memberStrikes.get(key) || 0) + 1;
  memberStrikes.set(key, strikes);
  if (!escalate) return boundedInt(baseMinutes, 10, 1, max);
  return boundedInt(baseMinutes * strikes, 10, 1, max);
}

function resetMemberWindow(guildId, userId) {
  memberWindows.set(`${guildId}:${userId}`, []);
}

function stats() {
  return {
    memberWindows: memberWindows.stats(),
    webhookWindows: webhookWindows.stats(),
    webhookLocks: webhookLocks.stats(),
    memberStrikes: memberStrikes.stats(),
    commandWindows: commandWindows.stats(),
  };
}

function reset() {
  memberWindows.clear();
  webhookWindows.clear();
  webhookLocks.clear();
  memberStrikes.clear();
  commandWindows.clear();
}

module.exports = {
  // réglages
  MEMBER_DEFAULTS,
  WEBHOOK_DEFAULTS,
  COMMAND_DEFAULTS,
  memberSettings,
  webhookSettings,
  commandSettings,
  // helpers purs (testés hors-ligne)
  normalizeContent,
  hashContent,
  countMentions,
  containsLink,
  pushHit,
  evaluateSignals,
  isAllowlistedWebhook,
  windowKey,
  isExternalCommand,
  isCommandGuardExempt,
  detectCommandSpam,
  // effets
  handleWebhookMessage,
  sendAntiSpamLog,
  removeWebhook,
  purgeWebhookMessages,
  detectMemberSpam,
  guardSlashCommand,
  guardExternalCommand,
  nextMuteDuration,
  resetMemberWindow,
  // diagnostic
  stats,
  reset,
  BURST,
  LOCK_MS,
  _caches: { memberWindows, webhookWindows, memberStrikes, commandWindows, webhookLocks },
};
