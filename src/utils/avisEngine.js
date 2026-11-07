'use strict';
// utils/avisEngine.js — Logique métier pure du système d'avis (aucune dépendance Discord/DB)

/**
 * Vérifie si un membre est autorisé à laisser un avis sur le serveur où il se trouve.
 * @param {{minJoinDays:number, minAccountAgeDays:number}} config
 * @param {{joinedAt:Date, accountCreatedAt:Date}} member
 * @param {Date} [now]
 */
function checkCanReview(config, member, now = new Date()) {
  const minJoin = config?.minJoinDays || 0;
  const minAge  = config?.minAccountAgeDays || 0;

  if (minJoin > 0) {
    const joinDays = (now.getTime() - new Date(member.joinedAt).getTime()) / 86_400_000;
    if (joinDays < minJoin) {
      return { ok: false, reason: 'join', joinDays: Math.floor(joinDays * 10) / 10, required: minJoin };
    }
  }
  if (minAge > 0) {
    const ageDays = (now.getTime() - new Date(member.accountCreatedAt).getTime()) / 86_400_000;
    if (ageDays < minAge) {
      return { ok: false, reason: 'age', ageDays: Math.floor(ageDays * 10) / 10, required: minAge };
    }
  }
  return { ok: true };
}

/**
 * @param {{editCooldownHours:number}} config
 * @param {Date|null} lastEditedAt
 * @param {Date} [now]
 */
function checkEditCooldown(config, lastEditedAt, now = new Date()) {
  const hours = config?.editCooldownHours || 0;
  if (hours <= 0 || !lastEditedAt) return { ok: true };
  const elapsedH = (now.getTime() - new Date(lastEditedAt).getTime()) / 3_600_000;
  if (elapsedH >= hours) return { ok: true };
  return { ok: false, remainingHours: Math.ceil(hours - elapsedH) };
}

/**
 * Vote "utile / pas utile" sur un avis — permet de changer d'avis, empêche le doublon exact.
 * Mute directement l'objet `review.helpfulUp` / `review.helpfulDown` (tableaux d'userId).
 * @returns {{changed:boolean, switched:boolean}}
 */
function applyHelpfulVote(review, userId, type) {
  review.helpfulUp = review.helpfulUp || [];
  review.helpfulDown = review.helpfulDown || [];
  const wasUp = review.helpfulUp.includes(userId);
  const wasDown = review.helpfulDown.includes(userId);
  const previous = wasUp ? 'up' : wasDown ? 'down' : null;

  if (previous === type) return { changed: false, switched: false };

  review.helpfulUp = review.helpfulUp.filter(id => id !== userId);
  review.helpfulDown = review.helpfulDown.filter(id => id !== userId);

  if (type === 'up') review.helpfulUp.push(userId);
  else review.helpfulDown.push(userId);

  return { changed: true, switched: previous !== null };
}

/**
 * @param {{count:number}} reported
 * @param {number} threshold
 */
function checkAutoHide(reported, threshold) {
  if (!threshold || threshold <= 0) return false;
  return (reported?.count || 0) >= threshold;
}

/**
 * @param {{rating:number}[]} reviews
 */
function computeAverage(reviews) {
  if (!reviews.length) return 0;
  const sum = reviews.reduce((s, r) => s + (r.rating || 0), 0);
  return Math.round((sum / reviews.length) * 10) / 10;
}

/**
 * Distribution du nombre d'avis par note (1 à 5).
 */
function computeDistribution(reviews) {
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) {
    if (dist[r.rating] !== undefined) dist[r.rating]++;
  }
  return dist;
}

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_MEDIA_PER_REVIEW = 3;

/**
 * Valide une liste de pièces jointes Discord (attachments) pour un avis.
 * N'accepte que des images (PNG/JPEG/WEBP/GIF), jusqu'à MAX_MEDIA_PER_REVIEW.
 * @param {Array<{name:string, contentType:string, url:string, size:number}|null|undefined>} attachments
 */
function validateMediaAttachments(attachments) {
  const provided = attachments.filter(Boolean);
  if (provided.length > MAX_MEDIA_PER_REVIEW) {
    return { ok: false, error: `Maximum ${MAX_MEDIA_PER_REVIEW} images par avis.` };
  }
  const urls = [];
  for (const att of provided) {
    const type = (att.contentType || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.includes(type)) {
      return { ok: false, error: `"${att.name}" n'est pas une image valide (formats acceptés : PNG, JPEG, WEBP, GIF).` };
    }
    urls.push(att.url);
  }
  return { ok: true, urls };
}

module.exports = { checkCanReview, checkEditCooldown, applyHelpfulVote, checkAutoHide, computeAverage, computeDistribution, validateMediaAttachments, ALLOWED_IMAGE_TYPES, MAX_MEDIA_PER_REVIEW };
