'use strict';
// scripts/mail-test.js — Vérifie l'envoi réel d'une clé de licence.
//
// Le script utilise exactement le même module que le site (`utils/storeMailer`),
// donc ce qui passe ici passera lors d'un achat. Après l'envoi, il interroge
// Resend pour connaître l'état réel du message (envoyé, livré, rejeté).
//
//   node scripts/mail-test.js --to=moi@exemple.fr
//   node scripts/mail-test.js --to=moi@exemple.fr --from="REZO <licences@mon-domaine.fr>"
//   node scripts/mail-test.js --dry            (construit le message, n'envoie rien)
//
// Options :
//   --to=…    destinataire (obligatoire hors --dry)
//   --from=…  expéditeur, écrase STORE_MAIL_FROM
//   --key=…   clé affichée dans le message (défaut : une clé de test)
//   --check=<identifiant>  relit l'état d'un message déjà envoyé, sans renvoyer
//   --dry     aucune requête réseau
//
// La clé API n'est jamais affichée : seulement sa présence et l'état du message.

require('dotenv').config();

const mailer = require('../src/utils/storeMailer');

const RESEND_STATUS = 'https://api.resend.com/emails';
const TEST_KEY = 'REZO-TEST-MAIL-CODE-2026';

function parseArgs(argv) {
  const out = { dry: false };
  for (const arg of argv) {
    if (arg === '--dry') { out.dry = true; continue; }
    const match = /^--([a-z-]+)=(.*)$/i.exec(arg);
    if (!match) continue;
    out[match[1].toLowerCase()] = match[2];
  }
  return out;
}

