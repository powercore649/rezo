# Site marchand REZO — licences

Le site n'est plus une page figée : c'est un serveur HTTP qui rend chaque page à
la requête, enregistre les commandes, encaisse le paiement et **écrit de vraies
clés de licence dans la base du bot**. Une clé achetée ici s'active ensuite sur
Discord avec `/license`.

## Ce que le site sait faire

| Route | Rôle |
| --- | --- |
| `GET /` | Accueil : modules, prix réels, FAQ |
| `GET /tarifs` | Paliers (Essentiel, Standard, Réseau) et offres avec formulaire d'achat |
| `GET /packs` | Les packs tout compris (licence + modules + prestations) avec formulaire d'achat |
| `GET /devis` | Formulaire complet de devis pour le pack REZO.net (sur devis) |
| `POST /devis` | Envoie la demande de devis au propriétaire par e-mail |
| `GET /commandes` | Explorateur des commandes du bot (recherche + domaines), alimenté par `src/commands` |
| `GET /verifier?cle=…` | État d'une clé : disponible, active, en grâce, expirée, révoquée — avec palier et sièges |
| `POST /acheter` | Crée la commande puis redirige vers Stripe (ou vers le suivi en mode manuel) |
| `GET /commande/:jeton` | Suivi de commande + clé délivrée |
| `GET /commande/:jeton/cle.txt` | La clé en fichier texte |
| `POST /stripe/webhook` | Confirmation signée, idempotente |
| `GET /admin` | Administration : approuver, refuser, envoyer la clé |
| `POST /admin` | Connexion au panneau (jeton → cookie `HttpOnly`) |
| `POST /admin/orders/:jeton/encaisse` | Approuve, émet la clé et l'envoie par e-mail |
| `POST /admin/orders/:jeton/refuser` | Refuse une commande en attente |
| `POST /admin/orders/:jeton/email` | Renvoie la clé par e-mail |
| `GET /statut` | État du bot et du site : latence, serveurs, membres, uptime, services configurés |
| `GET /sitemap.xml` | Plan du site (référencé par `robots.txt`) |
| `GET /api/plans`, `GET /api/commandes/:jeton`, `GET /api/statut`, `GET /health` | API JSON |

## Nouveau système de licence (paliers, sièges, grâce)

Le site ne définit aucun prix ni aucune règle en dur : il lit `src/utils/licensePlans.js`
(offres) et `src/utils/licenseCore.js` (paliers, sièges, grâce), donc les pages
reflètent toujours ce que le bot applique réellement.

- **Paliers** — Essentiel, Standard, Réseau. Le palier fixe les modules ouverts ;
  `/tarifs` affiche pour chacun la liste réelle des commandes débloquées. Un
  palier supérieur ouvre tout ce que les précédents ouvraient.
- **Sièges** — une clé Standard couvre 1 serveur, une clé Réseau en couvre 3.
  La clé émise porte donc `kind`, `maxGuilds` et `graceDays` ; la page de suivi
  et `/verifier` montrent les sièges utilisés (ex. `2 / 3`).
- **Grâce** — 3 jours (Pro), 7 jours (Business, Réseau, illimitée) pendant
  lesquels l'accès reste ouvert après l'expiration. `/verifier` distingue
  « active », « en grâce », « expirée » et affiche la fin de la grâce.
- **Obtention** — la page de commande explique l'activation réelle :
  `/license` → **Activer une clé** → coller la clé, en rappelant le nombre
  de serveurs couverts. Le fichier `cle.txt` reprend ces informations.

Les types `partner`, `owner` et `trial` ne sont jamais vendus : ils n'apparaissent
pas dans le site, même si le bot sait les émettre.

## Démarrage

Dans `.env` :

```ini
STORE_PORT=3200
STORE_HOST=0.0.0.0
SITE_URL=https://rezo.mondomaine.fr          # adresse publique, sans barre finale
```

