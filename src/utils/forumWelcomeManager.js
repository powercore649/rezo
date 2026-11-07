const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { COLORS } = require('../utils/embeds');

// ─── Remplace les placeholders {username} {titre} {forum} {tags} ─────────────
function resolvePlaceholders(template, { thread, ownerMention, tags }) {
  return (template || '')
    .replaceAll('{username}', ownerMention || 'membre')
    .replaceAll('{titre}', thread.name || 'ce post')
    .replaceAll('{forum}', thread.parent?.name || 'ce forum')
    .replaceAll('{tags}', tags && tags.length ? tags.join(', ') : 'Aucun tag');
}

// ─── Construit l'embed d'accueil à partir de la config et du thread ─────────
function buildWelcomeEmbed(cfg, thread, ownerMention) {
  const appliedTags = (thread.appliedTags || [])
    .map(tagId => thread.parent?.availableTags?.find(t => t.id === tagId)?.name)
    .filter(Boolean);

  const ctx = { thread, ownerMention, tags: appliedTags };

  return new EmbedBuilder()
    .setColor(cfg.color || COLORS.primary)
    .setTitle(resolvePlaceholders(cfg.title, ctx).slice(0, 256))
    .setDescription(resolvePlaceholders(cfg.message, ctx).slice(0, 4000))
    .setFooter({ text: 'Message automatique • REZO' })
    .setTimestamp();
}

function buildWelcomeRow(cfg) {
  if (!cfg.buttonLabel || !cfg.buttonUrl) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(cfg.buttonLabel).setStyle(ButtonStyle.Link).setURL(cfg.buttonUrl),
    ),
  ];
}

// ─── Poste (et épingle si demandé) le message d'accueil dans un post forum ───
async function postForumWelcome(thread, cfg) {
  try {
    const owner = await thread.guild.members.fetch(thread.ownerId).catch(() => null);
    const ownerMention = owner ? `<@${owner.id}>` : 'membre';

    const embed = buildWelcomeEmbed(cfg, thread, ownerMention);
    const components = buildWelcomeRow(cfg);

    const msg = await thread.send({ embeds: [embed], components }).catch(() => null);
    if (!msg) return null;

    if (cfg.pinMessage) {
      await msg.pin().catch(() => {});
    }
    return msg;
  } catch (err) {
    console.error('postForumWelcome:', err.message);
    return null;
  }
}

module.exports = { resolvePlaceholders, buildWelcomeEmbed, buildWelcomeRow, postForumWelcome };
