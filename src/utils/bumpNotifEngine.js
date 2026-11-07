'use strict';
// utils/bumpNotifEngine.js — Logique pure du système de notification (aucune dépendance Discord/DB)

const DEFAULT_TEMPLATE = 'Le cooldown de **2 heures** est écoulé pour **{serveur}** !\nUtilisez `/bump` pour remettre votre serveur en avant ! 🚀';

/**
 * Remplace les placeholders {serveur} {streak} {coins} {total} dans un message personnalisé.
 * Retourne le template par défaut si `template` est vide/null.
 */
function renderTemplate(template, vars = {}) {
  const base = template && template.trim() ? template : DEFAULT_TEMPLATE;
  return base
    .replace(/\{serveur\}/g, vars.serveur ?? 'ce serveur')
    .replace(/\{streak\}/g, String(vars.streak ?? 0))
    .replace(/\{coins\}/g, String(vars.coins ?? 0))
    .replace(/\{total\}/g, String(vars.total ?? 0));
}

/**
 * Valide une couleur hexadécimale saisie par l'utilisateur (avec ou sans #).
 * @returns {{ ok: boolean, hex?: string, error?: string }}
 */
function validateHexColor(input) {
  const clean = String(input || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return { ok: false, error: 'La couleur doit être un code hexadécimal à 6 caractères (ex: FEE75C).' };
  }
  return { ok: true, hex: clean.toUpperCase() };
}

/**
 * Détermine le salon effectif de notification : le salon dédié s'il est défini,
 * sinon le salon de bump par défaut du serveur.
 */
function resolveNotifChannelId(notifConfig, server) {
  return notifConfig?.notifChannelId || server?.bumpChannelId || null;
}

module.exports = { DEFAULT_TEMPLATE, renderTemplate, validateHexColor, resolveNotifChannelId };
