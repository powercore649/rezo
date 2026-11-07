'use strict';
// commands/planet.js — 🌍 Jeu complet de gestion de planète, piloté depuis un panel unique
// Créez votre planète, faites-la grandir (niveaux, bâtiments, population), le tout en emojis
// unicode (aucune image), avec boutons, select menu et statistiques en direct.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');

const Planet = require('../../models/Planet');
const { COLORS, successEmbed, errorEmbed, infoEmbed } = require('../../utils/embeds');
const {
  BIOMES, BUILDINGS, getGrowthStage, getBuildingCost, xpForNextLevel,
  checkHarvestCooldown, getPopulationCapacity, applyHarvest, applyBuild, renderProgressBar,
} = require('../../utils/planetEngine');

const HARVEST_COOLDOWN_MIN = 20;
const COLLECTOR_TIMEOUT_MS = 10 * 60 * 1000;

const HARVEST_FLAVOR = [
  '🌠 Une pluie d\'étoiles filantes traverse le ciel.',
  '🛰️ Vos ingénieurs optimisent la production.',
  '🌤️ Une météo idéale booste le moral des habitants.',
  '📡 Un signal lointain intrigue vos scientifiques.',
  '🌱 De nouvelles cultures prennent racine.',
];

function resBar(current, cap) {
  const pct = cap > 0 ? Math.min(1, current / cap) : (current > 0 ? 1 : 0);
  const filled = Math.round(pct * 10);
  return '🟦'.repeat(filled) + '⬜'.repeat(10 - filled);
}

function happinessEmoji(h) {
  if (h >= 80) return '😄';
  if (h >= 50) return '🙂';
  if (h >= 25) return '😐';
  return '😟';
}

// ═══════════════════════════════════════════════════════════════════════════
//  Rendu du panel principal (dashboard)
// ═══════════════════════════════════════════════════════════════════════════
function buildDashboard(planet, username) {
  const stage = getGrowthStage(planet.level);
  const biome = BIOMES[planet.type];
  const capacity = getPopulationCapacity(planet);
  const needed = xpForNextLevel(planet.level);

  const buildingsLines = Object.entries(BUILDINGS)
    .map(([key, def]) => `${def.label} : **${planet.buildings[key] || 0}**`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`${stage.emoji} ${planet.name}`)
    .setDescription(
      `${biome.emoji} Planète **${biome.label}** · ${stage.label}\n` +
      `Niveau **${planet.level}** — ${renderProgressBar(planet)} (${planet.xp}/${needed} XP)`
    )
    .addFields(
      { name: '👥 Population', value: `${planet.population} / ${capacity}\n${resBar(planet.population, capacity)}`, inline: true },
      { name: `${happinessEmoji(planet.happiness)} Bonheur`, value: `${planet.happiness}/100\n${resBar(planet.happiness, 100)}`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '🌾 Nourriture', value: `${planet.resources.food}`, inline: true },
      { name: '⚡ Énergie', value: `${planet.resources.energy}`, inline: true },
      { name: '⛏️ Minerais', value: `${planet.resources.minerals}`, inline: true },
      { name: '🏗️ Bâtiments', value: buildingsLines, inline: false },
    )
    .setFooter({ text: `Fondateur : ${username} · Récolte disponible toutes les ${HARVEST_COOLDOWN_MIN} min` })
    .setTimestamp();

  const cooldown = checkHarvestCooldown(planet.lastHarvest, HARVEST_COOLDOWN_MIN);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('planet_harvest').setLabel(cooldown.ok ? '🌾 Récolter' : `⏱️ ${cooldown.remainingMinutes} min`).setStyle(ButtonStyle.Success).setDisabled(!cooldown.ok),
    new ButtonBuilder().setCustomId('planet_build').setLabel('🏗️ Construire').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('planet_refresh').setLabel('🔄 Actualiser').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('planet_rename').setLabel('✏️ Renommer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('planet_reset').setLabel('🗑️ Réinitialiser').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2] };
}

function buildBuildMenu(planet) {
  const options = Object.entries(BUILDINGS)
    .filter(([, def]) => planet.level >= def.unlockLevel)
    .map(([key, def]) => {
      const count = planet.buildings[key] || 0;
      const cost = getBuildingCost(key, count);
      const costStr = Object.entries(cost).map(([r, a]) => `${a} ${r}`).join(', ');
      return { label: `${def.label} (${count})`, value: key, description: `Coût : ${costStr}` };
    });

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🏗️ Construire un bâtiment')
    .setDescription(
      Object.entries(BUILDINGS).map(([key, def]) => {
        const locked = planet.level < def.unlockLevel;
        return locked ? `🔒 ${def.label} — débloqué au niveau ${def.unlockLevel}` : `${def.label} — ${planet.buildings[key] || 0} construit(s)`;
      }).join('\n')
    );

  const menu = new StringSelectMenuBuilder().setCustomId('planet_build_select').setPlaceholder('Choisir un bâtiment à construire...').addOptions(options);
  const back = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('planet_back').setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu), back] };
}

