'use strict';
// utils/aiPlaygroundHandler.js — Réponse de l'IA dans un salon activé.
//
// C'est LE point d'entrée unique : que la personne écrive dans le salon créé par
// le bot ou dans n'importe quel salon qu'un admin a activé, tout passe ici.
//
// Avant, ce fichier avait son propre chemin (aiService + AiPlaygroundConfig) :
// limite quotidienne, mémoire et compteurs ne s'appliquaient donc qu'à moitié,
// et les réponses partaient en texte brut. Désormais il délègue à
// aiChat.processMessage — une seule logique, une seule mémoire, un seul jeu de
// limites — et n'a plus qu'un rôle : parler à Discord.
//
// Deux règles de forme, tenues par ce module :
//   • une réponse de l'IA est TOUJOURS un embed, jamais du texte brut ;
//   • aucune réponse ne porte de bouton — rien à cliquer, juste à lire.

const { AttachmentBuilder } = require('discord.js');
const { processMessage, checkAccess } = require('./aiChat');
const aiMemory = require('./aiMemory');
const aiImages = require('./aiImages');
const aiTranscribe = require('./aiTranscribe');
const aiModeration = require('./aiModeration');
const aiVoice = require('./aiVoice');
const { buildAnswerEmbeds, buildImageEmbed } = require('./aiEmbeds');
const { errorEmbed, infoEmbed } = require('./embeds');

const MAX_PROMPT_LENGTH = 2000;

// « /image un dragon », « !image un dragon », « image: un dragon »
const IMAGE_PREFIXES = [
  /^\/(?:image|img|imagine)\s+/i,
  /^!(?:image|img|imagine)\s+/i,
  /^image\s*[:=]\s*/i,
];

/** Préfixe explicite ; renvoie le prompt, ou null. */
function extractImagePrompt(content) {
  const text = String(content || '').trim();
  for (const pattern of IMAGE_PREFIXES) {
    const match = pattern.exec(text);
    if (match) return text.slice(match[0].length).trim();
  }
  return null;
}

/**
 * Décide s'il faut générer une image : préfixe explicite, ou simple phrase
 * (« génère-moi une image de soleil », « dessine un chat qui dort »).
 */
function resolveImageRequest(content) {
  const explicit = extractImagePrompt(content);
  if (explicit !== null) return { prompt: explicit, style: null, size: null };
  return aiImages.detectImageRequest(content);
}

function displayNameOf(message) {
  return message.member?.displayName
    || message.author?.globalName
    || message.author?.username
    || null;
}

/** Membre exploitable même quand le cache de Discord ne l'a pas encore. */
async function resolveMember(message, userName) {
  if (message.member) return message.member;
  const fetched = await message.guild?.members?.fetch?.(message.author?.id).catch(() => null);
  if (fetched) return fetched;
  return {
    id: message.author?.id,
    displayName: userName,
    user: message.author,
    roles: { cache: { some: () => false } },
  };
}