function maskFrom(from) {
  const value = String(from || '').trim();
  if (!value) return '(vide)';
  // Ne révèle jamais un secret : ici c'est une adresse publique, on l'affiche.
  return value;
}

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function statusOf(id, apiKey) {
  try {
    const res = await fetch(`${RESEND_STATUS}/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = body?.message || `HTTP ${res.status}`;
      // Une clé « Sending access » ne peut pas relire l'état : ce n'est pas un échec.
      return { ok: false, restricted: /restricted to only send/i.test(message), error: message };
    }
    return { ok: true, lastEvent: body?.last_event || 'inconnu' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Interroge Resend jusqu'à un état définitif, puis conclut. */
async function watchAndVerdict(id, apiKey) {
  console.log('\n── Livraison (interrogation de Resend) ──');
  let last = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 1 ? 1500 : 3000));
    last = await statusOf(id, apiKey);
    if (last.restricted) {
      console.log('  clé « Sending access » : lecture de l’état non autorisée (normal).');
      console.log('  Suivi détaillé : resend.com/emails → ce message.');
      break;
    }
    if (!last.ok) {
      console.log(`  état illisible : ${last.error}`);
      break;
    }
    console.log(`  tentative ${attempt} : ${last.lastEvent}`);
    if (['delivered', 'bounced', 'complained', 'failed'].includes(last.lastEvent)) break;
  }

  const verdict = last?.restricted
    ? '✅'
    : last?.ok
      ? (['delivered', 'sent'].includes(last.lastEvent) ? '✅' : '⚠️')
      : '⚠️';
  console.log(`\n${verdict} État final : ${last?.restricted ? 'accepté par Resend (suivi non lisible avec cette clé)' : last?.lastEvent || 'inconnu'}`);
  console.log('   « delivered » = le serveur de messagerie du destinataire a accepté le message.');
  console.log('   S’il n’arrive pas dans la boîte de réception, regarde les indésirables.\n');
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...process.env };
  if (args.from) env.STORE_MAIL_FROM = args.from;

  const provider = mailer.mailProvider(env);
  console.log('\n── Configuration e-mail ──');
  line('Fournisseur', provider || 'aucun (clé manquante)');
  line('BREVO_API_KEY', env.BREVO_API_KEY ? 'présente' : 'vide');
  line('RESEND_API_KEY', env.RESEND_API_KEY ? 'présente' : 'vide');
  line('STORE_MAIL_FROM', maskFrom(env.STORE_MAIL_FROM));

  if (args.dry) {
    const html = mailer.buildHtml({ key: TEST_KEY, plan: 'REZO TEST', amountCents: 0, currency: 'EUR' });
    const text = mailer.buildText({ key: TEST_KEY, plan: 'REZO TEST' });
    console.log('\n── Message construit (aucun envoi) ──');
    line('HTML', `${html.length} caractères`);
    line('Texte', `${text.length} caractères`);
    line('Clé dans le HTML', html.includes(TEST_KEY) ? 'oui' : 'NON');
    line('Clé dans le texte', text.includes(TEST_KEY) ? 'oui' : 'NON');
    console.log(`\n${html.includes(TEST_KEY) && text.includes(TEST_KEY) ? '✅' : '❌'} Message prêt.\n`);
    process.exitCode = html.includes(TEST_KEY) && text.includes(TEST_KEY) ? 0 : 1;
    return;
  }

  if (!mailer.mailConfigured(env)) {
    console.log('\n❌ Envoi impossible : il manque une variable.');
    if (!env.RESEND_API_KEY) {
      console.log('   → RESEND_API_KEY : crée une clé sur https://resend.com/api-keys');
      console.log('     puis ajoute dans .env : RESEND_API_KEY=re_…');
    }
    if (!env.STORE_MAIL_FROM) {
      console.log('   → STORE_MAIL_FROM : expéditeur vérifié chez Resend, par exemple');
      console.log('     STORE_MAIL_FROM=REZO <licences@ton-domaine.fr>');
      console.log('     (sans domaine vérifié, utilise onboarding@resend.dev : Resend');
      console.log('      n’écrit alors qu’à l’adresse du propriétaire du compte)');
    }
    process.exitCode = 1;
    return;
  }

  if (args.check) {
    line('Identifiant', args.check);
    if (provider !== 'resend') {
      console.log('\nℹ️  Le suivi par API n’existe que chez Resend. Chez Brevo, ouvre');
      console.log('   brevo.com → Transactional → Logs pour voir le message.\n');
      return;
    }
    await watchAndVerdict(args.check, env.RESEND_API_KEY);
    return;
  }

  if (!args.to || !mailer.validEmail(args.to)) {
    console.log('\n❌ Destinataire manquant ou invalide.');
    console.log('   Usage : node scripts/mail-test.js --to=moi@exemple.fr\n');
    process.exitCode = 1;
    return;
  }

  const key = args.key || TEST_KEY;
  console.log('\n── Envoi ──');
  line('Destinataire', args.to);
  line('Clé envoyée', key);

  const started = Date.now();
  const sent = await mailer.sendLicenseEmail({
    to: args.to,
    key,
    plan: 'REZO PRO (test)',
    amountCents: 990,
    currency: 'EUR',
    orderUrl: `${env.STORE_PUBLIC_URL || 'http://localhost:3200'}/`,
    env,
  });

  if (!sent.ok) {
    console.log(`\n❌ Resend a refusé l'envoi : ${sent.error}`);
    console.log('   Pistes : clé révoquée, domaine expéditeur non vérifié, ou');
    console.log('   « onboarding@resend.dev » utilisé vers une autre adresse que la tienne.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`  ✅ Accepté par ${sent.provider || provider} en ${Date.now() - started} ms`);
  line('Identifiant', sent.id || '(non fourni)');

  if (sent.provider !== 'resend') {
    console.log('\n✅ Message remis au fournisseur.');
    console.log('   Suivi : brevo.com → Transactional → Logs (statut « delivered »).');
    console.log('   S’il n’arrive pas, regarde les indésirables du destinataire.\n');
    return;
  }

  if (!sent.id) {
    console.log('\n⚠️  Pas d’identifiant retourné : impossible de suivre la livraison.\n');
    return;
  }

  await watchAndVerdict(sent.id, env.RESEND_API_KEY);
})().catch(err => {
  console.error('❌ exception :', err.message);
  process.exitCode = 1;
});
