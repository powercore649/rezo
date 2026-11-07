'use strict';
// utils/roleMenuView.js — Rendu d'un menu de rôles.
//
// Tout est pur : on reçoit un document RoleMenu (ou un objet équivalent) et on
// renvoie les embeds + composants Discord. La commande ne fait que publier et
// router les clics, ce qui permet de tester les limites dures de Discord
// (25 boutons, 25 options, 80 caractères de libellé, 100 de customId) sans bot.
//
// Les customId sont statiques et ne contiennent que l'identifiant du menu et
// celui du rôle : un panneau publié reste donc cliquable après un redémarrage,
// et l'état des rôles est relu en base à chaque clic.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { COLORS } = require('./embeds');

const MAX_ENTRIES = 25;      // 5 rangées × 5 boutons, ou 25 options de menu
const CID_BUTTON = 'rmn';    // rmn:<menuId>:<roleId>
const CID_SELECT = 'rmnsel'; // rmnsel:<menuId>

/** Libellé affiché pour une entrée (le nom du rôle sert de repli). */
function entryLabel(guild, entry) {
  if (entry.label) return entry.label;
  const role = guild?.roles?.cache?.get(entry.roleId);
  return role ? role.name : 'Rôle supprimé';
}

/** Le rôle est-il utilisable : existant, sous le rôle le plus haut du bot ? */
function roleIssue(guild, roleId) {
  const me = guild?.members?.me;
  const role = guild?.roles?.cache?.get(roleId);
  if (!role) return 'rôle supprimé';
  if (!me) return null;
  if (role.position >= me.roles.highest.position) return 'rôle au-dessus du bot';
  return null;
}

const HEX_COLOR = /^#?([0-9a-f]{6})$/i;
const HEX_SHORT = /^#?([0-9a-f]{3})$/i;

