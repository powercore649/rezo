'use strict';
// utils/storeTheme.js — Feuille de styles du site (thème sombre moderne).
//
// Sortie du fichier de rendu pour deux raisons :
//   • `storePages.js` ne contient plus que du HTML, la mise en forme est ici ;
//   • une modification de thème ne touche pas au code des pages.
//
// Contraintes tenues : aucune ressource externe (police, image, script), donc
// une CSP stricte suffit et le site s'affiche même hors ligne. Toutes les
// classes utilisées par les pages sont définies ici — aucune dépendance à une
// feuille distante.
//
// Accessibilité : contrastes conservés, anneau de focus visible, et les
// animations sont neutralisées quand le système demande moins de mouvement.

module.exports = `
:root{
  color-scheme:dark;
  --bg:#07060c; --bg2:#0b0913;
  --panel:rgba(255,255,255,.034); --panel2:rgba(255,255,255,.06);
  --line:rgba(255,255,255,.075); --line2:rgba(255,255,255,.14);
  --text:#f6f2fb; --muted:#a9a1bc; --dim:#7b7290;
  --wine:#a5212e; --wine2:#6f1220; --rose:#ef4d63;
  --gold:#f2d183; --gold2:#c79b32;
  --violet:#8b6cf6; --violet2:#5b3fd6;
  --ok:#4ade80; --warn:#fbbf24; --bad:#f87171;
  --radius:22px; --max:1140px;
  --ease:cubic-bezier(.22,.61,.36,1);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0; color:var(--text); background:var(--bg);
  font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,sans-serif;
  font-feature-settings:"ss01" 1,"cv11" 1;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  background-image:
    radial-gradient(720px 720px at 8% -12%, rgba(165,33,46,.26), transparent 66%),
    radial-gradient(680px 620px at 92% -6%, rgba(139,108,246,.20), transparent 64%),
    radial-gradient(900px 700px at 50% 108%, rgba(242,209,131,.06), transparent 70%),
    linear-gradient(180deg,var(--bg2),var(--bg) 46%);
  background-repeat:no-repeat; background-attachment:fixed;
}
::selection{background:rgba(242,209,131,.28);color:#fff}
a{color:inherit;text-decoration:none}
img{max-width:100%}
h1,h2,h3{line-height:1.08;letter-spacing:-.03em;margin:0;text-wrap:balance}
p{margin:0}
:focus-visible{outline:2px solid var(--gold);outline-offset:3px;border-radius:6px}
*{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.18) transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:999px;
  border:2px solid transparent;background-clip:content-box}
.wrap{width:100%;max-width:var(--max);margin:0 auto;padding:0 24px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:16px;top:12px;z-index:99;background:var(--gold);color:#1a1206;
  padding:8px 14px;border-radius:10px}

/* ── entête ─────────────────────────────────────────────────────────────── */
.top{position:sticky;top:0;z-index:40;background:rgba(8,7,13,.72);
  backdrop-filter:saturate(170%) blur(18px);-webkit-backdrop-filter:saturate(170%) blur(18px);
  border-bottom:1px solid var(--line)}
.top::after{content:'';display:block;height:1px;
  background:linear-gradient(90deg,transparent,rgba(242,209,131,.35),transparent)}
.top-inner{display:flex;align-items:center;gap:22px;height:70px}
.brand{display:flex;align-items:center;gap:11px;font-weight:800;letter-spacing:.16em;font-size:14.5px}
.mark{display:grid;place-items:center;width:32px;height:32px;border-radius:11px;
  background:linear-gradient(150deg,var(--rose),var(--wine) 55%,var(--wine2));
  color:#fff3d6;font-family:ui-serif,Georgia,serif;font-size:17px;
  box-shadow:0 10px 26px rgba(165,33,46,.45), inset 0 1px 0 rgba(255,255,255,.28)}
.ver{font-size:10.5px;letter-spacing:.08em;color:var(--dim);border:1px solid var(--line2);
  border-radius:999px;padding:2px 8px;font-weight:600;background:rgba(255,255,255,.03)}



.nav{display:flex;gap:24px;margin-left:auto;font-size:14px;color:var(--muted)}
.nav a{position:relative;padding:4px 0;transition:color .2s var(--ease)}
.nav a::after{content:'';position:absolute;left:0;right:0;bottom:-2px;height:1px;
  transform:scaleX(0);transform-origin:left;transition:transform .25s var(--ease);
  background:linear-gradient(90deg,var(--gold),transparent)}
.nav a:hover{color:var(--text)}
.nav a:hover::after{transform:scaleX(1)}

/* ── boutons ────────────────────────────────────────────────────────────── */
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:9px;
  border-radius:14px;padding:12px 20px;font-weight:650;font-size:14.5px;font-family:inherit;
  border:1px solid var(--line2);background:rgba(255,255,255,.045);color:var(--text);
  cursor:pointer;overflow:hidden;
  transition:transform .18s var(--ease),background .2s,border-color .2s,box-shadow .25s}
.btn:hover{transform:translateY(-2px);background:rgba(255,255,255,.075);
  border-color:rgba(255,255,255,.22);box-shadow:0 14px 30px rgba(0,0,0,.35)}
.btn:active{transform:translateY(0)}
.btn-primary{background:linear-gradient(135deg,var(--rose),var(--wine) 70%);
  border-color:rgba(239,77,99,.55);color:#fff;
  box-shadow:0 14px 34px -10px rgba(165,33,46,.6), inset 0 1px 0 rgba(255,255,255,.22)}
.btn-primary:hover{background:linear-gradient(135deg,#f75d72,var(--wine))}
.btn-gold{background:linear-gradient(135deg,#fbe6ac,var(--gold) 40%,var(--gold2));color:#241a06;
  border-color:rgba(255,240,205,.7);font-weight:750;
  box-shadow:0 14px 34px -10px rgba(242,209,131,.45), inset 0 1px 0 rgba(255,255,255,.6)}
.btn-gold::after{content:'';position:absolute;inset:0;
  background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.5),transparent 70%);
  transform:translateX(-120%);transition:transform .6s var(--ease)}
.btn-gold:hover::after{transform:translateX(120%)}
.btn-sm{padding:8px 14px;font-size:13px;border-radius:11px}
.btn-wide{width:100%}
.btn[disabled]{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none}

/* ── hero ───────────────────────────────────────────────────────────────── */
.hero{position:relative;padding:86px 0 30px}
.eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:12px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--gold);border:1px solid rgba(242,209,131,.32);
  background:linear-gradient(135deg,rgba(242,209,131,.12),rgba(139,108,246,.08));
  border-radius:999px;padding:6px 14px;font-weight:700}
.hero h1{font-size:clamp(36px,5.6vw,64px);margin:22px 0 18px;max-width:19ch}
.hero h1 em{font-style:normal;
  background:linear-gradient(100deg,var(--gold),#fff6d8 45%,var(--rose));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.hero .lead{color:var(--muted);font-size:clamp(16px,2vw,18.5px);max-width:62ch}
.hero-cta{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}
.hero-note{color:var(--dim);font-size:13.5px;margin-top:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:48px 0 0}
.stat{border:1px solid var(--line);border-radius:18px;padding:18px 20px;
  background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.015));
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.stat b{display:block;font-size:27px;letter-spacing:-.03em;
  background:linear-gradient(120deg,#fff,var(--gold));-webkit-background-clip:text;
  background-clip:text;color:transparent}
.stat span{color:var(--dim);font-size:12px;letter-spacing:.06em;text-transform:uppercase}

/* ── sections ───────────────────────────────────────────────────────────── */
section{padding:64px 0}
.sec-head{max-width:66ch;margin-bottom:34px}
.sec-head h2{font-size:clamp(26px,3.4vw,38px);margin-bottom:12px}
.sec-head h1,.sec-head h2{text-wrap:balance}
.sec-head p{color:var(--muted)}
.kicker{color:var(--gold);font-size:12px;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;margin-bottom:10px}

/* ── grilles & cartes ───────────────────────────────────────────────────── */
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(272px,1fr))}
.card{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);
  padding:24px;background:linear-gradient(170deg,rgba(255,255,255,.052),rgba(255,255,255,.014));
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:transform .22s var(--ease),border-color .22s,box-shadow .25s}
.card:hover{transform:translateY(-3px);border-color:rgba(255,255,255,.19);
  box-shadow:0 24px 50px -24px rgba(0,0,0,.75)}
.card .ico{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;font-size:21px;
  margin-bottom:16px;background:linear-gradient(145deg,rgba(239,77,99,.22),rgba(139,108,246,.16));
  border:1px solid rgba(255,255,255,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}
.card h3{font-size:18px;margin-bottom:6px}
.card .sub{color:var(--muted);font-size:14.5px;margin-bottom:14px}
.card ul{margin:0;padding:0;list-style:none;display:grid;gap:8px}
.card li{font-size:14px;color:var(--muted);padding-left:18px;position:relative}
.card li::before{content:'';position:absolute;left:0;top:.55em;width:7px;height:7px;border-radius:2px;
  background:linear-gradient(135deg,var(--gold),var(--rose));transform:rotate(45deg)}

/* ── offres ─────────────────────────────────────────────────────────────── */
.plans{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(268px,1fr));align-items:stretch}
.plan{position:relative;display:flex;flex-direction:column;border:1px solid var(--line);
  border-radius:24px;padding:28px;
  background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.012));
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:transform .22s var(--ease),border-color .22s,box-shadow .25s}
.plan:hover{transform:translateY(-3px);border-color:rgba(255,255,255,.18)}
.plan.hot{border-color:rgba(242,209,131,.5);
  box-shadow:0 0 0 1px rgba(242,209,131,.18), 0 34px 80px -30px rgba(165,33,46,.65);
  background:linear-gradient(180deg,rgba(242,209,131,.09),rgba(139,108,246,.05) 60%,rgba(255,255,255,.012))}
.plan .tag{position:absolute;top:-11px;left:28px;font-size:10.5px;font-weight:800;letter-spacing:.12em;
  text-transform:uppercase;background:linear-gradient(135deg,#fbe6ac,var(--gold),var(--gold2));
  color:#241a06;padding:5px 12px;border-radius:999px;
  box-shadow:0 8px 20px -6px rgba(242,209,131,.6)}
.plan h3{font-size:19.5px;margin-bottom:4px}
.plan .meta{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}
.badge{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--gold);
  border:1px solid rgba(242,209,131,.32);background:rgba(242,209,131,.08);
  border-radius:999px;padding:3px 10px;font-weight:700}
.badge.muted{color:var(--dim);border-color:var(--line2);background:rgba(255,255,255,.03);font-weight:600}
.plan .fine{font-size:12.5px;color:var(--dim);margin:2px 0 0}
.plan .tagline{color:var(--dim);font-size:13.5px;min-height:2.6em}
.price{display:flex;align-items:baseline;gap:9px;margin:18px 0 4px}
.price b{font-size:40px;letter-spacing:-.04em;
  background:linear-gradient(120deg,#fff,var(--gold));-webkit-background-clip:text;
  background-clip:text;color:transparent}
.price span{color:var(--dim);font-size:13.5px}
.plan ul{margin:18px 0 24px;padding:0;list-style:none;display:grid;gap:10px}
.plan li{font-size:14.2px;color:var(--muted);padding-left:22px;position:relative}
.plan li::before{content:'✓';position:absolute;left:0;top:-1px;font-weight:800;font-size:13px;
  color:var(--gold)}
.plan form{margin-top:auto}
.field{display:grid;gap:7px;margin-bottom:12px}
.field label{font-size:11.5px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase;font-weight:700}
input[type=text],input[type=email],input[type=search]{
  width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--line2);
  background:rgba(0,0,0,.35);color:var(--text);font-size:14.5px;font-family:inherit;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.45);
  transition:border-color .2s,box-shadow .2s}
input::placeholder{color:#6c637f}
input:focus{outline:none;border-color:rgba(242,209,131,.65);
  box-shadow:inset 0 1px 2px rgba(0,0,0,.45), 0 0 0 4px rgba(242,209,131,.14)}

/* ── paliers ────────────────────────────────────────────────────────────── */
.paliers{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(262px,1fr));margin-bottom:26px}
.palier{border:1px solid var(--line);border-radius:20px;padding:22px;
  background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.012))}
.palier .pk{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:700}
.palier h3{font-size:17.5px;margin:9px 0 6px}
.palier p{color:var(--muted);font-size:14px}
.palier .seats{margin-top:12px;font-size:12.5px;color:var(--gold);font-weight:650}
.palier .chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:12px}
.palier .chips span{font-size:11px;color:var(--dim);border:1px solid var(--line2);
  border-radius:7px;padding:1px 7px;font-family:ui-monospace,monospace;background:rgba(255,255,255,.03)}

/* ── étapes ─────────────────────────────────────────────────────────────── */
.steps{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(258px,1fr))}
.step{border:1px solid var(--line);border-radius:20px;padding:24px;
  background:linear-gradient(180deg,rgba(255,255,255,.045),rgba(255,255,255,.012))}
.step .num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  background:linear-gradient(120deg,var(--gold),var(--rose));-webkit-background-clip:text;
  background-clip:text;color:transparent;font-size:13px;letter-spacing:.18em;margin-bottom:12px}
.step h3{font-size:16.5px;margin-bottom:8px}
.step p{color:var(--muted);font-size:14.2px}

/* ── garanties ──────────────────────────────────────────────────────────── */
.guarantees{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:22px}
.guarantee{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);
  border-radius:16px;padding:15px 17px;background:rgba(255,255,255,.028)}
.guarantee .g-ico{font-size:18px;line-height:1.2}
.guarantee b{display:block;font-size:14px}
.guarantee span{color:var(--dim);font-size:12.8px}

/* ── commandes ──────────────────────────────────────────────────────────── */
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:22px}
.chip{border:1px solid var(--line2);border-radius:999px;padding:7px 14px;font-size:13px;
  color:var(--muted);background:rgba(255,255,255,.03);transition:border-color .2s,color .2s}
.chip:hover{border-color:rgba(255,255,255,.24);color:var(--text)}
.chip.on{border-color:transparent;color:#241a06;font-weight:700;
  background:linear-gradient(135deg,#fbe6ac,var(--gold))}
.cmd-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.cmd{border:1px solid var(--line);border-radius:16px;padding:16px 17px;
  background:rgba(255,255,255,.028);transition:border-color .2s,transform .2s var(--ease)}
.cmd:hover{border-color:rgba(255,255,255,.18);transform:translateY(-2px)}
.cmd .nm{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:var(--gold)}
.cmd .ds{color:var(--muted);font-size:13.6px;margin-top:4px}
.cmd .subs{margin-top:10px;display:flex;flex-wrap:wrap;gap:5px}
.cmd .subs span{font-size:11px;color:var(--dim);border:1px solid var(--line2);
  border-radius:7px;padding:1px 7px;font-family:ui-monospace,monospace;background:rgba(255,255,255,.03)}
.count{color:var(--dim);font-size:13px;margin-bottom:16px}

/* ── FAQ ────────────────────────────────────────────────────────────────── */
.faq{display:grid;gap:10px;max-width:880px}
details{border:1px solid var(--line);border-radius:16px;padding:16px 18px;
  background:rgba(255,255,255,.028);transition:border-color .2s,background .2s}
details:hover{border-color:rgba(255,255,255,.16)}
details[open]{border-color:rgba(242,209,131,.32);
  background:linear-gradient(180deg,rgba(242,209,131,.06),rgba(255,255,255,.02))}
summary{cursor:pointer;font-weight:650;font-size:15.5px;list-style:none;
  display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
summary::-webkit-details-marker{display:none}
summary::after{content:'+';color:var(--gold);font-weight:800;font-size:17px;line-height:1;
  transition:transform .2s var(--ease)}
details[open] summary::after{content:'−'}
details p{color:var(--muted);font-size:14.4px;margin-top:10px}

/* ── commande / licence ─────────────────────────────────────────────────── */
.panel{max-width:780px;margin:0 auto}
.box{border:1px solid var(--line);border-radius:var(--radius);padding:28px;
  background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.012));
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);margin-bottom:16px}
.status{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;font-weight:750;
  letter-spacing:.09em;text-transform:uppercase;border-radius:999px;padding:6px 13px}
.status.pending{color:#fde68a;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.4)}
.status.paid{color:#bbf7d0;background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.4)}
.status.bad{color:#fecaca;background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.4)}
.key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:clamp(16px,2.6vw,22px);
  letter-spacing:.07em;user-select:all;word-break:break-all;color:#fff8e2;
  border:1px dashed rgba(242,209,131,.45);border-radius:14px;padding:17px;text-align:center;
  background:radial-gradient(420px 120px at 50% 0%,rgba(242,209,131,.14),rgba(242,209,131,.03))}
.row{display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between;
  border-bottom:1px solid var(--line);padding:11px 0;font-size:14.5px}
.row:last-child{border-bottom:0}
.row span{color:var(--dim)}
.row b{font-weight:650}
.muted{color:var(--muted)}
.small{font-size:13px;color:var(--dim)}
.note{border-left:3px solid var(--gold2);padding:12px 15px;
  background:linear-gradient(90deg,rgba(242,209,131,.09),rgba(242,209,131,.02));
  border-radius:0 12px 12px 0;font-size:14px;color:var(--muted)}
.pill{display:inline-block;font-size:12px;border:1px solid var(--line2);border-radius:999px;
  padding:2px 10px;color:var(--dim);background:rgba(255,255,255,.03)}

/* ── bandeau final ──────────────────────────────────────────────────────── */
.final{position:relative;overflow:hidden;border:1px solid rgba(242,209,131,.28);
  border-radius:26px;padding:42px 32px;text-align:center;
  background:
    radial-gradient(700px 260px at 50% 0%,rgba(165,33,46,.30),transparent 70%),
    radial-gradient(520px 240px at 82% 100%,rgba(139,108,246,.20),transparent 70%),
    linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.012))}
.final h2{font-size:clamp(24px,3.4vw,34px);margin-bottom:12px}
.final p{color:var(--muted);max-width:56ch;margin:0 auto 22px}

/* ── pied ───────────────────────────────────────────────────────────────── */
footer{border-top:1px solid var(--line);padding:38px 0 46px;margin-top:24px;
  color:var(--dim);font-size:13.4px}
.foot{display:flex;flex-wrap:wrap;gap:18px;justify-content:space-between;align-items:center}
.foot a{transition:color .2s}
.foot a:hover{color:var(--text)}
.foot-links{display:flex;flex-wrap:wrap;gap:16px}

/* ── adaptations ────────────────────────────────────────────────────────── */
@media (max-width:900px){
  .nav{display:none}
  .hero{padding:62px 0 20px}
  section{padding:50px 0}
  .top-inner{height:62px}
}
@media (max-width:520px){
  .wrap{padding:0 18px}
  .box,.plan,.card{padding:20px}
  .price b{font-size:33px}
  .final{padding:32px 22px;border-radius:20px}
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{animation-duration:.001ms !important;transition-duration:.001ms !important}
  .btn:hover,.card:hover,.plan:hover,.cmd:hover{transform:none}
}
`;
