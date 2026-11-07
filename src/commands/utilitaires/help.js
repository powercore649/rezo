'use strict';
// commands/utilitaires/help.js — 📚 Centre d'aide REZO (v4).
//
// Refonte complète : le panel ne contient plus aucune liste de commandes écrite
// à la main. Tout vient de `utils/helpCatalog`, qui lit `client.commands` (le bot
// réellement chargé). Une commande ajoutée apparaît, une commande supprimée
// disparaît, et le total affiché ne peut pas mentir.
//
// Parcours :
//   Accueil → menu Catégories (9) → page de 10 commandes (pagination) → fiche
//   détaillée (usage, sous-commandes, permissions, licence) → retour.
//   Menu Guides (10) · Recherche plein texte · /help commande:nom (autocomplétion)
//   · Mes accès (commandes réellement lançables par le membre).
//
// Sécurité : chaque interaction vérifie qu'elle appartient à l'auteur du panel
// (ou à un membre avec Gérer le serveur). Les vues sont pures et testables.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const brand = require('../../utils/brand');
const catalogLib = require('../../utils/helpCatalog');
const diagnostics = require('../../utils/helpDiagnostics');
const { siteUrl } = require('../../utils/siteUrl');

// Une seule adresse pour tout le bot : SITE_URL dans le .env.
const SITE_URL    = siteUrl();
const SUPPORT_URL = 'https://discord.gg/ts5mh326ew';
// Bannière livrée dans assets/banners/help-banner.jpg (scripts/gen-help-banner.js).
// Surchargeable sans redéploiement via la variable d'environnement HELP_BANNER_URL.
const HELP_BANNER = process.env.HELP_BANNER_URL || `${SITE_URL}/banners/help-banner.jpg`;
const LOCK = '🔒';
const C = brand.BRAND.colors;

const PAGE_SIZE = 10;
const COMMAND_SELECT_LIMIT = 25;
const DIAG_ID = 'help_diag';

// Astuces affichées dans l'accueil (une au hasard, sans bouton à cliquer).
const TIPS = [
  'Le **score d’efficacité** de `/autopilote` transforme votre configuration en checklist : chaque point manquant indique la commande exacte à lancer.',
  'Un serveur qui **bump** toutes les 2 heures gagne durablement en visibilité — `/bump-notif` met en place les rappels.',
  'Le **honeypot** attrape les bots sans gêner un humain : un salon invisible où le premier clic est une faute.',
  'Le **grade S** est atteint à 90 % d’efficacité. La plupart des serveurs y arrivent en activant 5 à 6 systèmes.',
  'Vous pouvez **tout configurer sans taper de commande** : `/setting` ouvre chaque module directement dans le message.',
  'Le système de tickets tient dans **une seule commande**, `/ticket` : panel, catégories, support, stats et blacklist.',
  'Le **coffre-fort de permissions** de `/securite` referme les ouvertures silencieuses qu’un anti-nuke ne voit jamais.',
  'Les **sanctions automatiques** (`/mod paliers`) évitent les décisions à chaud : les paliers s’appliquent tout seuls.',
  '`/help commande:nom` ouvre la fiche exacte d’une commande, avec son usage et les permissions qu’elle demande.',
];

// Cache par collection de commandes : reconstruire le catalogue coûte ~1 ms,
// inutile de le refaire à chaque clic du panel.
let cache = null;
function catalogFor(client) {
  const commands = client?.commands;
  if (cache && cache.commands === commands && cache.size === commands?.size) return cache.catalog;
  const catalog = catalogLib.buildCatalog(client);
  cache = { commands, size: commands?.size, catalog };
  return catalog;
}
function resetCache() { cache = null; }

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const { normalize, formatUptime, canUse } = catalogLib;

function truncate(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

async function ensureCommands(client) {
  const manager = client?.application?.commands;
  if (!manager || typeof manager.fetch !== 'function') return;
  try { await manager.fetch(); } catch { /* IDs indisponibles : repli en code */ }
}

// Mention cliquable si la commande est connue du portail, sinon code simple.
function commandLabel(client, name) {
  const clean = String(name).replace(/^\//, '');
  if (clean.includes(' ')) return `\`/${clean}\``;
  const cmd = client?.application?.commands?.cache?.find?.(c => c.name === clean);
  return cmd ? `</${clean}:${cmd.id}>` : `\`/${clean}\``;
}

function ownershipId(interaction) {
  return interaction?.message?.interactionMetadata?.user?.id
    || interaction?.message?.interaction?.user?.id
    || null;
}

function ownsMenu(interaction) {
  const ownerId = ownershipId(interaction);
  if (!ownerId) return true;              // menu sans auteur connu : on ne bloque pas
  if (ownerId === interaction?.user?.id) return true;
  return !!interaction?.member?.permissions?.has?.('ManageGuild');
}

function refuse(interaction) {
  return interaction.reply({
    content: '❌ Ce menu ne t\'appartient pas ! Seul son auteur (ou un membre avec **Gérer le serveur**) peut l\'utiliser.',
    ephemeral: true,
  });
}

function groupOf(catalog, categoryId) {
  return catalog.categories.find(c => c.id === categoryId) || null;
}

function pageCount(category) {
  return Math.max(1, Math.ceil(category.commands.length / PAGE_SIZE));
}

function clampPage(category, page) {
  const count = pageCount(category);
  const value = Number(page);
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, Math.trunc(value)), count);
}

function pageEntries(category, page) {
  const current = clampPage(category, page);
  return category.commands.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
}

function licenseNote(entry) {
  return entry.license ? ` ${LOCK}` : '';
}

