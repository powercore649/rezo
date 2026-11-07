'use strict';
// commands/configuration/autopilote.js — 🚀 Autopilote REZO — PANEL UNIQUE
//
// Une seule commande qui pilote TOUT le bot : elle mesure l'efficacité réelle
// du serveur (0-100%), montre exactement ce qui manque pour atteindre 90%, puis
// installe automatiquement ce qu'elle peut installer sans risque.
//
// Sous licence : l'ouverture est déjà filtrée par le routeur
// (interactionCreate + LICENSE_REQUIRED_COMMANDS) et chaque action sensible
// revérifie l'accès — au cas où la licence expirerait panel ouvert.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const { COLORS, errorEmbed }   = require('../../utils/embeds');
const brand                    = require('../../utils/brand');
const { collectState, invalidateState } = require('../../utils/efficiencyState');
const { computeScore, CATEGORIES, gapToGoal } = require('../../utils/efficiencyScore');
const autopilot                = require('../../utils/autopilot');

const { BRAND, GOAL_PERCENT, bar, grade, scoreColor } = brand;

// ── Analyse complète d'un serveur ───────────────────────────────────────────
async function analyze(guild, { fresh = false } = {}) {
  const state = await collectState(guild.id, { fresh });
  const score = computeScore(state);
  const picks = autopilot.pickTextChannels(guild, guild.members?.me);
  const memberRole = autopilot.pickRole(guild, 'member');
  const plan = autopilot.buildPlan(state, { ...picks, memberRole });
  return { state, score, picks, plan, tookMs: state.tookMs || 0, cached: !!state.cached };
}

