'use strict';
// utils/vpnEngine.js — Décision pure « cette connexion est-elle autorisée ? ».
//
// Aucune dépendance Discord, HTTP ni Mongo : le moteur reçoit les indicateurs
// normalisés du fournisseur d'intelligence IP et la politique du serveur, et
// rend un verdict motivé. C'est ce qui rend le filtrage prévisible et testable
// (voir tests/anti-vpn-smoke.js) — et ce qui permet d'afficher au staff
// *pourquoi* une connexion a été refusée, au lieu d'un simple « VPN détecté ».

const net = require('net');

const FLAG_LABELS = {
  vpn: 'VPN',
  proxy: 'Proxy',
  tor: 'Tor',
  hosting: 'Hébergement / datacenter',
};

const FLAG_SETTINGS = {
  vpn: 'blockVPN',
  proxy: 'blockProxy',
  tor: 'blockTor',
  hosting: 'blockHosting',
};

function isIP(value) {
  return typeof value === 'string' && net.isIP(value.trim()) !== 0;
}

/** IPv4 → entier (pour les CIDR). */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

/** Adresse locale / privée : inutile d'interroger un fournisseur. */
function isPrivateIp(ip) {
  if (!isIP(ip)) return true;
  if (net.isIP(ip) === 6) {
    const value = ip.toLowerCase();
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80');
  }
  return inCidr(ip, '10.0.0.0/8')
    || inCidr(ip, '172.16.0.0/12')
    || inCidr(ip, '192.168.0.0/16')
    || inCidr(ip, '127.0.0.0/8')
    || inCidr(ip, '169.254.0.0/16')
    || inCidr(ip, '100.64.0.0/10');
}

function inCidr(ip, cidr) {
  const [network, bitsRaw] = String(cidr).split('/');
  if (!isIP(ip) || !isIP(network) || net.isIP(ip) !== 4 || net.isIP(network) !== 4) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
}

/** L'IP est-elle dans la liste blanche (IP exacte ou CIDR IPv4) ? */
function isAllowedIp(ip, list = []) {
  if (!isIP(ip)) return false;
  return (list || []).some(entry => {
    const value = String(entry || '').trim();
    if (!value) return false;
    return value.includes('/') ? inCidr(ip, value) : value === ip;
  });
}

function normalizeCountry(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeAsn(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  return raw.startsWith('AS') ? raw : `AS${raw}`;
}

/**
 * Évalue les indicateurs d'une connexion.
 *
 * @param {object|null} intel — { ip, country, asn, isp, riskScore, vpn, proxy, tor, hosting }
 * @param {object} cfg — document AntiVPN (ou objet équivalent)
 * @returns {{ok:boolean, blocked?:boolean, whitelisted?:boolean, reasons?:string[], score?:number, reason?:string}}
 */
function evaluateIntel(intel, cfg = {}) {
  if (!intel) return { ok: false, reason: 'no_intel' };

  const detection = cfg.detection || {};
  const reasons = [];

  // Liste blanche d'IP : priorité absolue, même si le fournisseur crie au VPN.
  if (isAllowedIp(intel.ip, detection.allowIPs)) {
    return { ok: true, blocked: false, whitelisted: true, reasons: [], score: intel.riskScore ?? null };
  }

  for (const [flag, setting] of Object.entries(FLAG_SETTINGS)) {
    if (detection[setting] && intel[flag] === true) reasons.push(`${FLAG_LABELS[flag]} détecté`);
  }

  const threshold = Number(detection.riskThreshold || 0);
  const score = Number.isFinite(Number(intel.riskScore)) ? Number(intel.riskScore) : null;
  if (threshold > 0 && score !== null && score >= threshold) {
    reasons.push(`Score de risque ${score}/100 (seuil ${threshold})`);
  }

  const country = normalizeCountry(intel.country);
  const allowCountries = (detection.allowCountries || []).map(normalizeCountry).filter(Boolean);
  const blockCountries = (detection.blockCountries || []).map(normalizeCountry).filter(Boolean);

  if (country && blockCountries.includes(country)) {
    reasons.push(`Pays bloqué (${country})`);
  }
  if (allowCountries.length && country && !allowCountries.includes(country)) {
    reasons.push(`Pays hors liste autorisée (${country})`);
  }

  const asn = normalizeAsn(intel.asn);
  const blockAsns = (detection.blockASNs || []).map(normalizeAsn).filter(Boolean);
  if (asn && blockAsns.includes(asn)) reasons.push(`Opérateur bloqué (${asn})`);

  // Un pays inconnu ne doit pas bloquer une liste blanche de pays : sans
  // information fiable, on ne refuse que sur les signaux réellement présents.
  return { ok: true, blocked: reasons.length > 0, reasons, score };
}

/** Résumé lisible d'un passage chez le fournisseur (journal, panneau, tests). */
function describeIntel(intel = {}) {
  const parts = [];
  if (intel.country) parts.push(intel.country);
  if (intel.asn) parts.push(normalizeAsn(intel.asn));
  if (intel.isp) parts.push(intel.isp);
  if (Number.isFinite(Number(intel.riskScore))) parts.push(`risque ${intel.riskScore}/100`);
  const flags = Object.entries(FLAG_LABELS)
    .filter(([flag]) => intel[flag])
    .map(([, label]) => label);
  if (flags.length) parts.push(flags.join(', '));
  return parts.join(' · ') || 'aucun signal particulier';
}

module.exports = {
  FLAG_LABELS,
  FLAG_SETTINGS,
  isIP,
  isPrivateIp,
  inCidr,
  isAllowedIp,
  normalizeCountry,
  normalizeAsn,
  evaluateIntel,
  describeIntel,
};
