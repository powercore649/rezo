'use strict';
// commands/communaute/confession.js — CONFESSIONS v2
//
// /confession : UNE commande, UN panneau — comme /signalement et /reglement.
//   • Côté membres  : `/confession envoyer` → formulaire anonyme (texte + image
//                     optionnelle selon la config), avec cooldown durable.
//   • Côté staff    : `/confession config` → panneau unique avec aperçu en
//                     direct de la prochaine confession, apparence, modération,
//                     réponses anonymes, cooldown, statistiques.
//
// Ce que la v2 corrige par rapport à la v1 :
//   1. Anonymat réel : aucun ID Discord n'est stocké, seulement un HMAC
//      (guildId:userId). La v1 enregistrait `authorId` en clair tout en
//      affichant « hashé pour anonymat ».
//   2. Numérotation atomique : la v1 faisait `countDocuments + 1`, ce qui
//      produisait deux « Confession #7 » lors d'envois simultanés. Un compteur
//      `nextNumber` ($inc) + index unique garantissent l'unicité.
//   3. Cooldown persistant : la v1 le gardait dans une Map en mémoire, perdue à
//      chaque redémarrage et fausse en mode shardé. Il est maintenant calculé en
//      base à partir du dernier envoi du même auteur (par hash).
//   4. Approbation sécurisée : les boutons Approuver/Refuser vérifient la
//      permission et ne peuvent s'appliquer qu'à une confession encore en
//      attente (plus de double publication au double-clic).
//   5. `allowImages` n'était qu'un affichage : il est réellement implémenté.
//   6. Nouveauté v2 : réponses 100 % anonymes, en fil sous chaque confession.
//
// CustomId :
//   confv_*   → panneau staff      confs_* → sélecteurs du panneau
//   confm_*   → modaux             conf_*  → boutons publics / modération
const crypto = require('crypto');
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder, StringSelectMenuBuilder, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { Confession, ConfessionConfig } = require('../../models/Confession.js');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');

const COLOR_PRESETS = [
  { value: '#9B59B6', label: 'Violet',      emoji: '🟣' },
  { value: '#E91E63', label: 'Rose',        emoji: '🌹' },
  { value: '#5865F2', label: 'Bleu',        emoji: '🔵' },
  { value: '#57F287', label: 'Vert',        emoji: '🟢' },
  { value: '#ED4245', label: 'Rouge',       emoji: '🔴' },
  { value: '#FEE75C', label: 'Jaune',       emoji: '🟡' },
  { value: '#2B2D31', label: 'Sombre',      emoji: '⚫' },
];

// Anti-spam des réponses anonymes (20 s) — volontairement en mémoire : c'est un
// garde-fou anti-flood, pas une règle de configuration à conserver.
const REPLY_COOLDOWN_MS = 20_000;
const replyCooldown = new Map();

// ─── Anonymat ─────────────────────────────────────────────────────────────────
// HMAC stable entre redémarrages et entre shards : identique pour un même
// couple serveur/membre, impossible à inverser sans le secret du déploiement.
function hashSecret() {
  return process.env.CONFESSION_SECRET
    || process.env.AUTH_ENCRYPTION_KEY
    || process.env.TOKEN
    || 'rezo-confession';
}