async function handleAiPlaygroundMessage(message, cfg, client) {
  let content = String(message.content || '').trim();

  // ── 0. Vocal → texte : un message audio n'a pas de contenu textuel ──────
  if (!content && cfg.voiceTranscription !== false) {
    const audio = message.attachments?.find?.((a) => aiTranscribe.looksLikeAudio(a));
    if (audio) {
      try {
        const transcript = await aiTranscribe.transcribeUrl(audio.url);
        if (transcript) content = transcript;
      } catch { await message.react('🎙️').catch(() => {}); }
    }
  }
  if (!content) return;

  const userName = displayNameOf(message);
  const mem = await aiMemory.getMemory(message.guild?.id, message.author?.id, userName);

  // ── 1. Image : ne consomme aucun quota de texte ────────────────────────
  const image = resolveImageRequest(content);
  if (image) {
    await handleImageRequest(message, { request: image, userName, mem, cfg });
    return;
  }

  // ── 2. Salon verrouillé : une réaction, pas un message par tentative ───
  if (cfg.locked) {
    await message.react('🔒').catch(() => {});
    return;
  }

  // ── 3. Réponse texte : un seul chemin, celui d'aiChat ──────────────────
  const member = await resolveMember(message, userName);
  await message.channel?.sendTyping?.().catch(() => {});

  // Contexte : message cité + derniers messages du salon (autres membres).
  const replyTo = cfg.replyChain === false ? null : await resolveReplyContext(message);
  const socialContext = cfg.socialContext === false ? null : await buildSocialContext(message).catch(() => null);

  try {
    const result = await processMessage({
      guild: message.guild,
      member,
      content: content.slice(0, MAX_PROMPT_LENGTH),
      userName,
      config: cfg,
      client,
      replyTo,
      socialContext,
    });

    const directives = result.directives || {};
    const humanDelay = cfg.humanDelay !== false;

    // ── Actions de modération : seulement si le serveur l'a autorisé ──────
    let actionsSummary = null;
    if (cfg.moderationTools && directives.actions?.length) {
      actionsSummary = await aiModeration.applyActions(directives.actions, { guild: message.guild, member }).catch(() => null);
    }

    if (humanDelay) await sleep(delayFor(result.text));

    // Réagir plutôt qu'écrire, quand le modèle l'a demandé.
    if (cfg.reactions !== false) {
      for (const emoji of (directives.reactions || []).slice(0, 3)) {
        await message.react(emoji).catch(() => {});
      }
    }

    if (cfg.stickers !== false && directives.sticker) {
      const sticker = findSticker(message.guild, directives.sticker);
      if (sticker) {
        await message.reply({ stickers: [sticker.id], allowedMentions: { repliedUser: false } }).catch(() => {});
      }
    }

    const segments = (cfg.multiMessage !== false && directives.segments?.length)
      ? directives.segments
      : [result.text];

    if (actionsSummary) segments[0] = `${segments[0]}\n\n${actionsSummary}`;

    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        await message.channel?.sendTyping?.().catch(() => {});
        if (humanDelay) await sleep(delayFor(segments[i]));
      }
      await message.reply({
        embeds: buildAnswerEmbeds(segments[i], { userName: result.userName || userName }),
        allowedMentions: { repliedUser: false },
      }).catch(() => {});
    }

    // ── Réponse vocale : demandée par la personne ou par le modèle ────────
    const wantsVoice = cfg.voiceReplies !== false && (directives.voice || aiVoice.wantsVoiceReply(content));
    if (wantsVoice) {
      const audio = await aiVoice.speak(result.text).catch(() => null);
      if (audio) {
        await message.reply({
          files: [new AttachmentBuilder(audio.buffer, { name: `rezo-vocal-${message.id}.${audio.ext}` })],
          allowedMentions: { repliedUser: false },
        }).catch(() => {});
      }
    }
  } catch (err) {
    await reportFailure(message, err);
  }
}

