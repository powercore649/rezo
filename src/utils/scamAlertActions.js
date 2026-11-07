'use strict';
// utils/scamAlertActions.js — Orchestration du réseau d'alertes scams.
//
// Utilisé par :
//   • /antiscam      (src/commands/moderation/antiscam.js) — panneau + validation
//   • /scam          (src/commands/moderation/scam.js)     — formulaire public
//   • interactionCreate.js                                 — boutons de vote `scamv_`
//
// Flux : signalement → validation staff local → diffusion aux serveurs abonnés
// → votes par les admins de chaque serveur → base d'alertes partagée.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { ScamAlert, SCAM_TYPES } = require('../models/ScamAlert');
const ScamAlertConfig = require('../models/ScamAlertConfig');
const { COLORS } = require('./embeds');

const TYPE_INFO = {
  phishing:      { emoji: '🎣', label: 'Phishing / liens piégés' },
  impersonation: { emoji: '🎭', label: 'Usurpation d\'identité' },
  nitro:         { emoji: '🎁', label: 'Faux Nitro / gifts' },
  crypto:        { emoji: '🪙', label: 'Arnaque crypto / investment' },
  fakegiveaway:  { emoji: '🎉', label: 'Faux giveaway' },
  shop:          { emoji: '🛒', label: 'Faux shop / vente' },
  steam:         { emoji: '🎮', label: 'Faux trades Steam / jeux' },
  other:         { emoji: '❓', label: 'Autre' },
};

const typeLabel = (t) => TYPE_INFO[t] ? `${TYPE_INFO[t].emoji} ${TYPE_INFO[t].label}` : `❓ ${t}`;

// ─── Carte de signalement (vue staff validation ET carte de vote réseau) ─────
function buildAlertEmbed(alert, { voteMode = false } = {}) {
  const statusInfo = {
    pending:  { label: '🟡 En attente de validation', color: COLORS.warning },
    approved: { label: '✅ Validé par le staff', color: COLORS.error },
    rejected: { label: '⛔ Rejeté', color: 0x2B2D31 },
  };
  const st = statusInfo[alert.status] || statusInfo.pending;
  const votesFor = alert.votes.filter(v => v.value === 1).length;
  const votesAgainst = alert.votes.filter(v => v.value === 0).length;

  const e = new EmbedBuilder()
    .setColor(voteMode ? COLORS.error : st.color)
    .setTitle(`${voteMode ? '🚨 ALERTE SCAM — Réseau REZO' : '🛡️ Signalement de scam'} • ${typeLabel(alert.type)}`)
    .setDescription(alert.details ? alert.details.slice(0, 1500) : '*Aucun détail fourni*')
    .addFields(
      { name: '🎯 Cible signalée', value: `**${alert.name}**${alert.guildName ? `\n🏠 Serveur : ${alert.guildName}` : ''}`, inline: true },
      { name: '👤 Signaleur', value: `${alert.reporterTag}\n\`${alert.reporterId}\``, inline: true },
      { name: '🏠 Serveur source', value: alert.sourceGuildName || '*inconnu*', inline: true },
    );

  if (alert.evidenceUrl) {
    if (/\.(png|jpe?g|gif|webp)$/i.test(alert.evidenceUrl)) e.setImage(alert.evidenceUrl);
    else e.addFields({ name: '🔗 Preuve', value: alert.evidenceUrl.slice(0, 500) });
  }

  if (voteMode) {
    e.addFields(
      { name: '🗳️ Votes', value: `✅ Scam confirmé : **${votesFor}**\n❌ Non confirmé : **${votesAgainst}**`, inline: true },
      { name: '📊 Score réseau', value: `**${alert.voteScore}**`, inline: true },
      { name: '🌍 Diffusion', value: `**${alert.reachedGuilds}** serveur(s)`, inline: true },
    );
  } else if (alert.status === 'approved' || alert.status === 'rejected') {
    e.addFields({ name: '⚖️ Décision', value: `${st.label}\nPar **${alert.approverTag}** <t:${Math.floor((alert.decidedAt?.getTime() || Date.now()) / 1000)}:R>`, inline: false });
  } else {
    e.addFields({ name: '⏳ Statut', value: st.label, inline: false });
  }

  e.setFooter({ text: `Dossier #${alert._id} • Réseau d'alertes scams REZO` });
  return e;
}

function voteRow(alert) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`scamv_yes_${alert._id}`).setLabel(`Scam confirmé (${alert.votes.filter(v => v.value === 1).length})`).setStyle(ButtonStyle.Danger).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`scamv_no_${alert._id}`).setLabel(`Non confirmé (${alert.votes.filter(v => v.value === 0).length})`).setStyle(ButtonStyle.Success).setEmoji('❌'),
  );
}

