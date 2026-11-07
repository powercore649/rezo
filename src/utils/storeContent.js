'use strict';
// utils/storeContent.js — Texte du site, tenu à part du rendu.
//
// Le site décrit ce que le bot fait **réellement** : chaque module listé ici
// correspond à des commandes qui existent (voir /commandes, généré depuis
// `src/commands`). Aucun argument marketing ne doit survivre à la disparition
// de la fonctionnalité.

const MODULES = [
  {
    id: 'protection',
    emoji: '🛡️',
    title: 'Protection',
    text: 'Le raid est arrêté avant la première vague de dégâts.',
    points: [
      'Antiraid sur les arrivées, suppressions de salons et bans en série',
      'Antispam, antilink, anti-mentions et anti-webhooks',
      'Rideau d’urgence, quarantaine et contrôle des bots',
    ],
  },
  {
    id: 'moderation',
    emoji: '⚔️',
    title: 'Modération',
    text: 'Chaque sanction est tracée, expliquée et réversible.',
    points: [
      'Casier complet par membre, numéroté et horodaté',
      'Purge, slowmode, verrouillage, mute et vocal',
      'Tribunal du staff pour les décisions lourdes',
    ],
  },
  {
    id: 'tickets',
    emoji: '🎫',
    title: 'Tickets & support',
    text: 'Un accueil propre, sans salon oublié ni demande perdue.',
    points: [
      'Catégories illimitées avec rôle staff et journal dédiés',
      'Panels en boutons ou en menu, apparence réglable',
      'Transcriptions conservées et relance automatique',
    ],
  },
  {
    id: 'reseaux',
    emoji: '🌐',
    title: 'Réseau inter-serveurs',
    text: 'Ton serveur grandit avec les autres, pas contre eux.',
    points: [
      'Bump partagé, territoires et classements',
      'Pont de discussion entre serveurs partenaires',
      'Boost, invitations et partenariats suivis',
    ],
  },
  {
    id: 'configuration',
    emoji: '⚙️',
    title: 'Panneau unique',
    text: 'Tout se règle au bouton, sans retaper une commande.',
    points: [
      'Chaque module s’édite dans un panneau avec ses valeurs actuelles',
      'Apparence propre à ton serveur : nom, couleur, bannière',
      'Diagnostic de configuration et sauvegardes',
    ],
  },
  {
    id: 'niveaux',
    emoji: '🏆',
    title: 'Niveaux & profil',
    text: 'Des cartes générées à la volée, pas des images figées.',
    points: [
      'XP, rangs et cartes de montée de niveau',
      'Profil personnalisable avec badges vérifiés',
      'Classements et récompenses automatiques',
    ],
  },
  {
    id: 'audio',
    emoji: '🎵',
    title: 'Musique & radio',
    text: 'Une vraie file d’attente, une vraie interface.',
    points: [
      'Lecture, file, boucle et recherche',
      'Carte de lecture synchronisée avec le morceau',
      'Radios vérifiées avec titre en direct',
    ],
  },
  {
    id: 'economie',
    emoji: '💰',
    title: 'Économie & casino',
    text: 'Une monnaie qui sert vraiment à quelque chose.',
    points: [
      'Solde, boutique, récompenses quotidiennes',
      'Casino configurable avec limites et historique',
      'Transferts, classements et objets',
    ],
  },
  {
    id: 'ia',
    emoji: '✨',
    title: 'Assistant IA',
    text: 'Un copilote dans le serveur, pas un gadget.',
    points: [
      'Réponses contextuelles et résumés de salon',
      'Quotas par serveur et par membre',
      'Modèles interchangeables, clés côté serveur',
    ],
  },
];

const STEPS = [
  {
    step: '01',
    title: 'Choisis un palier',
    text: 'Essentiel, Standard ou Réseau : le palier décide des modules ouverts, l’offre décide de la durée. Une clé Réseau couvre trois serveurs d’un coup.',
  },
  {
    step: '02',
    title: 'Reçois ta clé',
    text: 'Le paiement se fait par carte sur une page Stripe. La clé apparaît immédiatement sur ta page de commande, au format REZO-XXXX-XXXX-XXXX-XXXX.',
  },
  {
    step: '03',
    title: 'Active-la sur Discord',
    text: 'Tape /license sur ton serveur, clique « Activer une clé » et colle la clé. Un palier supérieur ouvre tout ce que le précédent ouvrait.',
  },
];

