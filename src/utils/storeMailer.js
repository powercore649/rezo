'use strict';
// utils/storeMailer.js — Envoi de la clé de licence par e-mail.
//
// Le site n'envoie qu'un seul type de message : la clé achetée. Il part par
// l'API HTTP de Resend (aucun SDK, aucun serveur SMTP à maintenir), avec un
// simple `fetch`. Si la configuration manque, rien n'est tenté et l'appelant
// reçoit `{ ok:false, error:'mail non configuré' }` — jamais une exception.
//
// Variables :
//   RESEND_API_KEY     clé API (serveur uniquement)
//   STORE_MAIL_FROM    expéditeur, ex. « REZO <licences@rezo.bot> »
//   STORE_MAIL_REPLY_TO  facultatif, adresse de réponse
//
// Le module est pur vis-à-vis du réseau : `fetchImpl` est injectable, donc
// testable hors-ligne.

const { formatPrice } = require('./licensePlans');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const SUPPORT_FALLBACK = 'https://discord.gg/rezo';

/**
 * Fournisseur actif : `brevo` ou `resend`.
 *
 * Brevo est prioritaire quand sa clé existe, parce qu'il sait envoyer à
 * n'importe quel destinataire dès qu'une simple adresse d'expédition est
 * vérifiée — sans domaine à acheter. `STORE_MAIL_PROVIDER` force l'autre choix.
 */
function mailProvider(env = process.env) {
  const explicit = String(env.STORE_MAIL_PROVIDER || '').trim().toLowerCase();
  const hasBrevo = Boolean(String(env.BREVO_API_KEY || '').trim());
  const hasResend = Boolean(String(env.RESEND_API_KEY || '').trim());
  if (explicit === 'brevo') return hasBrevo ? 'brevo' : null;
  if (explicit === 'resend') return hasResend ? 'resend' : null;
  if (hasBrevo) return 'brevo';
  if (hasResend) return 'resend';
  return null;
}

function mailConfigured(env = process.env) {
  return Boolean(mailProvider(env) && String(env.STORE_MAIL_FROM || '').trim());
}

/** « REZO <licences@site.fr> » → { name: 'REZO', email: 'licences@site.fr' } */
function parseSender(raw) {
  const value = String(raw || '').trim();
  const match = /^(.*)<([^>]+)>$/.exec(value);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '') || 'REZO';
    return { name, email: match[2].trim() };
  }
  return { name: 'REZO', email: value };
}

