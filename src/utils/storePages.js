'use strict';
// utils/storePages.js — Rendu HTML du site (aucun moteur de template).
//
// Chaque fonction reçoit des données déjà résolues et renvoie une page
// complète. C'est volontaire : le serveur HTTP ne fait que router, et les pages
// se vérifient sans réseau ni base de données.
//
// Contraintes tenues ici :
//   • aucune ressource externe (police, script, image distante) : une CSP
//     stricte suffit et le site s'affiche même hors ligne ;
//   • tout ce qui vient de l'utilisateur est échappé ;
//   • les liens sont relatifs, donc le site fonctionne derrière n'importe quel
//     domaine ou reverse proxy.

const { formatPrice, resolvePlan } = require('./licensePlans');
const {
  MODULES, STEPS, FAQ, GUARANTEES, SUPPORT_INVITE,
  FAQ_GROUPS, GUIDE_STEPS, GUIDE_TROUBLES, CHANGELOG,
} = require('./storeContent');
const { siteUrl } = require('./siteUrl');

const { currentRelease } = require('../core/release');
// Nom et version viennent de `core/release` : une seule source pour tout le produit.
const REL = currentRelease();
const VERSION = REL.version;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = require('./storeTheme');

// ── Layout ───────────────────────────────────────────────────────────────────
function layout({ title, description = '', body = '', active = '', bodyClass = '', path = '/', noindex = false }) {
  // Les liens du site restent relatifs (il fonctionne derrière n'importe quel
  // proxy) ; seules les balises qui exigent une URL absolue — canonique et
  // aperçu Discord — utilisent l'adresse publique configurée.
  const navLinks = [
    { href: '/#modules', label: 'Fonctionnalités', key: 'modules' },
    { href: '/commandes', label: 'Commandes', key: 'commandes' },
    { href: '/tarifs', label: 'Tarifs', key: 'tarifs' },
    { href: '/packs', label: 'Packs', key: 'packs' },
    { href: '/verifier', label: 'Vérifier une clé', key: 'verifier' },
    { href: '/faq', label: 'FAQ', key: 'faq' },
    { href: '/statut', label: 'Statut', key: 'statut' },
  ];
  const pageUrl = `${siteUrl()}${path}`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || `REZO — le système tout-en-un pour ton serveur Discord.`)}">
<meta name="theme-color" content="#0c0910">
<meta name="robots" content="${noindex ? 'noindex,nofollow' : 'index,follow'}">
<link rel="canonical" href="${esc(pageUrl)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="REZO">
<meta property="og:locale" content="fr_FR">
<meta property="og:url" content="${esc(pageUrl)}">
<meta name="twitter:card" content="summary">
<style>${CSS}</style>
</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>
<a class="skip" href="#main">Aller au contenu</a>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/"><span class="mark">R</span> ${esc(REL.name)} <span class="ver">v${esc(VERSION)}</span></a>
    <nav class="nav">
      ${navLinks.map(l => `<a href="${l.href}"${active === l.key ? ' style="color:var(--text)"' : ''}>${esc(l.label)}</a>`).join('\n      ')}
      <a href="${esc(SUPPORT_INVITE)}" rel="noopener">Support</a>
    </nav>
    <a class="btn btn-gold btn-sm" href="/tarifs#offres" style="margin-left:auto">Acheter</a>
  </div>
</header>
<main id="main">
${body}
</main>
<footer>
  <div class="wrap foot">
    <div>
      <b style="color:var(--text)">${esc(REL.name)}</b> — v${esc(VERSION)} · ${esc(new Date().getFullYear())}
      <div class="small" style="margin-top:4px">Site et bot indépendants. Non affilié à Discord Inc.</div>
    </div>
    <div class="foot-links">
      <a href="/tarifs">Tarifs</a>
      <a href="/packs">Packs</a>
      <a href="/commandes">Commandes</a>
      <a href="/verifier">Vérifier une clé</a>
      <a href="/faq">FAQ</a>
      <a href="/guide">Guide d’activation</a>
      <a href="/nouveautes">Nouveautés</a>
      <a href="/statut">Statut</a>
      <a href="${esc(SUPPORT_INVITE)}" rel="noopener">Support</a>
    </div>
  </div>
