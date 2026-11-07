'use strict';
// utils/aiEmbeds.js — Embeds du système IA : panneau d'admin, statistiques et
// réponses de l'assistant.
//
// Deux familles bien séparées :
//   • les PANNEAUX (configuration, statistiques) : outils d'administration,
//     ils gardent leurs boutons et peuvent nommer la mécanique interne ;
//   • les RÉPONSES de l'IA (chat, salon, images, mémoire) : embeds signés REZO,
//     sans le moindre bouton, et sans un mot sur les modèles ou fournisseurs.

const { EmbedBuilder } = require('discord.js');
const { AVAILABLE_MODELS } = require('./geminiClient');
const persona = require('./aiPersona');
const aiMemory = require('./aiMemory');
const { BRAND } = require('./brand');

// Couleur des panneaux d'administration (diagnostic technique).
const AI_COLOR = 0x8E75F5;
// Couleur de TOUT ce que l'IA dit aux membres : la palette REZO. Une réponse de
// l'IA doit ressembler au bot, pas à un service tiers.
const AI_CHAT_COLOR = BRAND.colors.primary;

const EMBED_DESCRIPTION_MAX = 3900; // marge sous la limite Discord (4096)
const MAX_ANSWER_EMBEDS = 3;        // au-delà, l'embed devient illisible

