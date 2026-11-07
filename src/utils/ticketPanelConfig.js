'use strict';
// utils/ticketPanelConfig.js — Règles métier pures du panel de tickets.
//
// Ce module ne touche ni à Discord ni à la base : il valide et normalise les
// réglages, transforme les saisies utilisateur en données sûres, et calcule la
// « complétude » d'un panel. Résultat : le panel unique de `/ticket` reste
// testable hors-ligne et les écritures en base ne peuvent pas contenir de
// valeur absurde.

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// ── Couleurs ────────────────────────────────────────────────────────────────
// Accepte « 2F7DFF », « #2F7DFF », « 0x2F7DFF » (espaces/casse ignorés).
// Renvoie '0xRRGGBB' ou null si la valeur n'est pas une couleur hex valide.
function normalizeHex(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null;
  const full = raw.length === 3
    ? raw.split('').map(c => c + c).join('')
    : raw;
  return `0x${full.toUpperCase()}`;
}

function hexToInt(hex, fallback = 0x3498DB) {
  const norm = normalizeHex(hex);
  if (!norm) return fallback;
  const n = parseInt(norm.slice(2), 16);
  return Number.isFinite(n) ? n : fallback;
}

// ── Nombres ─────────────────────────────────────────────────────────────────
function clampInt(value, min, max, fallback = min) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampCooldown(value) {
  return clampInt(value, 0, 3600, 0); // 0 = aucun, plafond 1 h
}

// ── Texte ───────────────────────────────────────────────────────────────────
// Le titre/la description d'embed ont des limites Discord strictes.
function clampText(value, max, { fallback = '' } = {}) {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s ? s.slice(0, max) : fallback;
}

// Emoji de bouton : Unicode uniquement. Les anciens tags custom `<:nom:id>`
// sont refusés (null) pour que le bot n'affiche jamais d'emoji de serveur ou
// d'application : les appelants retombent sur leur emoji Unicode par défaut.
function normalizeEmoji(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^<a?:[A-Za-z0-9_]+:\d{5,}>$/.test(s)) return null;
  if (/^[A-Za-z0-9_]+:\d{5,}$/.test(s)) return null;
  return s.slice(0, 16);
}

function sanitizePrefix(value) {
  const v = String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  return v.slice(0, 15) || 'ticket';
}

function isValidPriority(value) {
  return PRIORITIES.includes(String(value || '').toLowerCase().trim());
}

// ── Questions du formulaire d'ouverture ─────────────────────────────────────
// Format compact « Question 1 | Question 2 ». 5 questions maximum (limite de
// modales Discord). Une question longue devient un champ multiligne.
function parseQuestions(text) {
  const labels = String(text || '')
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5);
  return labels.map(label => ({
    label: label.slice(0, 45),
    style: label.length > 45 ? 'paragraph' : 'short',
    required: true,
    maxLength: 1000,
  }));
}

function questionsToText(questions) {
  return (questions || []).map(q => q.label).join(' | ');
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(q => (typeof q === 'string' ? q : q?.label))
    .filter(Boolean)
    .slice(0, 5)
    .map(label => ({
      label: String(label).trim().slice(0, 45),
      style: String(label).length > 45 ? 'paragraph' : 'short',
      required: true,
      maxLength: 1000,
    }));
}

// ── Valeurs par défaut ──────────────────────────────────────────────────────
const CATEGORY_DEFAULTS = {
  name: 'Support',
  emoji: '🎫',
  description: 'Ouvrir un ticket',
  channelPrefix: 'ticket',
  defaultPriority: 'normal',
  limitPerUser: 3,
  autoClaim: false,
  enabled: true,
};

const PANEL_DEFAULTS = {
  embedColor: '0x8B1A1A',
  embedTitle: '',
  embedDesc: '',
  embedImage: '',
  buttonLabel: '🎫 Ouvrir un ticket',
  buttonEmoji: '🎫',
  welcomeMessage: '',
  embedAuthor: '',
  embedAuthorIcon: '',
  embedFooter: '',
  embedFooterIcon: '',
  embedThumbnail: '',
  embedTimestamp: true,
  panelContent: '',
  cooldown: 0,
  dmUser: false,
  dmOnClose: false,
  mentionOnOpen: false,
};

