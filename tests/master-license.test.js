'use strict';
// tests/master-license.test.js — La licence maître protège l'émission de clés.
//
// Le dépôt est public : une copie du bot ne doit pas pouvoir fabriquer des clés
// `REZO-…` sans un jeton signé par la clé privée de l'éditeur. Ces vérifications
// couvrent la vérification Ed25519 (signature, expiration, portée) et les deux
// points d'émission (`licenseIssuer.issueKey`, `licenseGate.createLicense`).

const master = require('../src/utils/masterLicense');

function ok(value, label) {
  if (!value) throw new Error(label);
}

const { publicKeyPem, privateKeyPem } = master.generateKeyPair();
const { publicKeyPem: otherPublicKey } = master.generateKeyPair();
const nowSec = Math.floor(Date.now() / 1000);

function makeToken(overrides = {}) {
  return master.signToken({
    sub: 'rezo',
    iat: nowSec,
    exp: nowSec + 3600,
    note: 'test',
    ...overrides,
  }, privateKeyPem);
}

// Remplace la charge utile sans resigner : c'est exactement ce que tenterait
// quelqu'un qui veut prolonger un jeton sans la clé privée.
function forgePayload(token, patch) {
  const [prefix, encoded, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  Object.assign(payload, patch);
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${prefix}.${forged}.${signature}`;
}

async function withInvalidMaster(run) {
  const saved = process.env.MASTER_LICENSE;
  process.env.MASTER_LICENSE = 'rezomaster1.YWJj.def';
  master.resetCache();
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.MASTER_LICENSE;
    else process.env.MASTER_LICENSE = saved;
    master.resetCache();
  }
}

module.exports = {
  checks: [
    {
      name: 'un jeton signé est accepté par la clé publique correspondante',
      run() {
        const state = master.verifyToken(makeToken(), { publicKey: publicKeyPem });
        ok(state.ok, `jeton refusé : ${state.reason}`);
        ok(state.payload.sub === 'rezo', 'titulaire non lu');
        ok(state.expiresAt instanceof Date, 'date d’expiration absente');
      },
    },
    {
      name: 'une charge utile modifiée est refusée (signature)',
      run() {
        const token = forgePayload(makeToken(), { exp: nowSec + 99_999_999 });
        const state = master.verifyToken(token, { publicKey: publicKeyPem });
        ok(!state.ok && state.reason === 'signature', `attendu « signature », reçu « ${state.reason} »`);
      },
    },
    {
      name: 'un jeton expiré est refusé',
      run() {
        const state = master.verifyToken(makeToken({ exp: nowSec - 60 }), { publicKey: publicKeyPem });
        ok(!state.ok && state.reason === 'expired', `attendu « expired », reçu « ${state.reason} »`);
      },
    },
    {
      name: 'un jeton absent est refusé sans lever',
      run() {
        const state = master.verifyToken('', { publicKey: publicKeyPem });
        ok(!state.ok && state.reason === 'missing', `attendu « missing », reçu « ${state.reason} »`);
      },
    },
    {
      name: 'une autre clé publique ne valide pas le jeton',
      run() {
        const state = master.verifyToken(makeToken(), { publicKey: otherPublicKey });
        ok(!state.ok && state.reason === 'signature', `attendu « signature », reçu « ${state.reason} »`);
      },
    },
    {
      name: 'un jeton sans portée « issuer » est refusé',
      run() {
        const state = master.verifyToken(makeToken({ scope: 'read' }), { publicKey: publicKeyPem });
        ok(!state.ok && state.reason === 'scope', `attendu « scope », reçu « ${state.reason} »`);
      },
    },
    {
      name: 'une date de signature dans le futur est refusée',
      run() {
        const state = master.verifyToken(makeToken({ iat: nowSec + 3600 }), { publicKey: publicKeyPem });
        ok(!state.ok && state.reason === 'not_yet_valid', `attendu « not_yet_valid », reçu « ${state.reason} »`);
      },
    },
    {
      name: 'issueKey refuse d’émettre sans licence maître valide',
      run: async () => {
        const res = await withInvalidMaster(() => require('../src/utils/licenseIssuer').issueKey({
          planId: 'essentiel',
          createdBy: 'test',
        }));
        ok(res.ok === false, 'une clé a été émise sans licence maître');
        ok(res.code === 'master_locked', `code attendu « master_locked », reçu « ${res.code} »`);
        ok(!res.key, 'aucune clé ne doit être renvoyée');
      },
    },
    {
      name: 'createLicense refuse d’émettre sans licence maître valide',
      run: async () => {
        const res = await withInvalidMaster(async () => {
          try {
            await require('../src/utils/licenseGate').createLicense('test', { kind: 'standard' });
            return null;
          } catch (err) {
            return err;
          }
        });
        ok(res, 'createLicense a créé une licence sans licence maître');
        ok(res.code === 'master_locked', `code attendu « master_locked », reçu « ${res.code} »`);
      },
    },
  ],
};
