'use strict';
// utils/guildBrand.js — Identité visuelle par serveur.
//
// Discord permet à un bot d'avoir un PROFIL DE MEMBRE différent par serveur :
// avatar, bannière et surnom. Le bot peut donc personnaliser, pour chaque
// serveur :
//   • son surnom, son avatar et sa bannière de profil serveur via
//     `guild.members.editMe()` (le vrai affichage serveur, pas un webhook) ;
//   • le nom, la couleur, le pied de page et la bannière de ses embeds.
//
// Le module est volontairement sans dépendance à brand.js (qui l'utilise) pour
// éviter tout cycle. Le contexte courant est porté par AsyncLocalStorage : les
// handlers d'interaction et de message l'ouvrent une fois, et applyBrand()
// n'a plus qu'à lire le cache — aucun await dans le rendu.

const { AsyncLocalStorage } = require('async_hooks');
const { EmbedBuilder } = require('discord.js');
const { createBoundedCache } = require('./boundedCache');
const GuildBrand = require('../models/GuildBrand');
const nicknameStyle = require('./nicknameStyle');

const CACHE_TTL_MS = 60_000;
const MAX_URL = 512;
const MAX_TEXT = 120;

const DEFAULT_BRAND = Object.freeze({
  guildId: null,
  enabled: false,
  displayName: null,
  emoji: null,
  nickname: null,
  nicknameFont: 'classique',
  nicknameEffect: 'uni',
  nicknamePalette: 'none',
  nicknameWrap: 'none',
  nicknameRoleId: null,
  avatarUrl: null,
  bannerUrl: null,
  color: null,
  footerText: null,
  bannerMode: 'missing',
  replaceAuthor: true,
  replaceFooter: true,
  avatarThumbnail: false,
  updatedBy: null,
  updatedAt: null,
});

const BANNER_MODES = ['off', 'missing', 'always'];
const storage = new AsyncLocalStorage();
// guildId -> { cfg, at }. CACHE BORNÉ : l'identité est lue à chaque message et
// sur chaque interaction ; une Map nue gardait une entrée par serveur à vie.
const cache = createBoundedCache({ max: 20_000, ttl: 0, name: 'guild-brand' });

// ─── Validation / normalisation ─────────────────────────────────────────────

/** '#8B1A1A', '8B1A1A' ou '0x8B1A1A' → entier Discord, sinon null. */
function parseHexColor(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null;
  const full = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw;
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? n : null;
}

/** URL http(s) raisonnable, ou null. */
function sanitizeUrl(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.length > MAX_URL) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    return raw;
  } catch {
    return null;
  }
}

const MAX_ONELINE = 16;

/** Emoji signature : 1 à 16 caractères, sans espace (sinon ce n'est pas un emoji). */
function cleanEmoji(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, '').trim();
  if (!text) return null;
  if (/\s/.test(String(value).trim())) return null;
  return text.slice(0, MAX_ONELINE);
}

function sanitizeText(value, max = MAX_TEXT) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeBannerMode(value) {
  const mode = String(value || '').toLowerCase();
  return BANNER_MODES.includes(mode) ? mode : 'missing';
}

/** Document Mongo (ou null) → objet complet, jamais undefined. */
function normalizeDoc(doc, guildId = null) {
  const source = doc || {};
  return {
    ...DEFAULT_BRAND,
    ...source,
    guildId: source.guildId || guildId,
    enabled: Boolean(source.enabled),
    displayName: source.displayName || null,
    emoji: cleanEmoji(source.emoji),
    nickname: source.nickname || null,
    nicknameFont: nicknameStyle.fontByKey(source.nicknameFont)?.key || 'classique',
    nicknameEffect: nicknameStyle.effectByKey(source.nicknameEffect)?.key || 'uni',
    nicknamePalette: nicknameStyle.paletteByKey(source.nicknamePalette)?.key || 'none',
    nicknameWrap: nicknameStyle.wrapByKey(source.nicknameWrap)?.key || 'none',
    nicknameRoleId: source.nicknameRoleId || null,
    avatarUrl: source.avatarUrl || null,
    bannerUrl: source.bannerUrl || null,
    color: source.color || null,
    footerText: source.footerText || null,
    bannerMode: normalizeBannerMode(source.bannerMode),
    replaceAuthor: source.replaceAuthor !== false,
    replaceFooter: source.replaceFooter !== false,
    avatarThumbnail: source.avatarThumbnail === true,
    updatedAt: source.updatedAt || null,
  };
}

