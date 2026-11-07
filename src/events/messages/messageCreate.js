// events/messageCreate.js — AutoMod + XP + ping bot
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { COLORS } = require('../../utils/embeds');
const blacklist = require('../../utils/blacklist');
const configCache = require('../../utils/guildConfigCache');
const { createBoundedCache } = require('../../utils/boundedCache');

// Lecture de configuration de serveur MISE EN CACHE : avant, chaque message
// déclenchait une dizaine de requêtes MongoDB (« ce serveur a-t-il activé ce
// module ? »), ce qui sature la base dès quelques milliers de serveurs. Les
// entrées sont bornées, expirent seules, et sont purgées dès qu'une commande
// écrit la configuration (hooks Mongoose — voir utils/guildConfigCache).
const readConfig = configCache.registerModel;

// Repère « premier message du jour » de l'auto-thread : borné et expirant.
// Une Map nue grandissait avec le nombre de serveurs × salons × membres.
const firstMessageOfDay = createBoundedCache({ max: 20_000, ttl: 26 * 3600_000, name: 'first-msg-day' });

module.exports = {
  name: 'messageCreate',

  // Contexte d'identité du serveur : les embeds créés par les commandes
  // préfixées et les réponses de salon héritent du branding du serveur.
  async execute(message, client) {
    // DM et messages de bots : aucun branding à charger (et un message de bot
    // ne doit pas déclencher une lecture base inutile).
    if (!message.guild || message.author?.bot) return module.exports.handle(message, client);
    const guildBrand = require('../../utils/guildBrand');
    await guildBrand.prime(message.guild.id).catch(() => {});
    return guildBrand.runWith(message.guild.id, client, () => module.exports.handle(message, client));
  },

  async handle(message, client) {

    // ── Message partiel ───────────────────────────────────────────────────
    // Avec `Partials.Message`, un message dont le salon/serveur n'est pas en
    // cache arrive SANS auteur et SANS `webhookId` : l'anti-spam webhook ne le
    // voyait pas, et `message.author.bot` levait une exception un peu plus bas.
    // On rachète le message une fois, puis tout le reste est normal.
    if (message.partial) {
      try {
        await message.fetch();
      } catch {
        return; // introuvable ou supprimé entre-temps : rien à protéger
      }
    }

    // ── Blacklist globale — ignore tout message de serveur blacklisté ─────
    if (message.guild && blacklist.isBlacklisted(message.guildId)) return;

    // ── Anti-raid : honeypots — écrire dans un salon-piège = bot confirmé ──
    if (message.guild && !message.author.bot) {
      try {
        const { AntiRaidHoneypot } = require('../../models/AntiRaid');
        // Absences mémorisées uniquement : le document est modifié puis sauvegardé
        // lors d'un déclenchement (utils/antiraidActions), il doit rester vivant.
        const hp = await readConfig(AntiRaidHoneypot, { cacheHits: false })({
          guildId: message.guild.id, channelId: message.channel.id,
        });
        if (hp) {
          const { triggerHoneypot } = require('../../utils/antiraidActions');
          await triggerHoneypot(client, message.guild, hp, message.author.id);
          await message.delete().catch(() => {});
          return;
        }
      } catch (err) { console.error('[anti-raid] honeypot:', err.message); }
    }


    // ── Portail d'accès — réponse texte à l'étape en cours ────────────────
    if (message.guild && !message.author.bot) {
      try {
        const { handleMemberMessage } = require('../../utils/onboardingManager');
        if (await handleMemberMessage(message)) return;
      } catch (err) { console.error('onboarding message:', err.message); }
    }

    // ── ModMail — Messages privés (DM) ────────────────────────────────────
    if (!message.guild && !message.author.bot) {
      try {
        if (message.partial) await message.fetch().catch(() => {});

        const { ModMailConfig } = require('../../models/ModMail');
        const { openThread, relayToThread } = require('../../commands/moderation/modmail');
        const { ModMailThread } = require('../../models/ModMail');

        const existingThread = await ModMailThread.findOne({
          userId: message.author.id,
          status: 'open',
        });

        if (existingThread) {
          const config = await ModMailConfig.findOne({ guildId: existingThread.guildId, enabled: true });
          if (config) {
            const guild = client.guilds.cache.get(existingThread.guildId);
            if (guild) {
              await relayToThread(client, message, existingThread, config, guild);
              return;
            }
          }
        }

        const configs = await ModMailConfig.find({ enabled: true });
        let handled = false;

        for (const cfg of configs) {
          const guild = client.guilds.cache.get(cfg.guildId);
          if (!guild) continue;

          let isMember = guild.members.cache.has(message.author.id);
          if (!isMember) {
            const fetched = await guild.members.fetch(message.author.id).catch(() => null);
            isMember = !!fetched;
          }
          if (!isMember) continue;

          await openThread(client, message, cfg.guildId);
          handled = true;
          break;
        }

        if (!handled) {
          await message.author.send({
            embeds: [new EmbedBuilder()
              .setColor(0xED4245)
              .setTitle('⚠️ ModMail indisponible')
              .setDescription("Vous n'êtes membre d'aucun serveur utilisant REZO ModMail, ou le système est désactivé.")],
          }).catch(() => {});
        }
      } catch (err) {
        console.error('ModMail DM:', err.message);
      }
      return;
    }

    // ── Anti-spam WEBHOOKS — AVANT le retour « auteur = bot » ───────────────
    // Un webhook est publié avec `author.bot = true` : il sortait donc ici,
    // totalement hors de portée de l'auto-modération. C'était le vecteur de
    // spam le plus simple à exploiter (aucun compte à sanctionner). Le moteur
    // ne coûte aucune requête quand le garde-fou est désactivé.
    if (message.guild && message.webhookId) {
      try {
        const { handleWebhookMessage } = require('../../utils/antiSpam');
        await handleWebhookMessage(message, client);
      } catch (err) {
        console.error('❌ Anti-spam webhook:', err.message);
      }
      // Un message de webhook n'a ni XP, ni préfixe, ni pont : on s'arrête là.
      return;
    }

    if (message.author.bot || !message.guild) return;

    // ── Anti-ping : @everyone, @here, mentions de rôles/membres en masse ────
    // Avant tout le reste : un message qui ping tout le serveur n'a besoin ni
    // d'XP, ni de préfixe, ni de réponse — il doit disparaître et être
    // sanctionné. Le garde ne coûte aucune requête quand la configuration est
    // en cache (60 s), et il ne filtre jamais un membre autorisé à mentionner
    // @everyone.
    try {
      const { handleMessage: guardPings } = require('../../utils/pingGuard');
      if (await guardPings(message)) return;
    } catch (err) {
      console.error('❌ Anti-ping:', err.message);
    }

    // ── Préfixe hybride (b!ping → /ping) — avant tout le reste ─────────────
    // Ne s'active que si le serveur a activé un préfixe via /prefix. Si le
    // message est une commande préfixée (même inconnue), on s'arrête là :
    // le préfixe court-circuite XP, AutoMod, counting, relais, etc.
    let ownPrefix = null;
    try {
      const { handlePrefixMessage, getGuildConfig } = require('../../utils/prefixCommands');
      const cfg = await getGuildConfig(message.guildId);
      ownPrefix = cfg?.prefix || null;
      if (cfg && message.content?.startsWith(cfg.prefix)) {
        const handled = await handlePrefixMessage(message, client);
        if (handled) return;
      }
    } catch (err) {
      console.error('❌ Préfixe:', err.message);
    }

    // ── Anti-spam des commandes d'AUTRES bots (`!play`, `?rank`…) ──────────
    // Ce sont des messages de texte pour nous, mais des commandes pour un
    // voisin : aucune protection ne les comptait. Une rafale est supprimée et
    // journalisée, sans sanction (l'auteur n'a fait qu'utiliser un autre bot).
    try {
      const { guardExternalCommand } = require('../../utils/antiSpam');
      const guard = await guardExternalCommand(message, client, { ownPrefix });
      if (guard.handled) return;
    } catch (err) {
      console.error('❌ Anti-spam commandes externes:', err.message);
    }

    // ── Counting Game (comptage collaboratif) ──────────────────────────────
    try {
      const { handleCountingMessage } = require('../../utils/countingGame');
      const handled = await handleCountingMessage(message);
      if (handled) return; // ne pas traiter ce message plus loin (AutoMod, XP, etc.)
    } catch (err) {
      console.error('❌ Counting Game:', err.message);
    }

    // ── Honeypot (salon piège anti-bot / anti-token-grabber) ───────────────
    try {
      const Honeypot = require('../../models/Honeypot');
      const hpCfg = await readConfig(Honeypot)({ guildId: message.guild.id, enabled: true });
      if (hpCfg && hpCfg.channelIds.includes(message.channel.id)) {
        const { handleTrigger } = require('../../commands/moderation/honeypot');
        await handleTrigger(message, hpCfg);
        return; // ne pas traiter ce message plus loin (AutoMod, XP, etc.)
      }
    } catch (err) {
      console.error('❌ Honeypot — erreur complète ci-dessous :');
      console.error(err);
    }

    // ── Assistant IA — salons activés via /ia ─────────────────────────────
    // Une fois un salon activé, le bot répond à CHAQUE message : plus besoin de
    // commande pour discuter. La config est mise en cache 30 s, donc un message
    // ordinaire ne coûte pas une requête en base.
    try {
      const { findAiConfig } = require('../../utils/aiConfig');
      const aiCfg = await findAiConfig(message.guild.id);
      if (aiCfg?.enabled && aiCfg.channelIds?.includes(message.channel.id)) {
        const { handleAiPlaygroundMessage } = require('../../utils/aiPlaygroundHandler');
        await handleAiPlaygroundMessage(message, aiCfg, client);
        return; // salon IA : ne pas traiter plus loin (AutoMod, XP, etc.)
      }
    } catch (err) {
      console.error('❌ Assistant IA — erreur complète ci-dessous :');
      console.error(err);
    }

    // ── Demande de MP (salon "boîte de demandes" -> embed + fil) ──────────────
    try {
      const MpRequestConfig = require('../../models/MpRequestConfig');
      // Même raison que le honeypot : la configuration est incrémentée puis
      // sauvegardée à chaque demande (utils/mpRequestHandler).
      const mpCfg = await readConfig(MpRequestConfig, { cacheHits: false })({
        guildId: message.guild.id, enabled: true, channelId: message.channel.id,
      });
      if (mpCfg) {
        const { handleMpRequestMessage } = require('../../utils/mpRequestHandler');
        await handleMpRequestMessage(message, mpCfg);
        return; // salon dédié : ne pas traiter plus loin (AutoMod, XP, etc.)
      }
    } catch (err) {
      console.error('❌ Demande de MP — erreur complète ci-dessous :');
      console.error(err);
    }

    // ── Ping du bot (VERSION MODERNISÉE + NO PING USER) ───────────────────
    if (
      message.mentions.has(client.user) &&
      message.content.trim().replace(/\s/g, '') === `<@${client.user.id}>`
    ) {
      const Server = require('../../models/Server');
      // Compteurs de bump : durée de vie courte, l'affichage doit rester frais.
      const bumpStats = await readConfig(Server, { ttl: 15_000, negTtl: 60_000 })({ guildId: message.guild.id });
      const bumpCount = Number(bumpStats?.bumpCount || 0);

      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setAuthor({
          name: `✨ ${client.user.username}`,
          iconURL: client.user.displayAvatarURL()
        })
        .setTitle('👋 **Hey, tu m’as ping ?**')
        .setDescription([
          'Je suis **REZO**, le système tout‑en‑un qui fait grandir ta communauté Discord.',
          '',
          '➡️ **Besoin d’aide ?** Utilise `/help` pour voir toutes mes fonctionnalités.',
          '',
          '⚡ *Toujours prêt à faire grandir ton serveur.*'
        ].join('\n'))
        .addFields(
          {
            name: '🚀 Démarrage rapide',
            value: [
              '`/setting` → Configurer le serveur',
              '`/bump` → Rejoindre le réseau',
              '`/help` → Toutes les commandes'
            ].join('\n'),
            inline: true
          },
          {
            name: '🛡️ Sécurité',
            value: [
              '`/captcha` → Vérification humaine',
              '`/securite` → Anti‑spam / anti‑liens / filtre de mots'
            ].join('\n'),
            inline: true
          },
          {
            name: '📊 Statistiques globales',
            value: [
              `🌍 Serveurs protégés : **${client.guilds.cache.size}**`,
              `🚀 Bumps enregistrés ici : **${bumpCount}**`,
              `🔔 Rappels de bump : ${bumpStats?.reminderEnabled === false ? '🔴 désactivés' : '🟢 activés'}`
            ].join('\n'),
            inline: false
          }
        )
        .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
       .setImage('https://media.discordapp.net/attachments/1519886439964475463/1527847149889523772/ee4f41acd8a78e41af9f85c7110e7885.webp?ex=6a5c260a&is=6a5ad48a&hm=3388dc2a78657de5ef89e1e4d6d063519ceb676caa9c6596cc989c2ea2490ba6&=&format=webp&width=768&height=270')
        .setFooter({
          text: `REZO • Latence : ${client.ws.ping}ms`,
          iconURL: client.user.displayAvatarURL()
        })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('⚙️ Panel config')
          .setStyle(ButtonStyle.Primary)
          .setCustomId('ping_open_panel'),

        new ButtonBuilder()
          .setLabel('📖 Aide')
          .setStyle(ButtonStyle.Secondary)
          .setCustomId('ping_open_help'),

        new ButtonBuilder()
          .setLabel('🔗 Inviter REZO')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`)
      );

      await message.reply({
        embeds: [embed],
        components: [row],
        allowedMentions: { repliedUser: false } // ← empêche le ping du membre
      }).catch(() => {});
      return;
    }

    // ── AutoMod ───────────────────────────────────────────────────────────
    try {
      const AutoMod = require('../../models/AutoMod');
      const cfg = await readConfig(AutoMod)({ guildId: message.guild.id });
      // Portail large : toute protection activée déclenche le contrôle (les
      // doublons et mentions sont traités par le moteur avancé juste après).
      const active = cfg && (cfg.spamEnabled || cfg.linksEnabled || cfg.capsEnabled
        || cfg.duplicateEnabled || cfg.mentionLimit > 0);
      if (active) {
        const { handleMessage: autoModHandle } = require('../../commands/moderation/automod');
        await autoModHandle(message);
      }
    } catch (err) {
      // Une erreur d'auto-modération ne doit pas bloquer le message suivant,
      // mais elle ne doit plus être invisible : sinon un module cassé passe
      // pour un module inactif.
      console.error('❌ AutoMod:', err.message);
    }

    // ── Pont inter-serveurs — le message part vers les autres serveurs ─────
    // Après AutoMod : un message retenu par la modération ne doit pas quitter
    // le serveur. Le moteur sort immédiatement (sans requête) si ce salon n'est
    // pas un salon du pont.
    try {
      const bridge = require('../../utils/bridgeEngine');
      await bridge.relayMessage(message, client);
    } catch (err) {
      console.error('❌ Pont inter-serveurs:', err.message);
    }

    // ── Trésors cachés — devinette du coffre en cours ─────────────────────
    // Le moteur sort immédiatement (sans requête) si aucun coffre n'est ouvert.
    try {
      const { handleTreasureMessage } = require('../../utils/treasureEngine');
      await handleTreasureMessage(message, client);
    } catch (err) {
      console.error('❌ Trésor:', err.message);
    }

    // ── XP ────────────────────────────────────────────────────────────────
    try {
      const { handleMessage: xpHandle } = require('../../commands/xp/xp');
      await xpHandle(message);
    } catch (err) {
      console.error('❌ XP:', err.message);
    }

    // ── Auto-Thread avancé (Feature 1) ─────────────────────────────────────
    try {
      const AutoThread = require('../../models/AutoThread');
      const atCfg = await readConfig(AutoThread)({ guildId: message.guild.id, enabled: true });
      if (atCfg && message.channel && typeof message.startThread === 'function' && !message.hasThread) {
        const inInclude = atCfg.includeChannels.length === 0 || atCfg.includeChannels.includes(message.channel.id);
        const inExclude = atCfg.excludeChannels.includes(message.channel.id);

        if (inInclude && !inExclude) {
          let allowed = true;
          if (atCfg.restrictRoleId) {
            allowed = !!(message.member && message.member.roles.cache.has(atCfg.restrictRoleId));
          }

          if (allowed) {
            let shouldCreate = true;

            if (atCfg.onlyFirstMessagePerUser) {
              const dayKey = new Date().toISOString().slice(0, 10);
              const key = `${message.channel.id}:${message.author.id}:${dayKey}`;
              if (firstMessageOfDay.has(key)) {
                shouldCreate = false;
              } else {
                firstMessageOfDay.set(key, true);
              }
            }

            if (shouldCreate) {
              const threadName = (atCfg.threadNameTemplate || 'Discussion de {username}')
                .replace('{username}', message.author.username)
                .slice(0, 100);

              await message.startThread({
                name: threadName,
                autoArchiveDuration: atCfg.autoArchiveDuration,
                rateLimitPerUser: atCfg.slowmodeSeconds || 0,
              }).catch(() => {});
            }
          }
        }
      }
    } catch (_) {}

    // ── Auto-modération avancée (Feature 2) ─────────────────────────────────
    try {
      const AutoModAdvanced = require('../../models/AutoModAdvanced');
      const advCfg = await readConfig(AutoModAdvanced)({ guildId: message.guild.id });
      if (advCfg && message.member && !message.author.bot) {
        const { handleAdvancedAutoMod } = require('../../utils/automodAdvanced');
        await handleAdvancedAutoMod(message, advCfg).catch(() => {});
      }
    } catch (_) {}

  },
};