const FAQ = [
  {
    q: 'Quelle est la différence entre les paliers ?',
    a: 'Le palier fixe ce que la clé ouvre, pas la durée. Essentiel couvre le socle communautaire (bump, animations, alertes). Standard ajoute la modération, les tickets, les niveaux et les invitations. Réseau ouvre en plus les modules lourds : identité visuelle, sauvegardes, IA, carte, anti-VPN et pont inter-serveurs. Un palier supérieur ouvre tout ce que le précédent ouvrait.',
  },
  {
    q: 'Une clé fonctionne sur combien de serveurs ?',
    a: 'Cela dépend du type de clé : Essentiel et Standard couvrent un serveur, Réseau en couvre trois. Une fois activée, la clé reste attachée à ses serveurs : elle ne peut pas être partagée dans cent communautés.',
  },
  {
    q: 'Que se passe-t-il à l’expiration ?',
    a: 'La licence passe au statut expiré : les systèmes sous licence se verrouillent, mais rien n’est supprimé. Ta configuration, tes données et tes historiques restent en place et tout se rallume avec une nouvelle clé. Une période de grâce de 3 à 7 jours selon l’offre laisse le temps de renouveler sans coupure immédiate.',
  },
  {
    q: 'Comment équiper un deuxième serveur ?',
    a: 'Avec une clé Réseau, active la même clé sur chacun des trois serveurs depuis /license. Avec une clé Essentiel ou Standard, il faut une clé par serveur. La page /verifier indique combien de sièges sont déjà utilisés.',
  },
  {
    q: 'Puis-je tester avant d’acheter ?',
    a: 'Oui. Depuis /license, le propriétaire du serveur peut démarrer un essai gratuit qui ouvre les mêmes fonctionnalités pendant la durée d’essai (palier Standard). Aucune carte n’est demandée.',
  },
  {
    q: 'Comment récupérer ma clé plus tard ?',
    a: 'Le lien de suivi de commande contient un jeton privé. Garde-le : il affiche la clé à tout moment. Le site n’a ni compte ni mot de passe, donc ce lien est la seule preuve d’achat.',
  },
  {
    q: 'Le paiement est-il sécurisé ?',
    a: 'Le paiement est traité par Stripe : les données de carte ne transitent jamais par ce site et n’y sont jamais stockées. Le site ne reçoit qu’une confirmation signée.',
  },
];

const GUARANTEES = [
  { emoji: '🔑', title: 'Clé livrée à l’instant', text: 'Générée dès la confirmation du paiement.' },
  { emoji: '🧾', title: 'Preuve d’achat à vie', text: 'Un lien de suivi privé, sans compte à créer.' },
  { emoji: '🌐', title: 'Jusqu’à trois serveurs', text: 'Une clé Réseau couvre tout ton réseau.' },
  { emoji: '🛡️', title: 'Grâce de 3 à 7 jours', text: 'Aucune coupure sèche à l’expiration.' },
  { emoji: '🔒', title: 'Sans renouvellement forcé', text: 'Aucun prélèvement récurrent.' },
  { emoji: '🛠️', title: 'Mises à jour incluses', text: 'Les nouveautés arrivent sur ta licence.' },
];

const SUPPORT_INVITE = 'https://discord.gg/S5M9SGTM5Q';

