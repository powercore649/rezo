# REZO

Bot Discord tout-en-un, **auto-hébergeable** : 100 commandes slash réparties en
11 domaines (le budget Discord est de 100 et il est saturé), une base MongoDB,
et un site marchand qui délivre de vraies clés de licence au bot.

Le dépôt contient tout ce qu'il faut pour lancer ta propre instance : le bot,
le site, les tests et la documentation d'exploitation. Aucun service propriétaire
n'est requis en dehors de Discord, MongoDB et — si tu l'actives — l'API Gemini.

**Licence MIT** (voir [LICENSE](LICENSE)). Non affilié à Discord Inc.

---

## Ce que fait le bot

| Domaine | Exemples réels |
| --- | --- |
| Modération | sanctions, historique, mises en sourdine temporaires, tickets et ModMail |
| Automodération | liens, spam, majuscules, honeypot, liste noire de mots |
| Anti-ping | `@everyone`/`@here` sans permission, mentions en masse, salons aux noms suspects supprimés et anciens salons restaurés — panneau protégé par un code local, sans licence |
| Installation | À l'arrivée, un salon privé réservé aux administrateurs avec un bouton **Start here** qui ouvre le programme d'installation des modules — sans licence |
| Accès au serveur | captcha, anti-VPN avec portail de vérification, anti-raid, garde à l'arrivée |
| Communauté | niveaux et cartes de progression, économie, boutique, trésor, anniversaires |
| Animation | giveaways, sondages et prédictions, rappels, suggestions |
| Réseau | publicités entre serveurs, bump et rappels de bump, boost, invitations |
| Musique | lecture, file d'attente, radio avec reconnexion |
| IA | `/ia` avec mémoire de conversation, modèles d'images (facultatif) |
| Utilitaires | rappels, météo, traduction, QR codes, PDF, sondages |
| Personnalisation | commandes personnalisées, cartes de bienvenue, identité du serveur |
| Licences | `/license`, paliers, sièges, période de grâce, site de vente |

Le catalogue est généré depuis le code : la page `/commandes` du site liste
exactement les commandes réellement chargées, jamais une liste recopiée à la main.

## Prérequis

- **Node.js ≥ 22.5** (`package.json` → `engines`)
- **MongoDB** (locale ou Atlas)
- Un **token de bot** : <https://discord.com/developers/applications>
- Facultatif : `ffmpeg`/`yt-dlp` (`npm run music:setup`), Lavalink (`npm run lavalink:check`),
  une clé Gemini pour `/ia`, un compte Stripe + un fournisseur d'e-mail pour vendre.

## Démarrage rapide

```bash
git clone <URL du dépôt> rezo
cd rezo
npm ci
cp .env.example .env      # Windows : copy .env.example .env
npm test                  # vérifications hors ligne
npm start
```

Deux variables sont **obligatoires** — le noyau refuse de démarrer sans elles :

| Variable | Rôle |
| --- | --- |
| `TOKEN` | token du bot Discord |
| `MONGODB_URI` | chaîne de connexion MongoDB |

Tout le reste est facultatif : chaque fonctionnalité désactivée s'annonce
proprement dans la commande concernée au lieu de faire tomber le bot. Le fichier
[`.env.example`](.env.example) documente chaque variable, y compris celles du
site, des licences et des intégrations tierces.

Pour les déploiements multi-shards : `npm run start:shards`.

## Site marchand (facultatif)

```bash
npm run site              # http://127.0.0.1:24667 par défaut
```

Le site rend chaque page à la requête, encaisse Stripe, écrit de vraies clés
dans la base du bot, et sert un explorateur de commandes ainsi qu'un état du
service. Routes, variables et sécurité : [`SITE.md`](SITE.md).

## Scripts

| Commande | Effet |
| --- | --- |
| `npm start` | lance le bot |
| `npm run start:shards` | lance le gestionnaire de shards |
| `npm run site` | lance le site marchand |
| `npm test` | toutes les vérifications hors ligne |
| `npm run test:<domaine>` | une suite ciblée (`antinuke`, `music`, `shop`, `ai`…) |
| `npm run music:setup` | télécharge `yt-dlp` et `ffmpeg` dans `bin/` |
| `npm run lavalink:check` | teste le nœud Lavalink configuré |
| `npm run mail:test` | vérifie l'envoi d'e-mail du site |

## Architecture

```
src/
  core/        noyau : démarrage, chargement des commandes, erreurs, identité de version
  commands/    100 commandes racine, un dossier par domaine
  events/      écouteurs Discord (interactions, arrivées, messages…)
  crons/       tâches planifiées (bumps, purge, entretien de la base)
  models/      schémas Mongoose
  utils/       logique partagée : licences, marque, cartes, site, stockage
  web/         serveur HTTP du site marchand
tests/         vérifications hors ligne (aucun token, aucune base, aucun réseau)
scripts/       outils d'exploitation et d'installation
```

Points d'entrée : `src/index.js` (bot), `src/shard.js` (shards),
`src/web/storeServer.js` (site).

## Tests

`npm test` exécute `tests/run-all.js` : chaque fichier `tests/*.test.js` exporte
une liste de vérifications, et le code de sortie vaut 1 dès la première erreur —
utilisable tel quel en CI. Les tests n'ont besoin **ni de token, ni de MongoDB,
ni du réseau** : ils chargent les modules, vérifient les contrats, le budget de
100 commandes Discord, le rendu HTML du site et la documentation des variables
d'environnement.

## Contribuer et signaler une faille

- [CONTRIBUTING.md](CONTRIBUTING.md) — installation, conventions, checklist de PR.
- [SECURITY.md](SECURITY.md) — signalement **privé** des vulnérabilités.

Ne publie jamais de token, de chaîne MongoDB ou de clé d'API dans une issue :
`.env` est ignoré par Git, garde-le ainsi.

## Licence

Code sous [MIT](LICENSE) : utilisation, modification et redistribution libres,
y compris commerciales, avec conservation de la mention de copyright. Le module
de licences (`/license`, paliers, sièges) fait partie du dépôt : c'est du code
applicatif, pas une restriction d'usage du logiciel.
