#!/usr/bin/env node
'use strict';
// scripts/build-pdp.js — Génère la page de présentation (PDP) de REZO.
//
// La page est un fichier HTML unique, sans requête externe : CSS et JS embarqués,
// aucune police distante, aucune image à charger. Elle se dépose telle quelle sur
// n'importe quel hébergeur statique (ou sur le site du bot).
//
// Le contenu factuel (nombre de commandes, catégories, descriptions, guides)
// vient du catalogue réel du bot — pas de chiffres saisis à la main qui
// vieillissent mal. Relancer le script après l'ajout d'une commande suffit.
//
// Usage :
//   node scripts/build-pdp.js [--client-id=ID] [--permissions=MASQUE] [--out=chemin]
//   DISCORD_CLIENT_ID=ID node scripts/build-pdp.js
//
// Sans --client-id, le bouton « Inviter » renvoie vers la section essai : mieux
// vaut pas de lien qu'un lien Discord invalide.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const OUT_PATH = path.resolve(ROOT, args.out || path.join('site', 'index.html'));
const SITE_URL = String(args['site-url'] || require(path.join(ROOT, 'src', 'utils', 'siteUrl')).siteUrl()).replace(/\/+$/, '');
const CLIENT_ID = String(args['client-id'] || process.env.DISCORD_CLIENT_ID || '').trim();
const INVITE_URL = String(args['invite-url'] || process.env.INVITE_URL || '').trim();

// ── Contenu factuel ──────────────────────────────────────────────────────────
const pkg = require(path.join(ROOT, 'package.json'));
const { BRAND } = require(path.join(ROOT, 'src', 'utils', 'brand'));
const catalog = require(path.join(ROOT, 'src', 'utils', 'helpCatalog')).buildCatalog({});

const TRIAL_DAYS = Number.parseInt(process.env.TRIAL_DURATION_DAYS || '7', 10) || 7;
const licensed = catalog.entries.filter(e => e.license);
const freeCount = catalog.total - licensed.length;

/** Emoji de tête d'une description, retiré du texte pour éviter les doublons. */
function splitEmoji(text) {
  const m = /^([\p{Extended_Pictographic}\uFE0F\u200D]+)\s*/u.exec(text || '');
  return m ? { icon: m[1], text: text.slice(m[0].length) } : { icon: null, text: text || '' };
}

const CATEGORY_META = {
  configuration: { icon: '🛠️', blurb: 'Tout se règle depuis Discord, sans fichier de configuration.' },
  moderation:    { icon: '🛡️', blurb: 'Filtrage, sanctions, anti-raid et journalisation.' },
  communaute:    { icon: '👥', blurb: 'Animation, avis, anniversaires, invitations.' },
  'bump-reseau': { icon: '🚀', blurb: 'Visibilité et coopération entre serveurs.' },
  economie:      { icon: '💰', blurb: 'Monnaie, boutique, récompenses quotidiennes.' },
  musique:       { icon: '🎵', blurb: 'Lecture audio sans serveur externe.' },
  fun:           { icon: '🎲', blurb: 'Jeux et distractions rapides.' },
  xp:            { icon: '📈', blurb: 'Niveaux, rôles de palier et classements.' },
  utilitaires:   { icon: '🧰', blurb: 'Aide, profil, sondages, rappels.' },
  owner:         { icon: '👑', blurb: 'Outils réservés au propriétaire du bot.' },
};

// ── Permissions Discord demandées à l'invitation ─────────────────────────────
// Union volontairement large : le bot refuse proprement ce qu'il ne peut pas
// faire, et une ré-invitation pour un octet manquant est le premier motif de
// support. Le masque reste surchargeable via --permissions.
const PERMISSION_BITS = {
  MANAGE_CHANNELS: 16,
  KICK_MEMBERS: 2,
  BAN_MEMBERS: 4,
  ADD_REACTIONS: 64,
  VIEW_CHANNEL: 1024,
  SEND_MESSAGES: 2048,
  MANAGE_MESSAGES: 8192,
  EMBED_LINKS: 16384,
  ATTACH_FILES: 32768,
  READ_MESSAGE_HISTORY: 65536,
  USE_EXTERNAL_EMOJIS: 262144,
  CONNECT: 1048576,
  SPEAK: 2097152,
  MUTE_MEMBERS: 4194304,
  DEAFEN_MEMBERS: 8388608,
  MOVE_MEMBERS: 16777216,
  MANAGE_NICKNAMES: 134217728,
  MANAGE_ROLES: 268435456,
  MANAGE_WEBHOOKS: 536870912,
  MODERATE_MEMBERS: 1099511627776,
  CREATE_PRIVATE_THREADS: 17179869184,
  CREATE_PUBLIC_THREADS: 34359738368,
  SEND_MESSAGES_IN_THREADS: 274877906944,
};
const DEFAULT_PERMISSIONS = Object.values(PERMISSION_BITS).reduce((a, b) => a + b, 0);

const permissions = args.permissions !== undefined
  ? String(args.permissions)
  : String(DEFAULT_PERMISSIONS);

