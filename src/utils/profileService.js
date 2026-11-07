'use strict';
// utils/profileService.js — Accès aux données du profil utilisateur.
//
// Tout ce qui touche à la base est ici, pour que la commande et le panel
// restent de simples assembleurs de vues. Les statistiques affichées ne sont
// jamais recopiées dans le document de profil : elles sont relues à chaque
// affichage, donc la carte ne peut pas mentir ni vieillir.

const UserProfile = require('../models/UserProfile');
const ProfileCustom = require('../models/ProfileCustom');
const { Badge, UserBadge } = require('../models/Badge');
const XP = require('../models/XP');
const User = require('../models/User');
const Balance = require('../models/Balance');
const VoiceStats = require('../models/VoiceStats');
const CasinoProfile = require('../models/CasinoProfile');
const Invite = require('../models/Invite');
const profileBadges = require('./profileBadges');

const MAX_PINNED = 6;
const VISIBILITIES = ['public', 'serveur', 'prive'];

const EMPTY_STATS = Object.freeze({
  level: 0, xp: 0, totalXp: 0,
  messages: 0, voiceSeconds: 0,
  bumps: 0, streak: 0, invites: 0,
  coins: 0, casinoGames: 0, casinoWins: 0, jackpots: 0,
  memberDays: 0, isBooster: false, isStaff: false, isOwner: false,
});

/** Valeurs par défaut d'un profil jamais créé (aucune écriture en base). */
function defaultProfile(userId, guildId) {
  return {
    userId,
    guildId,
    title: '',
    bio: '',
    color: null,
    bannerUrl: null,
    pinnedBadges: [],
    showBadges: true,
    visibility: 'serveur',
    views: 0,
    createdAt: null,
    updatedAt: null,
    exists: false,
  };
}

function toPlain(doc, userId, guildId) {
  if (!doc) return defaultProfile(userId, guildId);
  const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    userId: raw.userId,
    guildId: raw.guildId,
    title: raw.title || '',
    bio: raw.bio || '',
    color: raw.color || null,
    bannerUrl: raw.bannerUrl || null,
    pinnedBadges: Array.isArray(raw.pinnedBadges) ? raw.pinnedBadges : [],
    showBadges: raw.showBadges !== false,
    visibility: VISIBILITIES.includes(raw.visibility) ? raw.visibility : 'serveur',
    views: Number(raw.views) || 0,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    exists: true,
  };
}

// ─── Nettoyage des entrées ───────────────────────────────────────────────────

function cleanText(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

const sanitizeTitle = value => cleanText(value, 48);
const sanitizeBio = value => String(value ?? '').replace(/\r/g, '').trim().slice(0, 240);

function sanitizeColor(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const hex = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : undefined;
}

function sanitizeBanner(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return /^https?:\/\/\S+$/i.test(raw) && raw.length <= 512 ? raw : undefined;
}

const sanitizeVisibility = value => (VISIBILITIES.includes(value) ? value : 'serveur');

function sanitizePinned(ids, allowedIds) {
  const allowed = new Set(allowedIds || []);
  const result = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const value = String(id);
    if (allowed.size && !allowed.has(value)) continue;
    if (result.includes(value)) continue;
    result.push(value);
    if (result.length >= MAX_PINNED) break;
  }
  return result;
}

/** Un profil privé n'est visible que par son propriétaire. */
function canView(profile, viewerId, ownerId) {
  if (!profile) return true;
  if (viewerId && ownerId && viewerId === ownerId) return true;
  return profile.visibility !== 'prive';
}

// ─── Lecture ────────────────────────────────────────────────────────────────

async function getProfile(guildId, userId) {
  if (!guildId || !userId) return defaultProfile(userId, guildId);
  const doc = await UserProfile.findOne({ guildId, userId }).catch(() => null);
  return toPlain(doc, userId, guildId);
}

async function getProfileDoc(guildId, userId) {
  return UserProfile.findOne({ guildId, userId }).catch(() => null);
}

/** Rassemble toutes les statistiques réelles du membre sur ce serveur. */
async function gatherStats({ guildId, userId, guild, member }) {
  const safe = (promise) => Promise.resolve(promise).catch(() => null);

  const [xp, user, balance, voice, casino, invites, owned] = await Promise.all([
    safe(XP.findOne({ guildId, userId })),
    safe(User.findOne({ guildId, userId })),
    safe(Balance.findOne({ guildId, userId })),
    safe(VoiceStats.findOne({ guildId, userId })),
    safe(CasinoProfile.findOne({ guildId, userId })),
    safe(Invite.find({ guildId, createdBy: userId })),
    safe(UserBadge.find({ guildId, userId })),
  ]);

  const inviteUses = (Array.isArray(invites) ? invites : [])
    .reduce((sum, inv) => sum + (Number(inv.uses) || 0), 0);

  let customBadges = [];
  const ownedIds = (Array.isArray(owned) ? owned : []).map(o => o.badgeId).filter(Boolean);
  if (ownedIds.length) {
    const catalog = await safe(Badge.find({ guildId, badgeId: { $in: ownedIds } }));
    customBadges = (Array.isArray(catalog) ? catalog : []).map((badge) => {
      const raw = typeof badge.toObject === 'function' ? badge.toObject() : badge;
      const ownedInfo = (owned || []).find(o => o.badgeId === raw.badgeId);
      return {
        badgeId: raw.badgeId,
        name: raw.name,
        emoji: raw.emoji,
        description: raw.description,
        color: raw.color,
        earnedAt: ownedInfo?.earnedAt || null,
      };
    });
  }

  const joinedAt = member?.joinedTimestamp || null;
  const memberDays = joinedAt ? Math.max(0, Math.floor((Date.now() - joinedAt) / 86_400_000)) : 0;
  const permissions = member?.permissions;
  const isStaff = Boolean(
    permissions && (permissions.has('ManageGuild') || permissions.has('ModerateMembers') || permissions.has('Administrator')),
  );

  const stats = {
    ...EMPTY_STATS,
    level: Number(xp?.level) || 0,
    xp: Number(xp?.xp) || 0,
    totalXp: Number(xp?.totalXp) || 0,
    messages: Number(xp?.messages) || 0,
    voiceSeconds: Number(voice?.totalSeconds) || 0,
    bumps: Number(user?.bumps) || 0,
    streak: Number(user?.streak) || 0,
    invites: inviteUses,
    coins: Number(balance?.coins) || 0,
    casinoGames: Number(casino?.gamesPlayed) || 0,
    casinoWins: Number(casino?.wins) || 0,
    jackpots: Number(casino?.jackpotsWon) || 0,
    memberDays,
    isBooster: Boolean(member?.premiumSince),
    isStaff,
    isOwner: Boolean(guild && guild.ownerId && guild.ownerId === userId),
  };

  return { stats, customBadges };
}

