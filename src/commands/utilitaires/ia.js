'use strict';
// commands/utilitaires/ia.js — LA commande du système IA de REZO.
//
// Une seule commande, tout dedans : le ou les salons où le bot répond tout seul,
// la personnalité, les limites, la mémoire, les images, la chaîne de modèles de
// secours, le salon « playground » créé à la demande et les statistiques.
//
// Elle a repris le nom /ia : un seul fichier, un seul modèle de données, pour
// que les réglages s'appliquent vraiment partout.
//
// Le salon n'est JAMAIS créé automatiquement : seulement sur action explicite.

const {
  SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits, ChannelType,
} = require('discord.js');

const { getAiConfig, saveAiConfig, defaultModelChain } = require('../../utils/aiConfig');
const { processMessage, resetConversation, providerReport, todayKey } = require('../../utils/aiChat');
const aiMemory = require('../../utils/aiMemory');
const aiStyle = require('../../utils/aiStyle');
const aiWeb = require('../../utils/aiWeb');
const aiEmbeddings = require('../../utils/aiEmbeddings');
const aiImages = require('../../utils/aiImages');
const { parseModelChainInput } = require('../../utils/aiQuotaEngine');
const {
  AI_CHAT_COLOR, buildConfigPanelEmbed, buildStatsEmbed, buildChatReplyEmbed, buildImageEmbed, buildMemoryEmbed,
} = require('../../utils/aiEmbeds');
const { successEmbed, errorEmbed, infoEmbed, COLORS } = require('../../utils/embeds');
const { AVAILABLE_MODELS } = require('../../utils/geminiClient');
const AiDailyStats = require('../../models/AiDailyStats');

const COLLECTOR_TIMEOUT_MS = 15 * 60 * 1000;
const CHANNEL_NAME = 'ia';

async function getTodayStats(guildId) {
  return AiDailyStats.findOne({ guildId, date: todayKey() }).catch(() => null);
}

async function getRecentDays(guildId, days = 7) {
  const docs = await AiDailyStats.find({ guildId }).sort({ date: -1 }).limit(days).catch(() => []);
  return (docs || []).reverse();
}

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

// ════════════════════════════════════════════════════════════════════════════
//  Panel de configuration
// ════════════════════════════════════════════════════════════════════════════
function buildPanelComponents(cfg) {
  return [
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('ai_add_channel')
        .setPlaceholder('➕ Ajouter un salon où je réponds tout seul…')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(5),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ai_model')
        .setPlaceholder('🤖 Choisir le modèle préféré…')
        .addOptions(AVAILABLE_MODELS.map((m) => ({ label: m.label.slice(0, 100), value: m.value, default: m.value === cfg.model }))),
    ),
    new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('ai_add_role')
        .setPlaceholder('🔐 Restreindre à un rôle (optionnel)…'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ai_toggle').setLabel(cfg.enabled ? 'Désactiver' : 'Activer').setEmoji(cfg.enabled ? '⏸️' : '▶️').setStyle(cfg.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ai_prompt').setLabel('Personnalité').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ai_advanced').setLabel('Réglages').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ai_memory').setLabel(cfg.memoryEnabled === false ? 'Mémoire : off' : 'Mémoire : on').setEmoji('🧠').setStyle(cfg.memoryEnabled === false ? ButtonStyle.Danger : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ai_chain').setLabel('Modèles de secours').setEmoji('🎯').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ai_salon').setLabel(cfg.playgroundChannelId ? 'Supprimer le salon' : 'Créer le salon').setEmoji(cfg.playgroundChannelId ? '🗑️' : '🛝').setStyle(cfg.playgroundChannelId ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ai_clear_channels').setLabel('Vider les salons').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ai_clear_roles').setLabel('Autoriser tout le monde').setEmoji('👥').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('ai_stats').setLabel('Statistiques').setEmoji('📊').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ai_features').setLabel('Fonctions').setEmoji('🧩').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** Crée le salon de discussion dédié et l'active tout de suite. */
