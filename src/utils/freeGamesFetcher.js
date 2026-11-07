'use strict';
// utils/freeGamesFetcher.js — Jeux gratuits : Epic · Steam · GamerPower · FreeToGame
// Toutes les APIs sont publiques et sans clé d'authentification.

const https = require('https');
const http  = require('http');

// ─── Fetch JSON robuste (suit les redirections, timeout, retry) ───────────────
function fetchJSON(url, timeoutMs = 10000, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; REZO/2.0)',
        'Accept':     'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
      timeout: timeoutMs,
    }, res => {
      // Suivre les redirections
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return fetchJSON(res.headers.location, timeoutMs, redirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON invalide: ${e.message}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout (${timeoutMs}ms)`)); });
  });
}

// ─── EPIC GAMES ───────────────────────────────────────────────────────────────
async function fetchEpicFreeGames() {
  try {
    const url  = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=fr&country=FR&allowCountries=FR';
    const data = await fetchJSON(url);
    const elements = data?.data?.Catalog?.searchStore?.elements || [];
    const games = [];

    for (const el of elements) {
      const promos   = el.promotions;
      if (!promos) continue;
      const current  = promos.promotionalOffers?.[0]?.promotionalOffers?.[0];
      const upcoming = promos.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0];
      const isFree   = current &&
        el.price?.totalPrice?.discountPrice === 0 &&
        el.price?.totalPrice?.originalPrice > 0;
      const isUp     = !isFree && !!upcoming;
      if (!isFree && !isUp) continue;

      const img  = el.keyImages?.find(i => ['Thumbnail','DieselStoreFrontWide','OfferImageWide'].includes(i.type))?.url || null;
      const slug = el.catalogNs?.mappings?.[0]?.pageSlug || el.urlSlug || '';
      const link = slug ? `https://store.epicgames.com/fr/p/${slug}` : 'https://store.epicgames.com/fr/free-games';
      const origPrice = el.price?.totalPrice?.originalPrice || 0;

      games.push({
        id:            `epic_${el.id}`,
        source:        'epic',
        sourceName:    'Epic Games Store',
        sourceColor:   0x2D2D2D,
        sourceIcon:    'https://upload.wikimedia.org/wikipedia/commons/thumb/3/31/Epic_Games_logo.svg/200px-Epic_Games_logo.svg.png',
        title:         el.title,
        description:   (el.description || '').slice(0, 250),
        image:         img,
        url:           link,
        price:         origPrice > 0 ? `~~${(origPrice/100).toFixed(2)}€~~ **GRATUIT**` : '**GRATUIT**',
        originalPrice: origPrice / 100,
        isFree,
        isUpcoming:    isUp,
        startDate:     new Date(isFree ? current.startDate : upcoming.startDate),
        endDate:       new Date(isFree ? current.endDate   : upcoming.endDate),
        platforms:     ['PC'],
      });
    }
    return games;
  } catch (err) {
    console.error('[FreeGames] Epic:', err.message);
    return [];
  }
}

