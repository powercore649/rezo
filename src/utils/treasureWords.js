// utils/treasureWords.js — Banque de mots et indices des Trésors cachés.
//
// Chaque entrée : un mot à deviner + des indices. L'admin peut ajouter ses
// propres mots (/tresor → 🧩 Mots & indices) : ils s'ajoutent à cette banque et
// remplacent une entrée par défaut du même mot.
//
// Un mot personnalisé qui n'a pas assez d'indices reste jouable : les indices
// manquants sont générés (nombre de lettres, première lettre…), sinon la rareté
// annoncerait plus d'indices que la banque n'en contient.
const RARITY_ORDER = ['common', 'rare', 'legendary'];

const RARITY_LABEL = { common: 'Commune', rare: 'Rare', legendary: 'Légendaire' };
const RARITY_EMOJI = { common: '🥉', rare: '🥈', legendary: '🏆' };
const RARITY_COLOR = { common: '#57F287', rare: '#5865F2', legendary: '#FEE75C' };

// Nombre d'indices dévoilés selon la rareté (le premier tombe à l'apparition)
const CLUES_BY_RARITY = { common: 2, rare: 3, legendary: 4 };

// Multiplicateurs de récompense selon la rareté
const RARITY_REWARD = { common: 1, rare: 2, legendary: 4 };

const DEFAULT_WORDS = Object.freeze([
  // ── Communes ──
  { word: 'bump', rarity: 'common', clues: [
    'Cela fait remonter un serveur dans la liste',
    'On retape la commande toutes les deux heures',
    'Quatre lettres, commence par B',
  ] },
  { word: 'salon', rarity: 'common', clues: [
    'On y discute, on y joue',
    'Son nom est souvent précédé d\'un #',
    'Cinq lettres, commence par S',
  ] },
  { word: 'emoji', rarity: 'common', clues: [
    'On le glisse dans un message pour réagir',
    'Il en existe des milliers',
    'Cinq lettres, commence par E',
  ] },
  { word: 'niveau', rarity: 'common', clues: [
    'Il monte quand on écrit beaucoup',
    'Le bot annonce son changement',
    'Six lettres, commence par N',
  ] },
  { word: 'membres', rarity: 'common', clues: [
    'Ils peuplent le serveur',
    'Leur nombre s\'affiche souvent à l\'entrée',
    'Sept lettres, commence par M',
  ] },

  // ── Rares ──
  { word: 'captcha', rarity: 'rare', clues: [
    'Il prouve qu\'on n\'est pas un robot',
    'Les nouveaux le croisent en arrivant',
    'Il se résout avec une image déformée',
    'Sept lettres, commence par C',
  ] },
  { word: 'antiraid', rarity: 'rare', clues: [
    'Il protège le serveur d\'une vague d\'arrivées',
    'Il agit en quelques secondes',
    'Il peut verrouiller les portes du serveur',
    'Huit lettres, se termine par D',
  ] },
  { word: 'invitation', rarity: 'rare', clues: [
    'Elle ouvre la porte du serveur',
    'Elle peut expirer ou être révoquée',
    'On la partage pour ramener des amis',
    'Dix lettres, commence par I',
  ] },
  { word: 'giveaway', rarity: 'rare', clues: [
    'Un tirage au sort avec des lots',
    'Il faut réagir pour participer',
    'Il a une date de fin',
    'Huit lettres, commence par G',
  ] },
  { word: 'tresor', rarity: 'rare', clues: [
    'Un coffre rempli de pièces',
    'Il se cache au bout d\'une chasse',
    'On le cherche en équipe',
    'Six lettres, commence par T',
  ] },
  { word: 'reglement', rarity: 'rare', clues: [
    'Il se lit en arrivant sur un serveur',
    'Il liste ce qui est interdit',
    'Le modérer, c\'est le travail de la modération',
    'Neuf lettres, commence par R',
  ] },

  // ── Légendaires ──
  { word: 'constellation', rarity: 'legendary', clues: [
    'Un dessin d\'étoiles dans le ciel',
    'Il en existe 88 officielles',
    'Un grand ours en porte le nom',
    'Treize lettres, commence par C',
  ] },
  { word: 'labyrinthe', rarity: 'legendary', clues: [
    'On s\'y perd volontiers',
    'Un fil célèbre y servait de GPS',
    'Un minotaure y habitait',
    'Dix lettres, commence par L',
  ] },
  { word: 'phenix', rarity: 'legendary', clues: [
    'Il renaît de ses cendres',
    'Oiseau des légendes',
    'Il est rouge et or',
    'Six lettres, sans son accent',
  ] },
  { word: 'telescope', rarity: 'legendary', clues: [
    'Il rapproche les étoiles',
    'On l\'installe loin des lumières de la ville',
    'Galilée s\'en est servi',
    'Neuf lettres, commence par T',
  ] },
  { word: 'bibliotheque', rarity: 'legendary', clues: [
    'Un endroit rempli d\'histoires',
    'On y parle très bas',
    'Son nom vient du grec ancien',
    'Douze lettres, commence par B',
  ] },
]);

