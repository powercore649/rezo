// commands/configuration/starterpack.js — /starterpack
//
// Panneau unique : aperçu de ce qui sera créé, installation en un clic,
// statut de ce que le pack a créé, désinstallation réversible.
//
// Tout est idempotent : relancer l'aperçu ou l'installation ne recrée jamais un
// élément existant. La commande et ses boutons exigent une licence (ou un essai
// gratuit) ET la permission « Gérer le serveur ».
const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const StarterPack = require('../../models/StarterPack');
const pack = require('../../utils/starterPack');
const licenseGate = require('../../utils/licenseGate');
const { COLORS, infoEmbed, errorEmbed } = require('../../utils/embeds');

const COMMAND = 'starterpack';
const PROGRESS_THROTTLE_MS = 2500; // évite de marteler l'édition du message

// ─── État ────────────────────────────────────────────────────────────────────
function ensureLists(state) {
  if (!state.created) state.created = {};
  for (const key of ['roles', 'categories', 'channels', 'panels']) {
    if (!Array.isArray(state.created[key])) state.created[key] = [];
  }
  return state;
}

async function getState(guildId) {
  let state = await StarterPack.findOne({ guildId });
  if (!state) state = await StarterPack.create({ guildId });
  return ensureLists(state);
}

function createdCount(state) {
  const c = state.created || {};
  return (c.roles?.length || 0) + (c.categories?.length || 0) + (c.channels?.length || 0) + (c.panels?.length || 0);
}

/** Aperçu complet du panneau. */
function previewPayload(guild, state, note = null) {
  const plan = pack.buildPlan(guild, state);
  return {
    plan,
    payload: pack.buildPreviewPayload(guild, plan, {
      state,
      note,
      installed: createdCount(state) > 0,
    }),
  };
}