/** Couleur d'embed : `#RRGGBB` accepté, tout le reste retombe sur le défaut. */
function safeColor(value, fallback = COLORS.primary) {
  const raw = String(value || '').trim();
  const long = raw.match(HEX_COLOR);
  if (long) return Number.parseInt(long[1], 16);
  const short = raw.match(HEX_SHORT);
  if (short) {
    const [r, g, b] = short[1].split('');
    return Number.parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  return fallback;
}

/** URL d'image utilisable : http(s) uniquement, sinon null (jamais d'erreur). */
function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** Embed public du panneau (sans les composants). */
function buildEmbed(menu, guild) {
  const embed = new EmbedBuilder()
    .setColor(safeColor(menu.color))
    .setTitle(menu.title || '🎭 Choisis tes rôles')
    .setTimestamp();

  if (menu.description) embed.setDescription(menu.description);
  else if (!menu.entries.length) embed.setDescription('*Ce menu ne contient encore aucun rôle.*');

  if (menu.authorName) {
    embed.setAuthor({
      name: menu.authorName,
      iconURL: safeUrl(menu.authorIconUrl) || undefined,
    });
  }

  const image = safeUrl(menu.imageUrl);
  if (image) embed.setImage(image);

  const thumbnail = safeUrl(menu.thumbnailUrl);
  if (thumbnail) embed.setThumbnail(thumbnail);

  const footParts = [];
  if (menu.footerText) footParts.push(menu.footerText);
  if (menu.exclusive && menu.entries.length > 1) footParts.push('Un seul rôle à la fois');
  if (footParts.length) {
    embed.setFooter({
      text: footParts.join(' · ').slice(0, 2048),
      iconURL: safeUrl(menu.footerIconUrl) || undefined,
    });
  }

  return embed;
}

/**
 * Composants interactifs du panneau.
 * `member` (facultatif) sert uniquement à colorer ce que la personne possède
 * déjà ; sans lui, tous les boutons sont neutres.
 */
function buildComponents(menu, guild, member = null) {
  const entries = (menu.entries || []).slice(0, MAX_ENTRIES);
  if (!entries.length) return [];

  const has = roleId => Boolean(member?.roles?.cache?.has(roleId));

  if (menu.mode === 'select') {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${CID_SELECT}:${menu._id}`)
      .setPlaceholder('Choisis ton rôle…')
      .setMinValues(0)
      .setMaxValues(menu.exclusive ? 1 : Math.max(1, entries.length));

    for (const entry of entries) {
      const option = {
        label: entryLabel(guild, entry).slice(0, 100),
        value: entry.roleId,
        default: has(entry.roleId),
      };
      if (entry.label && guild?.roles?.cache?.get(entry.roleId)) {
        option.description = `@${guild.roles.cache.get(entry.roleId).name}`.slice(0, 100);
      }
      if (entry.emoji) option.emoji = entry.emoji;
      select.addOptions(option);
    }

    return [new ActionRowBuilder().addComponents(select)];
  }

  const rows = [];
  for (let i = 0; i < entries.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const entry of entries.slice(i, i + 5)) {
      const button = new ButtonBuilder()
        .setCustomId(`${CID_BUTTON}:${menu._id}:${entry.roleId}`)
        .setLabel(entryLabel(guild, entry).slice(0, 80))
        .setStyle(has(entry.roleId) ? ButtonStyle.Success : ButtonStyle.Secondary);
      if (entry.emoji) {
        try { button.setEmoji(entry.emoji); } catch { /* émoji invalide : on l'ignore */ }
      }
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows.slice(0, 5);
}

/** Message complet prêt pour `channel.send()` ou `message.edit()`. */
function buildPanel(menu, guild, member = null) {
  return {
    embeds: [buildEmbed(menu, guild)],
    components: buildComponents(menu, guild, member),
  };
}

/** Aperçu privé destiné à la personne qui configure (état des entrées inclus). */
function buildPreview(menu, guild) {
  const lines = (menu.entries || []).map((entry, i) => {
    const issue = roleIssue(guild, entry.roleId);
    const name = guild?.roles?.cache?.get(entry.roleId)
      ? `<@&${entry.roleId}>`
      : `\`${entry.roleId}\``;
    return `**${i + 1}.** ${name}${issue ? ` ⚠️ *${issue}*` : ''}`;
  });

  const embed = buildEmbed(menu, guild)
    .setColor(COLORS.info)
    .setTitle(`🔎 ${menu.title || 'Menu de rôles'} — aperçu`);

  embed.addFields({
    name: 'Configuration',
    value: [
      `• Style : **${menu.mode === 'select' ? 'menu déroulant' : 'boutons'}**`,
      `• Choix : **${menu.exclusive ? 'un seul rôle' : 'plusieurs rôles'}**`,
      `• Rôles : **${(menu.entries || []).length}/${MAX_ENTRIES}**`,
      `• Publié : ${menu.messageId ? `<#${menu.channelId}>` : '*pas encore*'}`,
    ].join('\n'),
  });

  if (lines.length) embed.addFields({ name: 'Rôles du menu', value: lines.join('\n').slice(0, 1024) });

  return embed;
}

/** Décode `rmn:<menuId>:<roleId>` — null si l'identifiant n'est pas le nôtre. */
function parseButtonId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== CID_BUTTON || parts.length !== 3) return null;
  if (!/^[a-f0-9]{24}$/i.test(parts[1])) return null;
  if (!/^\d{5,32}$/.test(parts[2])) return null;
  return { menuId: parts[1], roleId: parts[2] };
}

/** Décode `rmnsel:<menuId>` — null sinon. */
function parseSelectId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== CID_SELECT || parts.length !== 2) return null;
  if (!/^[a-f0-9]{24}$/i.test(parts[1])) return null;
  return { menuId: parts[1] };
}

module.exports = {
  MAX_ENTRIES,
  CID_BUTTON,
  CID_SELECT,
  safeColor,
  safeUrl,
  entryLabel,
  roleIssue,
  buildEmbed,
  buildComponents,
  buildPanel,
  buildPreview,
  parseButtonId,
  parseSelectId,
};
