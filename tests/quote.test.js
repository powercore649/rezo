'use strict';
// tests/quote.test.js — Formulaire de devis du Pack REZO.net.
//
// Le parcours est : site → base → MP de l'owner → clic → MP de l'acheteur.
// Ces vérifications couvrent ce qui est testable hors-ligne : validation,
// contenu des messages, rendu de la page et carte d'approbation.

const assert = require('assert');
const { validateQuote, DURATIONS, daysFor, seatsFor } = require('../src/utils/quoteRequest');
const mailer = require('../src/utils/storeMailer');
const pages = require('../src/utils/storePages');
const plans = require('../src/utils/licensePlans');
const notifier = require('../src/utils/quoteNotifier');

const VALID = {
  name: 'Raph',
  email: 'client@exemple.fr',
  discord: 'raph#0001',
  discordId: '223456789012345678',
  guildId: '123456789012345678',
  guildName: 'Mon réseau',
  servers: '5',
  members: '12000',
  duration: '1 an',
  startDate: '2026-12-01',
  budget: '300 €',
  modules: 'IA, sauvegardes',
  message: 'Réseau de cinq serveurs gaming.',
  consent: '1',
};

const QUOTE_ID = 'a'.repeat(24);

const checks = [
  {
    name: 'une demande complète passe la validation',
    run() {
      const result = validateQuote(VALID);
      assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
      assert.strictEqual(result.values.servers, 5);
      assert.strictEqual(result.values.members, 12000);
      assert.strictEqual(result.values.discordId, VALID.discordId);
      assert.deepStrictEqual(result.errors, {});
    },
  },
  {
    name: 'un formulaire vide est refusé champ par champ',
    run() {
      const result = validateQuote({});
      assert.strictEqual(result.ok, false);
      for (const field of ['name', 'email', 'discordId', 'guildId', 'guildName', 'servers', 'members', 'duration', 'consent']) {
        assert.ok(result.errors[field], `${field} devrait être signalé`);
      }
    },
  },
  {
    name: 'un e-mail, un ID Discord ou un ID de serveur invalide est refusé',
    run() {
      const result = validateQuote({ ...VALID, email: 'pas-un-email', discordId: '1234', guildId: '123' });
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.email);
      assert.ok(result.errors.discordId);
      assert.ok(result.errors.guildId);
    },
  },
  {
    name: 'les saisies sont bornées et nettoyées',
    run() {
      const result = validateQuote({ ...VALID, message: 'x'.repeat(5000), guildId: '123 456 789 012 345 678' });
      assert.ok(result.values.message.length <= 1500);
      assert.strictEqual(result.values.guildId, '123456789012345678');
      assert.ok(DURATIONS.includes(result.values.duration));
    },
  },
  {
    name: 'la durée et les sièges accordés sont bornés',
    run() {
      assert.strictEqual(daysFor('3 mois'), 90);
      assert.strictEqual(daysFor('6 mois'), 180);
      assert.strictEqual(daysFor('1 an'), 365);
      assert.strictEqual(daysFor('sur mesure'), 365);
      assert.strictEqual(daysFor('n’importe quoi'), 365);
      assert.strictEqual(seatsFor(5), 5);
      assert.strictEqual(seatsFor('3'), 3);
      assert.strictEqual(seatsFor(0), 1);
      assert.strictEqual(seatsFor(500), 25);
    },
  },
  {
    name: 'sans configuration e-mail, l’envoi de secours est refusé explicitement',
    async run() {
      const result = await mailer.sendQuoteEmail({ fields: VALID, env: {}, fetchImpl: null });
      assert.strictEqual(result.ok, false);
      assert.ok(/mail non configuré/i.test(result.error), `erreur inattendue : ${result.error}`);
    },
  },
  {
    name: 'l’e-mail de secours part au propriétaire, avec le client en reply-to',
    async run() {
      let captured = null;
      const fetchImpl = async (url, options) => {
        captured = { url, body: JSON.parse(options.body) };
        return { ok: true, status: 200, text: async () => '{"messageId":"abc"}' };
      };
      const env = {
        BREVO_API_KEY: 'xkey',
        STORE_MAIL_FROM: 'REZO <licences@exemple.fr>',
        STORE_QUOTE_TO: 'raphwieczorek@gmail.com',
      };

      const result = await mailer.sendQuoteEmail({ fields: VALID, env, fetchImpl, siteUrl: 'https://exemple.fr' });
      assert.strictEqual(result.ok, true, result.error);
      assert.strictEqual(captured.body.to[0].email, 'raphwieczorek@gmail.com');
      assert.strictEqual(captured.body.replyTo.email, 'client@exemple.fr');
      assert.ok(/Devis REZO\.net/.test(captured.body.subject));
    },
  },
  {
    name: 'le message de secours contient toutes les informations saisies',
    run() {
      const text = mailer.buildQuoteText({ fields: VALID, sentAt: new Date('2026-01-01T10:00:00Z') });
      for (const value of [VALID.name, VALID.email, VALID.discordId, VALID.guildId, VALID.guildName, VALID.servers, VALID.members, VALID.modules, VALID.message]) {
        assert.ok(text.includes(String(value)), `valeur absente du message : ${value}`);
      }
      assert.ok(text.includes('2026-01-01T10:00:00.000Z'));
    },
  },
  {
    name: 'le HTML du message de secours échappe les saisies',
    run() {
      const html = mailer.buildQuoteHtml({ fields: { ...VALID, message: '<script>alert(1)</script>' } });
      assert.ok(!html.includes('<script>alert(1)</script>'), 'saisie non échappée');
      assert.ok(html.includes('&lt;script&gt;'));
    },
  },
  {
    name: 'la page /devis contient les 14 champs et poste vers /devis',
    run() {
      const html = pages.quotePage({ pack: plans.publicPacks().find(p => p.quote) });
      for (const name of ['name', 'email', 'discord', 'discordId', 'guildId', 'guildName', 'servers', 'members', 'duration', 'startDate', 'budget', 'modules', 'message', 'consent']) {
        assert.ok(new RegExp(`name="${name}"`).test(html), `champ manquant : ${name}`);
      }
      assert.ok(/action="\/devis"/.test(html), 'formulaire non relié à /devis');
      assert.ok(!/action="\/acheter"/.test(html), 'aucun achat ne doit être proposé');
      assert.ok(/messages? privé|MP/.test(html), 'la livraison en MP doit être annoncée');
    },
  },
  {
    name: 'le formulaire reste envoyable même sans configuration e-mail',
    run() {
      const html = pages.quotePage({ mailReady: false });
      assert.ok(!/<button[^>]*disabled/.test(html), 'le bouton ne doit pas être désactivé');
      assert.ok(!/non configuré/i.test(html), 'aucun avertissement e-mail ne doit bloquer la demande');
    },
  },
  {
    name: 'la confirmation annonce la réponse en message privé',
    run() {
      const html = pages.quotePage({ sent: true });
      assert.ok(/Demande de devis envoyée/.test(html));
      assert.ok(/message privé/i.test(html));
    },
  },
  {
    name: 'la carte envoyée à l’owner contient tout et les deux boutons',
    run() {
      const quote = {
        _id: QUOTE_ID, name: 'Raph', email: 'client@exemple.fr', discord: 'raph#0001',
        discordId: '223456789012345678', guildId: '123456789012345678', guildName: 'Mon réseau',
        servers: 5, members: 12000, duration: '1 an', startDate: '2026-12-01',
        budget: '300 €', modules: 'IA', message: 'Cinq serveurs à relier.', createdAt: new Date(),
      };
      const embed = notifier.buildQuoteEmbed(quote).toJSON();
      const text = JSON.stringify(embed);
      for (const value of [quote.name, quote.discordId, quote.guildId, quote.guildName, quote.modules, quote.message]) {
        assert.ok(text.includes(value), `valeur absente de la carte : ${value}`);
      }
      assert.ok(text.includes('223456789012345678'));

      const rows = notifier.buildQuoteRows(QUOTE_ID).map(r => r.toJSON());
      const ids = rows.flatMap(r => r.components.map(c => c.custom_id));
      assert.deepStrictEqual(ids, [`quote_ok_${QUOTE_ID}`, `quote_no_${QUOTE_ID}`]);
      assert.ok(/Approuver/.test(JSON.stringify(rows)));
    },
  },
  {
    name: 'le pack sur devis renvoie vers le formulaire, pas vers un achat',
    run() {
      const html = pages.packsPage({ packs: plans.publicPacks() });
      assert.ok(/href="\/devis"/.test(html), 'lien du formulaire absent');
      assert.strictEqual((html.match(/action="\/acheter"/g) || []).length, 6);
    },
  },
];

module.exports = { checks };
