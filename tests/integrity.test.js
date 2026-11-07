'use strict';
// tests/integrity.test.js — le bot est-il complet et publiable ?
//
// Ces vérifications attrapent les pannes qui n'écrivent aucune erreur visible :
// un module qui ne se charge plus (commande absente de Discord), deux commandes
// du même nom (l'une disparaît en silence), un dépassement du budget de 100
// commandes globales (aucune publication n'aboutit), une option mal formée
// (Discord répond 50035 au déploiement), une variable d'environnement non
// documentée.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { Events } = require('discord.js');
const cron = require('node-cron');

const {
  loadModules, moduleKind, getJsFiles,
} = require('../src/core/registry');
const {
  validateEnv, assertCommandBudget, duplicateCommandNames, mongoOptions,
  autoIndexEnabled, MAX_GLOBAL_COMMANDS,
} = require('../src/core/kernel');
const {
  cooldown, ownerOnly, guildOnly, runGuards,
} = require('../src/core/guards');
const { toUserMessage, UserFacingError, NotFoundError } = require('../src/core/errors');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const quietLogger = { error() {}, warn() {}, info() {}, debug() {} };

// Chargé une seule fois : 99 commandes + 31 événements + 14 crons.
const commands = loadModules(path.join(SRC, 'commands'), { logger: quietLogger });
const events = loadModules(path.join(SRC, 'events'), { logger: quietLogger });
const crons = loadModules(path.join(SRC, 'crons'), { logger: quietLogger });

const commandNames = commands.commands.map(entry => entry.mod.data?.name).filter(Boolean);

// Règles Discord pour les options (nom, description, ordre des obligatoires).
function assertOptions(options, prefix) {
  assert.ok(Array.isArray(options), `${prefix} : options illisibles`);
  assert.ok(options.length <= 25, `${prefix} : ${options.length} options (25 maximum)`);
  let optionalSeen = null;
  for (const option of options || []) {
    assert.match(option.name, /^[-_\p{L}\p{N}]{1,32}$/u, `${prefix}${option.name || '?'} : nom invalide`);
    assert.strictEqual(option.name, option.name.toLowerCase(), `${prefix}${option.name} : nom non minuscule (refus Discord)`);
    assert.strictEqual(typeof option.description, 'string', `${prefix}${option.name} : description absente`);
    assert.ok(option.description.length >= 1 && option.description.length <= 100,
      `${prefix}${option.name} : description de ${option.description?.length} caractère(s)`);
    if (!option.required && !optionalSeen) optionalSeen = option.name;
    assert.ok(!(option.required && optionalSeen),
      `${prefix}${option.name} : option obligatoire après l'option facultative « ${optionalSeen} » (refus Discord 50035)`);
    if (option.options) assertOptions(option.options, `${prefix}${option.name}.`);
  }
}

// Toutes les variables d'environnement lues dans src/ doivent être documentées.
function envKeysUsedInSource() {
  const keys = new Set();
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith('.js')) files.push(full);
    }
  })(SRC);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) keys.add(match[1]);
  }
  return keys;
}