// ── Complétude d'un panel ───────────────────────────────────────────────────
// Modèle « efficace à 90% » : chaque critère pèse un poids, le score est la
// part de poids satisfaite. Pur, donc testable et utilisable dans l'embed.
const COMPLETENESS_CHECKS = [
  { key: 'panel-posted',  weight: 12, label: 'Panel posté dans un salon',        hint: 'Cliquez sur « Reposter »',        test: (p, cats) => !!p.messageId && !!p.channelId },
  { key: 'categories',    weight: 14, label: 'Au moins 2 catégories',            hint: 'Ajoutez une catégorie (bug, achat…)', test: (p, cats) => cats.length >= 2 },
  { key: 'descriptions',  weight: 10, label: 'Catégories décrites',              hint: 'Renseignez la description',        test: (p, cats) => cats.length > 0 && cats.every(c => !!c.description) },
  { key: 'embed-title',   weight: 8,  label: 'Titre du panel personnalisé',      hint: 'Personnalisation → Titre',         test: p => !!p.embedTitle },
  { key: 'embed-desc',    weight: 8,  label: 'Description du panel',             hint: 'Personnalisation → Description',   test: p => !!p.embedDesc },
  { key: 'welcome',       weight: 10, label: "Message d'accueil à l'ouverture",  hint: 'Personnalisation → Message d\'accueil', test: p => !!p.welcomeMessage },
  { key: 'support-roles', weight: 12, label: 'Rôle support défini',              hint: 'Catégorie → Rôle support',         test: (p, cats) => cats.length > 0 && cats.some(c => !!c.supportRoleId) },
  { key: 'destinations',  weight: 10, label: 'Catégorie Discord de destination', hint: 'Catégorie → Destination',          test: (p, cats) => cats.length > 0 && cats.some(c => !!c.targetCategoryId || !!c.targetChannelId) },
  { key: 'archive',       weight: 8,  label: 'Archivage des tickets fermés',     hint: 'Comportement → Archivage',         test: p => !!p.closeCategoryId },
  { key: 'transcript',    weight: 8,  label: 'Salon des transcripts',            hint: 'Comportement → Transcripts',       test: p => !!p.transcriptChannelId },
];

function completeness(panel, categories) {
  // Tolère un état corrompu (champ absent, non-tableau) sans jamais planter.
  const source = Array.isArray(categories)
    ? categories
    : (Array.isArray(panel?.categories) ? panel.categories : []);
  const cats = source.filter(c => c && c.enabled !== false);
  const done = [];
  const todo = [];
  let earned = 0;
  let total = 0;
  for (const check of COMPLETENESS_CHECKS) {
    total += check.weight;
    let ok = false;
    try { ok = !!check.test(panel || {}, cats); } catch { ok = false; }
    if (ok) { earned += check.weight; done.push(check); }
    else todo.push(check);
  }
  const percent = total ? Math.round((earned / total) * 100) : 0;
  return { percent, earned, total, done, todo };
}

// ── Options de menus (données, testables) ───────────────────────────────────
const PANEL_VIEWS = [
  { value: 'overview',   emoji: '📊', label: "Vue d'ensemble",  description: 'État et complétude du panel' },
  { value: 'embed',      emoji: '🎨', label: 'Personnalisation', description: 'Titre, description, couleur, image, bouton' },
  { value: 'behavior',   emoji: '⚙️', label: 'Comportement',     description: 'MP, mention, cooldown, archivage, transcripts' },
  { value: 'categories', emoji: '🗂️', label: 'Catégories',       description: 'Gérer les types de tickets' },
  { value: 'staff',      emoji: '🛠️', label: 'Support & stats',  description: 'Console staff : stats, tickets, blacklist, actions' },
];

