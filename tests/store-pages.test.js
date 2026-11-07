'use strict';
// tests/store-pages.test.js — Pages publiques et API du site.
//
// Vérifie le rendu hors-ligne (aucune base, aucun réseau) et le routage HTTP
// réel via `handleRequest` avec des objets req/res factices.

const assert = require('assert');
const pages = require('../src/utils/storePages');
const content = require('../src/utils/storeContent');
const store = require('../src/web/storeServer');
const { publicPacks } = require('../src/utils/licensePlans');

// ── Client HTTP minimal ─────────────────────────────────────────────────────
function call(pathname, { method = 'GET', env = {}, body = '' } = {}) {
  const { PassThrough } = require('stream');
  return new Promise(resolve => {
    const req = new PassThrough();
    req.url = pathname;
    req.method = method;
    req.headers = { host: '127.0.0.1', 'user-agent': 'tests' };
    req.socket = { remoteAddress: '127.0.0.1' };

    const res = {
      status: 0,
      headers: {},
      body: '',
      setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
      writeHead(status, headers) {
        this.status = status;
        for (const [key, value] of Object.entries(headers || {})) this.headers[String(key).toLowerCase()] = value;
      },
      end(chunk) {
        if (chunk) this.body += String(chunk);
        resolve(this);
      },
    };

    Promise.resolve()
      .then(() => store.handleRequest(req, res, {
        env: { ...env },
        logger: { info() {}, warn() {}, error() {}, log() {} },
      }))
      .catch(err => {
        res.status = 500;
        res.body = `ERREUR ${err.message}`;
        resolve(res);
      });
  });
}

const checks = [
  {
    name: 'la FAQ affiche tous les groupes et reste lisible sans script',
    run() {
      const html = pages.faqPage();
      assert.ok(/Questions fréquentes/.test(html));
      for (const group of content.FAQ_GROUPS) {
        // Le rendu échappe le texte : on compare à la version échappée.
        assert.ok(html.includes(pages.esc(group.title)), `groupe absent : ${group.title}`);
        for (const item of group.items) {
          assert.ok(html.includes(pages.esc(item.q)), `question absente : ${item.q}`);
        }
      }
      assert.ok(html.includes('<details>'), 'les réponses doivent être présentes même sans JS');
      assert.ok(html.includes('id="faq-q"'), 'champ de recherche absent');
    },
  },
  {
    name: 'les données structurées de la FAQ sont un JSON valide',
    run() {
      const html = pages.faqPage();
      const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      assert.ok(match, 'JSON-LD absent');
      assert.ok(!match[1].includes('</script'), 'le JSON-LD peut refermer la balise');
      const data = JSON.parse(match[1].replace(/\\u003c/g, '<'));
      assert.strictEqual(data['@type'], 'FAQPage');
      const total = content.FAQ_GROUPS.reduce((sum, group) => sum + group.items.length, 0);
      assert.strictEqual(data.mainEntity.length, total);
    },
  },
  {
    name: 'la FAQ échappe le contenu injecté',
    run() {
      const html = pages.faqPage({
        groups: [{ id: 'x', title: 'Titre <b>', items: [{ q: '<script>alert(1)</script>', a: '</script><img onerror=1>' }] }],
      });
      assert.ok(!html.includes('<script>alert(1)</script>'), 'question non échappée');
      assert.ok(!html.includes('<img onerror=1>'), 'réponse non échappée');
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    },
  },
  {
    name: 'le guide décrit l’activation réelle (/license) et les pannes',
    run() {
      const html = pages.guidePage();
      assert.ok(/\/license/.test(html));
      assert.ok(/Activer une clé/.test(html));
      assert.ok(/jamais/.test(html), 'l’avertissement anti-phishing doit être présent');
      for (const item of content.GUIDE_TROUBLES) {
        assert.ok(html.includes(pages.esc(item.q)), `panne absente : ${item.q}`);
      }
      assert.ok(html.includes('href="/verifier"'));
    },
  },
  {
    name: 'le journal liste les nouveautés, du plus récent au plus ancien',
    run() {
      const html = pages.changelogPage();
      let last = '9999-99-99';
      for (const entry of content.CHANGELOG) {
        assert.ok(html.includes(entry.title), `entrée absente : ${entry.title}`);
        assert.ok(entry.date <= last, 'le journal doit être trié du plus récent au plus ancien');
        last = entry.date;
      }
      assert.ok(html.includes('<time datetime='));
    },
  },
  {
    name: 'la navigation et le pied de page mènent aux nouvelles pages',
    run() {
      const html = pages.homePage({ plans: [], tiers: [], stats: {} });
      for (const path of ['/faq', '/guide', '/nouveautes']) {
        assert.ok(html.includes(`href="${path}"`), `lien absent : ${path}`);
      }
    },
  },
  {
    name: 'GET /faq répond 200 avec une CSP stricte',
    async run() {
      const res = await call('/faq');
      assert.strictEqual(res.status, 200);
      assert.ok(/text\/html/.test(res.headers['content-type']));
      assert.ok(/default-src 'none'/.test(res.headers['content-security-policy']));
      assert.ok(res.body.includes('Questions fréquentes'));
    },
  },
  {
    name: 'GET /guide et GET /nouveautes répondent 200',
    async run() {
      const guide = await call('/guide');
      assert.strictEqual(guide.status, 200);
      assert.ok(guide.body.includes('Activer une clé'));

      const news = await call('/nouveautes');
      assert.strictEqual(news.status, 200);
      assert.ok(news.body.includes('Nouveautés'));
    },
  },
  {
    name: 'GET /api/faq expose les mêmes réponses en JSON',
    async run() {
      const res = await call('/api/faq');
      assert.strictEqual(res.status, 200);
      const data = JSON.parse(res.body);
      assert.ok(Array.isArray(data.groups));
      assert.strictEqual(data.groups.length, content.FAQ_GROUPS.length);
      assert.ok(data.groups[0].items[0].q.length > 0);
      assert.ok(data.groups[0].items[0].a.length > 0);
    },
  },
  {
    name: 'GET /api/packs renvoie les packs réels, avec leurs prix',
    async run() {
      const res = await call('/api/packs');
      assert.strictEqual(res.status, 200);
      const data = JSON.parse(res.body);
      const expected = publicPacks();
      assert.strictEqual(data.packs.length, expected.length);
      assert.strictEqual(data.currency, 'EUR');
      const quote = data.packs.find(pack => pack.quote);
      assert.ok(quote, 'le pack sur devis doit être présent');
      assert.ok(!('payload' in quote), 'aucune donnée interne ne doit fuiter');
    },
  },
  {
    name: 'le sitemap annonce les nouvelles pages',
    async run() {
      const res = await call('/sitemap.xml');
      assert.strictEqual(res.status, 200);
      for (const path of ['/faq', '/guide', '/nouveautes']) {
        assert.ok(res.body.includes(path), `sitemap incomplet : ${path}`);
      }
      assert.strictEqual(store.SITEMAP_PATHS.length, new Set(store.SITEMAP_PATHS).size);
    },
  },
];

module.exports = { checks };
