'use strict';
// utils/aiChat.js — Logique centrale du chat IA, partagée entre le mode salon
// (messageCreate) et la commande /ia chat.

const AiConfig       = require('../models/AiConfig');
const AiConversation = require('../models/AiConversation');
const AiDailyStats   = require('../models/AiDailyStats');
const AiModelStatus  = require('../models/AiModelStatus');
const providers       = require('./aiProviders');
const persona         = require('./aiPersona');
const memory          = require('./aiMemory');
const aiCommands      = require('./aiCommands');
const aiQuality       = require('./aiQuality');
const aiWeb           = require('./aiWeb');
const aiEmbeddings    = require('./aiEmbeddings');
const aiStyle         = require('./aiStyle');
const aiOutput        = require('./aiOutput');
const { computeCooldownUntil } = require('./aiQuotaEngine');

const { createBoundedCache } = require('./boundedCache');
// BORNÉ : une entrée par utilisateur ; sans éviction, la mémoire grandit avec
// le nombre de personnes qui parlent au bot.
const cooldowns = createBoundedCache({ max: 20_000, ttl: 0, name: 'ai-chat-cooldown' });
const COOLDOWN_MS = 3000;

// Le quota d'une clé API est partagé par TOUT le bot, d'où un garde-fou global
// (et non par serveur) : inutile de retenter un fournisseur qu'on vient de vider.
const gate = new providers.RateGate();

function providerKey(providerId, model) {
  return `${providerId}:${model}`;
}

/**
 * Chaîne d'essai : fournisseurs configurés, moins ceux dont le quota local est
 * épuisé, moins ceux en cooldown persistant (quota distant déjà constaté).
 * Si TOUT est en cooldown, on tente quand même : un cooldown peut être périmé,
 * et mieux vaut un appel de trop qu'un « je ne peux pas ».
 */
async function buildProviderChain(cfg) {
  const chain = providers.resolveChain(process.env, { gate });
  if (!chain.length) return { chain, blocked: new Set() };

  // Le modèle Gemini choisi dans le panel doit être respecté pour Gemini.
  const tuned = chain.map(entry => (
    entry.provider.id === 'gemini' && /^gemini-/.test(cfg?.model || '')
      ? { ...entry, model: cfg.model }
      : entry
  ));

  const keys = tuned.map(e => providerKey(e.provider.id, e.model));
  const rows = await findCooling(keys);
  const blocked = new Set(rows.map(r => r.modelName));

  const ready = tuned.filter(e => !blocked.has(providerKey(e.provider.id, e.model)));
  return { chain: ready.length ? ready : tuned, blocked };
}

/** Cooldowns persistants encore actifs pour ces clés (jamais bloquant). */
async function findCooling(keys, reference = new Date()) {
  if (!keys.length) return [];
  try {
    return await AiModelStatus.find({ modelName: { $in: keys }, unavailableUntil: { $gt: reference } }).lean();
  } catch {
    // Base indisponible : on préfère tenter un appel que refuser de répondre.
    return [];
  }
}

async function markProviderQuota(provider, model, err) {
  if (!provider?.id) return;
  await AiModelStatus.findOneAndUpdate(
    { modelName: providerKey(provider.id, model) },
    { unavailableUntil: computeCooldownUntil(), lastError: String(err?.message || 'quota').slice(0, 300), lastCheckedAt: new Date() },
    { upsert: true },
  ).catch(() => {});
}

async function markProviderHealthy(provider, model) {
  if (!provider?.id) return;
  await AiModelStatus.findOneAndUpdate(
    { modelName: providerKey(provider.id, model) },
    { unavailableUntil: null, lastCheckedAt: new Date() },
    { upsert: true },
  ).catch(() => {});
}

