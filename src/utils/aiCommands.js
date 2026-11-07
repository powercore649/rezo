'use strict';
// utils/aiCommands.js — Catalogue RÉEL des commandes du bot, pour l'IA.
//
// L'IA ne doit jamais inventer une commande. Ce module lit `client.commands`
// (la Collection Discord.js réellement chargée) et produit :
//   • une liste compacte de TOUTES les commandes ;
//   • le détail (sous-commandes + options) des commandes pertinentes pour la
//     question posée.
//
// Le catalogue est généré à chaque réponse depuis le registre vivant : une
// commande renommée, supprimée ou ajoutée est immédiatement reflétée. Aucune
// liste codée en dur ne peut donc diverger du bot.

const CACHE = new WeakMap();
const MAX_DETAILED = 5;
const MAX_SUBCOMMANDS = 10;
// Index complet (nom + description courte) + détail des commandes utiles :
// ~8 000 caractères pour 97 commandes, soit ~2 000 tokens. C'est le prix d'une
// réponse exacte : sans les descriptions, le modèle devine d'après un nom.
const MAX_BLOCK_CHARS = 16000;

// Mots trop courants pour guider la recherche de commandes.
const STOPWORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux', 'et', 'ou',
  'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles', 'mon', 'ton',
  'comment', 'quoi', 'que', 'qui', 'quel', 'quelle', 'quels', 'quelles',
  'pour', 'avec', 'dans', 'sur', 'sous', 'est', 'sont', 'peux', 'peut',
  'faire', 'fait', 'bot', 'rezo', 'discord', 'commande', 'commandes', 'aide',
  'svp', 'stp', 'merci', 'bonjour', 'salut', 'moi', 'toi', 'ce', 'cette',
  // Verbes et déterminants trop génériques : « voir mes invitations » doit
  // chercher les invitations, pas toutes les commandes qui affichent quelque
  // chose. Sans ça, « mes » matchait « freegaMES » par simple sous-chaîne.
  'mes', 'ma', 'voir', 'affiche', 'afficher', 'montre', 'montrer', 'donne',
  'tu', 'il', 'elle', 'on', 'sa', 'se', 'te', 'me', 'en', 'y', 'a', 'as', 'ai',
  'donner', 'liste', 'lister', 'obtenir', 'trouver', 'utiliser', 'utilise',
  'savoir', 'explique', 'expliquer', 'dis', 'dire', 'veux', 'vouloir',
  'peux-tu', 'comment-faire', 'config', 'configurer', 'parametre', 'parametres',
]);

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9/\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  // Deux lettres suffisent pour « xp » ou « ia » ; les mots vides sont filtrés
  // par la liste, pas par leur longueur.
  return normalize(text).split(/[\s/]+/).filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * Racine grossière mais stable : « invitations », « inviteur » et « invites »
 * partagent les cinq premières lettres. Évite de dépendre d'un dictionnaire.
 */
function stem(word) {
  const value = String(word || '');
  return value.length > 5 ? value.slice(0, 5) : value;
}

