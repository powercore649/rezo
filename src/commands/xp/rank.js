// commands/rank.js — Carte de rang (image générée) + personnalisation par membre.
//
// La carte suit le thème du serveur (réglé dans /leveling) et, si le membre a
// activé sa propre personnalisation (RankCardPref), ce sont ses réglages qui
// s'appliquent. Le bouton « Personnaliser ma carte » ouvre un panneau éphémère
// avec aperçu en direct.
const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const XP = require('../../models/XP');
const RankCardPref = require('../../models/RankCardPref');
const { getOrCreateConfig, getOrCreateXp, computeLevel } = require('./xp');
const { renderRankCard } = require('../../utils/rankCard');
const { resolveCardTheme, DEFAULT_THEME } = require('../../utils/rankCardTheme');
const {
  buildCardPanel, buildCardModal, applyCardOption, applyCardModal,
  optionKeyFromId, modalKeyFromId, pageForKey,
} = require('../../utils/rankCardPanel');
const { COLORS, errorEmbed } = require('../../utils/embeds');

// Aperçu de démonstration : utilisé tant que le membre n'a pas encore d'XP en
// base (on ne veut pas afficher une carte vide à quelqu'un qui la découvre).
const SAMPLE_STATS = { level: 12, rank: 42, xpIntoLevel: 12_340, xpForNext: 26_000, totalXp: 158_900, messages: 1_234 };

async function getPref(guildId, userId) {
  return RankCardPref.findOne({ guildId, userId }).catch(() => null);
}

/** Enregistre une modification : toute modification active l'override. */
async function savePref(guildId, userId, patch = {}, enabled, upsert = true) {
  const set = { ...patch };
  if (enabled !== undefined) set.enabled = enabled;
  if (!Object.keys(set).length) return getPref(guildId, userId);
  return RankCardPref.findOneAndUpdate(
    { guildId, userId },
    { $set: set },
    { upsert, new: true, setDefaultsOnInsert: true },
  ).catch(() => null);
}

/** Charge le thème effectif du membre (thème du serveur + son override). */
async function loadCardContext(guildId, userId) {
  const [cfg, pref] = await Promise.all([
    getOrCreateConfig(guildId).catch(() => null),
    getPref(guildId, userId),
  ]);
  return {
    cfg,
    pref,
    theme: resolveCardTheme(cfg, pref),
    overrideEnabled: !!pref?.enabled,
  };
}

/** Stats réelles du membre, ou valeurs de démonstration si rien en base. */
async function fetchStats(guildId, userId) {
  const doc = await getOrCreateXp(guildId, userId).catch(() => null);
  if (!doc) return { ...SAMPLE_STATS, sample: true };

  const above = await XP
    .countDocuments({ guildId, totalXp: { $gt: doc.totalXp } })
    .catch(() => 0);
  const { xpIntoLevel, xpForNext } = computeLevel(doc.totalXp);

  return {
    level: doc.level, rank: (above || 0) + 1,
    xpIntoLevel, xpForNext, totalXp: doc.totalXp, messages: doc.messages,
    sample: false,
  };
}

/** Objet minimal attendu par le renderer, construit depuis l'interaction. */
function memberLike(interaction, user = interaction.user) {
  const member = user.id === interaction.user.id ? interaction.member : null;
  const displayName = member?.displayName || user.globalName || user.username;
  return {
    displayName,
    user: { username: user.username },
    displayAvatarURL: opts => (member?.displayAvatarURL ? member.displayAvatarURL(opts) : user.displayAvatarURL(opts)),
  };
}