/** Adresse exploitable ? (volontairement permissif : Resend tranchera) */
function validEmail(value) {
  return typeof value === 'string' && /.+@.+\..+/.test(value.trim());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Texte brut : lisible dans n'importe quel client, même sans HTML. */
function buildText({ key, plan, tierLabel = '', seats = 1, graceDays = 0, amountCents, currency, orderUrl, supportUrl }) {
  return [
    'Merci pour ton achat — voici ta clé de licence REZO.',
    '',
    `Clé     : ${key}`,
    `Offre   : ${plan}`,
    tierLabel ? `Palier  : ${tierLabel}` : null,
    `Serveurs: ${seats}`,
    amountCents != null ? `Montant : ${formatPrice(amountCents, currency)}` : null,
    '',
    'ACTIVATION',
    '1. Ouvre ton serveur Discord et tape /license',
    '2. Clique « Activer une clé »',
    '3. Colle la clé ci-dessus',
    '',
    seats > 1
      ? `Cette clé couvre ${seats} serveurs : répète l’activation sur chacun.`
      : 'Cette clé couvre 1 serveur.',
    graceDays ? `Après expiration, ${graceDays} jour(s) de grâce laissent le temps de renouveler.` : null,
    orderUrl ? `Suivi de commande : ${orderUrl}` : null,
    `Besoin d'aide ? ${supportUrl}`,
    '',
    'REZO — site et bot indépendants, non affiliés à Discord Inc.',
  ].filter(Boolean).join('\n');
}

/** Carte sombre simple : rendu correct dans Gmail, Outlook et Apple Mail. */
function buildHtml({ key, plan, tierLabel = '', seats = 1, graceDays = 0, amountCents, currency, orderUrl, supportUrl }) {
  const amount = amountCents != null ? formatPrice(amountCents, currency) : null;
  const seatsLine = seats > 1
    ? `Cette clé couvre <b style="color:#e9e5ef">${escapeHtml(seats)} serveurs</b> : répète l’activation sur chacun.`
    : 'Cette clé couvre 1 serveur.';
  const graceLine = graceDays
    ? ` Après expiration, ${escapeHtml(graceDays)} jour(s) de grâce laissent le temps de renouveler.`
    : '';
  return `<!doctype html>
<html lang="fr"><body style="margin:0;padding:24px;background:#0c0910;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e9e5ef">
  <div style="max-width:520px;margin:0 auto;background:#15111c;border:1px solid #2a2335;border-radius:14px;padding:28px">
    <div style="font-size:13px;letter-spacing:.14em;color:#b49bff;text-transform:uppercase;margin-bottom:14px">REZO · Licence</div>
    <h1 style="margin:0 0 10px;font-size:21px;line-height:1.3">Ta clé de licence est prête</h1>
    <p style="margin:0 0 20px;color:#a79fb6;font-size:14px">Merci pour ton achat. Voici ta clé pour l’offre <b style="color:#e9e5ef">${escapeHtml(plan)}</b>${tierLabel ? ` — palier <b style="color:#e9e5ef">${escapeHtml(tierLabel)}</b>` : ''}${amount ? ` (${escapeHtml(amount)})` : ''}.</p>
    <div style="background:#0c0910;border:1px dashed #3b3350;border-radius:10px;padding:16px;text-align:center;font-family:ui-monospace,Consolas,monospace;font-size:17px;letter-spacing:.06em;color:#f5d68a;word-break:break-all">${escapeHtml(key)}</div>
    <div style="margin-top:24px;font-size:14px;color:#a79fb6">
      <b style="color:#e9e5ef">Activation</b>
      <ol style="margin:8px 0 0;padding-left:20px">
        <li>Tape <code style="color:#e9e5ef">/license</code> sur ton serveur</li>
        <li>Clique « Activer une clé »</li>
        <li>Colle la clé</li>
      </ol>
    </div>
    <p style="margin:18px 0 0;font-size:13px;color:#8f87a0">${seatsLine}${graceLine}</p>
    ${orderUrl ? `<p style="margin:14px 0 0"><a href="${escapeHtml(orderUrl)}" style="color:#b49bff;font-size:13px">Suivre ma commande</a></p>` : ''}
    <hr style="border:0;border-top:1px solid #2a2335;margin:22px 0">
    <p style="margin:0;font-size:12px;color:#8f87a0">Besoin d’aide ? <a href="${escapeHtml(supportUrl)}" style="color:#b49bff">Support</a><br>
    REZO — site et bot indépendants, non affiliés à Discord Inc.</p>
  </div>
</body></html>`;
}

/**
 * Envoie la clé par e-mail.
 * @returns {Promise<{ok:true, id:string|null}|{ok:false, error:string}>}
 */
async function sendLicenseEmail({
  to, key, plan = 'REZO', tierLabel = '', seats = 1, graceDays = 0,
  amountCents = null, currency = 'EUR',
  orderUrl = '', supportUrl = SUPPORT_FALLBACK,
  env = process.env, fetchImpl = globalThis.fetch,
} = {}) {
  if (!validEmail(to)) return { ok: false, error: 'adresse e-mail invalide' };
  if (!key) return { ok: false, error: 'aucune clé à envoyer' };
  const provider = mailProvider(env);
  if (!provider) return { ok: false, error: 'mail non configuré' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch indisponible' };

  const subject = `Ta clé de licence REZO — ${plan}`;
  const text = buildText({ key, plan, tierLabel, seats, graceDays, amountCents, currency, orderUrl, supportUrl });
  const html = buildHtml({ key, plan, tierLabel, seats, graceDays, amountCents, currency, orderUrl, supportUrl });
  const replyTo = String(env.STORE_MAIL_REPLY_TO || '').trim();

  let url; let headers; let body;
  if (provider === 'brevo') {
    url = BREVO_ENDPOINT;
    headers = {
      'api-key': String(env.BREVO_API_KEY).trim(),
      'Content-Type': 'application/json',
    };
    body = {
      sender: parseSender(env.STORE_MAIL_FROM),
      to: [{ email: to.trim() }],
      subject,
      htmlContent: html,
      textContent: text,
    };
    if (replyTo) body.replyTo = { email: replyTo };
  } else {
    url = RESEND_ENDPOINT;
    headers = {
      Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`,
      'Content-Type': 'application/json',
    };
    body = { from: String(env.STORE_MAIL_FROM).trim(), to: [to.trim()], subject, text, html };
    if (replyTo) body.reply_to = replyTo;
  }

  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, error: err?.message || `${provider} injoignable`, provider };
  }

  const raw = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* réponse non JSON */ }

  if (!res.ok) {
    const detail = parsed?.message || parsed?.error?.message || `HTTP ${res.status}`;
    return { ok: false, error: detail, provider };
  }
  return { ok: true, id: parsed?.id || parsed?.messageId || null, provider };
}

// ── Demande de devis (Pack REZO.net) ────────────────────────────────────────
// Secours du formulaire /devis : la demande part normalement en base puis en
// MP Discord au propriétaire. Ce message n'est envoyé que si l'enregistrement
// échoue, pour qu'une panne de base ne perde jamais une demande.
const DEFAULT_QUOTE_TO = 'raphwieczorek@gmail.com';

function quoteRecipient(env = process.env) {
  return String(env.STORE_QUOTE_TO || '').trim() || DEFAULT_QUOTE_TO;
}

const QUOTE_ROWS = [
  ['Nom / pseudo', 'name'],
  ['E-mail', 'email'],
  ['Discord', 'discord'],
  ['ID Discord (MP)', 'discordId'],
  ['Serveur', 'guildName'],
  ['ID du serveur', 'guildId'],
  ['Serveurs à couvrir', 'servers'],
  ['Membres cumulés', 'members'],
  ['Durée souhaitée', 'duration'],
  ['Mise en service', 'startDate'],
  ['Budget envisagé', 'budget'],
  ['Modules prioritaires', 'modules'],
  ['Contexte', 'message'],
];

function quoteEntries(fields = {}) {
  return QUOTE_ROWS
    .map(([label, key]) => [label, fields[key]])
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
}

function buildQuoteText({ fields = {}, sentAt = new Date(), siteUrl = '' } = {}) {
  return [
    'Nouvelle demande de devis — Pack REZO.net',
    '',
    ...quoteEntries(fields).map(([label, value]) => `${label} : ${value}`),
    '',
    `Reçue le ${new Date(sentAt).toISOString()}`,
    siteUrl ? `Site : ${siteUrl}` : null,
  ].filter(Boolean).join('\n');
}

function buildQuoteHtml({ fields = {}, sentAt = new Date(), siteUrl = '' } = {}) {
  const rows = quoteEntries(fields).map(([label, value]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#8f87a0;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
        <td style="padding:6px 0;color:#e9e5ef;font-size:14px;white-space:pre-wrap">${escapeHtml(value)}</td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="fr"><body style="margin:0;padding:24px;background:#0c0910;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e9e5ef">
  <div style="max-width:560px;margin:0 auto;background:#15111c;border:1px solid #2a2335;border-radius:14px;padding:26px">
    <div style="font-size:13px;letter-spacing:.14em;color:#b49bff;text-transform:uppercase;margin-bottom:12px">REZO · Devis</div>
    <h1 style="margin:0 0 6px;font-size:20px">Demande de devis — Pack REZO.net</h1>
    <p style="margin:0 0 18px;color:#a79fb6;font-size:13px">Réponds directement à ce message pour recontacter le demandeur.</p>
    <table style="width:100%;border-collapse:collapse">${rows}
    </table>
    <hr style="border:0;border-top:1px solid #2a2335;margin:20px 0">
    <p style="margin:0;font-size:12px;color:#8f87a0">Reçue le ${escapeHtml(new Date(sentAt).toISOString())}${siteUrl ? ` · ${escapeHtml(siteUrl)}` : ''}</p>
  </div>
</body></html>`;
}

/**
 * Envoie une demande de devis au propriétaire.
 * @returns {Promise<{ok:true, id:string|null, to:string}|{ok:false, error:string}>}
 */
async function sendQuoteEmail({ fields = {}, env = process.env, fetchImpl = globalThis.fetch, sentAt = new Date(), siteUrl = '' } = {}) {
  const to = quoteRecipient(env);
  if (!validEmail(to)) return { ok: false, error: 'destinataire du devis invalide' };
  const provider = mailProvider(env);
  if (!provider) return { ok: false, error: 'mail non configuré' };
  if (!String(env.STORE_MAIL_FROM || '').trim()) return { ok: false, error: 'STORE_MAIL_FROM manquant' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch indisponible' };

  const subject = `Devis REZO.net — ${fields.guildName || fields.name || 'réseau'}`;
  const text = buildQuoteText({ fields, sentAt, siteUrl });
  const html = buildQuoteHtml({ fields, sentAt, siteUrl });
  const replyTo = validEmail(fields.email) ? String(fields.email).trim() : '';

  let url; let headers; let body;
  if (provider === 'brevo') {
    url = BREVO_ENDPOINT;
    headers = { 'api-key': String(env.BREVO_API_KEY).trim(), 'Content-Type': 'application/json' };
    body = {
      sender: parseSender(env.STORE_MAIL_FROM),
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    };
    if (replyTo) body.replyTo = { email: replyTo };
  } else {
    url = RESEND_ENDPOINT;
    headers = { Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`, 'Content-Type': 'application/json' };
    body = { from: String(env.STORE_MAIL_FROM).trim(), to: [to], subject, text, html };
    if (replyTo) body.reply_to = replyTo;
  }

  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    return { ok: false, error: err?.message || `${provider} injoignable` };
  }

  const raw = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* réponse non JSON */ }

  if (!res.ok) {
    return { ok: false, error: parsed?.message || parsed?.error?.message || `HTTP ${res.status}` };
  }
  return { ok: true, id: parsed?.id || parsed?.messageId || null, to };
}

module.exports = {
  DEFAULT_QUOTE_TO,
  quoteRecipient,
  buildQuoteText,
  buildQuoteHtml,
  sendQuoteEmail,
  RESEND_ENDPOINT,
  BREVO_ENDPOINT,
  mailProvider,
  parseSender,
  mailConfigured,
  validEmail,
  buildText,
  buildHtml,
  sendLicenseEmail,
};