/** Garde-fou commun à tous les boutons : licence puis permission. */
async function guard(interaction) {
  const access = await licenseGate.checkAccessBounded(interaction.guildId, COMMAND);
  if (!access) {
    await interaction.reply({ embeds: [licenseGate.unavailableEmbed(COMMAND)], ephemeral: true }).catch(() => {});
    return false;
  }
  if (!access.ok) {
    await interaction.reply({ embeds: [licenseGate.lockEmbed(COMMAND, { access })], ephemeral: true }).catch(() => {});
    return false;
  }
  if (interaction.memberPermissions && !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ embeds: [errorEmbed('Permission refusée', 'La permission **Gérer le serveur** est requise.')], ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('starterpack')
    .setDescription('🚀 Installer la structure et les panneaux essentiels du serveur')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    if (!interaction.inGuild()) return;

    const state = await getState(interaction.guildId).catch(() => null);
    if (!state) {
      return interaction.reply({ embeds: [errorEmbed('Base indisponible', 'Impossible de lire l\'état du Starter Pack pour le moment.')], ephemeral: true });
    }

    const { payload } = previewPayload(interaction.guild, state);
    return interaction.reply({ ...payload, ephemeral: true });
  },

  // ── Boutons du panneau (ids `sp_*`) ─────────────────────────────────────────
  async handleButton(interaction) {
    if (!interaction.inGuild()) return;
    if (!(await guard(interaction))) return;

    const id = interaction.customId;
    const guild = interaction.guild;
    let state = await getState(interaction.guildId);
    const startedAt = Date.now();
    let lastProgress = 0;

    const progress = label => async () => {
      if (Date.now() - lastProgress < PROGRESS_THROTTLE_MS) return;
      lastProgress = Date.now();
      await interaction.editReply({ embeds: [pack.buildBusyEmbed(label)], components: [] }).catch(() => {});
    };

    try {
      // ── Aperçu ────────────────────────────────────────────────────────────
      if (id === 'sp_refresh' || id === 'sp_back') {
        return interaction.update(previewPayload(guild, state).payload);
      }

      if (id === 'sp_close') {
        return interaction.update({ embeds: [infoEmbed('Panneau fermé', 'Relance `/starterpack` pour le rouvrir.')], components: [] });
      }

      // ── Statut ────────────────────────────────────────────────────────────
      if (id === 'sp_status') {
        const plan = pack.buildPlan(guild, state);
        return interaction.update({ embeds: [pack.buildStatusEmbed(guild, state, plan)], components: pack.buildBackComponents() });
      }

      // ── Installation ──────────────────────────────────────────────────────
      if (id === 'sp_install') {
        const plan = pack.buildPlan(guild, state);
        if (!plan.toCreate) {
          return interaction.update({
            embeds: [infoEmbed('Rien à faire', 'Tous les éléments du Starter Pack sont déjà en place. Utilise 📋 **Statut** pour voir le détail.')],
            components: pack.buildBackComponents(),
          });
        }

        await interaction.update({ embeds: [pack.buildBusyEmbed(null)], components: [] });

        const report = await pack.install(guild, plan, {
          state,
          persist: () => state.save().catch(() => {}),
          onProgress: progress,
        });

        state.status = 'installed';
        state.version = pack.PACK_VERSION;
        state.installedAt = new Date();
        state.installedBy = interaction.user.id;
        state.addHistory(
          `Installation par ${interaction.user.tag || interaction.user.id} — `
          + `${report.createdRoles.length} rôle(s), ${report.createdCategories.length} catégorie(s), `
          + `${report.createdChannels.length} salon(s), ${report.createdPanels.length} panneau(x)`
          + (report.failed.length ? `, ${report.failed.length} échec(s)` : ''),
        );
        await state.save().catch(() => {});

        const planAfter = pack.buildPlan(guild, state);
        return interaction.editReply({
          embeds: [
            pack.buildInstallEmbed(report, { durationMs: Date.now() - startedAt }),
            pack.buildStatusEmbed(guild, state, planAfter),
          ],
          components: pack.buildPreviewComponents({ installed: createdCount(state) > 0 }),
        });
      }

      // ── Désinstallation (confirmation puis suppression) ────────────────────
      if (id === 'sp_uninstall') {
        if (!createdCount(state)) {
          return interaction.update({
            embeds: [infoEmbed('Rien à désinstaller', 'Le pack n\'a encore rien créé sur ce serveur.')],
            components: pack.buildBackComponents(),
          });
        }
        return interaction.update(pack.buildUninstallConfirmPayload(state));
      }

      if (id === 'sp_uninstall_confirm') {
        await interaction.update({ embeds: [pack.buildBusyEmbed(null)], components: [] });

        const report = await pack.uninstall(guild, state, { onProgress: progress });
        state.status = 'removed';
        state.removedAt = new Date();
        state.removedBy = interaction.user.id;
        state.addHistory(
          `Désinstallation par ${interaction.user.tag || interaction.user.id} — `
          + `${report.removedChannels.length} salon(s), ${report.removedRoles.length} rôle(s)`
          + (report.failed.length ? `, ${report.failed.length} échec(s)` : ''),
        );
        await state.save().catch(() => {});

        const { payload } = previewPayload(guild, state, '_Les réglages du staff (règlement, panneaux, avis) restent enregistrés._');
        return interaction.editReply({ embeds: [pack.buildUninstallEmbed(report), payload.embeds[0]], components: payload.components });
      }
    } catch (err) {
      console.error(`❌ /${COMMAND} (${id}) :`, err);
      const embed = new EmbedBuilder()
        .setColor(COLORS.error)
        .setTitle('❌ Opération interrompue')
        .setDescription(`Une erreur est survenue : \`${String(err.message).slice(0, 200)}\`\n\nRelance \`/starterpack\` pour voir l'état réel — tout ce qui a été créé est réversible.`);
      return interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sp_refresh').setLabel('Rafraîchir').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
      )] }).catch(() => {});
    }
  },

  // Exposé pour les tests
  _internal: { getState, ensureLists, createdCount, previewPayload, guard },
};