/**
 * Charge tout ce qu'il faut pour afficher un profil : document, stats, badges.
 * `visible: false` quand le profil est privé et que le visiteur n'est pas le
 * propriétaire (les données sont alors volontairement absentes).
 */
async function loadProfileView({ guildId, userId, guild, member, viewerId }) {
  const profile = await getProfile(guildId, userId);
  if (!canView(profile, viewerId, userId)) {
    return { visible: false, profile, stats: null, badges: [], showcase: [], next: [], customBadges: [] };
  }

  const { stats, customBadges } = await gatherStats({ guildId, userId, guild, member });
  const badges = profileBadges.evaluate(stats, customBadges);
  return {
    visible: true,
    profile,
    stats,
    customBadges,
    badges,
    showcase: profile.showBadges ? profileBadges.showcase(badges, profile.pinnedBadges, 8) : [],
    next: profileBadges.nextUp(badges, 3),
    earned: profileBadges.earned(badges).length,
  };
}

// ─── Écriture ───────────────────────────────────────────────────────────────

/**
 * Enregistre les champs fournis. Les valeurs invalides renvoient `{ ok:false }`
 * plutôt que d'écrire quelque chose de douteux en base.
 */
async function saveProfile(guildId, userId, patch = {}, { allowedBadgeIds = null } = {}) {
  const update = {};

  if (Object.prototype.hasOwnProperty.call(patch, 'title')) update.title = sanitizeTitle(patch.title);
  if (Object.prototype.hasOwnProperty.call(patch, 'bio')) update.bio = sanitizeBio(patch.bio);

  if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
    const color = sanitizeColor(patch.color);
    if (color === undefined) return { ok: false, field: 'color', reason: 'Format attendu : #RRGGBB' };
    update.color = color;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'bannerUrl')) {
    const banner = sanitizeBanner(patch.bannerUrl);
    if (banner === undefined) return { ok: false, field: 'bannerUrl', reason: 'URL invalide (http(s)://…, 512 caractères max)' };
    update.bannerUrl = banner;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'visibility')) {
    update.visibility = sanitizeVisibility(patch.visibility);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'showBadges')) {
    update.showBadges = Boolean(patch.showBadges);
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'pinnedBadges')) {
    update.pinnedBadges = sanitizePinned(patch.pinnedBadges, allowedBadgeIds);
  }

  if (!Object.keys(update).length) return { ok: true, profile: await getProfile(guildId, userId), unchanged: true };

  const doc = await UserProfile.findOneAndUpdate(
    { guildId, userId },
    { $set: update, $setOnInsert: { guildId, userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // La carte « bump » historique lit ProfileCustom : on la garde alignée pour
  // que le style choisi dans le panel s'applique aussi là-bas.
  const legacy = {};
  if ('color' in update) legacy.accentColor = update.color || null;
  if ('bannerUrl' in update) legacy.bannerUrl = update.bannerUrl;
  if ('showBadges' in update) legacy.showBadges = update.showBadges;
  if (Object.keys(legacy).length) {
    await ProfileCustom.findOneAndUpdate(
      { userId, guildId },
      { $set: legacy, $setOnInsert: { userId, guildId } },
      { upsert: true, setDefaultsOnInsert: true },
    ).catch(() => null);
  }

  return { ok: true, profile: toPlain(doc, userId, guildId) };
}

async function deleteProfile(guildId, userId) {
  const res = await UserProfile.deleteOne({ guildId, userId }).catch(() => null);
  return { ok: true, deleted: Number(res?.deletedCount) > 0 };
}

async function addView(guildId, userId) {
  await UserProfile.updateOne({ guildId, userId }, { $inc: { views: 1 } }).catch(() => null);
}

module.exports = {
  MAX_PINNED,
  VISIBILITIES,
  defaultProfile,
  toPlain,
  sanitizeTitle,
  sanitizeBio,
  sanitizeColor,
  sanitizeBanner,
  sanitizeVisibility,
  sanitizePinned,
  canView,
  getProfile,
  getProfileDoc,
  gatherStats,
  loadProfileView,
  saveProfile,
  deleteProfile,
  addView,
};