const PANEL_FIELDS = [
  { value: 'title',    emoji: '🏷️', label: 'Titre du panel',       description: 'Titre affiché en haut de l\'embed' },
  { value: 'desc',     emoji: '📝', label: 'Description',          description: 'Texte sous le titre' },
  { value: 'color',    emoji: '🎨', label: 'Couleur (hex)',        description: 'Ex : 8B1A1A' },
  { value: 'image',    emoji: '🖼️', label: 'Image (URL)',          description: 'Bannière décorative du panel' },
  { value: 'button',   emoji: '🔘', label: 'Bouton d\'ouverture',   description: 'Emoji + texte du bouton' },
  { value: 'welcome',  emoji: '👋', label: 'Message d\'accueil',    description: 'Variables {user} {guild} {category}' },
  { value: 'rename',   emoji: '✏️', label: 'Renommer le panel',     description: 'Nom interne du panel' },
  { value: 'channel',  emoji: '📍', label: 'Salon du panel',        description: 'Où le panel est posté' },
  { value: 'cooldown', emoji: '⏱️', label: 'Cooldown par membre',   description: 'Secondes entre deux tickets' },
  { value: 'author',     emoji: '👤', label: 'Auteur de l\'embed',   description: 'Ligne au-dessus du titre' },
  { value: 'authoricon', emoji: '🖼️', label: 'Icône de l\'auteur',   description: 'URL de l\'avatar' },
  { value: 'footer',     emoji: '📎', label: 'Pied de page',          description: 'Texte sous l\'embed' },
  { value: 'footericon', emoji: '🖼️', label: 'Icône du footer',       description: 'URL de l\'icône' },
  { value: 'thumbnail',  emoji: '🖼️', label: 'Miniature',             description: 'Image en haut à droite' },
  { value: 'content',    emoji: '💬', label: 'Message au-dessus',     description: 'Texte hors embed' },
  { value: 'timestamp',  emoji: '🕒', label: 'Horodatage',            description: 'Afficher la date du panel' },
];

const BEHAVIOR_FIELDS = [
  { value: 'dmopen',    emoji: '📩', label: 'MP à l\'ouverture',      description: 'Prévenir l\'auteur en privé' },
  { value: 'dmclose',   emoji: '📪', label: 'MP à la fermeture',      description: 'Prévenir l\'auteur quand c\'est fermé' },
  { value: 'mention',   emoji: '🔔', label: 'Mentionner le support',  description: 'Mentionner le rôle support à l\'ouverture' },
  { value: 'cooldown',  emoji: '⏱️', label: 'Cooldown par membre',    description: 'Secondes entre deux tickets' },
  { value: 'archive',   emoji: '🗄️', label: 'Catégorie d\'archivage', description: 'Où ranger les tickets fermés' },
  { value: 'transcript',emoji: '📄', label: 'Salon des transcripts',  description: 'Où poster/recevoir les transcripts' },
];

const CATEGORY_FIELDS = [
  { value: 'rename',      emoji: '✏️', label: 'Renommer',           description: 'Nom visible dans le panel' },
  { value: 'emoji',       emoji: '😀', label: 'Emoji',              description: 'Emoji affiché devant le nom' },
  { value: 'description', emoji: '📝', label: 'Description',        description: 'Texte du menu déroulant' },
  { value: 'prefix',      emoji: '🏷️', label: 'Préfixe des salons', description: 'Ex : support → support-0001' },
  { value: 'priority',    emoji: '📌', label: 'Priorité par défaut', description: 'low / normal / high / urgent' },
  { value: 'limit',       emoji: '🔢', label: 'Limite par membre',   description: '0 = illimité' },
  { value: 'role',        emoji: '🎭', label: 'Rôle support',        description: 'Accès + mention dans le ticket' },
  { value: 'dest',        emoji: '📂', label: 'Catégorie Discord',   description: 'Où créer les salons' },
  { value: 'fixed',       emoji: '📌', label: 'Salon fixe',          description: 'Un seul salon pour tous les tickets' },
  { value: 'questions',   emoji: '❓', label: 'Questions du formulaire', description: 'Jusqu\'à 5, séparées par |' },
  { value: 'autoclaim',   emoji: '🤖', label: 'Auto-claim',          description: 'Claim automatique à l\'ouverture' },
  { value: 'enabled',     emoji: '🔀', label: 'Activer / désactiver', description: 'Masquer sans supprimer' },
  { value: 'delete',      emoji: '🗑️', label: 'Supprimer',           description: 'Retirer définitivement' },
];

module.exports = {
  PRIORITIES,
  CATEGORY_DEFAULTS,
  PANEL_DEFAULTS,
  PANEL_VIEWS,
  PANEL_FIELDS,
  BEHAVIOR_FIELDS,
  CATEGORY_FIELDS,
  COMPLETENESS_CHECKS,
  normalizeHex,
  hexToInt,
  clampInt,
  clampCooldown,
  clampText,
  normalizeEmoji,
  sanitizePrefix,
  isValidPriority,
  parseQuestions,
  questionsToText,
  normalizeQuestions,
  completeness,
};
