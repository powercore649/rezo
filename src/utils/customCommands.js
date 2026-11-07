'use strict';
// utils/customCommands.js — Moteur des commandes personnalisées.
//
// Discord n'autorise pas une commande slash par membre (100 commandes
// globales maximum, et une commande appartient au bot, pas à un utilisateur).
// Ce moteur fournit l'équivalent réel : chaque membre crée SES commandes,
// stockées par serveur, et les déclenche via `/custom utiliser` (autocomplétion)
// ou via le préfixe du serveur (`b!ma-commande`).
//
// Le module est volontairement scindé en deux :
//   • des fonctions PURES (normalisation, validation, rendu, autocomplétion,
//     droits) — testables sans Discord ni MongoDB ;
//   • un adaptateur de stockage (`store`) qui enveloppe le modèle Mongoose et
//     peut être remplacé par un faux en mémoire dans les tests
//     (`__setStoreForTests`), ce qui permet de tester les flux complets
//     création → usage → modification → suppression hors base.

const NAME_RE   = /^[a-z0-9](?:[a-z0-9_-]{0,31})$/;

const MAX_NAME_LENGTH  = 32;
const MAX_DESCRIPTION  = 120;
const MAX_RESPONSE     = 4000;  // limite d'une description d'embed Discord
const MAX_PER_MEMBER   = 10;    // commandes créées par un même membre
const MAX_PER_GUILD    = 200;   // commandes d'un serveur, toutes confondues
const RUN_COOLDOWN_MS  = 2500;  // anti-spam : un même membre sur une même commande

// Variables utilisables dans le texte de la réponse.
const PLACEHOLDERS = [
  { key: '{user}',        hint: 'mention de celui qui a lancé la commande' },
  { key: '{username}',    hint: 'pseudo Discord (sans @)' },
  { key: '{displayname}', hint: 'pseudo affiché sur le serveur' },
  { key: '{server}',      hint: 'nom du serveur' },
  { key: '{channel}',     hint: 'salon où la commande est lancée' },
  { key: '{count}',       hint: 'nombre total d\'utilisations' },
  { key: '{args}',        hint: 'texte saisi après le nom de la commande' },
];

// ── Normalisation ────────────────────────────────────────────────────────────
// « Ma Commande ! » → « ma-commande ». Les accents sont retirés pour que le
// déclencheur reste tapable au clavier, comme les noms de commandes Discord.
function normalizeName(raw) {
  return String(raw ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^[!/.\s]+/, '')
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[-_]+$/, '');
}

// ── Validation ───────────────────────────────────────────────────────────────
function validateName(raw, { reserved = [] } = {}) {
  const name = normalizeName(raw);
  if (!name) {
    return { ok: false, code: 'EMPTY', message: 'Choisis un nom (lettres, chiffres, `-` ou `_`).' };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false, code: 'FORMAT',
      message: `Le nom doit faire 1 à ${MAX_NAME_LENGTH} caractères : lettres minuscules, chiffres, \`-\` ou \`_\`.`,
    };
  }
  const taken = new Set((reserved || []).map(n => String(n).toLowerCase()));
  if (taken.has(name)) {
    return { ok: false, code: 'RESERVED', message: `\`${name}\` est déjà une commande du bot — choisis un autre nom.` };
  }
  return { ok: true, name };
}

function validateResponse(text) {
  const value = String(text ?? '').trim();
  if (!value) return { ok: false, code: 'EMPTY', message: 'Le texte de la réponse ne peut pas être vide.' };
  if (value.length > MAX_RESPONSE) {
    return { ok: false, code: 'TOO_LONG', message: `La réponse est trop longue (${value.length}/${MAX_RESPONSE} caractères).` };
  }
  return { ok: true, value };
}

function validateDescription(text) {
  const value = String(text ?? '').trim();
  if (value.length > MAX_DESCRIPTION) {
    return { ok: false, code: 'TOO_LONG', message: `La description est trop longue (${value.length}/${MAX_DESCRIPTION} caractères).` };
  }
  return { ok: true, value };
}

// ── Rendu ────────────────────────────────────────────────────────────────────
function pluralizeCount(n) {
  return String(Number.isFinite(Number(n)) ? Number(n) : 0);
}

/**
 * Remplace les variables d'une réponse par leurs valeurs.
 * Une variable inconnue est laissée telle quelle (aucune surprise silencieuse).
 * @param {string} template
 * @param {{ userId?:string, username?:string, displayName?:string, guildName?:string, channelId?:string, count?:number, args?:string }} ctx
 */