// ─── STEAM (promotions gratuites via l'API officielle Steam) ─────────────────
// Steam n'a pas d'endpoint public dédié aux "jeux 100% gratuits temporairement".
// On utilise deux approches complémentaires :
//   1. ISteamApps/GetAppList + filtrage (trop lourd)
//   2. SteamSpy API (stats d'apps gratuites récentes)
//   3. Store search avec prix 0 (le plus fiable)
async function fetchSteamFreeGames() {
  try {
    // Approche: recherche dans le store Steam d'applis à prix 0 sortis récemment
    // Via l'API de recherche Steam (publique, sans clé)
    const searchUrl = 'https://store.steampowered.com/api/featuredcategories?cc=fr&l=french';
    const featured  = await fetchJSON(searchUrl, 10000);

    const games = [];
    const seen  = new Set();

    // Extraire les jeux en promo à 100% depuis les catégories featured
    const categories = ['specials', 'top_sellers', 'new_releases'];
    for (const cat of categories) {
      const items = featured?.[cat]?.items || [];
      for (const item of items) {
        if (seen.has(item.id)) continue;
        // Prix final = 0 ET prix original > 0 → promo 100%
        if (item.final_price === 0 && item.original_price > 0 && item.discount_percent === 100) {
          seen.add(item.id);
          games.push({
            id:            `steam_${item.id}`,
            source:        'steam',
            sourceName:    'Steam',
            sourceColor:   0x1B2838,
            sourceIcon:    'https://store.steampowered.com/favicon.ico',
            title:         item.name,
            description:   '',
            image:         item.header_image || item.large_capsule_image || null,
            url:           `https://store.steampowered.com/app/${item.id}`,
            price:         `~~${(item.original_price/100).toFixed(2)}€~~ **GRATUIT**`,
            originalPrice: item.original_price / 100,
            isFree:        true,
            isUpcoming:    false,
            startDate:     new Date(),
            endDate:       null,
            platforms:     ['PC'],
            discount:      item.discount_percent,
          });
        }
      }
    }

    // Approche 2: jeux "Free to Keep" via les promos spéciales
    try {
      const specialsUrl = 'https://store.steampowered.com/api/featured/?cc=fr&l=french';
      const specialData = await fetchJSON(specialsUrl, 10000);
      const specials    = specialData?.featured_win || [];

      for (const item of specials) {
        if (seen.has(item.id)) continue;
        if (item.final_price === 0 && item.original_price > 0 && item.discount_percent === 100) {
          seen.add(item.id);
          games.push({
            id:            `steam_${item.id}`,
            source:        'steam',
            sourceName:    'Steam',
            sourceColor:   0x1B2838,
            sourceIcon:    'https://store.steampowered.com/favicon.ico',
            title:         item.name,
            description:   '',
            image:         item.header_image || item.large_capsule_image || null,
            url:           `https://store.steampowered.com/app/${item.id}`,
            price:         `~~${(item.original_price/100).toFixed(2)}€~~ **GRATUIT**`,
            originalPrice: item.original_price / 100,
            isFree:        true,
            isUpcoming:    false,
            startDate:     new Date(),
            endDate:       null,
            platforms:     ['PC'],
            discount:      item.discount_percent,
          });
        }
      }
    } catch (_) {}

    // Approche 3: GamerPower filtre Steam uniquement (source fiable pour les promos Steam)
    try {
      const gpSteamUrl = 'https://www.gamerpower.com/api/giveaways?platform=steam&type=game&sort-by=date';
      const gpData     = await fetchJSON(gpSteamUrl, 10000);
      if (Array.isArray(gpData)) {
        for (const g of gpData.slice(0, 8)) {
          const key = `gp_steam_${g.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          games.push({
            id:            `steam_gp_${g.id}`,
            source:        'steam',
            sourceName:    'Steam (via GamerPower)',
            sourceColor:   0x1B2838,
            sourceIcon:    'https://store.steampowered.com/favicon.ico',
            title:         g.title,
            description:   (g.description || '').slice(0, 250),
            image:         g.image || g.thumbnail || null,
            url:           g.open_giveaway_url || `https://www.gamerpower.com/offers/${g.id}`,
            price:         g.worth && g.worth !== 'N/A' ? `~~${g.worth}~~ **GRATUIT**` : '**GRATUIT**',
            originalPrice: parseFloat((g.worth || '0').replace(/[^0-9.]/g, '')) || 0,
            isFree:        true,
            isUpcoming:    false,
            startDate:     new Date(g.published_date),
            endDate:       g.end_date && g.end_date !== 'N/A' ? new Date(g.end_date) : null,
            platforms:     ['PC'],
          });
        }
      }
    } catch (_) {}

    return games;
  } catch (err) {
    console.error('[FreeGames] Steam:', err.message);
    return [];
  }
}