function hashAuthor(guildId, userId) {
  return crypto.createHmac('sha256', hashSecret())
    .update(`${guildId}:${userId}`)
    .digest('hex')
    .slice(0, 32);
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────
async function getConfig(guildId) {
  const existing = await ConfessionConfig.findOne({ guildId });
  if (existing) return existing;
  try {
    return await ConfessionConfig.create({ guildId });
  } catch (err) {
    // Deux interactions simultanées sur un serveur neuf : le second create
    // tombe sur l'index unique, on relit simplement la configuration.
    if (err?.code === 11000) return ConfessionConfig.findOne({ guildId });
    throw err;
  }
}

function parseColor(value, fallback = 0x9B59B6) {
  if (typeof value === 'number') return value;
  const hex = String(value || '').replace('#', '').trim();
  const n = parseInt(hex, 16);
  return Number.isFinite(n) ? n : fallback;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function repliesMode(cfg) {
  if (!cfg.anonymousReplies) return 'off';
  return cfg.threads ? 'thread' : 'channel';
}

// Compteur atomique : `nextNumber` contient le dernier numéro distribué.
async function allocateNumber(guildId) {
  const before = await ConfessionConfig.findOneAndUpdate(
    { guildId },
    { $inc: { nextNumber: 1 } },
    { new: false, upsert: true, setDefaultsOnInsert: true },
  );

  let number = Number(before?.nextNumber);
  if (!Number.isFinite(number) || number < 0) {
    // Serveur migré depuis la v1 : on repart du plus grand numéro existant.
    const last = await Confession.findOne({ guildId }).sort({ number: -1 }).select('number').lean();
    number = Number(last?.number) || 0;
    await ConfessionConfig.updateOne({ guildId }, { $max: { nextNumber: number } });
  }
  return number + 1;
}

// Minutes restantes avant qu'un auteur puisse poster à nouveau (0 = libre).
async function cooldownWait(cfg, guildId, userId) {
  const minutes = Number(cfg.cooldownMin) || 0;
  if (minutes <= 0) return 0;
  const since = new Date(Date.now() - minutes * 60_000);
  const last = await Confession.findOne({
    guildId,
    authorHash: hashAuthor(guildId, userId),
    createdAt: { $gt: since },
  }).sort({ createdAt: -1 }).lean().catch(() => null);
  if (!last?.createdAt) return 0;
  const remaining = new Date(last.createdAt).getTime() + minutes * 60_000 - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 60_000) : 0;
}

async function bumpStats(cfg, { pending = 0, published = 0, rejected = 0 } = {}) {
  cfg.stats.pending = Math.max(0, (cfg.stats.pending || 0) + pending);
  cfg.stats.published = Math.max(0, (cfg.stats.published || 0) + published);
  cfg.stats.rejected = Math.max(0, (cfg.stats.rejected || 0) + rejected);
  cfg.updatedAt = new Date();
  if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
}

// ─── Rendu d'une confession (source unique : panneau ET publication) ──────────
function buildConfessionEmbed(cfg, guild, confession) {
  const embed = new EmbedBuilder()
    .setColor(parseColor(cfg.embedColor))
    .setTitle(`🤫 Confession #${confession.number}`)
    .setDescription(confession.content);
  if (confession.imageUrl) embed.setImage(confession.imageUrl);
  embed.setFooter({ text: `${guild.name} • Confession anonyme` });
  if (confession.createdAt) embed.setTimestamp(confession.createdAt);
  return embed;
}

function buildPreview(cfg, guild) {
  const sample = {
    number: (Number(cfg.nextNumber) || 0) + 1,
    content: 'Aperçu en direct : la prochaine confession ressemblera exactement à ceci.\n\n'
      + 'Personne ne verra qui l\'a écrite.'
      + (cfg.allowImages ? '\n\n*Une image peut y être jointe.*' : ''),
    createdAt: null,
  };
  return buildConfessionEmbed(cfg, guild, sample)
    .setFooter({ text: `${guild.name} • Aperçu — cette confession n'est pas publiée` });
}

// ─── Panneau staff ────────────────────────────────────────────────────────────
function buildPanel(cfg, guild, note = null) {
  const log = cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*non défini*';
  const mode = repliesMode(cfg);
  const modeLabel = mode === 'thread' ? '✅ en fil' : mode === 'channel' ? '✅ dans le salon' : '❌ désactivées';

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('🤫 Confessions — panneau de configuration')
    .setThumbnail(guild.iconURL?.({ dynamic: true }) ?? null)
    .setDescription(
      'Tout le module se pilote ici, chaque changement s\'applique immédiatement.'
      + `\n\n**⚡ Service :** ${cfg.enabled ? '🟢 activé' : '🔴 désactivé'}`
      + `\n**📢 Salon de publication :** ${cfg.channelId ? `<#${cfg.channelId}>` : '*non défini*'}`
      + `\n**🛡️ Modération :** ${cfg.moderation ? `✅ approbation manuelle dans ${log}` : '⚡ publication directe'}`
      + (cfg.moderation ? `\n**🔔 Alerte :** ${cfg.alertRoleId ? `<@&${cfg.alertRoleId}>` : '*aucun rôle*'}` : '')
      + `\n**🖼️ Images :** ${cfg.allowImages ? '✅ autorisées' : '❌ refusées'}`
      + `\n**💬 Réponses anonymes :** ${modeLabel}`
      + `\n**⏱️ Cooldown :** ${Number(cfg.cooldownMin) > 0 ? `${cfg.cooldownMin} min` : 'aucun'}`
      + `\n\n**📊 Publiées :** ${cfg.stats.published}  •  **en attente :** ${cfg.stats.pending}  •  **refusées :** ${cfg.stats.rejected}`
      + (note ? `\n\n${note}` : ''),
    )
    .setFooter({ text: `Prochaine confession : #${(Number(cfg.nextNumber) || 0) + 1}` });

  const stateRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confv_toggle')
      .setLabel(cfg.enabled ? 'Désactiver' : 'Activer')
      .setEmoji(cfg.enabled ? '⏸️' : '⚡')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('confv_mod')
      .setLabel(`Modération : ${cfg.moderation ? 'ON' : 'OFF'}`)
      .setEmoji('🛡️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('confv_img')
      .setLabel(`Images : ${cfg.allowImages ? 'ON' : 'OFF'}`)
      .setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('confv_replies')
      .setLabel(`Réponses : ${mode === 'off' ? 'OFF' : mode === 'thread' ? 'fil' : 'salon'}`)
      .setEmoji('💬').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('confv_cool')
      .setLabel(`Cooldown : ${Number(cfg.cooldownMin) > 0 ? `${cfg.cooldownMin}min` : 'off'}`)
      .setEmoji('⏱️').setStyle(ButtonStyle.Secondary),
  );

  const colorRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('confs_color')
      .setPlaceholder('🎨 Couleur des confessions…')
      .addOptions(COLOR_PRESETS.map(p => ({
        label: p.label, value: p.value, emoji: p.emoji,
        default: p.value.toLowerCase() === String(cfg.embedColor || '').toLowerCase(),
      }))),
  );

  const mainRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('confs_main')
      .setPlaceholder('📢 Salon où publier les confessions…')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );

  const logRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('confs_log')
      .setPlaceholder('🛡️ Salon de modération (Approuver / Refuser)…')
      .addChannelTypes(ChannelType.GuildText),
  );

  const alertRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('confs_alert')
      .setPlaceholder('🔔 Rôle à mentionner quand une confession attend…'),
  );

  return {
    embeds: [embed, buildPreview(cfg, guild)],
    components: [stateRow, colorRow, mainRow, logRow, alertRow],
    ephemeral: true,
  };
}

