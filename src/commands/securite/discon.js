'use strict';
// commands/securite/discon.js — 🚨 DISCON, le niveau de danger du serveur.
//
// Un seul chiffre décrit l'état de vigilance du serveur, et chaque cran ferme
// un peu plus ce qui peut être attaqué :
//   0 ⚪ Normal · 1 🟢 Guet · 2 🟡 Vigilance · 3 🟠 Alerte · 4 🔴 Danger · 5 ⚫ Verrouillage
//
// `/discon` ouvre le panneau ; `/discon niveau:3` applique directement.
// Tout est réversible : redescendre rouvre exactement ce que DISCON avait fermé.
//
// Réservé à la permission *Gérer le serveur*, et **jamais** sous licence : une
// protection d'urgence doit rester disponible sur un serveur non licencié.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');

const { COLORS, errorEmbed } = require('../../utils/embeds');
const brand = require('../../utils/brand');
const engine = require('../../utils/disconEngine');

const PANEL_TTL_MS = 10 * 60 * 1000;

function canManage(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

// ─── Rendu ──────────────────────────────────────────────────────────────────
function buildPanelEmbed({ level, applied = [], skipped = [], history = [] }) {
  const def = engine.levelDef(level);
  const active = engine.planFor(level);

  const lines = [
    `${engine.levelBar(level)}  ${def.emoji} **${def.label}** · cran **${level}/${engine.MAX_LEVEL}**`,
    def.summary,
    '',
  ];

  if (active.length) {
    lines.push('**Protections actives**');
    for (const step of active) lines.push(`${engine.STEPS[step].emoji} ${engine.STEPS[step].label}`);
  } else {
    lines.push('**Aucune restriction** — le serveur vit normalement.');
  }

  lines.push('', engine.nextStepHint(level));

  const embed = new EmbedBuilder()
    .setColor(def.color || COLORS.primary)
    .setTitle('🚨 DISCON — niveau de danger')
    .setDescription(lines.join('\n'));

  if (applied.length) {
    embed.addFields({
      name: '✅ Appliqué à l’instant',
      value: applied.map(s => `${engine.STEPS[s].emoji} ${engine.STEPS[s].label}`).join('\n').slice(0, 1024),
    });
  }
  if (skipped.length) {
    embed.addFields({
      name: '⚠️ Non appliqué',
      value: skipped.map(s => `• **${engine.STEPS[s.step]?.label || s.step}** — ${s.reason}`).join('\n').slice(0, 1024),
    });
  }
  if (history.length) {
    const last = history.slice(-3).reverse()
      .map(h => `• cran **${h.level}** <t:${Math.floor(new Date(h.at).getTime() / 1000)}:R>`);
    embed.addFields({ name: '🕘 Derniers changements', value: last.join('\n') });
  }

  embed
    .addFields({ name: '📖 Les cinq crans', value: engine.LEVELS.slice(1).map(l => `${l.emoji} **${l.level} · ${l.label}** — ${l.summary}`).join('\n').slice(0, 1024) })
    .setFooter({ text: brand.footer('DISCON — protection d’urgence') });

  return embed;
}

function buildPanelRow(level) {
  const clamped = engine.clampLevel(level);
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('discon_down').setLabel('Baisser').setEmoji('⬇️')
      .setStyle(ButtonStyle.Secondary).setDisabled(clamped <= 0),
    new ButtonBuilder().setCustomId('discon_up').setLabel('Monter').setEmoji('⬆️')
      .setStyle(ButtonStyle.Danger).setDisabled(clamped >= engine.MAX_LEVEL),
    new ButtonBuilder().setCustomId('discon_reset').setLabel('Tout rouvrir').setEmoji('✅')
      .setStyle(ButtonStyle.Success).setDisabled(clamped === 0),
    new ButtonBuilder().setCustomId('discon_refresh').setLabel('Actualiser').setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function render(guild, extra = {}) {
  const doc = await engine.getState(guild.id);
  return {
    embeds: [buildPanelEmbed({ level: doc.level, history: doc.history || [], ...extra })],
    components: [buildPanelRow(doc.level)],
  };
}

// ─── Commande ───────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('discon')
    .setDescription('🚨 Niveau de danger du serveur : cinq crans, un seul geste')
    .addIntegerOption((o) => o
      .setName('niveau')
      .setDescription('Appliquer directement un cran (0 = tout rouvrir)')
      .setMinValue(0)
      .setMaxValue(5)),

  async execute(interaction, client) {
    if (!canManage(interaction)) {
      return interaction.reply({
        embeds: [errorEmbed('Permission refusée', 'Réservé aux membres avec la permission *Gérer le serveur*.')],
        ephemeral: true,
      });
    }

    const guild = interaction.guild;
    const target = interaction.options.getInteger('niveau');

    // ── Application directe ────────────────────────────────────────────────
    if (target !== null && target !== undefined) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const result = await engine.applyLevel(guild, target, { byId: interaction.user.id });
        const doc = result.doc;
        return interaction.editReply({
          embeds: [buildPanelEmbed({
            level: result.level,
            applied: result.applied,
            skipped: result.skipped,
            history: doc.history || [],
          })],
          components: [buildPanelRow(result.level)],
        });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed('DISCON', err.message)] });
      }
    }

    // ── Panneau ────────────────────────────────────────────────────────────
    await interaction.deferReply({ ephemeral: true });
    const payload = await render(guild);
    const message = await interaction.editReply(payload);

    const collector = message.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id,
      time: PANEL_TTL_MS,
    });

    collector.on('collect', async (i) => {
      try {
        if (!canManage(i)) {
          return i.reply({ content: '❌ Tu n’as pas la permission *Gérer le serveur*.', ephemeral: true });
        }

        if (i.customId === 'discon_refresh') return i.update(await render(guild));

        const doc = await engine.getState(guild.id);
        const next = i.customId === 'discon_reset'
          ? 0
          : i.customId === 'discon_up' ? doc.level + 1 : doc.level - 1;

        await i.deferUpdate();
        const result = await engine.applyLevel(guild, engine.clampLevel(next), { byId: i.user.id, doc });
        return i.editReply({
          embeds: [buildPanelEmbed({
            level: result.level,
            applied: result.applied,
            skipped: result.skipped,
            history: result.doc.history || [],
          })],
          components: [buildPanelRow(result.level)],
        });
      } catch (err) {
        console.error('[discon panel]', err);
        if (!i.replied && !i.deferred) {
          await i.reply({ embeds: [errorEmbed('DISCON', 'Changement impossible pour le moment.')], ephemeral: true }).catch(() => {});
        }
      }
    });

    collector.on('end', () => { interaction.editReply({ components: [] }).catch(() => {}); });
  },

  // Exposé pour les tests : rendu sans Discord.
  buildPanelEmbed,
  buildPanelRow,
  render,
};
