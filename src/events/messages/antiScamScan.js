'use strict';
// events/messages/antiScamScan.js — Détection anti-scam des messages texte.
//
// Le scan s'applique à tout le contenu d'un message (textuel, liens, mentions).
// Quand le score de menace dépasse le seuil, le message est supprimé et une
// alerte est publiée dans le salon de log de la config. Gère aussi les
// domaines épinglés dans la config (knownDomains) et les mots-clés.

const { EmbedBuilder, PermissionFlagsBits, ColorResolvable } = require('discord.js');
const AntiScamConfig = require('../../models/AntiScamConfig');
const Warn = require('../../models/Warn');
const { scanMessage, RULES, buildReasons } = require('../../utils/antiScam');
const { COLORS } = require('../../utils/embeds');

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

function suspicionColor(score) {
  if (score >= 80) return 0xed4245; // rouge
  if (score >= 50) return 0xfee75c; // jaune
  return 0x57f287; // vert
}

async function applySanction(message, config, author, reasons, score) {
  const guild = message.guild;
  let label = 'Aucune';

  try {
    if (config.action === 'warn') {
      await Warn.create({
        userId: author.id,
        guildId: guild.id,
        warnedBy: message.client.user.id,
        reason: `[Anti-Arnaque] Image suspecte détectée (${score}%)`,
      });
      label = 'Avertissement';
    } else if (config.action === 'mute') {
      const member = await guild.members.fetch(author.id).catch(() => null);
      if (member?.moderatable) {
        await member.timeout(config.muteDuration * 60 * 1000, 'Anti-Arnaque : contenu suspect détecté');
        label = `Mute (${config.muteDuration} min)`;
      }
    } else if (config.action === 'kick') {
      const member = await guild.members.fetch(author.id).catch(() => null);
      if (member?.kickable) {
        await member.kick('Anti-Arnaque : contenu suspect détecté');
        label = 'Kick';
      }
    } else if (config.action === 'ban') {
      const member = await guild.members.fetch(author.id).catch(() => null);
      if (member?.bannable ?? guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
        await guild.members.ban(author.id, { reason: 'Anti-Arnaque : contenu suspect détecté' });
        label = 'Membre Banni (Ban)';
      }
    }
  } catch (err) {
    console.error('❌ Anti-Arnaque — échec de la sanction:', err.message);
    label = `${label} (échec — permissions insuffisantes ?)`;
  }

  if (config.deleteMessage) {
    await message.delete().catch(() => {});
    label += label !== 'Aucune' ? ' + Message Supprimé' : 'Message Supprimé';
  }

  return label;
}

async function sendAlert(message, config, author, reasons, score, actionLabel = 'Aucune') {
  if (!config.logChannelId) return;
  const channel = message.guild.channels.cache.get(config.logChannelId);
  if (!channel) return;

  const fields = reasons.slice(0, 6).map(r => ({ name: r.severity === 'error' ? '🚫' : '⚠️', value: r.message, inline: true }));
  const e = new EmbedBuilder()
    .setColor(suspicionColor(score))
    .setTitle(config.action === 'none' ? '🛡️ Alerte : contenu suspect détecté' : `🛡️ Alerte : Contenu Suspect Détecté (${score}%)`)
    .setDescription(`Un contenu a été intercepté et analysé par le module de sécurité anti-arnaque de **${message.client.user.username}**.`)
    .addFields(
      { name: '👤 Détails de l\'Auteur', value: `**Nom :** ${author.username}\n**ID :** ${author.id} (<@${author.id}>)\n**Salon :** <#${message.channel.id}>`, inline: true },
      { name: '🛰️ Analyse', value: `${reasons.map(r => `• ${r.message}`).join('\n')}\n**Indice :** \`${score}%\`` },
      { name: '⚙️ Action', value: `**Appliquée :** \`${actionLabel || 'Aucune'}\`` },
    )
    .setTimestamp();

  await channel.send({ embeds: [e] }).catch(() => {});
}

module.exports = {
  name: 'messageCreate',
  async execute(message) {
    if (!message.guild || message.author.bot) return;

    const config = await AntiScamConfig.findOne({ guildId: message.guild.id });
    if (!config || !config.enabled) return;

    // Exemptions : rôles et salons (ainsi que la vérification d'administrateur)
    if (message.member?.roles.cache.some((r) => config.exemptRoles.includes(r.id))) return;
    if (config.exemptChannels.includes(message.channel.id)) return;
    if (message.member?.permissions?.has(PermissionFlagsBits.Administrator)) return;

    const reasons = [];
    const factors = [];

    // ── 1. Contenu texte du message ────────────────────────────────────────
    const content = message.content || '';
    const scan = scanMessage(content, config);
    let score = scan.score;
    const msgFactors = scan.factors;
    reasons.push(...scan.reasons);
    factors.push(...msgFactors);

    // ── 2. Mots-clés personnalisés ────────────────────────────────────────
    for (const kw of config.customKeywords || []) {
      if (content.toLowerCase().includes(kw.toLowerCase())) {
        factors.push({ categoryId: 'custom', label: `Mot-clé perso : "${kw}"`, matched: true });
        // Un mot-clé choisi par le staff est une raison à lui seul : sans ça,
        // le score montait mais l'alerte ne partait jamais (aucune règle interne
        // déclenchée), donc le mot-clé ne servait à rien.
        reasons.push({ severity: 'warning', message: `Mot-clé surveillé : « ${kw} »` });
        score = Math.min(100, score + 10);
      }
    }

    // ── 3. Environment Google + Reddit (affichage de contenu) ─────────────
    if (message.content.includes('google.com') && /[?&]q=/.test(message.content)) reasons.push({ severity: 'warning', message: 'Recherche Google détectée' });
    if (message.content.includes('reddit.com')) reasons.push({ severity: 'warning', message: 'Tendance Reddit détectée' });

    // ── 4. Points d\'arrêt sur le nombre de liens ─────────────────────────
    const urlCount = (content.match(/(?:https?|ftp):\/\/[^\s<>"]+/g) || []).length;
    if (urlCount > 2) reasons.push({ severity: 'error', message: 'Trop de liens dans le message (peut-être un spam)' });

    if (score >= config.threshold && reasons.length > 0) {
      const actionLabel = config.action === 'none'
        ? 'Aucune (alerte uniquement)'
        : await applySanction(message, config, message.author, reasons, score);

      // Statistiques
      config.totalScanned += 1;
      if (score >= config.threshold) config.totalDetected += 1;
      await config.save().catch(() => {});

      await sendAlert(message, config, message.author, reasons, score, actionLabel).catch(err =>
        console.error('❌ Anti-Arnaque — alerte non envoyée:', err.message));
    }
  },
};
