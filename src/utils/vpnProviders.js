'use strict';
// utils/vpnProviders.js — Récupération des indicateurs IP (VPN, proxy, Tor…).
//
// Le bot ne parle qu'à des API HTTPS, côté serveur : la clé ne transite jamais
// par le navigateur du membre. Chaque fournisseur a son format ; tout est
// normalisé vers :
//   { ip, country, asn, isp, riskScore, vpn, proxy, tor, hosting, provider }
//
// Fournisseurs intégrés :
//   • proxycheck.io   — proxy/VPN/Tor, score de risque, pays, ASN (clé facultative)
//   • vpnapi.io       — sécurité VPN/proxy/Tor/relais (clé requise)
//   • IPQualityScore  — score de fraude, VPN/proxy/Tor (clé requise)
//   • ipapi.is        — VPN/proxy/Tor/datacenter, ASN (clé facultative)
//   • custom          — n'importe quelle API JSON via ANTIVPN_PROVIDER_URL
//
// Le résultat est mis en cache (30 min par défaut) : deux clics du même membre,
// ou plusieurs membres derrière la même IP, ne consomment qu'un appel.

const axios = require('axios');
const { describeIntel } = require('./vpnEngine');

const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE = 2000;

const cache = new Map(); // `${provider}:${ip}` → { at, intel }

const PROVIDERS = {
  proxycheck: {
    key: 'proxycheck',
    label: 'proxycheck.io',
    needsKey: false,
    env: 'ANTIVPN_API_KEY',
    url: (ip, key) => `https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=1&asn=1&risk=1&tag=rezo${key ? `&key=${encodeURIComponent(key)}` : ''}`,
    parse(json, ip) {
      const entry = json?.[ip] || Object.values(json || {}).find(v => v && typeof v === 'object' && ('proxy' in v || 'type' in v));
      if (!entry) return null;
      const type = String(entry.type || '').toLowerCase();
      return {
        ip,
        country: entry.isocode || entry.country || null,
        asn: entry.asn || null,
        isp: entry.provider || entry.organisation || null,
        riskScore: Number.isFinite(Number(entry.risk)) ? Number(entry.risk) : null,
        vpn: type.includes('vpn'),
        proxy: entry.proxy === 'yes' || type.includes('proxy'),
        tor: type.includes('tor'),
        hosting: type.includes('hosting') || type.includes('business'),
      };
    },
  },

  vpnapi: {
    key: 'vpnapi',
    label: 'vpnapi.io',
    needsKey: true,
    env: 'ANTIVPN_API_KEY',
    url: (ip, key) => `https://vpnapi.io/api/${encodeURIComponent(ip)}?key=${encodeURIComponent(key || '')}`,
    parse(json, ip) {
      if (!json || json.error) return null;
      const security = json.security || {};
      const network = json.network || {};
      return {
        ip,
        country: json.location?.country_code || null,
        asn: network.autonomous_system_number ? `AS${network.autonomous_system_number}` : null,
        isp: network.autonomous_system_organization || null,
        riskScore: null,
        vpn: security.vpn === true,
        proxy: security.proxy === true,
        tor: security.tor === true,
        hosting: security.relay === true,
      };
    },
  },

  ipqualityscore: {
    key: 'ipqualityscore',
    label: 'IPQualityScore',
    needsKey: true,
    env: 'ANTIVPN_API_KEY',
    url: (ip, key) => `https://ipqualityscore.com/api/json/ip/${encodeURIComponent(key || '')}/${encodeURIComponent(ip)}?strictness=0&allow_public_access_points=true`,
    parse(json, ip) {
      if (!json || json.success === false) return null;
      return {
        ip,
        country: json.country_code || null,
        asn: json.ASN ? `AS${json.ASN}` : null,
        isp: json.ISP || json.organization || null,
        riskScore: Number.isFinite(Number(json.fraud_score)) ? Number(json.fraud_score) : null,
        vpn: json.vpn === true || json.active_vpn === true,
        proxy: json.proxy === true || json.active_proxy === true,
        tor: json.tor === true || json.active_tor === true,
        hosting: json.is_crawler === true || json.recent_abuse === true,
      };
    },
  },

  ipapiis: {
    key: 'ipapiis',
    label: 'ipapi.is',
    needsKey: false,
    env: 'ANTIVPN_API_KEY',
    url: (ip, key) => `https://api.ipapi.is/?q=${encodeURIComponent(ip)}${key ? `&key=${encodeURIComponent(key)}` : ''}`,
    parse(json, ip) {
      if (!json || json.error) return null;
      const asn = json.asn || {};
      return {
        ip,
        country: json.location?.country_code || null,
        asn: asn.asn ? `AS${asn.asn}` : null,
        isp: asn.org || asn.descr || null,
        riskScore: null,
        vpn: json.is_vpn === true,
        proxy: json.is_proxy === true,
        tor: json.is_tor === true,
        hosting: json.is_datacenter === true,
      };
    },
  },

  custom: {
    key: 'custom',
    label: 'API personnalisée',
    needsKey: false,
    env: 'ANTIVPN_PROVIDER_URL',
    url: (ip, key, env = process.env) => String(env.ANTIVPN_PROVIDER_URL || '')
      .replace(/\{ip\}/g, encodeURIComponent(ip))
      .replace(/\{key\}/g, encodeURIComponent(key || '')),
    parse(json, ip) {
      if (!json || typeof json !== 'object') return null;
      const pick = (...keys) => keys.map(k => json[k]).find(v => v !== undefined);
      const bool = v => v === true || v === 'true' || v === 1 || v === 'yes';
      const risk = pick('risk', 'riskScore', 'risk_score', 'fraud_score', 'score');
      return {
        ip,
        country: pick('country', 'country_code', 'countryCode') || null,
        asn: pick('asn', 'ASN') || null,
        isp: pick('isp', 'ISP', 'org', 'organization') || null,
        riskScore: Number.isFinite(Number(risk)) ? Number(risk) : null,
        vpn: bool(pick('vpn', 'is_vpn', 'isVpn')),
        proxy: bool(pick('proxy', 'is_proxy', 'isProxy')),
        tor: bool(pick('tor', 'is_tor', 'isTor')),
        hosting: bool(pick('hosting', 'is_hosting', 'is_datacenter', 'datacenter')),
      };
    },
  },
};

