// commands/bump.js — Système de bump complet v2
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const Server = require('../../models/Server');
const Balance = require('../../models/Balance');
const BumpReminder = require('../../models/BumpReminder');
const { broadcastBump, computeScore, BUMP_COOLDOWN_MS } = require('../../utils/bumpNetwork');
const { rollLootBox } = require('../../utils/bumpFeatures');
const {
  claimBump, rewardBumper, buildCongratulationEmbed, sendBumpDm, BUMP_CARD_FILENAME,
} = require('../../utils/bumpService');
const { renderBumpCardSafe } = require('../../utils/bumpCard');
const { errorEmbed, COLORS } = require('../../utils/embeds');
const { applyBrand } = require('../../utils/brand');
const { getAppEmoji } = require('../../utils/emojiSync');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('bump')
    .setDescription('Bumpez votre serveur dans le réseau REZO !'),

  async execute(interaction, client) {
    await interaction.deferReply();
    const guild = interaction.guild;
    // Membre pour la carte, les MP et les auto-rôles. `interaction.member`
    // peut être absent (membre non mis en cache) : on retombe sur l'utilisateur.
    const bumper = interaction.member || interaction.user;

    // Emojis Unicode uniquement : aucun emoji custom n'est créé, uploadé ou
    // référencé par le bot. `getAppEmoji` ne renvoie donc que de l'Unicode.
    const eRocket = getAppEmoji('bumpify_rocket') || '🚀';
    const eStreak = getAppEmoji('bumpify_streak') || '🔥';
    const eCoin   = getAppEmoji('bumpify_coin')   || '💰';
    const eStar   = getAppEmoji('bumpify_star')   || '⭐';
    const eCross  = getAppEmoji('bumpify_cross')  || '❌';

    // ── Récupérer/créer la config serveur ────────────────────────────────
    let server = await Server.findOneAndUpdate(
      { guildId: guild.id },
      { $setOnInsert: { guildId: guild.id, guildName: guild.name, guildIcon: guild.iconURL({ dynamic: true }), memberCount: guild.memberCount } },
      { upsert: true, new: true }
    );
    server.guildName   = guild.name;
    server.guildIcon   = guild.iconURL({ dynamic: true });
    server.memberCount = guild.memberCount;

    // ── Vérifications ─────────────────────────────────────────────────────
    if (server.blacklisted) {
      return interaction.editReply({ embeds: [errorEmbed('Serveur blacklisté', `Ce serveur est banni du réseau.\nRaison : ${server.blacklistReason || 'Non précisée'}`)] });
    }

    if (server.bumpChannelId && interaction.channelId !== server.bumpChannelId) {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle(`${eCross} Mauvais salon`)
          .setDescription(`Les bumps ne sont autorisés que dans <#${server.bumpChannelId}>.`)],
      });
    }

    if (!server.description) {
      return interaction.editReply({ embeds: [errorEmbed('Configuration incomplète', 'Ajoutez une description via `/setting` → **Config bump** avant de bumper.')] });
    }
    if (!server.inviteLink) {
      return interaction.editReply({ embeds: [errorEmbed('Invitation manquante', 'Ajoutez un lien d\'invitation via `/setting` → **Config bump** avant de bumper.')] });
    }

    // ── Cooldown ──────────────────────────────────────────────────────────
    if (server.lastBump) {
      const elapsed = Date.now() - new Date(server.lastBump).getTime();
      if (elapsed < BUMP_COOLDOWN_MS) {
        const remaining  = BUMP_COOLDOWN_MS - elapsed;
        const nextBumpTs = Math.floor((Date.now() + remaining) / 1000);
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);

        // Barre de progression visuelle du cooldown
        const progress = Math.round((elapsed / BUMP_COOLDOWN_MS) * 20);
        const progressBar = '▰'.repeat(progress) + '▱'.repeat(20 - progress);
        const embed = new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle('ℹ️ Cooldown actif')
          .setDescription(`**${progressBar}** ${Math.round(elapsed / BUMP_COOLDOWN_MS * 100)}%\n\nVous pourrez bumper <t:${nextBumpTs}:R>`)
          .addFields(
            { name: '⏰ Prochain bump', value: `<t:${nextBumpTs}:T>`, inline: true },
            { name: '⏳ Temps restant', value: `${minutes}m ${seconds}s`, inline: true },
            { name: `${eStreak} Streak actuel`, value: `${server.bumpStreak} jour(s)`, inline: true },
          )
          .setFooter({ text: 'REZO • Cooldown 2h' });

        const BumpNotifConfig = require('../../models/BumpNotifConfig');
        const notifConfig = await BumpNotifConfig.findOne({ guildId: guild.id });
        const showDmButton = notifConfig?.showDmButton ?? true;

        const components = [];
        if (showDmButton) {
          components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('🔔 Me rappeler en DM').setStyle(ButtonStyle.Secondary).setCustomId('bump_remind_me'),
          ));
        }

        applyBrand(embed);
        const cooldownReply = await interaction.editReply({ embeds: [embed], components });
        if (!showDmButton) return;

        // Collector local, indépendant de interactionCreate.js — ne gère
        // que le clic sur CE bouton précis, sur CE message précis.
        const remindCollector = cooldownReply.createMessageComponentCollector({
          filter: (i) => i.customId === 'bump_remind_me' && i.user.id === interaction.user.id,
          time: BUMP_COOLDOWN_MS,
          max: 1,
        });

        remindCollector.on('collect', async (i) => {
          await BumpReminder.findOneAndUpdate(
            { userId: i.user.id, guildId: guild.id },
            { dueAt: new Date(Date.now() + remaining) },
            { upsert: true }
          );
          await i.reply({ content: `🔔 C'est noté ! Je t'enverrai un message privé dès que le cooldown de **${guild.name}** sera terminé (<t:${nextBumpTs}:R>).`, ephemeral: true });
          await interaction.editReply({ components: [] }).catch(() => {});
        });

        return;
      }
    }

    // ── Appliquer le bump ─────────────────────────────────────────────────
    // Réservation ATOMIQUE : le cooldown est vérifié et consommé dans la même
    // requête. Deux bumps simultanés ne peuvent donc pas être comptés deux
    // fois (l'ancien « lire puis sauver » le permettait).
    const claim = await claimBump(guild, interaction.user.id);
    if (!claim.ok) {
      if (claim.reason === 'blacklisted') {
        return interaction.editReply({ embeds: [errorEmbed('Serveur blacklisté', `Ce serveur est banni du réseau.\nRaison : ${claim.server?.blacklistReason || 'Non précisée'}`)] });
      }
      const wait = Math.max(1, Math.ceil((claim.remainingMs || BUMP_COOLDOWN_MS) / 1000));
      return interaction.editReply({
        embeds: [errorEmbed('Bump déjà enregistré', `Un bump vient d'être validé pour ce serveur.\nVous pourrez re-bumper <t:${Math.floor(Date.now() / 1000) + wait}:R>.`)],
      });
    }
    server = claim.server;

    // ── Stats, coins, badges et historique — une seule source de vérité ───
    const { totalReward, streakBonus, newBadges, userStats } = await rewardBumper(guild, interaction.user.id, server);

    // ── Auto-rôles bump ───────────────────────────────────────────────────
    try {
      const { checkBumpRoles } = require('../configuration/autorole');
      await checkBumpRoles(interaction.member, userStats?.bumps || 0);
    } catch (_) { /* membre non mis en cache : les rôles seront posés à la prochaine occasion */ }

    // ── Diffuser dans le réseau ───────────────────────────────────────────
    const sent = await broadcastBump(client, server, interaction.user);

    // ── Centre de notifications — abonnés « Bumps » ──────────────────────
    // Le type existait dans le panel, mais aucun bump ne le déclenchait :
    // l'abonnement « Bumps » ne recevait donc jamais rien.
    try {
      const { sendNotification } = require('../../utils/notificationManager');
      await sendNotification(
        client,
        guild.id,
        'bumps',
        new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle('🚀 Bump enregistré !')
          .setDescription(
            `**${guild.name}** vient d'être bumpé par ${interaction.user}.\n`
            + `Total : **${server.bumpCount}** bump(s) · streak **${server.bumpStreak}** jour(s).`,
          )
          .setThumbnail(guild.iconURL({ dynamic: true }))
          .setTimestamp(),
        `${guild.name} bumpé`,
      );
    } catch (err) { console.error('bump notif:', err.message); }

    // ── Attaque de territoire automatique ────────────────────────────────
    let territoryResult = null;
    try {
      const { attemptTerritoryAttack } = require('../../utils/territoryEngine');
      territoryResult = await attemptTerritoryAttack(guild.id, guild.name);
    } catch (err) {
      console.error('territoryAttack:', err.message);
    }

    // ── Log dans le salon logs ────────────────────────────────────────────
    if (server.logChannelId) {
      const logCh = guild.channels.cache.get(server.logChannelId);
      if (logCh?.isTextBased()) {
        logCh.send({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle('✅ Bump enregistré')
            .addFields(
              { name: '👤 Par',           value: `${interaction.user.tag}`, inline: true },
              { name: '🔢 Total',         value: `${server.bumpCount}`,     inline: true },
              { name: '📡 Diffusé vers',  value: `${sent} serveur(s)`,      inline: true },
              { name: `${eStreak} Streak`,        value: `${server.bumpStreak} jour(s)`, inline: true },
              { name: '🏆 Score réseau',  value: `${computeScore(server)}`, inline: true },
            )
            .setTimestamp()],
        }).catch(() => {});
      }
    }

    // ── Embed de succès ───────────────────────────────────────────────────
    const nextBumpTs = Math.floor((Date.now() + BUMP_COOLDOWN_MS) / 1000);
    const isFeatured = server.featured && server.featuredUntil && new Date(server.featuredUntil) > new Date();

    const embed = new EmbedBuilder()
      .setColor(isFeatured ? 0xFFD700 : COLORS.success)
      .setTitle(`${isFeatured ? eStar : eRocket} Serveur bumpé avec succès !`)
      .setDescription(server.description)
      .setThumbnail(guild.iconURL({ dynamic: true }))
      .addFields(
        { name: '👥 Membres',          value: `${guild.memberCount.toLocaleString()}`, inline: true },
        { name: '🔁 Total bumps',       value: `${server.bumpCount}`,                 inline: true },
        { name: '📡 Serveurs notifiés', value: `${sent}`,                             inline: true },
        { name: `${eStreak} Streak`,           value: `${server.bumpStreak} jour(s)`,        inline: true },
        { name: `${eCoin} Récompense`,       value: `+${totalReward} coins${streakBonus > 0 ? ` *(+${streakBonus} bonus streak)*` : ''}`, inline: true },
        { name: '⏳ Prochain bump',    value: `<t:${nextBumpTs}:R>`,                 inline: true },
        { name: '🏆 Score réseau',     value: `${computeScore(server)} pts`,         inline: true },
      )
      .setFooter({ text: `Bumpé par ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();

    if (server.tags?.length > 0) {
      embed.addFields({ name: '🏷️ Tags', value: server.tags.map(t => `\`${t}\``).join(' ') });
    }
    if (server.bumpStreak >= 3) {
      embed.addFields({ name: `${eStreak} Streak actif !`, value: `Ce serveur est bumpé depuis **${server.bumpStreak} jours** de suite !` });
    }
    if (isFeatured) {
      embed.addFields({ name: `${eStar} Mis en avant !`, value: `Votre serveur est mis en avant jusqu'au <t:${Math.floor(new Date(server.featuredUntil).getTime() / 1000)}:f>` });
    }
    if (newBadges.length > 0) {
      embed.addFields({
        name: '🏅 Nouveau(x) badge(s) débloqué(s) !',
        value: newBadges.map((b) => `${b.emoji} **${b.name}**`).join('\n') + '\n*Voir `/badge voir` pour ta collection complète.*',
      });
    }

    // ── Affichage du résultat de l'attaque territoire ──────────────────────
    if (territoryResult) {
      const z = territoryResult.zone;
      let territoryText = '';
      if (territoryResult.type === 'capture_free') {
        territoryText = `⚔️ **Zone \`${z.zoneId}\` ${z.name}** conquise (territoire libre) !`;
      } else if (territoryResult.type === 'capture_enemy') {
        territoryText = `🏴 **Zone \`${z.zoneId}\` ${z.name}** arrachée à **${territoryResult.previousName || 'un autre serveur'}** !`;
      } else if (territoryResult.type === 'reinforce') {
        territoryText = `🛡️ Renfort sur **\`${z.zoneId}\` ${z.name}** — Puissance : ${z.power}/500`;
      } else if (territoryResult.type === 'attack_failed') {
        territoryText = `⚠️ Attaque repoussée sur **\`${z.zoneId}\` ${z.name}** (défense : ${territoryResult.remainingPower})`;
      }
      embed.addFields({
        name: '🗺️ Guerre des Territoires',
        value: `${territoryText}\n💰 +${territoryResult.warCoinsEarned} war-coins ・ 👑 Rang : **${territoryResult.newRank}** ・ Voir \`/territoires carte\``,
      });
    }

    // ── Carte de félicitations (image PNG) ───────────────────────────────
    const card = await renderBumpCardSafe({
      member: bumper,
      guild,
      server,
      reward: totalReward,
      score: computeScore(server),
      source: 'REZO',
    });
    if (card) embed.setImage(`attachment://${BUMP_CARD_FILENAME}`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('📊 Mes stats').setStyle(ButtonStyle.Secondary).setCustomId('bump_view_stats'),
      new ButtonBuilder().setLabel('🏆 Top serveurs').setStyle(ButtonStyle.Primary).setCustomId('topserv_open'),
    );

    // ── Loot box (20% de chance par bump) ───────────────────────────────────
    const loot = rollLootBox();
    if (loot) {
      row.addComponents(
        new ButtonBuilder().setLabel('🎁 Ouvrir la loot box').setStyle(ButtonStyle.Success).setCustomId('bump_lootbox_open'),
      );
    }

    applyBrand(embed);
    const sentReply = await interaction.editReply({
      embeds: [embed],
      components: [row],
      files: card ? [{ attachment: card, name: BUMP_CARD_FILENAME }] : [],
    });

    // ── Félicitations en message privé (demande explicite) ───────────────
    // Repli silencieux si les MP sont fermés : le bump reste valide.
    const dmEmbed = buildCongratulationEmbed({
      guild,
      member: bumper,
      server,
      totalReward,
      streakBonus,
      newBadges,
      source: 'REZO',
      hasCard: !!card,
    });
    await sendBumpDm({ member: bumper, embed: dmEmbed, card });

    // ── Message de remerciement personnalisé ───────────────────────────────
    if (server.bumpThanksEnabled && server.bumpThanksMessage) {
      try {
        const thanksMessage = server.bumpThanksMessage
          .replace(/{user}/g, `<@${interaction.user.id}>`)
          .replace(/{username}/g, interaction.user.username)
          .replace(/{tag}/g, interaction.user.tag)
          .replace(/{serveur}/g, guild.name)
          .replace(/{membres}/g, guild.memberCount.toLocaleString())
          .replace(/{bumps}/g, server.bumpCount)
          .replace(/{streak}/g, server.bumpStreak);

        const thanksEmbed = new EmbedBuilder()
          .setColor(server.bumpThanksColor || '#2ecc71')
          .setTitle(server.bumpThanksTitle || '✅ Bump enregistré !')
          .setDescription(thanksMessage)
          .setFooter({ text: `REZO • Bump #${server.bumpCount}` })
          .setTimestamp();

        if (server.bumpThanksImage) {
          thanksEmbed.setImage(server.bumpThanksImage);
        }

        await interaction.followUp({ embeds: [thanksEmbed] });
      } catch (err) {
        console.error('Erreur message remerciement bump:', err);
      }
    }

    if (loot) {
      // Collector local, indépendant de interactionCreate.js — ne gère que
      // ce bouton précis, sur ce message précis, pendant 2 minutes.
      const lootCollector = sentReply.createMessageComponentCollector({
        filter: (i) => i.customId === 'bump_lootbox_open' && i.user.id === interaction.user.id,
        time: 120000,
        max: 1,
      });

      lootCollector.on('collect', async (i) => {
        await Balance.findOneAndUpdate(
          { userId: i.user.id, guildId: guild.id },
          { $inc: { coins: loot.coins } },
          { upsert: true }
        );
        const lootEmbed = new EmbedBuilder()
          .setColor(loot.coins >= 1000 ? 0xFFD700 : COLORS.success)
          .setTitle('🎁 Loot box ouverte !')
          .setDescription(`${loot.label}\n💰 Tu as gagné **+${loot.coins} coins** !`);
        applyBrand(lootEmbed);
        await i.reply({ embeds: [lootEmbed] });
        const disabledRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('📊 Mes stats').setStyle(ButtonStyle.Secondary).setCustomId('bump_view_stats'),
          new ButtonBuilder().setLabel('🎁 Ouverte').setStyle(ButtonStyle.Success).setCustomId('bump_lootbox_open').setDisabled(true),
        );
        await interaction.editReply({ components: [disabledRow] }).catch(() => {});
      });

      lootCollector.on('end', (collected) => {
        if (collected.size === 0) {
          // Personne n'a cliqué à temps : on désactive juste le bouton,
          // aucune perte pour l'utilisateur (la loot box expire, c'est tout).
          const expiredRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('📊 Mes stats').setStyle(ButtonStyle.Secondary).setCustomId('bump_view_stats'),
            new ButtonBuilder().setLabel('🎁 Expirée').setStyle(ButtonStyle.Secondary).setCustomId('bump_lootbox_open').setDisabled(true),
          );
          interaction.editReply({ components: [expiredRow] }).catch(() => {});
        }
      });
    }

    return sentReply;
  },
};
