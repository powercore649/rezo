'use strict';
// utils/antiScam.js — Détection anti-scam unifiée (texte, liens, mentions, snippets).
//
// Moteur remplaçant l'OCR local. L'analyse repose sur des règles vérifiables :
// correspondances de mots-clés, de domaines, de liens d'argent/mitige,
// d'usurpation de marque, et de snippets de preuves types.
//
// Retour de analyzeText(text, config) → { score, factors, reasons }
//   score : 0-100
//   factors : [{ categoryId, label, matched }] ce qui a déclenché l'alerte
//   reasons : [{ severity: 'error'|'warning'|'info', message }] pour le journal

const { URL } = require('url');

// ─── Règles de détection ─────────────────────────────────────────────────────
// Chaque règle a un poids et un tableau de motifs. Le score maximum (100) est
// plafonné après cumul, donc plusieurs règles peuvent s'activer sur un message
// court (par exemple un "Faux Nitro" + une incitation à l'urgence).
const RULES = {
  // Arnaques à crypto / jetons / investissements
  crypto: {
    weight: 25,
    label: 'Cryptomonnaie / investissement / giveaway',
    patterns: [
      /\bcrypto(currency)?\b/i,
      /\b(bitcoin|btc|ethereum|eth|usdt|binance|metamask|trust\s*wallet|solana|dogecoin)\b/i,
      /\b(giveaway|giving\s*away|airdrop|free\s*mint|claim\s*now|claim\s*your|expect\s+value)\b/i,
      /0x[a-fA-F0-9]{20,}/,
      /(?<!\")\$\d+(?:\.\d+)?(?:\.00)?(?!\")/,
      /(?:gains?|earnings?|winnings?)\s*(?:in\s+)?(crypto|fiat)/i,
    ],
  },

  // Officiels faux (seigneurs du don, donneurs, supporters)
  fakeOfficial: {
    weight: 25,
    label: 'Personne quasi-officielle / donateur / supporter',
    patterns: [
      /\b(discord\s*(?:mod|admin|staff|support|dev)\b|\bcaptcha\s*verified\b)/i,
      /\b(donate|donation|supporting|sponsor)\b/i,
      /\b(become\s+a\s+(member|patron|partner)|go\s+pro|join\s+the\s+badges?)\b/i,
      /\b(discord\s+bot|discord\s+verification|token\s+verification|captcha\s+verification)\b/i,
      /\b(discord\s*admin|discord\s*mod|cody\s*sims|minecraft\s+helper|minecraft\s*bot)\b/i,
    ],
  },

  // Faux cadeaux / atterrissage de mots de passe
  fakeGiveaway: {
    weight: 25,
    label: 'Faux cadeaux / atterrissage de mot de passe / promo mensongère',
    patterns: [
      /\b(free\s*nitro|gift\s*(?:code|now|here|discord)\b|discord\s*free\s*nitro)/i,
      /\b(nitro\s*(?:code|now|here|gratuit))\b/i,
      /\b(claim|grab|redeem|enter)\s+(this\s+)?(reward|prize|bonus|code|discord|link)\b/i,
      /\b(verification\s+required|verify\s+to\s+enter|verify\s+to\s+win|vote\s+now)\b/i,
      /\b(official\s+(?:discord|discord\.gg|discordapp))\b/i,
    ],
  },

  // Usurpation / arnaque à l'identité
  impersonation: {
    weight: 20,
    label: 'Usurpation d\'identité (marque, staff, célébrité)',
    patterns: [
      /\b(discord\s*(?:staff|mod|admin)|discord\s*partnership)\b/i,
      /\b(elon\s*musk|tesla\s*giveaway|binance\s*official|mrbeast|mr\.?beast|pewdiepie|kardashian)\b/i,
      /\b(steam\s*support|valve\s*official|epic\s*games\s*support)\b/i,
      /\b(discord\s*support|discord\s*verification|official\s*discord)\b/i,
    ],
  },

  // Arnaques financières
  financial: {
    weight: 20,
    label: 'Transaction / retrait / versement / frais cachés',
    patterns: [
      /\b(withdraw(al)?|deposit|transfer|wallet(?:\s+address)?)\b/i,
      /\b(retrait|versement|paiement|fee|commission|taxe)\b/i,
      /\b(0x[a-fA-F0-9]{20,})\b/,
      /\$\s*\d+(?:\.\d{2})?\s*(?:earned|paid|paid\s+to|won)\b/i,
      /crypto\s*(?:wallet|address|miner|card)\b/i,
      /\bréglement\s+provisionnel|règlement\s+de\s+paiement\b/i,
    ],
  },

  // Urgence / pression sur l'action immédiate
  urgency: {
    weight: 10,
    label: 'Incitation à l\'action immédiate (urgence)',
    patterns: [
      /\b(hurry|limited\s*time|expires?\s*(soon|today)|only\s*left|act\s*(?:now|fast)|immediately|dernière?\s*chance|une\s+niche\s+sur\s+24|en\s+24\s+heures)\b/i,
      /\b(verify\s+now|click\s+here\s+to\s+win|get\s+it\s+now)\b/i,
    ],
  },

  // Liens ouverts (phishing / téléchargement)
  links: {
    weight: 10,
    label: 'Lien non sécurisé / domaine suspect',
    // domaines de confiance
    safeDomains: [
      'discord.com', 'discord.gg', 'discordapp.com', 'discord.dev',
      'steampowered.com', 'twitch.tv', 'youtube.com', 'youtube.com/channel',
      'reddit.com', 'twitter.com', 'x.com', 'github.com', 'freecodecamp.org',
      'google.com', 'mail.google.com', 'googleapis.com', 'youtubei.googleapis.com',
    ],
    patterns: [
      // domaines suspects / mots-clés
      /(?:discord|kraken|binance|metamask|steam|twitch|twitter|x\.com|coinbase|phantom|voyager|opensea|nft)\s*[:\-]?\s*(?!er|re|ss)[\w.-]+(\.(?:com|gg|net|xyz|io|me|top|club|baby|xyz|win|online|fun|info|press|pro|market|trade|casino|game|gift|help|time|vote|earn))\b/i,
      /(?:verify|free|nitro|reward|claim|gift|bonus|log\s*in|sign\s*in|join|discord|official)\s*[:\-]?\s*['"]?\S+\.(?:gg|com|net|xyz|io|me|top|club)\b/i,
      /discord\.(?:gg|com)\/invite/,
      /(?:discord\.gg|discord\.com)\s*\/?\s*(?:invite|token|verification|verify)\b/i,
    ],
  },
};

const CATEGORY_TO_CONFIG_FLAG = {
  crypto: 'detectCrypto',
  fakeOfficial: 'detectCrypto',
  fakeGiveaway: 'detectCrypto',
  impersonation: 'detectImpersonation',
  financial: 'detectFinancial',
  urgency: 'detectUrgency',
  links: 'detectImpersonation',
};

// ─── Mots-clés personnalisés (config.customKeywords[]) ────────────────────────
const KEYWORDS_RULES = {
  casino: { weight: 25, label: 'Casino en ligne / paris ciblés' },
  withdrawal: { weight: 25, label: 'Retrait de fonds / preuve de retrait' },
  freeNitro: { weight: 25, label: 'Faux Nitro / cadeau gratuit' },
  referral: { weight: 15, label: 'Référence / affiliation' },
  phishing: { weight: 30, label: 'Arnaque / phishing' },
  crypto: { weight: 20, label: 'Crypto / tokens' },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan un message complet.
 * @param {string} text - Contenu du message (ou bout de snippet)
 * @param {import('../models/AntiScamConfig').default} config - Configuration du serveur
 * @returns {{ score: number, factors: { categoryId: string, label: string, matched: boolean }[], reasons: { severity: string, message: string }[] }}
 */
function analyzeText(text, config) {
  const factors = [];
  let score = 0;

  if (!text) return { score: 0, factors: [], reasons: [] };

  const lower = text.toLowerCase();

  // ── 1. Règles de mots-clés personnalisés ───────────────────────────────
  for (const kw of config.customKeywords || []) {
    const key = typeof kw === 'string' ? kw.trim().toLowerCase() : '';
    if (!key) continue;
    const rule = KEYWORDS_RULES[key];
    if (rule && lower.includes(key)) {
      factors.push({ categoryId: key, label: rule.label, matched: true });
      score += rule.weight;
    }
  }

  // ── 2. Règles de texte ─────────────────────────────────────────────────
  for (const [key, rule] of Object.entries(RULES)) {
    const flag = CATEGORY_TO_CONFIG_FLAG[key];
    if (config[flag] === false) continue;
    const matched = rule.patterns.some((re) => re.test(text));
    if (matched) {
      factors.push({ categoryId: key, label: rule.label, matched: true });
      score += rule.weight;
    }
  }

  // ── 3. Détection de domaines épinglés dans config.knownDomains ──────────
  for (const domain of config.knownDomains || []) {
    if (domain && new RegExp(`\\b${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
      factors.push({ categoryId: 'links', label: `Domaine épinglé : ${domain}`, matched: true });
      score += 30;
    }
  }

  // ── 4. Liens vers les serveurs suspects (via domaines épinglés ou dans le
  //     message) : le stayle "Discord" + un chemin /invite est un signal fort
  const urlCount = (text.match(/(?:https?|ftp):\/\/[^\s<>"]+/g) || []).length;
  if (urlCount > 1) {
    factors.push({ categoryId: 'links', label: 'Plusieurs liens dans le message', matched: true });
    score += 15;
  }

  // ── 5. Convergence ─────────────────────────────────────────────────────
  // 2 catégories actives sur un message protégé = signal fort
  if (config.enabled && factors.length >= 2) {
    factors.push({ categoryId: 'convergence', label: 'Convergence de plusieurs vecteurs de menace', matched: true });
    score += 10;
  }

  return {
    score: Math.min(100, score),
    factors,
    reasons: buildReasons(factors),
  };
}

function buildReasons(factors) {
  const reasons = [];
  for (const f of factors) {
    if (f.categoryId === 'convergence') continue;
    if (f.matched) {
      reasons.push({ severity: f.categoryId === 'fakeOfficial' || f.categoryId === 'phishing' ? 'error' : 'warning', message: f.label });
    }
  }
  if (factors.some(f => f.categoryId === 'convergence')) {
    reasons.push({ severity: 'warning', message: 'Taux de menace significatif : plusieurs indicateurs détectés' });
  }
  return reasons;
}

// ─── Point d'entrée du hook messageCreate ─────────────────────────────────────
/**
 * Scan d'un message (le flux que le hook antiScamScan.js appelle).
 * @param {import('../models/AntiScamConfig').default} config
 * @returns {{ score: number, factors: { categoryId: string, label: string, matched: boolean }[], reasons: { severity: string, message: string }[] }}
 */
function scanMessage(content, config) {
  const { score, factors, reasons } = analyzeText(content, config);
  return { score, factors, reasons };
}

module.exports = {
  RULES,
  CATEGORY_TO_CONFIG_FLAG,
  KEYWORDS_RULES,
  analyzeText,
  scanMessage,
};