function providerInfo(key = 'proxycheck') {
  return PROVIDERS[String(key || '').toLowerCase()] || PROVIDERS.proxycheck;
}

function cacheKey(provider, ip) {
  return `${provider}:${ip}`;
}

function clearCache() {
  cache.clear();
}

/**
 * Interroge le fournisseur et renvoie des indicateurs normalisés.
 * Ne jette jamais : renvoie `{ ok:false, error }` pour laisser l'appelant
 * appliquer sa politique de panne (allow / block).
 *
 * @returns {Promise<{ok:boolean, intel?:object, error?:string, provider?:string, cached?:boolean}>}
 */
async function fetchIntel(ip, {
  provider = 'proxycheck',
  apiKey = process.env.ANTIVPN_API_KEY,
  http = axios,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now(),
  env = process.env,
} = {}) {
  const info = providerInfo(provider);
  const key = cacheKey(info.key, ip);

  const hit = cache.get(key);
  if (hit && now - hit.at < cacheTtlMs) {
    return { ok: true, intel: { ...hit.intel }, provider: info.key, cached: true };
  }

  if (info.needsKey && !apiKey) {
    return { ok: false, error: `Clé API manquante pour ${info.label}`, provider: info.key };
  }

  const url = info.url(ip, apiKey, env);
  if (!url) return { ok: false, error: 'URL du fournisseur non configurée', provider: info.key };

  try {
    const response = await http.get(url, {
      timeout: timeoutMs,
      headers: { accept: 'application/json', 'user-agent': 'REZO-AntiVPN/1.0' },
      validateStatus: status => status >= 200 && status < 300,
    });
    const intel = info.parse(response.data, ip);
    if (!intel) return { ok: false, error: 'Réponse du fournisseur illisible', provider: info.key };

    const normalized = { ...intel, provider: info.key };
    cache.set(key, { at: now, intel: normalized });
    if (cache.size > MAX_CACHE) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    return { ok: true, intel: normalized, provider: info.key };
  } catch (err) {
    const status = err?.response?.status;
    const detail = status ? `HTTP ${status}` : String(err?.code || err?.message || 'erreur réseau');
    return { ok: false, error: `fournisseur injoignable (${detail})`, provider: info.key };
  }
}

/** Vérifie qu'IP + configuration produisent un verdict (utilisé par le test du panel). */
async function inspectIp(ip, cfg, opts = {}) {
  const { evaluateIntel } = require('./vpnEngine');
  const fetched = await fetchIntel(ip, {
    provider: cfg?.detection?.provider || opts.provider,
    ...opts,
  });
  if (!fetched.ok) return { ok: false, ...fetched };
  const verdict = evaluateIntel(fetched.intel, cfg);
  return {
    ok: true,
    intel: fetched.intel,
    verdict,
    summary: describeIntel(fetched.intel),
    cached: Boolean(fetched.cached),
    provider: fetched.provider,
  };
}

module.exports = {
  PROVIDERS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_MS,
  providerInfo,
  fetchIntel,
  inspectIp,
  clearCache,
};