// ─── Publication ──────────────────────────────────────────────────────────────
function buildReplyRow(cfg, confession) {
  if (!cfg.anonymousReplies) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`conf_reply_${confession._id}`)
      .setLabel('Répondre anonymement')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Secondary),
  )];
}

async function publishConfession(guild, cfg, confession) {
  const channel = await guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    return { ok: false, reason: 'Le salon de confession est introuvable — vérifie la configuration.' };
  }

  const msg = await channel.send({
    embeds: [buildConfessionEmbed(cfg, guild, confession)],
    components: buildReplyRow(cfg, confession),
  }).catch(() => null);
  if (!msg) return { ok: false, reason: `Je n'ai pas la permission d'écrire dans <#${cfg.channelId}>.` };

  let thread = null;
  if (cfg.anonymousReplies && cfg.threads) {
    thread = await msg.startThread({
      name: `Confession #${confession.number}`,
      autoArchiveDuration: 1440,
      reason: 'Réponses anonymes',
    }).catch(() => null);
  }

  await msg.react('🤫').catch(() => {});
  await Confession.updateOne({ _id: confession._id }, {
    status: 'published',
    approved: true,
    messageId: msg.id,
    threadId: thread?.id ?? null,
    publishedAt: new Date(),
  });

  return { ok: true, message: msg, thread };
}