function renderResponse(template, ctx = {}) {
  const userId = ctx.userId ?? null;
  const args = String(ctx.args ?? '').trim();
  const values = {
    '{user}': userId ? `<@${userId}>` : '',
    '{username}': ctx.username ?? '',
    '{displayname}': ctx.displayName || ctx.username || '',
    '{server}': ctx.guildName ?? '',
    '{channel}': ctx.channelId ? `<#${ctx.channelId}>` : '',
    '{count}': pluralizeCount(ctx.count),
    '{args}': args,
  };
  let out = String(template ?? '');
  for (const [key, value] of Object.entries(values)) {
    if (!out.includes(key)) continue;
    out = out.split(key).join(value);
  }
  return out.slice(0, 4096);
}

/**
 * Droits d'utilisation d'une commande personnalisée.
 * @param {object} doc
 * @param {{ userId?:string, memberRoleIds?:string[] }} who
 */
function canUse(doc, { userId = null, memberRoleIds = [] } = {}) {
  if (!doc) return false;
  if (!doc.enabled) return false;
  if (doc.ownerId && doc.ownerId === userId) return true;
  if (!doc.isPublic) return false;
  const allowed = Array.isArray(doc.allowedRoleIds) ? doc.allowedRoleIds : [];
  if (allowed.length && !allowed.some(id => (memberRoleIds || []).includes(id))) return false;
  return true;
}

/** Résumé d'une commande pour l'autocomplétion (25 propositions maximum). */
function suggestNames(docs, focused = '', { userId = null, limit = 25 } = {}) {
  const needle = String(focused ?? '').toLowerCase();
  const mine = [];
  const others = [];
  for (const doc of docs || []) {
    if (!doc?.name) continue;
    const haystack = `${doc.name} ${doc.description || ''}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    (doc.ownerId === userId ? mine : others).push(doc);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const format = doc => ({
    name: `${doc.name}${doc.ownerId === userId ? '' : ' · partagée'}${doc.description ? ` — ${doc.description}` : ''}`.slice(0, 100),
    value: doc.name.slice(0, 100),
  });
  return [...mine.sort(byName), ...others.sort(byName)].slice(0, limit).map(format);
}

/** Réponse complète d'une commande (embed brandé, jamais de ping de masse). */
function buildResponsePayload(doc, ctx = {}) {
  const { brandEmbed, BRAND } = require('./brand');
  const embed = brandEmbed({
    title: `/${doc?.name || 'commande'}`,
    description: renderResponse(doc?.response, ctx) || '*Cette commande est vide.*',
    color: BRAND.colors.primary,
    footerText: `Commande personnalisée • /custom`,
  });
  return { embeds: [embed], allowedMentions: { parse: [] } };
}

// ── Anti-spam (en mémoire : une entrée par membre + commande) ────────────────
const { createBoundedCache } = require('./boundedCache');
// BORNÉ : une entrée par membre et par commande personnalisée.
const cooldowns = createBoundedCache({ max: 20_000, ttl: 0, name: 'custom-cooldown' });

function checkCooldown(userId, name, now = Date.now()) {
  const key = `${userId}:${name}`;
  const until = cooldowns.get(key) ?? 0;
  if (now < until) return { ok: false, retryIn: Math.max(1, Math.ceil((until - now) / 1000)) };
  cooldowns.set(key, now + RUN_COOLDOWN_MS);
  return { ok: true };
}

function __resetCooldowns() { cooldowns.clear(); }

// ── Stockage ─────────────────────────────────────────────────────────────────
// Adaptateur par défaut : Mongoose. Les objets renvoyés sont des objets simples
// (lean) pour que toutes les fonctions ci-dessus fonctionnent sans document
// Mongoose hydraté — et donc qu'un faux store suffise en test.
function createMongooseStore() {
  const model = () => require('../models/CustomCommand');
  return {
    async listByGuild(guildId) {
      return model().find({ guildId }).sort({ name: 1 }).lean();
    },
    async findByOwner(guildId, ownerId) {
      return model().find({ guildId, ownerId }).sort({ name: 1 }).lean();
    },
    async findOne(guildId, name) {
      return model().findOne({ guildId, name }).lean();
    },
    async countByOwner(guildId, ownerId) {
      return model().countDocuments({ guildId, ownerId });
    },
    async countByGuild(guildId) {
      return model().countDocuments({ guildId });
    },
    async create(data) {
      const doc = await model().create(data);
      return doc.toObject();
    },
    async update(guildId, name, patch) {
      return model().findOneAndUpdate({ guildId, name }, { $set: patch }, { new: true }).lean();
    },
    async incrementUse(guildId, name) {
      return model().findOneAndUpdate(
        { guildId, name },
        { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } },
        { new: true },
      ).lean();
    },
    async remove(guildId, name) {
      return model().deleteOne({ guildId, name });
    },
  };
}

let store = createMongooseStore();

function getStore() { return store; }

/** Remplace le stockage (tests uniquement) : `__setStoreForTests(null)` restaure Mongoose. */
function __setStoreForTests(fake) {
  store = fake || createMongooseStore();
  return store;
}

// ── Flux métier ──────────────────────────────────────────────────────────────
/**
 * Crée une commande personnalisée pour un membre.
 * @returns {Promise<{ok:true, doc:object}|{ok:false, code:string, message:string}>}
 */
async function createCustomCommand({
  guildId, ownerId, name, response, description = '', isPublic = false, ephemeral = false,
  allowedRoleIds = [], reserved = [],
} = {}) {
  const nameCheck = validateName(name, { reserved });
  if (!nameCheck.ok) return nameCheck;

  const responseCheck = validateResponse(response);
  if (!responseCheck.ok) return responseCheck;

  const descriptionCheck = validateDescription(description);
  if (!descriptionCheck.ok) return descriptionCheck;

  const existing = await store.findOne(guildId, nameCheck.name);
  if (existing) {
    return {
      ok: false, code: 'DUPLICATE',
      message: existing.ownerId === ownerId
        ? `Tu as déjà une commande \`${nameCheck.name}\` — modifie-la avec \`/custom modifier\` ou supprime-la d'abord.`
        : `\`${nameCheck.name}\` est déjà utilisé sur ce serveur. Choisis un autre nom.`,
    };
  }

  const owned = await store.countByOwner(guildId, ownerId);
  if (owned >= MAX_PER_MEMBER) {
    return {
      ok: false, code: 'MEMBER_LIMIT',
      message: `Tu as atteint la limite de **${MAX_PER_MEMBER} commandes personnalisées**. Supprime-en une pour en créer une nouvelle.`,
    };
  }

  const total = await store.countByGuild(guildId);
  if (total >= MAX_PER_GUILD) {
    return {
      ok: false, code: 'GUILD_LIMIT',
      message: `Ce serveur a atteint la limite de **${MAX_PER_GUILD} commandes personnalisées**.`,
    };
  }

  const doc = await store.create({
    guildId,
    ownerId,
    name: nameCheck.name,
    response: responseCheck.value,
    description: descriptionCheck.value,
    isPublic: Boolean(isPublic),
    ephemeral: Boolean(ephemeral),
    allowedRoleIds: Array.isArray(allowedRoleIds) ? allowedRoleIds : [],
    enabled: true,
    usageCount: 0,
    lastUsedAt: null,
  });

  return { ok: true, doc };
}

