'use strict';
// utils/siteUrl.js — L'URL publique du site, en un seul endroit.
//
// Le bot et le site partagent la même adresse publique : elle est donc lue
// ici, et nulle part ailleurs. Changer de domaine (sous-domaine gratuit,
// tunnel, nom de domaine acheté) se résume à une variable d'environnement :
//
//   SITE_URL=https://rezo.exemple.fr
//
// `STORE_PUBLIC_URL` reste accepté : c'est le nom historique, déjà utilisé par
// le site pour les retours Stripe. Aucune valeur n'est jamais écrite dans un
// fichier du dépôt, donc aucun domaine n'est figé dans le code.
//
// `FALLBACK` ne sert qu'à un déploiement sans configuration : les liens du bot
// pointent alors vers l'adresse publique historique au lieu d'un `undefined`.

const FALLBACK = 'https://zyntra.dpdns.org';

/** URL publique sans slash final, ou `FALLBACK` si rien n'est configuré. */
function siteUrl(env = process.env) {
  const raw = String(env.SITE_URL || env.STORE_PUBLIC_URL || '').trim();
  return (raw || FALLBACK).replace(/\/+$/, '');
}

/** URL absolue d'un chemin du site (`/tarifs` → `https://…/tarifs`). */
function sitePath(pathname = '/', env = process.env) {
  const suffix = String(pathname || '/');
  return `${siteUrl(env)}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

module.exports = { FALLBACK, siteUrl, sitePath };