function inviteUrl() {
  if (INVITE_URL) return INVITE_URL;
  if (!CLIENT_ID) return null;
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&permissions=${permissions}&scope=bot%20applications.commands`;
}

// ── Éditorial ────────────────────────────────────────────────────────────────
const PILLARS = [
  {
    icon: '🛡️',
    title: 'Une sécurité qui ne se contourne pas',
    body: "Anti-nuke, anti-raid, captcha, honeypot et coffre-fort de permissions : cinq couches indépendantes. Si l'une laisse passer, la suivante arrête la casse.",
  },
  {
    icon: '🧭',
    title: 'Un autopilote qui configure',
    body: "Le bot note votre serveur de 0 à 100, montre précisément ce qui manque, puis installe lui-même ce qu'il peut faire sans risque.",
  },
  {
    icon: '📦',
    title: 'Tout-en-un, vraiment',
    body: `${catalog.total} commandes réparties en ${catalog.categories.length} catégories : modération, animation, musique, économie, IA, tickets. Un seul bot à inviter, un seul préfixe à retenir.`,
  },
  {
    icon: '💸',
    title: 'Aucune dépendance payante',
    body: "Pas de Lavalink à louer pour la musique, pas de clé d'IA à acheter : les moteurs gratuits et les fournisseurs sans clé prennent le relais.",
  },
  {
    icon: '🇫🇷',
    title: 'Pensé en français',
    body: "Textes, aide, erreurs et documentation en français. L'aide répond aussi bien à /help qu'à « comment activer le captcha ».",
  },
  {
    icon: '⚡',
    title: 'Rien à installer d\'obligatoire',
    body: "Chaque module fonctionne dès l'invitation avec des réglages par défaut sensés. La configuration est un confort, pas un prérequis.",
  },
];

const DEEP_DIVES = [
  {
    id: 'securite',
    eyebrow: 'Sécurité',
    title: 'Sentinel : le serveur se défend même quand vous dormez',
    body: "Chaque action destructrice est horodatée, attribuée et comparée à un seuil propre au serveur. Un compte compromis qui supprime douze salons en dix secondes est neutralisé avant d'atteindre le onzième.",
    bullets: [
      'Détection par type d\'action : salons, rôles, bans, webhooks, bots ajoutés.',
      'Correction automatique : rôles rendus, salons recréés depuis la sauvegarde.',
      'Responsable identifié et sanctionné, même s\'il est administrateur ou propriétaire.',
      'Tout est réversible : un journal explique chaque décision, /securite permet de tout couper.',
    ],
    visual: 'security',
  },
  {
    id: 'autopilote',
    eyebrow: 'Configuration',
    title: 'Un score qui vous dit quoi faire, puis le fait',
    body: "Le score d'efficacité mesure ce qui compte réellement : protections actives, arrivées filtrées, animation en place, journalisation. Chaque point manquant s'accompagne d'un bouton pour le gagner.",
    bullets: [
      `${BRAND.GOAL_PERCENT}% = serveur considéré comme complet, pas 100% : l'excellence n'exige pas l'usine à gaz.`,
      'Installation en un clic des modules sûrs (captcha, autorole, journalisation).',
      'Diagnostic relu à chaque passage : le score suit la vie du serveur.',
    ],
    visual: 'score',
  },
  {
    id: 'musique',
    eyebrow: 'Musique',
    title: 'De la musique sans serveur à louer',
    body: "La lecture passe par un moteur interne : pas de Lavalink, pas d'abonnement, pas de seconde machine à maintenir. La file survit aux coupures et précharge le morceau suivant pour éviter les blancs.",
    bullets: [
      'File, boucle, aléatoire, saut et reprise après déconnexion.',
      'Préchargement du titre suivant : l\'enchaînement est immédiat.',
      'Recherche par lien ou par mots-clés, sans compte premium.',
    ],
    visual: 'music',
  },
  {
    id: 'ia',
    eyebrow: 'Intelligence artificielle',
    title: 'Une IA qui bascule seule quand un quota tombe',
    body: "Le chat IA essaie plusieurs fournisseurs dans l'ordre, met de côté celui qui vient d'épuiser son quota et reprend là où il s'était arrêté. Deux fournisseurs fonctionnent même sans aucune clé API.",
    bullets: [
      'Bascule automatique entre fournisseurs, avec cooldown persistant.',
      'Mode salon, commande dédiée, playground et fiches de commande en langage naturel.',
      '/ia stats affiche l\'état réel de chaque fournisseur et son heure de retour.',
    ],
    visual: 'ai',
  },
];

const FAQ = [
  {
    q: 'Faut-il une licence pour utiliser REZO ?',
    a: `${freeCount} commandes fonctionnent sans licence, indéfiniment. ${licensed.length} commandes avancées (IA, tickets, niveaux, réseau, autopilote…) sont réservées aux serveurs sous licence, avec un essai de ${TRIAL_DAYS} jours pour tout évaluer.`,
  },
  {
    q: 'Comment se passe l\'essai ?',
    a: `À la première invitation, le serveur reçoit ${TRIAL_DAYS} jours d'accès complet, sans carte bancaire et sans limitation cachée. À la fin, les modules sous licence se mettent en pause ; tout le reste continue de fonctionner et rien n'est supprimé.`,
  },
  {
    q: 'Où trouve-t-on la clé de licence ?',
    a: 'La clé vous est transmise après l\'essai, au format REZO-XXXX-XXXX-XXXX-XXXX. Elle s\'active avec /license et se rattache au serveur, pas à un compte : elle survit aux changements de propriétaire.',
  },
  {
    q: 'Le bot lit-il mes messages ?',
    a: 'Les messages ne sont traités que pour les modules que vous activez (captcha, mots interdits, trésors, IA) et ne sont pas conservés au-delà du nécessaire. Le contenu des tickets et des conversations IA est stocké sur votre serveur pour que le contexte fonctionne, et supprimable avec /config.',
  },
  {
    q: 'Que se passe-t-il si le bot tombe ?',
    a: 'Les réglages vivent en base, pas en mémoire : au redémarrage, tout est rechargé. Les sauvegardes de serveur permettent même de reconstruire salons et rôles après un raid.',
  },
  {
    q: 'Puis-je tout désactiver ?',
    a: 'Oui, module par module, avec les commandes de configuration ou /securite pour la partie protection. Aucun module ne se réactive tout seul.',
  },
];