/**
 * Valide un patch venu d'un modal. Renvoie { ok, patch, error }.
 * Un champ absent n'est pas modifié ; une chaîne vide efface le champ.
 */
function validatePatch(input = {}) {
  const patch = {};
  const has = key => Object.prototype.hasOwnProperty.call(input, key);

  if (has('displayName')) {
    const value = String(input.displayName ?? '').trim();
    if (value && value.length < 2) return { ok: false, error: 'Le nom doit faire au moins 2 caractères.' };
    if (value.length > 32) return { ok: false, error: 'Le nom ne peut pas dépasser 32 caractères.' };
    patch.displayName = value || null;
  }

  if (has('nickname')) {
    const value = String(input.nickname ?? '').trim();
    if (value.length > 32) return { ok: false, error: 'Le surnom ne peut pas dépasser 32 caractères.' };
    patch.nickname = value || null;
  }

  // Style du surnom : valeurs validées contre les catalogues (police / effet /
  // palette). Une valeur inconnue est refusée plutôt que silencieusement gardée.
  for (const [key, catalog, label] of [
    ['nicknameFont', nicknameStyle.FONTS, 'police'],
    ['nicknameEffect', nicknameStyle.EFFECTS, 'effet'],
    ['nicknamePalette', nicknameStyle.PALETTES, 'couleur'],
    ['nicknameWrap', nicknameStyle.WRAPS, 'finition'],
  ]) {
    if (!has(key)) continue;
    const value = String(input[key] ?? '').toLowerCase();
    if (!catalog.some(entry => entry.key === value)) {
      return { ok: false, error: `Cette ${label} n'existe pas. Choisis-la dans le panneau /branding.` };
    }
    patch[key] = value;
  }

  for (const key of ['avatarUrl', 'bannerUrl']) {
    if (!has(key)) continue;
    const raw = String(input[key] ?? '').trim();
    if (!raw) { patch[key] = null; continue; }
    const clean = sanitizeUrl(raw);
    if (!clean) return { ok: false, error: 'L’URL doit commencer par http:// ou https:// et rester valide.' };
    patch[key] = clean;
  }

  if (has('color')) {
    const raw = String(input.color ?? '').trim();
    if (!raw) patch.color = null;
    else {
      const n = parseHexColor(raw);
      if (n === null) return { ok: false, error: 'Couleur invalide : utilise un code hexadécimal (#8B1A1A).' };
      patch.color = `#${n.toString(16).toUpperCase().padStart(6, '0')}`;
    }
  }

  if (has('footerText')) {
    const text = String(input.footerText ?? '').replace(/\s+/g, ' ').trim();
    if (text.length > MAX_TEXT) return { ok: false, error: `Le pied de page ne peut pas dépasser ${MAX_TEXT} caractères.` };
    patch.footerText = text || null;
  }

  if (has('emoji')) {
    const raw = String(input.emoji ?? '').trim();
    if (!raw) patch.emoji = null;
    else {
      const clean = cleanEmoji(raw);
      if (!clean) return { ok: false, error: 'L’emoji signature doit être un seul emoji, sans espace.' };
      patch.emoji = clean;
    }
  }

  if (has('bannerMode')) patch.bannerMode = normalizeBannerMode(input.bannerMode);
  for (const key of ['replaceAuthor', 'replaceFooter', 'avatarThumbnail', 'enabled']) {
    if (has(key)) patch[key] = Boolean(input[key]);
  }

  return { ok: true, patch };
}

// ─── Cache + contexte ───────────────────────────────────────────────────────

