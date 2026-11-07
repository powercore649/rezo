const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { Welcome } = require('../../models/Welcome');
const Invite = require('../../models/Invite');
const { CaptchaConfig } = require('../../models/Captcha');
const InviteConfig = require('../../models/InviteConfig');
const InviteUse = require('../../models/InviteUse');
const OnboardingConfig = require('../../models/OnboardingConfig');
const { resolveInviteForJoin } = require('../../utils/inviteCache');
const { COLORS } = require('../../utils/embeds');
const {
  computeInviteStats, getInviteRank, buildJoinEmbed,
  accountAgeDays: accountAgeOf, milestoneFor, eligibleRewardRoles, grantInviteCoins,
} = require('../../utils/inviteEngine');
const { renderInviteCardSafe, INVITE_CARD_FILENAME } = require('../../utils/inviteCard');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member, client) {
    const guild = member.guild;

    // ── VIGIE — profil écarté à l'arrivée : ni bienvenue, ni rôles, ni MP ──
    try {
      const { wasBlocked } = require('../../utils/joinGuardActions');
      if (wasBlocked(member)) return;
    } catch (_) {}

    // ── ANTI-RAID — si le membre vient d'être banni/kické par la protection, stop ici ──
    try {
      const AntiRaid = require('../../models/AntiRaid').AntiRaid;
      const cfg = await AntiRaid.findOne({ guildId: guild.id, enabled: true }).lean();
      if (cfg) {
        if ((cfg.bannedUserIds || []).includes(member.id)) return; // déjà géré par l'event antiraid (kick/ban appliqué)
        if (cfg.lockdownActive && cfg.response?.lockdown) {
          // Serveur verrouillé : on refuse l'arrivée des comptes trop récents
          const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
          if (ageDays < (cfg.minAccountAgeDays || 0)) {
            await member.kick('Anti-raid : serveur verrouillé, compte trop récent').catch(() => {});
            return;
          }
        }
      }
    } catch (_) {}

    // ── ANTI-VPN — le membre doit vérifier sa connexion avant tout accès ──
    // Quand la porte est active, elle remplace l'onboarding et le captcha :
    // deux vérifications successives ne feraient qu'ajouter de la friction.
    let antiVpnGate = false;
    try {
      const { AntiVPN } = require('../../models/AntiVPN');
      const vpnCfg = await AntiVPN.findOne({ guildId: guild.id, enabled: true });
      if (vpnCfg) {
        const { startVerification } = require('../../utils/antiVpnFlow');
        const started = await startVerification(member, vpnCfg, client);
        if (started.ok) {
          antiVpnGate = true;
          if (!started.delivered) {
            console.warn(`[anti-vpn] aucun lien délivré à ${member.user.tag} (${guild.id}) — vérifie le salon/les MP`);
          }
        } else if (started.reason === 'no_portal') {
          console.warn('[anti-vpn] portail non configuré (ANTIVPN_PORT / ANTIVPN_PUBLIC_URL) — vérification ignorée');
        }
      }
    } catch (err) { console.error('guildMemberAdd anti-vpn:', err.message); }

    // ── Onboarding / portail d'accès (priorité absolue si activé) ─────────
    let onboardingActive = false;
    try {
      const obCfg = !antiVpnGate ? await OnboardingConfig.findOne({ guildId: guild.id, enabled: true }) : null;
      if (obCfg) {
        const { startOnboarding } = require('../../utils/onboardingManager');
        await startOnboarding(member, obCfg, client);
        onboardingActive = true; // le message de bienvenue classique attendra la fin du portail
      }
    } catch (err) { console.error('guildMemberAdd onboarding:', err); }

    // ── CAPTCHA (priorité absolue si activé) ──────────────────────────────
    // La porte ne se contourne pas : elle s'applique aussi quand le salon est
    // introuvable — sendCaptcha refuse alors l'accès au lieu de laisser passer.
    // Tant qu'elle est active, les auto-rôles « arrivée » sont différés : ils
    // sont posés par le captcha une fois la vérification réussie.
    let captchaGate = false;
    try {
      const captchaCfg = !antiVpnGate ? await CaptchaConfig.findOne({ guildId: guild.id, enabled: true }) : null;
      if (captchaCfg) {
        captchaGate = true;
        const { sendCaptcha } = require('../../commands/configuration/captcha');
        const outcome = await sendCaptcha(member, captchaCfg, client);
        if (outcome === 'kicked') return; // membre déjà dehors : rien d'autre à faire
      }
    } catch (err) { console.error('guildMemberAdd captcha:', err); }

    // ── Détection d'invitation — UNE seule fois, partagée par Bienvenue+ et
    //    les annonces avancées (le second appel ne verrait aucun delta) ─────
    let inviteDetection = { code: null, inviterId: null, inviterTag: 'Inconnu', method: 'unknown' };
    try {
      inviteDetection = await resolveInviteForJoin(guild);
    } catch (err) { console.error('guildMemberAdd inviteCache:', err.message); }

    // ── Bienvenue+ (message, image canvas, MP, boutons, compteur, stats) ────
    try {
      const welcome = !onboardingActive && !antiVpnGate ? await Welcome.findOne({ guildId: guild.id, enabled: true }) : null;
      if (welcome) {
        const {
          sendWelcome, sendWelcomeDM, updateMemberCounter, recordJoinStats,
        } = require('../../utils/welcomeManager');

        const ctx = {
          member, guild, client,
          inviterId: inviteDetection.inviterId || null,
          inviteCode: inviteDetection.code || null,
          inviteCount: null,
        };
        if (ctx.inviterId) {
          ctx.inviteCount = await InviteUse.countDocuments({
            guildId: guild.id,
            inviterId: ctx.inviterId,
            left: false,
            fake: false,
          });
        }

        await sendWelcome(member, welcome, ctx);
        await sendWelcomeDM(member, welcome, ctx);
        await updateMemberCounter(guild, welcome);
        await recordJoinStats(Welcome, guild);
      }
    } catch (err) { console.error('guildMemberAdd bienvenue:', err.message); }

    // ── Auto-Rôle join (du nouveau système autorole.js) ───────────────────
    // Différés quand le captcha est actif : sinon un rôle d'accès distribué à
    // l'arrivée vaudrait vérification. Ils sont attribués à la réussite du
    // captcha (captcha.js → applyJoinRoles).
    if (!captchaGate && !antiVpnGate) {
      try {
        const AutoRole = require('../../models/AutoRole');
        const roles = await AutoRole.find({ guildId: guild.id, type: 'join', enabled: true });
        for (const ar of roles) {
          member.roles.add(ar.roleId).catch(() => {});
        }
      } catch (_) {}
    }

    // ── Tracking invitations ───────────────────────────────────────────────
    try {
      const invites = await guild.invites.fetch();
      for (const [code, inv] of invites) {
        const dbInv = await Invite.findOne({ code, guildId: guild.id });
        if (!dbInv) {
          const inviter = inv.inviter || { tag: 'Inconnu' };
          await Invite.create({
            code, guildId: guild.id,
            createdBy: inviter.id || 'unknown',
            createdByTag: inviter.tag,
            uses: inv.uses || 0,
          });
        } else if (inv.uses > dbInv.uses) {
          dbInv.uses = inv.uses;
          await dbInv.save();
        }
      }
    } catch (_) {}

    // ── Système d'invitations avancé (qui a invité qui) ────────────────────
    try {
      const invCfg = await InviteConfig.findOne({ guildId: guild.id });
      const enabled = invCfg?.enabled !== false; // activé par défaut si pas de config

      if (enabled) {
        // Déjà résolue en tête d'event et partagée avec Bienvenue+ (le cache
        // est déjà à jour — re-résoudre donnerait 'unknown')
        const detection = inviteDetection;
        const ignored = invCfg?.ignoredCodes || [];
        const isIgnored = detection.code && ignored.includes(detection.code);

        // Anti-fake : compte trop jeune
        const minAgeDays = invCfg?.minAccountAgeDays || 0;
        const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
        const isFake = minAgeDays > 0 && accountAgeDays < minAgeDays;

        if (!isIgnored) {
          // Un membre déjà présent ne doit pas cumuler deux invitations actives :
          // départ manqué pendant un arrêt du bot, ou ré-arrivée après un leave
          // non traité. Les entrées précédentes sont closes avant la nouvelle.
          await InviteUse.updateMany(
            { guildId: guild.id, userId: member.id, left: false },
            { $set: { left: true, leftAt: new Date() } },
          ).catch(() => {});

          await InviteUse.create({
            guildId: guild.id,
            userId: member.id,
            userTag: member.user.tag,
            inviterId: detection.inviterId,
            inviterTag: detection.inviterTag,
            code: detection.code,
            method: detection.method,
            fake: isFake,
            left: false,
          });

          // ── Stats + rang après création ──────────────────────────────────
          const stats = detection.inviterId
            ? await computeInviteStats(guild.id, detection.inviterId)
            : { joins: 0, active: 0, leaves: 0, fakes: 0 };
          const rank = detection.inviterId
            ? await getInviteRank(guild.id, detection.inviterId, stats.active)
            : null;
          const accountAge = accountAgeOf(member.user);
          const milestone = !isFake
            ? milestoneFor(stats.active, invCfg?.milestoneStep || 0)
            : null;

          // ── Récompense coins (invitation valide uniquement) ──────────────
          const coinsEarned = (!isFake && detection.inviterId)
            ? await grantInviteCoins(guild.id, detection.inviterId, invCfg?.rewardCoins || 0)
            : 0;

          // ── Rôles bonus ──────────────────────────────────────────────────
          let inviterMember = null;
          if (detection.inviterId) {
            inviterMember = guild.members.cache?.get?.(detection.inviterId)
              || await guild.members.fetch(detection.inviterId).catch(() => null);
            if (inviterMember) {
              for (const r of eligibleRewardRoles(invCfg?.rewardRoles, stats.active)) {
                if (!inviterMember.roles.cache.has(r.roleId)) {
                  await inviterMember.roles.add(r.roleId).catch(() => {});
                }
              }
            }
          }

          // ── Annonce d'arrivée enrichie (embed + carte) ──────────────────
          if (invCfg?.announceChannelId && invCfg.announceJoin !== false) {
            const ch = guild.channels.cache?.get?.(invCfg.announceChannelId)
              || await guild.channels.fetch(invCfg.announceChannelId).catch(() => null);
            if (ch?.isTextBased()) {
              const embed = buildJoinEmbed({
                guild,
                member,
                inviterId: detection.inviterId,
                inviterTag: detection.inviterTag,
                code: detection.code,
                method: detection.method,
                stats,
                rank,
                isFake,
                cfg: invCfg,
                accountAge,
                accountCreatedTs: member.user.createdTimestamp,
                milestone,
                coins: coinsEarned,
              });

              let card = null;
              if (invCfg.useCardOnJoin !== false && detection.inviterId) {
                card = await renderInviteCardSafe({
                  member: inviterMember || { user: { username: detection.inviterTag, displayAvatarURL: () => null } },
                  guild,
                  stats,
                  rank,
                  caption: `${member.user.username} a rejoint grâce à toi`,
                });
              }

              const payload = { embeds: [embed] };
              if (card) {
                embed.setImage(`attachment://${INVITE_CARD_FILENAME}`);
                payload.files = [new AttachmentBuilder(card, { name: INVITE_CARD_FILENAME })];
              }
              await ch.send(payload).catch(() => {});
            }
          }

          // ── Palier atteint : carte + MP de félicitations à l'inviteur ────
          if (milestone && detection.inviterId && invCfg?.milestoneDm !== false) {
            const inviter = inviterMember || await guild.members.fetch(detection.inviterId).catch(() => null);
            if (inviter) {
              const milestoneEmbed = new EmbedBuilder()
                .setColor(COLORS.success)
                .setAuthor({ name: 'Palier d’invitations atteint' })
                .setTitle(`🏆 ${milestone} invitations actives !`)
                .setDescription(`Tu viens d’atteindre **${milestone} invitation(s) active(s)** sur **${guild.name}**. Merci de faire grandir la communauté ! 🎉`)
                .addFields(
                  { name: '🏅 Rang', value: `**${rank ? `#${rank}` : '—'}**`, inline: true },
                  { name: '📊 Invitations actives', value: `**${stats.active}**`, inline: true },
                  { name: '🎁 Récompense', value: coinsEarned > 0 ? `🪙 +${coinsEarned} coins` : '*Aucune*', inline: true },
                )
                .setFooter({ text: 'REZO • Invitations' })
                .setTimestamp();

              const milestoneCard = await renderInviteCardSafe({
                member: inviter,
                guild,
                stats,
                rank,
                headline: 'PALIER ATTEINT',
                caption: `${milestone} invitations actives sur ${guild.name}`,
              });
              if (milestoneCard) milestoneEmbed.setImage(`attachment://${INVITE_CARD_FILENAME}`);

              await inviter.send({
                embeds: [milestoneEmbed],
                files: milestoneCard ? [new AttachmentBuilder(milestoneCard, { name: INVITE_CARD_FILENAME })] : [],
              }).catch(() => {});
            }
          }
        }
      }
    } catch (err) { console.error('guildMemberAdd invites-avancé:', err); }

    // ── Centre de notifications — abonnés « Nouveaux membres » ─────────────
    // Désactivé par défaut dans la config : sur un gros serveur, ce type
    // génère un message par arrivée.
    try {
      const { sendNotification } = require('../../utils/notificationManager');
      await sendNotification(
        client,
        guild.id,
        'members',
        new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('👥 Nouveau membre')
          .setDescription(`<@${member.id}> a rejoint **${guild.name}**.`)
          .addFields(
            { name: '👤 Compte',    value: `${member.user.tag}`, inline: true },
            { name: '📥 Membre n°', value: `${guild.memberCount}`, inline: true },
            {
              name: '🎟️ Invité par',
              value: inviteDetection.inviterId ? `<@${inviteDetection.inviterId}>` : 'Inconnu',
              inline: true,
            },
          )
          .setThumbnail(member.user.displayAvatarURL())
          .setTimestamp(),
        `Nouveau membre : ${member.user.tag}`,
      );
    } catch (err) { console.error('membres notif:', err.message); }

    // ── ModLog ─────────────────────────────────────────────────────────────
    try {
      const { sendModLog, ModlogConfig } = require('../../commands/moderation/modlog');
      const mlCfg = await ModlogConfig.findOne({ guildId: guild.id, enabled: true });
      if (mlCfg?.events?.memberJoin !== false) {
        await sendModLog(client, guild.id, new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('👋 Membre rejoint')
          .setDescription(`<@${member.id}> a rejoint le serveur.`)
          .addFields(
            { name: '👤 Utilisateur', value: `${member.user.tag} (\`${member.id}\`)`, inline: true },
            { name: '📅 Compte créé', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
          )
          .setThumbnail(member.user.displayAvatarURL())
          .setTimestamp()
        );
      }
    } catch (_) {}

    // ── Logs configurables : arrivée de membre (Feature 3) ────────────────
    try {
      const GuildLogs = require('../../models/GuildLogs');
      const logsCfg = await GuildLogs.findOne({ guildId: guild.id });
      if (logsCfg?.membres?.enabled && logsCfg.membres.channelId) {
        const ch = await guild.channels.fetch(logsCfg.membres.channelId).catch(() => null);
        if (ch?.isTextBased()) {
          await ch.send({
            embeds: [new EmbedBuilder()
              .setColor(0x57F287)
              .setTitle('📥 Arrivée d\'un membre')
              .addFields(
                { name: '👤 Utilisateur', value: `${member.user.tag} (\`${member.id}\`)`, inline: true },
                { name: '📅 Compte créé', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
              )
              .setThumbnail(member.user.displayAvatarURL())
              .setTimestamp()
            ],
          }).catch(() => {});
        }
      }
    } catch (_) {}
    // ── (L'ancien « raid mode automatique » a été remplacé par le système
    //    anti-raid complet : src/events/membres/antiraid.js + /antiraid) ──

    console.log(`✅ ${member.user.tag} a rejoint ${guild.name}`);
  },
};
