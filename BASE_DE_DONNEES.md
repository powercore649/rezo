# 🧽 Base de données — allégée automatiquement

Une base MongoDB grossit rarement à cause de ce qu'on lit : elle grossit à cause
de ce que **plus personne ne lit**. Un historique de bump de l'an dernier, des
centaines de milliers de lignes de journaux captcha, des conversations IA
abandonnées, des invitations de membres partis depuis huit mois, des rappels
terminés.

Ces documents coûtent trois fois : du disque (et donc souvent de l'argent), de la
mémoire pour l'index, et du temps à chaque sauvegarde ou restauration.

`utils/dbMaintenance.js` donne une **durée de vie** à chaque famille de documents,
et `crons/dbMaintenance.js` l'applique **chaque nuit à 04:00** (sur le shard 0 —
voir `SHARDING.md`).

---

## 1. Ce qui expire, et après combien de temps

| Famille | Collection | Champ daté | Rétention | Restriction |
|---|---|---|---|---|
| Conversations IA | `aiconversations` | `updatedAt` | 30 j | — |
| Statistiques IA journalières | `aidailystats` | `date` | 90 j | — |
| Mémoires IA | `aimemories` | `lastSeenAt` | 180 j | — |
| Historique des bumps | `bumphistories` | `createdAt` | 120 j | — |
| Journaux captcha | `captchallogs` | `date` | 30 j | — |
| Captchas en attente | `captchapendings` | `expiresAt` | 0 j | déjà expirés |
| Déclenchements honeypot | `honeypottriggers` | `triggeredAt` | 120 j | — |
| Invitations | `inviteuses` | `leftAt` | 180 j | `left: true` uniquement |
| Tickets ModMail | `modmailthreads` | `closedAt` | 180 j | `status: closed` uniquement |
| Rappels | `reminders` | `remindAt` | 30 j | `done: true` uniquement |
| Tâches | `todos` | `createdAt` | 90 j | `done: true` uniquement |
| Giveaways | `giveaways` | `endAt` | 60 j | `ended: true` uniquement |
| Sondages avancés | `advancedpolls` | `endsAt` | 60 j | `closed: true` uniquement |
| Historique des paiements | `transactions` | `createdAt` | 180 j | — |
| Cooldowns | `cooldowns` | `lastUse` | 30 j | — |

**Ce qui n'est jamais supprimé** : la configuration d'un serveur (marque, rôles
automatiques, panneaux, salons configurés), les soldes et les niveaux, les
licences, les commandes personnalisées, les avis, les acceptations des
conditions d'utilisation (`tosacceptances` — la preuve de consentement doit
survivre à l'entretien). La rétention ne touche qu'aux
**journaux, états transitoires et historiques**.

Chaque règle déclare son filtre dans `utils/dbMaintenance.js` (`RULES`) : une
ligne encore utile ne peut pas disparaître par accident, et c'est testé
(`tests/db-maintenance-smoke.js`, sections A et C).

---

## 2. Voir l'état réel

`/help` → bouton **🩺 Diagnostic** :

- taille des données et du stockage, nombre de collections et de documents ;
- nombre d'index et leur taille ;
- **documents nettoyables maintenant**, par famille, avec la rétention appliquée ;
- date et résultat du dernier entretien (documents supprimés, durée, erreurs).

Les statistiques sont mises en cache 60 secondes : cliquer dix fois sur le bouton
ne déclenche pas dix séries de comptages.

---

## 3. Lancer l'entretien à la main

```bash
npm run test:db          # 38 vérifications hors-ligne : filtres, dryRun, erreurs isolées, stats
node -e "require('./src/utils/dbMaintenance').runMaintenance({ dryRun: true, logger: console }).then(s => console.table(s.results.map(r => ({ regle: r.id, jours: r.days, concernes: r.count }))))"
```