async function prime(guildId, { force = false, now = Date.now() } = {}) {
  if (!guildId) return normalizeDoc(null, guildId);
  const hit = cache.get(guildId);
  if (!force && hit && now - hit.at < CACHE_TTL_MS) return hit.cfg;

  let doc = null;
  try {
    doc = await GuildBrand.findOne({ guildId }).lean();
  } catch {
    // Base momentanément indisponible : on rend l'identité par défaut, jamais
    // une exception au milieu d'un message.
  }
  const cfg = normalizeDoc(doc, guildId);

  // L'identité est un privilège de licence ACTIVE, pas d'essai. La vérification
  // est faite ici (et non seulement dans la commande) pour qu'une licence
  // expirée ou révoquée coupe aussi le rendu, même si la config reste en base.
  if (cfg.enabled) {
    try {
      const licenseGate = require('./licenseGate');
      const status = await licenseGate.getLicenseStatus(guildId);
      // La période de grâce reste un accès ouvert : on ne coupe pas l'identité
      // du serveur à la seconde où la licence expire.
      if (status.status !== 'active' && status.status !== 'grace') cfg.enabled = false;
    } catch {
      cfg.enabled = false;
    }
  }

  cache.set(guildId, { cfg, at: now });
  return cfg;
}

function getContext() {
  return storage.getStore() || null;
}

function runWith(guildId, client, fn) {
  if (!guildId) return fn();
  return storage.run({ guildId: String(guildId), client }, fn);
}

function getCachedConfig(guildId = null) {
  const id = guildId || getContext()?.guildId;
  if (!id) return null;
  return cache.get(String(id))?.cfg || null;
}

function setCachedConfig(cfg) {
  if (!cfg?.guildId) return null;
  const normalized = normalizeDoc(cfg);
  cache.set(String(cfg.guildId), { cfg: normalized, at: Date.now() });
  return normalized;
}

function invalidate(guildId) {
  if (guildId) cache.delete(String(guildId));
  else cache.clear();
}