/** État lisible des fournisseurs (utilisé par /ia stats et le panel). */
async function providerReport() {
  const list = providers.availability(process.env);
  const chain = providers.resolveChain(process.env, { gate });
  const keys = chain.map(e => providerKey(e.provider.id, e.model));
  const rows = await findCooling(keys, new Date(0));
  const byKey = new Map(rows.map(r => [r.modelName, r]));

  return list.map(({ provider, configured, missing }) => {
    const entry = chain.find(e => e.provider.id === provider.id);
    const status = entry ? byKey.get(providerKey(provider.id, entry.model)) : null;
    const cooldownUntil = status?.unavailableUntil && new Date(status.unavailableUntil) > new Date()
      ? new Date(status.unavailableUntil)
      : null;
    return {
      id: provider.id,
      label: provider.label,
      configured,
      missing,
      keyless: Boolean(provider.keyless),
      model: entry?.model || provider.models[0],
      docs: provider.docs,
      remaining: entry ? gate.remaining(provider) : null,
      ready: Boolean(entry) && !cooldownUntil,
      cooldownUntil,
      lastError: status?.lastError || null,
    };
  });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function isOnCooldown(userId) {
  const last = cooldowns.get(userId);
  if (last && Date.now() - last < COOLDOWN_MS) return true;
  cooldowns.set(userId, Date.now());
  return false;
}

// ─── Vérifie si un membre est autorisé à parler à l'IA sur ce serveur ─────
function checkAccess(cfg, member) {
  if (cfg.blockedUserIds.includes(member.id)) return { allowed: false, reason: 'blocked' };
  if (cfg.allowedRoleIds.length > 0) {
    const hasRole = member.roles.cache.some((r) => cfg.allowedRoleIds.includes(r.id));
    if (!hasRole) return { allowed: false, reason: 'role' };
  }
  return { allowed: true };
}

// ─── Récupère (ou crée) la conversation d'un utilisateur ──────────────────
async function getConversation(guildId, userId) {
  let convo = await AiConversation.findOne({ guildId, userId });
  if (!convo) convo = await AiConversation.create({ guildId, userId, messages: [] });
  return convo;
}

// ─── Traite un message utilisateur : interroge la chaîne de fournisseurs ──
// Retourne { text, model, provider, responseMs } en cas de succès, ou lève une
// erreur lisible.
// `userName` vient de Discord (surnom ou pseudo) et alimente la mémoire longue.
async function processMessage({ guild, member, content, userName = null, config = null, client = null, replyTo = null, socialContext = null }) {
  if (!providers.hasAnyProvider()) {
    throw new Error('Aucun fournisseur IA configuré — ajoute une clé gratuite (GEMINI_API_KEY, GROQ_API_KEY…) dans le .env.');
  }

  // `config` peut être fournie par l'appelant (config déjà en cache) : une seule
  // lecture pour toute la chaîne, sans risque de divergence entre deux copies.
  const cfg = config || await AiConfig.findOne({ guildId: guild.id });
  if (!cfg || !cfg.enabled) throw new Error('Le chat IA n\'est pas activé sur ce serveur.');

  // ── Verrou quota : auto-déverrouillage si le délai est passé ────────────
  if (cfg.locked && cfg.lockedUntil && cfg.lockedUntil.getTime() <= Date.now()) {
    cfg.locked = false;
    cfg.lockedUntil = null;
    await cfg.save();
  }
  if (cfg.locked) {
    const ts = Math.floor(cfg.lockedUntil.getTime() / 1000);
    throw new Error(`🔒 Le chat IA est temporairement verrouillé (quota des fournisseurs atteint). Réessaie <t:${ts}:R>.`);
  }

  const access = checkAccess(cfg, member);
  if (!access.allowed) throw new Error(access.reason === 'blocked' ? 'Tu n\'es pas autorisé à utiliser le chat IA.' : 'Tu n\'as pas le rôle requis pour utiliser le chat IA.');

  if (isOnCooldown(member.id)) throw new Error('Trop rapide ! Attends quelques secondes entre deux messages.');

  // ── Mémoire longue : qui parle, et ce qu'on sait déjà de lui ───────────
  const displayName = userName || member?.displayName || member?.user?.username || null;
  const mem = await memory.getMemory(guild.id, member.id, displayName);

  const convo = await getConversation(guild.id, member.id);

  // Limite quotidienne : on compte les messages 'user' de la conversation postés aujourd'hui
  if (cfg.dailyLimitPerUser > 0) {
    const todayStr = todayKey();
    const usedToday = convo.messages.filter((m) => m.role === 'user' && m.ts.toISOString().slice(0, 10) === todayStr).length;
    if (usedToday >= cfg.dailyLimitPerUser) {
      throw new Error(`Limite quotidienne atteinte (${cfg.dailyLimitPerUser} messages/jour). Réessaie demain !`);
    }
  }

  // Historique borné (les N derniers échanges pour limiter le coût en tokens)
  const maxMessages = Math.max(1, cfg.maxHistoryPairs) * 2;
  // L'historique est nettoyé au passage : une réponse d'avant qui aurait laissé
  // filer un nom de fournisseur ne doit pas être réinjectée au modèle.
  const history = convo.messages
    .slice(-maxMessages)
    .map((m) => ({ role: m.role, text: persona.scrubIdentity(m.text) }));

  const { chain } = await buildProviderChain(cfg);

  // Réponses déjà données dans cette conversation : sert à empêcher REZO de se
  // répéter (le prompt l'interdit, cette liste le prouve au modèle).
  const recentReplies = convo.messages
    .filter((m) => m.role === 'model')
    .slice(-4)
    .map((m) => persona.scrubIdentity(m.text))
    .filter(Boolean);

  // Catalogue RÉEL des commandes, généré depuis le registre vivant du bot :
  // l'IA ne peut citer que des commandes qui existent vraiment.
  const commandsBlock = aiCommands.buildCommandsBlock(client, content);

  // Identité REZO + mémoire du membre + catalogue : un seul prompt, appliqué à
  // tous les fournisseurs, pour un comportement identique quel que soit celui
  // qui répond.
  const memoryBlock = cfg.memoryEnabled === false ? null : memory.buildMemoryBlock(mem);

  // ── Contexte enrichi : message cité, salon, style, web, souvenirs ───────
  const extras = [];

  if (replyTo?.author && replyTo?.content) {
    extras.push(`Le message auquel tu réponds vient de ${replyTo.author} : « ${String(replyTo.content).slice(0, 400)} ». Tiens-en compte sans le répéter.`);
  }

  if (cfg.socialContext !== false && socialContext) extras.push(String(socialContext).slice(0, 1200));

  const styleBlock = aiStyle.buildStyleBlock(cfg.styleProfile);
  if (styleBlock) extras.push(styleBlock);

  if (cfg.vectorMemory !== false) {
    try {
      const facts = await aiEmbeddings.recall({ guildId: guild.id, userId: member.id, query: content, limit: 4 });
      if (facts.length) extras.push(`Souvenirs pertinents de tes échanges passés avec cette personne (ne les récite pas) :\n- ${facts.join('\n- ')}`);
    } catch { /* mémoire vectorielle optionnelle */ }
  }

  if (cfg.webSearch !== false && aiWeb.needsWebSearch(content)) {
    try {
      const web = await aiWeb.buildWebContext(content);
      if (web?.block) extras.push(web.block);
    } catch { /* pas de web disponible : on répond avec le reste */ }
  }

  extras.push(aiOutput.buildInstructions(cfg));

  const systemPrompt = persona.buildSystemPrompt(cfg.systemPrompt, {
    userName: mem?.displayName || displayName,
    memoryBlock,
    commandsBlock,
    isCreator: persona.isCreator(member?.id),
    extra: extras.filter(Boolean).join('\n\n') || null,
  });
  const genArgs = { systemPrompt, history, userMessage: content, temperature: cfg.temperature };
  const callOptions = {
    chain,
    gate,
    onQuota: (provider, model, err) => markProviderQuota(provider, model, err),
  };

  // On descend la chaîne : un fournisseur en quota, en panne ou mal configuré
  // ne doit jamais empêcher les suivants de répondre.
  let outcome = await providers.askWithFallback(genArgs, callOptions);

  if (!outcome.ok) {
    await bumpStats(guild.id, member.id, { error: true });
    cfg.totalErrors += 1;

    if (outcome.allExhausted) {
      cfg.quotaHits += 1;
      const soonestAt = await soonestUnlock(chain);
      const when = soonestAt ? ` Réessaie <t:${Math.floor(soonestAt.getTime() / 1000)}:R>.` : '';

      if (cfg.quotaFallbackMode === 'lock_channel') {
        cfg.locked = true;
        cfg.lockedUntil = soonestAt && soonestAt > new Date() ? soonestAt : new Date(Date.now() + cfg.lockDurationMinutes * 60000);
        await cfg.save();
        throw new Error(`🔒 Quota atteint sur tous les fournisseurs gratuits. Chat verrouillé.${when}`);
      }

      await cfg.save();
      throw new Error(`⏳ Tous les fournisseurs gratuits sont à leur quota.${when || ' Réessaie dans quelques minutes.'}`);
    }

    await cfg.save();
    throw new Error(outcome.error || 'Tous les fournisseurs IA ont échoué.');
  }

  let result = outcome;
  // Filet de sécurité : si le modèle a quand même lâché un nom de fournisseur,
  // l'utilisateur ne le verra jamais. On retire aussi les phrases recopiées
  // dans une même réponse.
  result.text = aiQuality.dedupeSentences(persona.scrubIdentity(result.text));

  // Anti-répétition : si la réponse recopie une réponse précédente de CETTE
  // conversation, une seule reformulation est tentée avec une consigne ciblée.
  if (recentReplies.length && aiQuality.isRepetitive(result.text, recentReplies)) {
    try {
      const retry = await providers.askWithFallback({
        ...genArgs,
        temperature: Math.min(1, Number(cfg.temperature ?? 0.9) + 0.15),
        systemPrompt: `${systemPrompt}\n\n${aiQuality.buildRepetitionNudge(recentReplies)}`,
      }, callOptions);

      if (retry.ok) {
        const guarded = aiCommands.sanitizeCommandMentions(persona.scrubIdentity(retry.text), aiCommands.commandEntries(client));
        const retryText = aiQuality.dedupeSentences(guarded.text);
        if (retryText && !aiQuality.isRepetitive(retryText, recentReplies)) {
          result = retry;
          result.text = retryText;
        }
      }
    } catch { /* on garde la première réponse plutôt que d'échouer */ }
  }

  // Directives Discord (réactions, sticker, découpage, actions) : extraites
  // AVANT l'envoi, pour qu'aucune balise ne soit jamais visible.
  const output = aiOutput.parse(result.text);
  if (output.text) result.text = output.text;

  // Dernier verrou de précision : aucune commande inexistante ne part sur
  // Discord, même si le modèle a ignoré le catalogue.
  const guard = aiCommands.sanitizeCommandMentions(result.text, aiCommands.commandEntries(client));
  if (guard.replaced.length) result.text = guard.text;

  const usedModel = result.model;
  const usedProvider = chain.find(e => e.provider.id === result.providerId)?.provider
    || providers.BY_ID.get(result.providerId);
  // Un succès annule le cooldown éventuel de ce fournisseur.
  await markProviderHealthy(usedProvider, result.model);

  // Sauvegarde de l'historique (borné pour éviter une croissance infinie du document)
  convo.messages.push({ role: 'user', text: content, ts: new Date() });
  convo.messages.push({ role: 'model', text: result.text, ts: new Date() });
  const hardCap = maxMessages + 20; // marge avant troncature définitive
  let dropped = [];
  if (convo.messages.length > hardCap) {
    dropped = convo.messages.slice(0, convo.messages.length - hardCap);
    convo.messages = convo.messages.slice(-hardCap);
  }
  convo.updatedAt = new Date();
  await convo.save();



  // Mise à jour des compteurs globaux + moyenne glissante du temps de réponse
  cfg.totalMessages += 1;
  cfg.totalTokensIn  += result.tokensIn;
  cfg.totalTokensOut += result.tokensOut;
  cfg.avgResponseMs   = cfg.avgResponseMs === 0
    ? result.responseMs
    : Math.round(cfg.avgResponseMs * 0.9 + result.responseMs * 0.1); // moyenne glissante
  cfg.lastUsedAt = new Date();
  cfg.lastProviderId = result.providerId;
  if (!cfg.providerUsage) cfg.providerUsage = {};
  cfg.providerUsage[result.providerId] = (cfg.providerUsage[result.providerId] || 0) + 1;
  cfg.markModified('providerUsage');
  await cfg.save();

  // Mémoire vectorielle : un message indexé par échange, en tâche de fond.
  if (cfg.vectorMemory !== false) {
    aiEmbeddings.remember({ guildId: guild.id, userId: member.id, text: content }).catch(() => {});
  }

  // Une seule écriture de mémoire par échange réussi — atomique côté Mongo.
  const memAfter = await memory.touchMemory(mem, {
    displayName: displayName || mem?.displayName,
    kind: 'message',
    topic: String(content).slice(0, 160),
  });

  // Mémoire longue : le résumé se rafraîchit tous les quelques échanges, sans
  // dépendre de la troncature de l'historique (c'était la cause principale des
  // souvenirs « perdus »). Échec silencieux assumé, jamais bloquant.
  try {
    const material = [...dropped, ...convo.messages].slice(-memory.MATERIAL_MAX);
    await memory.maybeSummarize({
      mem: memAfter || mem,
      material,
      chain,
      displayName: memAfter?.displayName || displayName,
    });
  } catch { /* la mémoire ne doit jamais empêcher une réponse */ }

  await bumpStats(guild.id, member.id, { tokensIn: result.tokensIn, tokensOut: result.tokensOut });

  return {
    text: result.text,
    model: usedModel,
    providerId: result.providerId,
    providerLabel: result.providerLabel,
    responseMs: result.responseMs,
    fallbackCount: result.attempts?.length || outcome.attempts?.length || 0,
    userName: mem?.displayName || displayName,
    memorySize: dropped.length,
    directives: {
      reactions: output.reactions,
      sticker: output.sticker,
      actions: output.actions,
      segments: output.segments.length > 1 ? output.segments : null,
    },
  };
}

/** Prochain moment où un fournisseur de la chaîne redeviendra disponible. */
async function soonestUnlock(chain) {
  const keys = chain.map(e => providerKey(e.provider.id, e.model));
  if (!keys.length) return null;
  const rows = await findCooling(keys);
  const times = rows.map(r => new Date(r.unavailableUntil)).filter(d => !Number.isNaN(d.getTime()));
  if (!times.length) return null;
  return new Date(Math.min(...times.map(d => d.getTime())));
}

// ─── Met à jour le document de stats journalières (créé à la volée) ───────
async function bumpStats(guildId, userId, { tokensIn = 0, tokensOut = 0, error = false } = {}) {
  const date = todayKey();
  const update = {
    $inc: {
      messageCount: error ? 0 : 1,
      tokensIn,
      tokensOut,
      errorCount: error ? 1 : 0,
    },
  };
  if (!error) update.$addToSet = { uniqueUsers: userId };
  await AiDailyStats.findOneAndUpdate({ guildId, date }, update, { upsert: true }).catch(() => {});
}

// ─── Réinitialise la mémoire de conversation d'un utilisateur ────────────
async function resetConversation(guildId, userId) {
  await AiConversation.findOneAndUpdate({ guildId, userId }, { messages: [], updatedAt: new Date() }, { upsert: true });
}

module.exports = {
  todayKey,
  getConversation,
  processMessage,
  resetConversation,
  bumpStats,
  providerReport,
  buildProviderChain,
  checkAccess,
  gate,
};
