'use strict';
// utils/mpRequestEngine.js — Logique pure du système "Demande de MP"

/**
 * Génère le nom du fil à partir du template, en respectant la limite Discord (100 car.).
 */
function renderThreadName(template, username) {
  const name = String(template || '💬 Demande de {username}').replace(/\{username\}/g, username);
  return name.slice(0, 100);
}

/**
 * Prépare le texte à afficher dans l'embed à partir du message original.
 * Gère le cas d'un message sans texte (uniquement des pièces jointes).
 */
function buildRequestSummary(content, attachmentCount = 0) {
  const trimmed = (content || '').trim();
  if (trimmed) return trimmed.slice(0, 4000);
  if (attachmentCount > 0) return `*(Message sans texte — ${attachmentCount} pièce(s) jointe(s))*`;
  return '*(Message vide)*';
}

/**
 * Détermine la personne visée par une demande, à partir des IDs mentionnés dans le message.
 * Règles : au moins une mention requise, on ne peut pas se mentionner soi-même, ni mentionner
 * le bot. Si plusieurs personnes sont mentionnées, seule la première (valide) est retenue.
 *
 * @param {string[]} mentionedUserIds - IDs des utilisateurs mentionnés (dans l'ordre du message)
 * @param {string} authorId
 * @param {string} botId
 * @returns {{ ok: boolean, targetId?: string, error?: 'no_mention'|'self_mention'|'bot_mention' }}
 */
function pickTarget(mentionedUserIds, authorId, botId) {
  const candidates = (mentionedUserIds || []).filter(id => id !== botId);

  if (candidates.length === 0) {
    if ((mentionedUserIds || []).includes(botId) && mentionedUserIds.length > 0) {
      return { ok: false, error: 'bot_mention' };
    }
    return { ok: false, error: 'no_mention' };
  }

  const validTarget = candidates.find(id => id !== authorId);
  if (!validTarget) return { ok: false, error: 'self_mention' };

  return { ok: true, targetId: validTarget };
}

module.exports = { renderThreadName, buildRequestSummary, pickTarget };
