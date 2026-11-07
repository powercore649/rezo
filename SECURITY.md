# Politique de sécurité

REZO manipule des tokens Discord, des chaînes de connexion MongoDB, des clés
d'API tierces et des clés de licence. Une faille signalée en privé est corrigée
avant d'être rendue publique.

## Signaler une vulnérabilité

Envoie un message privé au propriétaire du dépôt, ou un e-mail à
**raphwieczorek@gmail.com**, avec :

- la version concernée (`package.json` ou `/botinfo`) ;
- le module ou la route touchée ;
- les étapes de reproduction et l'impact concret ;
- éventuellement un correctif proposé.

**N'ouvre pas d'issue publique** et ne publie pas de preuve d'exploitation avant
qu'un correctif soit disponible.

## Périmètre

Sont concernés :

- le bot (`src/`) : commandes, permissions, modération, isolation entre serveurs ;
- le site (`src/web/`) : authentification admin, paiement Stripe, webhook,
  génération et vérification des clés, échappement HTML, limitation de débit ;
- le stockage des secrets : rien de sensible ne doit apparaître dans les logs,
  les embeds, les pages ou les exports.

Ne sont **pas** des vulnérabilités du projet :

- une instance auto-hébergée dont le `.env` a fuité ou dont le serveur est mal
  configuré ;
- l'absence de 2FA côté Discord ;
- du spam ou du raid rendus possibles par une configuration d'automodération
  désactivée par l'administrateur du serveur ;
- les dépendances : signale-les en amont, puis préviens-nous pour qu'on mette à
  jour le verrou.

## Bonnes pratiques d'exploitation

- `.env` n'est jamais commité ; garde-le hors du dossier servi par un proxy.
- `STORE_ADMIN_TOKEN` et `AUTH_ENCRYPTION_KEY` doivent être longues et uniques.
- Une instance de test utilise un token Discord et une base distincts.
- Le site expose `/admin` : place-le derrière HTTPS, jamais en clair sur Internet.