// ─── Soumission d'un signalement (depuis le formulaire /scam) ────────────────
// Retourne { ok, reason?, alert? }
async function submitReport(interaction, data) {
  const guild = interaction.guild;
  const cfg = await ScamAlertConfig.findOne({ guildId: guild.id });

  // Serveur inconnu → création à la volée (le formulaire doit marcher partout)
  const conf = cfg || await ScamAlertConfig.create({ guildId: guild.id });

  if (!conf.reportsEnabled) return { ok: false, reason: 'disabled' };
  if (conf.blacklistReporters.includes(interaction.user.id)) return { ok: false, reason: 'blacklisted' };

  // Anti-spam : cooldown par utilisateur
  const last = await ScamAlert.findOne({ reporterId: interaction.user.id, sourceGuildId: guild.id })
    .sort({ createdAt: -1 }).lean().catch(() => null);
  if (last && conf.cooldownMinutes > 0) {
    const elapsed = (Date.now() - new Date(last.createdAt).getTime()) / 60000;
    if (elapsed < conf.cooldownMinutes) {
      return { ok: false, reason: 'cooldown', remaining: Math.ceil(conf.cooldownMinutes - elapsed) };
    }
  }

  if (conf.requiredProof && !data.evidenceUrl) return { ok: false, reason: 'no_proof' };

  const alert = await ScamAlert.create({
    type: data.type,
    name: data.name,
    guildName: data.guildName || null,
    evidenceUrl: data.evidenceUrl || null,
    details: data.details || '',
    reporterId: interaction.user.id,
    reporterTag: interaction.user.tag,
    sourceGuildId: guild.id,
    sourceGuildName: guild.name,
  });

  conf.reportsSent += 1;
  await conf.save().catch(() => {});

  // Validation staff (carte pending dans le salon de review) ou publication directe
  if (conf.autoApprove) {
    await approveAndBroadcast(interaction.client, alert, { approver: { id: 'auto', tag: 'auto-approbation' } });
  } else if (conf.reviewChannelId) {
    const reviewCh = guild.channels.cache.get(conf.reviewChannelId);
    if (reviewCh) {
      const card = await reviewCh.send({
        embeds: [buildAlertEmbed(alert)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`scamv_approve_${alert._id}`).setLabel('Valider & diffuser').setStyle(ButtonStyle.Success).setEmoji('✅'),
          new ButtonBuilder().setCustomId(`scamv_reject_${alert._id}`).setLabel('Rejeter').setStyle(ButtonStyle.Danger).setEmoji('⛔'),
        )],
      }).catch(() => null);
      if (card) await card.pin().catch(() => {});
    }
  }

  return { ok: true, alert };
}

// ─── Validation + diffusion à tous les serveurs abonnés ──────────────────────
async function approveAndBroadcast(client, alert, { approver } = {}) {
  alert.status = 'approved';
  alert.approverId = approver?.id || null;
  alert.approverTag = approver?.tag || null;
  alert.decidedAt = new Date();
  alert.broadcastAt = new Date();

  const configs = await ScamAlertConfig.find({ subscribed: true, scamChannelId: { $ne: null } }).catch(() => []);
  let reached = 0;

  for (const conf of configs) {
    // Le serveur source reçoit aussi la carte finale (confirmation visuelle)
    if (conf.typeFilter?.length && !conf.typeFilter.includes(alert.type)) continue;

    const guild = client.guilds.cache.get(conf.guildId);
    const channel = guild?.channels?.cache.get(conf.scamChannelId);
    if (!channel) continue;

    // Pas de garde de permission : Discord autorise l'envoi si le bot a l'accès ;
    // les erreurs sont attrapées silencieusement.
    const sent = await channel.send({
      content: '🚨 **Nouvelle alerte scam validée — vérifiez vos membres et vos salons.**',
      embeds: [buildAlertEmbed(alert, { voteMode: true })],
      components: [voteRow(alert)],
    }).catch(() => null);

    if (sent) {
      reached++;
      await ScamAlertConfig.updateOne({ guildId: conf.guildId }, { $inc: { alertsReceived: 1 } }).catch(() => {});
    }
  }

  alert.reachedGuilds = reached;
  await alert.save().catch(() => {});
  return reached;
}

async function rejectAlert(alert, approver) {
  alert.status = 'rejected';
  alert.approverId = approver?.id || null;
  alert.approverTag = approver?.tag || null;
  alert.decidedAt = new Date();
  await alert.save().catch(() => {});
}

// ─── Vote d'un admin sur une carte diffusée ──────────────────────────────────
// interaction : bouton scamv_yes_/scamv_no_. Retourne le nouvel état du vote.
async function handleVote(interaction) {
  const alert = await ScamAlert.findById(interaction.customId.replace(/^scamv_(?:yes|no)_/, ''));
  if (!alert) return interaction.reply({ content: '⚠️ Ce dossier n\'existe plus.', ephemeral: true }).catch(() => {});

  // Seuls les membres avec la permission de gérer les messages votent (anti-troll)
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
    return interaction.reply({ content: '🔒 Seuls les membres pouvant gérer les messages peuvent voter.', ephemeral: true }).catch(() => {});
  }

  const value = interaction.customId.startsWith('scamv_yes_') ? 1 : 0;
  alert.votes = alert.votes.filter(v => v.userId !== interaction.user.id);
  alert.votes.push({ userId: interaction.user.id, value });
  alert.voteScore = alert.votes.reduce((s, v) => s + v.value, 0);
  await alert.save().catch(() => {});

  return interaction.update({
    embeds: [buildAlertEmbed(alert, { voteMode: true })],
    components: [voteRow(alert)],
  }).catch(() => {});
}

module.exports = {
  TYPE_INFO,
  SCAM_TYPES,
  typeLabel,
  buildAlertEmbed,
  voteRow,
  submitReport,
  approveAndBroadcast,
  rejectAlert,
  handleVote,
};