/** Normalise une saisie : minuscules, sans accents, sans ponctuation. */
function normalizeGuess(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** La proposition correspond-elle exactement au mot du coffre ? */
function isCorrectGuess(word, guess) {
  const target = normalizeGuess(word);
  return target.length > 0 && normalizeGuess(guess) === target;
}

/** Indice générique, calculé depuis le mot (`kind` : length | first | vowel). */
function generateClue(word, kind) {
  const letters = normalizeGuess(word).replace(/ /g, '');
  const upper = word.toUpperCase();
  if (kind === 'first') return `Il commence par « ${upper.charAt(0)} »`;
  if (kind === 'last') return `Il se termine par « ${upper.charAt(upper.length - 1)} »`;
  if (kind === 'vowel') {
    const vowels = [...new Set(letters.split('').filter(c => 'aeiouy'.includes(c)))];
    return vowels.length ? `Ses voyelles : ${vowels.join(', ').toUpperCase()}` : 'Il ne contient pas de voyelle';
  }
  if (kind === 'consonant') {
    const consonants = [...new Set(letters.split('').filter(c => /[a-z]/.test(c) && !'aeiouy'.includes(c)))];
    return consonants.length ? `Ses consonnes : ${consonants.join(', ').toUpperCase()}` : 'Il n\'a que des voyelles';
  }
  return `Il compte ${letters.length} lettre${letters.length > 1 ? 's' : ''}`;
}

// Assez de formes différentes pour couvrir la rareté la plus bavarde (4 indices)
const FALLBACK_KINDS = ['length', 'first', 'vowel', 'last', 'consonant'];

/** Indices d'une entrée, complétés pour atteindre le nombre attendu. */
function cluesForWord(entry, rarity = entry?.rarity || 'common') {
  const wanted = CLUES_BY_RARITY[rarity] || CLUES_BY_RARITY.common;
  const clues = Array.isArray(entry?.clues) ? entry.clues.map(c => String(c).trim()).filter(Boolean) : [];
  let i = 0;
  while (clues.length < wanted && i < FALLBACK_KINDS.length * 2) {
    const clue = generateClue(entry?.word || '', FALLBACK_KINDS[i % FALLBACK_KINDS.length]);
    if (!clues.includes(clue)) clues.push(clue);
    i++;
  }
  return clues.slice(0, wanted);
}

/** Banque effective : défauts + mots personnalisés (qui remplacent un doublon). */
function wordsFor(cfg = null) {
  const custom = (cfg && cfg.customWords ? [...cfg.customWords] : [])
    .map(w => ({
      word: String(w.word || '').trim(),
      rarity: RARITY_ORDER.includes(w.rarity) ? w.rarity : 'common',
      clues: Array.isArray(w.clues) ? w.clues.map(c => String(c).trim()).filter(Boolean) : [],
      custom: true,
    }))
    .filter(w => w.word.length >= 2 && normalizeGuess(w.word).length >= 2);

  const byWord = new Map(custom.map(w => [normalizeGuess(w.word), w]));
  const merged = [...DEFAULT_WORDS.map(w => ({ ...w, clues: [...w.clues], custom: false }))]
    .map(w => byWord.get(normalizeGuess(w.word)) || w);

  for (const w of custom) {
    if (!DEFAULT_WORDS.some(d => normalizeGuess(d.word) === normalizeGuess(w.word))) merged.push(w);
  }
  return merged;
}

/** Entrée correspondant à un mot (pour retrouver la rareté/classe d'origine). */
function findWordEntry(words, word) {
  const key = normalizeGuess(word);
  return words.find(w => normalizeGuess(w.word) === key) || null;
}

/** Mot masqué : « B U _ _ » selon le nombre de lettres déjà dévoilées. */
function maskedWord(word, lettersShown = 0) {
  const shown = Math.max(0, Math.floor(Number(lettersShown) || 0));
  return String(word ?? '').trim()
    .split('')
    .map((c, i) => (c === ' ' ? ' ' : (i < shown ? c.toUpperCase() : '_')))
    .join(' ');
}

/** Découpe une saisie de modal « mot | indice 1 ; indice 2 ». */
function parseCustomWord(raw) {
  const [wordPart, ...clueParts] = String(raw ?? '').split('|');
  const word = String(wordPart ?? '').trim();
  const clues = clueParts
    .join('|')
    .split(';')
    .map(c => c.trim())
    .filter(Boolean)
    .slice(0, 4);
  return { word, clues };
}

module.exports = {
  RARITY_ORDER, RARITY_LABEL, RARITY_EMOJI, RARITY_COLOR, CLUES_BY_RARITY, RARITY_REWARD,
  DEFAULT_WORDS, FALLBACK_KINDS,
  normalizeGuess, isCorrectGuess, generateClue, cluesForWord, wordsFor, findWordEntry,
  maskedWord, parseCustomWord,
};
