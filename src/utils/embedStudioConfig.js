'use strict';
// utils/embedStudioConfig.js — Règles pures du studio d'embeds.
//
// Aucune dépendance à Discord ni à Mongo : limites, validation et
// normalisation, donc testable hors-ligne. Toute saisie utilisateur passe par
// ici avant d'être écrite, ce qui évite les refus 50035 de l'API.

const LIMITS = {
  title: 256,
  description: 4096,
  author: 256,
  footer: 2048,
  fieldName: 256,
  fieldValue: 1024,
  content: 2000,
  name: 60,
  fields: 25,
  buttons: 25,
  url: 400,
};

const DEFAULT_COLOR = '0x8B1A1A';

function normalizeHex(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null;
  const full = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw;
  return `0x${full.toUpperCase()}`;
}

function hexToInt(hex, fallback = 0x8B1A1A) {
  const norm = normalizeHex(hex);
  if (!norm) return fallback;
  const n = parseInt(norm.slice(2), 16);
  return Number.isFinite(n) ? n : fallback;
}

function clampText(value, max, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s ? s.slice(0, max) : fallback;
}

function isHttpUrl(value) {
  return /^https?:\/\/\S+$/i.test(String(value || '').trim());
}

// Emoji : Unicode uniquement. Un `<:nom:id>` d'un serveur où le bot n'est pas
// présent ferait échouer l'envoi du message.
function normalizeEmoji(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^<a?:[A-Za-z0-9_]+:\d{5,}>$/.test(s)) return '';
  return s.slice(0, 16);
}

function normalizeField(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = clampText(raw.name, LIMITS.fieldName);
  const value = clampText(raw.value, LIMITS.fieldValue);
  if (!name || !value) return null;
  return { name, value, inline: raw.inline === true };
}

function normalizeFields(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeField).filter(Boolean).slice(0, LIMITS.fields);
}

const BUTTON_TYPES = ['link', 'role', 'reply', 'ticket'];

function normalizeType(value) {
  const s = String(value || '').toLowerCase().trim();
  if (['role', 'rôle', 'roles', 'rôles'].includes(s)) return 'role';
  if (['reply', 'reponse', 'réponse', 'texte', 'message'].includes(s)) return 'reply';
  if (['ticket', 'tickets', 'support'].includes(s)) return 'ticket';
  // tout le reste (lien, url, link, vide) → bouton-liens : compatibilité avec
  // les boutons enregistrés avant l'ajout des types.
  return 'link';
}

function normalizeRoleMode(value) {
  const s = String(value || '').toLowerCase().trim();
  if (['add', 'ajouter', 'ajout', 'donner'].includes(s)) return 'add';
  if (['remove', 'retirer', 'retrait', 'enlever'].includes(s)) return 'remove';
  return 'toggle';
}

function normalizeRoleId(value) {
  const s = String(value || '').trim();
  const m = s.match(/^<@&(\d{5,})>$/) || s.match(/^(\d{5,})$/);
  return m ? m[1] : '';
}

function normalizeButton(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = clampText(raw.label, 80);
  if (!label) return null;

  const type = normalizeType(raw.type);
  const emoji = normalizeEmoji(raw.emoji);
  const base = { label, emoji, type };

  if (type === 'link') {
    const url = String(raw.url || '').trim().slice(0, LIMITS.url);
    if (!isHttpUrl(url)) return null;
    return { ...base, url };
  }

  if (type === 'role') {
    // Le rôle peut être choisi après la création (assistant du studio) : un
    // brouillon sans roleId reste valide, il n'est simplement pas publié.
    return { ...base, roleId: normalizeRoleId(raw.roleId), roleMode: normalizeRoleMode(raw.roleMode) };
  }

  if (type === 'reply') {
    const response = clampText(raw.response, 1000);
    if (!response) return null;
    return { ...base, response };
  }

  return { ...base, ticketPanel: clampText(raw.ticketPanel, 100, 't1') };
}

function normalizeButtons(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeButton).filter(Boolean).slice(0, LIMITS.buttons);
}

function nextPanelKey(used = []) {
  const taken = new Set(used.map(k => String(k)));
  let n = 1;
  while (taken.has(`e${n}`)) n++;
  return `e${n}`;
}

function defaults(name = 'Embed') {
  return {
    name: clampText(name, LIMITS.name, 'Embed'),
    content: '',
    authorName: '',
    authorIcon: '',
    title: '',
    description: '',
    color: DEFAULT_COLOR,
    footer: '',
    footerIcon: '',
    image: '',
    thumbnail: '',
    timestamp: true,
    fields: [],
    buttons: [],
  };
}

// Décrit la complétude d'un panel (utilisé dans la vue d'ensemble).
function completeness(panel) {
  const checks = [
    { label: 'Titre', test: p => !!p.title },
    { label: 'Description', test: p => !!p.description },
    { label: 'Couleur personnalisée', test: p => normalizeHex(p.color) && normalizeHex(p.color) !== DEFAULT_COLOR },
    { label: 'Au moins un champ', test: p => normalizeFields(p.fields).length > 0 },
    { label: 'Au moins un bouton', test: p => normalizeButtons(p.buttons).length > 0 },
    { label: 'Salon défini', test: p => !!p.channelId },
    { label: 'Publié', test: p => !!p.messageId },
  ];
  const done = checks.filter(c => { try { return !!c.test(panel || {}); } catch { return false; } });
  return { percent: Math.round((done.length / checks.length) * 100), done: done.map(c => c.label), todo: checks.filter(c => !done.includes(c)).map(c => c.label) };
}

module.exports = {
  LIMITS,
  DEFAULT_COLOR,
  normalizeHex,
  hexToInt,
  clampText,
  isHttpUrl,
  normalizeEmoji,
  normalizeField,
  normalizeFields,
  normalizeButton,
  normalizeButtons,
  normalizeType,
  normalizeRoleMode,
  normalizeRoleId,
  BUTTON_TYPES,
  nextPanelKey,
  defaults,
  completeness,
};
