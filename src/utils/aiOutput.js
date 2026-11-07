'use strict';
// utils/aiOutput.js — Mise en forme des réponses de l'IA pour Discord.
//
// Le modèle peut demander trois choses en plus du texte :
//   • réagir avec un emoji       → [[react: 😂]]
//   • envoyer un sticker        → [[sticker: nom]]
//   • découper en messages      → une ligne `---` entre les parties
//
// La modération est traitée à part (aiModeration) et n'est active que si le
// serveur l'autorise : [[action: {"type":"timeout","user":"ID",…}]].
//
// Ce module est pur : aucune dépendance Discord, Mongo ou réseau, donc testable
// seul. Toutes les balises sont retirées du texte final, quoi qu'il arrive.

const MAX_SEGMENTS = 3;
const MAX_REACTIONS = 3;

/** Consignes ajoutées au prompt (courtes : elles coûtent des tokens à chaque appel). */
function buildInstructions(cfg = {}) {
  const lines = [
    'Mise en forme Discord (balises invisibles pour les membres) :',
    '• [[react: 😂]] pour réagir au message au lieu d’écrire (1 à 3 max).',
    '• [[sticker: nom]] pour envoyer un sticker du serveur quand c’est plus parlant.',
    '• Sépare plusieurs messages par une ligne ne contenant que --- (3 max, chacun court).',
  ];
  if (cfg.moderationTools) {
    lines.push('• [[action: {"type":"timeout|kick|ban|unban","user":"ID","minutes":10,"reason":"..."}]] uniquement si on te demande explicitement une sanction et que tu connais l’ID du membre.');
  }
  lines.push('• [[voice]] pour joindre aussi une version vocale de ta réponse (uniquement si on te le demande).');
  lines.push('N’utilise ces balises que si elles apportent quelque chose ; sinon réponds normalement.');
  lines.push('Si on te demande de répondre en vocal ou en audio, ne dis JAMAIS que tu en es incapable : réponds normalement, le bot joint l’audio.');
  return lines.join('\n');
}

function cleanSegment(text) {
  return String(text || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extrait les directives et renvoie un texte propre, découpé en segments.
 * @returns {{ text:string, segments:string[], reactions:string[], sticker:string|null, actions:object[] }}
 */
function parse(raw) {
  let text = String(raw || '');
  const reactions = [];
  const actions = [];
  let sticker = null;
  let voice = false;

  text = text.replace(/\[\[voice\]\]/gi, () => { voice = true; return ''; });

  text = text.replace(/\[\[(react|sticker|action)\s*:\s*([\s\S]*?)\]\]/gi, (_, kind, value) => {
    const clean = String(value || '').trim();
    const type = String(kind).toLowerCase();
    if (!clean) return '';
    if (type === 'react' && reactions.length < MAX_REACTIONS) reactions.push(clean.slice(0, 32));
    else if (type === 'sticker') sticker = clean.slice(0, 64);
    else if (type === 'action') {
      try {
        const parsed = JSON.parse(clean);
        if (parsed && typeof parsed === 'object' && parsed.type) actions.push(parsed);
      } catch { /* directive illisible : ignorée */ }
    }
    return '';
  });

  // Balises inconnues : jamais affichées au membre.
  text = text.replace(/\[\[[a-z_-]+\s*:[\s\S]*?\]\]/gi, '');

  const segments = text
    .split(/\n\s*---\s*\n/)
    .map(cleanSegment)
    .filter(Boolean)
    .slice(0, MAX_SEGMENTS);

  return {
    text: segments.join('\n\n'),
    segments,
    reactions,
    sticker,
    voice,
    actions: actions.slice(0, 2),
  };
}

module.exports = { MAX_SEGMENTS, MAX_REACTIONS, buildInstructions, parse };