function formatCooldown(ms) {
  const seconds = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function permissionSummary(entry) {
  if (entry.permissionBits === null) return 'Tout le monde';
  return entry.permissions.join(', ');
}

/**
 * Astuce affichée (une au hasard). `forced` n'est utilisé que par les tests,
 * pour que la vérification « aucune astuce ne cite une commande inexistante »
 * couvre les 9 astuces au lieu d'une seule tirée au sort.
 */
function randomTip(forced = null) {
  if (typeof forced === 'string' && TIPS.includes(forced)) return forced;
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}

// ═══════════════════════════════════════════════════════════════════════════════
// VUES — ACCUEIL
// ═══════════════════════════════════════════════════════════════════════════════
async function buildHomeEmbed(catalog, ctx = {}) {
  const client = ctx.client || null;
  const member = ctx.member || null;
  await ensureCommands(client);

  const serverCount = client?.guilds?.cache?.size ?? 0;
  const uptime = formatUptime(client?.uptime);
  const ping = Number.isFinite(client?.ws?.ping) && client.ws.ping >= 0 ? `${Math.round(client.ws.ping)} ms` : '—';
  const accessible = member ? catalogLib.accessibleCount(catalog, member) : null;
  const m = name => commandLabel(client, name);

  const author = { name: `${brand.BRAND.name} • Centre d'aide` };
  const avatar = client?.user?.displayAvatarURL?.();
  if (avatar) author.iconURL = avatar;

  const stats = [
    `📚 **${catalog.total} commandes** · 📂 **${catalog.categories.length} catégories** · 📖 **${catalog.guides.length} guides**`,
    `💎 **${serverCount} serveurs** équipés · ⏱️ En ligne depuis **${uptime}** · 📡 **${ping}**`,
  ];
  if (accessible !== null) {
    stats.push(`🔓 **${accessible}/${catalog.total}** commandes sont à votre portée sur ce serveur — voir **Mes accès**.`);
  }

  return new EmbedBuilder()
    .setColor(C.primary)
    .setAuthor(author)
    .setTitle('🎯 Comment puis-je vous aider ?')
    .setDescription([
      `Bienvenue dans le centre d'aide de **${brand.BRAND.name}**, ${brand.BRAND.tagline.toLowerCase()}.`,
      '',
      ...stats,
      '',
      `> ${LOCK} Les commandes marquées **${LOCK}** nécessitent une licence valide — voir ${m('license')}.`,
      '> Astuce : `/help commande:nom` ouvre directement une fiche.',
    ].join('\n'))
    .addFields(
      {
        name: '🚀 Démarrage express', inline: true,
        value: [
          `1️⃣ ${m('setting')} — hub central`,
          `2️⃣ ${m('autopilote')} — config auto`,
          `3️⃣ ${m('captcha')} — filtrer les arrivées`,
          `4️⃣ ${m('bump')} — visibilité`,
        ].join('\n'),
      },
      {
        name: '🛡️ Sécurité express', inline: true,
        value: [
          `• ${m('captcha')} — vérification humaine`,
          `• ${m('antiraid')} — anti-raid`,
          `• ${m('anti-nuke')} — anti-nuke Sentinel`,
          `• ${m('controle-arrivee')} — Vigie`,
          `• ${m('securite')} — spam + coffre-fort`,
          `• ${m('honeypot')} — piège à bots`,
        ].join('\n'),
      },
      {
        name: '🧭 Navigation', inline: true,
        value: [
          '• **Catégories** — ci-dessous',
          '• **Guides** — parcours pas-à-pas',
          '• **Rechercher** — nom ou mot-clé',
          '• **Mes accès** — ce que vous pouvez lancer',
          '• **`/help commande:nom`** — fiche directe',
        ].join('\n'),
      },
      { name: '💡 Le savais-tu ?', value: randomTip(ctx.tip) },
    )
    .setImage(HELP_BANNER)
    .setFooter({ text: brand.footer(`${catalog.total} commandes · ${LOCK} = licence requise`) })
    .setTimestamp();
}

// Trois rangées : deux menus, cinq boutons d'action, puis les liens externes.
// (Discord plafonne à 5 composants par rangée — un sixième bouton oblige à
// ouvrir une rangée, il ne faut donc pas les empiler au hasard.)
function homeComponents(catalog) {
  return [
    categorySelect(catalog),
    docsSelect(catalog),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('help_search').setLabel('Rechercher').setEmoji('🔎').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('help_access').setLabel('Mes accès').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(DIAG_ID).setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('help_whatsnew').setLabel('Nouveautés').setEmoji('🆕').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('help_license').setLabel('Licence').setEmoji(LOCK).setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Support').setEmoji('💬').setStyle(ButtonStyle.Link).setURL(SUPPORT_URL),
      new ButtonBuilder().setLabel('Site').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(SITE_URL),
    ),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// VUES — CATÉGORIE
// ═══════════════════════════════════════════════════════════════════════════════
function buildCategoryEmbed(catalog, categoryId, page, ctx = {}) {
  const category = groupOf(catalog, categoryId);
  if (!category) return null;
  const current = clampPage(category, page);
  const entries = pageEntries(category, current);
  const client = ctx.client || null;

  const lines = entries.map((entry, index) => {
    const position = (current - 1) * PAGE_SIZE + index + 1;
    return `**${position}.** ${commandLabel(client, entry.name)}${licenseNote(entry)}\n└ ${truncate(entry.description || 'Aucune description.', 110)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(category.color)
    .setAuthor({ name: `${brand.BRAND.name} ${brand.BRAND.emoji.spark}` })
    .setTitle(`${category.emoji} ${category.label}`)
    .setDescription(`${category.tagline}\n\n${brand.divider(12)}\n\n${lines.join('\n\n')}`.slice(0, 4000))
    .setFooter({
      text: `Page ${current}/${pageCount(category)} · ${category.commands.length} commande(s) · ${LOCK} = licence requise`,
    })
    .setTimestamp();

  if (!entries.length) embed.setDescription(`${category.tagline}\n\n*Aucune commande dans cette catégorie.*`);
  return embed;
}

function categorySelect(catalog, activeId = null) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('help_category')
      .setPlaceholder('📂 Parcourir une catégorie…')
      .addOptions(catalog.categories.map(category => ({
        label: category.label,
        value: category.id,
        emoji: category.emoji,
        description: truncate(`${category.commands.length} commande(s) — ${category.tagline}`, 90),
        default: category.id === activeId,
      }))),
  );
}

function docsSelect(catalog, activeId = null) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('help_docs')
      .setPlaceholder('📖 Lire un guide pas-à-pas…')
      .addOptions(catalog.guides.slice(0, 25).map(guide => ({
        label: guide.label,
        value: guide.id,
        emoji: guide.emoji,
        description: truncate(guide.tagline, 90),
        default: guide.id === activeId,
      }))),
  );
}

function categoryComponents(catalog, categoryId, page = 1) {
  const category = groupOf(catalog, categoryId);
  const rows = [categorySelect(catalog, categoryId)];
  if (category) {
    const current = clampPage(category, page);
    const entries = pageEntries(category, current);
    if (entries.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('help_cmd')
          .setPlaceholder('🔎 Ouvrir la fiche d\'une commande…')
          .addOptions(entries.slice(0, COMMAND_SELECT_LIMIT).map(entry => ({
            label: truncate(`/${entry.name}`, 100),
            value: entry.name,
            description: truncate(entry.description || 'Aucune description.', 90),
          }))),
      ));
    }
    const total = pageCount(category);
    if (total > 1) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`help_page_prev:${category.id}:${current}`)
          .setLabel('Précédent').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
          .setDisabled(current <= 1),
        new ButtonBuilder()
          .setCustomId(`help_page_info:${category.id}:${current}`)
          .setLabel(`Page ${current}/${total}`).setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`help_page_next:${category.id}:${current}`)
          .setLabel('Suivant').setEmoji('▶️').setStyle(ButtonStyle.Secondary)
          .setDisabled(current >= total),
      ));
    }
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_search').setLabel('Rechercher').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(DIAG_ID).setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help_license').setLabel('Licence').setEmoji(LOCK).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('Site').setEmoji('🌐').setStyle(ButtonStyle.Link).setURL(SITE_URL),
  ));
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VUES — FICHE COMMANDE
// ═══════════════════════════════════════════════════════════════════════════════
function buildCommandEmbed(catalog, name, ctx = {}) {
  const entry = catalog.byName.get(normalize(name));
  if (!entry) return null;
  const client = ctx.client || null;
  const category = groupOf(catalog, entry.category);
  const color = category?.color ?? C.primary;

  const fields = [
    { name: '📂 Catégorie', value: category ? `${category.emoji} ${category.label}` : entry.category, inline: true },
    { name: '🔑 Accès requis', value: truncate(permissionSummary(entry), 1024), inline: true },
    { name: '🔒 Licence', value: entry.license ? 'Requise' : 'Non requise', inline: true },
  ];

  // Détails utiles : à quelle fréquence on peut relancer la commande, si elle
  // n'existe qu'en serveur, et quelles options elle attend.
  if (entry.cooldownMs) {
    fields.push({ name: '⏱️ Anti-spam', value: formatCooldown(entry.cooldownMs), inline: true });
  }
  if (entry.guildOnly) {
    fields.push({ name: '🏠 Portée', value: 'Serveur uniquement', inline: true });
  }
  if (entry.optionNames?.length) {
    fields.push({
      name: `🎛️ Options (${entry.optionNames.length})`,
      value: truncate(entry.optionNames.map(name => `\`${name}\``).join(' · '), 1024),
    });
  }

  if (entry.subcommands.length) {
    const lines = entry.subcommands
      .map(sub => `**/${entry.name} ${sub.name}** — ${sub.description || 'sans description'}`)
      .join('\n');
    fields.push({ name: `🧩 Sous-commandes (${entry.subcommands.length})`, value: truncate(lines, 1024) });
  }

  fields.push({
    name: '🧭 Où la trouver',
    value: category
      ? `Menu **Catégories** → ${category.emoji} ${category.label} (${category.commands.length} commandes)`
      : 'Menu **Catégories**',
  });

  // Commandes liées : c'est ce qui fait passer d'une fiche isolée à un parcours.
  const related = catalogLib.relatedEntries(catalog, entry.name, 5);
  if (related.length) {
    fields.push({
      name: `🔗 Voir aussi (${related.length})`,
      value: truncate(related
        .map(other => `• ${commandLabel(client, other.name)} — ${truncate(other.description || 'sans description', 70)}`)
        .join('\n'), 1024),
    });
  }

  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: `${brand.BRAND.name} • Fiche commande` })
    .setTitle(truncate(`/${entry.name}${entry.license ? ` ${LOCK}` : ''}`, 256))
    .setDescription([
      entry.description || 'Aucune description fournie par la commande.',
      '',
      brand.divider(12),
      '',
      '**Utilisation**',
      '```',
      truncate(entry.usage, 900),
      '```',
    ].join('\n').slice(0, 4000))
    .addFields(fields)
    .setFooter({ text: brand.footer(category ? `${category.label} · ${LOCK} = licence requise` : `${LOCK} = licence requise`) })
    .setTimestamp();
}

