'use strict';
// scripts/deploy-commands.js — Enregistre l'arbre de commandes auprès de Discord.
//
// L'arbre est construit par le NOYAU v2 (src/core/kernel.js → loadCommands), donc
// exactement la même règle que le bot au démarrage : une seule source de vérité,
// plus de chargeur dupliqué ici.
//
// À noter : le bot déploie déjà ses commandes automatiquement à chaque démarrage
// (événement `ready`). Ce script sert uniquement à forcer/vérifier le déploiement
// sans lancer le bot — il ne se connecte PAS à MongoDB et n'ouvre aucune gateway.
//
// Usage :
//   node scripts/deploy-commands.js                 → global (jusqu'à ~1h de propagation)
//   node scripts/deploy-commands.js --guild <ID>    → + copie instantanée sur un serveur (TEST)
//   node scripts/deploy-commands.js --clear-guild <ID> → supprime la copie locale (fin des doublons)
//   node scripts/deploy-commands.js --check         → n'écrit rien, affiche l'état actuel sur Discord
//   node scripts/deploy-commands.js --dry           → hors-ligne : affiche seulement l'arbre local (aucun réseau)
//
// ⚠️ Une commande enregistrée en global ET sur un serveur s'affiche DEUX FOIS
// dans la liste de ce serveur. `--guild` est donc réservé aux tests : le
// démarrage du bot nettoie automatiquement la copie du serveur DEV_GUILD_ID.
//
// Le token n'est jamais affiché.

require('dotenv').config();
const path = require('path');
const { Collection, REST, Routes } = require('discord.js');

const { loadCommands } = require('../src/core/kernel');
const { createLogger } = require('../src/core/logger');

// ── Arbre de commandes : la même règle que le noyau v2 ──────────────────────
const log = createLogger('deploy');
const fakeClient = { commands: new Collection() };
const { data: commandData, failed } = loadCommands(fakeClient, path.join(__dirname, '..', 'src'), { logger: log });
if (failed.length) log.warn(`${failed.length} fichier(s) de commande en échec de chargement`);

const argv      = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const dryRun    = argv.includes('--dry');
const guildFlag = argv.includes('--guild') ? argv[argv.indexOf('--guild') + 1] : null;
const guildArg  = guildFlag || null;
const clearFlag = argv.includes('--clear-guild')
  ? (argv[argv.indexOf('--clear-guild') + 1] || process.env.DEV_GUILD_ID || null)
  : null;

if (dryRun) {
  console.log(`\n📦 ${commandData.length} commande(s) locale(s) (hors-ligne, aucun appel Discord)`);
  process.exit(failed.length ? 1 : 0);
}

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('❌ TOKEN absent de .env');
  process.exit(1);
}

function summarize(list, label) {
  const tickets = list.filter(c => /ticket/i.test(c.name));
  console.log(`\n── ${label} : ${list.length} commande(s) côté Discord`);
  for (const t of tickets) {
    const subs = (t.options || []).filter(o => o.type === 1 || o.type === 2).map(o => o.name);
    console.log(`   /${t.name} → ${subs.length === 0 ? 'aucune sous-commande ✔' : `${subs.length} sous-commande(s) : ${subs.join(', ')}`}`);
  }
  if (tickets.length !== 1) console.log(`   ⚠️ ${tickets.length} commande(s) « ticket » enregistrée(s) — attendu : 1`);
}

(async () => {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const me   = await rest.get(Routes.user('@me'));
  console.log(`🤖 Application : ${me.username} (${me.id})`);

  if (checkOnly) {
    summarize(await rest.get(Routes.applicationCommands(me.id)), 'global');
    if (guildArg) summarize(await rest.get(Routes.applicationGuildCommands(me.id, guildArg)), `serveur ${guildArg}`);
    return;
  }

  if (clearFlag) {
    const before = await rest.get(Routes.applicationGuildCommands(me.id, clearFlag));
    await rest.put(Routes.applicationGuildCommands(me.id, clearFlag), { body: [] });
    console.log(`🧹 ${before.length} copie(s) locale(s) supprimée(s) sur le serveur ${clearFlag} — plus de doublons`);
    return;
  }

  await rest.put(Routes.applicationCommands(me.id), { body: commandData });
  console.log(`✅ ${commandData.length} commande(s) publiée(s) en global (propagation jusqu'à ~1h)`);

  if (guildArg) {
    await rest.put(Routes.applicationGuildCommands(me.id, guildArg), { body: commandData });
    console.log(`⚡ ${commandData.length} commande(s) publiée(s) instantanément sur le serveur ${guildArg}`);
    console.log('⚠️  Ce serveur affichera chaque commande DEUX FOIS (copie locale + globale).');
    console.log(`    Pour revenir à la normale : node scripts/deploy-commands.js --clear-guild ${guildArg}`);
  }

  // ── Relecture : ce que Discord renvoie réellement ──────────────────────────
  summarize(await rest.get(Routes.applicationCommands(me.id)), 'global (relu)');
  if (guildArg) summarize(await rest.get(Routes.applicationGuildCommands(me.id, guildArg)), `serveur ${guildArg} (relu)`);
})().catch(err => {
  console.error('❌ Échec :', err?.message || err);
  process.exit(1);
});