</footer>
</body>
</html>`;
}

// ── Fragments ────────────────────────────────────────────────────────────────
function planCard(plan) {
  return `
    <article class="plan${plan.highlighted ? ' hot' : ''}">
      ${plan.highlighted ? '<span class="tag">Le plus choisi</span>' : ''}
      <div class="meta">
        <span class="badge">${esc(plan.kindLabel || plan.kind || 'Standard')}</span>
        <span class="badge muted">${esc(plan.seatsLabel || '1 serveur')}</span>
      </div>
      <h3>${esc(plan.label)}</h3>
      <p class="tagline">${esc(plan.tagline)}</p>
      <div class="price">
        <b>${esc(formatPrice(plan.amountCents, plan.currency))}</b>
        <span>${plan.days === null ? 'une fois, pour toujours' : `pour ${plan.days} jours`}</span>
      </div>
      ${plan.graceDays ? `<p class="fine">+ ${esc(plan.graceDays)} jours de grâce après l’expiration</p>` : ''}
      <ul>${plan.perks.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      <form method="post" action="/acheter">
        <input type="hidden" name="plan" value="${esc(plan.id)}">
        <div class="field">
          <label for="email-${esc(plan.id)}">E-mail (optionnel, pour recevoir la clé)</label>
          <input id="email-${esc(plan.id)}" type="email" name="email" placeholder="toi@exemple.com" autocomplete="email">
        </div>
        <button class="btn ${plan.highlighted ? 'btn-gold' : 'btn-primary'} btn-wide" type="submit">
          Acheter ${esc(plan.label)}
        </button>
      </form>
    </article>`;
}

// ── Paliers de licence ───────────────────────────────────────────────────────
// Rendus depuis `licenseCore` : la page ne peut pas promettre un module que le
// bot ne verrouille pas (ou l'inverse).
function tiersSection(tiers = []) {
  if (!tiers.length) return '';
  return `
  <section id="paliers">
    <div class="wrap">
      <div class="sec-head">
        <div class="kicker">Nouveau système de licence</div>
        <h2>Trois paliers, un seul bot.</h2>
        <p>Le palier décide des modules ouverts, pas la durée. Chaque niveau ouvre tout ce que le précédent ouvrait — inutile de cumuler les clés.</p>
      </div>
      <div class="paliers">
        ${tiers.map(t => `
          <article class="palier">
            <div class="pk">Palier</div>
            <h3>${esc(t.emoji)} ${esc(t.label)}</h3>
            <p>${esc(t.description)}</p>
            <div class="seats">${esc(t.seatsLabel)}</div>
            <div class="chips">
              ${t.features.slice(0, 12).map(f => `<span>/${esc(f)}</span>`).join('')}
              ${t.features.length > 12 ? `<span>+${t.features.length - 12} modules</span>` : ''}
            </div>
          </article>`).join('')}
      </div>
    </div>
  </section>`;
}

function plansSection(plans, tiers = []) {
  return `
  ${tiersSection(tiers)}
  <section id="offres">
    <div class="wrap">
      <div class="sec-head">
        <div class="kicker">Offres</div>
        <h2>Une clé, un ou trois serveurs, aucun abonnement.</h2>
        <p>Le paiement est traité par Stripe. La clé est générée dès la confirmation et s’active avec <code>/license</code> → <b>Activer une clé</b>.</p>
      </div>
      <div class="plans">${plans.map(planCard).join('')}</div>
      <div class="guarantees">
        ${GUARANTEES.map(g => `
          <div class="guarantee">
            <span class="g-ico">${g.emoji}</span>
            <div><b>${esc(g.title)}</b><span>${esc(g.text)}</span></div>
          </div>`).join('')}
      </div>
    </div>
  </section>`;
}

// ── Accueil ──────────────────────────────────────────────────────────────────
function homePage({ plans = [], tiers = [], stats = {} } = {}) {
  // Le nombre de serveurs n'existe que si le site tourne dans le bot : en
  // autonome, on préfère trois chiffres exacts à un tiret qui inquiète.
  const statCards = [
    stats.guilds ? { value: stats.guilds, label: 'serveurs' } : null,
    { value: stats.commands ?? '—', label: 'commandes' },
    { value: stats.modules ?? MODULES.length, label: 'modules' },
    { value: `v${VERSION}`, label: 'version' },
  ].filter(Boolean);

  const body = `
  <section class="hero">
    <div class="wrap">
      <span class="eyebrow">● ${esc(stats.status || 'En ligne')} · v${esc(VERSION)}</span>
      <h1>Le serveur Discord qui tient <em>tout seul</em>.</h1>
      <p class="lead">
        Protection, modération, tickets, réseau inter-serveurs, niveaux, économie et musique :
        un seul bot, un seul panneau, des réglages au bouton. Sans configuration interminable
        et sans vingt bots qui se contredisent.
      </p>
      <div class="hero-cta">
        <a class="btn btn-gold" href="/tarifs#offres">Obtenir une licence</a>
        <a class="btn" href="/commandes">Parcourir les commandes</a>
      </div>
      <p class="hero-note">Clé délivrée immédiatement · Activation par <code>/license</code> · Paiement par Stripe</p>
      <div class="stats">
        ${statCards.map(s => `<div class="stat"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}
      </div>
    </div>
  </section>

  <section id="modules">
    <div class="wrap">
      <div class="sec-head">
        <div class="kicker">Ce que fait le bot</div>
        <h2>Des modules complets, pas des demi-fonctions.</h2>
        <p>Chaque module se règle dans le panneau du serveur&nbsp;: les valeurs actuelles sont déjà remplies, tu ne modifies que ce qui change.</p>
      </div>
      <div class="grid">
        ${MODULES.map(m => `
          <article class="card">
            <div class="ico">${m.emoji}</div>
            <h3>${esc(m.title)}</h3>
            <p class="sub">${esc(m.text)}</p>
            <ul>${m.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
          </article>`).join('')}
      </div>
    </div>
  </section>

  <section id="activation">
    <div class="wrap">
      <div class="sec-head">
        <div class="kicker">Activation</div>
        <h2>Trois étapes, deux minutes.</h2>
        <p>Pas de tableau de bord à créer, pas de compte à mémoriser : la clé se colle directement dans Discord.</p>
      </div>
      <div class="steps">
        ${STEPS.map(s => `
          <div class="step">
            <div class="num">${esc(s.step)}</div>
            <h3>${esc(s.title)}</h3>
            <p>${esc(s.text)}</p>
          </div>`).join('')}
      </div>
      <div class="note" style="margin-top:20px">
        Une licence déjà activée peut être vérifiée à tout moment sur
        la page <a href="/verifier" style="color:var(--gold)">Vérifier une clé</a>.
      </div>
    </div>
  </section>

  ${plansSection(plans, tiers)}

  <section id="faq">
    <div class="wrap">
      <div class="sec-head">
        <div class="kicker">Questions fréquentes</div>
        <h2>Les réponses avant l’achat.</h2>
      </div>
      <div class="faq">
        ${FAQ.map(item => `
          <details>
            <summary>${esc(item.q)}</summary>
            <p>${esc(item.a)}</p>
          </details>`).join('')}
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="final">
        <h2>Prêt à reprendre la main sur ton serveur ?</h2>
        <p>Une clé suffit pour ouvrir tous les modules sous licence. Si une question reste, le serveur de support est ouvert.</p>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
          <a class="btn btn-gold" href="/tarifs#offres">Choisir mon offre</a>
          <a class="btn" href="${esc(SUPPORT_INVITE)}" rel="noopener">Rejoindre le support</a>
        </div>
      </div>
    </div>
  </section>`;

  return layout({
    title: 'REZO — le système tout-en-un pour ton serveur Discord',
    description: 'Protection, modération, tickets, réseau, niveaux, économie, musique. Une licence, un serveur, un panneau unique.',
    body,
  });
}

// ── Tarifs ───────────────────────────────────────────────────────────────────
function pricingPage({ plans = [], tiers = [] } = {}) {
  const body = `
  <section class="hero" style="padding-bottom:6px">
    <div class="wrap">
      <span class="eyebrow">Tarifs</span>
      <h1 style="margin-top:18px">Un palier, une durée, <em>un prix clair</em>.</h1>
      <p class="lead">Le palier fixe les modules ouverts, l’offre fixe la durée. Aucun prélèvement récurrent, aucune reconduction automatique : la clé s’arrête à sa date, avec quelques jours de grâce pour renouveler.</p>
    </div>
  </section>
  ${plansSection(plans, tiers)}
  <section>
    <div class="wrap panel" style="text-align:center">
      <div class="sec-head" style="margin-bottom:16px">
        <div class="kicker">Bundles</div>
        <h2>Besoin de plus qu’une clé ?</h2>
        <p>Les packs réunissent licence, durée et prestations — installation, visuels, migration, support prioritaire — à prix réduit.</p>
      </div>
      <a class="btn btn-gold" href="/packs">Voir les packs</a>
    </div>
  </section>
  <section>
    <div class="wrap">
      <div class="sec-head">
        <div class="kicker">Questions fréquentes</div>
        <h2>Avant de payer.</h2>
      </div>
      <div class="faq">
        ${FAQ.map(item => `<details><summary>${esc(item.q)}</summary><p>${esc(item.a)}</p></details>`).join('')}
      </div>
    </div>
  </section>`;
  return layout({
    title: 'Tarifs — REZO',
    description: 'Paliers Essentiel, Standard et Réseau : 7, 30, 90 jours ou illimitée, une clé pour un ou trois serveurs, paiement unique par Stripe.',
    body, active: 'tarifs', path: '/tarifs',
  });
}

// ── Packs ──────────────────────────────────────────────────────────────────
// Un pack délivre la même clé qu'une offre : palier, durée et sièges. Ce qui
// change, ce sont les prestations jointes (installation, visuels, migration).
function packCard(pack) {
  return `
    <article class="plan${pack.highlighted ? ' hot' : ''}">
      ${pack.highlighted ? '<span class="tag">Meilleur rapport</span>' : ''}
      <div class="meta">
        <span class="badge">${esc(pack.kindLabel || 'Standard')}</span>
        <span class="badge muted">${esc(pack.seatsLabel || '1 serveur')}</span>
      </div>
      <h3>${esc(pack.label)}</h3>
      <p class="tagline">${esc(pack.tagline)}</p>
      ${pack.quote
        ? `<div class="price">
        <b>Sur devis</b>
        <span>tarif établi avec le support</span>
      </div>`
        : `<div class="price">
        <b>${esc(formatPrice(pack.amountCents, pack.currency))}</b>
        <span>${pack.days === null ? 'une fois, pour toujours' : `pour ${pack.days} jours`}</span>
      </div>`}
      ${!pack.quote && pack.savingsCents
        ? `<p class="fine">au lieu de ${esc(formatPrice(pack.compareAtCents, pack.currency))} — ${esc(formatPrice(pack.savingsCents, pack.currency))} d’économie</p>`
        : ''}
      ${!pack.quote && pack.graceDays ? `<p class="fine">+ ${esc(pack.graceDays)} jours de grâce après l’expiration</p>` : ''}
      <ul>${pack.perks.map(p => `<li>${esc(p)}</li>`).join('')}</ul>
      ${pack.quote
        ? `<a class="btn btn-gold btn-wide" href="/devis">Demander un devis</a>
      <p class="fine" style="margin-top:10px">Aucun paiement en ligne : le tarif et la durée se fixent avec le support.</p>`
        : `<form method="post" action="/acheter">
        <input type="hidden" name="plan" value="${esc(pack.id)}">
        <div class="field">
          <label for="email-${esc(pack.id)}">E-mail (optionnel, pour recevoir la clé)</label>
          <input id="email-${esc(pack.id)}" type="email" name="email" placeholder="toi@exemple.com" autocomplete="email">
        </div>
        <button class="btn ${pack.highlighted ? 'btn-gold' : 'btn-primary'} btn-wide" type="submit">
          Acheter ${esc(pack.label)}
        </button>
      </form>`}
    </article>`;
}

function packsPage({ packs = [] } = {}) {
  const body = `
  <section class="hero" style="padding-bottom:6px">
    <div class="wrap">
      <span class="eyebrow">Packs</span>
      <h1 style="margin-top:18px">${packs.length} packs, <em>tout compris</em>.</h1>
      <p class="lead">
        Chaque pack réunit une licence, sa durée, des <b>modules que le palier seul ne donne pas</b>
        (niveaux, IA, sauvegardes) et les prestations qui vont avec : installation accompagnée,
        visuels, migration, support prioritaire. Une seule clé, générée immédiatement, à activer
        avec <code>/license</code> → <b>Activer une clé</b>.
      </p>
    </div>
  </section>
  <section id="packs">
    <div class="wrap">
      <div class="plans">${packs.map(packCard).join('')}</div>
      <div class="guarantees">
        ${GUARANTEES.map(g => `
          <div class="guarantee">
            <span class="g-ico">${g.emoji}</span>
            <div><b>${esc(g.title)}</b><span>${esc(g.text)}</span></div>
          </div>`).join('')}
      </div>
    </div>
  </section>
  <section>
    <div class="wrap">
      <div class="sec-head">
        <div class="kicker">Bon à savoir</div>
        <h2>Ce qu’un pack change vraiment.</h2>
      </div>
      <div class="faq">
        <details><summary>Le pack remplace-t-il une licence ?</summary><p>Oui. Il contient une licence complète (palier, durée, serveurs) et les prestations associées. La clé obtenue s’active exactement comme une autre avec <code>/license</code>.</p></details>
        <details><summary>Puis-je prendre un pack si j’ai déjà une licence ?</summary><p>La nouvelle clé remplace la licence en cours sur le serveur : elle n’ajoute pas de durée à l’ancienne. Attends la fin de celle-ci, ou contacte le support pour organiser la transition.</p></details>
        <details><summary>Les prestations sont-elles automatiques ?</summary><p>La clé, elle, est immédiate. Les prestations (installation, visuels, migration) sont réalisées avec toi après l’achat : le support te contacte à l’adresse laissée dans le formulaire.</p></details>
        <details><summary>Et si je change de serveur ?</summary><p>Le siège suit ton serveur. Pour déplacer une clé réseau, il suffit de l’activer sur le nouveau serveur : un siège libre est réclamé automatiquement.</p></details>
      </div>
    </div>
  </section>`;
  return layout({
    title: 'Packs — REZO',
    description: 'Packs tout compris : licence, modules en plus, durée et prestations. Le réseau REZO.net se chiffre sur devis.',
    body, active: 'packs', path: '/packs',
  });
}

// ── Devis (Pack REZO.net) ──────────────────────────────────────────────────
// Formulaire complet : la demande part par e-mail au propriétaire, rien n'est
// enregistré en base et aucune clé n'est créée.
function quoteField({ name, label, value = '', error = '', type = 'text', required = false, placeholder = '', hint = '', autocomplete = '' }) {
  return `
        <div class="field">
          <label for="q-${esc(name)}">${esc(label)}${required ? ' *' : ''}</label>
          <input id="q-${esc(name)}" type="${esc(type)}" name="${esc(name)}" value="${esc(value)}"
                 placeholder="${esc(placeholder)}"${autocomplete ? ` autocomplete="${esc(autocomplete)}"` : ''}${required ? ' required' : ''}>
          ${hint ? `<p class="fine">${esc(hint)}</p>` : ''}
          ${error ? `<p class="fine" style="color:#ff8a8a">${esc(error)}</p>` : ''}
        </div>`;
}

function quotePage({ pack = null, values = {}, errors = {}, sent = false, mailReady = true, supportUrl = SUPPORT_INVITE } = {}) {
  const v = values || {};
  const e = errors || {};

  if (sent) {
    const body = `
  <section style="padding:72px 0">
    <div class="wrap panel" style="text-align:center">
      <div style="font-size:44px">📨</div>
      <h1 style="font-size:27px;margin:14px 0 10px">Demande de devis envoyée</h1>
      <p class="muted" style="max-width:52ch;margin:0 auto 18px">
        Ta demande est partie chez le propriétaire de REZO, en message privé Discord.
        Il l’examine et te répond, avec un tarif, une durée et un nombre de serveurs
        fixés ensemble — puis ta clé arrive dans tes MP.
      </p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <a class="btn btn-gold" href="/packs">Retour aux packs</a>
        <a class="btn" href="${esc(supportUrl)}" rel="noopener">Rejoindre le support</a>
      </div>
    </div>
  </section>`;
    return layout({
      title: 'Demande de devis envoyée — REZO',
      description: 'Ta demande de devis pour le pack REZO.net a été envoyée.',
      body, noindex: true,
    });
  }

  const body = `
  <section class="hero" style="padding-bottom:6px">
    <div class="wrap">
      <span class="eyebrow">Devis — Pack REZO.net</span>
      <h1 style="margin-top:18px">Un réseau, <em>un tarif sur mesure</em>.</h1>
      <p class="lead">
        Ce pack couvre jusqu’à 25 serveurs, avec une durée et des prestations adaptées.
        Remplis le formulaire : la demande arrive directement en message privé au
        propriétaire de REZO, qui l’examine et te répond. Une fois le devis accepté,
        ta clé part en MP. Aucun paiement en ligne, aucune clé émise avant accord.
      </p>
    </div>
  </section>
  <section>
    <div class="wrap panel">
      ${e.global ? `<div class="box" style="border-color:#7a2b2b;margin-bottom:18px">
        <b>Envoi impossible.</b> ${esc(e.global)}
        <p class="fine" style="margin:8px 0 0">Ta saisie est conservée ci-dessous : réessaie, ou écris directement au support :
          <a href="${esc(supportUrl)}" rel="noopener">${esc(supportUrl)}</a>.</p>
      </div>` : ''}
      <form method="post" action="/devis">
        <h2 style="font-size:20px;margin:0 0 14px">Qui demande le devis</h2>
        ${quoteField({ name: 'name', label: 'Nom ou pseudo', value: v.name, error: e.name, required: true, placeholder: 'Ton nom', autocomplete: 'name' })}
        ${quoteField({ name: 'email', label: 'E-mail de réponse', value: v.email, error: e.email, type: 'email', required: true, placeholder: 'toi@exemple.com', hint: 'Utilisé en secours si tes MP Discord sont fermés.', autocomplete: 'email' })}
        ${quoteField({ name: 'discord', label: 'Pseudo Discord', value: v.discord, error: e.discord, placeholder: 'pseudo (facultatif)' })}
        ${quoteField({ name: 'discordId', label: 'ID Discord (pour recevoir la clé)', value: v.discordId, error: e.discordId, required: true, placeholder: '123456789012345678', hint: 'Paramètres → Avancé → Mode développeur, puis clic droit sur ton profil → « Copier l’identifiant ».' })}

        <h2 style="font-size:20px;margin:24px 0 14px">Le réseau à couvrir</h2>
        ${quoteField({ name: 'guildName', label: 'Serveur principal', value: v.guildName, error: e.guildName, required: true, placeholder: 'Nom de ton serveur' })}
        ${quoteField({ name: 'guildId', label: 'ID du serveur', value: v.guildId, error: e.guildId, required: true, placeholder: '123456789012345678', hint: 'Clic droit sur le serveur → « Copier l’identifiant ».' })}
        ${quoteField({ name: 'servers', label: 'Nombre de serveurs à couvrir', value: v.servers, error: e.servers, type: 'number', required: true, placeholder: '3', hint: 'Entre 1 et 100.' })}
        ${quoteField({ name: 'members', label: 'Membres cumulés', value: v.members, error: e.members, type: 'number', required: true, placeholder: '5000' })}

        <h2 style="font-size:20px;margin:24px 0 14px">Ce qu’il te faut</h2>
        <div class="field">
          <label for="q-duration">Durée souhaitée *</label>
          <select id="q-duration" name="duration" required>
            <option value="">Choisir…</option>
            ${['3 mois', '6 mois', '1 an', 'sur mesure'].map(d => `<option value="${esc(d)}"${v.duration === d ? ' selected' : ''}>${esc(d)}</option>`).join('')}
          </select>
          ${e.duration ? `<p class="fine" style="color:#ff8a8a">${esc(e.duration)}</p>` : ''}
        </div>
        ${quoteField({ name: 'startDate', label: 'Mise en service souhaitée', value: v.startDate, error: e.startDate, type: 'date' })}
        ${quoteField({ name: 'budget', label: 'Budget envisagé', value: v.budget, error: e.budget, placeholder: 'facultatif' })}
        <div class="field">
          <label for="q-modules">Modules prioritaires</label>
          <textarea id="q-modules" name="modules" rows="3" placeholder="IA, sauvegardes, branding, anti-VPN, pont inter-serveurs…">${esc(v.modules || '')}</textarea>
          ${e.modules ? `<p class="fine" style="color:#ff8a8a">${esc(e.modules)}</p>` : ''}
        </div>
        <div class="field">
          <label for="q-message">Contexte</label>
          <textarea id="q-message" name="message" rows="5" placeholder="Ton projet, contraintes, échéances, besoin de migration…">${esc(v.message || '')}</textarea>
          ${e.message ? `<p class="fine" style="color:#ff8a8a">${esc(e.message)}</p>` : ''}
        </div>
        <div class="field">
          <label style="display:flex;gap:10px;align-items:flex-start">
            <input id="q-consent" type="checkbox" name="consent" value="1"${v.consent ? ' checked' : ''} style="margin-top:3px;width:auto" required>
            <span>J’accepte d’être recontacté au sujet de ce devis. Les informations servent uniquement à l’établir et ne sont pas conservées sur le site.</span>
          </label>
          ${e.consent ? `<p class="fine" style="color:#ff8a8a">${esc(e.consent)}</p>` : ''}
        </div>
        <button class="btn btn-gold btn-wide" type="submit">Envoyer ma demande de devis</button>
        <p class="fine" style="margin-top:12px">Aucun paiement ni engagement : le devis est une proposition, la licence n’est créée qu’après accord.</p>
      </form>
    </div>
  </section>`;

  return layout({
    title: 'Demande de devis — REZO.net',
    description: 'Formulaire de devis pour le Pack REZO.net : réseau jusqu’à 25 serveurs, durée et prestations sur mesure.',
    body, active: 'packs', path: '/devis', noindex: true,
  });
}

// ── Page de paiement (mode sans Stripe / redirection) ────────────────────────
function checkoutPage({ order, plan, stripe = true } = {}) {
  const tracking = `/commande/${order.token}`;
  const body = `
  <section style="padding:56px 0">
    <div class="wrap panel">
      <div class="box">
        <span class="status ${order.status === 'paid' ? 'paid' : 'pending'}">${order.status === 'paid' ? 'Payée' : 'En attente de paiement'}</span>
        <h1 style="font-size:28px;margin:16px 0 10px">${esc(plan?.label || order.plan)} — ${esc(formatPrice(order.amountCents, order.currency))}</h1>
        <p class="muted">Commande <span class="pill">${esc(order.token.slice(0, 10))}…</span></p>
        ${stripe ? `
          <p class="muted" style="margin-top:14px">Redirection vers la page de paiement Stripe…</p>
          <p><a class="btn btn-gold" href="${esc(order.checkoutUrl || tracking)}">Continuer vers le paiement</a></p>
        ` : `
          <div class="note" style="margin-top:18px">
            Le paiement en ligne n’est pas encore activé sur cette instance. Ta commande est
            enregistrée : contacte le support avec sa référence pour la régler, la clé apparaîtra
            ensuite sur la page de suivi.
          </div>
          <p style="margin-top:20px">
            <a class="btn btn-gold" href="${esc(SUPPORT_INVITE)}" rel="noopener">Contacter le support</a>
            <a class="btn" href="${esc(tracking)}">Suivre ma commande</a>
          </p>
        `}
      </div>
      <div class="box">
        <h2 style="font-size:17px;margin-bottom:12px">À conserver</h2>
        <p class="small">Ce lien est privé : il affiche ta clé dès que le paiement est confirmé. Aucun compte n’est nécessaire, donc c’est ta seule preuve d’achat.</p>
        <div class="key" style="font-size:13px;margin-top:14px">${esc(tracking)}</div>
      </div>
    </div>
  </section>`;
  // Page privée (jeton de commande) : jamais indexée, ni en aperçu de lien.
  return layout({ title: `Commande ${order.plan} — REZO`, description: 'Suivi de commande REZO.', body, noindex: true });
}

// ── Suivi de commande (clé) ──────────────────────────────────────────────────
function orderPage({ order, key = null, justPaid = false } = {}) {
  const paid = order.status === 'paid' && Boolean(key || order.key);
  const finalKey = key || order.key || null;
  const plan = resolvePlan(order.plan);
  const seats = plan?.maxGuilds || 1;
  const tierLabel = plan?.kindLabel || 'Standard';

  const statusBadge = paid
    ? '<span class="status paid">● Payée — clé délivrée</span>'
    : order.status === 'cancelled' || order.status === 'refunded'
      ? `<span class="status bad">● ${order.status === 'refunded' ? 'Remboursée' : 'Annulée'}</span>`
      : '<span class="status pending">● En attente de paiement</span>';

  const body = `
  <section style="padding:52px 0">
    <div class="wrap panel">
      ${justPaid && paid ? `
        <div class="box" style="border-color:rgba(74,222,128,.4)">
          <b style="color:var(--ok)">Paiement confirmé.</b>
          <p class="muted" style="margin-top:6px">Ta clé est prête. Copie-la puis active-la sur ton serveur avec <code>/license</code>.</p>
        </div>` : ''}

      <div class="box">
        ${statusBadge}
        <h1 style="font-size:26px;margin:14px 0 6px">Licence ${esc(plan?.label || order.plan)}</h1>
        <p class="muted">${esc(formatPrice(order.amountCents, order.currency))} · créée le ${esc(new Date(order.createdAt).toLocaleString('fr-FR'))}</p>

        ${paid ? `
          <div style="margin-top:22px">
            <div class="small" style="margin-bottom:8px">Ta clé de licence</div>
            <div class="key" id="license-key">${esc(finalKey)}</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
              <button class="btn btn-gold btn-sm" type="button" onclick="copyKey()">Copier la clé</button>
              <a class="btn btn-sm" href="/commande/${esc(order.token)}/cle.txt">Télécharger en .txt</a>
              <a class="btn btn-sm" href="/verifier?cle=${encodeURIComponent(finalKey || '')}">Vérifier</a>
            </div>
          </div>
          <div class="note" style="margin-top:22px">
            <b>Obtenir ta licence</b><br>
            1. Sur le serveur à équiper, tape <code>/license</code> (réservé aux administrateurs).<br>
            2. Clique <b>Activer une clé</b>, colle la clé ci-dessus.<br>
            ${seats > 1
              ? `3. Répète l’opération sur les <b>${esc(seats)} serveurs</b> couverts : le palier ${esc(tierLabel)} reste le même partout.`
              : '3. La clé se lie au serveur et ouvre immédiatement les modules de son palier.'}
          </div>
        ` : order.status === 'pending' ? `
          <div class="note" style="margin-top:20px">
            ${order.provider === 'stripe'
              ? 'Le paiement est en cours de confirmation par Stripe. Cette page se rafraîchit toute seule dès que la clé est émise.'
              : 'Cette commande attend une validation de paiement. Dès qu’elle est enregistrée, la clé apparaît ici automatiquement.'}
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
            <button class="btn btn-sm" type="button" onclick="location.reload()">Actualiser</button>
            <a class="btn btn-sm" href="${esc(SUPPORT_INVITE)}" rel="noopener">Support</a>
          </div>
        ` : `
          <div class="note" style="margin-top:20px">
            Cette commande n’est plus payable. Reprends une offre depuis la page des tarifs pour obtenir une nouvelle clé.
          </div>
          <p style="margin-top:18px"><a class="btn btn-gold btn-sm" href="/tarifs#offres">Voir les offres</a></p>
        `}
      </div>

      <div class="box">
        <h2 style="font-size:16px;margin-bottom:10px">Détail</h2>
        <div class="row"><span>Référence</span><b>${esc(order.token.slice(0, 16))}…</b></div>
        <div class="row"><span>Offre</span><b>${esc(plan?.label || order.plan)}</b></div>
        <div class="row"><span>Palier</span><b>${esc(tierLabel)}</b></div>
        <div class="row"><span>Serveurs couverts</span><b>${esc(seats)}</b></div>
        <div class="row"><span>Durée</span><b>${esc(plan?.durationLabel || (plan?.days === null ? 'illimitée' : `${plan?.days || 30} jours`))}${plan?.graceDays ? ` + ${esc(plan.graceDays)} j de grâce` : ''}</b></div>
        <div class="row"><span>Montant</span><b>${esc(formatPrice(order.amountCents, order.currency))}</b></div>
        <div class="row"><span>Moyen de paiement</span><b>${order.provider === 'stripe' ? 'Carte bancaire (Stripe)' : 'Validation manuelle'}</b></div>
        ${order.paidAt ? `<div class="row"><span>Payée le</span><b>${esc(new Date(order.paidAt).toLocaleString('fr-FR'))}</b></div>` : ''}
      </div>

      <p class="small">Conserve l’adresse de cette page : c’est elle qui contient ton jeton privé et qui reste la seule preuve d’achat.</p>
    </div>
  </section>
  <script>
    function copyKey(){
      var t = document.getElementById('license-key');
      if (!t) return;
      var v = t.textContent.trim();
      if (navigator.clipboard) navigator.clipboard.writeText(v).then(function(){
        var b = event.target; b.textContent = 'Copié ✓'; setTimeout(function(){ b.textContent = 'Copier la clé'; }, 1600);
      });
      else { var r = document.createRange(); r.selectNode(t); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('copy'); }
    }
    ${order.status === 'pending' ? `
    (function poll(){
      var tries = 0;
      var timer = setInterval(function(){
        tries++;
        if (tries > 150) return clearInterval(timer);
        fetch('/api/commandes/${esc(order.token)}', { headers: { accept: 'application/json' } })
          .then(function(r){ return r.json(); })
          .then(function(d){ if (d && d.status === 'paid') { clearInterval(timer); location.reload(); } })
          .catch(function(){});
      }, 6000);
    })();` : ''}
  </script>`;

  return layout({
    title: paid ? `Ta clé — ${order.plan} · REZO` : `Commande en attente — ${order.plan} · REZO`,
    description: 'Suivi de commande et clé de licence REZO.',
    body, noindex: true,
  });
}

// ── Vérificateur de clé ──────────────────────────────────────────────────────
function verifyPage({ key = '', result = null } = {}) {
  const labels = {
    available: ['Clé valide, jamais activée', 'paid', 'Elle peut être activée sur un serveur : /license → « Activer une clé ». Elle ouvre le palier indiqué ci-dessous.'],
    active: ['Licence active', 'paid', 'Cette clé est en service : les modules de son palier sont ouverts sur ses serveurs.'],
    grace: ['Licence en période de grâce', 'pending', 'La date d’expiration est passée, mais l’accès reste ouvert le temps de renouveler. Renouvelle avant la fin de la grâce pour éviter toute coupure.'],
    activated: ['Licence active', 'paid', 'Cette clé est en service.'],
    expired: ['Licence expirée', 'bad', 'La durée et la période de grâce sont dépassées. Les systèmes sous licence se sont verrouillés ; une nouvelle clé les rouvre.'],
    revoked: ['Licence révoquée', 'bad', 'Cette clé a été désactivée par l’éditeur.'],
  };

  let resultHtml = '';
  if (result) {
    if (!result.ok) {
      resultHtml = `
        <div class="box" style="margin-top:18px;border-color:rgba(248,113,113,.4)">
          <span class="status bad">● Invalide</span>
          <p class="muted" style="margin-top:10px">
            ${result.error === 'format'
              ? 'Ce n’est pas un format de clé REZO. Attendu : REZO-XXXX-XXXX-XXXX-XXXX.'
              : 'Cette clé n’existe pas dans notre registre. Vérifie les caractères (O/I et 0/1 sont exclus des clés).'}
          </p>
        </div>`;
    } else {
      const [title, tone, text] = labels[result.state] || ['Clé inconnue', 'bad', ''];
      resultHtml = `
        <div class="box" style="margin-top:18px">
          <span class="status ${tone}">● ${esc(title)}</span>
          <div style="margin-top:14px" class="key">${esc(result.key)}</div>
          <p class="muted" style="margin-top:12px">${esc(text)}</p>
          ${result.kindLabel ? `<div class="row"><span>Palier</span><b>${esc(result.kindLabel)}</b></div>` : ''}
          ${typeof result.seatsUsed === 'number'
            ? `<div class="row"><span>Serveurs liés</span><b>${esc(result.seatsUsed)} / ${esc(result.maxGuilds)}</b></div>`
            : ''}
          ${result.expiresAt ? `<div class="row"><span>Expire le</span><b>${esc(new Date(result.expiresAt).toLocaleDateString('fr-FR'))}</b></div>` : '<div class="row"><span>Expiration</span><b>illimitée</b></div>'}
          ${typeof result.daysLeft === 'number' && result.state !== 'expired'
            ? `<div class="row"><span>Jours restants</span><b>${esc(result.daysLeft)}</b></div>`
            : ''}
          ${result.state === 'grace' && result.graceEndsAt
            ? `<div class="row"><span>Grâce jusqu’au</span><b>${esc(new Date(result.graceEndsAt).toLocaleDateString('fr-FR'))}</b></div>`
            : ''}
        </div>`;
    }
  }

  const body = `
  <section style="padding:56px 0">
    <div class="wrap panel">
      <div class="box">
        <span class="eyebrow">Contrôle</span>
        <h1 style="font-size:28px;margin:16px 0 8px">Vérifier une clé</h1>
        <p class="muted">Colle une clé pour connaître son état. Aucune information sur le serveur qui l’utilise n’est affichée.</p>
        <form method="get" action="/verifier" style="margin-top:20px">
          <div class="field">
            <label for="cle">Clé de licence</label>
            <input id="cle" name="cle" type="text" value="${esc(key)}" placeholder="REZO-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
          </div>
          <button class="btn btn-gold" type="submit">Vérifier</button>
        </form>        ${resultHtml}
        <p class="small" style="margin-top:16px">
          Besoin d’aide pour activer ? <a href="/guide" style="color:var(--gold)">Guide d’activation</a>
          · <a href="/faq" style="color:var(--gold)">Questions fréquentes</a>
        </p>
      </div>


    </div>
  </section>`;
  return layout({
    title: 'Vérifier une clé — REZO',
    description: 'Vérifie l’état d’une clé de licence REZO : disponible, activée, expirée ou révoquée.',
    body, active: 'verifier', path: '/verifier',
  });
}

// ── FAQ ──────────────────────────────────────────────────────────────────────
// Le filtrage se fait dans le navigateur, sans réseau ni dépendance : la page
// reste utilisable même si le script ne s’exécute pas (toutes les réponses sont
// présentes dans le document).
function faqJsonLd(groups = FAQ_GROUPS) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: groups.flatMap(group => group.items.map(item => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    }))),
  };
  // `<` échappé : une réponse ne peut pas refermer la balise script.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function faqPage({ groups = FAQ_GROUPS } = {}) {
  const sections = groups.map(group => `
      <section style="margin:0 0 30px">
        <h2 style="font-size:20px;margin:0 0 12px">${esc(group.title)}</h2>
        <div class="faq">
          ${group.items.map(item => `
            <details>
              <summary>${esc(item.q)}</summary>
              <p>${esc(item.a)}</p>
            </details>`).join('')}
        </div>
      </section>`).join('');

  const body = `
  <section style="padding:56px 0 8px">
    <div class="wrap">
      <div class="sec-head" style="text-align:left;margin:0 0 24px">
        <div class="kicker">Aide</div>
        <h1 style="font-size:30px;margin:12px 0 10px">Questions fréquentes</h1>
        <p class="muted" style="max-width:70ch">
          Des réponses exactes sur la licence, le paiement, les packs et le support.
          Si une réponse manque, le serveur de support est ouvert.
        </p>
      </div>

      <div class="box" style="margin-bottom:26px">
        <div class="field" style="margin:0">
          <label for="faq-q">Chercher dans la FAQ</label>
          <input id="faq-q" type="search" placeholder="clé, sièges, remboursement, devis…" autocomplete="off">
        </div>
        <p class="small" id="faq-count" aria-live="polite" style="margin:10px 0 0"></p>
      </div>

      ${sections}

      <div class="note" style="margin-top:8px">
        Toujours bloqué ? <a href="${esc(SUPPORT_INVITE)}" rel="noopener" style="color:var(--gold)">Rejoins le support</a>
        · <a href="/guide" style="color:var(--gold)">Guide d’activation</a>
        · <a href="/verifier" style="color:var(--gold)">Vérifier une clé</a>
      </div>
    </div>
  </section>
  <script type="application/ld+json">${faqJsonLd(groups)}</script>
  <script>
  (function () {
    var input = document.getElementById('faq-q');
    if (!input) return;
    var items = Array.prototype.slice.call(document.querySelectorAll('.faq details'));
    var count = document.getElementById('faq-count');
    function norm(value) {
      return String(value || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, ' ').trim();
    }
    input.addEventListener('input', function () {
      var query = norm(input.value);
      var shown = 0;
      items.forEach(function (item) {
        var hit = !query || norm(item.textContent).indexOf(query) !== -1;
        item.style.display = hit ? '' : 'none';
        if (hit) { shown++; if (query) item.open = true; }
      });
      if (count) count.textContent = query ? shown + ' réponse(s) pour « ' + input.value.trim() + ' »' : '';
    });
  })();
  </script>`;

  return layout({
    title: 'FAQ — REZO',
    description: 'Réponses sur la licence REZO : activation, sièges, expiration, paiement Stripe, packs et devis.',
    body, active: 'faq', path: '/faq',
  });
}