function commandComponents(catalog, name) {
  const entry = catalog.byName.get(normalize(name));
  const categoryId = entry?.category;
  const buttons = [];
  if (categoryId && groupOf(catalog, categoryId)) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`help_back:${categoryId}`)
      .setLabel('Catégorie').setEmoji('↩️').setStyle(ButtonStyle.Secondary));
  }
  buttons.push(
    new ButtonBuilder().setCustomId('help_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_search').setLabel('Rechercher').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(DIAG_ID).setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('Support').setEmoji('💬').setStyle(ButtonStyle.Link).setURL(SUPPORT_URL),
  );
  return [new ActionRowBuilder().addComponents(...buttons)];
}

// ═══════════════════════════════════════════════════════════════════════════════
// VUES — GUIDE
// ═══════════════════════════════════════════════════════════════════════════════
function commandsCitedInGuide(guide, catalog) {
  // Une citation de commande s'écrit toujours entre backticks (ou en mention) :
  // on évite ainsi de confondre « ajouter/retirer » avec un /retirer.
  const names = [...String(guide.body).matchAll(/(?:`|<)\/([a-z][a-z0-9-]{1,31})/g)]
    .map(match => match[1])
    .filter(name => catalog.byName.has(name));
  return [...new Set(names)].slice(0, 12);
}

function buildGuideEmbed(catalog, guide, ctx = {}) {
  const client = ctx.client || null;
  const cited = commandsCitedInGuide(guide, catalog);
  const embed = new EmbedBuilder()
    .setColor(guide.color)
    .setAuthor({ name: `${brand.BRAND.name} • Guide` })
    .setTitle(truncate(`${guide.emoji} ${guide.title}`, 256))
    .setDescription(`${guide.tagline}\n\n${brand.divider(12)}\n\n${guide.body}`.slice(0, 4000))
    .setFooter({ text: brand.footer('Guides') })
    .setTimestamp();
  if (cited.length) {
    embed.addFields({
      name: `⌨️ Commandes de ce guide (${cited.length})`,
      value: truncate(cited.map(name => `• ${commandLabel(client, name)}`).join('\n'), 1024),
    });
  }
  return embed;
}

function guideComponents(catalog, activeId = null) {
  return [
    docsSelect(catalog, activeId),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('help_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('help_search').setLabel('Rechercher').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('help_access').setLabel('Mes accès').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(DIAG_ID).setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setLabel('Support').setEmoji('💬').setStyle(ButtonStyle.Link).setURL(SUPPORT_URL),
    ),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// VUES — RECHERCHE
// ═══════════════════════════════════════════════════════════════════════════════
function buildSearchResultsEmbed(query, results, ctx = {}) {
  const client = ctx.client || null;
  const commands = results?.commands || [];
  const guides = results?.guides || [];
  // Suggestions de proximité (faute de frappe) : « captchaa » → « captcha ».
  const suggestions = results?.didYouMean || [];
  if (!commands.length && !guides.length) {
    return new EmbedBuilder()
      .setColor(C.warning)
      .setAuthor({ name: `${brand.BRAND.name} • Recherche` })
      .setTitle('🔎 Aucun résultat')
      .setDescription([
        `Rien ne correspond à **« ${truncate(query, 60)} »**.`,
        '',
        'Essayez un nom de commande (`bump`, `captcha`), un système (`tickets`)',
        'ou un mot-clé (`sécurité`, `modération`).',
        '',
        suggestions?.length
        ? `💡 Vouliez-vous dire : ${suggestions.map(name => `**${name}**`).join(', ')} ?`
        : '💡 `/help commande:nom` propose une autocomplétion sur toutes les commandes.',
      ].join('\n'))
      .setFooter({ text: brand.footer('Recherche') });
  }

  const embed = new EmbedBuilder()
    .setColor(C.info)
    .setAuthor({ name: `${brand.BRAND.name} ${brand.BRAND.emoji.spark}` })
    .setTitle(truncate(`🔎 Résultats — « ${query} »`, 256))
    .setDescription([
      `**${commands.length}** commande(s) et **${guides.length}** guide(s) trouvés.`,
      'Choisissez dans le menu ci-dessous pour ouvrir une fiche.',
    ].join('\n'));

  if (commands.length) {
    embed.addFields({
      name: `⌨️ Commandes (${commands.length})`,
      value: truncate(commands.slice(0, 10).map(entry =>
        `• ${commandLabel(client, entry.name)}${licenseNote(entry)}\n└ ${truncate(entry.description, 100)}`).join('\n'), 1024),
    });
  }
  if (guides.length) {
    embed.addFields({
      name: `📖 Guides (${guides.length})`,
      value: truncate(guides.slice(0, 5).map(guide => `• **${guide.label}** — ${guide.tagline}`).join('\n'), 1024),
    });
  }
  embed.setFooter({ text: brand.footer('Recherche') });
  return embed;
}

function searchComponents(results) {
  const rows = [];
  const options = [];
  // Aucun résultat : les suggestions deviennent cliquables — c'est ce qui
  // rattrape une faute de frappe sans obliger à retaper la requête.
  if (!(results?.commands || []).length && (results?.didYouMean || []).length) {
    for (const name of results.didYouMean.slice(0, 5)) {
      options.push({
        label: truncate(`/${name}`, 100),
        value: `cmd:${name}`,
        description: 'Suggestion la plus proche',
      });
    }
  }
  for (const entry of (results?.commands || []).slice(0, 20)) {
    options.push({
      label: truncate(`/${entry.name}`, 100),
      value: `cmd:${entry.name}`,
      description: truncate(entry.description || 'Aucune description.', 90),
    });
  }
  for (const guide of (results?.guides || []).slice(0, 5)) {
    options.push({
      label: truncate(`Guide — ${guide.label}`, 100),
      value: `doc:${guide.id}`,
      emoji: guide.emoji,
      description: truncate(guide.tagline, 90),
    });
  }
  if (options.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('help_result')
        .setPlaceholder('📄 Ouvrir un résultat…')
        .addOptions(options.slice(0, COMMAND_SELECT_LIMIT)),
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('help_search').setLabel('Nouvelle recherche').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(DIAG_ID).setLabel('Diagnostic').setEmoji('🩺').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setLabel('Support').setEmoji('💬').setStyle(ButtonStyle.Link).setURL(SUPPORT_URL),
  ));
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VUES — MES ACCÈS
// ═══════════════════════════════════════════════════════════════════════════════
function buildAccessEmbed(catalog, member, ctx = {}) {
  const client = ctx.client || null;
  const embed = new EmbedBuilder()
    .setColor(C.accent)
    .setAuthor({ name: `${brand.BRAND.name} • Vos accès` })
    .setTitle('🔓 Ce que vous pouvez lancer ici');

  if (!member?.permissions?.has) {
    embed.setDescription([
      'Cette vue se calcule sur un serveur : en message privé, les permissions ne s\'appliquent pas.',
      '',
      `Sur un serveur, ouvrez **Mes accès** pour voir les commandes réellement disponibles pour vous.`,
    ].join('\n'));
    return embed.setFooter({ text: brand.footer('Accès') }).setTimestamp();
  }

  const usable = catalog.entries.filter(entry => canUse(entry, member));
  const locked = catalog.entries.filter(entry => !canUse(entry, member));
  const isAdmin = !!member.permissions.has('Administrator');

  embed.setDescription([
    `Vous pouvez lancer **${usable.length}/${catalog.total}** commandes sur ce serveur${isAdmin ? ' (administrateur : tout est ouvert)' : ''}.`,
    '',
    '**Répartition par catégorie**',
    ...catalog.categories.map(category => {
      const ok = category.commands.filter(entry => canUse(entry, member)).length;
      return `${category.emoji} **${category.label}** — ${ok}/${category.commands.length}`;
    }),
  ].join('\n').slice(0, 4000));

  if (locked.length) {
    embed.addFields({
      name: `🔑 Commandes hors de portée (${locked.length})`,
      value: truncate(locked.slice(0, 12).map(entry =>
        `• ${commandLabel(client, entry.name)} — ${truncate(permissionSummary(entry), 60)}`).join('\n'), 1024),
    });
    if (locked.length > 12) {
      embed.addFields({ name: '…', value: `${locked.length - 12} autre(s) commande(s) demandent aussi des permissions.` });
    }
  }

  return embed
    .setFooter({ text: brand.footer('Accès calculés sur vos permissions réelles') })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════════════════════
// VUES — NOUVEAUTÉS & LICENCE
// ═══════════════════════════════════════════════════════════════════════════════
function buildWhatsNewEmbed(catalog = null) {
  // Les compteurs viennent du catalogue réel : ils ne peuvent pas se périmer.
  const inventory = catalog?.total
    ? `**${catalog.total} commandes**, **${catalog.categories.length} catégories**, **${catalog.guides.length} guides**`
    : 'tout le bot chargé';

  return new EmbedBuilder()
    .setColor(C.accent)
    .setAuthor({ name: `${brand.BRAND.name} • Nouveautés` })
    .setTitle('🆕 Nouveautés REZO')
    .setDescription('Ce qui a changé récemment, en clair.')
    .addFields(
      {
        name: '🔨 `/sanctions` — les sanctions **officielles** de Discord',
        value: [
          'La liste des bannissements tenue par Discord, **paginée**, filtrable par pseudo,',
          'identifiant ou motif, **exportable** en un clic et corrélée au journal d’audit',
          '(qui a sanctionné, quand, et pourquoi).',
          '👤 `/sanctions membre:@x` : bannissement, exclusion temporaire en cours, avertissements',
          'et historique officiel — avec un bouton pour **débannir** sans quitter la fiche.',
        ].join('\n'),
      },
      {
        name: '🎨 Chaque serveur a sa propre identité, partout',
        value: [
          'Le nom, la **couleur** et le nouvel **emoji signature** d’un serveur ne s’arrêtent plus aux embeds :',
          'ils signent aussi les **cartes de rang, de niveau, de profil, de bienvenue, de radio et de trésor**,',
          'ainsi que les titres et pieds de page des modules. Réglage dans `/branding` ou `/setting` → 🎨.',
        ].join('\n'),
      },
      {
        name: '⚙️ `/setting` — un seul panel pour tout le bot',
        value: [
          'Neuf domaines, **un champ par module** disant exactement comment l’ouvrir, et les',
          'valeurs actuelles déjà remplies : tu ne retapes que ce qui change.',
          '🎛️ Nouvelle **console** : toutes les commandes du bot, page par page, avec leur état réel —',
          'et un menu pour **les lancer pour de vrai**, permissions et licence comprises.',
        ].join('\n'),
      },
      {
        name: '📚 `/help` — centre d\'aide entièrement reconstruit',
        value: [
          `Le panel lit désormais le **bot réel** : ${inventory}.`,
          'Pagination, fiche détaillée (usage, sous-commandes, permissions, **options**,',
          '**commandes liées**), recherche tolérante aux fautes de frappe et vue **Mes accès**.',
        ].join('\n'),
      },
      {
        name: '🩺 `/help` → **Diagnostic** — l\'état réel, sans jargon',
        value: [
          'Latence, uptime, mémoire, **shards** et serveurs visibles, taille de la base,',
          'collections, index, documents nettoyables et dernier entretien — dans un seul embed.',
        ].join('\n'),
      },
      {
        name: '🧩 Sharding — plusieurs processus, un seul bot',
        value: [
          'Passé quelques milliers de serveurs, une seule connexion Gateway ne suffit plus.',
          'Démarrez avec `npm run start:shards` : les serveurs sont répartis, le déploiement',
          'des commandes et les tâches planifiées restent sur le shard 0.',
        ].join('\n'),
      },
      {
        name: '🧽 Base de données allégée automatiquement',
        value: [
          'Chaque famille de documents a une **durée de vie** (journaux captcha 30 j, bumps 120 j,',
          'tickets modmail 180 j, conversations IA 30 j…). Le cron `db-maintenance` nettoie',
          'chaque nuit à 04:00 et rejoue les index — sans jamais toucher à la configuration.',
        ].join('\n'),
      },
      {
        name: '🗄️ `/securite` — coffre-fort de permissions',
        value: [
          'Il mémorise l\'accès attendu des salons et rôles sensibles, puis **referme**',
          'toute ouverture silencieuse : `@everyone` ajouté sur un salon staff, `Gérer les rôles`',
          'glissé à un rôle subalterne… L\'anti-nuke voit la destruction, pas ces ouvertures.',
        ].join('\n'),
      },
      {
        name: '⚖️ `/mod` — tous les gestes de modération au même endroit',
        value: [
          'Avertir et les paliers de sanctions restent là, avec en plus **débannir**,',
          '**verrouiller / rouvrir** un salon, régler le **mode lent** (`off`, `30s`, `5m`, `2h`) et',
          '**débloquer un membre coincé derrière le captcha**. La raison est acceptée partout.',
        ].join('\n'),
      },
      {
        name: '⌨️ Anti-spam de commandes',
        value: [
          'Une rafale de commandes slash n\'est plus invisible : elle est **refusée**. Les commandes',
          'd\'autres bots (`!play`, `?rank`…) sont comptées et supprimées — jamais un message normal.',
          'Réglage dans `/securite` → Anti-Spam.',
        ].join('\n'),
      },
      {
        name: '🎫 `/ticket` — une seule commande pour tout le système',
        value: 'Panels, catégories, personnalisation, support, statistiques et blacklist dans un panel unique.',
      },
      {
        name: '🚀 `/autopilote` — le bot mesure puis configure',
        value: 'Score d\'efficacité 0-100 %, plan d\'installation automatique et liste honnête de ce qui reste manuel.',
      },
      {
        name: '🛡️ `/antiraid` & `/anti-nuke` — deux couches complémentaires',
        value: 'Vigie pour les arrivées, Sentinel pour la destruction massive, `/audit-securite` pour noter le tout.',
      },
      {
        name: '🔐 `/setuprescue` — ne perdez plus jamais votre serveur',
        value: 'Récupération en 30 secondes grâce à une authentification 2FA et une clé hors ligne.',
      },
    )
    .setFooter({ text: brand.footer('Nouveautés') })
    .setTimestamp();
}

function buildLicenseEmbed(catalog) {
  const licensed = (catalog?.entries || []).filter(entry => entry.license);
  const list = licensed.length
    ? licensed.map(entry => `• \`/${entry.name}\``)
    : ['*Aucune commande sous licence dans ce build*'];

  return new EmbedBuilder()
    .setColor(C.accent)
    .setAuthor({ name: `${brand.BRAND.name} • Licence` })
    .setTitle(`${LOCK} Système de licence`)
    .setDescription([
      `${licensed.length} fonctionnalité(s) avancée(s) utilisent une **licence valide** pour votre serveur.`,
      'Tout le reste du bot fonctionne **sans licence**.',
      '',
      'La liste ci-dessous est générée depuis le bot chargé : elle ne peut pas être obsolète.',
    ].join('\n'))
    .addFields(
      { name: 'Commandes sous licence', value: truncate(list.join('\n'), 1024) },
      {
        name: 'Activer / vérifier',
        value: [
          '• `/license` → **🔑 Activer une clé** — `REZO-XXXX-XXXX-XXXX-XXXX`',
          '• `/license statut` — licence et essai gratuit',
          '• `/license aide` — explication complète',
        ].join('\n'),
      },
      { name: 'Essai gratuit', value: 'Un essai est disponible sur chaque serveur : lancez `/license` pour le voir.' },
    )
    .setFooter({ text: brand.footer(`${LOCK} = licence requise`) })
    .setTimestamp();
}

function buildRandomTipEmbed() {
  return new EmbedBuilder()
    .setColor(C.accent)
    .setAuthor({ name: `${brand.BRAND.name} • Le savais-tu ?` })
    .setTitle('💡 Le savais-tu ?')
    .setDescription(randomTip())
    .setFooter({ text: brand.footer('Une astuce au hasard') })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════════════════════
// RÉSOLUTION DE COMMANDE
// ═══════════════════════════════════════════════════════════════════════════════
function resolveCommand(catalog, raw) {
  const key = normalize(raw);
  if (!key) return null;
  if (catalog.byName.has(key)) return catalog.byName.get(key);
  const compact = key.replace(/\s+/g, '-');
  if (catalog.byName.has(compact)) return catalog.byName.get(compact);
  const matches = catalogLib.searchCatalog(catalog, key).commands;
  return matches[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════
function ctxOf(interaction, client) {
  return { client: client || interaction.client, member: interaction.member || null };
}

async function execute(interaction, client) {
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const requested = typeof interaction.options?.getString === 'function'
    ? interaction.options.getString('commande')
    : null;

  if (requested) {
    const entry = resolveCommand(catalog, requested);
    if (!entry) {
      return interaction.reply({
        content: `❌ Commande **${truncate(requested, 60)}** introuvable. Ouvre \`/help\` puis **Rechercher**, ou utilise l'autocomplétion de \`/help commande:\`.`,
        ephemeral: true,
      });
    }
    return interaction.reply({
      embeds: [buildCommandEmbed(catalog, entry.name, ctxOf(interaction, cli))],
      components: commandComponents(catalog, entry.name),
      ephemeral: true,
    });
  }

  const embed = await buildHomeEmbed(catalog, ctxOf(interaction, cli));
  return interaction.reply({ embeds: [embed], components: homeComponents(catalog) });
}

async function handleHome(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const embed = await buildHomeEmbed(catalog, ctxOf(interaction, cli));
  return interaction.update({ embeds: [embed], components: homeComponents(catalog) });
}

// Menu Catégories
async function handleSelect(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const category = groupOf(catalog, interaction.values[0]);
  if (!category) {
    return interaction.reply({ content: '❌ Catégorie introuvable.', ephemeral: true });
  }
  return interaction.update({
    embeds: [buildCategoryEmbed(catalog, category.id, 1, ctxOf(interaction, cli))],
    components: categoryComponents(catalog, category.id, 1),
  });
}

// Menu Guides
async function handleDocsSelect(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const guide = catalogLib.GUIDE_BY_ID[interaction.values[0]];
  if (!guide) {
    return interaction.reply({ content: '❌ Guide introuvable.', ephemeral: true });
  }
  return interaction.update({
    embeds: [buildGuideEmbed(catalog, guide, ctxOf(interaction, cli))],
    components: guideComponents(catalog, guide.id),
  });
}

// Menu des commandes d'une page de catégorie
async function handleCommandSelect(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const entry = catalog.byName.get(normalize(interaction.values[0]));
  if (!entry) {
    return interaction.reply({ content: '❌ Commande introuvable — elle a peut-être été retirée du bot.', ephemeral: true });
  }
  return interaction.update({
    embeds: [buildCommandEmbed(catalog, entry.name, ctxOf(interaction, cli))],
    components: commandComponents(catalog, entry.name),
  });
}

// Menu des résultats de recherche (valeurs `cmd:nom` / `doc:id`)
async function handleResultSelect(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const [kind, ...rest] = String(interaction.values[0] || '').split(':');
  const value = rest.join(':');

  if (kind === 'doc') {
    const guide = catalogLib.GUIDE_BY_ID[value];
    if (!guide) return interaction.reply({ content: '❌ Guide introuvable.', ephemeral: true });
    return interaction.update({
      embeds: [buildGuideEmbed(catalog, guide, ctxOf(interaction, cli))],
      components: guideComponents(catalog, guide.id),
    });
  }

  const entry = catalog.byName.get(normalize(value));
  if (!entry) {
    return interaction.reply({ content: '❌ Commande introuvable — elle a peut-être été retirée du bot.', ephemeral: true });
  }
  return interaction.update({
    embeds: [buildCommandEmbed(catalog, entry.name, ctxOf(interaction, cli))],
    components: commandComponents(catalog, entry.name),
  });
}

// Pagination
async function handlePage(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const match = /^help_page_(prev|next):([a-z0-9-]+):(\d+)$/.exec(interaction.customId);
  if (!match) return refuse(interaction);
  const [, direction, categoryId, rawPage] = match;
  const category = groupOf(catalog, categoryId);
  if (!category) return interaction.reply({ content: '❌ Catégorie introuvable.', ephemeral: true });
  const current = clampPage(category, rawPage);
  const page = clampPage(category, direction === 'next' ? current + 1 : current - 1);
  return interaction.update({
    embeds: [buildCategoryEmbed(catalog, category.id, page, ctxOf(interaction, cli))],
    components: categoryComponents(catalog, category.id, page),
  });
}

async function handleBack(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const match = /^help_back:([a-z0-9-]+)$/.exec(interaction.customId);
  const categoryId = match?.[1];
  const category = groupOf(catalog, categoryId);
  if (!category) return handleHome(interaction, client);
  return interaction.update({
    embeds: [buildCategoryEmbed(catalog, category.id, 1, ctxOf(interaction, cli))],
    components: categoryComponents(catalog, category.id, 1),
  });
}

// Bouton « Nouveautés »
async function handleWhatsNew(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const catalog = catalogFor(client || interaction.client);
  return interaction.reply({ embeds: [buildWhatsNewEmbed(catalog)], ephemeral: true });
}

// Bouton « Diagnostic » — mesure réelle du bot, du réseau et de la base.
// Volontairement lisible par tous : ce sont des chiffres de santé, pas des secrets.
async function handleDiagnostic(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const cli = client || interaction.client;
  const diag = await diagnostics.gatherDiagnostics(cli);
  return interaction.reply({ embeds: [diagnostics.buildDiagnosticEmbed(diag)], ephemeral: true });
}

// Bouton « Licence »
async function handleLicense(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const catalog = catalogFor(client || interaction.client);
  return interaction.reply({ embeds: [buildLicenseEmbed(catalog)], ephemeral: true });
}

// Bouton « Mes accès »
async function handleAccess(interaction, client) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const catalog = catalogFor(client || interaction.client);
  return interaction.reply({
    embeds: [buildAccessEmbed(catalog, interaction.member, ctxOf(interaction, client))],
    ephemeral: true,
  });
}

// Bouton « Découvrir » (conservé pour compatibilité d'API)
async function handleRandomButton(interaction) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  return interaction.reply({ embeds: [buildRandomTipEmbed()], ephemeral: true });
}

// Bouton « Rechercher » : ouvre la modale
async function handleSearchButton(interaction) {
  if (!ownsMenu(interaction)) return refuse(interaction);
  const modal = new ModalBuilder()
    .setCustomId('help_search_modal')
    .setTitle('🔎 Rechercher dans l\'aide');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('help_search_query')
      .setLabel('Commande, système ou mot-clé')
      .setPlaceholder('ex : bump, captcha, tickets, sécurité')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80),
  ));
  return interaction.showModal(modal);
}