async function createPlaygroundChannel(guild, cfg) {
  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return { error: 'Le bot a besoin de la permission **Gérer les salons** pour créer le salon.' };
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: '🤖 Discutez librement — réponses de REZO en embeds, images sur simple demande',
      rateLimitPerUser: cfg.slowmodeSeconds ?? 5,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [
            PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
          ],
          deny: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.MentionEveryone],
        },
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ],
    });
  } catch (err) {
    return { error: `Discord a refusé la création du salon : ${err.message}` };
  }

  cfg.playgroundChannelId = channel.id;
  if (!cfg.channelIds.includes(channel.id)) cfg.channelIds.push(channel.id);
  cfg.enabled = true; // un salon de discussion n'a d'intérêt que si l'IA répond

  await channel.send({
    embeds: [new (require('discord.js').EmbedBuilder)()
      .setColor(AI_CHAT_COLOR)
      .setTitle('🤖 C’est prêt — écrivez, je réponds')
      .setDescription('Posez simplement votre question ici, pas besoin de commande.\nPour une image, demandez-la normalement : « *génère-moi une image de soleil au coucher* ».')
      .setFooter({ text: 'REZO • nova_lead_' })],
  }).catch(() => {});

  return { channel };
}

// ════════════════════════════════════════════════════════════════════════════
//  Vue « statistiques » (auto-actualisée)
// ════════════════════════════════════════════════════════════════════════════
async function renderStats(guild, cfg) {
  const [today, recent, report, memory] = await Promise.all([
    getTodayStats(guild.id),
    getRecentDays(guild.id),
    providerReport().catch(() => []),
    aiMemory.memoryOverview(guild.id),
  ]);
  const embed = buildStatsEmbed(guild, cfg, today, recent, report, memory);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ai_stats_close').setLabel('Fermer').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('ia')
    .setDescription('🤖 Tout l’assistant IA : chat, images, mémoire, salon, réglages, stats')
    .addSubcommand((s) => s.setName('panel').setDescription('⚙️ Configurer l’IA du serveur *(Admin)*'))
    .addSubcommand((s) => s.setName('stats').setDescription('📊 Statistiques et état des moteurs *(Admin)*'))
    .addSubcommand((s) => s
      .setName('salon')
      .setDescription('🛝 Créer ou supprimer le salon de discussion *(Admin)*')
      .addStringOption((o) => o
        .setName('action')
        .setDescription('Créer ou supprimer le salon')
        .setRequired(true)
        .addChoices({ name: 'Créer', value: 'creer' }, { name: 'Supprimer', value: 'supprimer' })))
    .addSubcommand((s) => s
      .setName('chat')
      .setDescription('💬 Poser une question sans passer par un salon')
      .addStringOption((o) => o.setName('message').setDescription('Votre question').setRequired(true).setMaxLength(1500)))
    .addSubcommand((s) => s
      .setName('image')
      .setDescription('🖼️ Générer une image à partir d’une description')
      .addStringOption((o) => o.setName('description').setDescription('Ce que vous voulez voir').setRequired(true).setMaxLength(600))
      .addStringOption((o) => o
        .setName('format')
        .setDescription('Format de l’image')
        .addChoices(
          { name: 'Carré (par défaut)', value: 'carre' },
          { name: 'Paysage', value: 'paysage' },
          { name: 'Portrait', value: 'portrait' },
        ))
      .addStringOption((o) => o
        .setName('style')
        .setDescription('Rendu souhaité')
        .addChoices(
          { name: 'Photo réaliste', value: 'photo' },
          { name: 'Illustration', value: 'art' },
          { name: 'Anime', value: 'anime' },
          { name: 'Rendu 3D', value: '3d' },
          { name: 'Dessin au trait', value: 'dessin' },
          { name: 'Logo', value: 'logo' },
          { name: 'Peinture', value: 'peinture' },
          { name: 'Aucun', value: 'aucun' },
        ))
      .addIntegerOption((o) => o.setName('seed').setDescription('Graine, pour retomber sur la même image')))
    .addSubcommand((s) => s
      .setName('memoire')
      .setDescription('🧠 Voir ou effacer ce que l’IA retient de vous')
      .addStringOption((o) => o
        .setName('action')
        .setDescription('Que faire de votre mémoire ?')
        .addChoices(
          { name: 'Voir', value: 'voir' },
          { name: 'Oublier', value: 'oublier' },
          { name: 'État du serveur (Admin)', value: 'etat' },
        )))
    .addSubcommand((s) => s.setName('reset').setDescription('🔄 Repartir de zéro avec l’IA'))
    .addSubcommand((s) => s
      .setName('style')
      .setDescription('🎨 Apprendre le style d’écriture du serveur *(Admin)*')
      .addChannelOption((o) => o
        .setName('salon')
        .setDescription('Salon à analyser (défaut : le salon courant)')
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s
      .setName('recherche')
      .setDescription('🌐 Chercher sur le web et obtenir un résumé sourcé')
      .addStringOption((o) => o.setName('requete').setDescription('Ce que vous cherchez').setRequired(true).setMaxLength(300))),

  async execute(interaction, client = null) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // ── /ia chat ───────────────────────────────────────────────
    if (sub === 'chat') {
      await interaction.deferReply();
      const message = interaction.options.getString('message');
      const userName = interaction.member?.displayName || interaction.user.username;
      try {
        const cfg = await getAiConfig(guild.id);
        const result = await processMessage({ guild, member: interaction.member, content: message, userName, config: cfg, client });
        return interaction.editReply({ embeds: [buildChatReplyEmbed({ question: message, answer: result.text, userName: result.userName || userName })] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Erreur', err.message)] });
      }
    }

    // ── /ia image ──────────────────────────────────────────────
    if (sub === 'image') {
      await interaction.deferReply();
      const prompt = interaction.options.getString('description');
      const size = interaction.options.getString('format') || aiImages.DEFAULT_SIZE;
      const style = interaction.options.getString('style') || aiImages.DEFAULT_STYLE;
      const seed = interaction.options.getInteger('seed');
      const userName = interaction.member?.displayName || interaction.user.username;

      try {
        const image = await aiImages.generateImage({ prompt, size, style, seed });
        const extension = image.mime.includes('png') ? 'png' : 'jpg';
        const fileName = `rezo-${interaction.user.id}-${Date.now()}.${extension}`;

        const sent = await interaction.editReply({
          embeds: [buildImageEmbed({
            prompt, userName, attachmentName: fileName,
            styleLabel: image.style, sizeLabel: image.sizeLabel, responseMs: image.responseMs,
          })],
          files: [new AttachmentBuilder(image.buffer, { name: fileName })],
        });

        const mem = await aiMemory.getMemory(guild.id, interaction.user.id, userName);
        await aiMemory.touchMemory(mem, { displayName: userName, kind: 'image', topic: prompt });
        return sent;
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('Image non générée', err.message || 'Réessayez dans un instant.')] });
      }
    }

    // ── /ia memoire ────────────────────────────────────────────
    if (sub === 'memoire') {
      await interaction.deferReply({ ephemeral: true });
      const action = interaction.options.getString('action') || 'voir';
      const userName = interaction.member?.displayName || interaction.user.username;

      if (action === 'etat') {
        if (!isAdmin(interaction)) {
          return interaction.editReply({ embeds: [errorEmbed('Permission refusée', 'Réservé aux membres avec la permission *Gérer le serveur*.')] });
        }
        const overview = await aiMemory.memoryOverview(guild.id);
        const cfg = await getAiConfig(guild.id);
        return interaction.editReply({
          embeds: [infoEmbed('🧠 État de la mémoire', overview
            ? [
              `**Profils suivis** : ${overview.profiles}`,
              `**Dont avec un résumé écrit** : ${overview.summarized}`,
              `**Dernier membre vu** : ${overview.latest?.displayName || '*—*'} (${overview.latest ? aiMemory.humanizeSince(overview.latest.lastSeenAt) : '—'})`,
              `**Mémoire** : ${cfg.memoryEnabled === false ? '🔴 désactivée sur ce serveur' : '🟢 activée'}`,
              '',
              'Un résumé s’écrit tous les quelques échanges ; s’il reste vide alors que des échanges ont eu lieu, l’écriture en base échoue (voir les logs du bot).',
            ].join('\n')
            : 'Base de données injoignable — la mémoire ne peut pas être lue. Les réponses de l’IA continuent de fonctionner sans mémoire.')],
        });
      }

      if (action === 'oublier') {
        await aiMemory.clearMemory(guild.id, interaction.user.id);
        await aiEmbeddings.forget({ guildId: guild.id, userId: interaction.user.id });
        await resetConversation(guild.id, interaction.user.id);
        return interaction.editReply({ embeds: [buildMemoryEmbed(null, { action: 'oublier' })] });
      }

      const mem = await aiMemory.getMemory(guild.id, interaction.user.id, userName);
      return interaction.editReply({ embeds: [buildMemoryEmbed(mem)] });
    }

    // ── /ia reset ──────────────────────────────────────────────
    if (sub === 'reset') {
      await interaction.deferReply({ ephemeral: true });
      await resetConversation(guild.id, interaction.user.id);
      return interaction.editReply({ embeds: [successEmbed('Conversation réinitialisée', 'L’IA repart de zéro pour cette conversation. Sa mémoire longue (qui vous êtes) est conservée — `/ia memoire` pour l’effacer aussi.')] });
    }

    // ── /ia style ──────────────────────────────────────────────
    if (sub === 'style') {
      if (!isAdmin(interaction)) {
        return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Réservé aux membres avec la permission *Gérer le serveur*.')], ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.options.getChannel('salon') || interaction.channel;
      const samples = await aiStyle.collectSamples(channel);
      if (samples.length < 3) {
        return interaction.editReply({ embeds: [errorEmbed('Pas assez de matière', 'Il faut au moins 3 messages récents et un peu fournis dans ce salon pour en déduire un style.')] });
      }

      const profile = await aiStyle.learnStyle(samples);
      if (!profile) {
        return interaction.editReply({ embeds: [errorEmbed('Style non appris', 'Aucun fournisseur IA n’a pu analyser les messages. Vérifie les clés du .env puis réessaie.')] });
      }

      const cfg = await getAiConfig(guild.id, { force: true });
      cfg.styleProfile = profile;
      await saveAiConfig(cfg);
      return interaction.editReply({ embeds: [successEmbed('🎨 Style du serveur enregistré', `${profile}\n\n*Appliqué à toutes les prochaines réponses — repasse \`/ia style\` pour le rafraîchir.*`)] });
    }

    // ── /ia recherche ──────────────────────────────────────────
    if (sub === 'recherche') {
      await interaction.deferReply();
      const query = interaction.options.getString('requete');
      const web = await aiWeb.buildWebContext(query).catch(() => null);
      if (!web?.block) {
        return interaction.editReply({ embeds: [errorEmbed('Recherche vide', 'Aucun résultat exploitable. Reformule la demande ou réessaie dans un instant.')] });
      }
      return interaction.editReply({ embeds: [infoEmbed(`🌐 Recherche : ${query}`.slice(0, 250), web.block.slice(0, 3800))] });
    }

    // ── /ia stats ──────────────────────────────────────────────
    if (sub === 'stats') {
      if (!isAdmin(interaction)) {
        return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Réservé aux membres avec la permission *Gérer le serveur*.')], ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const cfg = await getAiConfig(guild.id);
      const payload = await renderStats(guild, cfg);

      const message = await interaction.editReply(payload);
      let stopped = false;
      const interval = setInterval(async () => {
        if (stopped) return;
        try {
          const fresh = await getAiConfig(guild.id, { force: true });
          await interaction.editReply(await renderStats(guild, fresh));
        } catch { stopped = true; clearInterval(interval); }
      }, 10_000);
      const stopTimeout = setTimeout(() => { stopped = true; clearInterval(interval); }, 10 * 60 * 1000);

      const collector = message.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id && i.customId === 'ai_stats_close', time: 10 * 60 * 1000 });
      collector.on('collect', async (i) => {
        stopped = true;
        clearInterval(interval);
        clearTimeout(stopTimeout);
        await i.update({ components: [] }).catch(() => {});
      });
      return;
    }

    // ── /ia salon ──────────────────────────────────────────────
    if (sub === 'salon') {
      if (!isAdmin(interaction)) {
        return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Réservé aux membres avec la permission *Gérer le serveur*.')], ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const cfg = await getAiConfig(guild.id, { force: true });
      const action = interaction.options.getString('action');

      if (action === 'supprimer') {
        const channel = cfg.playgroundChannelId ? guild.channels.cache.get(cfg.playgroundChannelId) : null;
        if (channel) await channel.delete('Suppression demandée via /ia salon').catch(() => {});
        cfg.channelIds = cfg.channelIds.filter((id) => id !== cfg.playgroundChannelId);
        cfg.playgroundChannelId = null;
        await saveAiConfig(cfg);
        return interaction.editReply({ embeds: [successEmbed('Salon supprimé', 'Le salon de discussion a été supprimé et retiré des salons actifs.')] });
      }

      const result = await createPlaygroundChannel(guild, cfg);
      if (result.error) return interaction.editReply({ embeds: [errorEmbed('Création impossible', result.error)] });
      await saveAiConfig(cfg);
      return interaction.editReply({ embeds: [successEmbed('Salon créé', `<#${result.channel.id}> est prêt : l’IA y répond à chaque message, et les images se demandent en langage naturel.`)] });
    }

    // ── /ia panel (reste) ──────────────────────────────────────
    if (!isAdmin(interaction)) {
      return interaction.reply({ embeds: [errorEmbed('Permission refusée', 'Réservé aux membres avec la permission *Gérer le serveur*.')], ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    let cfg = await getAiConfig(guild.id, { force: true });
    // Un salon supprimé à la main ne doit pas rester « actif » dans la config.
    if (cfg.playgroundChannelId && !guild.channels.cache.has(cfg.playgroundChannelId)) {
      cfg.playgroundChannelId = null;
      await saveAiConfig(cfg);
    }

    const reply = await interaction.editReply({
      embeds: [buildConfigPanelEmbed(guild, cfg)],
      components: buildPanelComponents(cfg),
    });

    const refresh = async () => {
      const fresh = await getAiConfig(guild.id, { force: true });
      return { embeds: [buildConfigPanelEmbed(guild, fresh)], components: buildPanelComponents(fresh) };
    };

    const collector = reply.createMessageComponentCollector({ filter: (i) => i.user.id === interaction.user.id, time: COLLECTOR_TIMEOUT_MS });

    collector.on('collect', async (i) => {
      try {
        const id = i.customId;
        cfg = await getAiConfig(guild.id, { force: true });

        if (id === 'ai_add_channel') {
          for (const channelId of i.values) if (!cfg.channelIds.includes(channelId)) cfg.channelIds.push(channelId);
          await saveAiConfig(cfg);
          return i.update(await refresh());
        }

        if (id === 'ai_clear_channels') {
          cfg.channelIds = [];
          await saveAiConfig(cfg);
          return i.update(await refresh());
        }

        if (id === 'ai_clear_roles') {
          cfg.allowedRoleIds = [];
          await saveAiConfig(cfg);
          return i.update(await refresh());
        }

        if (id === 'ai_toggle') {
          cfg.enabled = !cfg.enabled;
          await saveAiConfig(cfg);
          return i.update(await refresh());
        }

        if (id === 'ai_memory') {
          cfg.memoryEnabled = cfg.memoryEnabled === false;
          await saveAiConfig(cfg);
          return i.update(await refresh());
        }

        if (id === 'ai_model') {
          cfg.model = i.values[0];
          await saveAiConfig(cfg);
          return i.update(await refresh());
        }

        if (id === 'ai_add_role') {
          const roleId = i.values[0];
          if (!cfg.allowedRoleIds.includes(roleId)) cfg.allowedRoleIds.push(roleId);
          await saveAiConfig(cfg);
          return i.update(await refresh());
        }

        if (id === 'ai_salon') {
          if (cfg.playgroundChannelId) {
            const channel = guild.channels.cache.get(cfg.playgroundChannelId);
            await channel?.delete('Salon retiré via /ia panel').catch(() => {});
            cfg.channelIds = cfg.channelIds.filter((cid) => cid !== cfg.playgroundChannelId);
            cfg.playgroundChannelId = null;
            await saveAiConfig(cfg);
            await i.update(await refresh());
            return i.followUp({ embeds: [successEmbed('Salon supprimé', 'Le salon de discussion a été supprimé.')], ephemeral: true }).catch(() => {});
          }

          await i.deferUpdate();
          const result = await createPlaygroundChannel(guild, cfg);
          if (result.error) {
            return i.followUp({ embeds: [errorEmbed('Création impossible', result.error)], ephemeral: true }).catch(() => {});
          }
          await saveAiConfig(cfg);
          await interaction.editReply(await refresh());
          return i.followUp({ embeds: [successEmbed('Salon créé', `<#${result.channel.id}> est actif : l’IA y répond à chaque message.`)], ephemeral: true }).catch(() => {});
        }

        if (id === 'ai_prompt') {
          const modal = new ModalBuilder().setCustomId('ai_modal_prompt').setTitle('📝 Personnalité de l’assistant');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('value')
              .setLabel('Comportement souhaité (le ton de REZO)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(1000)
              .setValue(cfg.systemPrompt || ''),
          ));
          await i.showModal(modal);
          const submitted = await i.awaitModalSubmit({ filter: (m) => m.customId === 'ai_modal_prompt' && m.user.id === interaction.user.id, timeout: 300_000 }).catch(() => null);
          if (!submitted) return;
          cfg = await getAiConfig(guild.id, { force: true });
          cfg.systemPrompt = submitted.fields.getTextInputValue('value').trim();
          await saveAiConfig(cfg);
          return submitted.update(await refresh());
        }

        if (id === 'ai_advanced') {
          const modal = new ModalBuilder().setCustomId('ai_modal_advanced').setTitle('⚙️ Réglages de l’IA');
          modal.addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('temp').setLabel('Créativité (0.0 à 2.0)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.temperature))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('history').setLabel('Échanges en mémoire immédiate (1 à 30)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.maxHistoryPairs))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('limit').setLabel('Limite par membre et par jour (0 = illimité)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.dailyLimitPerUser))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('slowmode').setLabel('Slowmode du salon créé (secondes)').setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.slowmodeSeconds ?? 5))),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quota').setLabel('Quota épuisé : auto ou verrou (lock)').setStyle(TextInputStyle.Short).setRequired(false).setValue(cfg.quotaFallbackMode === 'lock_channel' ? 'lock' : 'auto')),
          );
          await i.showModal(modal);
          const submitted = await i.awaitModalSubmit({ filter: (m) => m.customId === 'ai_modal_advanced' && m.user.id === interaction.user.id, timeout: 300_000 }).catch(() => null);
          if (!submitted) return;

          const temp = parseFloat(submitted.fields.getTextInputValue('temp'));
          const history = parseInt(submitted.fields.getTextInputValue('history'), 10);
          const limit = parseInt(submitted.fields.getTextInputValue('limit'), 10);
          const slowmode = parseInt(submitted.fields.getTextInputValue('slowmode'), 10);
          const quota = submitted.fields.getTextInputValue('quota').trim().toLowerCase();

          cfg = await getAiConfig(guild.id, { force: true });
          if (Number.isFinite(temp) && temp >= 0 && temp <= 2) cfg.temperature = temp;
          if (Number.isFinite(history) && history >= 1 && history <= 30) cfg.maxHistoryPairs = history;
          if (Number.isFinite(limit) && limit >= 0) cfg.dailyLimitPerUser = limit;
          if (Number.isFinite(slowmode) && slowmode >= 0 && slowmode <= 21600) cfg.slowmodeSeconds = slowmode;
          if (quota.startsWith('lock') || quota.startsWith('verr')) cfg.quotaFallbackMode = 'lock_channel';
          else if (quota.startsWith('auto') || quota.startsWith('aut')) cfg.quotaFallbackMode = 'switch_model';
          await saveAiConfig(cfg);

          // Le slowmode s'applique vraiment au salon, pas seulement dans la config.
          if (cfg.playgroundChannelId) {
            const channel = guild.channels.cache.get(cfg.playgroundChannelId);
            await channel?.setRateLimitPerUser(cfg.slowmodeSeconds).catch(() => {});
          }
          return submitted.update(await refresh());
        }

        if (id === 'ai_chain') {
          const modal = new ModalBuilder().setCustomId('ai_modal_chain').setTitle('🎯 Modèles de secours');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('value')
              .setLabel('Modèles essayés dans l’ordre (virgules)')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setValue((cfg.modelChain?.length ? cfg.modelChain : defaultModelChain()).join(', ')),
          ));
          await i.showModal(modal);
          const submitted = await i.awaitModalSubmit({ filter: (m) => m.customId === 'ai_modal_chain' && m.user.id === interaction.user.id, timeout: 300_000 }).catch(() => null);
          if (!submitted) return;
          const chain = parseModelChainInput(submitted.fields.getTextInputValue('value'));
          cfg = await getAiConfig(guild.id, { force: true });
          // Chaîne vide = on revient aux modèles par défaut (jamais « aucun modèle »).
          cfg.modelChain = chain.length ? chain : defaultModelChain();
          await saveAiConfig(cfg);
          return submitted.update(await refresh());
        }

        if (id === 'ai_features') {
          // Un select ne peut pas cohabiter avec 5 boutons dans une même ligne,
          // et Discord limite un message à 5 lignes : le menu s'ouvre donc en
          // réponse éphémère, sans alourdir le panel.
          await i.deferUpdate();
          const menu = new StringSelectMenuBuilder()
            .setCustomId('ai_features_pick')
            .setPlaceholder('Coche les fonctions à activer, puis valide…')
            .setMinValues(0)
            .setMaxValues(10)
            .addOptions([
              { label: 'Recherche web', value: 'web', default: cfg.webSearch !== false },
              { label: 'Vocal → texte', value: 'voice', default: cfg.voiceTranscription !== false },
              { label: 'Réponses vocales', value: 'voicereply', default: cfg.voiceReplies !== false },
              { label: 'Réactions emoji', value: 'reactions', default: cfg.reactions !== false },
              { label: 'Stickers', value: 'stickers', default: cfg.stickers !== false },
              { label: 'Réponses multiples', value: 'multi', default: cfg.multiMessage !== false },
              { label: 'Délais humains', value: 'delays', default: cfg.humanDelay !== false },
              { label: 'Contexte social', value: 'social', default: cfg.socialContext !== false },
              { label: 'Mémoire vectorielle', value: 'vectors', default: cfg.vectorMemory !== false },
              { label: 'Outils de modération', value: 'moderation', default: cfg.moderationTools === true },
            ]);

          const sent = await i.followUp({
            embeds: [infoEmbed('🧩 Fonctions avancées', 'Sélectionne ce qui doit rester actif pour ce serveur, puis valide.')],
            components: [new ActionRowBuilder().addComponents(menu)],
            ephemeral: true,
            fetchReply: true,
          });

          const picked = await sent.awaitMessageComponent({
            filter: (m) => m.user.id === interaction.user.id,
            time: 120_000,
          }).catch(() => null);
          if (!picked) return;

          const on = new Set(picked.values);
          cfg = await getAiConfig(guild.id, { force: true });
          cfg.webSearch = on.has('web');
          cfg.voiceTranscription = on.has('voice');
          cfg.voiceReplies = on.has('voicereply');
          cfg.reactions = on.has('reactions');
          cfg.stickers = on.has('stickers');
          cfg.multiMessage = on.has('multi');
          cfg.humanDelay = on.has('delays');
          cfg.socialContext = on.has('social');
          cfg.vectorMemory = on.has('vectors');
          cfg.moderationTools = on.has('moderation');
          await saveAiConfig(cfg);

          await picked.update({
            embeds: [successEmbed('Fonctions mises à jour', 'Les nouvelles réglages s’appliquent dès le prochain message.')],
            components: [],
          }).catch(() => {});

          return interaction.editReply(await refresh());
        }

        if (id === 'ai_stats') {
          await i.deferUpdate();
          const fresh = await getAiConfig(guild.id, { force: true });
          return interaction.editReply(await renderStats(guild, fresh));
        }

        if (id === 'ai_refresh') {
          return i.update(await refresh());
        }
      } catch (err) {
        console.error('[ia panel]', err);
        if (!i.replied && !i.deferred) await i.reply({ embeds: [errorEmbed('Erreur', 'Une erreur est survenue. Réessayez.')], ephemeral: true }).catch(() => {});
      }
    });

    collector.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },
};

// Note : les modaux du panel (ai_modal_*) sont attendus par les collecteurs
// internes ci-dessus via awaitModalSubmit. interactionCreate ne doit donc PAS
// les router ailleurs, sous peine de traiter la soumission deux fois.