// ── Guide d’activation ──────────────────────────────────────────────────────
function guidePage({ steps = GUIDE_STEPS, troubles = GUIDE_TROUBLES } = {}) {
  const body = `
  <section style="padding:56px 0 8px">
    <div class="wrap">
      <div class="sec-head" style="text-align:left;margin:0 0 26px">
        <div class="kicker">Guide</div>
        <h1 style="font-size:30px;margin:12px 0 10px">Activer une clé, pas à pas</h1>
        <p class="muted" style="max-width:70ch">
          Quatre étapes, deux minutes. La clé s’active dans Discord avec la commande
          <code>/license</code> — inutile de passer par un site tiers.
        </p>
      </div>

      ${steps.map(item => `
        <div class="box" style="margin-bottom:12px;display:flex;gap:16px;align-items:flex-start">
          <div style="font:700 20px/1 ui-monospace,monospace;color:var(--gold)">${esc(item.step)}</div>
          <div>
            <b>${esc(item.title)}</b>
            <p class="muted" style="margin-top:6px">${esc(item.text)}</p>
          </div>
        </div>`).join('')}

      <div class="note" style="margin:18px 0 30px">
        Le bot ne demande <b>jamais</b> ta clé en message privé. Une demande de clé, de mot de passe
        ou de code est une tentative d’arnaque : signale-la sur le serveur de support.
      </div>

      <h2 style="font-size:20px;margin:0 0 12px">Ça ne marche pas ?</h2>
      <div class="faq">
        ${troubles.map(item => `
          <details>
            <summary>${esc(item.q)}</summary>
            <p>${esc(item.a)}</p>
          </details>`).join('')}
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:26px">
        <a class="btn btn-gold" href="/verifier">Vérifier une clé</a>
        <a class="btn" href="/tarifs#offres">Voir les offres</a>
        <a class="btn" href="${esc(SUPPORT_INVITE)}" rel="noopener">Support</a>
      </div>
    </div>
  </section>`;

  return layout({
    title: 'Guide d’activation — REZO',
    description: 'Activer une licence REZO avec /license : étapes, sièges, erreurs de format et licence expirée.',
    body, active: 'guide', path: '/guide',
  });
}

