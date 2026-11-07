'use strict';
// commands/bump-reseau/pont.js — 🌐 Le pont inter-serveurs.
//
// `/pont` ouvre le panneau : salon à relier, canal commun, filtres, rythme
// anti-spam, serveurs ignorés, réseau. `/pont salon:#général hub:gaming` relie
// directement et affiche le même panneau déjà réglé.
//
// Tout se fait dans le message : un collecteur unique route les boutons et les
// menus, chaque choix est enregistré immédiatement et la vue est redessinée
// avec ce qui vient de changer. Aucune sous-commande à retenir.

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const engine = require('../../utils/bridgeEngine');
const panel = require('../../utils/bridgePanel');
const hubs = require('../../utils/bridgeHubs');
const { errorEmbed } = require('../../utils/embeds');

const COLLECTOR_MS = 15 * 60 * 1000;

function guildNameOf(client, id) {
  const name = client?.guilds?.cache?.get?.(id)?.name;
  return name || `Serveur ${String(id).slice(-4)}`;
}

async function fetchChannel(guild, channelId) {
  return guild.channels?.cache?.get?.(channelId)
    || await guild.channels?.fetch?.(channelId).catch?.(() => null)
    || null;
}

async function handleComponent(interaction, client) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ embeds: [errorEmbed('Serveur uniquement', 'Le pont relie des serveurs, pas des messages privés.')], ephemeral: true }).catch(() => {});

  await interaction.deferUpdate().catch(() => {});
  const id = interaction.customId;

  let cfg = await engine.getConfig(guild.id, { fresh: true });
  let note = null;
  let view = 'panel';
  let network = null;

  const toggleValue = (key) => !(cfg?.[key] ?? engine.DEFAULTS[key]);

  if (id === panel.IDS.channel) {
    const channelId = interaction.values?.[0];
    const channel = channelId ? await fetchChannel(guild, channelId) : null;
    if (!channel) {
      note = '❌ Salon introuvable : réessaie avec un autre salon.';
    } else {
      const result = await engine.linkChannel({
        client, guild, channel, hub: cfg?.hub, userId: interaction.user?.id,
      });
      note = result.ok
        ? `✅ **#${channel.name}** est relié au canal ${hubs.hubLabel(result.hub)}.`
        : `❌ ${result.error}`;
      cfg = await engine.getConfig(guild.id, { fresh: true });
    }
  } else if (id === panel.IDS.hub) {
    const hub = interaction.values?.[0];
    await engine.updateConfig(guild.id, { hub });
    note = `✅ Canal commun : ${hubs.hubLabel(hub)}.`;
  } else if (id === panel.IDS.toggle) {
    if (!cfg?.channelId) {
      note = '❌ Choisis d’abord un salon ci-dessus.';
    } else {
      const next = toggleValue('enabled');
      await engine.updateConfig(guild.id, { enabled: next });
      note = next
        ? '▶️ Pont **activé** : les messages circulent de nouveau.'
        : '⏸️ Pont **en pause** : plus rien ne sort, rien n’entre.';
    }
  } else if (id === panel.IDS.filters) {
    view = 'filters';
  } else if (id === panel.IDS.blocks) {
    view = 'blocks';
  } else if (id === panel.IDS.network) {
    view = 'network';
    network = await engine.networkStats();
  } else if (id === panel.IDS.antispam) {
    // Même identifiant pour le bouton (ouvrir) et le menu (choisir) : c'est la
    // présence de `values` qui distingue les deux.
    const preset = panel.presetById(interaction.values?.[0]);
    if (!preset) {
      view = 'antispam';
    } else {
      await engine.updateConfig(guild.id, {
        rateLimit: preset.rateLimit,
        rateWindowSeconds: preset.rateWindowSeconds,
      });
      note = `✅ Anti-spam **${preset.label}** : ${preset.description}.`;
    }
  } else if (id === panel.IDS.refresh) {
    view = 'panel';
  } else if (id === panel.IDS.block) {
    const target = String(interaction.values?.[0] || '');
    const blocked = new Set((cfg?.blockedGuilds || []).map(String));
    if (!target || target === guild.id) {
      note = '❌ Ce serveur ne peut pas être ignoré.';
    } else if (blocked.size >= 25) {
      note = '❌ 25 serveurs ignorés au maximum.';
    } else {
      blocked.add(target);
      await engine.updateConfig(guild.id, { blockedGuilds: [...blocked] });
      note = `🚫 **${guildNameOf(client, target)}** est ignoré : plus aucun échange dans les deux sens.`;
    }
    view = 'blocks';
  } else if (id === panel.IDS.unblock) {
    const target = String(interaction.values?.[0] || '');
    const blocked = (cfg?.blockedGuilds || []).map(String).filter(entry => entry !== target);
    await engine.updateConfig(guild.id, { blockedGuilds: blocked });
    note = `✅ **${guildNameOf(client, target)}** peut de nouveau échanger avec ce serveur.`;
    view = 'blocks';
  } else if (id === panel.IDS.unlink) {
    view = 'confirm';
  } else if (id === panel.IDS.unlinkConfirm) {
    await engine.unlinkChannel(guild.id, client);
    note = '🔌 Salon **délié**. Les réglages sont conservés : un salon suffit à repartir.';
  } else if (id === panel.IDS.back) {
    view = 'panel';
  } else {
    const field = panel.toggleFieldOf(id);
    if (field) {
      const next = toggleValue(field);
      await engine.updateConfig(guild.id, { [field]: next });
      note = `✅ **${field}** : ${next ? '🟢 activé' : '🔴 désactivé'}.`;
      view = 'filters';
    }
  }

  cfg = await engine.getConfig(guild.id, { fresh: true });
  const peers = view === 'blocks' ? await engine.peerServers(cfg, client) : [];

  return interaction.editReply(panel.render(cfg, {
    guild,
    note,
    view,
    peers,
    resolveName: target => guildNameOf(client, target),
    network,
  })).catch(() => {});
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pont')
    .setDescription('🌐 Relier un salon au chat inter-serveurs')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option => option
      .setName('salon')
      .setDescription('Salon à relier au pont (facultatif : le panneau s’ouvre)'))
    .addStringOption(option => option
      .setName('hub')
      .setDescription('Canal commun à rejoindre')
      .addChoices(...hubs.hubChoices())),

  async execute(interaction, client) {
    if (!interaction.guild) {
      return interaction.reply({
        embeds: [errorEmbed('Serveur uniquement', 'Le pont relie des serveurs, pas des messages privés.')],
        ephemeral: true,
      }).catch(() => {});
    }

    const options = interaction.options;
    const salon = typeof options?.getChannel === 'function' ? options.getChannel('salon') : null;
    const hubChoice = typeof options?.getString === 'function' ? options.getString('hub') : null;

    let note = null;
    if (salon) {
      const result = await engine.linkChannel({
        client,
        guild: interaction.guild,
        channel: salon,
        hub: hubChoice || (await engine.getConfig(interaction.guild.id))?.hub,
        userId: interaction.user?.id,
      });
      note = result.ok
        ? `✅ **#${salon.name || 'salon'}** est relié au canal ${hubs.hubLabel(result.hub)}.`
        : `❌ ${result.error}`;
    } else if (hubChoice) {
      await engine.updateConfig(interaction.guild.id, { hub: hubChoice });
      note = `✅ Canal commun : ${hubs.hubLabel(hubChoice)}.`;
    }

    const cfg = await engine.getConfig(interaction.guild.id, { fresh: true });
    const payload = panel.render(cfg, { guild: interaction.guild, note });

    let message;
    if (interaction.deferred || interaction.replied) {
      message = await interaction.editReply(payload).catch(() => null);
    } else {
      message = await interaction.reply({ ...payload, ephemeral: true, fetchReply: true }).catch(() => null);
    }
    if (!message) return;

    const collector = message.createMessageComponentCollector?.({
      filter: component => component.user.id === interaction.user.id,
      time: COLLECTOR_MS,
    });
    if (!collector) return;

    collector.on('collect', component => handleComponent(component, client).catch(err => {
      console.error('pont → interaction:', err.message);
      component.followUp({ content: '❌ Action impossible pour le moment, réessaie.', ephemeral: true }).catch(() => {});
    }));
    collector.on('end', () => message.edit({ components: [] }).catch(() => {}));
  },
};