function buildModerationEmbed(cfg, guild, confession) {
  const embed = buildConfessionEmbed(cfg, guild, confession)
    .setColor(COLORS.warning)
    .setTitle(`🛡️ Confession #${confession.number} — en attente`)
    .setFooter({ text: `${guild.name} • À approuver ou refuser` });
  return embed;
}

function buildModerationRows(confession) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`conf_approve_${confession._id}`)
      .setLabel('Approuver').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`conf_deny_${confession._id}`)
      .setLabel('Refuser').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  )];
}

async function sendToModeration(guild, cfg, confession) {
  const channel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  const msg = await channel.send({
    content: cfg.alertRoleId ? `<@&${cfg.alertRoleId}>` : undefined,
    embeds: [buildModerationEmbed(cfg, guild, confession)],
    components: buildModerationRows(confession),
  }).catch(() => null);
  if (msg) {
    await Confession.updateOne({ _id: confession._id }, { logMessageId: msg.id, channelId: cfg.channelId });
  }
  return msg;
}

// ─── Modération (boutons du salon de logs) ────────────────────────────────────
async function handleModeration(interaction, client, action, confessionId) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return interaction.reply({
      embeds: [errorEmbed('Permission manquante', 'Seuls les membres qui gèrent les messages peuvent valider une confession.')],
      ephemeral: true,
    });
  }

  const guild = interaction.guild;
  const confession = await Confession.findById(confessionId).catch(() => null);
  if (!confession) {
    return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Cette confession n\'existe plus.')], ephemeral: true });
  }
  if (confession.status !== 'pending') {
    const state = confession.status === 'published' ? 'publiée' : 'refusée';
    return interaction.reply({
      embeds: [infoEmbed('Déjà traitée', `Cette confession a déjà été **${state}**${confession.decidedBy ? ` par <@${confession.decidedBy}>` : ''}.`)],
      ephemeral: true,
    });
  }

  const cfg = await getConfig(guild.id);

  if (action === 'deny') {
    await Confession.updateOne({ _id: confessionId, status: 'pending' }, {
      status: 'rejected', approved: false, decidedBy: interaction.user.id, decidedAt: new Date(),
    });
    await bumpStats(cfg, { pending: -1, rejected: 1 });
    const done = buildConfessionEmbed(cfg, guild, confession)
      .setColor(COLORS.error)
      .setTitle(`🗑️ Confession #${confession.number} refusée`)
      .setFooter({ text: `Refusée par ${interaction.user.tag}` });
    return interaction.update({ embeds: [done], components: [] }).catch(() => {});
  }

  const published = await publishConfession(guild, cfg, confession);
  if (!published.ok) {
    return interaction.reply({ embeds: [errorEmbed('Publication impossible', published.reason)], ephemeral: true });
  }

  await Confession.updateOne({ _id: confessionId }, { decidedBy: interaction.user.id, decidedAt: new Date() });
  await bumpStats(cfg, { pending: -1, published: 1 });

  const done = buildConfessionEmbed(cfg, guild, confession)
    .setColor(COLORS.success)
    .setTitle(`✅ Confession #${confession.number} approuvée`)
    .setFooter({ text: `Approuvée par ${interaction.user.tag}` });
  return interaction.update({ embeds: [done], components: [] }).catch(() => {});
}

