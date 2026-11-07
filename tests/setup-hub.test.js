'use strict';
// tests/setup-hub.test.js — Salon administrateur et programme d'installation.
//
// À l'arrivée du bot : un salon privé réservé aux administrateurs et un bouton
// « Start here » qui ouvre la liste des modules réellement absents. On vérifie
// ici les rendus et les décisions pures, sans Discord ni MongoDB.

const assert = require('assert');
const hub = require('../src/utils/setupHub');

const GUILD = { name: 'Serveur de test' };
const CLIENT = { user: { username: 'REZO', displayAvatarURL: () => 'https://cdn.example/avatar.png' } };

function moduleEntry(overrides = {}) {
  return {
    key: 'welcome',
    label: 'Message de bienvenue',
    category: 'communaute',
    weight: 2,
    auto: true,
    fix: '/welcome',
    hint: 'Accueillir chaque nouveau membre',
    ok: false,
    ...overrides,
  };
}

function fakeScore(missing = [moduleEntry()], overrides = {}) {
  return {
    percent: 42,
    goal: 90,
    reached: false,
    activeCount: 3,
    moduleCount: 5,
    modules: missing,
    missing,
    categories: [
      { key: 'securite', label: 'Sécurité', emoji: '🛡️', weight: 30, percent: 50, enabled: 1, count: 2 },
      { key: 'communaute', label: 'Accueil & communauté', emoji: '👋', weight: 25, percent: 33, enabled: 1, count: 3 },
    ],
    ...overrides,
  };
}

function componentIds(rows) {
  return rows.flatMap(row => row.toJSON().components.map(component => component.custom_id));
}

// Faux interaction : suffisamment fidèle pour exécuter les vrais handlers
// (accusés de réception, réponses, permissions) sans passer par Discord.
function fakeInteraction({ customId, userId = 'admin', owner = 'owner', admin = true, values = [] }) {
  const calls = { deferred: null, replies: [], edits: [], updates: [], followUps: [] };
  return {
    calls,
    customId,
    values,
    guildId: 'g1',
    guild: {
      id: 'g1',
      name: 'Serveur de test',
      ownerId: owner,
      channels: { cache: new Map() },
      roles: { everyone: { id: 'e' }, cache: new Map() },
      members: { me: { id: 'bot' } },
    },
    user: { id: userId, tag: 'admin#0001' },
    memberPermissions: { has: () => admin },
    inGuild: () => true,
    isMessageComponent: () => true,
    deferred: false,
    replied: false,
    async deferReply() { calls.deferred = 'reply'; this.deferred = true; },
    async deferUpdate() { calls.deferred = 'update'; this.deferred = true; },
    async reply(payload) { calls.replies.push(payload); this.replied = true; return payload; },
    async editReply(payload) { calls.edits.push(payload); return payload; },
    async update(payload) { calls.updates.push(payload); return payload; },
    async followUp(payload) { calls.followUps.push(payload); return payload; },
  };
}