// ─── FAQ complète (page /faq) ────────────────────────────────────────────────
// Chaque réponse décrit le comportement réel du bot et du site. Une réponse
// qui ne serait plus vraie après un changement de code doit être corrigée ici :
// la page est indexée et sert de référence au support.
const FAQ_GROUPS = [
  {
    id: 'licence',
    title: 'Licence & activation',
    items: [
      {
        q: 'Où trouver ma clé après l’achat ?',
        a: 'La clé s’affiche immédiatement sur la page de suivi de commande, au format REZO-XXXX-XXXX-XXXX-XXXX. Si tu as laissé une adresse e-mail, elle part aussi par e-mail. Le lien de suivi est privé : garde-le, il reste la seule preuve d’achat (le site n’a ni compte ni mot de passe).',
      },
      {
        q: 'Comment activer une clé ?',
        a: 'Sur ton serveur, tape /license puis clique sur « Activer une clé » et colle la clé. Le palier s’affiche aussitôt. Sur une offre multi-serveurs, répète l’opération sur chaque serveur couvert : la même clé réclame un siège libre à chaque activation.',
      },
      {
        q: 'Combien de serveurs une clé couvre-t-elle ?',
        a: 'Cela dépend de l’offre : un serveur pour Essentiel et Standard, trois pour Réseau. Les packs Réseau, Intégral et REZO.net montent respectivement à 5, 10 et 25 sièges. La page /verifier indique combien de sièges sont déjà utilisés.',
      },
      {
        q: 'Que se passe-t-il à l’expiration ?',
        a: 'La licence passe en expiré : les modules sous licence se verrouillent, mais rien n’est supprimé. Configuration, données et historiques restent en place et tout se rallume avec une nouvelle clé. Une période de grâce de quelques jours (3 à 7 selon l’offre) laisse le temps de renouveler sans coupure sèche.',
      },
      {
        q: 'Puis-je déplacer une clé vers un autre serveur ?',
        a: 'Oui, tant qu’un siège est libre. Active la clé sur le nouveau serveur : elle y prend un siège. Une clé déjà utilisée sur tous ses sièges ne peut pas en ouvrir un de plus — c’est ce qui empêche son partage à grande échelle.',
      },
      {
        q: 'Existe-t-il un essai gratuit ?',
        a: 'Oui. Depuis /license, le propriétaire du serveur peut lancer un essai qui ouvre les fonctionnalités du palier Standard pendant la durée d’essai, sans carte bancaire.',
      },
    ],
  },
  {
    id: 'paiement',
    title: 'Paiement & commande',
    items: [
      {
        q: 'Le paiement est-il sécurisé ?',
        a: 'Le paiement est traité par Stripe : les données de carte ne passent jamais par ce site et n’y sont jamais stockées. Le site ne reçoit qu’une confirmation signée. Si Stripe n’est pas configuré sur cette instance, la commande reste en attente et le propriétaire la valide manuellement.',
      },
      {
        q: 'J’ai fermé la page après le paiement, comment récupérer ma clé ?',
        a: 'Rouvre le lien de suivi reçu après l’achat (/commande/…). Il affiche l’état de la commande et la clé dès qu’elle est émise. Sans ce lien, contacte le support avec ton adresse e-mail et la date d’achat.',
      },
      {
        q: 'Ma commande reste « en attente », que faire ?',
        a: 'Un paiement par carte peut mettre quelques secondes à être confirmé. Recharge la page de suivi : la confirmation est alors demandée directement à Stripe. Si elle reste en attente après plusieurs minutes, le paiement n’a probablement pas abouti — aucune somme n’est prélevée dans ce cas, et tu peux recommencer.',
      },
      {
        q: 'Puis-je être remboursé ?',
        a: 'Le site ne prévoit pas de remboursement automatique : la clé est délivrée immédiatement après le paiement. Si un problème technique empêche l’activation, écris au support avec la référence de commande : c’est le seul canal pour étudier la situation.',
      },
    ],
  },
  {
    id: 'packs',
    title: 'Packs & devis',
    items: [
      {
        q: 'Un pack remplace-t-il une licence ?',
        a: 'Oui. Un pack contient une licence complète (palier, durée, sièges) plus des modules que le palier seul n’ouvre pas et des prestations humaines. La clé obtenue s’active exactement comme une autre avec /license.',
      },
      {
        q: 'Les prestations sont-elles automatiques ?',
        a: 'Non. La clé, elle, est immédiate. L’installation accompagnée, les visuels, la migration et le support prioritaire se font avec toi après l’achat, via le serveur de support.',
      },
      {
        q: 'Comment fonctionne le Pack REZO.net ?',
        a: 'Il n’a pas de prix fixe et ne s’achète pas en ligne. Tu remplis le formulaire /devis : la demande arrive en message privé au propriétaire, qui l’examine et répond. Une fois le devis accepté, la clé part directement dans tes MP Discord. Aucune clé n’existe avant cet accord.',
      },
      {
        q: 'J’ai déjà une licence, puis-je prendre un pack ?',
        a: 'Oui, mais la nouvelle clé remplace la licence en cours sur le serveur : elle n’ajoute pas de durée à l’ancienne. Le plus simple est d’attendre la fin de la licence actuelle, ou de contacter le support pour organiser la transition.',
      },
    ],
  },
  {
    id: 'support',
    title: 'Compte, sécurité & support',
    items: [
      {
        q: 'Le staff peut-il me demander ma clé ?',
        a: 'Jamais. Personne dans l’équipe n’a besoin de ta clé : elle sert uniquement à /license sur ton serveur. Toute demande de clé, de mot de passe ou de code est une tentative d’arnaque — signale-la sur le serveur de support.',
      },
      {
        q: 'La page de vérification révèle-t-elle mes serveurs ?',
        a: 'Non. /verifier affiche l’état de la clé, le palier, le nombre de sièges utilisés et la date d’expiration — jamais l’identité ou le nom des serveurs qui l’utilisent.',
      },
      {
        q: 'Un module reste verrouillé alors que ma licence est active.',
        a: 'Vérifie trois choses : la clé est activée sur ce serveur précis (pas un autre), la licence n’est pas expirée (voir /verifier), et le palier ouvre bien ce module. Le panneau /license rappelle le palier en cours et ce qu’il ouvre.',
      },
      {
        q: 'Comment signaler un bug ou proposer une idée ?',
        a: 'Passe par le serveur de support : un salon dédié permet de décrire le problème avec la commande concernée et, si possible, la capture du message d’erreur. Les rapports sont traités dans l’ordre d’arrivée.',
      },
    ],
  },
];