// ─── Réponses anonymes ───────────────────────────────────────────────────────
async function openReplyModal(interaction) {
  const id = interaction.customId.replace('conf_reply_', '');
  const cfg = await getConfig(interaction.guildId);
  if (!cfg.anonymousReplies) {
    return interaction.reply({ embeds: [errorEmbed('Réponses désactivées', 'Les réponses anonymes sont désactivées sur ce serveur.')], ephemeral: true });
  }

  const confession = await Confession.findById(id).catch(() => null);
  if (!confession || confession.status !== 'published') {
    return interaction.reply({ embeds: [errorEmbed('Confession indisponible', 'Cette confession n\'est plus disponible.')], ephemeral: true });
  }

  const modal = new ModalBuilder().setCustomId(`confm_reply_${id}`).setTitle(`💬 Réponse à la confession #${confession.number}`);
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('conf_reply_text')
      .setLabel('Ta réponse (100 % anonyme)')
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(2)
      .setMaxLength(1000)
      .setRequired(true)
      .setPlaceholder('Réponds à cette confession… personne ne saura qui tu es.'),
  ));
  return interaction.showModal(modal);
}

async function submitReply(interaction) {
  const id = interaction.customId.replace('confm_reply_', '');
  const text = (interaction.fields.getTextInputValue('conf_reply_text') || '').trim();
  if (!text) {
    return interaction.reply({ embeds: [errorEmbed('Réponse vide', 'Écris un message avant de valider.')], ephemeral: true });
  }

  const key = `${interaction.guildId}:${interaction.user.id}`;
  const last = replyCooldown.get(key) || 0;
  if (Date.now() - last < REPLY_COOLDOWN_MS) {
    const wait = Math.ceil((REPLY_COOLDOWN_MS - (Date.now() - last)) / 1000);
    return interaction.reply({ embeds: [errorEmbed('Doucement', `Attends encore **${wait}s** avant de répondre à nouveau.`)], ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  const cfg = await getConfig(guild.id);
  const confession = await Confession.findById(id).catch(() => null);
  if (!confession || confession.status !== 'published') {
    return interaction.editReply({ embeds: [errorEmbed('Confession indisponible', 'Cette confession n\'est plus disponible.')] });
  }

  let target = null;
  if (confession.threadId) target = await guild.channels.fetch(confession.threadId).catch(() => null);
  if (!target?.isTextBased()) target = await guild.channels.fetch(confession.channelId).catch(() => null);
  if (!target) {
    return interaction.editReply({ embeds: [errorEmbed('Salon introuvable', 'La confession a été supprimée ou déplacée.')] });
  }

  const inThread = target.id !== confession.channelId;
  const embed = new EmbedBuilder()
    .setColor(parseColor(cfg.embedColor))
    .setAuthor({ name: `💬 Réponse anonyme à la confession #${confession.number}` })
    .setDescription(text)
    .setTimestamp();

  const payload = { embeds: [embed], allowedMentions: { parse: [] } };
  if (!inThread && confession.messageId) payload.reply = { messageReference: confession.messageId, failIfNotExists: false };

  const sent = await target.send(payload).catch(() => null);
  if (!sent) {
    return interaction.editReply({ embeds: [errorEmbed('Envoi impossible', 'Je n\'ai pas la permission d\'écrire ici.')] });
  }

  await Confession.updateOne({ _id: id }, { $inc: { replies: 1 } }).catch(() => {});
  replyCooldown.set(key, Date.now());

  return interaction.editReply({
    embeds: [successEmbed('Réponse envoyée', `Ta réponse anonyme est publiée${inThread ? ' dans le fil de la confession' : ''}.`)],
  });
}

// ─── Soumission d'une confession ─────────────────────────────────────────────
async function askConfession(interaction) {
  const cfg = await getConfig(interaction.guildId);
  if (!cfg.enabled || !cfg.channelId) {
    return interaction.reply({
      embeds: [errorEmbed('Système désactivé', 'Les confessions ne sont pas activées sur ce serveur. Demande à un modérateur.')],
      ephemeral: true,
    });
  }

  const wait = await cooldownWait(cfg, interaction.guildId, interaction.user.id);
  if (wait > 0) {
    return interaction.reply({
      embeds: [errorEmbed('Patiente un peu', `Tu pourras envoyer une nouvelle confession dans **${wait} minute(s)**.`)],
      ephemeral: true,
    });
  }

  const modal = new ModalBuilder().setCustomId('confession_submit').setTitle('🤫 Confession anonyme');
  const rows = [new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('confession_text')
      .setLabel('Ta confession (100 % anonyme)')
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(10)
      .setMaxLength(1000)
      .setRequired(true)
      .setPlaceholder('Écris ta confession ici… personne ne saura qui tu es.'),
  )];
  if (cfg.allowImages) {
    rows.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('confession_image')
        .setLabel('Image (URL, optionnel)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(300)
        .setPlaceholder('https://…'),
    ));
  }
  modal.addComponents(rows);
  return interaction.showModal(modal);
}

async function submitConfession(interaction) {
  const guild = interaction.guild;
  const cfg = await getConfig(guild.id);
  if (!cfg.enabled || !cfg.channelId) {
    return interaction.reply({ embeds: [errorEmbed('Système désactivé', 'Les confessions ont été désactivées.')], ephemeral: true });
  }

  const wait = await cooldownWait(cfg, guild.id, interaction.user.id);
  if (wait > 0) {
    return interaction.reply({
      embeds: [errorEmbed('Patiente un peu', `Tu pourras envoyer une nouvelle confession dans **${wait} minute(s)**.`)],
      ephemeral: true,
    });
  }

  const content = (interaction.fields.getTextInputValue('confession_text') || '').trim();
  if (content.length < 10) {
    return interaction.reply({ embeds: [errorEmbed('Trop court', 'Ta confession doit faire au moins **10 caractères**.')], ephemeral: true });
  }

  let imageUrl = null;
  if (cfg.allowImages) {
    const raw = (interaction.fields.getTextInputValue('confession_image') || '').trim();
    if (raw) {
      if (!isHttpUrl(raw)) {
        return interaction.reply({ embeds: [errorEmbed('Lien invalide', 'L\'image doit être un lien **http(s)**, par exemple `https://exemple.fr/image.png`.')], ephemeral: true });
      }
      imageUrl = raw;
    }
  }

  await interaction.deferReply({ ephemeral: true });

  const authorHash = hashAuthor(guild.id, interaction.user.id);
  let confession = null;
  for (let attempt = 0; attempt < 2 && !confession; attempt += 1) {
    const number = await allocateNumber(guild.id);
    try {
      confession = await Confession.create({
        guildId: guild.id,
        channelId: cfg.channelId,
        authorHash,
        number,
        content,
        imageUrl,
        status: cfg.moderation ? 'pending' : 'published',
        approved: !cfg.moderation,
      });
    } catch (err) {
      // Numéro déjà pris par un envoi concurrent (index unique) → nouvelle tentative.
      if (err?.code === 11000 && attempt === 0) continue;
      throw err;
    }
  }
  if (!confession) {
    return interaction.editReply({ embeds: [errorEmbed('Réessaye', 'Impossible d\'attribuer un numéro à ta confession.')] });
  }

  if (cfg.moderation) {
    await bumpStats(cfg, { pending: 1 });
    const logMsg = cfg.logChannelId ? await sendToModeration(guild, cfg, confession) : null;
    return interaction.editReply({
      embeds: [successEmbed('Confession envoyée !',
        logMsg
          ? `Ta confession **#${confession.number}** est en attente d'approbation par les modérateurs.`
          : 'Ta confession est enregistrée, mais le salon de modération est introuvable — préviens un administrateur.')],
    });
  }

  const published = await publishConfession(guild, cfg, confession);
  if (!published.ok) {
    await Confession.updateOne({ _id: confession._id }, { status: 'pending' }).catch(() => {});
    await bumpStats(cfg, { pending: 1 });
    return interaction.editReply({
      embeds: [errorEmbed('Publication impossible', `${published.reason}\n\nTa confession est conservée : un modérateur peut la publier depuis le salon de modération.`)],
    });
  }

  await bumpStats(cfg, { published: 1 });
  return interaction.editReply({
    embeds: [successEmbed('Confession publiée !', `Ta confession anonyme **#${confession.number}** est en ligne dans <#${cfg.channelId}>.`)],
  });
}

// ─── Cooldown (modal du panneau) ─────────────────────────────────────────────
async function saveCooldown(interaction) {
  const raw = (interaction.fields.getTextInputValue('cooldown_value') || '').trim();
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || value > 1440) {
    return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Indique un nombre de minutes entre **0** (aucun cooldown) et **1440**.')], ephemeral: true });
  }
  const cfg = await getConfig(interaction.guildId);
  cfg.cooldownMin = value;
  cfg.updatedAt = new Date();
  if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
  return interaction.reply(buildPanel(cfg, interaction.guild, `⏱️ Cooldown : **${value > 0 ? `${value} minute(s)` : 'aucun'}**.`));
}