/**
 * Modifie une commande existante (son auteur, ou un administrateur du serveur).
 */
async function updateCustomCommand({
  guildId, userId, name, patch = {}, isManager = false, reserved = [],
} = {}) {
  const doc = await store.findOne(guildId, name);
  if (!doc) return { ok: false, code: 'NOT_FOUND', message: `Aucune commande \`${name}\` sur ce serveur.` };
  if (doc.ownerId !== userId && !isManager) {
    return { ok: false, code: 'FORBIDDEN', message: `\`${name}\` appartient à quelqu'un d'autre.` };
  }

  const next = {};

  if (patch.name !== undefined && String(patch.name) !== doc.name) {
    const nameCheck = validateName(patch.name, { reserved });
    if (!nameCheck.ok) return nameCheck;
    const clash = await store.findOne(guildId, nameCheck.name);
    if (clash) {
      return { ok: false, code: 'DUPLICATE', message: `\`${nameCheck.name}\` est déjà utilisé sur ce serveur.` };
    }
    next.name = nameCheck.name;
  }

  if (patch.response !== undefined) {
    const check = validateResponse(patch.response);
    if (!check.ok) return check;
    next.response = check.value;
  }

  if (patch.description !== undefined) {
    const check = validateDescription(patch.description);
    if (!check.ok) return check;
    next.description = check.value;
  }

  if (patch.isPublic !== undefined) next.isPublic = Boolean(patch.isPublic);
  if (patch.ephemeral !== undefined) next.ephemeral = Boolean(patch.ephemeral);
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.allowedRoleIds !== undefined) {
    next.allowedRoleIds = Array.isArray(patch.allowedRoleIds) ? patch.allowedRoleIds : [];
  }

  if (!Object.keys(next).length) {
    return { ok: true, doc, unchanged: true };
  }

  const updated = await store.update(guildId, doc.name, next);
  return { ok: true, doc: updated || { ...doc, ...next } };
}