// ─── Guide d’activation (page /guide) ────────────────────────────────────────
const GUIDE_STEPS = [
  {
    step: '01',
    title: 'Vérifie que le bot est sur le serveur',
    text: 'La commande /license doit répondre. Si elle n’apparaît pas, le bot n’est pas invité sur ce serveur : ajoute-le depuis le serveur de support.',
  },
  {
    step: '02',
    title: 'Ouvre /license',
    text: 'Tape /license dans n’importe quel salon. Le panneau affiche le palier en cours, la durée restante et les modules ouverts.',
  },
  {
    step: '03',
    title: 'Clique sur « Activer une clé »',
    text: 'Un formulaire s’ouvre. Colle la clé au format REZO-XXXX-XXXX-XXXX-XXXX, en majuscules et avec les tirets.',
  },
  {
    step: '04',
    title: 'Répète sur chaque serveur couvert',
    text: 'Une clé Réseau (3 serveurs) ou un pack multi-serveurs réclame un siège libre à chaque activation. Sur un pack, vérifie le nombre de sièges indiqué sur la page de la commande.',
  },
];

const GUIDE_TROUBLES = [
  {
    q: '« Format de clé invalide »',
    a: 'La clé contient quatre groupes de quatre caractères. Les lettres O et I et les chiffres 0 et 1 n’existent pas dans les clés : ils ont été retirés pour éviter les confusions. Vérifie aussi que les tirets sont bien présents.',
  },
  {
    q: '« Tous les sièges sont déjà utilisés »',
    a: 'La clé a atteint son nombre de serveurs. Vérifie les sièges sur /verifier. Pour un réseau plus large, il faut une clé supplémentaire ou un pack multi-serveurs.',
  },
  {
    q: '« Licence expirée » alors que je viens de renouveler',
    a: 'Active la nouvelle clé avec /license sur le serveur concerné : une clé non activée n’ouvre rien, même si elle est valide. Le statut affiché par /verifier reste « disponible » tant qu’aucun serveur ne l’a réclamée.',
  },
  {
    q: 'La clé est active mais un module reste fermé',
    a: 'Le module appartient peut-être à un palier supérieur. /license liste ce que le palier ouvre réellement. Si le module devrait être inclus, ouvre un ticket sur le serveur de support avec la clé masquée et le nom du module.',
  },
  {
    q: 'Je ne retrouve plus ma commande',
    a: 'Le lien de suivi est la seule preuve d’achat : il contient un jeton privé. Sans lui, le support peut retrouver une commande à partir de l’adresse e-mail utilisée au paiement.',
  },
];

// ─── Journal des nouveautés (page /nouveautes) ───────────────────────────────
// Trié du plus récent au plus ancien. Chaque entrée décrit une fonctionnalité
// réellement livrée, pas une annonce.
const CHANGELOG = [
  {
    date: '2026-11-06',
    title: 'Code source public',
    points: [
      'Le dépôt passe en open source : licence, guide de contribution et intégration continue',
      'Installation documentée de bout en bout : base, site et bot sur une machine neuve',
      'Aucune bêta séparée : une seule version, celle du dépôt',
    ],
  },
  {
    date: '2026-11-05',
    title: 'FAQ, guide d’activation et journal',
    points: [
      'Nouvelle page /faq avec recherche instantanée, sans script externe',
      'Guide /guide : activation pas à pas et pannes courantes',
      'API publique /api/faq et /api/packs pour les outils tiers',
    ],
  },
  {
    date: '2026-11-05',
    title: 'Portail d’accès v2',
    points: [
      'Quatre types d’étapes : texte, boutons, menu de rôles et acceptation du règlement',
      'Mode salon privé ou salon partagé, MP d’accueil avec le lien du portail',
      'Relance unique, journal des passages et validation manuelle par le staff',
    ],
  },
  {
    date: '2026-11-05',
    title: 'Devis Pack REZO.net en message privé',
    points: [
      'Formulaire /devis complet, avec identifiant Discord obligatoire',
      'La demande arrive en MP au propriétaire, qui approuve ou refuse en un clic',
      'La clé part ensuite dans les MP de l’acheteur, jamais avant l’accord',
    ],
  },
  {
    date: '2026-11-05',
    title: 'Packs tout compris',
    points: [
      'Sept packs : licence, durée, modules en plus et prestations',
      'Page /packs séparée des paliers, pour ne pas mélanger les deux',
      'Pack REZO.net sur devis, jusqu’à 25 serveurs',
    ],
  },
];

module.exports = {
  MODULES, STEPS, FAQ, GUARANTEES, SUPPORT_INVITE,
  FAQ_GROUPS, GUIDE_STEPS, GUIDE_TROUBLES, CHANGELOG,
};