// ─── Commandes / boutons / menus / modaux ────────────────────────────────────
async function handleButton(interaction, client) {
  const id = interaction.customId || '';

  // Boutons publics / de modération (pas de permission de configuration requise)
  if (id.startsWith('conf_approve_') || id.startsWith('conf_deny_')) {
    const action = id.startsWith('conf_approve_') ? 'approve' : 'deny';
    const confessionId = id.replace(`conf_${action}_`, '');
    return handleModeration(interaction, client, action, confessionId);
  }
  if (id.startsWith('conf_reply_')) return openReplyModal(interaction);

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Seuls les membres qui gèrent le serveur peuvent configurer les confessions.')], ephemeral: true });
  }

  const cfg = await getConfig(interaction.guildId);
  const guild = interaction.guild;

  if (id === 'confv_toggle') {
    cfg.enabled = !cfg.enabled;
    cfg.updatedAt = new Date();
    if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
    const note = cfg.enabled
      ? (cfg.channelId ? '⚡ Système **activé** — les membres peuvent poster.' : '⚠️ Système **activé**, mais aucun salon de publication n\'est défini.')
      : '⏸️ Système **désactivé** — toute nouvelle confession est refusée.';
    return interaction.update(buildPanel(cfg, guild, note));
  }

  if (id === 'confv_mod') {
    cfg.moderation = !cfg.moderation;
    cfg.updatedAt = new Date();
    if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
    return interaction.update(buildPanel(cfg, guild, cfg.moderation
      ? (cfg.logChannelId ? '🛡️ Approbation **activée** — chaque confession part en modération.' : '🛡️ Approbation **activée**, mais aucun salon de modération n\'est défini : les confessions seraient perdues.')
      : '⚡ Publication **directe** — plus aucune validation manuelle.'));
  }

  if (id === 'confv_img') {
    cfg.allowImages = !cfg.allowImages;
    cfg.updatedAt = new Date();
    if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
    return interaction.update(buildPanel(cfg, guild, `🖼️ Images ${cfg.allowImages ? '**autorisées** (lien http/https)' : '**refusées**'}.`));
  }

  if (id === 'confv_replies') {
    // Cycle : désactivées → fil → salon → désactivées
    const mode = repliesMode(cfg);
    if (mode === 'off') { cfg.anonymousReplies = true; cfg.threads = true; }
    else if (mode === 'thread') { cfg.anonymousReplies = true; cfg.threads = false; }
    else { cfg.anonymousReplies = false; cfg.threads = false; }
    cfg.updatedAt = new Date();
    if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
    const next = repliesMode(cfg);
    return interaction.update(buildPanel(cfg, guild, next === 'thread'
      ? '💬 Réponses anonymes **activées**, chacune dans un fil dédié.'
      : next === 'channel' ? '💬 Réponses anonymes **activées** directement dans le salon (sans fil).'
        : '💬 Réponses anonymes **désactivées**.'));
  }

  if (id === 'confv_cool') {
    const modal = new ModalBuilder().setCustomId('confm_cooldown').setTitle('⏱️ Cooldown des confessions');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('cooldown_value')
        .setLabel('Minutes entre deux confessions (0 = aucun)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(Number(cfg.cooldownMin) || 0))
        .setMaxLength(4),
    ));
    return interaction.showModal(modal);
  }

  // Identifiant inconnu : on ne laisse pas l'interaction expirer en silence.
  return interaction.reply({ embeds: [errorEmbed('Action inconnue', 'Ce bouton n\'est plus valide — relance `/confession config`.')], ephemeral: true });
}

