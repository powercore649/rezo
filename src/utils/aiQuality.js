'use strict';
// utils/aiQuality.js — Qualité de réponse de l'IA : anti-répétition.
//
// Deux niveaux, tous deux purs et testables :
//   1. DANS une réponse : suppression des phrases/paragraphes strictement
//      répétés (un modèle qui boucle produit souvent la même phrase deux fois) ;
//   2. ENTRE les réponses : détection de similarité avec les dernières réponses
//      de la conversation, pour déclencher UNE reformulation au lieu de servir
//      deux fois le même texte.
//
// Aucune dépendance Discord/DB/réseau.

const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux', 'et', 'ou',
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'mon', 'ton',
  'ce', 'cette', 'ces', 'que', 'qui', 'pour', 'avec', 'dans', 'sur', 'est',
  'sont', 'a', 'ai', 'as', 'en', 'y', 'ne', 'pas', 'plus', 'mais', 'donc',
  'si', 'comme', 'tout', 'tous', 'toute', 'toutes', 'bien', 'aussi', 'peut',
  'être', 'etre', 'avoir', 'fait', 'faire', 'très', 'tres', 'bon', 'voici',
]);

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text) {
  return normalizeText(text).split(' ').filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/** Similarité de Jaccard entre les mots significatifs de deux textes (0 → 1). */
function similarity(a, b) {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Vrai si `candidate` répète l'une des `previous` réponses.
 * Un texte strictement identique, quasi identique (Jaccard ≥ seuil), ou qui
 * contient mot pour mot une réponse précédente assez longue est considéré
 * comme une répétition.
 */
function isRepetitive(candidate, previous = [], threshold = 0.8) {
  const clean = normalizeText(candidate);
  if (!clean) return false;

  for (const prior of previous) {
    const old = normalizeText(prior);
    if (!old) continue;
    if (clean === old) return true;
    if (old.length > 120 && (clean.includes(old) || old.includes(clean))) return true;
    if (similarity(clean, old) >= threshold) return true;
  }
  return false;
}

/**
 * Supprime les paragraphes identiques et les phrases strictement dupliquées
 * DANS un même texte. Conservateur : seules les répétitions exactes (une fois
 * normalisées) sont retirées, la mise en forme et le contenu utiles restent.
 */
function dedupeSentences(text) {
  const source = String(text || '').trim();
  if (!source) return source;

  const paragraphs = source.split(/\n{2,}/);
  const seenParagraphs = new Set();
  const seenOutputs = new Set();
  const output = [];

  for (const paragraph of paragraphs) {
    const cleanParagraph = normalizeText(paragraph);
    if (cleanParagraph.length >= 40 && seenParagraphs.has(cleanParagraph)) continue;
    if (cleanParagraph) seenParagraphs.add(cleanParagraph);

    const sentences = paragraph.split(/(?<=[.!?…])\s+/);
    const seenSentences = new Set();
    const kept = [];

    for (const sentence of sentences) {
      const cleanSentence = normalizeText(sentence);
      if (cleanSentence.length >= 30 && seenSentences.has(cleanSentence)) continue;
      if (cleanSentence) seenSentences.add(cleanSentence);
      kept.push(sentence);
    }

    const rebuilt = kept.join(' ').replace(/\s+\n/g, '\n').trim();
    const cleanRebuilt = normalizeText(rebuilt);
    if (!rebuilt) continue;
    // Le paragraphe d'origine peut contenir une phrase dupliquée : c'est le
    // texte RECONSTRUIT qu'il faut comparer aux paragraphes déjà gardés.
    if (cleanRebuilt.length >= 40 && seenOutputs.has(cleanRebuilt)) continue;
    if (cleanRebuilt) seenOutputs.add(cleanRebuilt);
    output.push(rebuilt);
  }

  return output.join('\n\n').trim();
}

/**
 * Consigne de reformulation ajoutée au prompt lors d'une seconde tentative.
 * Les réponses précédentes sont tronquées : le but est d'indiquer l'angle à
 * éviter, pas de recopier tout l'historique.
 */
function buildRepetitionNudge(recentReplies = []) {
  const samples = [...recentReplies].slice(-2).map((reply) => `- « ${String(reply).slice(0, 220)} »`).join('\n');
  return [
    'TA RÉPONSE PRÉCÉDENTE ÉTAIT TROP PROCHE D’UNE RÉPONSE DÉJÀ DONNÉE.',
    samples ? `Réponses à ne pas répéter :\n${samples}` : '',
    'Reformule entièrement : autre angle, autre structure, autre formulation. Si le fond est le même, apporte un complément concret (exemple, étape, précision) au lieu de recopier. Ne t’excuse pas, réponds directement.',
  ].filter(Boolean).join('\n');
}

module.exports = {
  normalizeText,
  words,
  similarity,
  isRepetitive,
  dedupeSentences,
  buildRepetitionNudge,
};
