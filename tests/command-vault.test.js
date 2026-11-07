'use strict';
// tests/command-vault.test.js — Coffre d'accès des commandes sensibles.
//
// Système indépendant du système de licences : il ne vérifie ni abonnement, ni
// clé, ni service distant. On teste ici le hachage (scrypt + sel), la décision
// d'accès, le verrouillage anti-force brute et les sessions de déverrouillage.

const assert = require('assert');
const engine = require('../src/utils/commandVaultEngine');
const vault = require('../src/utils/commandVault');

const checks = [
  {
    name: 'le code d’accès est haché avec un sel, jamais stocké en clair',
    run() {
      const { salt, hash } = engine.hashCode('CodeSecret42');
      assert.ok(salt && salt.length >= 16, 'sel présent');
      assert.ok(hash && hash.length === 64, 'hachage scrypt de 32 octets en hexadécimal');
      assert.ok(!hash.includes('CodeSecret42'), 'aucun code en clair dans le hachage');

      // Deux hachages du même code diffèrent : le sel est bien aléatoire.
      const second = engine.hashCode('CodeSecret42');
      assert.notStrictEqual(second.salt, salt);
      assert.notStrictEqual(second.hash, hash);
    },
  },
  {
    name: 'la vérification accepte le bon code et refuse tout le reste',
    run() {
      const stored = engine.hashCode('CodeSecret42');
      assert.strictEqual(engine.verifyCode('CodeSecret42', stored), true);
      assert.strictEqual(engine.verifyCode('codesecrt42', stored), false);
      assert.strictEqual(engine.verifyCode('', stored), false);
      assert.strictEqual(engine.verifyCode('CodeSecret42', {}), false, 'aucun code défini = refus');
      assert.strictEqual(engine.verifyCode('CodeSecret42', { salt: stored.salt, hash: 'zz' }), false, 'hachage illisible = refus');
      assert.strictEqual(engine.verifyCode('CodeSecret42', { salt: 'autre-sel', hash: stored.hash }), false, 'mauvais sel = refus');
    },
  },
  {
    name: 'un code trop faible est refusé avant d’être enregistré',
    run() {
      assert.strictEqual(engine.validateCode('court').ok, false);
      assert.strictEqual(engine.validateCode('12345678').ok, true);
      assert.strictEqual(engine.validateCode('   ').ok, false);
      assert.strictEqual(engine.validateCode(' motdepasse ').ok, false, 'espaces ambigus');
      assert.strictEqual(engine.validateCode('x'.repeat(129)).ok, false);
      assert.ok(engine.validateCode('court').reason);
    },
  },
  {
    name: 'propriétaire, membres et rôles autorisés passent sans code',
    run() {
      const base = { guildOwnerId: 'owner', authorizedUsers: ['7'], authorizedRoles: ['88'] };
      assert.strictEqual(engine.decideAccess({ ...base, userId: 'owner' }).reason, 'owner');
      assert.strictEqual(engine.decideAccess({ ...base, userId: '7' }).reason, 'authorized');
      assert.strictEqual(engine.decideAccess({ ...base, userId: '3', roleIds: ['88'] }).reason, 'role');
      assert.strictEqual(engine.decideAccess({ ...base, userId: '3', roleIds: ['5'], hasCode: true }).reason, 'code-required');
      assert.strictEqual(engine.decideAccess({ ...base, userId: '3', roleIds: ['5'], hasCode: false }).reason, 'no-code');
      assert.strictEqual(engine.decideAccess({ ...base, userId: null }).allowed, false);
    },
  },
  {
    name: 'sans code défini, seul le propriétaire ouvre le panneau',
    run() {
      const decision = engine.decideAccess({ userId: '42', guildOwnerId: 'owner', hasCode: false });
      assert.strictEqual(decision.allowed, false);
      assert.strictEqual(decision.needsCode, false);
      assert.ok(engine.describeDenial(decision).includes('propriétaire'));
      assert.ok(!engine.describeDenial(decision).includes('null'));
    },
  },
  {
    name: 'cinq codes faux verrouillent l’accès, puis expirent',
    run() {
      const now = 1_700_000_000_000;
      let entry = { userId: 'u1' };
      for (let i = 1; i <= engine.MAX_ATTEMPTS; i++) {
        entry = engine.registerFailure(entry, now + i);
        assert.strictEqual(entry.count, i);
      }
      assert.ok(entry.lockedUntil > now, 'verrouillé au cinquième échec');
      assert.strictEqual(
        engine.decideAccess({ userId: 'u1', guildOwnerId: 'owner', hasCode: true, lockedUntil: entry.lockedUntil, now }).reason,
        'locked',
      );
      assert.ok(engine.describeDenial({ reason: 'locked', retryAt: entry.lockedUntil }).includes('min'));

      // Après la fenêtre, le compteur repart de zéro : une erreur isolée ne
      // verrouille jamais définitivement.
      const later = entry.lockedUntil + engine.FAILURE_WINDOW_MS + 1;
      const reset = engine.registerFailure(entry, later);
      assert.strictEqual(reset.count, 1);
      assert.strictEqual(reset.lockedUntil, 0);
      assert.strictEqual(engine.remainingLockMs(entry.lockedUntil, later), 0);
    },
  },
  {
    name: 'les tentatives restantes et le compte à rebours sont exacts',
    run() {
      assert.strictEqual(engine.remainingAttempts(0), engine.MAX_ATTEMPTS);
      assert.strictEqual(engine.remainingAttempts(3), engine.MAX_ATTEMPTS - 3);
      assert.strictEqual(engine.remainingAttempts(engine.MAX_ATTEMPTS + 2), 0);

      const now = Date.now();
      assert.strictEqual(engine.remainingLockMs(now + 60_000, now), 60_000);
      assert.strictEqual(engine.remainingLockMs(now - 1, now), 0);
      assert.strictEqual(engine.remainingLockMs(0, now), 0);
    },
  },
  {
    name: 'une session déverrouille dix minutes, par membre et par serveur',
    run() {
      vault.openSession('g1', 'u1');
      assert.strictEqual(vault.hasSession('g1', 'u1'), true);
      assert.strictEqual(vault.hasSession('g1', 'u2'), false, 'une session ne vaut que pour son membre');
      assert.strictEqual(vault.hasSession('g2', 'u1'), false, 'une session ne vaut que pour son serveur');
      vault.closeSession('g1', 'u1');
      assert.strictEqual(vault.hasSession('g1', 'u1'), false);
      assert.ok(engine.SESSION_MS <= 15 * 60_000, 'session courte');
    },
  },
  {
    name: 'les raisons d’accès sont lisibles en français',
    run() {
      for (const reason of ['owner', 'authorized', 'role', 'session', 'disabled', 'denied']) {
        const text = engine.describeReason(reason);
        assert.ok(text && typeof text === 'string');
      }
      assert.ok(engine.describeReason('owner').includes('propriétaire'));
      assert.ok(!engine.describeDenial({ reason: 'inconnu' }).includes('undefined'));
    },
  },
];

module.exports = { checks };