// ── Rendu ────────────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const escAttr = esc;
const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Markdown allégé : gras, code inline, paragraphes. Suffisant pour les guides. */
function mdLite(text) {
  const html = esc(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  return html.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function renderPillars() {
  return PILLARS.map(p => `
      <article class="card pillar">
        <span class="pillar-icon" aria-hidden="true">${p.icon}</span>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.body)}</p>
      </article>`).join('');
}

function renderVisual(kind) {
  if (kind === 'security') {
    const rows = [
      ['09:41:02', 'Suppression de 3 salons', 'bloquée', 'bad'],
      ['09:41:02', 'Rôles restaurés', 'auto', 'ok'],
      ['09:41:03', 'Auteur expulsé', 'sanction', 'ok'],
      ['09:41:05', 'Journal envoyé', '2 destinataires', 'muted'],
    ];
    return `<div class="mock">
        <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><em>sentinel · journal</em></div>
        <ul class="mock-log">${rows.map(([t, what, tag, kind2]) => `
          <li><time>${t}</time><span>${esc(what)}</span><b class="${kind2}">${esc(tag)}</b></li>`).join('')}
        </ul>
        <div class="mock-foot"><span class="pulse"></span> Protection active · 5 couches</div>
      </div>`;
  }
  if (kind === 'score') {
    const checks = [
      ['Captcha d\'arrivée', true], ['Anti-nuke armé', true], ['Journal de modération', true],
      ['Autorole configuré', true], ['Animation quotidienne', false],
    ];
    return `<div class="mock score">
        <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><em>autopilote</em></div>
        <div class="score-head">
          <strong>${BRAND.GOAL_PERCENT}%</strong>
          <div>
            <span class="score-grade">Objectif atteint</span>
            <span class="score-bar">${BRAND.glyphs.full.repeat(11)}${BRAND.glyphs.empty.repeat(1)}</span>
          </div>
        </div>
        <ul class="score-list">${checks.map(([label, done]) => `
          <li class="${done ? 'done' : 'todo'}"><i aria-hidden="true">${done ? '✓' : '+'}</i>${esc(label)}<em>${done ? 'actif' : 'installer'}</em></li>`).join('')}
        </ul>
      </div>`;
  }
  if (kind === 'music') {
    return `<div class="mock music">
        <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><em>musique · salon vocal</em></div>
        <div class="track">
          <div class="cover" aria-hidden="true">♫</div>
          <div class="track-meta">
            <strong>Lecture en cours</strong>
            <span>Moteur interne · sans Lavalink</span>
            <div class="progress"><i style="width:42%"></i></div>
            <div class="times"><span>1:12</span><span>2:54</span></div>
          </div>
        </div>
        <ul class="queue">
          <li><b>01</b> Morceau suivant <em>préchargé</em></li>
          <li><b>02</b> File d'attente <em>+7</em></li>
        </ul>
      </div>`;
  }
  const providers = [
    ['Sans clé', 'prêt', 'ok'], ['Sans clé', 'prêt', 'ok'],
    ['Avec clé', 'prêt', 'ok'], ['Quota atteint', 'retour 14:20', 'warn'],
  ];
  return `<div class="mock ai">
      <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><em>ia · fournisseurs</em></div>
      <ul class="providers">${providers.map(([name, state, kind2]) => `
        <li><span class="prov-name">${esc(name)}</span><b class="${kind2}">${esc(state)}</b></li>`).join('')}
      </ul>
      <div class="bubble"><span>Vous</span>Quelle commande pour masquer un salon ?</div>
      <div class="bubble bot"><span>REZO</span>/config → Salons → Visibilité, puis choisissez le rôle.</div>
    </div>`;
}

function renderDeepDives() {
  return DEEP_DIVES.map((d, i) => `
      <article class="dive ${i % 2 ? 'flip' : ''}" id="${d.id}">
        <div class="dive-copy">
          <span class="eyebrow">${esc(d.eyebrow)}</span>
          <h3>${esc(d.title)}</h3>
          <p class="lede">${esc(d.body)}</p>
          <ul class="ticks">${d.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
        </div>
        <div class="dive-visual">${renderVisual(d.visual)}</div>
      </article>`).join('');
}

function renderGuides() {
  return catalog.guides.map(g => `
      <details class="guide">
        <summary><span aria-hidden="true">${esc(g.emoji || '📘')}</span>${esc(g.label || g.title)}</summary>
        ${g.tagline ? `<p class="tagline">${esc(g.tagline)}</p>` : ''}
        <div class="guide-body">${mdLite(g.body || '')}</div>
      </details>`).join('');
}

function renderCommands() {
  return catalog.categories.map((cat, index) => {
    const meta = CATEGORY_META[cat.id] || { icon: '•', blurb: '' };
    const rows = cat.commands.map(entry => {
      const { icon, text } = splitEmoji(entry.description || '');
      const search = [entry.name, entry.description, cat.label, ...(entry.aliases || [])].join(' ').toLowerCase();
      return `
          <li class="cmd" data-search="${escAttr(slug(search).replace(/-/g, ' '))}">
            <span class="cmd-ico" aria-hidden="true">${icon || meta.icon}</span>
            <div class="cmd-main">
              <code>/${esc(entry.name)}</code>
              <p>${esc(text)}</p>
            </div>
            ${entry.license ? '<span class="tag lic" title="Nécessite une licence">🔒 licence</span>' : ''}
          </li>`;
    }).join('');
    return `
      <details class="cat"${index === 0 ? ' open' : ''}>
        <summary>
          <span class="cat-ico" aria-hidden="true">${meta.icon}</span>
          <span class="cat-name">${esc(cat.label)}</span>
          <span class="cat-count">${cat.commands.length}</span>
        </summary>
        <p class="cat-blurb">${esc(meta.blurb)}</p>
        <ul class="cmd-list">${rows}</ul>
      </details>`;
  }).join('');
}

function renderFaq() {
  return FAQ.map(f => `
      <details class="faq">
        <summary>${esc(f.q)}</summary>
        <p>${esc(f.a)}</p>
      </details>`).join('');
}

// ── Page ─────────────────────────────────────────────────────────────────────
const invite = inviteUrl();
const primaryCta = invite
  ? { href: invite, label: 'Inviter REZO', external: true }
  : { href: '#essai', label: 'Essayer gratuitement', external: false };
const secondaryCta = invite
  ? { href: '#commandes', label: `Voir les ${catalog.total} commandes`, external: false }
  : { href: '#commandes', label: `Voir les ${catalog.total} commandes`, external: false };

const STATS = [
  [String(catalog.total), 'commandes'],
  [String(catalog.categories.length), 'catégories'],
  [`${freeCount}`, 'gratuites à vie'],
  [`${TRIAL_DAYS} j`, 'd\'essai complet'],
];

const title = `${BRAND.name} — ${BRAND.tagline} pour Discord`;
const description = `${BRAND.name} réunit ${catalog.total} commandes Discord : modération, anti-nuke, captcha, musique sans Lavalink, niveaux, économie et IA gratuite. Essai de ${TRIAL_DAYS} jours, sans carte.`;

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${escAttr(description)}">
<meta name="theme-color" content="#8B1A1A">
<meta property="og:type" content="website">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(description)}">
<meta property="og:url" content="${escAttr(SITE_URL)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${escAttr(SITE_URL)}">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#8B1A1A"/><text x="32" y="45" font-family="Georgia,serif" font-size="38" font-weight="700" fill="#D4AF37" text-anchor="middle">R</text></svg>`)}">
<style>
:root{
  --wine:#8B1A1A; --wine-lt:#B8272B; --gold:#D4AF37; --gold-soft:#E8C96B;
  --bg:#0B0709; --bg-2:#120B0E; --panel:rgba(255,255,255,.045);
  --line:rgba(255,255,255,.09); --line-strong:rgba(212,175,55,.32);
  --text:#F4EEEF; --muted:#A89EA1; --ok:#57F287; --warn:#FEE75C; --err:#ED4245;
  --radius:18px; --maxw:1120px;
  --font:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  --serif:Georgia,"Times New Roman",serif;
}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:var(--bg);color:var(--text);font-family:var(--font);
  line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden;
}
body::before{
  content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;
  background:
    radial-gradient(900px 520px at 12% -8%,rgba(139,26,26,.45),transparent 62%),
    radial-gradient(760px 500px at 88% 4%,rgba(212,175,55,.13),transparent 60%),
    radial-gradient(900px 700px at 50% 110%,rgba(139,26,26,.22),transparent 65%),
    var(--bg);
}
a{color:var(--gold-soft);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{line-height:1.15;margin:0;letter-spacing:-.02em}
h1{font-family:var(--serif);font-weight:700}
p{margin:0 0 1em}
code{font-family:"Cascadia Code",Consolas,monospace;font-size:.86em;background:rgba(255,255,255,.07);border:1px solid var(--line);padding:.1em .38em;border-radius:6px;color:var(--gold-soft)}
ul{padding:0;margin:0;list-style:none}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px;border-radius:6px}
.skip{position:absolute;left:-999px;top:8px;background:var(--wine);padding:.6rem 1rem;border-radius:8px;z-index:100}
.skip:focus{left:8px}