// ── Journal des nouveautés ──────────────────────────────────────────────────
function changelogPage({ entries = CHANGELOG } = {}) {
  const sorted = [...entries].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const body = `
  <section style="padding:56px 0 8px">
    <div class="wrap">
      <div class="sec-head" style="text-align:left;margin:0 0 26px">
        <div class="kicker">Journal</div>
        <h1 style="font-size:30px;margin:12px 0 10px">Nouveautés</h1>
        <p class="muted" style="max-width:70ch">
          Ce qui a réellement changé, daté. Une entrée n’est publiée que quando
          la fonctionnalité est en service.
        </p>
      </div>

      ${sorted.map(entry => `
        <article class="box" style="margin-bottom:14px">
          <div class="small" style="color:var(--dim)">
            <time datetime="${esc(entry.date)}">${esc(new Date(`${entry.date}T12:00:00Z`).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }))}</time>
          </div>
          <h2 style="font-size:19px;margin:6px 0 10px">${esc(entry.title)}</h2>
          <ul style="margin:0;padding-left:20px" class="muted">
            ${entry.points.map(point => `<li>${esc(point)}</li>`).join('')}
          </ul>
        </article>`).join('')}

      <div class="note" style="margin-top:10px">
        Les commandes disponibles sont listées dans
        <a href="/commandes" style="color:var(--gold)">l’explorateur</a>.
      </div>
    </div>
  </section>`;

  return layout({
    title: 'Nouveautés — REZO',
    description: 'Journal des fonctionnalités livrées sur REZO : portail d’accès, devis, packs et site.',
    body, active: 'nouveautes', path: '/nouveautes',
  });
}