// ─── GAMERPOWER (GOG, Epic, itch.io, etc.) ───────────────────────────────────
async function fetchGamerPowerGames() {
  try {
    // Exclure Steam (géré séparément) pour éviter les doublons
    const url  = 'https://www.gamerpower.com/api/giveaways?platform=epic-games.gog.itch.io&type=game&sort-by=popularity';
    const data = await fetchJSON(url, 10000);
    if (!Array.isArray(data)) return [];

    return data.slice(0, 10).map(g => ({
      id:            `gp_${g.id}`,
      source:        'gamerpower',
      sourceName:    'GamerPower',
      sourceColor:   0xFF6B35,
      sourceIcon:    'https://www.gamerpower.com/favicon.ico',
      title:         g.title,
      description:   (g.description || '').slice(0, 250),
      image:         g.image || g.thumbnail || null,
      url:           g.open_giveaway_url || `https://www.gamerpower.com/offers/${g.id}`,
      price:         g.worth && g.worth !== 'N/A' ? `~~${g.worth}~~ **GRATUIT**` : '**GRATUIT**',
      originalPrice: parseFloat((g.worth || '0').replace(/[^0-9.]/g, '')) || 0,
      isFree:        true,
      isUpcoming:    false,
      startDate:     new Date(g.published_date),
      endDate:       g.end_date && g.end_date !== 'N/A' ? new Date(g.end_date) : null,
      platforms:     (g.platforms || 'PC').split(',').map(p => p.trim()),
    }));
  } catch (err) {
    console.error('[FreeGames] GamerPower:', err.message);
    return [];
  }
}

// ─── FREETOGAME ───────────────────────────────────────────────────────────────
async function fetchFreeToPlayGames(limit = 5) {
  try {
    const url  = 'https://www.freetogame.com/api/games?sort-by=popularity';
    const data = await fetchJSON(url, 10000);
    if (!Array.isArray(data)) return [];

    return data.slice(0, limit).map(g => ({
      id:            `f2p_${g.id}`,
      source:        'freetogame',
      sourceName:    'Free-to-Play',
      sourceColor:   0x00D166,
      sourceIcon:    'https://www.freetogame.com/favicon.ico',
      title:         g.title,
      description:   (g.short_description || '').slice(0, 250),
      image:         g.thumbnail || null,
      url:           g.game_url || 'https://www.freetogame.com',
      price:         '**FREE-TO-PLAY**',
      originalPrice: 0,
      isFree:        true,
      isUpcoming:    false,
      startDate:     new Date(g.release_date),
      endDate:       null,
      platforms:     [(g.platform || 'PC').toLowerCase()],
      genre:         g.genre,
    }));
  } catch (err) {
    console.error('[FreeGames] FreeToGame:', err.message);
    return [];
  }
}

// ─── Récupérer TOUS les jeux selon les options ────────────────────────────────
async function fetchAllFreeGames(options = {}) {
  const {
    epicEnabled        = true,
    steamEnabled       = true,
    gamerPowerEnabled  = true,
    onlyCurrentlyFree  = true,
  } = options;

  const promises = [];
  if (epicEnabled)       promises.push(fetchEpicFreeGames());
  if (steamEnabled)      promises.push(fetchSteamFreeGames());
  if (gamerPowerEnabled) promises.push(fetchGamerPowerGames());

  const results = await Promise.allSettled(promises);
  let games = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  if (onlyCurrentlyFree) {
    games = games.filter(g => g.isFree && !g.isUpcoming);
  }

  // Dédupliquer par titre (insensible à la casse)
  const seen = new Set();
  games = games.filter(g => {
    const key = g.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Trier : Epic en premier, puis Steam, puis le reste
  const order = { epic: 0, steam: 1, gamerpower: 2, freetogame: 3 };
  games.sort((a, b) => (order[a.source] ?? 99) - (order[b.source] ?? 99));

  return games;
}

module.exports = {
  fetchAllFreeGames,
  fetchEpicFreeGames,
  fetchSteamFreeGames,
  fetchGamerPowerGames,
  fetchFreeToPlayGames,
};