const checks = [
  {
    name: 'le salon d’administration porte un nom fixe et une création unique',
    run() {
      assert.strictEqual(hub.CHANNEL_NAME, 'rezo-admin');
      assert.ok(hub.MAX_SELECT_OPTIONS <= 25, 'un menu Discord accepte 25 options au maximum');
      assert.strictEqual(typeof hub.onGuildJoin, 'function');
      assert.strictEqual(typeof hub.ensureAdminChannel, 'function');
    },
  },
  {
    name: 'le message d’arrivée annonce le bouton Commencer',
    run() {
      const embed = hub.buildStartEmbed({ guild: GUILD, client: CLIENT }).toJSON();
      assert.ok(embed.title.includes('Installer REZO'));
      assert.ok(embed.description.includes('Serveur de test'));
      assert.ok(embed.description.includes('administrateurs'));
      assert.ok(embed.footer.text.includes('REZO'));
      assert.strictEqual(embed.fields.length, 3);

      const ids = componentIds(hub.buildStartRow ? [hub.buildStartRow()] : []);
      assert.ok(ids.includes('setup_start'));
      assert.ok(ids.every(id => id.startsWith('setup_')), 'identifiants persistants et préfixés');
    },
  },
  {
    name: 'les permissions du salon excluent @everyone et gardent le propriétaire, le bot et les admins',
    run() {
      const guild = {
        ownerId: 'owner',
        roles: {
          everyone: { id: 'everyone' },
          cache: new Map([
            ['adminRole', { id: 'adminRole', permissions: { has: () => true } }],
            ['basicRole', { id: 'basicRole', permissions: { has: () => false } }],
          ]),
        },
        members: { me: { id: 'bot' } },
      };
      const overwrites = hub.adminOverwrites(guild);
      const ids = overwrites.map(entry => entry.id);
      const everyone = overwrites.find(entry => entry.id === 'everyone');
      assert.deepStrictEqual(everyone.deny, [1024n], 'ViewChannel refusé à @everyone');
      assert.ok(ids.includes('owner'), 'le propriétaire voit le salon');
      assert.ok(ids.includes('bot'), 'le bot peut y écrire');
      assert.ok(ids.includes('adminRole'), 'les rôles administrateurs voient le salon');
      assert.ok(!ids.includes('basicRole'), 'un rôle sans permission ne voit rien');
    },
  },
  {
    name: 'le programme d’installation affiche les modules absents et le score',
    run() {
      const missing = [
        moduleEntry({ key: 'captcha', label: 'Captcha', auto: false, fix: '/captcha', hint: 'Vérification humaine' }),
        moduleEntry({ key: 'xp', label: 'Niveaux & XP', hint: 'Récompenser l’activité' }),
      ];
      const embed = hub.buildInstallerEmbed({ guild: GUILD, score: fakeScore(missing), plan: { blocked: [] } }).toJSON();
      assert.ok(embed.title.includes('installation'));
      assert.ok(embed.description.includes('42%'));
      assert.ok(embed.description.includes('2 module(s)'));
      const field = embed.fields.find(item => item.name.includes('À installer'));
      assert.ok(field.value.includes('Captcha'));
      assert.ok(field.value.includes('Niveaux & XP'));
      assert.ok(embed.fields.some(item => item.name.includes('Couverture')));
    },
  },
  {
    name: 'le menu liste au plus 25 modules et propose l’installation groupée',
    run() {
      const missing = Array.from({ length: 30 }, (_, index) => moduleEntry({
        key: `module-${index}`,
        label: `Module ${index}`,
        hint: `Apport ${index}`,
      }));
      const rows = hub.buildInstallerComponents({ score: fakeScore(missing), plan: { blocked: [] } });
      assert.ok(rows.length <= 5, 'cinq rangées de composants au maximum');

      const select = rows[0].toJSON().components[0];
      assert.strictEqual(select.custom_id, 'setup_pick');
      assert.strictEqual(select.options.length, 25);

      const ids = componentIds(rows);
      assert.ok(ids.includes('setup_install_auto'));
      assert.ok(ids.includes('setup_refresh'));
    },
  },
  {
    name: 'sans module installable, le bouton groupé est désactivé',
    run() {
      const manual = [moduleEntry({ key: 'tickets', label: 'Tickets', auto: false, fix: '/ticket' })];
      const rows = hub.buildInstallerComponents({ score: fakeScore(manual), plan: { blocked: [] } });
      const buttons = rows[1].toJSON().components;
      const auto = buttons.find(button => button.custom_id === 'setup_install_auto');
      assert.strictEqual(auto.disabled, true);

      const channelButton = buttons.find(button => button.custom_id === 'setup_channels');
      assert.strictEqual(channelButton.disabled, true, 'aucun salon à créer');
    },
  },
  {
    name: 'le détail d’un module montre son pilier, sa méthode et sa commande',
    run() {
      const score = fakeScore([moduleEntry({ key: 'tickets', label: 'Tickets', auto: false, fix: '/ticket' })]);
      const embed = hub.buildModuleEmbed({ guild: GUILD, score, key: 'tickets' }).toJSON();
      assert.ok(embed.title.includes('Tickets'));
      assert.ok(embed.description.includes('choix humain'));
      const fields = embed.fields.map(field => `${field.name}: ${field.value}`).join('\n');
      assert.ok(fields.includes('Gestion & support') || fields.includes('gestion'), 'pilier affiché');
      assert.ok(fields.includes('/ticket'));

      const rows = hub.buildInstallerComponents({ score, plan: { blocked: [] }, selected: 'tickets' });
      const ids = componentIds(rows);
      assert.ok(ids.includes('setup_install:tickets'));
      assert.ok(ids.includes('setup_back'));

      const unknown = hub.buildModuleEmbed({ guild: GUILD, score, key: 'inexistant' }).toJSON();
      assert.ok(unknown.title.includes('inconnu'));
    },
  },
  {
    name: 'seuls le propriétaire, un administrateur ou un gestionnaire ouvrent le programme',
    run() {
      assert.strictEqual(hub.decideSetupAccess({ isOwner: true }).allowed, true);
      assert.strictEqual(hub.decideSetupAccess({ isAdmin: true }).allowed, true);
      assert.strictEqual(hub.decideSetupAccess({ isManager: true }).allowed, true);
      const denied = hub.decideSetupAccess({});
      assert.strictEqual(denied.allowed, false);
      assert.strictEqual(denied.reason, 'denied');
    },
  },
  {
    name: 'l’installation explique ce qu’elle a réellement fait',
    run() {
      const applied = hub.installNote({ type: 'applied', applied: [{ label: 'Activer les niveaux' }], failed: [] });
      assert.ok(applied.includes('1 réglage'));

      const failed = hub.installNote({
        type: 'applied',
        applied: [],
        failed: [{ label: 'Bienvenue', error: 'base indisponible' }],
      });
      assert.ok(failed.includes('Bienvenue'));

      const blocked = hub.installNote({ type: 'blocked', blocked: { reason: 'Aucun salon « annonces » trouvé' } });
      assert.ok(blocked.includes('Salon manquant'));
      assert.ok(blocked.includes('Créer les salons'));

      const manual = hub.installNote({ type: 'manual', meta: { fix: '/ticket' } });
      assert.ok(manual.includes('/ticket'));

      assert.ok(hub.installNote({ type: 'nothing' }).length > 0);
    },
  },
  {
    name: 'le programme d’installation ne dépend d’aucune licence',
    run() {
      const fs = require('fs');
      const path = require('path');
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'setupHub.js'), 'utf8');
      // Régression : le panneau ne doit ni importer ni appeler le contrôle de
      // licence — installer un module est gratuit, par décision de produit.
      assert.ok(!/licenseGate|checkAccess|ensureLicense/.test(source), 'aucune dépendance à la licence dans le hub');
      assert.strictEqual(hub.ensureLicense, undefined);

      const embed = hub.buildInstallerEmbed({ guild: GUILD, score: fakeScore(), plan: { blocked: [] } }).toJSON();
      assert.ok(/aucune licence/i.test(embed.description), 'le panneau annonce l’installation libre');
    },
  },
  {
    name: 'un clic sur le programme répond toujours (bouton ou menu)',
    async run() {
      // La base n'est pas disponible hors-ligne : on remplace uniquement la
      // collecte d'état. Tout le reste (rendu, décisions, réponses) est le vrai
      // code exécuté par le bot.
      const efficiency = require('../src/utils/efficiencyState');
      const original = { collectState: efficiency.collectState, invalidateState: efficiency.invalidateState };
      efficiency.collectState = async guildId => ({ guildId });
      efficiency.invalidateState = () => {};

      try {
        const start = fakeInteraction({ customId: 'setup_start' });
        await hub.handleSetupInteraction(start, {});
        assert.strictEqual(start.calls.deferred, 'reply', 'l’ouverture est acquittée tout de suite');
        assert.strictEqual(start.calls.edits.length, 1, 'le panneau est bien envoyé');
        assert.ok(start.calls.edits[0].embeds.length, 'embed présent');
        assert.ok(start.calls.edits[0].components.length, 'composants présents');
        assert.strictEqual(start.calls.replies.length, 0, 'aucun refus pour un administrateur');

        // Le sélecteur de modules : longtemps le maillon manquant, un menu n'est
        // pas un bouton et doit être routé lui aussi.
        const pick = fakeInteraction({ customId: 'setup_pick', values: ['welcome'] });
        await hub.handleSetupInteraction(pick, {});
        assert.strictEqual(pick.calls.deferred, 'update', 'un menu met à jour le panneau');
        assert.ok(pick.calls.edits.length === 1, 'la fiche du module est affichée');
        assert.ok(pick.calls.edits[0].embeds[0].toJSON().title.includes('Message de bienvenue'));

        const refresh = fakeInteraction({ customId: 'setup_refresh' });
        await hub.handleSetupInteraction(refresh, {});
        assert.strictEqual(refresh.calls.edits.length, 1, 'actualiser répond');

        const install = fakeInteraction({ customId: 'setup_install:welcome' });
        await hub.handleSetupInteraction(install, {});
        assert.strictEqual(install.calls.edits.length, 1, 'installer répond, même sans salon disponible');
        assert.ok(install.calls.edits[0].embeds[0].toJSON().description.length > 0);

        const denied = fakeInteraction({ customId: 'setup_start', admin: false });
        await hub.handleSetupInteraction(denied, {});
        assert.strictEqual(denied.calls.replies.length, 1);
        assert.ok(denied.calls.replies[0].content.includes('administrateurs'));
        assert.strictEqual(denied.calls.edits.length, 0, 'un refus ne modifie pas le panneau');
      } finally {
        efficiency.collectState = original.collectState;
        efficiency.invalidateState = original.invalidateState;
      }
    },
  },
  {
    name: 'un module inconnu ne casse pas la recherche de métadonnées',
    run() {
      assert.strictEqual(hub.moduleMeta('inexistant'), null);
      const welcome = hub.moduleMeta('welcome');
      assert.ok(welcome && welcome.hint);
      assert.strictEqual(typeof welcome.auto, 'boolean');
    },
  },
];

module.exports = { checks };