Le `dryRun` **compte sans supprimer** — pratique pour mesurer avant d'agir.
Le cron, lui, appelle `runMaintenance({ indexes: true })` : il supprime *et*
rejoue les index déclarés (`createIndexes()`), sans jamais en supprimer un.

---

## 4. Ajouter une règle

Une seule entrée dans `RULES` (`src/utils/dbMaintenance.js`) :

```js
{
  id: 'ma-collection',            // clé unique, utilisée par `only` et les tests
  label: 'Nom lisible',           // affiché dans le Diagnostic
  collection: 'macollection',     // nom Mongo (pour la doc)
  path: '../models/MonModele',    // modèle mongoose (résolu paresseusement)
  days: 90,                       // durée de vie
  field: 'createdAt',             // champ daté
  extra: { done: true },          // facultatif : ne viser que certaines lignes
  description: 'Pourquoi cette durée, en une phrase.',
}
```

Puis : `npm run test:db` (les tests lisent `RULES`, une règle ajoutée est donc
immédiatement couverte) et `/help` → Diagnostic pour la voir apparaître.

---

## 5. Tenue en charge — plusieurs milliers de serveurs

Une base qui va bien sur 20 serveurs peut tomber sur 5 000. Quatre mécanismes
s'en occupent ; tout est vérifié par `npm run test:scale` (90 contrôles hors ligne).

### 5.1 Un message ne doit plus coûter dix requêtes

Chaque message demandait « ce serveur a-t-il activé ce module ? » pour une
dizaine de modules (AutoMod, AutoThread, honeypot, demandes de MP, XP, comptage…).
Ces configurations changent quelques fois par mois et se lisent des milliers de
fois par heure : `utils/guildConfigCache.js` les garde en mémoire.

- **cache borné** (LRU) : le nombre de serveurs n'augmente pas la mémoire ;
- **mémorisation négative** : un serveur sans configuration n'est pas requêté à
  chaque message ;
- **mutualisation** : 50 messages simultanés du même serveur = 1 seule requête ;
- **invalidation automatique** : des hooks Mongoose purgent l'entrée dès qu'une
  commande écrit la configuration (`findOneAndUpdate`, `updateOne`, `save`…),
  donc le panel ne ment jamais ;
- **abandon rapide** : si la base ne répond pas, la lecture rend `null` au bout de
  `DB_CACHE_TIMEOUT` ms au lieu de laisser le traitement pendre.

Quand un document doit être **modifié puis sauvegardé** (comptage, demandes de MP,
honeypot anti-raid), le cache ne mémorise que son **absence** : le document rendu
reste un vrai document Mongoose.

| Variable | Défaut | Rôle |
|---|---|---|
| `DB_CACHE_TTL` | `60000` | Durée de vie d'une configuration en cache (ms). |
| `DB_CACHE_NEG_TTL` | `300000` | Durée de vie d'une *absence* de configuration. |
| `DB_CACHE_MAX` | `20000` | Nombre maximal d'entrées en mémoire. |
| `DB_CACHE_TIMEOUT` | `2500` | Au-delà, on renonce à la lecture au lieu d'attendre. |

### 5.2 La connexion est bornée dans les deux sens

| Variable | Défaut | Rôle |
|---|---|---|
| `MONGO_MAX_POOL` | (driver) | Connexions par processus. À régler en shardé : N shards × 100 connexions saturent la base. |
| `MONGO_WAIT_QUEUE_MS` | `10000` | Au-delà, une requête en attente échoue vite au lieu de s'empiler en mémoire. |
| `MONGO_SERVER_SELECTION_MS` | `15000` | Temps maximal pour joindre la base. |
| `MONGO_SOCKET_TIMEOUT_MS` | `45000` | Délai d'inactivité d'un socket. |
| `MONGO_CONNECT_TIMEOUT_MS` | `15000` | Délai de connexion initiale. |
| `MONGO_MAX_IDLE_MS` | `120000` | Ferme les connexions inutilisées. |
| `MONGO_AUTO_INDEX` | `true` | `false` = construire les index par l'entretien nocturne, pas à chaque démarrage. |