`SITE_URL` est lue par `src/utils/siteUrl.js` : elle sert aux liens du bot
(`/help`, `/botinfo`, message d'arrivée, réseau de bumps), aux balises
canonique/`og:url` des pages et au `sitemap.xml`. `STORE_PUBLIC_URL` reste
accepté (nom historique) et sert de repli.

Le bot démarre le site sur le shard principal (comme le portail anti-VPN).
`STORE_PORT` doit être différent de `ANTIVPN_PORT`.

## Hébergement sur un port (panneau type Pterodactyl / HidenCloud)

Le site écoute sur le port alloué à ton serveur, comme n'importe quel process :

```ini
STORE_PUBLIC_URL=http://noel.hidencloud.com:24667
STORE_HOST=0.0.0.0               # écouter sur toutes les interfaces
```

Quand l'URL publique contient un port explicite, `STORE_PORT` devient inutile :
le site écoute sur ce même port. On peut toujours le forcer (`STORE_PORT=24667`),
mais les deux valeurs doivent alors concorder — sinon le site écoute ailleurs
que l'adresse annoncée aux clients.

```ini
STORE_TRUST_PROXY=1              # seulement si un proxy TLS est devant
```

Vérification après redémarrage : `http://ton-hote:port/health` doit répondre
`{"ok":true,...}`. Un port qui refuse la connexion signifie que rien n'écoute
encore (mauvais port, ou process arrêté) — ce n'est pas un problème de DNS.

Si le port est déjà pris par un autre service de ton serveur, choisis-en un
autre : `STORE_PORT` et `ANTIVPN_PORT` doivent être distincts.

## Une URL publique gratuite

Aucune adresse n'est écrite dans le code : changer de domaine = changer
`SITE_URL` puis redémarrer. Trois options gratuites, selon ce dont tu disposes :

**1. Le sous-domaine de ton hébergeur** (le plus simple)

Pterodactyl/HidenCloud fournissent souvent un nom d'hôte pour l'allocation du
serveur. C'est déjà une URL personnalisable, gratuite et stable :

```ini
SITE_URL=http://noel.hidencloud.com:24667
STORE_HOST=0.0.0.0
```

**2. Un sous-domaine gratuit chez un fournisseur de DNS**

[DuckDNS](https://www.duckdns.org) (`rezo.duckdns.org`), [DigitalPlat](https://dash.domain.digitalplat.org)
(`*.dpdns.org`, déjà utilisé par le projet) ou [is-a.dev](https://www.is-a.dev)
(`rezo.is-a.dev`) attribuent un sous-domaine gratuit. Il faut ton compte : le nom
ne peut pas être réservé à ta place. Ensuite, pointe le sous-domaine vers l'IP
de l'hébergeur (`A`) ou vers l'hôte fourni (`CNAME`), puis :

```ini
SITE_URL=http://rezo.duckdns.org:24667
```

Sans proxy TLS, l'adresse reste en `http://` : parfait pour tester, insuffisant
pour encaisser en live chez Stripe.

**3. Cloudflare Tunnel : HTTPS gratuit, sans domaine**

Sur la machine qui fait tourner le site :

```bash
cloudflared tunnel --url http://localhost:3200
```

Cloudflare affiche une URL `https://<nom-aléatoire>.trycloudflare.com` déjà en
HTTPS, sans compte ni carte bancaire. Recopie-la dans `SITE_URL`, mets
`STORE_TRUST_PROXY=1` (le tunnel termine le TLS), puis redémarre. Limite
connue : l'URL change à chaque relance du tunnel — pour une adresse stable, il
faut un tunnel nommé, donc un domaine qui t'appartient.

Dans les trois cas, vérifie après redémarrage :

```bash
curl https://ton-adresse/health      # {"ok":true,…}
curl https://ton-adresse/statut      # page lisible par un humain
```

Les pages privées (`/commande/:jeton`, `/admin`) sont en `noindex,nofollow` :
un moteur de recherche ne peut pas y exposer une clé. Les pages publiques
exposent `canonical` et `og:url` sur l'adresse configurée, donc le lien
partagé sur Discord affiche le bon titre et la bonne description.

**HTTPS** : Stripe attend une URL de retour HTTPS en mode live. Un port http
direct fonctionne en test, mais pour encaisser réellement, place le site
derrière un proxy TLS (Cloudflare, Nginx) ou un tunnel : dans ce cas mets
`STORE_PUBLIC_URL=https://…` et `STORE_TRUST_PROXY=1`, sinon le site croira
que la requête est en http et construira de mauvais liens de retour.

Pour héberger la boutique séparément du bot :

```bash
npm run site          # node scripts/store-server.js
```

Le site a besoin de `MONGODB_URI` : sans base, il refuse de démarrer plutôt que
de vendre des clés qu'il ne pourrait pas enregistrer.

## Encaissement

### Stripe (recommandé)

1. Dashboard Stripe → **Developers → API keys** → copier la clé secrète.
2. `STRIPE_SECRET_KEY=sk_live_…` dans `.env`.
3. **Developers → Webhooks → Add endpoint** :
   - URL : `https://ton-domaine/stripe/webhook`
   - Événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`
4. Copier le **signing secret** (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET`.

Le webhook refuse toute requête dont la signature ne correspond pas et toute
requête de plus de cinq minutes (anti-rejeu). Un événement rejoué par Stripe ne
crée jamais de seconde clé.

Filet de sécurité : en revenant du paiement, la page de suivi relit la session
auprès de Stripe et délivre la clé si le paiement est confirmé. Un webhook en
retard (ou mal configuré) ne laisse donc pas un client payé sans clé.

### Sans Stripe : validation manuelle

Sans `STRIPE_SECRET_KEY`, `POST /acheter` crée la commande et renvoie le client
vers sa page de suivi (« en attente de paiement »). Tu tranches ensuite depuis
la **page d'administration**, qui ne demande aucun outil :

1. `STORE_ADMIN_TOKEN=un-jeton-long-et-secret` dans `.env`.
2. Ouvre `/admin` sur le site et colle ce jeton : il devient un cookie
   `HttpOnly` valable 12 h, jamais une adresse dans l'historique.
3. Chaque commande affiche **Approuver et envoyer** (émet la clé puis l'envoie
   par e-mail) ou **Refuser** (annule, aucune clé). Les commandes payées
   proposent **Renvoyer la clé**.

La page liste aussi les filtres (en attente / payées / annulées), l'adresse e-mail du client, la clé émise et la date du dernier envoi.

Sans navigateur, les mêmes actions existent en HTTP :

```bash
curl -X POST https://ton-domaine/admin/orders/<jeton>/encaisse \
     -H "Authorization: Bearer $STORE_ADMIN_TOKEN"
curl -X POST https://ton-domaine/admin/orders/<jeton>/refuser  -H "Authorization: Bearer $STORE_ADMIN_TOKEN"
curl -X POST https://ton-domaine/admin/orders/<jeton>/email    -H "Authorization: Bearer $STORE_ADMIN_TOKEN"
```

`<jeton>` est la valeur du lien de suivi de la commande. La clé apparaît
immédiatement sur la page du client (elle s'actualise toute seule).

### Envoi de la clé par e-mail

La clé part automatiquement à l'approbation, si le client a laissé une adresse :

```ini
RESEND_API_KEY=re_…                  # resend.com → API Keys
STORE_MAIL_FROM=REZO <licences@ton-domaine.fr>
STORE_MAIL_REPLY_TO=                 # facultatif
```

L'expéditeur doit être un domaine **vérifié chez Resend**. Sans ces deux
variables, la clé est quand même émise : elle s'affiche sur la page du client et
la page d'administration annonce « E-mails désactivés ». Un échec d'envoi ne
bloque jamais la commande, il est seulement signalé.

### Brevo — quand on n'a pas de domaine

Resend exige un **domaine vérifié**. Brevo, lui, valide une simple **adresse
expéditrice** : c'est la solution quand on ne possède aucun domaine.

```ini
BREVO_API_KEY=xkeysib-…            # app.brevo.com → SMTP & API → API Keys
STORE_MAIL_FROM=REZO <mon-adresse@exemple.fr>
STORE_MAIL_PROVIDER=brevo          # facultatif : brevo | resend
```

1. app.brevo.com → **Senders, Domain & IPs → Add a sender** → ton adresse.
2. Clique le lien de vérification reçu par e-mail.
3. Crée une clé API **version v3** et colle-la dans `BREVO_API_KEY`.

Offre gratuite : 300 e-mails par jour, largement suffisant pour des licences.
Si `BREVO_API_KEY` et `RESEND_API_KEY` coexistent, **Brevo gagne** — sauf si
`STORE_MAIL_PROVIDER=resend` le force. Une erreur fréquente chez Brevo :
« sender not verified » → l'adresse expéditrice n'a pas été validée à l'étape 2.

### Vérifier qu'un vrai message part

```bash
node scripts/mail-test.js --to=ton-adresse@exemple.fr
# ou : npm run mail:test -- --to=ton-adresse@exemple.fr
```

Le script utilise le même module que le site, envoie une clé de test, puis
interroge Resend pour connaître l'état réel du message (`sent`, `delivered`,
`bounced`…). `--dry` construit le message sans rien envoyer. La clé API n'est
jamais affichée, seulement sa présence.

## Prix

Modifiables sans toucher au code, en centimes :

```ini
SITE_PRICE_EVENT_CENTS=290
SITE_PRICE_PRO_CENTS=990
SITE_PRICE_BUSINESS_CENTS=2490
SITE_PRICE_NETWORK_CENTS=3990
SITE_PRICE_LIFETIME_CENTS=4990

# Packs tout compris (page /packs) : licence + installation, visuels, support.
SITE_PRICE_PACK_DECOUVREUR_CENTS=690
SITE_PRICE_PACK_LANCEMENT_CENTS=1490
SITE_PRICE_PACK_PREMIER_REZO_CENTS=1990
SITE_PRICE_PACK_COMMUNAUTE_CENTS=3990
SITE_PRICE_PACK_RESEAU_CENTS=5990
SITE_PRICE_PACK_INTEGRAL_CENTS=17990

# Destinataire des demandes de devis (par défaut : propriétaire du bot).
STORE_QUOTE_TO=raphwieczorek@gmail.com
```

## Sécurité

- Aucun compte, aucun mot de passe : le lien de suivi contient un jeton de
  32 octets, seul moyen de lire la clé.
- Une commande impayée ne produit jamais de clé ; une commande payée mais dont
  l'émission échoue repasse en attente (jamais d'argent encaissé sans clé).
- Corps de requête borné (16 Ko), débit limité par IP, CSP stricte, aucune
  ressource externe, `no-store` partout.
- Le jeton admin est comparé à temps constant et n'est jamais journalisé.
- Les données de carte ne transitent pas par le site : Stripe les traite.

## Vérifications

```bash
npm run test:store
```

Le test couvre le format des clés, l'idempotence du paiement, la signature
Stripe, les routes, l'échappement HTML et le fait qu'une commande impayée ne
donne accès à aucune clé.
