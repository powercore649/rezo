'use strict';
// commands/scam.js — Formulaire PUBLIC de signalement de scam.
//
// Tout membre peut signaler une arnaque (phishing, faux Nitro, usurpation…)
// via un formulaire en 3 étapes. Le staff du serveur valide ensuite la carte
// (salon de review configuré dans /antiscam), puis l'alerte est diffusée à
// tous les serveurs abonnés au réseau d'alertes scams REZO.
//
// Flux : /scam → modal étape 1 (cible) → bouton suite → modal étape 2 (preuve)
//        → carte "pending" (validation staff) → diffusion réseau.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');
const ScamAlertConfig = require('../../models/ScamAlertConfig');
const { ScamAlert } = require('../../models/ScamAlert');
const {
  TYPE_INFO, typeLabel, buildAlertEmbed, submitReport,
} = require('../../utils/scamAlertActions');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ═══ Coffre-fort de données entre les 2 étapes du formulaire ═════════════════
// (les modals Discord ne peuvent pas être chaînés directement — on stocke les
// données de l'étape 1 en mémoire quelques minutes, cléée par userId).
const pendingForms = new Map();
/** @private */ function _clearPendingFormsForTests() { pendingForms.clear(); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingForms) if (now - v.at > 15 * 60 * 1000) pendingForms.delete(k);
}, 5 * 60 * 1000).unref?.();

// ─── Étape 1 : la cible ──────────────────────────────────────────────────────
async function openStep1(interaction) {
  // Pré-sélection du type si fourni en option
  const presetType = interaction.options?.getString('type') || '';

  const modal = new ModalBuilder()
    .setCustomId('scamf_step1')
    .setTitle('Signaler un scam • 1/2 — Cible');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('scam_type')
        .setLabel('Type d\'arnaque')
        .setPlaceholder(`Ex : ${Object.keys(TYPE_INFO).slice(0, 3).map(t => TYPE_INFO[t].label).join(', ')}`)
        .setValue(presetType ? typeLabel(presetType) : '')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('scam_name')
        .setLabel('Pseudo / identité de l\'arnaqueur')
        .setPlaceholder('Pseudo exact (+ #1234 ou ID si connu)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('scam_guild')
        .setLabel('Serveur où opère-t-il ? (optionnel)')
        .setPlaceholder('Nom du serveur Discord (si connu)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(false),
    ),
  );

  // On stocke le type demandé pour le retrouver au traitement
  pendingForms.set(interaction.user.id, { at: Date.now(), presetType, guildId: interaction.guildId });

  return interaction.showModal(modal);
}