async function saveBrand(guildId, patch, userId = null) {
  const clean = { ...patch };
  if (userId) clean.updatedBy = userId;
  clean.updatedAt = new Date();
  const doc = await GuildBrand.findOneAndUpdate(
    { guildId },
    { $set: clean, $setOnInsert: { guildId } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  const cfg = setCachedConfig(doc);
  return cfg;
}

// ─── Application aux réponses d'interaction ─────────────────────────────────
// Les commandes qui construisent un EmbedBuilder à la main ne passent pas par
// utils/embeds. On enveloppe donc les méthodes de réponse de l'interaction
// courante (localement, pas le prototype Discord.js) : tout embed envoyé par
// cette interaction hérite du branding, sans toucher aux messages destinés à
// d'autres serveurs.
const patched = new WeakSet();

function brandPayload(payload, cfg) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (!Array.isArray(payload.embeds) || !payload.embeds.length) return payload;

  const embeds = payload.embeds.map((entry) => {
    if (!entry) return entry;
    if (typeof entry.setColor === 'function') {
      applyBrandToEmbed(entry, cfg);
      return entry;
    }
    try {
      const built = EmbedBuilder.from(entry);
      applyBrandToEmbed(built, cfg);
      return built;
    } catch {
      return entry;
    }
  });

  return { ...payload, embeds };
}

/** Enveloppe reply/editReply/followUp/update pour cette interaction seulement. */
function patchInteraction(interaction, cfg) {
  if (!interaction || !cfg?.enabled || patched.has(interaction)) return interaction;
  patched.add(interaction);

  for (const method of ['reply', 'editReply', 'followUp', 'update']) {
    const original = interaction[method];
    if (typeof original !== 'function') continue;
    interaction[method] = function brandedResponse(payload, ...rest) {
      return original.call(this, brandPayload(payload, cfg), ...rest);
    };
  }
  return interaction;
}

// ─── Application aux embeds ─────────────────────────────────────────────────

function isBrandAuthor(name) {
  return !name || /^REZO\b/i.test(String(name));
}

/**
 * Applique l'identité du serveur à un EmbedBuilder existant.
 * Ne casse jamais un embed : chaque champ est optionnel et les protections
 * (replaceAuthor / replaceFooter / bannerMode) évitent d'écraser un contenu
 * légitime.
 */
function applyBrandToEmbed(embed, cfg) {
  if (!embed || typeof embed.setColor !== 'function') return embed;
  if (!cfg?.enabled) return embed;

  const color = parseHexColor(cfg.color);
  if (color !== null) embed.setColor(color);

  const author = embed.data?.author;
  // L'emoji signature fait partie du nom affiché : « Nom 🎲 ».
  const emoji = cfg.enabled ? cleanEmoji(cfg.emoji) : null;
  const baseName = cfg.displayName || author?.name || 'REZO';
  const desiredName = emoji && !String(baseName).includes(emoji) ? `${baseName} ${emoji}` : baseName;
  const authorAllowed = !author || cfg.replaceAuthor || isBrandAuthor(author.name);
  if (authorAllowed && (cfg.displayName || cfg.avatarUrl || emoji)) {
    const data = { name: desiredName };
    if (cfg.avatarUrl) data.iconURL = cfg.avatarUrl;
    embed.setAuthor(data);
  }

  if (cfg.bannerUrl && cfg.bannerMode !== 'off') {
    const hasImage = Boolean(embed.data?.image?.url);
    if (cfg.bannerMode === 'always' || !hasImage) embed.setImage(cfg.bannerUrl);
  }

  if (cfg.avatarThumbnail && cfg.avatarUrl && !embed.data?.thumbnail?.url) {
    embed.setThumbnail(cfg.avatarUrl);
  }

  const desiredFooter = cfg.footerText || cfg.displayName || null;
  const footer = embed.data?.footer;
  const footerAllowed = !footer || cfg.replaceFooter || isBrandAuthor(footer.text || footer.name);
  if (desiredFooter && footerAllowed) {
    const data = { text: desiredFooter };
    if (cfg.avatarUrl) data.iconURL = cfg.avatarUrl;
    embed.setFooter(data);
  }

  return embed;
}

/** Embed d'aperçu, construit avec les mêmes règles que les vrais messages. */
function buildPreviewEmbed(cfg, guildName = 'ce serveur') {
  const embed = new EmbedBuilder()
    .setTitle(`${cfg.displayName || 'REZO'} • Aperçu`)
    .setDescription(
      `Voici comment **${cfg.displayName || 'REZO'}** apparaît sur **${guildName}**.\n\n`
      + 'Le nom d’affichage, l’avatar, la bannière, la couleur et le pied de page '
      + 's’appliquent aux embeds du bot. Le surnom du bot est réellement propre à ce serveur.',
    )
    .setColor(parseHexColor(cfg.color) ?? 0x8B1A1A)
    .setTimestamp();

  applyBrandToEmbed(embed, { ...cfg, enabled: true });
  return embed;
}

// ─── Profil de membre : avatar, bannière et surnom par serveur ───────────────

/**
 * Applique le profil serveur du bot via `guild.members.editMe()`.
 * C'est le vrai affichage serveur Discord (avatar, bannière, surnom), pas un
 * webhook. Désactiver l'identité remet les trois champs à null (profil global).
 *
 * @returns {Promise<{ok:boolean, reason?:string, error?:string, profile?:object}>}
 */
async function applyServerProfile(guild, cfg) {
  const members = guild?.members;
  if (!members) return { ok: false, reason: 'missing_member' };
  // `editMe()` = PATCH /guilds/{guild.id}/members/@me : le profil du bot PROPRE
  // au serveur. Aucun passage par l'avatar global de l'application ni par un
  // webhook. Disponible depuis discord.js 14.17.
  if (typeof members.editMe !== 'function') return { ok: false, reason: 'unsupported' };

  const enabled = Boolean(cfg?.enabled);
  // Le pseudo est transformé par le style choisi (police + effet). Sans surnom
  // configuré, on ne touche pas au pseudo : le profil global reste affiché.
  const styledNick = enabled && cfg.nickname
    ? nicknameStyle.renderNickname({ ...cfg, nickname: cfg.nickname })
    : null;

  const profile = {
    nick: styledNick,
    avatar: enabled ? (cfg.avatarUrl || null) : null,
    banner: enabled ? (cfg.bannerUrl || null) : null,
    reason: 'Identité visuelle par serveur (REZO)',
  };

  try {
    await members.editMe(profile);
  } catch (err) {
    const code = err?.code ?? null;
    const text = String(err?.message || '');
    // 50035 couvre aussi un pseudo stylé refusé (trop long / glyphe refusé) :
    // on ne parle d'image que si une image était effectivement transmise.
    const sentImage = Boolean(profile.avatar || profile.banner);
    const reason = code === 50013 || /permission/i.test(text) ? 'permission'
      : (code === 50035 || /invalid form body/i.test(text)) ? (sentImage ? 'invalid_image' : 'invalid_nick')
      : code === 429 || /rate limit/i.test(text) ? 'rate_limit'
      : 'unknown';
    return { ok: false, reason, error: err.message, code };
  }

  // Couleur du pseudo : la seule réellement rendue par Discord vient d'un rôle.
  const gradient = await applyNicknameStyleRole(guild, enabled ? cfg : { nicknamePalette: 'none', nicknameRoleId: cfg?.nicknameRoleId });
  return { ok: true, profile, nick: styledNick, gradient };
}

// ─── Couleur du pseudo (rôle dégradé) ───────────────────────────────────────
// Discord colore un pseudo avec le rôle coloré le plus haut du membre. Un
// dégradé nécessite les « styles de rôle améliorés » (role colors : primary /
// secondary), débloqués par les boosts du serveur. Si Discord refuse, on
// retombe proprement sur une couleur unie plutôt que d'échouer.
const STYLE_ROLE_NAME = 'REZO • Style';

async function removeStyleRole(guild, cfg = {}) {
  const roleId = cfg.nicknameRoleId;
  if (!roleId) return { ok: true, mode: 'none', roleId: null };
  const role = guild?.roles?.cache?.get?.(roleId) || null;
  const me = guild?.members?.me;
  try {
    if (role && me?.roles?.remove) await me.roles.remove(role).catch(() => {});
  } catch { /* le rôle a peut-être déjà disparu */ }
  try {
    if (role && typeof role.delete === 'function') await role.delete().catch(() => {});
  } catch { /* suppression facultative */ }
  return { ok: true, mode: 'none', roleId: null };
}

/**
 * Applique la palette choisie au pseudo du bot.
 * @param {object} guild
 * @param {object} cfg identité du serveur (nicknamePalette + nicknameRoleId)
 * @returns {Promise<{ok:boolean, mode:'gradient'|'solid'|'none', roleId?:string|null, reason?:string, error?:string}>}
 */
async function applyNicknameStyleRole(guild, cfg = {}) {
  const palette = nicknameStyle.activePalette(cfg);
  if (!palette) return removeStyleRole(guild, cfg);

  const roles = guild?.roles;
  const me = guild?.members?.me;
  if (!me?.roles || typeof roles?.create !== 'function') {
    return { ok: false, mode: 'none', reason: 'unsupported' };
  }

  let role = cfg.nicknameRoleId ? roles.cache?.get?.(cfg.nicknameRoleId) : null;
  if (!role) {
    const base = {
      name: STYLE_ROLE_NAME,
      hoist: false,
      mentionable: false,
      permissions: [],
      reason: 'Couleur du pseudo du bot (REZO)',
    };
    try {
      role = await roles.create({
        ...base,
        colors: { primaryColor: palette.primary, secondaryColor: palette.secondary, tertiaryColor: null },
      });
    } catch (err) {
      // Dégradé refusé (styles de rôle non débloqués) → rôle uni.
      try {
        role = await roles.create({ ...base, color: palette.primary });
      } catch (err2) {
        const reason = (err2?.code === 50013 || /permission/i.test(String(err2?.message))) ? 'permission' : 'unknown';
        return { ok: false, mode: 'none', reason, error: err2?.message };
      }
    }
  }

  // Le rôle doit être le plus haut rôle COLORÉ du bot : Discord le place à la
  // création tout en bas, donc on le remonte juste sous le rôle géré du bot
  // (on ne peut pas aller au-dessus de son propre rôle le plus haut).
  const highest = me.roles.highest;
  if (highest && typeof role.setPosition === 'function' && typeof highest.position === 'number') {
    const target = Math.max(1, highest.position - 1);
    if (role.position !== target) {
      try {
        await role.setPosition(target, { reason: 'Couleur du pseudo du bot (REZO)' });
      } catch { /* la couleur peut fonctionner sans remontée */ }
    }
  }

  let mode = 'gradient';
  try {
    await role.setColors({ primaryColor: palette.primary, secondaryColor: palette.secondary, tertiaryColor: null });
  } catch {
    mode = 'solid';
    await role.setColors({ primaryColor: palette.primary, secondaryColor: null, tertiaryColor: null }).catch(() => {});
  }

  try {
    await me.roles.add(role);
  } catch (err) {
    const reason = (err?.code === 50013 || /permission/i.test(String(err?.message))) ? 'permission' : 'unknown';
    return { ok: false, mode, roleId: role.id, reason, error: err?.message };
  }

  return { ok: true, mode, roleId: role.id };
}

/**
 * Applique UNIQUEMENT le pseudo du bot (style + couleur), sans toucher au reste
 * de l'identité visuelle (avatar, bannière, embeds). C'est le chemin utilisé
 * par l'écran « Style du pseudo » : le style doit fonctionner même quand
 * l'identité globale n'est pas activée.
 *
 * @param {object} guild
 * @param {object} cfg
 * @returns {Promise<{ok:boolean, nick?:string|null, gradient?:object, reason?:string, error?:string}>}
 */
async function applyNicknameOnly(guild, cfg = {}) {
  const members = guild?.members;
  if (!members) return { ok: false, reason: 'missing_member' };
  if (typeof members.editMe !== 'function') return { ok: false, reason: 'unsupported' };

  // On ne stylise qu'un surnom (ou un nom d'affichage) réellement choisi :
  // écrire « REZO » à la place du nom de l'application serait une surprise.
  const source = cfg.nickname || cfg.displayName || null;
  if (!source) return { ok: false, reason: 'no_source' };
  const nick = nicknameStyle.renderNickname({ ...cfg, nickname: source });

  try {
    await members.editMe({ nick, reason: 'Style du pseudo (REZO)' });
  } catch (err) {
    const code = err?.code ?? null;
    const text = String(err?.message || '');
    const reason = code === 50013 || /permission/i.test(text) ? 'permission'
      : code === 50035 || /invalid form body/i.test(text) ? 'invalid_nick'
      : code === 429 || /rate limit/i.test(text) ? 'rate_limit'
      : 'unknown';
    return { ok: false, reason, error: err.message, code };
  }

  const gradient = await applyNicknameStyleRole(guild, cfg);
  return { ok: true, nick, gradient };
}

/**
 * Diagnostic du style sur un serveur réel : ce qui est stocké, ce qui est
 * appliqué, et ce qui empêche éventuellement le rendu (rôle absent, boost).
 * Sert à expliquer pourquoi un dégradé ne s'affiche pas comme prévu.
 */
async function collectStyleStatus(guild, cfg = {}) {
  const me = guild?.members?.me;
  const palette = nicknameStyle.activePalette(cfg);
  const role = cfg.nicknameRoleId ? guild?.roles?.cache?.get?.(cfg.nicknameRoleId) : null;
  const source = cfg.nickname || cfg.displayName || 'REZO';
  const expectedNick = nicknameStyle.renderNickname({ ...cfg, nickname: source });

  return {
    palette: palette?.key || null,
    wrap: cfg.nicknameWrap === 'pastilles' ? 'pastilles' : 'none',
    roleFound: Boolean(role),
    roleAssigned: Boolean(role && me?.roles?.cache?.has?.(role.id)),
    rolePosition: role?.position ?? null,
    botRolePosition: me?.roles?.highest?.position ?? null,
    canManageRoles: me?.permissions?.has?.('ManageRoles') ?? null,
    canChangeNickname: me?.permissions?.has?.('ManageNicknames') ?? null,
    premiumTier: guild?.premiumTier ?? 0,
    boosts: guild?.premiumSubscriptionCount ?? null,
    currentNick: me?.nickname ?? null,
    expectedNick,
  };
}

/** Compatibilité : ancien nom utilisé par les appels existants. */
const applyNickname = applyServerProfile;

module.exports = {
  DEFAULT_BRAND,
  BANNER_MODES,
  CACHE_TTL_MS,
  parseHexColor,
  sanitizeUrl,
  sanitizeText,
  normalizeBannerMode,
  normalizeDoc,
  validatePatch,
  prime,
  getContext,
  runWith,
  getCachedConfig,
  setCachedConfig,
  invalidate,
  saveBrand,
  applyBrandToEmbed,
  brandPayload,
  patchInteraction,
  buildPreviewEmbed,
  applyServerProfile,
  applyNickname,
  applyNicknameOnly,
  collectStyleStatus,
  STYLE_ROLE_NAME,
  applyNicknameStyleRole,
  removeStyleRole,
};