// ─── Génération d'image demandée dans le salon ───────────────────────────────
async function handleImageRequest(message, { request, userName, mem, cfg }) {
  const prompt = String(request.prompt || '').trim();

  if (prompt.length < 3) {
    await message.reply({
      embeds: [infoEmbed('🖼️ Générer une image', 'Décrivez ce que vous voulez voir, par exemple :\n`génère-moi une image d’un renard roux dans la brume`\n\nVous pouvez aussi écrire `/ia image` pour choisir le format et le style.')],
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
    return;
  }

  // Les règles du serveur s'appliquent aussi aux images.
  if (cfg && message.member) {
    const access = checkAccess(cfg, message.member);
    if (!access.allowed) {
      await message.reply({
        embeds: [errorEmbed('Accès refusé', access.reason === 'blocked' ? 'Tu n’es pas autorisé à utiliser l’IA sur ce serveur.' : 'Tu n’as pas le rôle requis pour utiliser l’IA sur ce serveur.')],
      }).catch(() => {});
      return;
    }
  }

  await message.channel?.sendTyping?.().catch(() => {});

  try {
    const image = await aiImages.generateImage({
      prompt,
      style: request.style || aiImages.DEFAULT_STYLE,
      size: request.size || aiImages.DEFAULT_SIZE,
    });

    const extension = image.mime.includes('png') ? 'png' : 'jpg';
    const fileName = `rezo-${message.author?.id || 'image'}-${Date.now()}.${extension}`;

    await message.reply({
      embeds: [buildImageEmbed({
        prompt,
        userName: mem?.displayName || userName,
        attachmentName: fileName,
        styleLabel: image.style,
        sizeLabel: image.sizeLabel,
        responseMs: image.responseMs,
      })],
      files: [new AttachmentBuilder(image.buffer, { name: fileName })],
      allowedMentions: { repliedUser: false },
    }).catch(() => {});

    await aiMemory.touchMemory(mem, { displayName: userName, kind: 'image', topic: prompt });
  } catch (err) {
    // Le message est déjà rédigé pour la personne (délai d'attente exact, etc.)
    await message.reply({
      embeds: [errorEmbed('Image non générée', err.message || 'Réessayez dans un instant.')],
      allowedMentions: { repliedUser: false },
    }).catch(() => {});
  }
}

/**
 * Erreurs du chemin texte. Les cas répétitifs (quota épuisé, anti-spam) se
 * contentent d'une réaction : répondre à chaque message transformerait un
 * serveur actif en mur d'embeds rouges.
 */
async function reportFailure(message, err) {
  const text = String(err?.message || '');

  if (/verrouill/i.test(text)) {
    await message.react('🔒').catch(() => {});
    return;
  }
  if (/quota|Trop rapide/i.test(text)) {
    await message.react('⏳').catch(() => {});
    return;
  }

  await message.reply({
    embeds: [errorEmbed('Erreur IA', text || 'Une erreur inattendue est survenue. Réessayez plus tard.')],
    allowedMentions: { repliedUser: false },
  }).catch(() => {});
}

// ─── Contexte de conversation ────────────────────────────────────────────────
async function resolveReplyContext(message) {
  if (!message.reference?.messageId) return null;
  const ref = await message.channel?.messages?.fetch?.(message.reference.messageId).catch(() => null);
  if (!ref?.content) return null;
  return {
    author: ref.member?.displayName || ref.author?.globalName || ref.author?.username || 'un membre',
    content: String(ref.content).slice(0, 400),
  };
}

/** Derniers messages d'AUTRES membres : l'IA comprend de quoi le salon parle. */
async function buildSocialContext(message) {
  const batch = await message.channel?.messages?.fetch?.({ limit: 8, before: message.id }).catch(() => null);
  if (!batch) return null;

  const lines = [...batch.values()]
    .reverse()
    .filter((m) => m.author?.id !== message.author?.id && String(m.content || '').trim())
    .map((m) => `${m.member?.displayName || m.author?.globalName || m.author?.username || 'membre'} : ${String(m.content).trim().slice(0, 120)}`)
    .slice(-6);

  if (!lines.length) return null;
  return `Contexte social — derniers messages du salon (d’autres membres, pas forcément adressés à toi) :\n${lines.join('\n')}`;
}

function findSticker(guild, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted || !guild?.stickers?.cache) return null;
  return guild.stickers.cache.find((s) => s.id === wanted || String(s.name || '').toLowerCase() === wanted) || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Délai de frappe : court, borné, jamais bloquant pour le reste du salon. */
function delayFor(text) {
  const base = 500 + Math.min(2000, String(text || '').length * 8);
  return base + Math.floor(Math.random() * 400);
}

function splitForDiscord(text, maxLen = 1900) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

module.exports = {
  handleAiPlaygroundMessage,
  splitForDiscord,
  extractImagePrompt,
  resolveImageRequest,
  displayNameOf,
  resolveReplyContext,
  buildSocialContext,
  wantsVoice: (text) => aiVoice.wantsVoiceReply(text),
  findSticker,
  delayFor,
};