.wrap{width:min(100% - 2.5rem,var(--maxw));margin-inline:auto}

/* ── Nav ─────────────────────────────────────────────────────────── */
.nav{
  position:sticky;top:0;z-index:50;backdrop-filter:blur(14px);
  background:rgba(11,7,9,.76);border-bottom:1px solid var(--line);
}
.nav .wrap{display:flex;align-items:center;gap:1.4rem;height:64px}
.brand{display:flex;align-items:center;gap:.6rem;font-weight:800;letter-spacing:.16em;font-size:.95rem;color:var(--text)}
.brand:hover{text-decoration:none}
.brand svg{width:30px;height:30px;flex:none}
.nav nav{display:flex;gap:1.1rem;margin-left:auto;font-size:.9rem}
.nav nav a{color:var(--muted);font-weight:500}
.nav nav a:hover{color:var(--text);text-decoration:none}
.nav .btn{padding:.5rem .95rem;font-size:.85rem}
@media(max-width:880px){.nav nav{display:none}}

/* ── Boutons ─────────────────────────────────────────────────────── */
.btn{
  display:inline-flex;align-items:center;gap:.5rem;padding:.85rem 1.5rem;border-radius:999px;
  font-weight:700;font-size:.95rem;border:1px solid transparent;transition:transform .18s,box-shadow .18s,background .18s;
}
.btn:hover{text-decoration:none;transform:translateY(-1px)}
.btn-primary{
  background:linear-gradient(135deg,#A11F24,#6E1216);color:#fff;
  border-color:rgba(212,175,55,.55);box-shadow:0 10px 30px -12px rgba(161,31,36,.9),inset 0 1px 0 rgba(255,255,255,.14);
}
.btn-primary:hover{box-shadow:0 16px 38px -12px rgba(161,31,36,1),0 0 0 1px rgba(212,175,55,.55)}
.btn-ghost{background:rgba(255,255,255,.05);color:var(--text);border-color:var(--line)}
.btn-ghost:hover{background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.2)}