// Modale de recherche : raccourci catégorie, sinon résultats
async function handleSearchModal(interaction, client) {
  const cli = client || interaction.client;
  const catalog = catalogFor(cli);
  const query = interaction.fields?.getTextInputValue?.('help_search_query') || '';

  const category = catalogLib.resolveCategoryAlias(catalog, query);
  if (category) {
    return interaction.reply({
      embeds: [buildCategoryEmbed(catalog, category.id, 1, ctxOf(interaction, cli))],
      components: categoryComponents(catalog, category.id, 1),
      ephemeral: true,
    });
  }

  // « bump » ne doit pas seulement renvoyer des résultats : si une commande
  // porte exactement ce nom, on ouvre directement sa fiche.
  const exact = catalog.byName.get(normalize(query));
  if (exact) {
    return interaction.reply({
      embeds: [buildCommandEmbed(catalog, exact.name, ctxOf(interaction, cli))],
      components: commandComponents(catalog, exact.name),
      ephemeral: true,
    });
  }

  const results = catalogLib.searchCatalog(catalog, query);
  return interaction.reply({
    embeds: [buildSearchResultsEmbed(query.trim(), results, ctxOf(interaction, cli))],
    components: searchComponents(results),
    ephemeral: true,
  });
}

// Routeur des boutons du centre d'aide
async function handleButton(interaction, client) {
  const id = interaction.customId;
  if (id.startsWith('help_page_')) return handlePage(interaction, client);
  if (id.startsWith('help_back')) return handleBack(interaction, client);

  switch (id) {
    case 'help_home':     return handleHome(interaction, client);
    case 'help_search':   return handleSearchButton(interaction);
    case 'help_random':   return handleRandomButton(interaction);
    case 'help_whatsnew': return handleWhatsNew(interaction, client);
    case 'help_license':  return handleLicense(interaction, client);
    case 'help_access':   return handleAccess(interaction, client);
    case DIAG_ID:         return handleDiagnostic(interaction, client);
    default:              return refuse(interaction);
  }
}

