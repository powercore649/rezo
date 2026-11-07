# Contribuer à REZO

Merci de prendre le temps de proposer une amélioration. Ce dépôt est un bot
Discord de production : une contribution utile est une contribution qui ne
casse ni le démarrage, ni les tests, ni les données des serveurs.

## Mise en route

```bash
git clone <URL du dépôt> rezo
cd rezo
npm ci
cp .env.example .env     # Windows : copy .env.example .env
npm test
```

Pour lancer le bot, il faut un `TOKEN` et un `MONGODB_URI`. Utilise une
application Discord de test et une base dédiée : ne pointe jamais une instance
de développement vers la base de production.

## Conventions

- **Langage** : français dans le code, les commentaires, les messages et les
  commits, comme le reste du dépôt.
- **Dépendances** : n'ajoute pas de paquet sans nécessité réelle. Le projet
  évite volontairement les frameworks ; une fonctionnalité qui peut s'écrire
  avec la bibliothèque standard doit s'écrire avec elle.
- **Commentaires** : explique *pourquoi*, pas *quoi*. Un commentaire qui répète
  le code sera retiré en revue.
- **Commandes slash** : le budget Discord est de 100 commandes racine et le
  dépôt est déjà à 100. Toute nouvelle commande doit donc être une
  sous-commande d'une commande existante, ou remplacer une commande existante —
  `npm run test:limit` tranchera.
- **Variables d'environnement** : toute variable lue dans `src/` doit être
  documentée dans `.env.example`, sinon `tests/integrity.test.js` échoue.
- **Rendu HTML du site** : tout contenu dynamique passe par `esc()` ; aucune
  ressource externe (police, script, image distante) ; la CSP reste
  `default-src 'none'`.

## Avant d'ouvrir une pull request

1. `npm test` passe, sans échec (colle la dernière ligne dans la description).
2. Si tu ajoutes un comportement, ajoute la vérification correspondante dans
   `tests/` — les tests existants servent de modèle.
3. Aucun secret, aucune donnée personnelle, aucun identifiant de serveur réel
   dans le diff.
4. Si tu touches à la base, indique la migration ou l'index à créer.

Les contributions qui réécrivent l'architecture sans discussion préalable ont
peu de chances d'être fusionnées : ouvre d'abord une issue pour en parler.

## Signaler un bug

Donne la version (`/botinfo` ou `package.json`), la commande concernée, ce que
tu attendais et ce qui s'est produit. Les journaux aident beaucoup ; retire-en
les tokens, les identifiants et les adresses e-mail avant de les coller.

## Vulnérabilités

Ne les publie pas en issue publique : suis [SECURITY.md](SECURITY.md).
