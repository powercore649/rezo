'use strict';
// utils/countingEmbeds.js — Réactions & embeds du Counting Game

const { EmbedBuilder } = require('discord.js');

const COUNTING_COLOR = 0xFEE75C;

// Pool de styles (emoji + couleur) utilisés aléatoirement pour chaque bon nombre,
// posté par le bot lui-même à la place du message supprimé de l'utilisateur.
const SUCCESS_STYLES = [
  { emoji: '🧡', color: 0xE67E22 },
  { emoji: '💛', color: 0xF1C40F },
  { emoji: '💚', color: 0x2ECC71 },
  { emoji: '💙', color: 0x3498DB },
  { emoji: '💜', color: 0x9B59B6 },
  { emoji: '🤍', color: 0xECF0F1 },
  { emoji: '✨', color: 0xF8C8DC },
  { emoji: '🌟', color: 0xF1C40F },
  { emoji: '💯', color: 0xED4245 },
  { emoji: '✅', color: 0x57F287 },
  { emoji: '🎉', color: 0xEB459E },
  { emoji: '🔥', color: 0xE74C3C },
];

function randomSuccessStyle() {
  return SUCCESS_STYLES[Math.floor(Math.random() * SUCCESS_STYLES.length)];
}

function renderTemplate(template, data = {}) {
  const map = { user: data.user || '', number: data.number ?? '' };
  return String(template).replace(/\{(user|number)\}/g, (_, key) => map[key]);
}

// ─── Embed : posté par le bot à la place du message de l'utilisateur ──────
function buildSuccessEmbed({ userId, number }) {
  const style = randomSuccessStyle();
  return new EmbedBuilder()
    .setColor(style.color)
    .setDescription(`${style.emoji} <@${userId}> : **${number}** !`);
}

// ─── Embed : le compte a été cassé ─────────────────────────────────────────
function buildFailEmbed({ user, given, expected, resetOnFail, highestCount }) {
  return new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('💥 Le compte a été cassé !')
    .setDescription(
      `${user} a écrit \`${given}\` au lieu de **${expected}**.\n\n` +
      (resetOnFail
        ? `Le compteur est **remis à 0**. Meilleur score : **${highestCount}**.`
        : `Le compteur reste à **${expected - 1}**.`),
    )
    .setFooter({ text: 'REZO • Counting Game' })
    .setTimestamp();
}

// ─── Embed : même utilisateur deux fois d'affilée ──────────────────────────
function buildSameUserEmbed({ user, expected, resetOnFail, highestCount }) {
  return new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('🙅 Deux comptes d\'affilée interdits !')
    .setDescription(
      `${user} ne peut pas compter deux fois de suite.\n\n` +
      (resetOnFail
        ? `Le compteur est **remis à 0**. Prochain nombre attendu : **1**.`
        : `Le compteur reste à **${expected - 1}**. Prochain nombre attendu : **${expected}**.`),
    )
    .setFooter({ text: 'REZO • Counting Game' })
    .setTimestamp();
}

// ─── Embed : cadeau trouvé (nombre mystère ou palier) ──────────────────────
function buildRewardEmbed({ user, number, kind, roleId, customMessage }) {
  const title = kind === 'secret' ? '🎁 Nombre mystère trouvé !' : '🏆 Palier atteint !';
  const desc = customMessage
    ? renderTemplate(customMessage, { user: `<@${user}>`, number })
    : (kind === 'secret'
      ? `${user} a trouvé **le bon numéro** (\`${number}\`) et remporte un cadeau ! 🎉`
      : `${user} a fait passer le compteur au palier **${number}** ! 🎉`);

  const embed = new EmbedBuilder()
    .setColor(0xF1C40F)
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: 'REZO • Counting Game' })
    .setTimestamp();

  if (roleId) embed.addFields({ name: 'Récompense', value: `Rôle <@&${roleId}> attribué !`, inline: false });
  return embed;
}

module.exports = {
  COUNTING_COLOR,
  SUCCESS_STYLES,
  randomSuccessStyle,
  renderTemplate,
  buildSuccessEmbed,
  buildFailEmbed,
  buildSameUserEmbed,
  buildRewardEmbed,
};