// Autocomplétion de `/help commande:<nom>`
async function autocomplete(interaction, client) {
  const catalog = catalogFor(client || interaction.client);
  const focused = typeof interaction.options?.getFocused === 'function'
    ? interaction.options.getFocused(true)
    : { value: '' };
  const query = normalize(focused?.value || '');

  // Même moteur que la recherche du panel (alias, fautes de frappe, options) :
  // l'autocomplétion ne doit pas être plus bête que le menu.
  const pool = query
    ? catalogLib.searchCatalog(catalog, query).commands
      .concat(catalog.entries.filter(entry =>
        normalize(entry.name).includes(query) || normalize(entry.description).includes(query)))
    : catalog.entries;
  const unique = [...new Map(pool.map(entry => [entry.name, entry])).values()];

  const choices = unique.slice(0, 25).map(entry => ({
    name: truncate(`/${entry.name} — ${entry.description || 'commande'}`, 100),
    value: entry.name,
  }));
  return interaction.respond(choices);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('📚 Centre d\'aide REZO — commandes, guides et recherche')
    .addStringOption(option => option
      .setName('commande')
      .setDescription('Ouvrir directement la fiche d\'une commande')
      .setAutocomplete(true)
      .setRequired(false)),

  execute,
  autocomplete,
  handleHome,
  handleSelect,
  handleDocsSelect,
  handleCommandSelect,
  handleResultSelect,
  handleButton,
  handleWhatsNew,
  handleRandomButton,
  handleLicense,
  handleAccess,
  handleSearchButton,
  handleSearchModal,
  handleDiagnostic,

  // Exposé pour la suite de tests : rendu pur, sans I/O.
  __testables: {
    TIPS, PAGE_SIZE, COMMAND_SELECT_LIMIT, LOCK, DIAG_ID,
    formatCooldown, diagnostics,
    catalogFor, resetCache, ownsMenu, commandLabel, resolveCommand, randomTip,
    buildHomeEmbed, homeComponents,
    buildCategoryEmbed, categoryComponents, categorySelect, docsSelect,
    buildCommandEmbed, commandComponents,
    buildGuideEmbed, guideComponents, commandsCitedInGuide,
    buildSearchResultsEmbed, searchComponents,
    buildAccessEmbed, buildLicenseEmbed, buildWhatsNewEmbed, buildRandomTipEmbed,
    pageCount, clampPage, pageEntries, groupOf,
    ...catalogLib,
  },
};