/** Égalité stricte ou racine commune, jamais une sous-chaîne arbitraire. */
function wordMatches(part, word) {
  const a = String(part || '');
  const b = String(word || '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (stem(a) === stem(b)) return true;
  // « bump » / « bumper », « invite » / « invitations » : un radical reste un
  // radical. La longueur minimale évite que « mes » attrape « messages ».
  return a.startsWith(b) || b.startsWith(a);
}

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function optionNames(options = []) {
  return (options || [])
    .filter((option) => option && option.name && !option.options)
    .map((option) => option.name)
    .slice(0, 8);
}

function entryFromModule(command) {
  const data = command?.data?.toJSON ? command.data.toJSON() : command?.data;
  if (!data?.name) return null;

  const options = Array.isArray(data.options) ? data.options : [];
  const subcommands = options
    .filter((option) => option.type === 1)
    .map((option) => ({
      name: option.name,
      description: truncate(option.description, 110),
      options: optionNames(option.options),
    }));

  return {
    name: data.name,
    description: truncate(data.description, 140),
    subcommands,
    options: optionNames(options.filter((option) => option.type !== 1 && option.type !== 2)),
  };
}

/** Catalogue trié des commandes réellement chargées. */
function commandEntries(client) {
  const commands = client?.commands;
  if (!commands || typeof commands.values !== 'function') return [];

  const signature = `${commands.size}:${[...commands.keys()].sort().join(',')}`;
  const cached = CACHE.get(client);
  if (cached?.signature === signature) return cached.entries;

  const entries = [...commands.values()]
    .map(entryFromModule)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  CACHE.set(client, { signature, entries });
  return entries;
}

/** Score une commande par rapport aux mots de la question. */
function scoreEntry(entry, message, words) {
  const messageNorm = normalize(message);
  const nameParts = entry.name.split('-').filter(Boolean);
  const descriptionWords = normalize(entry.description).split(/\s+/).filter(Boolean);
  const subNames = entry.subcommands.flatMap((s) => normalize(s.name).split(/\s+/));
  const subDescriptions = entry.subcommands.flatMap((s) => normalize(s.description).split(/\s+/));
  let score = 0;

  // Mention explicite « /nom » — la preuve la plus forte.
  if (new RegExp(`/${entry.name}(?:\\s|$)`).test(messageNorm)) score += 14;
  else if (new RegExp(`(?:^|\\s)${entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(messageNorm)) score += 8;

  for (const word of words) {
    if (nameParts.some((part) => part === word)) score += 6;
    else if (nameParts.some((part) => wordMatches(part, word))) score += 4;

    if (descriptionWords.some((part) => wordMatches(part, word))) score += 2;
    if (subNames.some((part) => wordMatches(part, word))) score += 3;
    else if (subDescriptions.some((part) => wordMatches(part, word))) score += 1;
  }
  return score;
}

/**
 * Commandes les plus pertinentes pour un message.
 * @returns {Array<object>} entrées triées par score décroissant
 */
function findRelevantCommands(entries, message, limit = MAX_DETAILED) {
  const words = tokens(message);
  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(entry, message, words) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  return scored.slice(0, limit).map((row) => row.entry);
}

function describeCommand(entry) {
  const lines = [`/${entry.name} — ${entry.description || '*sans description*'}`];
  for (const sub of entry.subcommands.slice(0, MAX_SUBCOMMANDS)) {
    const args = sub.options.length ? ` [${sub.options.join(', ')}]` : '';
    lines.push(`  · ${sub.name}${args} — ${sub.description || ''}`.trimEnd());
  }
  if (entry.options.length && !entry.subcommands.length) {
    lines.push(`  · options : ${entry.options.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Bloc de prompt décrivant le catalogue réel.
 * Toujours borné : le modèle reçoit tous les NOMS, et le détail des commandes
 * utiles à la question, jamais 97 descriptions complètes.
 */
function buildCommandsBlock(client, message = '') {
  const entries = commandEntries(client);
  if (!entries.length) {
    return [
      'CATALOGUE DES COMMANDES : indisponible pour le moment.',
      'Ne cite aucune commande précise : invite la personne à utiliser /help.',
    ].join('\n');
  }

  const index = entries
    .map((entry) => `/${entry.name} — ${truncate(entry.description.replace(/^[^\p{L}\p{N}]+/u, ''), 90) || 'sans description'}`)
    .join('\n');
  const relevant = findRelevantCommands(entries, message);

  const parts = [
    'CATALOGUE RÉEL DES COMMANDES DU BOT (généré à l’instant depuis le bot en fonctionnement) :',
    `Commandes disponibles (${entries.length}) — choisis celle dont la description correspond le mieux :`,
    index,
  ];

  if (relevant.length) {
    parts.push('Détail des commandes pertinentes pour ce message :');
    for (const entry of relevant) parts.push(describeCommand(entry));
  }

  parts.push(
    'RÈGLES DE PRÉCISION (obligatoires) :',
    '- Tu ne cites QUE des commandes présentes dans ce catalogue, avec leur orthographe exacte.',
    '- Pour choisir, appuie-toi sur la description de chaque commande, pas seulement sur son nom.',
    '- Tu n’inventes jamais de commande, de sous-commande, d’option ni de fonctionnalité.',
    '- Si aucune commande du catalogue ne répond à la question, dis-le clairement et propose /help.',
    '- Quand tu donnes une commande, donne sa forme exacte (ex: `/invites voir membre:@Alice`).',
  );

  let block = parts.join('\n');
  if (block.length > MAX_BLOCK_CHARS) {
    // Filet de sécurité : la liste des noms reste, le détail est coupé proprement.
    block = `${block.slice(0, MAX_BLOCK_CHARS - 1)}…`;
  }
  return block;
}

/**
 * Filet de sécurité : une commande inexistante citée par le modèle est
 * remplacée par /help. Le prompt interdit déjà l'invention ; ceci garantit
 * qu'elle ne peut pas atteindre Discord même si le modèle désobéit.
 *
 * Seuls les « /mot » isolés sont examinés : les chemins de fichiers, les URL et
 * les fractions ne sont pas touchés.
 */
function sanitizeCommandMentions(text, entries) {
  const source = String(text || '');
  if (!source) return { text: source, replaced: [] };

  const known = new Set((entries || []).map((entry) => entry.name));
  if (!known.size) return { text: source, replaced: [] };

  const replaced = [];
  const cleaned = source.replace(/(^|[\s`(\["'])\/([a-z][a-z0-9-]{1,31})\b/gi, (match, prefix, name) => {
    const normalized = String(name).toLowerCase();
    if (known.has(normalized)) return match;
    replaced.push(normalized);
    return `${prefix}/help`;
  });

  return { text: cleaned, replaced };
}

module.exports = {
  normalize,
  tokens,
  commandEntries,
  findRelevantCommands,
  describeCommand,
  buildCommandsBlock,
  sanitizeCommandMentions,
  MAX_DETAILED,
};