const checks = [
  // ── Chargement ────────────────────────────────────────────────────────────
  {
    name: 'toutes les commandes se chargent (aucun require en échec)',
    run() {
      assert.deepStrictEqual(commands.failed, [], `échecs : ${commands.failed.map(f => f.file).join(', ')}`);
      assert.ok(commands.commands.length > 0, 'aucune commande chargée');
    },
  },
  {
    name: 'tous les événements se chargent',
    run() {
      assert.deepStrictEqual(events.failed, [], `échecs : ${events.failed.map(f => f.file).join(', ')}`);
      assert.ok(events.events.length > 0, 'aucun événement chargé');
    },
  },
  {
    name: 'tous les crons se chargent',
    run() {
      assert.deepStrictEqual(crons.failed, [], `échecs : ${crons.failed.map(f => f.file).join(', ')}`);
      assert.ok(crons.crons.length > 0, 'aucun cron chargé');
    },
  },

  // ── Contrat des commandes ────────────────────────────────────────────────
  {
    name: 'aucun nom de commande en double',
    run() {
      assert.deepStrictEqual(duplicateCommandNames(commandNames), []);
    },
  },
  {
    name: `budget Discord respecté (${commandNames.length}/${MAX_GLOBAL_COMMANDS})`,
    run() {
      const budget = assertCommandBudget(commandNames.map(name => ({ name })));
      assert.ok(budget.ok, `${budget.count} commandes pour ${budget.max} autorisées — en trop : ${budget.overflow.join(', ')}`);
    },
  },
  {
    name: 'chaque commande est publiable (nom, description, options)',
    run() {
      assert.strictEqual(new Set(commandNames).size, commandNames.length);
      for (const entry of commands.commands) {
        const data = entry.mod.data;
        const label = `${data?.name || path.basename(entry.file)}`;
        assert.match(label, /^[-_\p{L}\p{N}]{1,32}$/u, `${label} : nom invalide pour Discord`);
        assert.strictEqual(label, label.toLowerCase(), `${label} : nom non minuscule (refus Discord)`);
        assert.ok(data.description && data.description.length <= 100,
          `${label} : description de ${data.description?.length} caractère(s)`);
        const json = data.toJSON();
        if (json.options) assertOptions(json.options, `${label} `);
      }
    },
  },
  {
    name: 'defineCommand applique les garde-fous et n’expose aucune erreur brute',
    async run() {
      const { defineCommand } = require('../src/core/defineCommand');

      const refusals = [];
      const denied = defineCommand({
        data: { name: 'demo', toJSON: () => ({ name: 'demo' }) },
        meta: { ownerOnly: true },
        execute: async () => { throw new Error('ne doit pas être exécutée'); },
      });
      const interaction = {
        commandName: 'demo', user: { id: 'pas-un-owner' }, replied: false, deferred: false,
        reply: async (payload) => { refusals.push(payload); interaction.replied = true; },
      };
      await denied.execute(interaction, {});
      assert.strictEqual(refusals.length, 1, 'aucun refus renvoyé à l’utilisateur');
      assert.match(JSON.stringify(refusals[0]), /owners/i);

      const crashes = [];
      const boom = defineCommand({
        data: { name: 'boom', toJSON: () => ({ name: 'boom' }) },
        meta: {},
        execute: async () => { throw new Error('SECRET_INTERNE_connexion_refusee'); },
      });
      const second = {
        commandName: 'boom', user: { id: 'u' }, replied: false, deferred: false,
        reply: async (payload) => { crashes.push(payload); second.replied = true; },
      };
      await boom.execute(second, {});
      assert.strictEqual(crashes.length, 1, 'une commande en erreur doit répondre');
      assert.ok(!JSON.stringify(crashes[0]).includes('SECRET_INTERNE'), 'message technique exposé à l’utilisateur');
    },
  },
  {
    name: 'chaque commande appartient à une catégorie',
    run() {
      for (const entry of commands.commands) {
        assert.ok(entry.category && entry.category !== 'racine',
          `${entry.mod.data?.name} : hors catégorie (${entry.category})`);
      }
    },
  },

  // ── Événements et crons ──────────────────────────────────────────────────
  {
    name: 'chaque événement est un événement Discord connu',
    run() {
      const known = new Set(Object.values(Events));
      for (const entry of events.events) {
        assert.ok(known.has(entry.mod.name), `événement inconnu : ${entry.mod.name} (${path.basename(entry.file)})`);
        assert.strictEqual(typeof entry.mod.execute, 'function', `${entry.mod.name} : execute manquant`);
      }
    },
  },
  {
    name: 'les crons ont un nom unique et une expression valide',
    run() {
      const names = crons.crons.map(entry => entry.mod.name);
      assert.strictEqual(new Set(names).size, names.length, 'deux crons portent le même nom');
      for (const entry of crons.crons) {
        assert.ok(cron.validate(entry.mod.schedule), `cron ${entry.mod.name} : expression invalide « ${entry.mod.schedule} »`);
        assert.ok(['primary', 'guilds', undefined].includes(entry.mod.scope),
          `cron ${entry.mod.name} : portée inconnue « ${entry.mod.scope} »`);
      }
    },
  },

  // ── Composants Discord ───────────────────────────────────────────────────
  {
    name: 'aucune ActionRow ne mélange select menu et boutons',
    run() {
      const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-mixed-rows.js')], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.ok(/Total rangées mixtes : 0/.test(out), out.trim().split('\n').slice(0, 6).join(' | '));
    },
  },

  // ── Noyau ────────────────────────────────────────────────────────────────
  {
    name: 'validateEnv signale TOKEN et MONGODB_URI manquants',
    run() {
      const { errors } = validateEnv({});
      assert.strictEqual(errors.length, 2);
      assert.ok(errors.some(error => /TOKEN/.test(error)));
      assert.ok(errors.some(error => /MONGODB_URI/.test(error)));
    },
  },
  {
    name: 'validateEnv accepte un environnement complet',
    run() {
      const { errors } = validateEnv({ TOKEN: 'x', MONGODB_URI: 'mongodb://localhost' });
      assert.deepStrictEqual(errors, []);
    },
  },
  {
    name: 'assertCommandBudget accepte 100 et refuse 101',
    run() {
      const atLimit = assertCommandBudget(Array.from({ length: 100 }, (_, i) => ({ name: `c${i}` })));
      assert.ok(atLimit.ok);
      assert.strictEqual(atLimit.headroom, 0);
      const over = assertCommandBudget(Array.from({ length: 101 }, (_, i) => ({ name: `c${i}` })));
      assert.strictEqual(over.ok, false);
      assert.deepStrictEqual(over.overflow, ['c100']);
    },
  },
  {
    name: 'mongoOptions applique les défauts et les surcharges',
    run() {
      const defaults = mongoOptions({});
      assert.strictEqual(defaults.serverSelectionTimeoutMS, 15_000);
      assert.strictEqual(defaults.waitQueueTimeoutMS, 10_000);
      assert.strictEqual(defaults.maxPoolSize, undefined);
      const custom = mongoOptions({ MONGO_MAX_POOL: '25', MONGO_SOCKET_TIMEOUT_MS: '1000', MONGO_WAIT_QUEUE_MS: 'oops' });
      assert.strictEqual(custom.maxPoolSize, 25);
      assert.strictEqual(custom.socketTimeoutMS, 1000);
      assert.strictEqual(custom.waitQueueTimeoutMS, 10_000, 'valeur invalide : défaut attendu');
    },
  },
  {
    name: 'autoIndexEnabled interprète les valeurs désactivantes',
    run() {
      for (const raw of ['0', 'false', 'OFF', 'non', 'no']) {
        assert.strictEqual(autoIndexEnabled({ MONGO_AUTO_INDEX: raw }), false, raw);
      }
      assert.strictEqual(autoIndexEnabled({}), true);
      assert.strictEqual(autoIndexEnabled({ MONGO_AUTO_INDEX: 'true' }), true);
    },
  },

  // ── Garde-fous ───────────────────────────────────────────────────────────
  {
    name: 'cooldown refusé au second appel, puis rendu par reset',
    run() {
      const guard = cooldown(60_000);
      const ctx = { command: 'demo', interaction: { user: { id: 'u1' } } };
      assert.strictEqual(guard.check(ctx).ok, true);
      const second = guard.check(ctx);
      assert.strictEqual(second.ok, false);
      assert.strictEqual(second.code, 'COOLDOWN');
      guard.reset();
      assert.strictEqual(guard.check(ctx).ok, true);
    },
  },
  {
    name: 'le cooldown est isolé par utilisateur et par portée',
    run() {
      const guard = cooldown(60_000);
      assert.strictEqual(guard.check({ command: 'demo', interaction: { user: { id: 'a' } } }).ok, true);
      assert.strictEqual(guard.check({ command: 'demo', interaction: { user: { id: 'b' } } }).ok, true);
      const byGuild = cooldown(60_000, { scope: 'guild' });
      assert.strictEqual(byGuild.check({ command: 'demo', interaction: { user: { id: 'a' }, guildId: 'g1' } }).ok, true);
      assert.strictEqual(byGuild.check({ command: 'demo', interaction: { user: { id: 'b' }, guildId: 'g1' } }).ok, false);
    },
  },
  {
    name: 'ownerOnly refuse un utilisateur non owner',
    run() {
      const guard = ownerOnly(['owner-1']);
      assert.strictEqual(guard.check({ interaction: { user: { id: 'owner-1' } } }).ok, true);
      const denied = guard.check({ interaction: { user: { id: 'autre' } } });
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.code, 'OWNER_ONLY');
    },
  },
  {
    name: 'guildOnly refuse une interaction en message privé',
    run() {
      assert.strictEqual(guildOnly().check({ interaction: { guildId: 'g1' } }).ok, true);
      assert.strictEqual(guildOnly().check({ interaction: {} }).ok, false);
    },
  },
  {
    name: 'runGuards s’arrête au premier refus',
    run() {
      const calls = [];
      const guards = [
        { name: 'a', check: () => { calls.push('a'); return { ok: true }; } },
        { name: 'b', check: () => { calls.push('b'); return { ok: false, code: 'B', message: 'non' }; } },
        { name: 'c', check: () => { calls.push('c'); return { ok: true }; } },
      ];
      return runGuards(guards, { interaction: {}, command: 'demo' }).then(result => {
        assert.strictEqual(result.code, 'B');
        assert.deepStrictEqual(calls, ['a', 'b']);
      });
    },
  },

  // ── Erreurs ──────────────────────────────────────────────────────────────
  {
    name: 'toUserMessage n’expose jamais un message technique',
    run() {
      assert.strictEqual(toUserMessage(new Error('ECONNREFUSED 10.0.0.1')), 'Une erreur est survenue. Réessaie dans quelques instants.');
      assert.strictEqual(toUserMessage(new NotFoundError('Salon introuvable')), 'Salon introuvable');
      assert.strictEqual(toUserMessage(new UserFacingError('Action impossible')), 'Action impossible');
    },
  },

  // ── Registre ─────────────────────────────────────────────────────────────
  {
    name: 'moduleKind classe commande, cron et événement',
    run() {
      assert.strictEqual(moduleKind({ data: {}, execute() {} }), 'command');
      assert.strictEqual(moduleKind({ name: 'x', schedule: '* * * * *', execute() {} }), 'cron');
      assert.strictEqual(moduleKind({ name: 'y', execute() {} }), 'event');
      assert.strictEqual(moduleKind({ helper: true }), null);
    },
  },
  {
    name: 'la découverte des fichiers est déterministe',
    run() {
      const first = getJsFiles(path.join(SRC, 'commands'));
      const second = getJsFiles(path.join(SRC, 'commands'));
      assert.deepStrictEqual(first, second);
      assert.deepStrictEqual([...first].sort(), first, 'ordre non trié : les listeners changeraient d’ordre selon la machine');
    },
  },

  // ── Environnement documenté ──────────────────────────────────────────────
  {
    name: '.env.example existe et contient les variables obligatoires',
    run() {
      const file = path.join(ROOT, '.env.example');
      assert.ok(fs.existsSync(file), '.env.example absent');
      const content = fs.readFileSync(file, 'utf8');
      for (const required of ['TOKEN', 'MONGODB_URI', 'OWNER_IDS']) {
        assert.ok(new RegExp(`^#?\\s*${required}=`, 'm').test(content), `${required} non documentée`);
      }
    },
  },
  {
    name: 'toutes les variables lues dans src/ sont documentées',
    run() {
      const content = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
      const documented = new Set([...content.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(match => match[1]));
      const missing = [...envKeysUsedInSource()].filter(key => !documented.has(key));
      assert.deepStrictEqual(missing, [], `non documentées : ${missing.join(', ')}`);
    },
  },
];

module.exports = { checks };
