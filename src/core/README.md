# 🧠 REZO v2 — Noyau (`src/core/`)

Le noyau v2 est la couche sur laquelle tourne **tout** le bot. Il est
**rétro-compatible** : les 99 commandes et les événements historiques
continuent de fonctionner tels quels, et les nouveaux modules peuvent adopter le
contrat v2 progressivement.

## Fichiers

| Fichier | Rôle |
|---|---|
| `kernel.js` | Démarrage complet : env, client Discord, loaders, MongoDB, déploiement, signaux d'arrêt. |
| `registry.js` | Découverte et classification des modules (`commande` / `cron` / `événement`). |
| `logger.js` | Journalisation structurée (niveaux, tags, couleurs, mesure de durée). |
| `errors.js` | Hiérarchie d'erreurs + réponse d'erreur uniforme aux interactions. |
| `guards.js` | Garde-fous réutilisables : guilde, permissions, owner, cooldown, licence. |
| `defineCommand.js` | Contrat de commande v2 (avec guards et capture d'erreur automatiques). |
| `ui.js` | Point d'entrée unique pour l'apparence (marque + embeds + cartes). |
| `latencyGuard.js` | Filet d'acquittement : une commande lente ne finit plus en « L'application ne répond pas ». |
| `sharding.js` | Mode shardé : plan de démarrage (auto/off/N), lancement du `ShardingManager`, détection du shard primaire. |

Le point d'entrée `src/index.js` ne fait plus qu'appeler `kernel.boot()`.

## Écrire une commande v2

```js
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { defineCommand } = require('../../core/defineCommand');
const { successEmbed } = require('../../core/ui');

module.exports = defineCommand({
  data: new SlashCommandBuilder()
    .setName('exemple')
    .setDescription('Une commande v2'),

  meta: {
    category: 'utilitaires',        // optionnel : remplace le nom du dossier
    guildOnly: true,                // uniquement en serveur
    permissions: [PermissionFlagsBits.ManageGuild],
    botPermissions: [PermissionFlagsBits.ManageRoles],
    license: false,                 // true → garde-fou licence sur cette commande
    cooldown: 5000,                 // 5 s par utilisateur
    defer: 'reply',                 // deferReply automatique
    ephemeral: true,                // defer éphémère (défaut : true)
  },

  async execute(interaction, client, ctx) {
    await interaction.editReply({ embeds: [successEmbed('OK', 'Ça marche.')] });
  },
});
```

Le module renvoyé a exactement la forme `{ data, execute }` attendue par le
chargeur : v1 et v2 cohabitent sans configuration.

## Filet d'acquittement (`latencyGuard.js`)

Discord exige une réponse sous **3 s**. Une commande qui interroge la base,
dessine une carte ou appelle un service externe dépasse ce budget dès que le
pool Mongo sature (`MONGO_WAIT_QUEUE_MS`, 10 s par défaut) ou qu'un cache est
froid.

Le routeur (`events/core/interactionCreate.js`) enveloppe donc l'exécution dans
`runWithAutoAck()` :

- commande rapide → **strictement rien ne change** (aucun defer, réponse normale) ;
- au-delà de 2,3 s → l'interaction est acquittée à sa place et le premier
  `reply()` de la commande devient un `editReply()` : l'utilisateur voit
  l'accusé de réception puis le résultat, au lieu d'un échec ;
- un `showModal()` trop tardif (impossible après acquittement) devient un message
  invitant à relancer, au lieu d'une exception ;
- l'authentification (`authGate`) n'est **pas** enveloppée : elle peut ouvrir un
  modal immédiatement.

Le dépassement est journalisé (`[latence] /nom a dépassé 2300 ms`) pour
distinguer les vraies commandes lentes des autres. Aucune commande n'a été
modifiée : le filet vit à un seul endroit.

## Garde-fous (`guards.js`)

- `guildOnly()`, `ownerOnly()`, `requireUserPermissions([...])`, `requireBotPermissions([...])`, `cooldown(ms, { scope })`, `licenseRequired({ feature })`.
- `runGuards(guards, ctx)` exécute dans l'ordre et s'arrête au premier refus.
- `guardsFromMeta(meta, data)` construit les guards standards à partir de `meta`
  (utilisé automatiquement par `defineCommand`).

## Erreurs (`errors.js`)

- `new UserFacingError('message')` → le message peut être montré à l'utilisateur.
- Toute autre `BotError` non `expose` affiche un message générique (pas de fuite technique).
- `handleInteractionError(interaction, err)` répond proprement selon l'état de
  l'interaction (jamais répondu / deferred / déjà répondu) et journalise la cause.

## Sharding (`sharding.js`)

```bash
npm run start:shards     # plusieurs processus Discord, un seul bot (voir SHARDING.md)
SHARD_COUNT=off npm start  # processus unique (comportement historique)
```

En mode shardé, le noyau ne publie les slash commands que sur le **shard 0**
(`isPrimaryShard`). Les crons ont une portée : `scope: 'primary'` (défaut) pour
les tâches globales (entretien de la base, resets, REST), `scope: 'guilds'` pour
celles qui ont besoin du cache local (anniversaires, trésors, paliers YouTube,
sites) — ces dernières tournent sur chaque shard, sur leurs propres serveurs.

Les helpers `visibleGuildIds`, `ownsGuild` et `guildScope` évitent les doublons
et les états marqués « envoyé » par le mauvais processus. La connexion Mongo est
bornée par processus (`MONGO_MAX_POOL`). Aucun de ces garde-fous ne s'applique
en mode simple : le comportement d'origine est inchangé.

## Entretien de la base (`utils/dbMaintenance.js`)

Chaque famille de documents (journaux captcha, bumps, tickets modmail, mémoire
IA…) a une **durée de vie** ; le cron `crons/dbMaintenance.js` l'applique chaque
nuit à 04:00 et rejoue les index. Le détail est dans `BASE_DE_DONNEES.md`, et
l'état réel s'affiche dans `/help` → 🩺 **Diagnostic**.

## Crons (`src/crons/`)

Un cron est un module `{ name, schedule, execute }` (expression `node-cron`) :

```js
module.exports = {
  name: 'mon-cron',
  schedule: '*/15 * * * *',
  async execute(client) { /* … */ },
};
```

Le noyau les planifie automatiquement et capture leurs erreurs.

## Vérifier

```bash
node tests/v2-core.js     # tests du noyau v2
node tests/load-all.js    # chargement de tous les modules
```
