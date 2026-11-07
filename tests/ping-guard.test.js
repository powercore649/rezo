'use strict';
// tests/ping-guard.test.js — Anti-ping (@everyone/@here, mentions de masse) et
// garde des noms de salons suspects.
//
// Les décisions sont pures (src/utils/pingGuardEngine.js) : aucun token, aucune
// base, aucun réseau. On vérifie surtout les cas limites qui coûtent cher en
// production : un faux positif qui bannit un modérateur, une mention dans un
// bloc de code, une sanction qui ne monte jamais jusqu'au ban.

const assert = require('assert');
const engine = require('../src/utils/pingGuardEngine');
const command = require('../src/commands/securite/antiping');

const member = { canMentionEveryone: false, roleMentions: 0, userMentions: 0 };

const checks = [
  {
    name: 'la configuration est bornée même avec un document abîmé',
    run() {
      const cfg = engine.normalizeConfig({
        enabled: 'oui',
        maxRoleMentions: -40,
        maxUserMentions: 'beaucoup',
        timeoutMin: 999_999,
        strikesBeforeBan: 0,
        punishment: 'explode',
        exemptRoles: ['1', '1', '', null],
        channelGuard: { restoreWindowMin: 0, keywords: ['', 'x', 'nuke'] },
      });
      assert.strictEqual(cfg.enabled, true, 'une valeur non booléenne garde le défaut');
      assert.strictEqual(cfg.maxRoleMentions, 0);
      assert.strictEqual(cfg.maxUserMentions, engine.DEFAULTS.maxUserMentions);
      assert.strictEqual(cfg.timeoutMin, 40_320);
      assert.strictEqual(cfg.strikesBeforeBan, 1);
      assert.strictEqual(cfg.punishment, 'timeout');
      assert.deepStrictEqual(cfg.exemptRoles, ['1']);
      assert.strictEqual(cfg.channelGuard.restoreWindowMin, 1);
      assert.deepStrictEqual(cfg.channelGuard.keywords, ['nuke']);
    },
  },
  {
    name: '@everyone et @here sont bloqués sans la permission, jamais avec',
    run() {
      const blocked = engine.analyzeMessage({ content: 'salut @everyone', ...member }, {});
      assert.strictEqual(blocked.violation, true);
      assert.strictEqual(blocked.rule, 'everyone');

      const here = engine.analyzeMessage({ content: '@here on arrive', ...member }, {});
      assert.strictEqual(here.rule, 'here');

      const staff = engine.analyzeMessage({ content: '@everyone annonce', canMentionEveryone: true }, {});
      assert.strictEqual(staff.violation, false);

      const off = engine.analyzeMessage({ content: '@everyone' }, { blockEveryone: false });
      assert.strictEqual(off.violation, false);
    },
  },
  {
    name: 'une mention dans du code ou échappée ne compte pas',
    run() {
      const code = engine.analyzeMessage({ content: 'utilise `@everyone` dans ton message', ...member }, {});
      assert.strictEqual(code.violation, false);

      const fence = engine.analyzeMessage({ content: 'exemple :\n```\n@everyone\n```', ...member }, {});
      assert.strictEqual(fence.violation, false);

      const escaped = engine.analyzeMessage({ content: 'écris \\@everyone pour le voir en clair', ...member }, {});
      assert.strictEqual(escaped.violation, false);

      const prose = engine.analyzeMessage({ content: 'le rôle @everyone-ish ne ping personne', ...member }, {});
      assert.strictEqual(prose.violation, false, '« @everyone-ish » n’est pas une mention');
    },
  },
  {
    name: 'les mentions de rôles et de membres en masse sont plafonnées',
    run() {
      const roles = engine.analyzeMessage({ content: 'oi', roleMentions: 3, userMentions: 0, canMentionEveryone: false }, {});
      assert.strictEqual(roles.rule, 'roleMass');
      assert.strictEqual(roles.count, 3);

      const under = engine.analyzeMessage({ content: 'oi', roleMentions: 2, userMentions: 0 }, {});
      assert.strictEqual(under.violation, false);

      const users = engine.analyzeMessage({ content: 'oi', roleMentions: 0, userMentions: 6 }, {});
      assert.strictEqual(users.rule, 'userMass');

      // Seuil à 0 = détection désactivée, pas « bloque tout ».
      const off = engine.analyzeMessage({ content: 'oi', roleMentions: 20, userMentions: 20 }, { maxRoleMentions: 0, maxUserMentions: 0 });
      assert.strictEqual(off.violation, false);
    },
  },
  {
    name: 'la sanction monte jusqu’au ban à la récidive prévue',
    run() {
      const cfg = engine.normalizeConfig({ punishment: 'timeout', strikesBeforeBan: 3 });
      assert.strictEqual(engine.sanctionForStrike(cfg, 1), 'timeout');
      assert.strictEqual(engine.sanctionForStrike(cfg, 2), 'timeout');
      assert.strictEqual(engine.sanctionForStrike(cfg, 3), 'ban');
      assert.strictEqual(engine.sanctionForStrike(cfg, 9), 'ban');

      const strict = engine.normalizeConfig({ punishment: 'kick', strikesBeforeBan: 1 });
      assert.strictEqual(engine.sanctionForStrike(strict, 1), 'ban');

      const deleteOnly = engine.normalizeConfig({ punishment: 'delete', strikesBeforeBan: 5 });
      assert.strictEqual(engine.sanctionForStrike(deleteOnly, 4), 'delete');
      assert.strictEqual(engine.sanctionForStrike(deleteOnly, 5), 'ban');
    },
  },
  {
    name: 'une alerte ne re-ping jamais le serveur',
    run() {
      const safe = engine.sanitizeMentions('@everyone @here <@&123> <@456> coupable');
      assert.ok(!/@everyone/.test(safe), '@everyone doit être neutralisé');
      assert.ok(!/@here/.test(safe), '@here doit être neutralisé');
      assert.ok(!/<@/.test(safe), 'les mentions de rôle et de membre doivent être neutralisées');
      assert.ok(safe.length <= 300);
    },
  },
  {
    name: 'les noms de salons suspects sont reconnus sans faux positif évident',
    run() {
      assert.strictEqual(engine.channelNameVerdict('discord.gg/abc123').reason, 'invite');
      assert.strictEqual(engine.channelNameVerdict('free-nitro-ici').reason, 'keyword');
      assert.strictEqual(engine.channelNameVerdict('nuke-by-someone').reason, 'keyword');
      assert.strictEqual(engine.channelNameVerdict('@everyone').reason, 'mention');
      assert.strictEqual(engine.channelNameVerdict('https://example.com').reason, 'lien');

      for (const legit of ['annonces', 'raid-annonces', 'général', 'entraide', 'nitro-boost']) {
        assert.strictEqual(engine.channelNameVerdict(legit).suspicious, false, `« ${legit} » ne doit pas être suspect`);
      }

      // Une formule ajoutée par le serveur s'applique ; la liste par défaut ne
      // contient pas « raid » seul, qui sert à des salons légitimes.
      assert.strictEqual(engine.channelNameVerdict('salon-go-go-go', ['go go go']).suspicious, true);
      assert.strictEqual(engine.channelNameVerdict('raid-annonces', []).suspicious, false);
    },
  },
  {
    name: 'un salon supprimé peut être reconstruit à l’identique',
    run() {
      const channel = {
        id: '123',
        name: 'général',
        type: 0,
        parentId: '999',
        rawPosition: 4,
        topic: 'Le salon principal',
        nsfw: false,
        rateLimitPerUser: 5,
        bitrate: null,
        userLimit: null,
        permissionOverwrites: {
          cache: new Map([
            ['42', { id: '42', type: 0, allow: { bitfield: 1024n }, deny: { bitfield: 0n } }],
          ]),
        },
      };
      const snapshot = engine.channelSnapshot(channel);
      assert.strictEqual(snapshot.name, 'général');
      assert.strictEqual(snapshot.parentId, '999');
      assert.strictEqual(snapshot.permissionOverwrites.length, 1);

      const options = engine.restoreOptionsFromSnapshot(snapshot);
      assert.strictEqual(options.name, 'général');
      assert.strictEqual(options.type, 0);
      assert.strictEqual(options.parent, '999');
      assert.strictEqual(options.topic, 'Le salon principal');
      assert.strictEqual(options.rateLimitPerUser, 5);
      assert.deepStrictEqual(options.permissionOverwrites, [{ id: '42', type: 0, allow: '1024', deny: '0' }]);

      assert.strictEqual(engine.channelSnapshot(null), null);
      assert.strictEqual(engine.restoreOptionsFromSnapshot({}), null);
    },
  },
  {
    name: 'propriétaire, bot et listes de confiance échappent à la garde',
    run() {
      const cfg = engine.normalizeConfig({ trustedUsers: ['7'], trustedRoles: ['88'] });
      assert.strictEqual(engine.isTrusted({ userId: '1', guildOwnerId: '1' }, cfg), true);
      assert.strictEqual(engine.isTrusted({ userId: '2', clientId: '2' }, cfg), true);
      assert.strictEqual(engine.isTrusted({ userId: '7' }, cfg), true);
      assert.strictEqual(engine.isTrusted({ userId: '3', roleIds: ['88'] }, cfg), true);
      assert.strictEqual(engine.isTrusted({ userId: '4', roleIds: ['5'] }, cfg), false);
      assert.strictEqual(engine.isTrusted({ userId: null }, cfg), false);
    },
  },
  {
    name: '/antiping est une commande simple, réglée par un panneau',
    run() {
      const json = command.data.toJSON();
      assert.strictEqual(json.name, 'antiping');
      assert.ok(json.description.length >= 1 && json.description.length <= 100);
      assert.deepStrictEqual(json.options || [], [], 'aucune sous-commande : tout passe par le panneau');
      assert.strictEqual(typeof command.execute, 'function');
      assert.deepStrictEqual(command.sections, ['main', 'mentions', 'salons', 'confiance', 'acces', 'restaurer']);
    },
  },
  {
    name: 'chaque section du panneau respecte les limites de Discord',
    run() {
      const doc = { stats: {}, recent: [] };
      const config = engine.normalizeConfig({ trustedUsers: ['7'], trustedRoles: ['88'] });
      const guild = { name: 'Test', members: { cache: new Map() }, roles: { cache: new Map() } };

      for (const section of command.sections) {
        const panel = command.buildPanel(section, { doc, config, guild, guildName: 'Test', pending: 2 });
        assert.ok(panel.embeds.length === 1, `${section} : un seul embed`);
        assert.ok(panel.components.length >= 1 && panel.components.length <= 5,
          `${section} : ${panel.components.length} rangées (5 maximum)`);

        for (const row of panel.components) {
          const json = row.toJSON();
          const children = json.components || [];
          assert.ok(children.length <= 5, `${section} : ${children.length} composants dans une rangée`);
          if (children.length > 1 && children[0].type !== 2) {
            assert.fail(`${section} : un menu doit occuper sa propre rangée`);
          }
          for (const child of children) {
            assert.ok(String(child.custom_id).length <= 100, `${section} : custom_id trop long`);
          }
        }

        const embed = panel.embeds[0].toJSON();
        assert.ok(embed.title && embed.title.length <= 256, `${section} : titre invalide`);
        for (const field of embed.fields || []) {
          assert.ok(field.name.length <= 256, `${section} : nom de champ trop long`);
          assert.ok(field.value.length <= 1024, `${section} : valeur de champ trop longue`);
        }
      }
    },
  },
  {
    name: 'le panneau anti-ping n’expose jamais un menu vide',
    run() {
      const doc = { stats: {}, recent: [] };
      const empty = engine.normalizeConfig({});
      const panel = command.buildPanel('confiance', {
        doc, config: empty, guild: { name: 'Test', members: { cache: new Map() }, roles: { cache: new Map() } }, guildName: 'Test', pending: 0,
      });
      const ids = panel.components.flatMap(row => (row.toJSON().components || []).map(child => child.custom_id));
      assert.ok(ids.includes('ap_trust_user'));
      assert.ok(!ids.includes('ap_untrust'), 'aucun menu de retrait quand la liste est vide');
    },
  },
];

module.exports = { checks };