function modelLabel(value) {
  return AVAILABLE_MODELS.find((m) => m.value === value)?.label || value;
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/** Découpe un texte long sur les fins de ligne, jamais au milieu d'un mot. */
function chunkText(text, maxLen = EMBED_DESCRIPTION_MAX) {
  const value = String(text ?? '');
  if (value.length <= maxLen) return [value];
  const chunks = [];
  let remaining = value;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── Panel unique : tout le système IA sur un seul écran ────────────────────
function buildConfigPanelEmbed(guild, cfg) {
  const lockStatus = cfg.locked
    ? `🔒 Verrouillé${cfg.lockedUntil ? ` — réessai <t:${Math.floor(new Date(cfg.lockedUntil).getTime() / 1000)}:R>` : ''}`
    : '🔓 Ouvert';

  const quotaMode = cfg.quotaFallbackMode === 'lock_channel'
    ? '🔒 Verrouillage quand tout est en quota'
    : '🔄 Bascule de modèle automatique';

  const channels = cfg.channelIds?.length
    ? cfg.channelIds.map((id) => `<#${id}>`).join(', ')
    : '*Aucun — le bot ne répond nulle part pour l’instant*';

  const chain = (cfg.modelChain?.length ? cfg.modelChain : ['gemini-2.5-flash']).map((m) => `\`${m}\``).join(' → ');

  return new EmbedBuilder()
    .setColor(AI_CHAT_COLOR)
    .setTitle('🤖 REZO — système IA')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setDescription('Configurez l’assistant **REZO** : les salons où il répond tout seul, sa personnalité, ses limites et sa mémoire. Les membres lui parlent en écrivant simplement un message — aucune commande à taper — et une image se demande en français : « *génère-moi une image de soleil* ».')
    .addFields(
      { name: 'Statut', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'Modèle préféré', value: modelLabel(cfg.model), inline: true },
      { name: 'Créativité', value: `${cfg.temperature}`, inline: true },
      { name: '📣 Salons où je réponds', value: channels, inline: false },
      { name: '🧠 Mémoire longue', value: cfg.memoryEnabled === false ? '🔴 Désactivée' : '🟢 Activée — `/ia memoire`', inline: true },
      { name: '🕘 Mémoire immédiate', value: `${cfg.maxHistoryPairs} échanges`, inline: true },
      { name: '⏳ Limite / membre / jour', value: cfg.dailyLimitPerUser > 0 ? `${cfg.dailyLimitPerUser} messages` : 'Illimité', inline: true },
      { name: '🎯 Modèles de secours', value: chain, inline: false },
      { name: '🛝 Salon créé par le bot', value: cfg.playgroundChannelId ? `<#${cfg.playgroundChannelId}> · slowmode ${cfg.slowmodeSeconds ?? 5}s` : '*Aucun — bouton ci-dessous*', inline: false },
      { name: '🔐 Accès', value: cfg.allowedRoleIds?.length ? cfg.allowedRoleIds.map((id) => `<@&${id}>`).join(', ') : '*Tout le monde*', inline: true },
      { name: '🚦 État', value: lockStatus, inline: true },
      { name: '🧯 Si tout est en quota', value: quotaMode, inline: true },
      { name: '📝 Personnalité du serveur', value: `\`\`\`${(cfg.systemPrompt || '*par défaut*').slice(0, 250)}\`\`\``, inline: false },
    )
    .setFooter({ text: persona.identityFooter() })
    .setTimestamp();
}

// ─── Statistiques (panneau d'administration, auto-actualisé) ────────────────
function buildStatsEmbed(guild, cfg, todayStats, recentDays, providerReport = null, memory = null) {
  const uptime = cfg.createdAt ? `<t:${Math.floor(new Date(cfg.createdAt).getTime() / 1000)}:R>` : 'N/A';
  const errorRate = cfg.totalMessages > 0 ? ((cfg.totalErrors / cfg.totalMessages) * 100).toFixed(1) : '0.0';

  const embed = new EmbedBuilder()
    .setColor(AI_COLOR)
    .setTitle('📊 Système IA — statistiques')
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .addFields(
      { name: '💬 Messages aujourd’hui', value: `**${todayStats?.messageCount ?? 0}**`, inline: true },
      { name: '👥 Membres actifs', value: `**${todayStats?.uniqueUsers?.length ?? 0}**`, inline: true },
      { name: '📈 Total', value: `**${cfg.totalMessages}**`, inline: true },
      { name: '⏱️ Réponse moyenne', value: `**${cfg.avgResponseMs ? Math.round(cfg.avgResponseMs) : 0} ms**`, inline: true },
      { name: '❌ Taux d’erreur', value: `**${errorRate}%**`, inline: true },
      { name: '🕐 Actif depuis', value: uptime, inline: true },
      { name: '🔤 Tokens entrants', value: `${(cfg.totalTokensIn || 0).toLocaleString()}`, inline: true },
      { name: '🔤 Tokens sortants', value: `${(cfg.totalTokensOut || 0).toLocaleString()}`, inline: true },
      { name: '🔌 Dernier moteur', value: cfg.lastProviderId || '*—*', inline: true },
    );

  if (memory) {
    embed.addFields({
      name: '🧠 Mémoire',
      value: [
        `Profils suivis : **${memory.profiles}** · avec résumé : **${memory.summarized}**`,
        memory.latest ? `Dernier membre vu : **${memory.latest.displayName || '—'}** (${aiMemory.humanizeSince(memory.latest.lastSeenAt)})` : 'Aucun membre encore vu',
        cfg.memoryEnabled === false ? '⚠️ Mémoire désactivée sur ce serveur' : null,
      ].filter(Boolean).join('\n'),
      inline: false,
    });
  } else {
    embed.addFields({ name: '🧠 Mémoire', value: '⚠️ Impossible de lire la mémoire (base indisponible) — l’IA répond sans mémoire.', inline: false });
  }

  if (cfg.providerUsage && Object.keys(cfg.providerUsage).length) {
    embed.addFields({
      name: '📡 Réponses par moteur',
      value: Object.entries(cfg.providerUsage).sort((a, b) => b[1] - a[1]).map(([id, count]) => `\`${id}\` — ${count}`).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  if (providerReport?.length) {
    embed.addFields({ name: '🧩 Moteurs disponibles (repli automatique)', value: providerStatusField(providerReport), inline: false });
  }

  if (recentDays?.length) {
    embed.addFields({
      name: '📅 7 derniers jours',
      value: recentDays.map((d) => `\`${d.date}\` — ${d.messageCount} msg · ${d.uniqueUsers.length} membres`).join('\n') || '*Aucune donnée*',
      inline: false,
    });
  }

  embed.setFooter({ text: 'REZO • Actualisé toutes les 10 s' }).setTimestamp();
  return embed;
}

/**
 * Réponse de chat (commande /ia chat).
 * Volontairement muette sur la plomberie : ni modèle, ni fournisseur.
 */
function buildChatReplyEmbed({ question = '', answer = '', userName = null, memoryNote = null } = {}) {
  return new EmbedBuilder()
    .setColor(AI_CHAT_COLOR)
    .setAuthor({ name: `🤖 ${persona.BOT_NAME}${userName ? ` — pour ${userName}` : ''}` })
    .addFields({ name: '💭 Question', value: truncate(question, 300) || '*—*', inline: false })
    .setDescription(truncate(answer, EMBED_DESCRIPTION_MAX) || '*…*')
    .setFooter({ text: memoryNote ? `${persona.identityFooter()} • ${memoryNote}` : persona.identityFooter() })
    .setTimestamp();
}

// ─── Réponse en salon (une ou plusieurs embeds, jamais de bouton) ───────────
function buildAnswerEmbeds(answer, { userName = null, title = null } = {}) {
  const text = String(answer || '').trim() || '*…*';
  const chunks = chunkText(text, EMBED_DESCRIPTION_MAX).slice(0, MAX_ANSWER_EMBEDS);
  const lastIndex = chunks.length - 1;

  return chunks.map((chunk, index) => {
    const embed = new EmbedBuilder().setColor(AI_CHAT_COLOR).setDescription(chunk);
    if (index === 0) embed.setAuthor({ name: title || `🤖 ${persona.BOT_NAME}${userName ? ` — pour ${userName}` : ''}` });
    if (index === lastIndex) embed.setFooter({ text: persona.identityFooter() });
    return embed;
  });
}

// ─── Image générée ─────────────────────────────────────────────────────────
// `attachmentName` a la priorité : une pièce jointe ne disparaît jamais, alors
// qu'un lien distant peut expirer.
function buildImageEmbed({
  prompt = '', userName = null, attachmentName = null, imageUrl = null,
  styleLabel = null, sizeLabel = null, responseMs = null,
} = {}) {
  const embed = new EmbedBuilder()
    .setColor(AI_CHAT_COLOR)
    .setAuthor({ name: `🖼️ ${persona.BOT_NAME} — image générée` })
    .addFields({ name: '🖊️ Demande', value: truncate(prompt, 400) || '*—*', inline: false });

  const meta = [
    styleLabel && styleLabel !== 'aucun' ? `🎨 ${styleLabel}` : null,
    sizeLabel ? `📐 ${sizeLabel}` : null,
    responseMs ? `⏱️ ${(responseMs / 1000).toFixed(1)} s` : null,
  ].filter(Boolean);
  if (meta.length) embed.addFields({ name: 'Réglages', value: meta.join(' · '), inline: true });
  if (userName) embed.addFields({ name: 'Demandée par', value: userName, inline: true });

  const target = attachmentName ? `attachment://${attachmentName}` : imageUrl;
  if (target) embed.setImage(target);

  return embed.setFooter({ text: persona.identityFooter() }).setTimestamp();
}

// ─── Mémoire : ce que l'IA sait de la personne ─────────────────────────────
function buildMemoryEmbed(mem, { action = 'voir' } = {}) {
  if (action === 'oublier') {
    return new EmbedBuilder()
      .setColor(BRAND.colors.success)
      .setTitle('🧽 Mémoire effacée')
      .setDescription('Je ne me souviens plus de rien vous concernant sur ce serveur, et la conversation repart de zéro.\nJ’apprendrai de nouveau au fil des messages.')
      .setFooter({ text: persona.identityFooter() });
  }

  const description = mem ? aiMemory.renderMemory(mem) : '*Aucune mémoire pour l’instant.*';
  return new EmbedBuilder()
    .setColor(AI_CHAT_COLOR)
    .setTitle('🧠 Ma mémoire sur vous')
    .setDescription(truncate(description, EMBED_DESCRIPTION_MAX))
    .setFooter({ text: persona.identityFooter() })
    .setTimestamp();
}

// ─── État des fournisseurs gratuits (panneaux d'admin) ─────────────────────
function providerStatusField(report = []) {
  if (!report.length) return 'Aucun fournisseur configuré.';
  return report.map(p => {
    const state = !p.configured
      ? `⚪ non configuré${p.missing?.length ? ` (${p.missing.join(', ')})` : ''}`
      : p.cooldownUntil
        ? `🟡 quota — retour <t:${Math.floor(p.cooldownUntil.getTime() / 1000)}:R>`
        : '🟢 prêt';
    const quota = p.remaining && (p.remaining.rpm !== null || p.remaining.rpd !== null)
      ? ` · reste ${[p.remaining.rpm !== null ? `${p.remaining.rpm}/min` : null, p.remaining.rpd !== null ? `${p.remaining.rpd}/j` : null].filter(Boolean).join(' · ')}`
      : '';
    const keyless = p.keyless ? ' *(sans clé)*' : '';
    return `**${p.label}**${keyless} — ${state}${quota}`;
  }).join('\n').slice(0, 1024);
}

module.exports = {
  AI_COLOR,
  AI_CHAT_COLOR,
  EMBED_DESCRIPTION_MAX,
  modelLabel,
  providerStatusField,
  buildConfigPanelEmbed,
  buildStatsEmbed,
  buildChatReplyEmbed,
  buildAnswerEmbeds,
  buildImageEmbed,
  buildMemoryEmbed,
  chunkText,
};