// ─── Traitement étape 1 → ouverture étape 2 ──────────────────────────────────
async function handleStep1(interaction) {
  const session = pendingForms.get(interaction.user.id);
  pendingForms.delete(interaction.user.id);

  const typeRaw = interaction.fields.getTextInputValue('scam_type').trim();
  const name = interaction.fields.getTextInputValue('scam_name').trim().slice(0, 100);
  const guildName = interaction.fields.getTextInputValue('scam_guild').trim().slice(0, 100);

  // Résolution souple du type : l'utilisateur peut taper "phishing", "nitro"…
  const norm = typeRaw.toLowerCase();
  let type = Object.keys(TYPE_INFO).find(k =>
    norm.includes(k) || TYPE_INFO[k].label.toLowerCase().includes(norm),
  );
  if (!type) {
    type = norm.includes('arnaq') || norm.includes('scam') ? 'other' : 'other';
  }

  pendingForms.set(interaction.user.id, {
    at: Date.now(), guildId: interaction.guildId, type, name, guildName,
  });

  // Le modal doit être suivi d'une réponse immédiate — on édite et on demande l'étape 2
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('📝 Étape 2/2 — Preuve & détails')
    .setDescription(
      `**Cible :** ${name}\n**Type :** ${typeLabel(type)}\n\n` +
      'Clique sur **« Ajouter la preuve »** pour terminer le signalement.\n' +
      'Une capture d\'écran (lien direct) ou un lien vers la conversation est fortement recommandé — sans preuve, le staff risque de rejeter le dossier.',
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('scamf_step2').setLabel('Ajouter la preuve').setStyle(ButtonStyle.Primary).setEmoji('📎'),
    new ButtonBuilder().setCustomId('scamf_cancel').setLabel('Annuler').setStyle(ButtonStyle.Secondary).setEmoji('🗑️'),
  );

  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ─── Étape 2 : preuve + détails ──────────────────────────────────────────────
async function openStep2(interaction) {
  const session = pendingForms.get(interaction.user.id);
  // Session valide uniquement si l'étape 1 a été complétée (type + nom présents) —
  // protège contre les vieux boutons « Ajouter la preuve » de cartes précédentes.
  if (!session || !session.type || !session.name) {
    return interaction.reply({
      embeds: [errorEmbed('Session expirée', 'Ton signalement a expiré (15 min). Relance `/scam` pour recommencer.')],
      ephemeral: true,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId('scamf_step2_submit')
    .setTitle('Signaler un scam • 2/2 — Preuve');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('scam_evidence')
        .setLabel('Lien de preuve (capture, conversation…)')
        .setPlaceholder('https://… (image, message Discord, etc.)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(500)
        .setRequired(false),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('scam_details')
        .setLabel('Décris ce qui s\'est passé')
        .setPlaceholder('Comment l\'arnaque s\'est déroulée, ce qui a été promis…')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true),
    ),
  );

  return interaction.showModal(modal);
}

// ─── Soumission finale ───────────────────────────────────────────────────────
async function handleStep2(interaction, client) {
  const session = pendingForms.get(interaction.user.id);
  pendingForms.delete(interaction.user.id);

  if (!session || session.guildId !== interaction.guildId) {
    return interaction.reply({
      embeds: [errorEmbed('Session expirée', 'Ton signalement a expiré. Relance `/scam`.')],
      ephemeral: true,
    });
  }

  const evidenceUrl = interaction.fields.getTextInputValue('scam_evidence').trim().slice(0, 500) || null;
  const details = interaction.fields.getTextInputValue('scam_details').trim().slice(0, 1000);

  const result = await submitReport(interaction, {
    type: session.type,
    name: session.name,
    guildName: session.guildName,
    evidenceUrl,
    details,
  });

  if (!result.ok) {
    const messages = {
      disabled:   errorEmbed('Signalements désactivés', 'Le staff de ce serveur a désactivé les signalements de scam.'),
      blacklisted:errorEmbed('Accès refusé', 'Tu n\'es plus autorisé à soumettre des signalements sur ce serveur.'),
      cooldown:   errorEmbed('Trop de signalements', `Réessaie dans **${result.remaining} minute(s)**.`),
      no_proof:   errorEmbed('Preuve requise', 'Le staff exige une preuve (lien ou capture) pour chaque signalement.'),
    };
    return interaction.reply({ embeds: [messages[result.reason] || errorEmbed('Erreur', 'Réessaie plus tard.')], ephemeral: true });
  }

  const conf = await ScamAlertConfig.findOne({ guildId: interaction.guild.id });
  const autoApproved = conf?.autoApprove;
  const hasReview = !!conf?.reviewChannelId;

  const e = successEmbed(
    'Signalement transmis !',
    autoApproved
      ? 'Ton signalement a été **publié directement** sur le réseau d\'alertes (auto-approbation activée). Merci ! 🛡️'
      : hasReview
        ? `Ton signalement est maintenant **en attente de validation** par le staff. Les serveurs abonnés seront alertés dès validation. Merci ! 🛡️`
        : 'Ton signalement a été **enregistré**. Le staff de ce serveur n\'a pas encore configuré de salon de validation — alerte-les pour qu\'ils règlent `/antiscam`.',
  ).addFields(
    { name: '🎯 Cible', value: result.alert.name, inline: true },
    { name: '📂 Type', value: typeLabel(result.alert.type), inline: true },
    { name: '🔖 Dossier', value: `#${result.alert._id}`, inline: true },
  );

  return interaction.reply({ embeds: [e], ephemeral: true });
}

function handleCancel(interaction) {
  pendingForms.delete(interaction.user.id);
  return interaction.update({
    embeds: [errorEmbed('Signalement annulé', 'Ton brouillon a été supprimé.')],
    components: [],
  }).catch(() => {});
}

const authGate = require('../../utils/authGate');

// ─── Ma commande /scam ────────────────────────────────────────────────────────
module.exports = {
  _clearPendingFormsForTests,
  data: new SlashCommandBuilder()
    .setName('scam')
    .setDescription('🚨 Signaler une arnaque (scam) au réseau d\'alertes REZO')
    .addStringOption((o) => o.setName('type')
      .setDescription('Type d\'arnaque (facultatif — sinon demandé dans le formulaire)')
      .addChoices(...Object.entries(TYPE_INFO).map(([value, info]) => ({ name: `${info.emoji} ${info.label}`, value })))),

  async execute(interaction) {
    // Confirmation du salon de review : le signalement ira au staff
    const conf = await ScamAlertConfig.findOne({ guildId: interaction.guild.id });
    if (conf && conf.reportsEnabled === false) {
      return interaction.reply({ embeds: [errorEmbed('Signalements désactivés', 'Le staff a désactivé les signalements sur ce serveur.')], ephemeral: true });
    }

    return openStep1(interaction);
  },

  // ─── Modaux routés par interactionCreate.js (scamf_) ─────────────────────
  async handleModal(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Signalement de scam' }))) return;
    if (interaction.customId === 'scamf_step1') return handleStep1(interaction);
    if (interaction.customId === 'scamf_step2_submit') return handleStep2(interaction, client);
  },

  // ─── Boutons scamf_ (étape 2, annulation) ────────────────────────────────
  async handleButton(interaction, client) {
    // Protection : preuve d'identité avant toute action de ce panneau.
    if (!(await authGate.authorizeComponent(interaction, { label: 'Signalement de scam' }))) return;
    if (interaction.customId === 'scamf_step2') return openStep2(interaction);
    if (interaction.customId === 'scamf_cancel') return handleCancel(interaction);
  },
};