// ── Embed principal : la carte d'efficacité ──────────────────────────────────
function buildOverviewEmbed({ score, tookMs, cached, delta = null }) {
  const g = grade(score.percent);
  const lines = [
    `${bar(score.percent, { length: 16 })}  ${g.emoji} **${g.label}**`,
    '',
    `🎯 **Objectif : ${GOAL_PERCENT}%** — ${
      score.reached
        ? '🏆 **atteint !** Votre serveur exploite tout ce que REZO sait faire.'
        : `encore **${gapToGoal(score.percent)} points** à gagner.`
    }`,
    `🧩 **${score.activeCount}/${score.moduleCount}** modules actifs · ${score.earnedWeight}/${score.totalWeight} points de couverture`,
  ];
  if (delta !== null) {
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    lines.push(`📈 **${sign} points** gagnés par la dernière optimisation ${delta > 0 ? '🚀' : ''}`);
  }
  lines.push('', `⚡ Analyse ${cached ? 'en cache' : 'complète'} en **${tookMs} ms** · \`${BRAND.name} ${BRAND.version}\``);

  const embed = new EmbedBuilder()
    .setColor(scoreColor(score.percent))
    .setTitle('🚀 Autopilote — Efficacité du serveur')
    .setDescription(lines.join('\n'));

  if (score.autoFixable.length) {
    embed.addFields({
      name:  `⚙️ Installable automatiquement (${score.autoGain} pts disponibles)`,
      value: score.autoFixable.slice(0, 6).map(m => `• **${m.label}**`).join('\n')
        + (score.autoFixable.length > 6 ? `\n*…et ${score.autoFixable.length - 6} autre(s)*` : ''),
    });
  }
  if (score.manualFixable.length) {
    embed.addFields({
      name:  `🛠️ À finaliser à la main (${score.manualFixable.length})`,
      value: score.manualFixable.slice(0, 6)
        .map(m => `• **${m.label}**${m.fix ? ` → \`${m.fix}\`` : ''}`).join('\n')
        + (score.manualFixable.length > 6 ? `\n*…et ${score.manualFixable.length - 6} autre(s)*` : ''),
    });
  }
  embed.addFields({
    name:   `📊 Répartition par piliers`,
    value:  score.categories.map(c => `${c.emoji} **${c.label}** ${c.percent}% ${bar(c.percent, { length: 8, suffix: false })}  *${c.enabled}/${c.count}*`).join('\n'),
  });

  return embed;
}

// ── Embed de détail d'un pilier ─────────────────────────────────────────────
function buildCategoryEmbed(score, categoryKey) {
  const c = score.categories.find(x => x.key === categoryKey);
  if (!c) return buildOverviewEmbed({ score, tookMs: 0, cached: false });

  const ok = c.modules.filter(m => m.ok);
  const ko = c.modules.filter(m => !m.ok);
  const desc = [
    `${bar(c.percent, { length: 16 })}`,
    '',
    `${c.emoji} **${c.label}** — *${c.hint}*`,
    `**${c.enabled}/${c.count}** modules actifs sur ce pilier (poids ${c.weight} dans le score global)`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setColor(scoreColor(c.percent))
    .setTitle(`📂 ${c.label} — ${c.percent}%`)
    .setDescription(desc);

  if (ok.length) {
    embed.addFields({ name: `🟢 Actif (${ok.length})`, value: ok.map(m => `• ${m.label}`).join('\n').slice(0, 1024) });
  }
  if (ko.length) {
    embed.addFields({
      name:  `⚫ Manquant (${ko.length})`,
      value: ko.map(m => `• **${m.label}** — ${m.hint}${m.auto ? ' *(auto)*' : (m.fix ? ` → \`${m.fix}\`` : '')}`).join('\n').slice(0, 1024),
    });
  }
  embed.setFooter({ text: brand.footer(`Détail du pilier · ${BRAND.version}`) });
  return embed;
}

// ── Embed du plan détaillé ──────────────────────────────────────────────────
function buildPlanEmbed(plan, score) {
  const autoLines = plan.steps.map(s => `• **${s.label}**`).join('\n').slice(0, 1024) || '*Rien à installer, tout est déjà en place.*';
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📋 Plan de l\'autopilote')
    .setDescription(
      `Voici ce que l'autopilote appliquerait **maintenant**, sans risque et de façon réversible.\n`
      + `Résultat estimé : **${score.percent}% → ${Math.min(100, score.percent + score.autoGain)}%**.`,
    )
    .addFields({ name: `⚙️ Actions immédiates (${plan.steps.length})`, value: autoLines });

  if (plan.blocked.length) {
    embed.addFields({
      name:  `⛔ Bloqué faute de salon (${plan.blocked.length})`,
      value: plan.blocked.map(b => `• **${b.label}** — ${b.reason}`).join('\n').slice(0, 1024),
    });
    const missing = autopilot.missingChannels(plan);
    if (missing.length) {
      embed.addFields({
        name:  '🏗️ Salons que REZO peut créer',
        value: missing.map(m => `• \`#${m.name}\` → débloque ${m.unlocks.length} module(s)`).join('\n'),
      });
    }
  }
  if (score.manualFixable.length) {
    embed.addFields({
      name:  `🛠️ Restera manuel (${score.manualFixable.length})`,
      value: score.manualFixable.slice(0, 8)
        .map(m => `• **${m.label}**${m.fix ? ` → \`${m.fix}\`` : ''}`).join('\n').slice(0, 1024),
    });
  }
  embed.setFooter({ text: brand.footer('Plan d\'automatisation') });
  return embed;
}

// ── Embed « comment atteindre 90% » ─────────────────────────────────────────
function buildGoalEmbed(score) {
  const lines = [];
  if (score.reached) {
    lines.push(`🏆 **Objectif atteint : ${score.percent}% !**`, '',
      'Votre serveur exploite l\'essentiel de REZO. Les modules restants sont optionnels — activez-les selon vos envies.');
  } else {
    lines.push(`🎯 Il manque **${gapToGoal(score.percent)} points** pour atteindre ${GOAL_PERCENT}%.`, '');
    if (score.autoFixable.length) {
      lines.push(`⚙️ **${score.autoFixable.length} module(s) installables en un clic** (+${score.autoGain} pts) :`);
      lines.push(score.autoFixable.map(m => `• ${m.label}`).join('\n'), '');
    }
    if (score.manualFixable.length) {
      lines.push(`🛠️ **${score.manualFixable.length} module(s) demandant un choix humain :**`);
      lines.push(score.manualFixable.slice(0, 10)
        .map(m => `• **${m.label}**${m.fix ? ` → \`${m.fix}\`` : ''}`).join('\n'));
      if (score.manualFixable.length > 10) lines.push(`*…et ${score.manualFixable.length - 10} autre(s)*`);
    }
  }
  return new EmbedBuilder()
    .setColor(scoreColor(score.percent))
    .setTitle(`🎯 Cap sur les ${GOAL_PERCENT}%`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: brand.footer(`${score.percent}% → ${GOAL_PERCENT}%`) });
}

// ── Composants du panel ─────────────────────────────────────────────────────
function buildComponents(score, view = 'overview') {
  const options = [
    { label: 'Vue d\'ensemble', value: 'overview', emoji: '📊', description: `Score global : ${score.percent}%` },
    ...CATEGORIES.map(c => {
      const cat = score.categories.find(x => x.key === c.key);
      return {
        label: c.label,
        value: c.key,
        emoji: c.emoji,
        description: `${cat.enabled}/${cat.count} modules · ${cat.percent}%`,
        default: view === c.key,
      };
    }),
  ];

  const rows = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('apl_view')
        .setPlaceholder('📂 Voir le détail d\'un pilier')
        .addOptions(options),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('apl_optimize')
        .setLabel(`Optimiser (+${score.autoGain}%)`)
        .setEmoji('▶️').setStyle(ButtonStyle.Success)
        .setDisabled(score.autoFixable.length === 0),
      new ButtonBuilder().setCustomId('apl_channels')
        .setLabel('Salons + optimisation').setEmoji('🏗️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('apl_refresh')
        .setLabel('Actualiser').setEmoji('🔃').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('apl_plan')
        .setLabel('Plan détaillé').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('apl_goal')
        .setLabel(`Cap sur ${GOAL_PERCENT}%`).setEmoji('🎯').setStyle(ButtonStyle.Secondary),
    ),
  ];
  return rows;
}

// ── Rapport d'application ───────────────────────────────────────────────────
function buildReportEmbed({ applied, failed, blocked, created, createFailed, before, after }) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('✅ Optimisation appliquée')
    .setDescription(`**Efficacité : ${before}% → ${after}%** ${bar(after, { length: 12 })}`);

  if (created?.length) {
    embed.addFields({
      name:  '🏗️ Salons créés',
      value: created.map(c => `• <#${c.id}>${c.existed ? ' *(existait déjà)*' : ''}`).join('\n').slice(0, 1024),
    });
  }
  if (applied.length) {
    embed.addFields({ name: `⚙️ Modules activés (${applied.length})`, value: applied.map(a => `• ${a.label}`).join('\n').slice(0, 1024) });
  }
  if (failed?.length || createFailed?.length) {
    embed.addFields({
      name:  '⚠️ Échecs',
      value: [...(failed || []).map(f => `• ${f.label} : ${f.error}`),
              ...(createFailed || []).map(f => `• #${f.name} : ${f.error}`)].join('\n').slice(0, 1024),
    });
  }
  if (blocked?.length) {
    embed.addFields({
      name:  '⛔ Toujours bloqué',
      value: blocked.map(b => `• **${b.label}** — ${b.reason}`).join('\n').slice(0, 1024),
    });
  }
  embed.setFooter({ text: brand.footer('Réversible : tout se désactive depuis /setting') });
  return embed;
}

// Verrou de licence pour les actions sensibles
async function ensureLicensed(guildId, replyFn) {
  const { checkAccess, lockEmbed } = require('../../utils/licenseGate');
  const access = await checkAccess(guildId, 'autopilote');
  if (!access.ok) {
    await replyFn({ embeds: [lockEmbed('autopilote', { access })], ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
//  COMMANDE
// ════════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('autopilote')
    .setDescription('🚀 Score d\'efficacité + configuration automatique du serveur (sous licence)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const guild = interaction.guild;
    let current = await analyze(guild).catch(err => {
      console.error('[Autopilote] analyse:', err);
      return null;
    });
    if (!current) {
      return interaction.editReply({ embeds: [errorEmbed('Analyse impossible', 'Impossible de lire la configuration du serveur pour le moment.')] }).catch(() => {});
    }

    let view = 'overview';

    const buildView = () => ({
      embeds: [
        view === 'overview'
          ? buildOverviewEmbed({ ...current, delta: current.delta ?? null })
          : buildCategoryEmbed(current.score, view),
      ],
      components: buildComponents(current.score, view),
    });

    const rebuild = async (fresh = false) => {
      const next = await analyze(guild, { fresh });
      current = { ...next, delta: current?.delta ?? null };
    };

    const reply = await interaction.editReply(buildView());

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time:   15 * 60 * 1000,
    });

    col.on('collect', async (i) => {
      try {
        const id = i.customId;

        // ── Changer de vue ──────────────────────────────────────────────────
        if (id === 'apl_view') {
          view = i.values[0] === 'overview' ? 'overview' : i.values[0];
          return i.update(buildView());
        }

        // ── Actualiser (relit tout, ignore le cache) ───────────────────────
        if (id === 'apl_refresh') {
          invalidateState(guild.id);
          await rebuild(true);
          return i.update(buildView());
        }

        // ── Plan détaillé ──────────────────────────────────────────────────
        if (id === 'apl_plan') {
          return i.reply({ embeds: [buildPlanEmbed(current.plan, current.score)], ephemeral: true }).catch(() => {});
        }

        // ── Comment atteindre 90% ──────────────────────────────────────────
        if (id === 'apl_goal') {
          return i.reply({ embeds: [buildGoalEmbed(current.score)], ephemeral: true }).catch(() => {});
        }

        // ── Optimisation automatique ───────────────────────────────────────
        if (id === 'apl_optimize') {
          if (!(await ensureLicensed(guild.id, p => i.reply(p)))) return;
          await i.deferUpdate();

          const before = current.score.percent;
          const res = await autopilot.applyPlan(current.plan);

          invalidateState(guild.id);
          await rebuild(true);
          const after = current.score.percent;
          current.delta = after - before;

          await i.editReply(buildView());
          return i.followUp({
            embeds: [buildReportEmbed({ ...res, created: [], before, after })],
            ephemeral: true,
          }).catch(() => {});
        }

        // ── Créer les salons manquants puis optimiser ──────────────────────
        if (id === 'apl_channels') {
          if (!(await ensureLicensed(guild.id, p => i.reply(p)))) return;
          await i.deferUpdate();

          const before = current.score.percent;
          const toCreate = autopilot.missingChannels(current.plan);
          const { created, failed: createFailed } = toCreate.length
            ? await autopilot.createMissingChannels(guild, toCreate)
            : { created: [], failed: [] };

          invalidateState(guild.id);
          await rebuild(true);

          // Une fois les salons en place, les modules débloqués s'installent.
          const res = await autopilot.applyPlan(current.plan);

          invalidateState(guild.id);
          await rebuild(true);
          const after = current.score.percent;
          current.delta = after - before;

          await i.editReply(buildView());
          return i.followUp({
            embeds: [buildReportEmbed({ ...res, created, createFailed, before, after })],
            ephemeral: true,
          }).catch(() => {});
        }
      } catch (err) {
        console.error('[AutopilotePanel]', err);
        const payload = { embeds: [errorEmbed('Erreur', 'Action impossible pour le moment. Réessayez.')], ephemeral: true };
        if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
        else await i.reply(payload).catch(() => {});
      }
    });

    col.on('end', () => { interaction.editReply({ components: [] }).catch(() => {}); });
  },

  // Exposé pour la suite de tests : les builders de rendu sont purs, ce qui
  // permet de vérifier la carte d'efficacité sans client Discord.
  __testables: {
    buildOverviewEmbed,
    buildCategoryEmbed,
    buildPlanEmbed,
    buildGoalEmbed,
    buildReportEmbed,
    buildComponents,
  },
};