async function handleSelect(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Seuls les membres qui gèrent le serveur peuvent configurer les confessions.')], ephemeral: true });
  }

  const id = interaction.customId;
  const cfg = await getConfig(interaction.guildId);
  const guild = interaction.guild;
  const value = interaction.values?.[0];

  if (id === 'confs_color') {
    cfg.embedColor = value;
    cfg.updatedAt = new Date();
    if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
    const preset = COLOR_PRESETS.find(p => p.value === value);
    return interaction.update(buildPanel(cfg, guild, `🎨 Couleur : **${preset?.label ?? value}**.`));
  }

  if (id === 'confs_main') {
    cfg.channelId = value;
    cfg.updatedAt = new Date();
    if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
    return interaction.update(buildPanel(cfg, guild, `📢 Les confessions seront publiées dans <#${value}>.`));
  }

  if (id === 'confs_log') {
    cfg.logChannelId = value;
    cfg.updatedAt = new Date();
    if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
    return interaction.update(buildPanel(cfg, guild, `🛡️ Les confessions à valider arriveront dans <#${value}>.`));
  }

  if (id === 'confs_alert') {
    cfg.alertRoleId = value || null;
    cfg.updatedAt = new Date();
    if (typeof cfg.save === 'function') await cfg.save().catch(() => {});
    return interaction.update(buildPanel(cfg, guild, value
      ? `🔔 <@&${value}> sera mentionné quand une confession attend une validation.`
      : '🔔 Plus aucune mention lors des demandes de validation.'));
  }

  return interaction.reply({ embeds: [errorEmbed('Action inconnue', 'Ce menu n\'est plus valide — relance `/confession config`.')], ephemeral: true });
}

