'use strict';
// commands/utilitaires/statut-site.js — Surveillance de sites web.
//
// UNE SEULE commande pour tout : ajouter/retirer un site, choisir le salon
// d'alerte, la fréquence, le seuil d'échecs, les mots qui signalent une
// maintenance et le message d'alerte. Le bot vérifie ensuite les sites tout seul
// (cron chaque minute, chaque site à sa fréquence) et prévient à chaque
// transition : en ligne → hors ligne → maintenance → rétabli.
//
// Les interactions sont routées par events/core/interactionCreate.js (préfixe
// `site_`), ce qui garde le panel utilisable même après un redémarrage.

const {
  SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const SiteMonitor = require('../../models/SiteMonitor');
const engine = require('../../utils/siteMonitorEngine');
const view = require('../../utils/siteMonitorView');
const { successEmbed, errorEmbed, warningEmbed } = require('../../utils/embeds');
const { MAX_SITES, DEFAULT_MAINTENANCE_KEYWORDS } = require('../../utils/siteStatus');

// ─── Accès & configuration ──────────────────────────────────────────────────
function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
}

async function requireAccess(interaction) {
  if (!interaction.inGuild?.()) {
    await interaction.reply({ embeds: [errorEmbed('Serveur requis', 'Cette commande s’utilise sur un serveur.')], ephemeral: true }).catch(() => {});
    return false;
  }
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur** pour surveiller des sites.')],
      ephemeral: true,
    }).catch(() => {});
    return false;
  }
  return true;
}

async function getConfig(guildId) {
  return SiteMonitor.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

function panelPayload(config, guild) {
  return {
    embeds: [view.buildPanelEmbed(config, guild)],
    components: view.buildPanelComponents(config),
  };
}

function settingsPayload(config) {
  return {
    embeds: [view.buildSettingsEmbed(config)],
    components: view.buildSettingsComponents(config),
  };
}

function sitePayload(config, site) {
  return {
    embeds: [view.buildSiteEmbed(config, site)],
    components: view.buildSiteComponents(site),
  };
}

function confirmPayload(site) {
  return {
    embeds: [view.buildConfirmEmbed(site)],
    components: view.buildConfirmComponents(site),
  };
}

// ─── Modaux ─────────────────────────────────────────────────────────────────
function textInput(id, label, { value = '', placeholder = null, max = 300, required = false, style = TextInputStyle.Short } = {}) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label.slice(0, 45))
    .setStyle(style)
    .setMaxLength(max)
    .setRequired(required);
  if (value) input.setValue(String(value).slice(0, max));
  if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(input);
}

function addSiteModal() {
  return new ModalBuilder()
    .setCustomId('site_modal_add')
    .setTitle('Ajouter un site à surveiller')
    .addComponents(
      textInput('url', 'URL du site', { placeholder: 'https://exemple.com', max: 300, required: true }),
      textInput('label', 'Nom affiché (optionnel)', { placeholder: 'Mon site', max: 80 }),
      textInput('keywords', 'Mots de maintenance pour ce site (optionnel)', {
        placeholder: 'maintenance, indisponible', max: 300,
      }),
    );
}

function keywordsModal(config) {
  const keywords = config.maintenanceKeywords?.length ? config.maintenanceKeywords : DEFAULT_MAINTENANCE_KEYWORDS;
  return new ModalBuilder()
    .setCustomId('site_modal_keywords')
    .setTitle('Mots signalant une maintenance')
    .addComponents(textInput('keywords', 'Mots (séparés par des virgules)', {
      value: keywords.join(', '), max: 400, style: TextInputStyle.Paragraph,
      placeholder: 'maintenance, temporairement indisponible',
    }));
}

function messageModal(config) {
  return new ModalBuilder()
    .setCustomId('site_modal_message')
    .setTitle('Message d’alerte')
    .addComponents(textInput('message', 'Texte (vide = message par défaut)', {
      value: config.alertMessage || '', max: 500, required: false, style: TextInputStyle.Paragraph,
      placeholder: '🔴 {site} est injoignable — code {code}',
    }));
}