// ── Explorateur de commandes ─────────────────────────────────────────────────
function commandsPage({ commands = [], domains = [], domain = '', query = '' } = {}) {
  const cards = commands.map(c => `
    <article class="cmd">
      <div class="nm">/${esc(c.name)}</div>
      <div class="ds">${esc(c.description || '')}</div>
      ${c.subcommands?.length ? `<div class="subs">${c.subcommands.slice(0, 12).map(s => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
    </article>`).join('');

  const body = `
  <section style="padding:52px 0 10px">
    <div class="wrap">
      <span class="eyebrow">Commandes</span>
      <h1 style="font-size:clamp(28px,4vw,42px);margin:16px 0 10px">Tout ce que tu peux taper.</h1>
      <p class="lead muted" style="max-width:64ch">Cette liste vient du bot lui-même : elle est générée à chaque chargement de page, donc une commande ajoutée apparaît ici immédiatement.</p>
    </div>
  </section>
  <section style="padding-top:26px">
    <div class="wrap">
      <form method="get" action="/commandes" class="toolbar">
        <input type="search" name="q" value="${esc(query)}" placeholder="Rechercher une commande…" style="max-width:300px" aria-label="Rechercher">
        ${domain ? `<input type="hidden" name="domaine" value="${esc(domain)}">` : ''}
        <button class="btn btn-sm" type="submit">Rechercher</button>
        ${query || domain ? '<a class="btn btn-sm" href="/commandes">Réinitialiser</a>' : ''}
      </form>
      <div class="toolbar">
        <a class="chip${domain ? '' : ' on'}" href="/commandes${query ? `?q=${encodeURIComponent(query)}` : ''}">Toutes</a>
        ${domains.map(d => `<a class="chip${domain === d.id ? ' on' : ''}" href="/commandes?domaine=${encodeURIComponent(d.id)}${query ? `&q=${encodeURIComponent(query)}` : ''}">${esc(d.emoji)} ${esc(d.label)}</a>`).join('')}
      </div>
      <p class="count">${commands.length} commande${commands.length > 1 ? 's' : ''}${domain || query ? ' correspondante(s)' : ' au total'}</p>
      ${cards ? `<div class="cmd-grid">${cards}</div>` : '<div class="note">Aucun résultat. Essaie un autre mot-clé.</div>'}
    </div>
  </section>`;
  return layout({
    title: 'Commandes — REZO',
    description: 'Liste complète des commandes REZO, avec recherche et domaines.',
    body, active: 'commandes', path: '/commandes',
  });
}

// ── Erreurs ──────────────────────────────────────────────────────────────────
// ── Administration des commandes ─────────────────────────────────────────────
// Une seule page, sans JavaScript : chaque action est un formulaire POST. Le
// jeton admin est mémorisé dans un cookie HttpOnly par la route /admin, donc
// il n'apparaît jamais dans l'URL des actions.
function adminLoginPage({ error = '' } = {}) {
  const body = `
  <section style="padding:64px 0">
    <div class="wrap panel">
      <div class="box">
        <h1 style="font-size:24px;margin:0 0 8px">Administration</h1>
        <p class="muted" style="margin-bottom:20px">Cette page liste les commandes et permet d'émettre les clés. Réservée au propriétaire.</p>
        ${error ? `<div class="note" style="border-left-color:#f87171;margin-bottom:18px"><b style="color:#fecaca">${esc(error)}</b></div>` : ''}
        <form method="post" action="/admin">
          <label class="small" for="jeton">Jeton administrateur</label>
          <input id="jeton" name="jeton" type="password" required autocomplete="current-password"
            style="width:100%;margin:8px 0 16px;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:#0c0910;color:var(--text);font-size:14px"
            placeholder="STORE_ADMIN_TOKEN">
          <button class="btn btn-gold btn-wide" type="submit">Entrer</button>
        </form>
        <p class="small" style="margin-top:16px">Le jeton se définit dans <code>STORE_ADMIN_TOKEN</code>.</p>
      </div>
    </div>
  </section>`;
  return layout({ title: 'Administration — REZO', description: 'Gestion des commandes REZO.', body, noindex: true });
}

const STATUS_LABELS = {
  pending: ['En attente', 'pending'],
  paid: ['Payée', 'paid'],
  cancelled: ['Annulée', 'bad'],
  refunded: ['Remboursée', 'bad'],
};

function adminOrderCard(order) {
  const [label, tone] = STATUS_LABELS[order.status] || [order.status, 'pending'];
  const ref = String(order.token || '').slice(0, 12);
  const token = esc(order.token || '');
  const hasMail = Boolean(order.email);

  const actions = [];
  if (order.status === 'pending') {
    actions.push(`<form method="post" action="/admin/orders/${token}/encaisse"><button class="btn btn-gold btn-sm" type="submit">${hasMail ? 'Approuver et envoyer' : 'Approuver'}</button></form>`);
    actions.push(`<form method="post" action="/admin/orders/${token}/refuser"><button class="btn btn-sm" type="submit">Refuser</button></form>`);
  }
  if (order.status === 'paid') {
    actions.push(`<form method="post" action="/admin/orders/${token}/email"><button class="btn btn-sm" type="submit"${hasMail ? '' : ' disabled'}>${order.emailSentAt ? 'Renvoyer la clé' : 'Envoyer la clé'}</button></form>`);
    actions.push(`<a class="btn btn-sm" href="/commande/${token}">Page client</a>`);
  }

  return `
    <div class="box" style="padding:18px 20px">
      <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
        <div>
          <b style="font-size:15px">Licence ${esc(order.plan)}</b>
          <span class="status ${tone}" style="margin-left:8px">● ${esc(label)}</span>
          <div class="small" style="margin-top:6px">
            ${esc(formatPrice(order.amountCents, order.currency))} · ${esc(new Date(order.createdAt).toLocaleString('fr-FR'))} · réf. ${esc(ref)}…
          </div>
        </div>
        <div class="small" style="text-align:right">
          ${hasMail ? `✉️ ${esc(order.email)}${order.emailSentAt ? `<br><span style="color:var(--ok)">envoyée le ${esc(new Date(order.emailSentAt).toLocaleString('fr-FR'))}</span>` : ''}` : '<span style="color:var(--dim)">aucune adresse e-mail</span>'}
        </div>
      </div>
      ${order.key ? `<div class="small" style="margin-top:10px">Clé : <code>${esc(order.key)}</code></div>` : ''}
      ${actions.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">${actions.join('')}</div>` : ''}
    </div>`;
}

function adminPage({ orders = [], message = null, mail = { configured: false }, filter = '' } = {}) {
  const counts = { pending: 0, paid: 0, cancelled: 0, refunded: 0 };
  for (const order of orders) if (order.status in counts) counts[order.status] += 1;

  const filters = [['', 'Toutes'], ['pending', 'En attente'], ['paid', 'Payées'], ['cancelled', 'Annulées']];
  const tabs = filters.map(([value, label]) =>
    `<a class="btn btn-sm" href="/admin${value ? `?etat=${value}` : ''}"${filter === value ? ' style="border-color:var(--gold2);color:var(--gold)"' : ''}>${esc(label)}</a>`,
  ).join('');

  const body = `
  <section style="padding:44px 0">
    <div class="wrap" style="max-width:900px;margin:0 auto">
      ${message ? `<div class="note" style="margin-bottom:18px">${esc(message)}</div>` : ''}
      <div class="box" style="margin-bottom:20px">
        <h1 style="font-size:24px;margin:0 0 6px">Commandes</h1>
        <p class="muted small" style="margin:0">${counts.pending} en attente · ${counts.paid} payées · ${counts.cancelled + counts.refunded} annulées ou remboursées</p>
        ${mail.configured ? '' : `<div class="note" style="border-left-color:#fbbf24;margin-top:16px"><b>E-mails désactivés.</b> Ajoute <code>RESEND_API_KEY</code> et <code>STORE_MAIL_FROM</code> pour livrer la clé automatiquement. En attendant, elle s'affiche sur la page client.</div>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">${tabs}</div>
      </div>
      <div style="display:grid;gap:12px">
        ${orders.length ? orders.map(adminOrderCard).join('\n') : '<div class="box" style="text-align:center"><p class="muted" style="margin:0">Aucune commande pour ce filtre.</p></div>'}
      </div>
    </div>
  </section>`;
  return layout({ title: 'Commandes — Administration REZO', description: 'Gestion des licences REZO.', body, noindex: true });
}

// ── Statut ───────────────────────────────────────────────────────────────────
// Rendue depuis l'état réel du processus : aucune valeur n'est inventée. Quand
// le site tourne seul (`npm run site`), le bot est simplement absent — la page
// le dit au lieu d'afficher « hors ligne » comme une panne.
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min ${s % 60} s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const mo = bytes / 1048576;
  return mo >= 1024 ? `${(mo / 1024).toFixed(1)} Go` : `${Math.round(mo)} Mo`;
}

function statusPage({ info = {} } = {}) {
  const online = Boolean(info.online);
  const rows = [
    ['Bot', online ? '🟢 En ligne' : '⚪ Site seul (bot non connecté)'],
    ['Latence', Number.isFinite(info.ping) ? `${info.ping} ms` : '—'],
    ['Serveurs', Number.isFinite(info.guilds) ? info.guilds : '—'],
    ['Membres', Number.isFinite(info.members) ? info.members : '—'],
    ['Commandes', Number.isFinite(info.commands) ? info.commands : '—'],
    ['Modules', Number.isFinite(info.modules) ? info.modules : '—'],
    ['En ligne depuis', formatDuration(info.uptimeMs)],
    ['Mémoire du processus', formatBytes(info.memoryBytes)],
    ['Paiement Stripe', info.services?.stripe ? 'configuré' : 'validation manuelle'],
    ['Livraison par e-mail', info.services?.mail ? 'configurée' : 'désactivée'],
    ['Adresse publique', info.siteUrl || '—'],
    ['Version', `v${info.version || VERSION}`],
  ];

  const body = `
  <section style="padding:56px 0 10px">
    <div class="wrap">
      <span class="eyebrow">Statut</span>
      <h1 style="font-size:clamp(28px,4vw,42px);margin:16px 0 12px">${online ? 'Tout répond.' : 'Le site répond.'}</h1>
      <p class="lead muted" style="max-width:62ch">Mesures prises à l’instant sur le processus qui sert cette page. Rien n’est mis en cache.</p>
    </div>
  </section>
  <section style="padding-top:22px">
    <div class="wrap panel">
      <div class="row" style="border:0;padding:0"><span>Dernière vérification</span><b>${esc(new Date().toLocaleString('fr-FR'))}</b></div>
      ${rows.map(([label, value]) => `<div class="row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('\n      ')}
      <p class="small" style="margin-top:18px">Cette page ne dévoile aucun secret : elle indique seulement si les services sont configurés. Actualise pour rafraîchir les mesures.</p>
      <p style="margin-top:16px"><a class="btn btn-sm" href="/statut">Actualiser</a> <a class="btn btn-sm" href="/api/statut">Version JSON</a></p>
    </div>
  </section>`;
  return layout({
    title: 'Statut — REZO',
    description: 'État du bot et du site REZO : latence, serveurs, uptime, version, services configurés.',
    body, active: 'statut', path: '/statut',
  });
}

function errorPage({ status = 404, title = 'Page introuvable', message = 'Cette page n’existe pas ou a été déplacée.' } = {}) {
  const body = `
  <section style="padding:80px 0">
    <div class="wrap panel" style="text-align:center">
      <div style="font-size:56px;font-weight:800;letter-spacing:-.04em;color:var(--gold)">${esc(status)}</div>
      <h1 style="font-size:26px;margin:12px 0 10px">${esc(title)}</h1>
      <p class="muted" style="max-width:46ch;margin:0 auto 22px">${esc(message)}</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <a class="btn btn-gold" href="/">Retour à l’accueil</a>
        <a class="btn" href="/tarifs">Voir les offres</a>
      </div>
    </div>
  </section>`;
  return layout({ title: `${title} — REZO`, description: message, body, noindex: true });
}

// ── Fin des pages publiques ─────────────────────────────────────────────────

module.exports = {
  CSS,
  esc,
  formatDuration,
  formatBytes,
  statusPage,
  layout,
  planCard,
  plansSection,
  homePage,
  pricingPage,
  packCard,
  packsPage,
  faqPage,
  faqJsonLd,
  guidePage,
  changelogPage,
  quotePage,
  checkoutPage,
  orderPage,
  verifyPage,
  commandsPage,
  adminLoginPage,
  adminPage,
  errorPage,
};