/** Supprime une commande (son auteur, ou un administrateur du serveur). */
async function deleteCustomCommand({ guildId, userId, name, isManager = false } = {}) {
  const doc = await store.findOne(guildId, name);
  if (!doc) return { ok: false, code: 'NOT_FOUND', message: `Aucune commande \`${name}\` sur ce serveur.` };
  if (doc.ownerId !== userId && !isManager) {
    return { ok: false, code: 'FORBIDDEN', message: `\`${name}\` appartient à quelqu'un d'autre.` };
  }
  await store.remove(guildId, doc.name);
  return { ok: true, doc };
}

/** Lecture directe d'une commande (sans contrôle de droits d'usage). */
async function getByName(guildId, name) {
  if (!guildId || !normalizeName(name)) return null;
  return store.findOne(guildId, normalizeName(name));
}

/**
 * Récupère une commande prête à l'emploi, droits compris.
 */
async function getForUse({ guildId, name, userId, memberRoleIds = [] } = {}) {
  const doc = await store.findOne(guildId, normalizeName(name));
  if (!doc) return { ok: false, code: 'NOT_FOUND', message: `Aucune commande \`${name}\` sur ce serveur.` };
  if (!doc.enabled) return { ok: false, code: 'DISABLED', message: `\`${doc.name}\` est désactivée.` };
  if (!canUse(doc, { userId, memberRoleIds })) {
    return { ok: false, code: 'FORBIDDEN', message: `\`${doc.name}\` n'est pas partagée avec toi.` };
  }
  return { ok: true, doc };
}

/**
 * Exécute une commande personnalisée : anti-spam, rendu, compteur d'usage.
 * @returns {Promise<{ok:true, payload:object, ephemeral:boolean, doc:object}|{ok:false, code:string, message:string}>}
 */
async function runCustomCommand({
  doc, userId, username, displayName, memberRoleIds = [], guildName, channelId, args = '',
} = {}) {
  if (!canUse(doc, { userId, memberRoleIds })) {
    return { ok: false, code: 'FORBIDDEN', message: `\`${doc?.name ?? '?'}\` n'est pas partagée avec toi.` };
  }

  const cool = checkCooldown(userId, doc.name);
  if (!cool.ok) {
    return { ok: false, code: 'COOLDOWN', message: `Doucement ! Réessaie dans ${cool.retryIn} s.` };
  }

  const payload = buildResponsePayload(doc, {
    userId,
    username,
    displayName,
    guildName,
    channelId,
    count: (doc.usageCount || 0) + 1,
    args,
  });

  store.incrementUse(doc.guildId, doc.name).catch(() => {});

  return { ok: true, payload, ephemeral: Boolean(doc.ephemeral), doc };
}

/** Liste des commandes d'un membre + celles partagées par les autres. */
async function listCustomCommands(guildId, userId) {
  const all = await store.listByGuild(guildId);
  return {
    mine: all.filter(d => d.ownerId === userId),
    shared: all.filter(d => d.ownerId !== userId && d.isPublic),
    total: all.length,
  };
}

/** Menu d'autocomplétion pour un serveur (vos commandes d'abord). */
async function autocompleteFor(guildId, userId, focused = '', { includePrivate = false } = {}) {
  const all = await store.listByGuild(guildId);
  const visible = all.filter(d => includePrivate || d.ownerId === userId || d.isPublic);
  return suggestNames(visible, focused, { userId });
}

module.exports = {
  // constantes
  NAME_RE,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION,
  MAX_RESPONSE,
  MAX_PER_MEMBER,
  MAX_PER_GUILD,
  RUN_COOLDOWN_MS,
  PLACEHOLDERS,
  // fonctions pures
  normalizeName,
  validateName,
  validateResponse,
  validateDescription,
  renderResponse,
  canUse,
  suggestNames,
  buildResponsePayload,
  checkCooldown,
  // stockage
  getStore,
  __setStoreForTests,
  __resetCooldowns,
  // flux
  createCustomCommand,
  updateCustomCommand,
  deleteCustomCommand,
  getByName,
  getForUse,
  runCustomCommand,
  listCustomCommands,
  autocompleteFor,
};