function siteKeywordsModal(config, site) {
  const declared = site.maintenanceKeywords?.length ? site.maintenanceKeywords : [];
  const inherited = config.maintenanceKeywords?.length ? config.maintenanceKeywords : DEFAULT_MAINTENANCE_KEYWORDS;
  return new ModalBuilder()
    .setCustomId(`site_modal_sitekeywords:${site._id}`)
    .setTitle('Mots de maintenance du site')
    .addComponents(textInput('keywords', 'Vide = mots du serveur', {
      value: declared.join(', '), max: 400, style: TextInputStyle.Paragraph,
      placeholder: inherited.slice(0, 3).join(', '),
    }));
}

// ─── Commande ───────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('statut-site')
    .setDescription('🛰️ Surveiller des sites web : en ligne, en maintenance ou hors ligne')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    if (!(await requireAccess(interaction))) return;
    const config = await getConfig(interaction.guildId).catch(err => {
      console.error('[SiteMonitor] chargement:', err.message);
      return null;
    });
    if (!config) {
      return interaction.reply({ embeds: [errorEmbed('Base injoignable', 'Impossible de charger la surveillance pour le moment. Réessaie dans un instant.')], ephemeral: true });
    }
    return interaction.reply({ ...panelPayload(config, interaction.guild), ephemeral: true });
  },

  // ─── Boutons ──────────────────────────────────────────────────────────────
  async handleButton(interaction, client) {
    if (!(await requireAccess(interaction))) return;
    const config = await getConfig(interaction.guildId);
    const [action, arg] = interaction.customId.slice('site_'.length).split(':');

    if (action === 'add') return interaction.showModal(addSiteModal());
    if (action === 'back') return interaction.update(panelPayload(config, interaction.guild));
    if (action === 'settings') return interaction.update(settingsPayload(config));
    if (action === 'settings_keywords') return interaction.showModal(keywordsModal(config));
    if (action === 'settings_message') return interaction.showModal(messageModal(config));

    if (action === 'enable' || action === 'disable') {
      config.enabled = action === 'enable';
      await config.save();
      return interaction.update(panelPayload(config, interaction.guild));
    }

    if (action === 'checkall') {
      await interaction.deferUpdate();
      const summary = await engine.checkConfig(config, {
        force: true,
        notify: payload => engine.sendAlert(client, payload),
      });
      const detail = summary.checked
        ? `${summary.checked} site(s) vérifié(s)${summary.alerts.length ? ` — ${summary.alerts.length} changement(s) d’état détecté(s)` : ' — aucun changement d’état'}`
        : 'Aucun site actif à vérifier : ajoutez un site ou réactivez-en un.';
      return interaction.editReply({
        embeds: [(summary.checked ? successEmbed : warningEmbed)('Vérification terminée', detail), view.buildPanelEmbed(config, interaction.guild)],
        components: view.buildPanelComponents(config),
      });
    }

    const site = arg ? engine.findSite(config, arg) : null;
    if (!site) {
      return interaction.update({
        embeds: [errorEmbed('Site introuvable', 'Il a peut-être été supprimé — retour au panel.'), view.buildPanelEmbed(config, interaction.guild)],
        components: view.buildPanelComponents(config),
      });
    }

    if (action === 'open') return interaction.update(sitePayload(config, site));

    if (action === 'delete') return interaction.update(confirmPayload(site));

    if (action === 'delete_yes') {
      const removed = engine.removeSite(config, arg);
      if (!removed.ok) {
        return interaction.update(panelPayload(config, interaction.guild));
      }
      await config.save();
      return interaction.update({
        embeds: [successEmbed('Site retiré', `**${engine.siteDisplayName(removed.site)}** n’est plus surveillé.`), view.buildPanelEmbed(config, interaction.guild)],
        components: view.buildPanelComponents(config),
      });
    }

    if (action === 'pause') {
      site.enabled = site.enabled === false;
      await config.save();
      return interaction.update(sitePayload(config, site));
    }

    if (action === 'sitekeywords') return interaction.showModal(siteKeywordsModal(config, site));

    if (action === 'check') {
      await interaction.deferUpdate();
      await engine.checkConfig(config, {
        force: true,
        only: [String(site._id)],
        notify: payload => engine.sendAlert(client, payload),
      });
      const fresh = engine.findSite(config, arg) || site;
      return interaction.editReply(sitePayload(config, fresh));
    }

    return undefined;
  },

  // ─── Menus ────────────────────────────────────────────────────────────────
  async handleSelect(interaction) {
    if (!(await requireAccess(interaction))) return;
    const config = await getConfig(interaction.guildId);
    const [action, arg] = interaction.customId.slice('site_'.length).split(':');
    const value = interaction.values?.[0];

    if (action === 'select') {
      const site = engine.findSite(config, value);
      if (!site) return interaction.update(panelPayload(config, interaction.guild));
      return interaction.update(sitePayload(config, site));
    }

    if (action === 'interval') {
      const minutes = Math.min(120, Math.max(5, Number(value) || config.intervalMinutes));
      config.intervalMinutes = minutes;
      await config.save();
      return interaction.update(settingsPayload(config));
    }

    if (action === 'threshold') {
      config.failureThreshold = Math.min(5, Math.max(1, Number(value) || config.failureThreshold));
      await config.save();
      return interaction.update(settingsPayload(config));
    }

    if (action === 'channel') {
      config.channelId = value;
      await config.save();
      await interaction.update(settingsPayload(config));
      const channel = interaction.guild.channels.cache.get(value)
        || await interaction.guild.channels.fetch(value).catch(() => null);
      const permissions = channel?.permissionsFor?.(interaction.guild.members.me);
      if (permissions && !permissions.has(['SendMessages', 'EmbedLinks'])) {
        return interaction.followUp({
          embeds: [warningEmbed('Permissions incomplètes', `Le bot ne peut pas écrire dans <#${value}> : il lui faut **Envoyer des messages** et **Intégrer des liens**.`)],
          ephemeral: true,
        });
      }
      return undefined;
    }

    return undefined;
  },

  // ─── Modaux soumis ────────────────────────────────────────────────────────
  async handleModal(interaction) {
    if (!(await requireAccess(interaction))) return;
    const config = await getConfig(interaction.guildId);
    const id = interaction.customId;
    const value = name => interaction.fields.getTextInputValue(name) || '';

    if (id === 'site_modal_add') {
      const result = engine.addSite(config, {
        url: value('url'),
        label: value('label').trim() || null,
        keywords: engine.parseKeywords(value('keywords')),
      });
      if (!result.ok) {
        return interaction.reply({ embeds: [errorEmbed('Site refusé', result.error)], ephemeral: true });
      }
      await config.save();
      return interaction.reply({
        embeds: [
          successEmbed('Site ajouté', `**${engine.siteDisplayName(result.site)}** sera vérifié lors du prochain passage (vous pouvez forcer avec **Vérifier maintenant**).`),
          view.buildPanelEmbed(config, interaction.guild),
        ],
        components: view.buildPanelComponents(config),
        ephemeral: true,
      });
    }

    if (id === 'site_modal_keywords') {
      const keywords = engine.parseKeywords(value('keywords'));
      config.maintenanceKeywords = keywords;
      await config.save();
      return interaction.reply({
        embeds: [successEmbed('Mots de maintenance mis à jour', keywords.length ? `\`${keywords.join('`, `')}\`` : 'Liste vide : les mots par défaut du bot s’appliquent.'), view.buildSettingsEmbed(config)],
        components: view.buildSettingsComponents(config),
        ephemeral: true,
      });
    }

    if (id === 'site_modal_message') {
      const message = value('message').trim();
      config.alertMessage = message ? message.slice(0, 500) : null;
      await config.save();
      return interaction.reply({
        embeds: [successEmbed('Message d’alerte mis à jour', config.alertMessage || '*Message par défaut rétabli.*'), view.buildSettingsEmbed(config)],
        components: view.buildSettingsComponents(config),
        ephemeral: true,
      });
    }

    if (id.startsWith('site_modal_sitekeywords:')) {
      const siteId = id.split(':')[1];
      const site = engine.findSite(config, siteId);
      if (!site) {
        return interaction.reply({ embeds: [errorEmbed('Site introuvable', 'Il a peut-être été supprimé.')], ephemeral: true });
      }
      site.maintenanceKeywords = engine.parseKeywords(value('keywords'));
      await config.save();
      return interaction.reply({
        embeds: [
          successEmbed('Mots du site mis à jour', site.maintenanceKeywords.length ? `\`${site.maintenanceKeywords.join('`, `')}\`` : '*Liste vide : les mots du serveur s’appliquent.*'),
          view.buildSiteEmbed(config, site),
        ],
        components: view.buildSiteComponents(site),
        ephemeral: true,
      });
    }

    return undefined;
  },

  // Exposés pour les tests (aucune interaction Discord requise).
  isAdmin,
  _maxSites: MAX_SITES,
};
