'use strict';
// utils/brand.js — Kit d'identité visuelle REZO.
//
// Source unique de vérité pour l'apparence du bot : palette, glyphes, signature
// de pied d'embed, barre de progression visuelle et grades. Tout module qui veut
// « ressembler à REZO » passe par ici — ce qui garantit une identité cohérente
// sur l'ensemble des 100+ commandes au lieu de couleurs choisies au hasard.
//
// Aucune dépendance à Discord au-delà de l'objet embed : ces fonctions sont
// pures et testables sans client ni base de données.

const release = require('../core/release');

// Nom, version et slogan viennent de `core/release` : un seul endroit à changer
// pour que les embeds, la présence et le site restent alignés.
const CURRENT = release.currentRelease();

const BRAND = {
  name: CURRENT.name,
  version: CURRENT.version,
  tagline: CURRENT.tagline,
  // Palette de marque — le rouge vin est la couleur historique de REZO.
  // Palette refonte 2026 : bordeaux plus profond, or plus chaud, couleurs
  // d'état lisibles sur le thème sombre. Tous les embeds en héritent.
  colors: {
    primary:  0x8E1B2E, // bordeaux REZO — couleur de marque
    wine:     0x8E1B2E,
    accent:   0xD8A548, // or REZO — signature secondaire
    success:  0x2FBF71,
    warning:  0xE0A32E,
    error:    0xE5484D,
    info:     0x4C9AFF,
    muted:    0x8B949E, // états vides, éléments secondaires
    surface:  0x15131A, // fond des panneaux neutres
  },
  // Glyphes signature : barre pleine / barre vide.
  glyphs: {
    full:  '▰',
    empty: '▱',
    divider: '▬',
  },
  // Emoji thématiques réutilisés partout pour l'identité.
  emoji: {
    shield: '🛡️',
    crown: '👑',
    spark: '✨',
    bolt: '⚡',
    chart: '📊',
  },
};

// ── Signature ────────────────────────────────────────────────────────────────
function footer(text = null) {
  return `${BRAND.name} • ${text || `v${BRAND.version}`}`;
}

function divider(length = 14) {
  return BRAND.glyphs.divider.repeat(length);
}

// ── Barre de progression visuelle ────────────────────────────────────────────
// bar(90)            -> '▰▰▰▰▰▰▰▰▰▰▱▱'
// bar(90, {suffix:1}) -> '▰▰▰▰▰▰▰▰▰▰▱▱ 90%'
function bar(percent, { length = 12, suffix = true, full = BRAND.glyphs.full, empty = BRAND.glyphs.empty } = {}) {
  const pct    = clampPercent(percent);
  const filled = Math.round((pct / 100) * length);
  const barTxt = full.repeat(filled) + empty.repeat(Math.max(0, length - filled));
  return suffix ? `${barTxt} \`${pct}%\`` : barTxt;
}

function clampPercent(percent) {
  const n = Number(percent);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ── Grades ───────────────────────────────────────────────────────────────────
// Grille de notation signature : S ≥ 90 (l'objectif « efficace à 90% »).
const GRADES = [
  { min: 90, letter: 'S', label: 'Excellent',    emoji: '🏆', color: BRAND.colors.accent },
  { min: 75, letter: 'A', label: 'Très bon',     emoji: '🥇', color: BRAND.colors.success },
  { min: 60, letter: 'B', label: 'Correct',      emoji: '🥈', color: BRAND.colors.info },
  { min: 40, letter: 'C', label: 'À améliorer',  emoji: '🥉', color: BRAND.colors.warning },
  { min: 0,  letter: 'D', label: 'Critique',     emoji: '⚠️', color: BRAND.colors.error },
];

// Objectif d'efficacité du bot : un serveur bien configuré atteint 90%.
const GOAL_PERCENT = 90;

function grade(percent) {
  const pct = clampPercent(percent);
  return GRADES.find(g => pct >= g.min) || GRADES[GRADES.length - 1];
}

function scoreColor(percent) {
  return grade(percent).color;
}

// ── Embeds ───────────────────────────────────────────────────────────────────
// Construit un embed déjà « brandé » : couleur, auteur signature, pied REZO.
function brandEmbed({
  title = null,
  description = null,
  color = BRAND.colors.primary,
  footerText = null,
  thumbnail = null,
  fields = null,
  author = BRAND.name,
  timestamp = false,
} = {}) {
  const { EmbedBuilder } = require('discord.js');
  const e = new EmbedBuilder().setColor(color);
  if (author) e.setAuthor({ name: `${author} ${BRAND.emoji.spark}`.trim() });
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  if (thumbnail) e.setThumbnail(thumbnail);
  if (fields?.length) e.addFields(fields);
  e.setFooter({ text: footer(footerText || BRAND.tagline) });
  if (timestamp) e.setTimestamp();
  // Le pied de page par défaut vient d'être posé : applyBrand() le remplace par
  // celui du serveur si une identité personnalisée est active.
  return applyBrand(e);
}

// Applique l'identité du SERVEUR (si elle est active et chargée par le contexte
// courant), puis la signature REZO par défaut. L'identité de serveur est lue
// dans le cache synchrone de guildBrand : aucun await dans le rendu d'un embed.
function applyBrand(embed, { footerText = null } = {}) {
  if (!embed || typeof embed.setFooter !== 'function') return embed;

  try {
    const guildBrand = require('./guildBrand');
    const cfg = guildBrand.getCachedConfig();
    if (cfg?.enabled) guildBrand.applyBrandToEmbed(embed, cfg);
  } catch { /* identité de serveur facultative : jamais bloquante */ }

  const existing = typeof embed.data?.footer?.text === 'string' ? embed.data.footer.text : null;
  if (existing) return embed;
  embed.setFooter({ text: footer(footerText || BRAND.tagline) });
  return embed;
}

module.exports = {
  BRAND,
  GOAL_PERCENT,
  GRADES,
  footer,
  divider,
  bar,
  grade,
  scoreColor,
  clampPercent,
  brandEmbed,
  applyBrand,
};
