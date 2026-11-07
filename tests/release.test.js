'use strict';
// tests/release.test.js — Identité publique de REZO.
//
// Vérifie la source unique du nom et de la version (embeds, présence, site) et
// l'absence de tout canal ou étiquette bêta : le dépôt n'en a plus qu'un.

const assert = require('assert');
const pkg = require('../package.json');
const release = require('../src/core/release');
const brand = require('../src/utils/brand');
const { DEFAULTS } = require('../src/utils/botStatus');
const pages = require('../src/utils/storePages');
const store = require('../src/web/storeServer');

const checks = [
  {
    name: 'release expose un nom et une version figés, sans étiquette de canal',
    run() {
      const current = release.currentRelease();
      assert.strictEqual(current.name, 'REZO');
      assert.strictEqual(current.version, pkg.version);
      assert.ok(Object.isFrozen(current), 'l’identité ne doit pas être modifiable à l’exécution');
      assert.strictEqual(current.channel, undefined, 'plus de notion de canal');
      assert.strictEqual(current.badge, undefined, 'plus de badge bêta');
      assert.ok(!/-beta/.test(current.version));
    },
  },
  {
    name: 'les embeds, la présence et le site lisent la même identité',
    run() {
      assert.strictEqual(brand.BRAND.name, 'REZO');
      assert.strictEqual(brand.BRAND.version, pkg.version);
      assert.ok(brand.footer().startsWith('REZO • v'));
      assert.ok(DEFAULTS.activityText.startsWith('REZO —'));

      const html = pages.homePage({});
      assert.ok(html.includes('REZO'));
      assert.ok(html.includes(`v${pkg.version}`));
      assert.ok(!/beta-chip|beta-bar/.test(html), 'aucune étiquette bêta ne doit subsister');
    },
  },
  {
    name: 'le site ne sert plus ni /beta ni /api/release',
    async run() {
      const { PassThrough } = require('stream');
      const call = pathname => new Promise(resolve => {
        const req = new PassThrough();
        req.url = pathname;
        req.method = 'GET';
        req.headers = { host: '127.0.0.1' };
        req.socket = { remoteAddress: '127.0.0.1' };
        const res = {
          status: 0,
          body: '',
          setHeader() {},
          writeHead(status) { this.status = status; },
          end(chunk) { if (chunk) this.body += String(chunk); resolve(this); },
        };
        Promise.resolve()
          .then(() => store.handleRequest(req, res, { env: {}, logger: { info() {}, warn() {}, error() {} } }))
          .catch(() => { res.status = 500; resolve(res); });
      });

      const beta = await call('/beta');
      assert.strictEqual(beta.status, 404);
      const api = await call('/api/release');
      assert.strictEqual(api.status, 404);
    },
  },
  {
    name: 'aucun script npm ni fichier ne référence encore la bêta',
    run() {
      const fs = require('fs');
      const path = require('path');
      const root = path.join(__dirname, '..');

      for (const name of Object.keys(pkg.scripts)) {
        assert.ok(!/beta/i.test(name), `script bêta restant : ${name}`);
      }

      const sources = [
        'src/core/release.js',
        'src/utils/brand.js',
        'src/utils/botStatus.js',
        'src/utils/storePages.js',
        'src/web/storeServer.js',
      ];
      for (const file of sources) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        assert.ok(!/REZO_CHANNEL|betaPage|Cobalt/.test(text), `référence bêta restante : ${file}`);
      }

      const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
      assert.ok(!/REZO_CHANNEL/.test(env), 'REZO_CHANNEL ne doit plus être documentée');
    },
  },
];

module.exports = { checks };
