// utils/partnerEmbed.js — Logique PARTAGÉE entre /partenariat et
// /partenariat-config pour construire l'embed d'annonce. Avoir une seule
// source de vérité garantit que l'aperçu affiché lors de la configuration
// est TOUJOURS identique au message réellement envoyé — pas de divergence
// possible entre les deux commandes.
const { EmbedBuilder } = require('discord.js');

const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;
const URL_REGEX = /^https?:\/\/.+/i;

// Liste des variables disponibles, avec leur description — utilisée à la
// fois par /partenariat-config variables (documentation) et pour valider
// qu'aucune variable inconnue n'est utilisée par erreur.
const AVAILABLE_VARIABLES = {
  '{user}':     'Mention du membre crédité (ex : @Jean)',
  '{username}': "Nom d'affichage du membre crédité",
  '{count}':    'Nombre de partenariats effectués par ce membre',
  '{rang}':     'Classement de ce membre (1 = le plus de partenariats)',
  '{serveur}':  'Nom du serveur partenaire',
  '{invite}':   "Lien d'invitation du serveur partenaire (si fourni)",
  '{membres}':  'Nombre de membres de votre serveur',
  '{total}':    'Nombre total de partenariats effectués sur votre serveur',
  '{date}':     'Date du jour (ex : 15 juillet 2026)',
};

function formatDateFr(date = new Date()) {
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Remplace toutes les variables connues. Une variable non reconnue (faute
// de frappe de l'admin) reste visible telle quelle plutôt que d'échouer
// silencieusement — l'admin la remarquera immédiatement dans l'aperçu.
function applyPlaceholders(template, values) {
  let out = String(template || '');
  for (const [key, val] of Object.entries(values)) {
    out = out.split(key).join(val);
  }
  return out;
}

// Construit le dictionnaire de valeurs à partir de données réelles
// (aucune valeur inventée — {total}/{count}/{rang} viennent de MongoDB,
// {membres} vient du cache Discord.js du serveur).
function buildPartnerValues({ target, guild, serveurNom, inviteLink, count, rang, total }) {
  return {
    '{user}':     `<@${target.id}>`,
    '{username}': target.username,
    '{count}':    `${count}`,
    '{rang}':     `${rang}`,
    '{serveur}':  serveurNom || 'un serveur partenaire',
    '{invite}':   inviteLink || 'non spécifié',
    '{membres}':  `${guild.memberCount}`,
    '{total}':    `${total}`,
    '{date}':     formatDateFr(),
  };
}

// Construit l'embed final à partir de la config du serveur + des valeurs
// déjà calculées. Pure (ne touche pas à la base de données) : peut donc
// être utilisée aussi bien pour un aperçu que pour l'envoi réel.
//
// Le message personnalisé de l'admin (description) reste modifiable
// librement, mais les statistiques clés (partenaire, compteur, date) sont
// TOUJOURS affichées dans des champs Discord séparés — jamais fondues dans
// le texte — pour que le rendu final soit toujours propre et lisible,
// quel que soit le template écrit par l'admin.
function buildPartnerEmbed(server, values, target) {
  const color = HEX_REGEX.test(server.partnerColor) ? server.partnerColor : '#7c6cf0';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(applyPlaceholders(server.partnerTitle, values).slice(0, 256))
    .setDescription(applyPlaceholders(server.partnerMessage, values).slice(0, 4096))
    .setTimestamp();

  // Champ "Partenaire" — nom du serveur + lien cliquable si disponible.
  const partenaireValue = values['{invite}'] && values['{invite}'] !== 'non spécifié'
    ? `**${values['{serveur}']}**\n🔗 [Rejoindre](${values['{invite}']})`
    : `**${values['{serveur}']}**`;
  embed.addFields({ name: '🤝 Partenaire', value: partenaireValue, inline: true });

  // Champ "Statistiques" — compteur + classement, toujours lisible séparément
  // du message libre (jamais collé dans la même phrase).
  embed.addFields({ name: '📊 Statistiques', value: `**${values['{count}']}** partenariat(s)\n🏅 Rang #${values['{rang}']}`, inline: true });

  embed.addFields({ name: '📅 Date', value: values['{date}'], inline: true });

  if (server.partnerFooter) {
    embed.setFooter({ text: applyPlaceholders(server.partnerFooter, values).slice(0, 2048) });
  }

  if (server.partnerThumbnail !== 'none') {
    const isCustomUrl = server.partnerThumbnail && URL_REGEX.test(server.partnerThumbnail);
    embed.setThumbnail(isCustomUrl ? server.partnerThumbnail : target.displayAvatarURL({ dynamic: true, size: 256 }));
  }

  // Grande image/bannière — bien visible en bas de l'embed (setImage affiche
  // toujours l'image en pleine largeur, sous les champs, jamais "collée").
  if (server.partnerImage && URL_REGEX.test(server.partnerImage)) {
    embed.setImage(server.partnerImage);
  }

  return embed;
}

module.exports = {
  AVAILABLE_VARIABLES,
  HEX_REGEX,
  URL_REGEX,
  formatDateFr,
  applyPlaceholders,
  buildPartnerValues,
  buildPartnerEmbed,
};