/** Payload du panneau, avec aperçu régénéré à chaque étape. */
async function panelPayload(interaction, ctx, { notice = null, stats = null, page = 'colors' } = {}) {
  const theme = resolveCardTheme(ctx.cfg, ctx.pref);
  const cardStats = stats || await fetchStats(interaction.guild.id, interaction.user.id);
  const buffer = await renderRankCard(memberLike(interaction), cardStats, theme);
  const { embed, components } = buildCardPanel(theme, 'member', {
    notice: cardStats.sample && !notice
      ? '*(aperçu de démonstration : envoie quelques messages pour voir tes vrais chiffres)*'
      : notice,
    overrideEnabled: !!ctx.pref?.enabled,
    page,
  });
  return {
    embeds: [embed], components,
    files: [new AttachmentBuilder(buffer, { name: 'card.png' })],
    attachments: [], // remplace l'aperçu précédent
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('🏆 Voir la carte de niveau (ou celle d\'un autre membre)')
    .addUserOption(o => o.setName('membre').setDescription('Le membre à afficher').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply();

    const target = interaction.options.getUser('membre') || interaction.user;
    if (target.bot) {
      return interaction.editReply({ embeds: [errorEmbed('Impossible', 'Les bots n\'ont pas de niveau.')] });
    }

    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      return interaction.editReply({ embeds: [errorEmbed('Introuvable', 'Ce membre n\'est plus sur le serveur.')] });
    }

    // Le thème appliqué est celui du membre affiché (chaque membre peut avoir le sien)
    const ctx = await loadCardContext(interaction.guild.id, target.id);
    const isSelf = target.id === interaction.user.id;
    const stats = await fetchStats(interaction.guild.id, target.id);

    try {
      const buffer = await renderRankCard(
        { displayName: member.displayName, user: { username: target.username }, displayAvatarURL: o => member.displayAvatarURL(o) },
        stats,
        ctx.theme,
      );

      const components = isSelf
        ? [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('rcp_open')
            .setLabel('Personnaliser ma carte')
            .setEmoji('🎨')
            .setStyle(ButtonStyle.Secondary),
        )]
        : [];

      return interaction.editReply({
        files: [new AttachmentBuilder(buffer, { name: 'rank.png' })],
        components,
      });
    } catch (err) {
      console.error('❌ rank card:', err.message);

      const remaining = Math.max(0, stats.xpForNext - stats.xpIntoLevel);
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setDescription(`**XP Level** : \`${member.displayName}\`\n\`${remaining.toLocaleString()}\` XP avant le niveau suivant`)
        .addFields(
          { name: '⬆️ · Niveau', value: `${stats.level}`, inline: true },
          { name: '🏅 · Rang', value: `#${stats.rank}`, inline: true },
          { name: '✨ · XP', value: `${stats.xpIntoLevel.toLocaleString()}/${stats.xpForNext.toLocaleString()}`, inline: true },
        )
        .setThumbnail(member.displayAvatarURL({ dynamic: true }))
        .setFooter({ text: 'REZO', iconURL: interaction.client.user.displayAvatarURL() })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },

  // ── Boutons du panneau de personnalisation (ids `rcp_*`) ────────────────────
  async handleButton(interaction, client) {
    if (!interaction.inGuild()) return;

    const key = optionKeyFromId(interaction.customId, 'member');
    if (!key) return;

    // Ouverture du panneau depuis la carte publique
    if (key === 'open') {
      await interaction.deferReply({ ephemeral: true });
      const ctx = await loadCardContext(interaction.guild.id, interaction.user.id);
      return interaction.editReply(await panelPayload(interaction, ctx));
    }

    const ctx = await loadCardContext(interaction.guild.id, interaction.user.id);
    const res = applyCardOption(ctx.theme, key, interaction.values || [], 'member');
    // La page affichée suit l'option touchée : aucun état à mémoriser.
    const page = res.action?.page || pageForKey(key);

    // 1) Enregistrement de la modification éventuelle
    if (res.patch) {
      await savePref(interaction.guild.id, interaction.user.id, res.patch, true);
    }

    // 2) Actions spéciales
    if (res.action === 'reset') {
      await savePref(interaction.guild.id, interaction.user.id, {}, false, false);
      return interaction.update(await panelPayload(interaction, await loadCardContext(interaction.guild.id, interaction.user.id), {
        notice: '↩️ Tu utilises de nouveau la carte du serveur. Tes réglages sont conservés.',
        page,
      }));
    }

    if (res.action === 'toggleEnabled') {
      const enable = !ctx.overrideEnabled;
      await savePref(interaction.guild.id, interaction.user.id, {}, enable);
      return interaction.update(await panelPayload(interaction, await loadCardContext(interaction.guild.id, interaction.user.id), {
        notice: enable ? '🟢 Ta carte personnalisée est active.' : '⚪ Retour à la carte du serveur (tes réglages sont conservés).',
        page,
      }));
    }

    if (res.action && typeof res.action === 'object' && res.action.modal) {
      const fresh = await loadCardContext(interaction.guild.id, interaction.user.id);
      const modal = buildCardModal(fresh.theme, res.action.modal, 'member');
      if (!modal) return interaction.reply({ content: '❌ Option indisponible.', ephemeral: true });
      return interaction.showModal(modal);
    }

    // 3) Sinon : rafraîchissement du panneau avec le nouvel aperçu
    // (contexte RECHARGÉ : sinon le premier changement ne s'afficherait pas
    // dans l'aperçu, le document lu avant l'enregistrement étant périmé)
    const fresh = await loadCardContext(interaction.guild.id, interaction.user.id);
    return interaction.update(await panelPayload(interaction, fresh, { notice: res.notice, page }));
  },

  // ── Modaux du panneau (ids `rcp_modal_*`) ──────────────────────────────────
  async handleModal(interaction, client) {
    if (!interaction.inGuild()) return;

    const key = modalKeyFromId(interaction.customId, 'member');
    if (!key) return;

    const res = applyCardModal(key, interaction.fields, 'member');
    if (res.error) {
      return interaction.reply({ content: `❌ ${res.error}`, ephemeral: true }).catch(() => {});
    }

    await savePref(interaction.guild.id, interaction.user.id, res.patch, true);
    const ctx = await loadCardContext(interaction.guild.id, interaction.user.id);
    const payload = await panelPayload(interaction, ctx, { notice: res.notice, page: pageForKey(key) });

    // Le panneau est éphémère : on tente de le rafraîchir sur place, et on
    // retombe sur un nouveau panneau si Discord refuse l'édition.
    if (interaction.message) {
      try {
        await interaction.message.edit(payload);
        return interaction.reply({ content: res.notice || '✅ Enregistré.', ephemeral: true }).catch(() => {});
      } catch { /* on renvoie un panneau neuf juste en dessous */ }
    }
    return interaction.reply({ ...payload, ephemeral: true });
  },

  // Partagé avec /leveling (aperçu admin) et les tests
  SAMPLE_STATS, DEFAULT_THEME, loadCardContext, fetchStats, memberLike, panelPayload,
};
