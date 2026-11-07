'use strict';

// Cache en mémoire : Map<guildId, Map<code, { uses, inviterId, inviterTag }>>
// Alimenté au démarrage (ready) et à chaque join/leave/inviteCreate/inviteDelete.
const cache = new Map();

// Santé du cache : un serveur où `invites.fetch()` échoue (permission « Gérer le
// serveur » manquante) produit des arrivées « inconnues » en silence. On retient
// l'état pour pouvoir l'expliquer dans /invites-config statut.
const unavailable = new Map(); // guildId → message d'erreur
const primedAt = new Map();    // guildId → timestamp du dernier amorçage réussi

/**
 * Convertit une Collection d'invitations Discord.js en objet simple sérialisable
 * (Map<code, {uses, inviterId, inviterTag}>).
 */
function snapshotFromDiscordInvites(discordInvites) {
  const snap = new Map();
  for (const [code, inv] of discordInvites) {
    snap.set(code, {
      uses: inv.uses ?? 0,
      inviterId: inv.inviter?.id ?? null,
      inviterTag: inv.inviter?.tag ?? 'Inconnu',
      maxUses: inv.maxUses ?? 0,
      temporary: inv.temporary ?? false,
    });
  }
  return snap;
}

/**
 * Charge (ou recharge) le cache d'un serveur à partir de l'API Discord.
 * À appeler au ready, à guildCreate, et après chaque join/leave pour rester synchro.
 */
async function primeGuildCache(guild) {
  try {
    const invites = await guild.invites.fetch();
    const snap = snapshotFromDiscordInvites(invites);

    // Ajoute le vanity URL s'il existe (compte séparément, pas de "code" classique dans invites.fetch())
    if (guild.features?.includes('VANITY_URL') || guild.vanityURLCode) {
      try {
        const vanity = await guild.fetchVanityData().catch(() => null);
        if (vanity?.code) {
          snap.set(`vanity:${vanity.code}`, {
            uses: vanity.uses ?? 0,
            inviterId: null,
            inviterTag: 'Lien Vanity',
            maxUses: 0,
            temporary: false,
            isVanity: true,
          });
        }
      } catch (_) {}
    }

    cache.set(guild.id, snap);
    unavailable.delete(guild.id);
    primedAt.set(guild.id, Date.now());
    return snap;
  } catch (err) {
    console.error(`[inviteCache] Impossible de charger les invitations pour ${guild.id}:`, err.message);
    unavailable.set(guild.id, err.message);
    // Ne pas écraser un cache existant en cas d'erreur réseau ponctuelle
    if (!cache.has(guild.id)) cache.set(guild.id, new Map());
    return cache.get(guild.id);
  }
}

/**
 * État de la lecture des invitations pour un serveur, à afficher dans la config.
 * @returns {{ available: boolean, codes: number, primedAt: number|null, error: string|null }}
 */
function getCacheHealth(guildId) {
  return {
    available: !unavailable.has(guildId),
    codes: getGuildCache(guildId).size,
    primedAt: primedAt.get(guildId) || null,
    error: unavailable.get(guildId) || null,
  };
}

function getGuildCache(guildId) {
  return cache.get(guildId) || new Map();
}

/**
 * Fonction PURE (aucun accès réseau/DB) : compare l'ancien et le nouveau snapshot
 * pour déterminer quel code a été utilisé.
 *
 * Stratégie :
 *  1. Un code dont `uses` a augmenté par rapport à l'ancien snapshot = code utilisé (cas normal).
 *  2. Un code présent dans newSnap mais absent d'oldSnap avec uses >= 1 = invitation créée et
 *     utilisée dans la même fenêtre de temps (rare mais possible) = code utilisé.
 *  3. Un code présent dans oldSnap mais absent de newSnap (invitation à usage unique qui vient
 *     d'expirer après avoir été utilisée) = code utilisé, uses considéré comme son max.
 *  4. Le lien vanity : s'il existe dans les deux et que ses uses ont augmenté, et qu'aucun
 *     autre code classique n'a bougé, alors c'est le vanity qui a été utilisé.
 *  5. Si plusieurs codes ont augmenté simultanément (race condition entre deux joins concurrents),
 *     on retourne celui avec la plus grande augmentation ; en cas d'égalité stricte, le premier
 *     rencontré (ordre non garanti mais déterministe pour un même input).
 *  6. Aucun changement détecté = méthode 'unknown'.
 *
 * @returns {{ code: string|null, inviterId: string|null, inviterTag: string, method: 'invite'|'vanity'|'unknown' }}
 */
function detectUsedCode(oldSnap, newSnap) {
  const candidates = [];

  // Cas 1 & 2 : présent dans newSnap, uses supérieur (ou nouveau avec uses >= 1)
  for (const [code, newData] of newSnap) {
    const oldData = oldSnap.get(code);
    const oldUses = oldData ? oldData.uses : 0;
    const delta = newData.uses - oldUses;
    if (delta > 0) {
      candidates.push({
        code,
        delta,
        inviterId: newData.inviterId,
        inviterTag: newData.inviterTag,
        method: newData.isVanity ? 'vanity' : 'invite',
      });
    }
  }

  // Cas 3 : présent dans oldSnap, disparu de newSnap (invitation à 1 usage consommée puis supprimée par Discord)
  for (const [code, oldData] of oldSnap) {
    if (!newSnap.has(code) && oldData.maxUses === 1) {
      candidates.push({
        code,
        delta: 1, // usage implicite
        inviterId: oldData.inviterId,
        inviterTag: oldData.inviterTag,
        method: oldData.isVanity ? 'vanity' : 'invite',
      });
    }
  }

  if (candidates.length === 0) {
    return { code: null, inviterId: null, inviterTag: 'Inconnu', method: 'unknown' };
  }

  // Le plus grand delta gagne ; à égalité, ordre de découverte (déterministe pour un même input)
  candidates.sort((a, b) => b.delta - a.delta);
  const best = candidates[0];
  return {
    // Le préfixe interne « vanity: » ne doit jamais apparaître dans les annonces
    // ni dans les codes ignorés : seule la méthode distingue un lien vanity.
    code: best.code.startsWith('vanity:') ? best.code.slice('vanity:'.length) : best.code,
    inviterId: best.inviterId,
    inviterTag: best.inviterTag,
    method: best.method,
  };
}

/**
 * Point d'entrée principal utilisé par guildMemberAdd : capture le nouveau snapshot,
 * compare avec l'ancien, met à jour le cache, et retourne le résultat de détection.
 * Un mutex simple par guild évite les races entre deux joins simultanés.
 */
const locks = new Map();

async function resolveInviteForJoin(guild) {
  // Mutex minimal par guild : on chaîne les résolutions pour ne pas comparer deux fois le même vieux snapshot
  const prevLock = locks.get(guild.id) || Promise.resolve();
  let release;
  const lock = new Promise(res => { release = res; });
  locks.set(guild.id, prevLock.then(() => lock));
  await prevLock;

  try {
    const oldSnap = getGuildCache(guild.id);
    const newSnap = await primeGuildCache(guild);
    return detectUsedCode(oldSnap, newSnap);
  } finally {
    release();
  }
}

module.exports = {
  snapshotFromDiscordInvites,
  primeGuildCache,
  getGuildCache,
  getCacheHealth,
  detectUsedCode,
  resolveInviteForJoin,
  _cache: cache, // exposé pour les tests
};