async function handleModal(interaction, client) {
  const id = interaction.customId || '';
  if (id.startsWith('confm_reply_')) return submitReply(interaction);
  if (id === 'confm_cooldown' || id === 'conf_cooldown_modal') return saveCooldown(interaction);
  if (id === 'confession_submit') return submitConfession(interaction);
  return undefined;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('confession')
    .setDescription('🤫 Envoyer une confession anonyme ou configurer le système')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('envoyer').setDescription('Envoyer une confession anonyme'))
    .addSubcommand(s => s.setName('config').setDescription('Panneau de configuration du système de confessions')),

  async execute(interaction, client) {
    if (!interaction.inGuild()) return;
    const sub = interaction.options.getSubcommand();
    if (sub === 'envoyer') return askConfession(interaction);

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ embeds: [errorEmbed('Permission manquante', 'Seuls les membres qui gèrent le serveur peuvent configurer les confessions.')], ephemeral: true });
    }
    const cfg = await getConfig(interaction.guildId);
    return interaction.reply(buildPanel(cfg, interaction.guild));
  },

  handleButton,
  handleSelect,
  handleModal,

  // Compat v1 : le routeur historique appelle encore ces noms.
  handleConfessionModal: handleModal,
  handleCooldownModal: saveCooldown,
  handleConfessionMod: handleModeration,

  // Exposés pour les tests
  _internal: {
    buildPanel, buildPreview, buildConfessionEmbed, buildReplyRow, buildModerationRows,
    hashAuthor, allocateNumber, cooldownWait, parseColor, isHttpUrl, repliesMode, COLOR_PRESETS,
  },
};