### 5.3 Les tâches périodiques ne s'empilent plus

Un cron qui dure plus longtemps que son intervalle voyait le suivant démarrer
par-dessus : travail doublé, mémoire qui grimpe, envois en double. Le noyau
(`core/kernel.js`) et les planificateurs à intervalle (alertes de stream, Reddit,
accueil, jeux gratuits) refusent désormais un second passage simultané : il est
ignoré et signalé dans les logs.

`utils/concurrency.js` fournit aussi `mapLimit` (N opérations en vol, erreurs
isolées par serveur) pour paralléliser sans saturer la base ni l'API Discord.

### 5.4 Les caches mémoire sont bornés

Une `Map` de portée module gardait une entrée par serveur, par membre ou par
adresse IP — indéfiniment. Tous les caches des chemins chauds passent par
`utils/boundedCache.js` (LRU + TTL) : configuration de préfixe, identité de
serveur, cooldowns XP et IA, anti-spam avancé, licences, premium, 2FA, limiteur
du portail anti-VPN, trésors, marqueur « premier message du jour ».

### 5.5 Les index des chemins chauds

Sans index, chaque message balaie toute la collection. Ces chemins sont
désormais indexés (et vérifiés par `test:scale`, section F) : `guildId` sur tous
les modèles de configuration, `userId` sur l'XP et les soldes, `key` sur les
licences, `enabled` sur le pont inter-serveurs, `done+remindAt` sur les rappels.
Le modèle `Duel` n'avait **aucun** index : il en a trois, dont une expiration à
30 jours (une collection de duels grossissait sans fin).

### 5.6 Une config par serveur, même à deux clics simultanés

Une quarantaine de modules écrivent `if (!cfg) cfg = await Model.create({ guildId })`.
Sur un serveur qui n'a encore **aucun** document, deux actions simultanées (deux
admins qui ouvrent le panel, un événement plus un clic) lancent deux insertions :
la seconde casse sur l'index unique `guildId_1` et le module répond « une erreur
est survenue ». C'est l'origine des `E11000 … xpconfigs` observés en production.

`utils/guildSingleton.js` rattrape exactement ce cas, installé par le noyau avant
le chargement des commandes :

- **la règle est étroite** : uniquement un doublon dont la clef unique est
  exactement `{ guildId: 1 }`, c'est-à-dire une configuration « un par serveur ».
  Le second appel relit le document que le premier vient d'insérer et le renvoie ;
- **rien d'autre n'est avalé** : une clé métier (`key` de licence, vote, index
  composé `guildId + userId`) remonte toujours comme une vraie erreur, et une
  panne base (timeout) n'est jamais transformée en succès ;
- **aucune écriture inventée** : le document rendu est celui de l'autre appel,
  donc aucune configuration n'est écrasée.

Vérifié par `tests/guild-singleton-smoke.js`, y compris trois ouvertures
simultanées sur un serveur vierge (un seul document, aucune erreur).

---

## 6. Fichiers

| Fichier | Rôle |
|---|---|
| `src/utils/dbMaintenance.js` | Règles, plan de rétention, exécution, statistiques. |
| `src/crons/dbMaintenance.js` | Entretien quotidien (04:00, shard 0). |
| `src/utils/helpDiagnostics.js` | Mise en forme dans le panel d'aide. |
| `src/utils/guildConfigCache.js` | Cache des configurations par serveur + invalidation. |
| `src/utils/boundedCache.js` | Cache borné (LRU + TTL) partagé. |
| `src/utils/concurrency.js` | Parallélisme borné et anti-chevauchement. |
| `src/utils/guildSingleton.js` | Config « un par serveur » : la course sur `create` devient une relecture. |
| `tests/db-maintenance-smoke.js` | Filet de sécurité hors-ligne de l'entretien. |
| `tests/scale-smoke.js` | Tenue en charge : caches, invalidation, index, connexion. |