function buildBiomeSelectRow() {
  const menu = new StringSelectMenuBuilder().setCustomId('planet_biome_select').setPlaceholder('Choisissez le biome de votre planète...')
    .addOptions(Object.entries(BIOMES).map(([key, def]) => ({ label: def.label, value: key, emoji: def.emoji })));
  return new ActionRowBuilder().addComponents(menu);
}

// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  data: new SlashCommandBuilder()
    .setName('planet')
    .setDescription('🌍 Créez et faites grandir votre propre planète'),

  async execute(interaction) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    let planet = await Planet.findOne({ guildId, userId });

    // ── Pas encore de planète : flux de création ──────────────────────────
    if (!planet) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle('🌌 Bienvenue, futur créateur de monde !')
        .setDescription('Vous n\'avez pas encore de planète. Cliquez ci-dessous pour fonder la vôtre et commencer à la faire grandir. 🚀');
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('planet_create').setLabel('🌍 Créer ma planète').setStyle(ButtonStyle.Success));

      const reply = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true, fetchReply: true });
      const click = await reply.awaitMessageComponent({ filter: i => i.user.id === userId, time: COLLECTOR_TIMEOUT_MS }).catch(() => null);
      if (!click) return interaction.editReply({ components: [] }).catch(() => {});

      const modal = new ModalBuilder().setCustomId('planet_create_modal').setTitle('🌍 Nommez votre planète');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('planet_name').setLabel('Nom de votre planète').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32).setPlaceholder('Ex : Nova Terra'),
      ));
      await click.showModal(modal);

      const modalSubmit = await click.awaitModalSubmit({ filter: i => i.user.id === userId && i.customId === 'planet_create_modal', time: 5 * 60 * 1000 }).catch(() => null);
      if (!modalSubmit) return;

      const name = modalSubmit.fields.getTextInputValue('planet_name').trim().slice(0, 32);
      const biomeMsg = await modalSubmit.reply({
        embeds: [infoEmbed('🧬 Choisissez un biome', `**${name}** attend sa nature ! Chaque biome offre un léger bonus de production.`)],
        components: [buildBiomeSelectRow()],
        ephemeral: true, fetchReply: true,
      });

      const biomePick = await biomeMsg.awaitMessageComponent({ filter: i => i.user.id === userId, time: 5 * 60 * 1000 }).catch(() => null);
      if (!biomePick) return;

      planet = await Planet.create({ guildId, userId, name, type: biomePick.values[0] });
      return biomePick.update(buildDashboard(planet, interaction.user.username));
    }

    // ── Dashboard existant ─────────────────────────────────────────────────
    const payload = buildDashboard(planet, interaction.user.username);
    const reply = await interaction.reply({ ...payload, ephemeral: true, fetchReply: true });
    attachCollector(reply, interaction, planet);
  },

  async handleModal(interaction) {
    if (interaction.customId !== 'planet_rename_modal') return;
    const planet = await Planet.findOne({ guildId: interaction.guildId, userId: interaction.user.id });
    if (!planet) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Vous n\'avez plus de planète.')], ephemeral: true });

    const newName = interaction.fields.getTextInputValue('planet_name').trim().slice(0, 32);
    planet.name = newName;
    await planet.save();

    return interaction.update(buildDashboard(planet, interaction.user.username)).catch(() =>
      interaction.reply({ embeds: [successEmbed('Renommée !', `Votre planète s'appelle maintenant **${newName}**.`)], ephemeral: true }));
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Collecteur du dashboard (récolte, construction, renommage, reset)
// ═══════════════════════════════════════════════════════════════════════════
function attachCollector(message, interaction, planet) {
  const userId = interaction.user.id;
  const collector = message.createMessageComponentCollector({ filter: i => i.user.id === userId, time: COLLECTOR_TIMEOUT_MS });

  collector.on('collect', async (i) => {
    const id = i.customId;

    if (id === 'planet_refresh' || id === 'planet_back') {
      planet = await Planet.findOne({ guildId: interaction.guildId, userId });
      if (!planet) return i.update({ embeds: [infoEmbed('Planète détruite', 'Utilisez `/planet` pour en refonder une nouvelle.')], components: [] });
      return i.update(buildDashboard(planet, interaction.user.username));
    }

    if (id === 'planet_harvest') {
      planet = await Planet.findOne({ guildId: interaction.guildId, userId });
      if (!planet) return i.update({ embeds: [infoEmbed('Planète détruite', 'Utilisez `/planet` pour en refonder une nouvelle.')], components: [] });

      const cooldown = checkHarvestCooldown(planet.lastHarvest, HARVEST_COOLDOWN_MIN);
      if (!cooldown.ok) return i.reply({ content: `⏱️ Encore **${cooldown.remainingMinutes} min** avant la prochaine récolte.`, ephemeral: true });

      const result = applyHarvest(planet);
      await planet.save();

      const flavor = HARVEST_FLAVOR[Math.floor(Math.random() * HARVEST_FLAVOR.length)];
      const gainsStr = Object.entries(result.gains).filter(([, v]) => v > 0).map(([r, v]) => `+${v} ${r}`).join(' · ') || 'rien de neuf';
      let summary = `${flavor}\n\n🌾 ${gainsStr}\n📈 +${result.xpGained} XP`;
      if (result.populationChange > 0) summary += `\n👥 +${result.populationChange} habitants`;
      if (result.populationChange < 0) summary += `\n⚠️ ${result.populationChange} habitants (famine !)`;
      if (result.levelResult?.leveledUp) summary += `\n\n🎉 **Niveau supérieur !** Votre planète atteint maintenant le niveau **${result.levelResult.newLevel}** !`;

      await i.reply({ embeds: [successEmbed('🌾 Récolte effectuée', summary)], ephemeral: true });
      return i.message.edit(buildDashboard(planet, interaction.user.username)).catch(() => {});
    }

    if (id === 'planet_build') {
      planet = await Planet.findOne({ guildId: interaction.guildId, userId });
      if (!planet) return i.update({ embeds: [infoEmbed('Planète détruite', 'Utilisez `/planet` pour en refonder une nouvelle.')], components: [] });
      return i.update(buildBuildMenu(planet));
    }

    if (id === 'planet_build_select') {
      planet = await Planet.findOne({ guildId: interaction.guildId, userId });
      if (!planet) return i.update({ embeds: [infoEmbed('Planète détruite', 'Utilisez `/planet` pour en refonder une nouvelle.')], components: [] });

      const result = applyBuild(planet, i.values[0]);
      if (!result.ok) {
        const label = BUILDINGS[i.values[0]]?.label || i.values[0];
        const msg = result.error === 'level_locked'
          ? `🔒 **${label}** nécessite un niveau supérieur.`
          : `❌ Ressources insuffisantes pour **${label}** (coût : ${Object.entries(result.cost).map(([r, a]) => `${a} ${r}`).join(', ')}).`;
        return i.reply({ content: msg, ephemeral: true });
      }

      await planet.save();
      let summary = `${BUILDINGS[i.values[0]].label} construit(e) avec succès !`;
      if (result.levelResult?.leveledUp) summary += `\n\n🎉 **Niveau supérieur !** Votre planète atteint maintenant le niveau **${result.levelResult.newLevel}** !`;
      await i.reply({ embeds: [successEmbed('🏗️ Construction terminée', summary)], ephemeral: true });
      return i.message.edit(buildBuildMenu(planet)).catch(() => {});
    }

    if (id === 'planet_rename') {
      const modal = new ModalBuilder().setCustomId('planet_rename_modal').setTitle('✏️ Renommer votre planète');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('planet_name').setLabel('Nouveau nom').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32).setValue(planet.name),
      ));
      return i.showModal(modal);
    }

    if (id === 'planet_reset') {
      const embed = errorEmbed('⚠️ Confirmer la destruction', `Voulez-vous vraiment détruire **${planet.name}** ? Cette action est irréversible.`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('planet_reset_confirm').setLabel('💥 Détruire définitivement').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('planet_back').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
      );
      return i.update({ embeds: [embed], components: [row] });
    }

    if (id === 'planet_reset_confirm') {
      await Planet.deleteOne({ guildId: interaction.guildId, userId });
      collector.stop('destroyed');
      return i.update({ embeds: [infoEmbed('💥 Planète détruite', 'Utilisez `/planet` quand vous voulez en fonder une nouvelle.')], components: [] });
    }
  });

  collector.on('end', (_, reason) => {
    if (reason === 'destroyed') return;
    interaction.editReply({ components: [] }).catch(() => {});
  });
}