/* ── Hero ────────────────────────────────────────────────────────── */
.hero{padding:clamp(3.5rem,8vw,6.5rem) 0 3rem;position:relative}
.badge{
  display:inline-flex;align-items:center;gap:.55rem;font-size:.76rem;letter-spacing:.14em;
  text-transform:uppercase;font-weight:700;color:var(--gold-soft);
  border:1px solid var(--line-strong);background:rgba(212,175,55,.08);
  padding:.42rem .9rem;border-radius:999px;margin-bottom:1.6rem;
}
.badge i{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px rgba(87,242,135,.18);animation:pulse 2.6s infinite}
.hero h1{font-size:clamp(2.6rem,6.4vw,4.6rem);max-width:19ch}
.hero h1 em{font-style:normal;background:linear-gradient(100deg,var(--gold) 0%,#F3DFA0 45%,var(--wine-lt) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .sub{font-size:clamp(1.02rem,1.6vw,1.22rem);color:var(--muted);max-width:60ch;margin:1.3rem 0 2.1rem}
.hero .sub strong{color:var(--text);font-weight:600}
.cta-row{display:flex;flex-wrap:wrap;gap:.8rem;align-items:center}
.cta-note{font-size:.82rem;color:var(--muted)}

.stats{
  display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin-top:3.4rem;
  background:var(--line);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;
}
.stats div{background:rgba(18,11,14,.86);padding:1.15rem 1.25rem}
.stats strong{display:block;font-size:clamp(1.5rem,2.6vw,2rem);font-family:var(--serif);color:var(--gold-soft);font-variant-numeric:tabular-nums}
.stats span{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
@media(max-width:720px){.stats{grid-template-columns:repeat(2,1fr)}}

/* ── Sections ────────────────────────────────────────────────────── */
section{padding:clamp(3rem,6vw,5rem) 0}
.head{max-width:64ch;margin-bottom:2.4rem}
.eyebrow{display:block;font-size:.74rem;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);font-weight:700;margin-bottom:.7rem}
.head h2{font-size:clamp(1.7rem,3.4vw,2.5rem);font-family:var(--serif)}
.head p{color:var(--muted);margin-top:.9rem;font-size:1.02rem}

.grid{display:grid;gap:1.1rem;grid-template-columns:repeat(3,1fr)}
@media(max-width:900px){.grid{grid-template-columns:1fr 1fr}}
@media(max-width:620px){.grid{grid-template-columns:1fr}}
.card{
  background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  padding:1.5rem;position:relative;overflow:hidden;transition:border-color .2s,transform .2s,background .2s;
}
.card::after{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,transparent,rgba(212,175,55,.5),transparent);opacity:0;transition:opacity .2s}
.card:hover{border-color:rgba(255,255,255,.17);transform:translateY(-3px);background:rgba(255,255,255,.062)}
.card:hover::after{opacity:1}
.pillar-icon{font-size:1.5rem;display:block;margin-bottom:.85rem}
.card h3{font-size:1.04rem;margin-bottom:.6rem}
.card p{color:var(--muted);font-size:.92rem;margin:0}

/* ── Focus ───────────────────────────────────────────────────────── */
.dive{display:grid;grid-template-columns:1.05fr .95fr;gap:clamp(1.5rem,4vw,3.4rem);align-items:center;padding:1.4rem 0}
.dive + .dive{border-top:1px solid var(--line)}
.dive.flip .dive-copy{order:2}
.dive-copy h3{font-size:clamp(1.35rem,2.6vw,1.85rem);font-family:var(--serif);margin-bottom:.9rem}
.lede{color:var(--muted);font-size:.98rem}
.ticks li{position:relative;padding-left:1.7rem;margin-bottom:.6rem;font-size:.9rem;color:#DED5D7}
.ticks li::before{content:"✓";position:absolute;left:0;top:0;color:var(--ok);font-weight:700}
@media(max-width:860px){
  .dive{grid-template-columns:1fr}
  .dive.flip .dive-copy{order:0}
}

/* ── Maquettes ───────────────────────────────────────────────────── */
.mock{
  background:linear-gradient(180deg,rgba(20,12,15,.96),rgba(12,8,10,.96));
  border:1px solid var(--line);border-radius:var(--radius);padding:1rem;
  box-shadow:0 30px 60px -40px #000,inset 0 1px 0 rgba(255,255,255,.05);
  font-size:.85rem;
}
.mock-bar{display:flex;align-items:center;gap:.35rem;padding-bottom:.75rem;border-bottom:1px solid var(--line);margin-bottom:.85rem}
.mock-bar .dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.16)}
.mock-bar .dot:first-child{background:var(--wine-lt)}
.mock-bar .dot:nth-child(2){background:var(--gold)}
.mock-bar em{margin-left:.6rem;font-style:normal;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.mock-log li{display:grid;grid-template-columns:auto 1fr auto;gap:.7rem;align-items:center;padding:.5rem .2rem;border-bottom:1px dashed rgba(255,255,255,.06)}
.mock-log li:last-child{border-bottom:0}
.mock-log time{font-family:Consolas,monospace;font-size:.74rem;color:var(--muted)}
.mock-log b{font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;padding:.18rem .45rem;border-radius:999px;border:1px solid}
.mock-log b.bad{color:#FF9B9D;border-color:rgba(237,66,69,.45);background:rgba(237,66,69,.12)}
.mock-log b.ok{color:#9DF3BC;border-color:rgba(87,242,135,.4);background:rgba(87,242,135,.1)}
.mock-log b.muted{color:var(--muted);border-color:var(--line)}
.mock-foot{display:flex;align-items:center;gap:.5rem;margin-top:.85rem;font-size:.76rem;color:var(--muted)}
.pulse{width:7px;height:7px;border-radius:50%;background:var(--ok);animation:pulse 2s infinite}

.score-head{display:flex;align-items:center;gap:1rem;margin-bottom:1rem}
.score-head strong{font-family:var(--serif);font-size:2.6rem;color:var(--gold-soft);line-height:1}
.score-grade{display:block;font-size:.76rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ok)}
.score-bar{display:block;color:var(--gold);letter-spacing:.12em;font-size:.9rem;margin-top:.35rem}
.score-list li{display:flex;align-items:center;gap:.6rem;padding:.42rem .1rem;font-size:.83rem;border-bottom:1px dashed rgba(255,255,255,.06)}
.score-list li:last-child{border:0}
.score-list i{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-style:normal;font-size:.7rem;flex:none}
.score-list .done i{background:rgba(87,242,135,.15);color:var(--ok)}
.score-list .todo i{background:rgba(254,231,92,.12);color:var(--warn)}
.score-list em{margin-left:auto;font-style:normal;font-size:.72rem;color:var(--muted)}

.track{display:flex;gap:.85rem;align-items:center;margin-bottom:.9rem}
.cover{width:58px;height:58px;border-radius:12px;display:grid;place-items:center;font-size:1.5rem;flex:none;
  background:linear-gradient(135deg,var(--wine),#3A0A0C);border:1px solid var(--line-strong);color:var(--gold-soft)}
.track-meta{flex:1;min-width:0}
.track-meta strong{display:block;font-size:.9rem}
.track-meta span{font-size:.74rem;color:var(--muted)}
.progress{height:5px;border-radius:99px;background:rgba(255,255,255,.1);margin:.55rem 0 .3rem;overflow:hidden}
.progress i{display:block;height:100%;background:linear-gradient(90deg,var(--wine-lt),var(--gold))}
.times{display:flex;justify-content:space-between;font-size:.68rem;color:var(--muted)}
.queue li{display:flex;gap:.6rem;align-items:center;font-size:.8rem;padding:.42rem .1rem;border-top:1px dashed rgba(255,255,255,.06)}
.queue b{color:var(--muted);font-weight:600;font-size:.72rem}
.queue em{margin-left:auto;font-style:normal;font-size:.68rem;color:var(--gold-soft)}

.providers li{display:flex;justify-content:space-between;align-items:center;padding:.4rem .1rem;font-size:.8rem;border-bottom:1px dashed rgba(255,255,255,.06)}
.providers b{font-size:.68rem;padding:.16rem .5rem;border-radius:999px;border:1px solid}
.providers b.ok{color:#9DF3BC;border-color:rgba(87,242,135,.4);background:rgba(87,242,135,.1)}
.providers b.warn{color:#FBEDA0;border-color:rgba(254,231,92,.35);background:rgba(254,231,92,.1)}
.bubble{margin-top:.7rem;background:rgba(255,255,255,.05);border:1px solid var(--line);border-radius:12px;padding:.6rem .75rem;font-size:.8rem}
.bubble span{display:block;font-size:.64rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.2rem}
.bubble.bot{background:rgba(139,26,26,.22);border-color:var(--line-strong)}

/* ── Guides ──────────────────────────────────────────────────────── */
.guides{display:grid;grid-template-columns:repeat(2,1fr);gap:.8rem}
@media(max-width:760px){.guides{grid-template-columns:1fr}}
details{background:var(--panel);border:1px solid var(--line);border-radius:14px}
details[open]{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14)}
summary{cursor:pointer;list-style:none;padding:.95rem 1.1rem;font-weight:600;font-size:.94rem;display:flex;align-items:center;gap:.65rem}
summary::-webkit-details-marker{display:none}
summary::after{content:"+";margin-left:auto;color:var(--gold);font-weight:400;font-size:1.15rem;line-height:1}
details[open] summary::after{content:"–"}
.guide .tagline{color:var(--muted);font-size:.82rem;margin:0 1.1rem .6rem}
.guide-body{padding:0 1.1rem 1.1rem;font-size:.88rem;color:#D6CCCE}
.guide-body p{margin:0 0 .7rem}
.guide-body strong{color:var(--text)}

/* ── Commandes ───────────────────────────────────────────────────── */
.cmd-tools{display:flex;gap:.8rem;align-items:center;margin-bottom:1.2rem;flex-wrap:wrap}
.cmd-tools input{
  flex:1;min-width:220px;background:rgba(255,255,255,.05);border:1px solid var(--line);
  border-radius:999px;padding:.7rem 1.1rem;color:var(--text);font-family:inherit;font-size:.9rem;
}
.cmd-tools input::placeholder{color:#7C7275}
.cmd-tools input:focus{border-color:var(--line-strong);outline:none;box-shadow:0 0 0 3px rgba(212,175,55,.12)}
.cmd-count{font-size:.8rem;color:var(--muted);font-variant-numeric:tabular-nums}
.cat{margin-bottom:.6rem}
.cat summary{gap:.8rem}
.cat-ico{font-size:1.05rem}
.cat-name{flex:1}
.cat-count{font-size:.72rem;color:var(--gold-soft);background:rgba(212,175,55,.1);border:1px solid var(--line-strong);padding:.1rem .5rem;border-radius:999px;font-variant-numeric:tabular-nums}
.cat summary::after{content:"+";flex:none}
.cat-blurb{padding:0 1.1rem;font-size:.82rem;color:var(--muted);margin:0 0 .5rem}
.cmd-list{padding:0 1.1rem 1rem;display:grid;grid-template-columns:1fr 1fr;gap:.1rem .9rem}
@media(max-width:820px){.cmd-list{grid-template-columns:1fr}}
.cmd{display:flex;gap:.7rem;align-items:flex-start;padding:.55rem .1rem;border-bottom:1px dashed rgba(255,255,255,.055);min-width:0}
.cmd-ico{flex:none;width:1.4rem;text-align:center;font-size:.95rem;opacity:.9}
.cmd-main{min-width:0}
.cmd-main code{background:none;border:0;padding:0;font-size:.92rem;color:var(--gold-soft);font-weight:600}
.cmd-main p{margin:.1rem 0 0;font-size:.8rem;color:var(--muted);line-height:1.45}
.tag{flex:none;font-size:.6rem;letter-spacing:.06em;text-transform:uppercase;padding:.15rem .4rem;border-radius:5px;border:1px solid rgba(212,175,55,.4);color:var(--gold-soft);background:rgba(212,175,55,.08);white-space:nowrap}
.cmd.hide{display:none}
.empty{display:none;padding:1.2rem 1.1rem;color:var(--muted);font-size:.9rem}
.empty.show{display:block}

/* ── Essai ───────────────────────────────────────────────────────── */
.trial{
  display:grid;grid-template-columns:1.1fr .9fr;gap:2rem;align-items:center;
  border:1px solid var(--line-strong);border-radius:24px;padding:clamp(1.6rem,4vw,2.8rem);
  background:
    radial-gradient(600px 300px at 0% 0%,rgba(139,26,26,.4),transparent 65%),
    radial-gradient(500px 300px at 100% 100%,rgba(212,175,55,.12),transparent 60%),
    rgba(18,11,14,.9);
}
@media(max-width:860px){.trial{grid-template-columns:1fr}}
.trial h2{font-family:var(--serif);font-size:clamp(1.6rem,3.2vw,2.2rem);margin-bottom:.9rem}
.trial p{color:var(--muted);margin:0 0 .7rem}
.key-card{background:rgba(0,0,0,.45);border:1px solid var(--line);border-radius:14px;padding:1.2rem;text-align:center}
.key-card span{display:block;font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-bottom:.6rem}
.key-card code{font-size:clamp(.85rem,2.4vw,1.05rem);letter-spacing:.06em;background:none;border:0;color:var(--gold-soft)}
.key-card small{display:block;margin-top:.8rem;color:var(--muted);font-size:.72rem}

/* ── FAQ ─────────────────────────────────────────────────────────── */
.faq-list{max-width:840px}
.faq{margin-bottom:.6rem}
.faq summary{font-size:.95rem}
.faq p{padding:0 1.1rem 1.1rem;margin:0;color:var(--muted);font-size:.89rem}

/* ── Final ───────────────────────────────────────────────────────── */
.final{text-align:center;border-top:1px solid var(--line);padding-block:clamp(3rem,7vw,5rem)}
.final h2{font-family:var(--serif);font-size:clamp(1.8rem,4vw,2.8rem);margin-bottom:1rem}
.final p{color:var(--muted);max-width:52ch;margin:0 auto 1.8rem}
.final .cta-row{justify-content:center}

footer{border-top:1px solid var(--line);padding:2.2rem 0 2.6rem;font-size:.82rem;color:var(--muted)}
footer .wrap{display:flex;flex-wrap:wrap;gap:1rem 1.6rem;align-items:center;justify-content:space-between}
footer .links{display:flex;gap:1.2rem;flex-wrap:wrap}

@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important}
}
.reveal{opacity:0;transform:translateY(14px)}
.reveal.in{opacity:1;transform:none;transition:opacity .55s ease,transform .55s ease}
@media(prefers-reduced-motion:reduce){.reveal{opacity:1;transform:none}}
</style>
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>

<header class="nav">
  <div class="wrap">
    <a class="brand" href="#haut" aria-label="${escAttr(BRAND.name)} — accueil">
      <svg viewBox="0 0 64 64" role="img" aria-hidden="true">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#A11F24"/><stop offset="1" stop-color="#5A0F12"/>
        </linearGradient></defs>
        <rect width="64" height="64" rx="15" fill="url(#g)" stroke="rgba(212,175,55,.55)"/>
        <text x="32" y="45" font-family="Georgia,serif" font-size="36" font-weight="700" fill="#D4AF37" text-anchor="middle">R</text>
      </svg>
      ${esc(BRAND.name)}
    </a>
    <nav aria-label="Sections">
      <a href="#atouts">Atouts</a>
      <a href="#securite">Sécurité</a>
      <a href="#guides">Guides</a>
      <a href="#commandes">Commandes</a>
      <a href="#essai">Licence</a>
    </nav>
    <a class="btn btn-primary" href="${escAttr(primaryCta.href)}"${primaryCta.external ? ' target="_blank" rel="noopener"' : ''}>${esc(primaryCta.label)}</a>
  </div>
</header>

<main id="contenu">
  <section class="hero" id="haut">
    <div class="wrap">
      <span class="badge"><i></i>v${esc(pkg.version)} · ${catalog.total} commandes · ${catalog.categories.length} catégories</span>
      <h1>Le bot Discord <em>tout-en-un</em> qui protège et anime votre serveur.</h1>
      <p class="sub">${esc(BRAND.name)} réunit la modération, l'anti-nuke, le captcha, la musique, les niveaux, l'économie et une IA gratuite dans un seul bot. <strong>${freeCount} commandes gratuites à vie</strong>, ${TRIAL_DAYS} jours d'essai complet pour le reste, aucune carte bancaire.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="${escAttr(primaryCta.href)}"${primaryCta.external ? ' target="_blank" rel="noopener"' : ''}>${esc(primaryCta.label)}</a>
        <a class="btn btn-ghost" href="${escAttr(secondaryCta.href)}">${esc(secondaryCta.label)}</a>
        <span class="cta-note">Configuration par défaut incluse</span>
      </div>

      <div class="stats">
        ${STATS.map(([n, label]) => `<div><strong>${esc(n)}</strong><span>${esc(label)}</span></div>`).join('')}
      </div>
    </div>
  </section>

  <section id="atouts">
    <div class="wrap">
      <div class="head reveal">
        <span class="eyebrow">Pourquoi ${esc(BRAND.name)}</span>
        <h2>Un bot, pas une collection de modules à recoller.</h2>
        <p>La plupart des serveurs empilent cinq bots qui se marchent dessus : un pour la modération, un pour la musique, un pour les niveaux, un pour les tickets, un pour l'IA. ${esc(BRAND.name)} remplace la pile — et les réglages vivent au même endroit.</p>
      </div>
      <div class="grid reveal">${renderPillars()}
      </div>
    </div>
  </section>

  <section id="fonctionnalites">
    <div class="wrap">
      <div class="head reveal">
        <span class="eyebrow">En détail</span>
        <h2>Ce que ça change, concrètement.</h2>
        <p>Quatre modules qui font la différence au quotidien, avec le comportement réel — pas une liste de promesses.</p>
      </div>
      ${renderDeepDives()}
    </div>
  </section>

  <section id="guides">
    <div class="wrap">
      <div class="head reveal">
        <span class="eyebrow">Prise en main</span>
        <h2>${catalog.guides.length} guides, écrits pour être suivis.</h2>
        <p>Les mêmes guides que dans <code>/help</code>, accessibles sans être sur le serveur. Chaque étape indique la commande exacte.</p>
      </div>
      <div class="guides reveal">${renderGuides()}
      </div>
    </div>
  </section>

  <section id="commandes">
    <div class="wrap">
      <div class="head reveal">
        <span class="eyebrow">Catalogue</span>
        <h2>${catalog.total} commandes, ${catalog.categories.length} catégories.</h2>
        <p>Liste complète générée depuis le bot : descriptions exactes, commandes sous licence signalées 🔒.</p>
      </div>
      <div class="cmd-tools">
        <label for="q" class="skip">Rechercher une commande</label>
        <input id="q" type="search" placeholder="Rechercher une commande (captcha, musique, ticket…)" autocomplete="off" spellcheck="false">
        <span class="cmd-count" id="cmd-count" aria-live="polite">${catalog.total} commandes</span>
      </div>
      <div class="cmd-cats reveal">${renderCommands()}
        <p class="empty" id="cmd-empty">Aucune commande ne correspond à cette recherche.</p>
      </div>
    </div>
  </section>

  <section id="essai">
    <div class="wrap">
      <div class="trial reveal">
        <div>
          <span class="eyebrow">Licence</span>
          <h2>${TRIAL_DAYS} jours pour tout tester. Ensuite, vous choisissez.</h2>
          <p>À l'invitation, le serveur reçoit l'accès complet pendant ${TRIAL_DAYS} jours : IA, tickets, niveaux, réseau, autopilote. Pas de carte bancaire, pas de formulaire.</p>
          <p>À la fin de l'essai, les modules sous licence se mettent en pause. Les ${freeCount} commandes gratuites continuent de fonctionner et <strong>rien n'est supprimé</strong> : réactiver suffit à retrouver la configuration.</p>
        </div>
        <div class="key-card">
          <span>Format de clé</span>
          <code>REZO-XXXX-XXXX-XXXX-XXXX</code>
          <small>Activation avec <code>/license</code> · rattachée au serveur</small>
        </div>
      </div>
    </div>
  </section>

  <section id="faq">
    <div class="wrap">
      <div class="head reveal">
        <span class="eyebrow">Questions fréquentes</span>
        <h2>Les réponses avant l'invitation.</h2>
      </div>
      <div class="faq-list reveal">${renderFaq()}
      </div>
    </div>
  </section>

  <section class="final">
    <div class="wrap">
      <h2>Prêt à remplacer la pile de bots ?</h2>
      <p>Invitation en deux clics, réglages par défaut déjà efficaces, et ${TRIAL_DAYS} jours pour juger sur pièce.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="${escAttr(primaryCta.href)}"${primaryCta.external ? ' target="_blank" rel="noopener"' : ''}>${esc(primaryCta.label)}</a>
        <a class="btn btn-ghost" href="${escAttr(SITE_URL)}">Documentation</a>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <span>${esc(BRAND.name)} v${esc(pkg.version)} · ${esc(BRAND.tagline)}</span>
    <span class="links">
      <a href="${escAttr(SITE_URL)}/help">Aide</a>
      <a href="#commandes">Commandes</a>
      <a href="#essai">Licence</a>
      <a href="${escAttr(SITE_URL)}">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a>
    </span>
  </div>
</footer>

<script>
(function () {
  var input = document.getElementById('q');
  var count = document.getElementById('cmd-count');
  var empty = document.getElementById('cmd-empty');
  var cats = Array.prototype.slice.call(document.querySelectorAll('.cat'));
  if (input && cats.length) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('.cmd'));
    var total = rows.length;
    var norm = function (s) {
      return (s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
    };
    var filter = function () {
      var q = norm(input.value).trim();
      var shown = 0;
      rows.forEach(function (row) {
        var hit = !q || norm(row.getAttribute('data-search') + ' ' + row.textContent).indexOf(q) !== -1;
        row.classList.toggle('hide', !hit);
        if (hit) shown++;
      });
      cats.forEach(function (cat) {
        var visible = cat.querySelectorAll('.cmd:not(.hide)').length;
        cat.dataset.hits = visible;
        cat.classList.toggle('hide', visible === 0);
        if (q && visible > 0) cat.open = true;
        var badge = cat.querySelector('.cat-count');
        if (badge) badge.textContent = q ? visible : cat.querySelectorAll('.cmd').length;
      });
      if (count) count.textContent = q ? shown + ' / ' + total + ' commandes' : total + ' commandes';
      if (empty) empty.classList.toggle('show', shown === 0);
    };
    input.addEventListener('input', filter);
    input.addEventListener('search', filter);
  }

  var reveals = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    reveals.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  reveals.forEach(function (el) { io.observe(el); });
})();
</script>
</body>
</html>
`;

// ── Écriture ─────────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
const rel = path.relative(ROOT, OUT_PATH).replace(/\\/g, '/');
console.log(`✅ Page générée : ${rel} (${kb} Ko)`);
console.log(`   ${catalog.total} commandes · ${catalog.categories.length} catégories · ${catalog.guides.length} guides · ${freeCount} gratuites / ${licensed.length} sous licence`);
if (!invite) {
  console.log('   ⚠️  Aucun CLIENT_ID fourni : le bouton principal pointe vers la section essai.');
  console.log('      Relancez avec --client-id=VOTRE_ID (ou DISCORD_CLIENT_ID=…).');
} else {
  console.log(`   Invitation : ${invite.slice(0, 78)}${invite.length > 78 ? '…' : ''}`);
}

// Le chargement du catalogue ouvre des handles (modèles, minuteurs) : sans cette
// sortie explicite, le script reste vivant après avoir écrit le fichier.
process.exit(0);
