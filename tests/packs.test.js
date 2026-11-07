'use strict';
// tests/packs.test.js — Les quatre packs tout compris vendus sur le site.
//
// Un pack n'est pas un palier de plus : c'est un bundle qui délivre une clé
// (palier + durée + sièges) avec des prestations. Ces vérifications garantissent
// que le tunnel d'achat existant le traite exactement comme une offre.

const assert = require('assert');
const plans = require('../src/utils/licensePlans');

const PACK_IDS = [
  'pack-decouvreur',
  'pack-lancement',
  'pack-premier-rezo',
  'pack-communaute',
  'pack-reseau',
  'pack-integral',
  'pack-rezo-net',
];

const checks = [
  {
    name: 'sept packs sont exposés, avec des identifiants uniques',
    run() {
      const packs = plans.publicPacks();
      assert.strictEqual(packs.length, 7, `packs trouvés : ${packs.length}`);
      assert.deepStrictEqual(packs.map(p => p.id), PACK_IDS);
    },
  },
  {
    name: 'chaque pack se résout comme une offre achetable',
    run() {
      for (const id of PACK_IDS) {
        const plan = plans.resolvePlan(id);
        assert.ok(plan, `${id} introuvable`);
        if (plan.quote) assert.strictEqual(plan.amountCents, 0, `${id} : un pack sur devis ne doit pas avoir de prix`);
        else assert.ok(plan.amountCents > 0, `${id} : prix absent`);
        assert.strictEqual(plan.currency, 'EUR');
        assert.ok(plan.kind && plan.maxGuilds >= 1, `${id} : palier ou sièges manquants`);
        assert.ok(Array.isArray(plan.perks) && plan.perks.length >= 4, `${id} : prestations manquantes`);
        assert.ok(plan.days === null || plan.days > 0, `${id} : durée invalide`);
      }
    },
  },
  {
    name: 'un pack est un bundle : prix inférieur au cumul annoncé',
    run() {
      for (const pack of plans.publicPacks()) {
        assert.ok(pack.bundle, `${pack.id} n’est pas marqué bundle`);
        if (pack.quote) continue;
        assert.ok(pack.compareAtCents > pack.amountCents, `${pack.id} : prix comparé incohérent`);
        assert.strictEqual(pack.savingsCents, pack.compareAtCents - pack.amountCents);
      }
    },
  },
  {
    name: 'les packs ne polluent pas la liste des offres de licence',
    run() {
      const offers = plans.publicPlans();
      assert.ok(offers.length >= 5, `offres : ${offers.length}`);
      for (const offer of offers) {
        assert.ok(!PACK_IDS.includes(offer.id), `${offer.id} est un pack dans les offres`);
      }
      for (const id of PACK_IDS) {
        if (plans.resolvePlan(id).quote) {
          assert.ok(!plans.planIds().includes(id), `${id} est sur devis : il ne doit pas être achetable`);
        } else {
          assert.ok(plans.planIds().includes(id), `${id} n’est pas achetable`);
        }
      }
    },
  },
  {
    name: 'les prix des packs suivent les variables d’environnement',
    run() {
      const before = plans.resolvePlan('pack-integral').amountCents;
      process.env.SITE_PRICE_PACK_INTEGRAL_CENTS = '12345';
      try {
        assert.strictEqual(plans.resolvePlan('pack-integral').amountCents, 12345);
      } finally {
        delete process.env.SITE_PRICE_PACK_INTEGRAL_CENTS;
      }
      assert.strictEqual(plans.resolvePlan('pack-integral').amountCents, before);
    },
  },
  {
    name: 'la clé émise porte le palier, la durée et les sièges du pack',
    run() {
      const issuer = require('../src/utils/licenseIssuer');

      const expiry = issuer.expiryFor('pack-lancement', new Date('2026-01-01T00:00:00Z'));
      assert.strictEqual(expiry.toISOString().slice(0, 10), '2026-01-31');

      const reseau = plans.resolvePlan('pack-reseau');
      assert.strictEqual(reseau.kind, 'network');
      // Cinq sièges là où l'offre Réseau s'arrête à trois.
      assert.strictEqual(reseau.maxGuilds, 5);

      const integral = plans.resolvePlan('pack-integral');
      assert.strictEqual(integral.kind, 'network');
      assert.strictEqual(integral.maxGuilds, 10);
      assert.strictEqual(integral.graceDays, 14);
    },
  },
  {
    name: 'un pack ouvre des modules que son palier ne donne pas',
    run() {
      const core = require('../src/utils/licenseCore');

      const lancement = plans.resolvePlan('pack-lancement');
      assert.ok(lancement.extras.includes('leveling'), 'niveaux absents du pack Lancement');
      assert.strictEqual(core.featureAllowed('essentiel', 'leveling'), false, 'Essentiel seul ne doit pas ouvrir /leveling');
      assert.strictEqual(core.featureAllowed('essentiel', 'leveling', lancement.extras), true, 'le pack doit ouvrir /leveling');

      const communaute = plans.resolvePlan('pack-communaute');
      assert.ok(communaute.extras.includes('ia'), 'IA absente du pack Communauté');
      assert.strictEqual(core.featureAllowed('standard', 'ia'), false, 'Standard seul ne doit pas ouvrir /ia');
      assert.strictEqual(core.featureAllowed('standard', 'ia', communaute.extras), true, 'le pack doit ouvrir /ia');

      // Une licence individuelle n'apporte aucun module en plus.
      for (const offer of plans.publicPlans()) {
        assert.ok(!offer.extras || offer.extras.length === 0, `${offer.id} ne doit pas avoir d’extras`);
      }

      // Le compte affiché dans le panel doit refléter les extras, pas le palier nu.
      assert.ok(core.featuresFor('essentiel', lancement.extras).length > core.featuresForKind('essentiel').length);
    },
  },
  {
    name: 'le panel /license décrit les packs sans promettre d’achat dans Discord',
    run() {
      const cmd = require('../src/commands/configuration/license');
      assert.strictEqual(typeof cmd.buildPacksEmbed, 'function', 'buildPacksEmbed non exporté');

      const embed = cmd.buildPacksEmbed().toJSON();
      const fields = embed.fields || [];
      assert.strictEqual(fields.length, 7, `packs affichés : ${fields.length}`);
      assert.ok(
        /ne s.achètent pas depuis Discord/i.test(embed.description || ''),
        'le panel doit dire que l’achat se fait sur le site',
      );
      assert.ok(/\/packs/.test(embed.description || ''), 'lien du site absent');

      for (const pack of plans.publicPacks()) {
        assert.ok(fields.some(f => f.name.includes(pack.label)), `${pack.label} absent du panel`);
      }
      for (const field of fields) {
        assert.ok(field.name.length <= 256, 'nom de champ hors limite Discord');
        assert.ok(field.value.length <= 1024, 'valeur de champ hors limite Discord');
      }
      assert.ok(JSON.stringify(embed).length <= 6000, 'embed hors limite Discord');
    },
  },
  {
    name: 'le pack sur devis n’est ni chiffré, ni commandable, ni émis automatiquement',
    async run() {
      const quote = plans.resolvePlan('pack-rezo-net');
      assert.ok(quote.quote, 'pack-rezo-net doit être marqué sur devis');
      assert.strictEqual(quote.amountCents, 0, 'un devis ne porte pas de prix');
      assert.strictEqual(quote.durationLabel, 'sur devis');

      const store = require('../src/utils/licenseStore');
      const created = await store.createOrder({ planId: 'pack-rezo-net' });
      assert.strictEqual(created.ok, false, 'aucune commande ne doit être créée pour un devis');
      assert.ok(/devis/i.test(created.error || ''), `erreur inattendue : ${created.error}`);

      const issuer = require('../src/utils/licenseIssuer');
      const issued = await issuer.issueKey({ planId: 'pack-rezo-net', createdBy: 'test' });
      assert.strictEqual(issued.ok, false, 'une clé ne doit pas être émise pour un devis');
    },
  },
  {
    name: 'le pack sur devis est affiché sans prix et sans formulaire',
    run() {
      const pages = require('../src/utils/storePages');
      const html = pages.packsPage({ packs: plans.publicPacks() });
      assert.ok(/Sur devis/i.test(html), 'mention « sur devis » absente');
      assert.ok(!/value="pack-rezo-net"/.test(html), 'le pack sur devis ne doit pas avoir de formulaire');
      assert.strictEqual((html.match(/action="\/acheter"/g) || []).length, 6, 'seuls les packs chiffrés ont un formulaire');
    },
  },
  {
    name: 'une offre inconnue reste refusée',
    run() {
      assert.strictEqual(plans.resolvePlan('pack-inexistant'), null);
      assert.strictEqual(plans.resolvePlan(''), null);
    },
  },
];

module.exports = { checks };
