'use strict';
// commands/avis.js — Système d'avis (reviews) sur les serveurs du réseau REZO
// Étoiles + commentaire + tags, réponses publiques du staff, votes "utile",
// signalement avec masquage automatique, file de modération, stats temps réel,
// classement réseau, et panel de configuration avancé.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
} = require('discord.js');

const { Review } = require('../../models/Review');
const Server = require('../../models/Server');
const { logAction } = require('../../utils/avisLogger');
const { checkCanReview, checkEditCooldown, applyHelpfulVote, checkAutoHide, computeAverage, computeDistribution, validateMediaAttachments } = require('../../utils/avisEngine');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const { TAG_LABELS, stars, isMod, getOrCreateConfig, buildReviewCard, renderPanel, renderTagsView } = require('../../utils/avisUI');

const COLLECTOR_TIMEOUT_MS = 10 * 60 * 1000;
const LIVE_STATS_DURATION_MS = 90 * 1000;
const LIVE_STATS_INTERVAL_MS = 5 * 1000;

async function publishReviewIfNeeded(client, config, review, guild) {
  if (!config.reviewChannelId || !review.approved || review.hidden) return;
  try {
    const channel = guild.channels.cache.get(config.reviewChannelId) || await guild.channels.fetch(config.reviewChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const author = review.anonymous ? null : await client.users.fetch(review.reviewerId).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setAuthor({ name: review.anonymous ? 'Avis anonyme 🕵️' : (author?.username || 'Inconnu'), iconURL: author?.displayAvatarURL?.() })
      .setTitle(stars(review.rating))
      .setDescription(review.comment)
      .setTimestamp(review.createdAt);
    if (review.tags?.length) embed.addFields({ name: 'Tags', value: review.tags.map(t => TAG_LABELS[t] || t).join(' · ') });
    const embeds = [embed];
    if (review.mediaUrls?.length) {
      embed.setImage(review.mediaUrls[0]);
      for (const url of review.mediaUrls.slice(1)) embeds.push(new EmbedBuilder().setColor(COLORS.primary).setImage(url));
    }
    await channel.send({ embeds }).catch(() => {});
  } catch (_) {}
}

async function notifyModerationQueue(client, config, review, guild) {
  if (!config.logChannelId) return;
  try {
    const channel = guild.channels.cache.get(config.logChannelId) || await guild.channels.fetch(config.logChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('🕒 Nouvel avis en attente d\'approbation')
      .setDescription(`${stars(review.rating)}\n${review.comment}`)
      .addFields({ name: 'Auteur', value: review.anonymous ? 'Anonyme' : `<@${review.reviewerId}>` })
      .setTimestamp();
    if (review.mediaUrls?.length) embed.setThumbnail(review.mediaUrls[0]);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`avis_approve_${review._id}`).setLabel('✅ Approuver').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`avis_reject_${review._id}`).setLabel('❌ Rejeter').setStyle(ButtonStyle.Danger),
    );
    await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('avis')
    .setDescription('⭐ Système d\'avis sur les serveurs du réseau')
    .addSubcommand(s => s.setName('noter').setDescription('Laisser un avis sur ce serveur')
      .addIntegerOption(o => o.setName('note').setDescription('Note de 1 à 5').setRequired(true).addChoices(
        { name: '⭐ 1', value: 1 }, { name: '⭐⭐ 2', value: 2 }, { name: '⭐⭐⭐ 3', value: 3 }, { name: '⭐⭐⭐⭐ 4', value: 4 }, { name: '⭐⭐⭐⭐⭐ 5', value: 5 },
      ))
      .addStringOption(o => o.setName('commentaire').setDescription('Votre avis (max 500 caractères)').setRequired(true).setMaxLength(500))
      .addBooleanOption(o => o.setName('anonyme').setDescription('Publier anonymement (si autorisé)'))
      .addAttachmentOption(o => o.setName('image1').setDescription('Image jointe (capture d\'écran, preuve...) — PNG/JPEG/WEBP/GIF').setRequired(false))
      .addAttachmentOption(o => o.setName('image2').setDescription('Deuxième image (optionnel)').setRequired(false))
      .addAttachmentOption(o => o.setName('image3').setDescription('Troisième image (optionnel)').setRequired(false)))
    .addSubcommand(s => s.setName('modifier').setDescription('Modifier votre avis existant')
      .addIntegerOption(o => o.setName('note').setDescription('Nouvelle note de 1 à 5').setRequired(true).addChoices(
        { name: '⭐ 1', value: 1 }, { name: '⭐⭐ 2', value: 2 }, { name: '⭐⭐⭐ 3', value: 3 }, { name: '⭐⭐⭐⭐ 4', value: 4 }, { name: '⭐⭐⭐⭐⭐ 5', value: 5 },
      ))
      .addStringOption(o => o.setName('commentaire').setDescription('Nouveau commentaire').setRequired(true).setMaxLength(500))
      .addAttachmentOption(o => o.setName('image1').setDescription('Image jointe — remplace les images existantes si fournie').setRequired(false))
      .addAttachmentOption(o => o.setName('image2').setDescription('Deuxième image (optionnel)').setRequired(false))
      .addAttachmentOption(o => o.setName('image3').setDescription('Troisième image (optionnel)').setRequired(false)))
    .addSubcommand(s => s.setName('supprimer').setDescription('Supprimer votre avis'))
    .addSubcommand(s => s.setName('voir').setDescription('Parcourir les avis de ce serveur (images, votes utile, réponses du staff)'))
    .addSubcommand(s => s.setName('top').setDescription('Classement des serveurs les mieux notés du réseau'))
    .addSubcommand(s => s.setName('stats').setDescription('Statistiques des avis de ce serveur (temps réel)'))
    .addSubcommand(s => s.setName('repondre').setDescription('Répondre publiquement à un avis (staff)')
      .addUserOption(o => o.setName('membre').setDescription('Auteur de l\'avis').setRequired(true))
      .addStringOption(o => o.setName('reponse').setDescription('Votre réponse').setRequired(true).setMaxLength(500)))
    // Le panel vivait dans sa propre commande `/avis-panel` : c'est le MÊME
    // panneau (utils/avisUI.renderPanel), donc une sous-commande suffit — et
    // ça rend un des 100 emplacements Discord au bot.
    .addSubcommand(s => s.setName('panel').setDescription('⚙️ Panel de configuration avancé des avis (staff)')),

  async execute(interaction, client) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // ── NOTER ──────────────────────────────────────────────────────────────
    if (sub === 'noter') {
      const config = await getOrCreateConfig(guild.id);
      if (!config.enabled) return interaction.reply({ embeds: [errorEmbed('Désactivé', 'Le système d\'avis n\'est pas activé sur ce serveur.')], ephemeral: true });

      const existing = await Review.findOne({ guildId: guild.id, reviewerId: interaction.user.id });
      if (existing) return interaction.reply({ embeds: [errorEmbed('Avis déjà existant', 'Utilisez `/avis modifier` pour changer votre avis existant.')], ephemeral: true });

      const check = checkCanReview(config, { joinedAt: interaction.member.joinedAt, accountCreatedAt: interaction.user.createdAt });
      if (!check.ok) {
        const msg = check.reason === 'join'
          ? `Vous devez être membre depuis au moins **${check.required} jour(s)** (actuellement ${check.joinDays}j).`
          : `Votre compte Discord doit avoir au moins **${check.required} jour(s)** (actuellement ${check.ageDays}j).`;
        return interaction.reply({ embeds: [errorEmbed('Conditions non remplies', msg)], ephemeral: true });
      }

      let anonymous = interaction.options.getBoolean('anonyme') || false;
      if (anonymous && !config.allowAnonymous) anonymous = false;

      const rawAttachments = [interaction.options.getAttachment('image1'), interaction.options.getAttachment('image2'), interaction.options.getAttachment('image3')];
      const media = validateMediaAttachments(rawAttachments);
      if (!media.ok) return interaction.reply({ embeds: [errorEmbed('Image invalide', media.error)], ephemeral: true });

      const review = await Review.create({
        guildId: guild.id, reviewerId: interaction.user.id,
        rating: interaction.options.getInteger('note'), comment: interaction.options.getString('commentaire'),
        anonymous, mediaUrls: media.urls, approved: !config.requireApproval,
      });

      await logAction({ client, guildId: guild.id, userId: interaction.user.id, action: 'created' });

      if (config.requireApproval) {
        await notifyModerationQueue(client, config, review, guild);
        return interaction.reply({ embeds: [successEmbed('Avis envoyé', 'Votre avis a été soumis et sera publié après validation par le staff.')], ephemeral: true });
      }

      await publishReviewIfNeeded(client, config, review, guild);
      return interaction.reply({ embeds: [successEmbed('Avis publié !', 'Merci pour votre retour ⭐')], ephemeral: true });
    }

    // ── MODIFIER ───────────────────────────────────────────────────────────
    if (sub === 'modifier') {
      const config = await getOrCreateConfig(guild.id);
      const review = await Review.findOne({ guildId: guild.id, reviewerId: interaction.user.id });
      if (!review) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Vous n\'avez pas encore laissé d\'avis. Utilisez `/avis noter`.')], ephemeral: true });

      const cd = checkEditCooldown(config, review.editedAt);
      if (!cd.ok) return interaction.reply({ embeds: [errorEmbed('Cooldown actif', `Vous devez attendre encore **${cd.remainingHours}h** avant de modifier votre avis.`)], ephemeral: true });

      const rawAttachments = [interaction.options.getAttachment('image1'), interaction.options.getAttachment('image2'), interaction.options.getAttachment('image3')];
      const providedAny = rawAttachments.some(Boolean);
      if (providedAny) {
        const media = validateMediaAttachments(rawAttachments);
        if (!media.ok) return interaction.reply({ embeds: [errorEmbed('Image invalide', media.error)], ephemeral: true });
        review.mediaUrls = media.urls;
      }

      review.rating = interaction.options.getInteger('note');
      review.comment = interaction.options.getString('commentaire');
      review.editedAt = new Date();
      await review.save();

      await logAction({ client, guildId: guild.id, userId: interaction.user.id, action: 'edited' });
      return interaction.reply({ embeds: [successEmbed('Avis modifié', 'Votre avis a été mis à jour.')], ephemeral: true });
    }

    // ── SUPPRIMER ──────────────────────────────────────────────────────────
    if (sub === 'supprimer') {
      const review = await Review.findOne({ guildId: guild.id, reviewerId: interaction.user.id });
      if (!review) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Vous n\'avez pas d\'avis à supprimer.')], ephemeral: true });
      await Review.deleteOne({ _id: review._id });
      await logAction({ client, guildId: guild.id, userId: interaction.user.id, action: 'deleted' });
      return interaction.reply({ embeds: [successEmbed('Avis supprimé', 'Votre avis a été supprimé.')], ephemeral: true });
    }

    // ── VOIR (paginé, avec images/votes/signalement/réponses) ────────────────
    if (sub === 'voir') {
      const config = await getOrCreateConfig(guild.id);
      const all = await Review.find({ guildId: guild.id, hidden: false, approved: true }).sort({ createdAt: -1 });
      if (!all.length) return interaction.reply({ embeds: [infoEmbed('Aucun avis', 'Ce serveur n\'a pas encore reçu d\'avis. Soyez le premier avec `/avis noter` !')], ephemeral: true });

      all.sort((a, b) => (b.helpfulUp.length - b.helpfulDown.length) - (a.helpfulUp.length - a.helpfulDown.length));
      let index = 0;
      const mod = isMod(interaction);

      const authorCache = new Map();
      async function getAuthor(userId, anonymous) {
        if (anonymous) return null;
        if (authorCache.has(userId)) return authorCache.get(userId);
        const u = await client.users.fetch(userId).catch(() => null);
        authorCache.set(userId, u);
        return u;
      }

      const author0 = await getAuthor(all[0].reviewerId, all[0].anonymous);
      const message = await interaction.reply({
        ...buildReviewCard({ review: all[0], index, total: all.length, author: author0, config, canReply: mod }),
        ephemeral: true, fetchReply: true,
      });

      const collector = message.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: COLLECTOR_TIMEOUT_MS });

      collector.on('collect', async (i) => {
        const id = i.customId;

        if (id === 'avis_close') { collector.stop('closed'); return i.update({ components: [] }); }
        if (id === 'avis_prev' || id === 'avis_next') {
          index = id === 'avis_prev' ? Math.max(0, index - 1) : Math.min(all.length - 1, index + 1);
          const author = await getAuthor(all[index].reviewerId, all[index].anonymous);
          return i.update(buildReviewCard({ review: all[index], index, total: all.length, author, config, canReply: mod }));
        }

        const current = all[index];

        if (id === 'avis_helpful_up' || id === 'avis_helpful_down') {
          const fresh = await Review.findById(current._id);
          if (!fresh) return i.reply({ content: '❌ Cet avis n\'existe plus.', ephemeral: true });
          const result = applyHelpfulVote(fresh, i.user.id, id === 'avis_helpful_up' ? 'up' : 'down');
          if (!result.changed) return i.reply({ content: '❌ Tu as déjà voté ainsi pour cet avis.', ephemeral: true });
          await fresh.save();
          all[index] = fresh;
          const author = await getAuthor(fresh.reviewerId, fresh.anonymous);
          return i.update(buildReviewCard({ review: fresh, index, total: all.length, author, config, canReply: mod }));
        }

        if (id === 'avis_report') {
          const fresh = await Review.findById(current._id);
          if (!fresh) return i.reply({ content: '❌ Cet avis n\'existe plus.', ephemeral: true });
          if (fresh.reported.reporterIds.includes(i.user.id)) return i.reply({ content: '❌ Tu as déjà signalé cet avis.', ephemeral: true });
          fresh.reported.reporterIds.push(i.user.id);
          fresh.reported.count += 1;
          if (checkAutoHide(fresh.reported, config.reportThreshold)) {
            fresh.hidden = true;
            await logAction({ client, guildId: guild.id, userId: fresh.reviewerId, action: 'auto_hidden', detail: `${fresh.reported.count} signalements` });
          }
          await fresh.save();
          await logAction({ client, guildId: guild.id, userId: i.user.id, action: 'reported' });
          await i.reply({ content: '🚩 Avis signalé. Merci pour votre vigilance.', ephemeral: true });

          if (fresh.hidden) {
            all.splice(index, 1);
            if (!all.length) return interaction.editReply({ embeds: [infoEmbed('Aucun avis', 'Plus aucun avis à afficher.')], components: [] });
            index = Math.min(index, all.length - 1);
            const author = await getAuthor(all[index].reviewerId, all[index].anonymous);
            return interaction.editReply(buildReviewCard({ review: all[index], index, total: all.length, author, config, canReply: mod }));
          }
          return;
        }

        if (id === 'avis_reply' && mod) {
          const modal = new ModalBuilder().setCustomId(`avis_reply_modal_${current._id}`).setTitle('💬 Répondre à cet avis');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('reply_text').setLabel('Votre réponse publique').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500).setValue(current.ownerReply?.text || ''),
          ));
          return i.showModal(modal);
        }
      });

      collector.on('end', (_, reason) => { if (reason !== 'closed') interaction.editReply({ components: [] }).catch(() => {}); });
      return;
    }

    // ── TOP (classement réseau) ────────────────────────────────────────────
    if (sub === 'top') {
      const all = await Review.find({ hidden: false, approved: true }).lean();
      const byGuild = {};
      for (const r of all) {
        byGuild[r.guildId] = byGuild[r.guildId] || [];
        byGuild[r.guildId].push(r);
      }
      const ranked = Object.entries(byGuild)
        .map(([guildId, reviews]) => ({ guildId, avg: computeAverage(reviews), count: reviews.length }))
        .filter(g => g.count >= 3)
        .sort((a, b) => b.avg - a.avg || b.count - a.count)
        .slice(0, 10);

      if (!ranked.length) return interaction.reply({ embeds: [infoEmbed('Pas encore de classement', 'Aucun serveur n\'a encore au moins 3 avis. Revenez plus tard !')], ephemeral: true });

      const names = await Server.find({ guildId: { $in: ranked.map(r => r.guildId) } }).lean();
      const nameMap = Object.fromEntries(names.map(s => [s.guildId, s.guildName || s.guildId]));

      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('🏆 Top serveurs — Avis du réseau')
        .setDescription(ranked.map((r, i) => {
          const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'][i];
          return `${medal} **${nameMap[r.guildId] || r.guildId}** — ${stars(Math.round(r.avg))} (${r.avg}/5, ${r.count} avis)`;
        }).join('\n'))
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }

    // ── STATS (temps réel) ──────────────────────────────────────────────────
    if (sub === 'stats') {
      await interaction.deferReply();

      async function render(live) {
        const reviews = await Review.find({ guildId: guild.id, hidden: false, approved: true }).lean();
        const avg = computeAverage(reviews);
        const dist = computeDistribution(reviews);
        const tagCounts = {};
        for (const r of reviews) for (const t of (r.tags || [])) tagCounts[t] = (tagCounts[t] || 0) + 1;
        const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

        const embed = new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(`📊 Statistiques des avis${live ? ' · 🔴 EN DIRECT' : ''}`)
          .addFields(
            { name: '⭐ Note moyenne', value: `${stars(Math.round(avg))} (${avg}/5)`, inline: true },
            { name: '💬 Total avis', value: `${reviews.length}`, inline: true },
            { name: '📈 Distribution', value: [5, 4, 3, 2, 1].map(n => `${n}⭐ ${'█'.repeat(reviews.length ? Math.round((dist[n] / reviews.length) * 10) : 0).padEnd(10, '░')} ${dist[n]}`).join('\n'), inline: false },
          );
        if (topTags.length) embed.addFields({ name: '🏷️ Tags les plus fréquents', value: topTags.map(([t, c]) => `${TAG_LABELS[t] || t} (${c})`).join(', '), inline: false });
        embed.setFooter({ text: live ? 'Actualisation automatique toutes les 5s' : 'Cliquez sur 🔴 pour activer le direct' }).setTimestamp();
        return embed;
      }
      function row(live) {
        return new ActionRowBuilder().addComponents(
          live
            ? new ButtonBuilder().setCustomId('avisstats_stop').setLabel('⏹️ Arrêter le direct').setStyle(ButtonStyle.Danger)
            : new ButtonBuilder().setCustomId('avisstats_live').setLabel('🔴 Activer le direct (90s)').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('avisstats_refresh').setLabel('🔄 Actualiser').setStyle(ButtonStyle.Secondary),
        );
      }

      const message = await interaction.editReply({ embeds: [await render(false)], components: [row(false)] });
      const collector = message.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: COLLECTOR_TIMEOUT_MS });
      let liveInterval = null;
      const stopLive = () => { if (liveInterval) { clearInterval(liveInterval); liveInterval = null; } };

      collector.on('collect', async (i) => {
        if (i.customId === 'avisstats_refresh') return i.update({ embeds: [await render(!!liveInterval)], components: [row(!!liveInterval)] });
        if (i.customId === 'avisstats_stop') { stopLive(); return i.update({ embeds: [await render(false)], components: [row(false)] }); }
        if (i.customId === 'avisstats_live') {
          await i.update({ embeds: [await render(true)], components: [row(true)] });
          stopLive();
          const endAt = Date.now() + LIVE_STATS_DURATION_MS;
          liveInterval = setInterval(async () => {
            if (Date.now() >= endAt) { stopLive(); return interaction.editReply({ embeds: [await render(false)], components: [row(false)] }).catch(() => {}); }
            await interaction.editReply({ embeds: [await render(true)], components: [row(true)] }).catch(() => {});
          }, LIVE_STATS_INTERVAL_MS);
        }
      });
      collector.on('end', () => { stopLive(); interaction.editReply({ components: [] }).catch(() => {}); });
      return;
    }

    // ── REPONDRE (staff) ─────────────────────────────────────────────────────
    if (sub === 'repondre') {
      if (!isMod(interaction)) return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Permission `Gérer le serveur` requise.')], ephemeral: true });
      const config = await getOrCreateConfig(guild.id);
      if (!config.allowOwnerReply) return interaction.reply({ embeds: [errorEmbed('Désactivé', 'Les réponses du staff sont désactivées sur ce serveur.')], ephemeral: true });

      const target = interaction.options.getUser('membre');
      const review = await Review.findOne({ guildId: guild.id, reviewerId: target.id });
      if (!review) return interaction.reply({ embeds: [errorEmbed('Introuvable', `${target.username} n'a pas laissé d'avis.`)], ephemeral: true });

      review.ownerReply = { text: interaction.options.getString('reponse'), repliedBy: interaction.user.id, repliedAt: new Date() };
      await review.save();
      await logAction({ client, guildId: guild.id, userId: interaction.user.id, action: 'owner_reply' });
      return interaction.reply({ embeds: [successEmbed('Réponse publiée', `Votre réponse à l'avis de **${target.username}** a été publiée.`)] });
    }

    // ── PANEL (staff) — ex-`/avis-panel` ─────────────────────────────────────
    if (sub === 'panel') {
      if (!isMod(interaction)) {
        return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Permission `Gérer le serveur` requise.')], ephemeral: true });
      }

      let config = await getOrCreateConfig(guild.id);
      const reply = await interaction.reply({ ...renderPanel(config), ephemeral: true, fetchReply: true });
      const collector = reply.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: COLLECTOR_TIMEOUT_MS });

      collector.on('collect', async i => {
        const id = i.customId;
        config = await getOrCreateConfig(guild.id);

        if (id === 'avispanel_back' || id === 'avispanel_refresh') return i.update(renderPanel(config));
        if (id === 'avispanel_log') { config.logChannelId = i.values[0]; await config.save(); return i.update(renderPanel(config)); }
        if (id === 'avispanel_publish') { config.reviewChannelId = i.values[0]; await config.save(); return i.update(renderPanel(config)); }

        if (id === 'avispanel_toggle_enabled') { config.enabled = !config.enabled; await config.save(); return i.update(renderPanel(config)); }
        if (id === 'avispanel_toggle_anon') { config.allowAnonymous = !config.allowAnonymous; await config.save(); return i.update(renderPanel(config)); }
        if (id === 'avispanel_toggle_reply') { config.allowOwnerReply = !config.allowOwnerReply; await config.save(); return i.update(renderPanel(config)); }
        if (id === 'avispanel_toggle_approval') { config.requireApproval = !config.requireApproval; await config.save(); return i.update(renderPanel(config)); }

        if (id === 'avispanel_tags') return i.update(renderTagsView(config));
        if (id === 'avispanel_tags_select') { config.activeTags = i.values; await config.save(); return i.update(renderTagsView(config)); }

        if (id === 'avispanel_modal_thresholds') {
          const modal = new ModalBuilder().setCustomId('avispanel_modal_thresholds_submit').setTitle('🕒 Ancienneté & Cooldowns');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min_join').setLabel('Ancienneté min. sur le serveur (jours, 0=off)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.minJoinDays))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min_age').setLabel('Âge min. du compte Discord (jours, 0=off)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.minAccountAgeDays))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('edit_cd').setLabel('Cooldown de modification (heures)').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.editCooldownHours))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('report_threshold').setLabel('Signalements avant masquage auto').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(config.reportThreshold))),
          );
          return i.showModal(modal);
        }
      });

      collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
    }
  },

  // ─── Modal de réponse à un avis (bouton "Répondre" dans /avis voir) ────────
  async handleModal(interaction) {
    // Seuils du panel staff (ex-`/avis-panel`) : le seul modal que le collecteur
    // du panel laisse remonter au routeur.
    if (interaction.customId === 'avispanel_modal_thresholds_submit') {
      const config = await getOrCreateConfig(interaction.guild.id);
      const minJoin = parseInt(interaction.fields.getTextInputValue('min_join'));
      const minAge = parseInt(interaction.fields.getTextInputValue('min_age'));
      const cd = parseInt(interaction.fields.getTextInputValue('edit_cd'));
      const thresh = parseInt(interaction.fields.getTextInputValue('report_threshold'));

      if ([minJoin, minAge, cd, thresh].some(v => isNaN(v) || v < 0)) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Toutes les valeurs doivent être des nombres positifs (0 pour désactiver une contrainte).')], ephemeral: true });
      }

      config.minJoinDays = minJoin;
      config.minAccountAgeDays = minAge;
      config.editCooldownHours = cd;
      config.reportThreshold = thresh;
      await config.save();
      return interaction.update(renderPanel(config)).catch(() => interaction.reply({ embeds: [successEmbed('Paramètres mis à jour')], ephemeral: true }));
    }

    if (!interaction.customId.startsWith('avis_reply_modal_')) return;

    const reviewId = interaction.customId.replace('avis_reply_modal_', '');
    const review = await Review.findById(reviewId);
    if (!review) return interaction.reply({ content: '❌ Cet avis n\'existe plus.', ephemeral: true });

    review.ownerReply = { text: interaction.fields.getTextInputValue('reply_text'), repliedBy: interaction.user.id, repliedAt: new Date() };
    await review.save();
    await logAction({ client: interaction.client, guildId: interaction.guild.id, userId: interaction.user.id, action: 'owner_reply' });
    return interaction.reply({ embeds: [successEmbed('Réponse publiée', 'Votre réponse a été enregistrée sur cet avis.')], ephemeral: true });
  },

  // ─── Boutons de la file de modération (salon de logs, persistants) ─────────
  async handleModerationButton(interaction) {
    const id = interaction.customId;
    const isApprove = id.startsWith('avis_approve_');
    const isReject = id.startsWith('avis_reject_');
    if (!isApprove && !isReject) return;
    if (!isMod(interaction)) return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });

    const reviewId = id.replace(isApprove ? 'avis_approve_' : 'avis_reject_', '');
    const review = await Review.findById(reviewId);
    if (!review) return interaction.update({ content: '❌ Avis introuvable (déjà traité ?).', embeds: [], components: [] }).catch(() => {});

    if (isApprove) {
      review.approved = true;
      await review.save();
      const config = await getOrCreateConfig(interaction.guild.id);
      await publishReviewIfNeeded(interaction.client, config, review, interaction.guild);
      await interaction.update({ content: `✅ Avis approuvé par ${interaction.user.tag}.`, embeds: [], components: [] });
    } else {
      await Review.deleteOne({ _id: review._id });
      await interaction.update({ content: `❌ Avis rejeté par ${interaction.user.tag}.`, embeds: [], components: [] });
    }
  },
};
