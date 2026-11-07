'use strict';
// tests/onboarding.test.js — Portail d'accès v2.
//
// Vérifie ce qui est contrôlable hors-ligne : validation des étapes, rendu des
// messages, cycle des sessions, relances et cartes de validation staff.

const assert = require('assert');
const mgr = require('../src/utils/onboardingManager');
const { shouldRemind, reviewExpired } = require('../src/utils/onboardingScheduler');
const OnboardingConfig = require('../src/models/OnboardingConfig');
const OnboardingSession = require('../src/models/OnboardingSession');

const QID = 'q_1';
const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';

const fakeGuild = {
  name: 'Serveur test',
  roles: { cache: { get: id => (id === ROLE_A ? { name: 'Gamer' } : id === ROLE_B ? { name: 'Créatif' } : null) } },
};

const member = {
  id: '333333333333333333',
  user: { tag: 'test#0001', createdTimestamp: Date.UTC(2024, 0, 1) },
  guild: fakeGuild,
};

const checks = [
  {
    name: 'la barre de progression reste bornée',
    run() {
      assert.strictEqual(mgr.progressBar(0, 1).length, 10);
      assert.strictEqual(mgr.progressBar(0, 4).length, 10);
      assert.strictEqual(mgr.progressBar(99, 4), '▓'.repeat(10));
      assert.strictEqual(mgr.progressBar(-5, 0).startsWith('▓'), true);
    },
  },
  {
    name: 'les types d’étapes sont normalisés depuis le français',
    run() {
      assert.strictEqual(mgr.normalizeType('choix'), 'choice');
      assert.strictEqual(mgr.normalizeType('Boutons'), 'choice');
      assert.strictEqual(mgr.normalizeType('rôles'), 'roles');
      assert.strictEqual(mgr.normalizeType('Règlement'), 'rules');
      assert.strictEqual(mgr.normalizeType('charte'), 'rules');
      assert.strictEqual(mgr.normalizeType('autre chose'), 'text');
    },
  },
  {
    name: 'une étape invalide est refusée avec une raison',
    run() {
      assert.strictEqual(mgr.validateQuestion({ prompt: '', type: 'text' }).ok, false);
      assert.strictEqual(mgr.validateQuestion({ prompt: 'As-tu lu ?', type: 'inconnu' }).ok, false);
      assert.strictEqual(mgr.validateQuestion({ prompt: 'Ton style ?', type: 'choice', choices: ['seul'] }).ok, false);
      assert.strictEqual(mgr.validateQuestion({ prompt: 'Ton style ?', type: 'choice', choices: ['a', 'b', 'c', 'd', 'e', 'f'] }).ok, false);
      assert.strictEqual(mgr.validateQuestion({ prompt: 'Choisis un rôle', type: 'roles', choices: [] }).ok, false);
      assert.strictEqual(mgr.validateQuestion({ prompt: 'Règlement ?', type: 'rules', required: false }).ok, false);
      assert.strictEqual(mgr.validateQuestion({ prompt: 'Quel est ton pseudo ?', type: 'text' }).ok, true);
      assert.strictEqual(mgr.validateQuestion({ prompt: 'Ton style ?', type: 'choice', choices: ['a', 'b'] }).ok, true);
      assert.strictEqual(mgr.validateQuestion({ prompt: 'Choisis un rôle', type: 'roles', choices: [ROLE_A] }).ok, true);
    },
  },
  {
    name: 'les rôles d’accès fusionnent l’ancien et le nouveau champ, sans doublon',
    run() {
      const roles = mgr.resolveAccessRoles({ accessRoleId: ROLE_A, accessRoleIds: [ROLE_A, ROLE_B, 'pas-un-id'] });
      assert.deepStrictEqual(roles, [ROLE_A, ROLE_B]);
      assert.deepStrictEqual(mgr.resolveAccessRoles({}), []);
      assert.deepStrictEqual(mgr.normalizeIdList(`<@&${ROLE_A}>, ${ROLE_B} ${ROLE_B}`), [ROLE_A, ROLE_B]);
    },
  },
  {
    name: 'une étape « choix » produit un bouton par option',
    run() {
      const payload = mgr.buildStepPayload(
        { id: QID, type: 'choice', prompt: 'Ton style ?', choices: ['PvP', 'PvE'], required: true },
        0, 2, { guild: fakeGuild },
      );
      const row = payload.components[0].toJSON();
      assert.strictEqual(row.components.length, 2);
      assert.deepStrictEqual(row.components.map(c => c.custom_id), [`ob_answer:${QID}:0`, `ob_answer:${QID}:1`]);
      assert.ok(/étape 1\/2/.test(payload.embeds[0].toJSON().title));
    },
  },
  {
    name: 'une étape « texte » n’a pas de bouton, sauf si elle est optionnelle',
    run() {
      const required = mgr.buildStepPayload({ id: QID, type: 'text', prompt: 'Quel pseudo ?', required: true }, 0, 1, {});
      assert.strictEqual(required.components.length, 0);
      assert.ok(/réponds ici/.test(required.embeds[0].toJSON().footer.text));

      const optional = mgr.buildStepPayload({ id: QID, type: 'text', prompt: 'Une remarque ?', required: false }, 0, 1, {});
      assert.strictEqual(optional.components.length, 1);
      assert.strictEqual(optional.components[0].toJSON().components[0].custom_id, `ob_skip:${QID}`);
    },
  },
  {
    name: 'une étape « rôles » produit un menu avec les vrais noms de rôles',
    run() {
      const payload = mgr.buildStepPayload(
        { id: QID, type: 'roles', prompt: 'Tes centres d’intérêt', choices: [ROLE_A, ROLE_B], required: true, maxChoices: 2 },
        1, 3, { guild: fakeGuild },
      );
      const menu = payload.components[0].toJSON().components[0];
      assert.strictEqual(menu.custom_id, `ob_roles:${QID}`);
      assert.strictEqual(menu.min_values, 1);
      assert.strictEqual(menu.max_values, 2);
      assert.deepStrictEqual(menu.options.map(o => o.label), ['Gamer', 'Créatif']);
    },
  },
  {
    name: 'une étape « règlement » n’a qu’un bouton d’acceptation',
    run() {
      const payload = mgr.buildStepPayload({ id: QID, type: 'rules', prompt: 'Charte du serveur', required: true }, 0, 1, {});
      const buttons = payload.components[0].toJSON().components;
      assert.strictEqual(buttons.length, 1);
      assert.strictEqual(buttons[0].custom_id, `ob_rules:${QID}`);
      assert.strictEqual(buttons[0].style, 3); // succès
      assert.ok(/J’accepte/.test(buttons[0].label));
    },
  },
  {
    name: 'la carte de validation staff contient les réponses et les deux boutons',
    run() {
      const session = {
        _id: 'a'.repeat(24),
        userId: member.id,
        createdAt: new Date(),
        answers: [
          { questionId: QID, label: 'Quel est ton pseudo ?', answer: 'Raph' },
          { questionId: 'q_2', label: 'Tes centres d’intérêt', answer: '<@&111111111111111111>' },
        ],
      };
      const payload = mgr.buildReviewPayload(member, session, {});
      const text = JSON.stringify(payload.embeds[0].toJSON());
      assert.ok(text.includes('Raph'));
      assert.ok(text.includes('Quel est ton pseudo'));
      assert.ok(text.includes(member.id));

      const ids = payload.components[0].toJSON().components.map(c => c.custom_id);
      assert.deepStrictEqual(ids, [`obreview_ok:${session._id}`, `obreview_no:${session._id}`]);
    },
  },
  {
    name: 'la relance part une seule fois, et jamais en cours de validation',
    run() {
      const now = Date.now();
      const cfg = { remindAfterMinutes: 30 };
      const fresh = { status: 'in_progress', createdAt: new Date(now - 10 * 60_000), remindedAt: null };
      const late = { status: 'in_progress', createdAt: new Date(now - 40 * 60_000), remindedAt: null };
      const already = { ...late, remindedAt: new Date(now - 10 * 60_000) };
      const review = { status: 'pending_review', createdAt: new Date(now - 40 * 60_000), remindedAt: null };

      assert.strictEqual(shouldRemind(fresh, cfg, now), false);
      assert.strictEqual(shouldRemind(late, cfg, now), true);
      assert.strictEqual(shouldRemind(already, cfg, now), false);
      assert.strictEqual(shouldRemind(review, cfg, now), false);
      assert.strictEqual(shouldRemind(late, { remindAfterMinutes: 0 }, now), false);
    },
  },
  {
    name: 'une demande de validation trop ancienne est détectée',
    run() {
      const now = Date.now();
      const cfg = { reviewTimeoutMinutes: 60 };
      const recent = { status: 'pending_review', submittedAt: new Date(now - 10 * 60_000) };
      const old = { status: 'pending_review', submittedAt: new Date(now - 90 * 60_000) };
      assert.strictEqual(reviewExpired(recent, cfg, now), false);
      assert.strictEqual(reviewExpired(old, cfg, now), true);
      assert.strictEqual(reviewExpired(old, { reviewTimeoutMinutes: 0 }, now), false);
      assert.strictEqual(reviewExpired({ ...old, status: 'in_progress' }, cfg, now), false);
    },
  },
  {
    name: 'les nouveaux réglages ont des valeurs par défaut sûres',
    run() {
      assert.strictEqual(OnboardingConfig.schema.path('mode').defaultValue, 'private');
      assert.strictEqual(OnboardingConfig.schema.path('dmWelcome').defaultValue, true);
      assert.strictEqual(OnboardingConfig.schema.path('reviewEnabled').defaultValue, false);
      assert.strictEqual(OnboardingConfig.schema.path('reviewRejectAction').defaultValue, 'none');
      assert.strictEqual(OnboardingConfig.schema.path('remindAfterMinutes').defaultValue, 0);
      assert.ok(OnboardingConfig.schema.path('questions').schema.path('type').enumValues.includes('roles'));
      assert.ok(OnboardingSession.schema.path('status').enumValues.includes('pending_review'));
      assert.ok(OnboardingSession.schema.path('status').enumValues.includes('rejected'));
    },
  },
  {
    name: 'les placeholders des messages sont remplacés',
    run() {
      const text = mgr.placeholderMessage(
        'Bienvenue {user} sur {server} — {link}',
        member,
        fakeGuild,
        { id: '444444444444444444', guild: { id: '555555555555555555' } },
      );
      assert.ok(text.includes(`<@${member.id}>`));
      assert.ok(text.includes('Serveur test'));
      assert.ok(text.includes('https://discord.com/channels/'));
      assert.strictEqual(mgr.MAX_QUESTIONS, 15);
    },
  },
  {
    name: 'le panel tient dans les limites Discord (5 rangées, 5 composants)',
    run() {
      const cmd = require('../src/commands/configuration/onboarding');
      const cfg = {
        mode: 'private',
        questions: [{ id: 'q1', type: 'text', prompt: 'Pseudo ?', choices: [], required: true }],
      };
      const guild = { iconURL: () => null };

      for (const rows of [
        cmd._builders.buildOverviewRows(cfg),
        cmd._builders.buildChannelsRows(cfg),
        cmd._builders.buildRolesRows(cfg),
        cmd._builders.buildQuestionsRows(cfg),
      ]) {
        assert.ok(rows.length <= 5, 'plus de 5 rangées');
        for (const row of rows) {
          const json = row.toJSON();
          assert.ok(json.components.length >= 1 && json.components.length <= 5, 'rangée invalide');
        }
      }

      const page = cmd._builders.render(cfg, guild, 'overview');
      assert.strictEqual(page.embeds.length, 1);
      assert.strictEqual(cmd.data.name, 'onboarding');
      assert.strictEqual(typeof cmd.handleModal, 'function');
    },
  },
  {
    name: 'le moteur expose le parcours complet (démarrage, étapes, décision)',
    run() {
      for (const name of [
        'startOnboarding', 'handleStepInteraction', 'handleMemberMessage',
        'completeOnboarding', 'grantAccess', 'denyAccess', 'handleReviewButton',
        'submitForReview', 'cancelOnboarding', 'logOnboarding',
      ]) {
        assert.strictEqual(typeof mgr[name], 'function', `${name} manquant`);
      }
    },
  },
];

module.exports = { checks };
