// commands/leveling.js — Panel de configuration complet du système XP/leveling
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, AttachmentBuilder,
  ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder,
  PermissionFlagsBits, ChannelType,
} = require('discord.js');
const XPConfig = require('../../models/XPConfig');
const XP = require('../../models/XP');
const { getOrCreateConfig } = require('../xp/xp');
const rankCmd = require('../xp/rank');
const { renderRankCard } = require('../../utils/rankCard');
const { renderLevelUpCard } = require('../../utils/levelUpCard');
const { resolveCardTheme, describeTheme, DEFAULT_THEME } = require('../../utils/rankCardTheme');
const { resolveLevelUpTheme, levelUpCardResetPatch } = require('../../utils/levelUpCardTheme');
const {
  buildCardPanel, buildCardModal, applyCardOption, applyCardModal, optionKeyFromId, modalKeyFromId, pageForKey,
} = require('../../utils/rankCardPanel');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ─── Carte de rang du serveur (aperçu + panneau) ──────────────────────────────
async function serverCardPayload(interaction, cfg, notice = null, page = 'colors') {
  const theme = resolveCardTheme(cfg);
  const stats = await rankCmd.fetchStats(interaction.guild.id, interaction.user.id)
    .catch(() => rankCmd.SAMPLE_STATS);
  const buffer = await renderRankCard(rankCmd.memberLike(interaction), stats, theme);
  const { embed, components } = buildCardPanel(theme, 'server', { notice, page });
  return {
    embeds: [embed], components,
    files: [new AttachmentBuilder(buffer, { name: 'card.png' })],
    attachments: [],
  };
}

// ─── Carte de l'annonce de niveau (aperçu + panneau) ──────────────────────────
// L'aperçu simule la PROMOTION en cours : niveau suivant, barre qui repart, ce
// qui montre exactement ce que verront les membres au moment de l'annonce.
async function levelUpCardPayload(interaction, cfg, notice = null, page = 'colors') {
  const resolved = resolveLevelUpTheme(cfg);
  const stats = await rankCmd.fetchStats(interaction.guild.id, interaction.user.id)
    .catch(() => rankCmd.SAMPLE_STATS);
  const preview = {
    ...stats,
    level: (stats.level || 0) + 1,
    xpIntoLevel: Math.min(42, stats.xpForNext || 100),
  };
  const buffer = await renderLevelUpCard(rankCmd.memberLike(interaction), preview, resolved.theme, {
    title: resolved.title,
    subtitle: resolved.subtitle,
    vars: { server: interaction.guild?.name },
  });
  const { embed, components } = buildCardPanel(resolved.theme, 'levelup', { notice, page, texts: resolved });
  return {
    embeds: [embed], components,
    files: [new AttachmentBuilder(buffer, { name: 'card.png' })],
    attachments: [],
  };
}

const LEVEL_PRESETS = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100];

// État temporaire par session (le temps de choisir un rôle PUIS un niveau)
const pendingLevelRole = new Map(); // userId -> roleId

function buildEmbed(cfg) {
  const chanMult = [...cfg.channelMultipliers.entries()].map(([id, m]) => `<#${id}>: x${m}`).join(', ') || '*Aucun*';
  const roleMult = [...cfg.roleMultipliers.entries()].map(([id, m]) => `<@&${id}>: x${m}`).join(', ') || '*Aucun*';
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('📊 Leveling — Panel de configuration')
    .setDescription("Système d'XP par message, avec niveaux, rôles de récompense et carte visuelle.")
    .addFields(
      { name: 'État', value: cfg.enabled ? '🟢 Activé' : '🔴 Désactivé', inline: true },
      { name: 'XP par message', value: `${cfg.minXp} – ${cfg.maxXp}`, inline: true },
      { name: 'Cooldown', value: `${cfg.cooldownSeconds}s`, inline: true },
      { name: "Annonce de niveau", value: cfg.announceLevelUp ? '✅ Activée' : '❌ Désactivée', inline: true },
      { name: 'Carte visuelle', value: cfg.useCardOnLevelUp ? '✅ Oui' : '❌ Non (texte seul)', inline: true },
      { name: "Salon d'annonce", value: cfg.levelUpChannelId ? `<#${cfg.levelUpChannelId}>` : '*Salon du message*', inline: true },
      { name: 'Salons silencieux', value: cfg.silentChannels.length ? cfg.silentChannels.map(id => `<#${id}>`).join(', ') : '*Aucun*', inline: true },
      { name: 'Carte de rang', value: describeTheme(resolveCardTheme(cfg)), inline: false },
      { name: 'Salons exclus', value: cfg.excludedChannels.length ? cfg.excludedChannels.map(id => `<#${id}>`).join(', ') : '*Aucun*', inline: false },
      { name: 'Rôles de niveau', value: cfg.levelRoles.length ? cfg.levelRoles.sort((a, b) => a.level - b.level).map(lr => `Niv.${lr.level} → <@&${lr.roleId}>`).join(', ') : '*Aucun*', inline: false },
      { name: 'Multiplicateurs salons', value: chanMult, inline: false },
      { name: 'Multiplicateurs rôles', value: roleMult, inline: false },
    )
    .setFooter({ text: 'REZO • Leveling' })
    .setTimestamp();
}

function buildComponents() {
  const r1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lvl_toggle').setLabel('🔛 Activer / Désactiver').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('lvl_xp_settings').setLabel('⚙️ XP & Cooldown').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('lvl_announce').setLabel('📢 Annonce de niveau').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('lvl_card_color').setLabel('🎨 Couleur de la carte').setStyle(ButtonStyle.Secondary),
  );
  const r2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lvl_level_roles').setLabel('🎭 Rôles de niveau').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lvl_excluded').setLabel('🚫 Salons exclus').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lvl_multipliers').setLabel('✖️ Multiplicateurs').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lvl_reset_user').setLabel('🔄 Réinitialiser un membre').setStyle(ButtonStyle.Danger),
  );
  const r3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lvlcard_open').setLabel('🎨 Carte de rang').setStyle(ButtonStyle.Primary),
  );
  return [r1, r2, r3];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leveling')
    .setDescription('📊 Configurer le système de niveaux (XP)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    let cfg = await getOrCreateConfig(interaction.guild.id);

    const reply = await interaction.reply({
      embeds: [buildEmbed(cfg)],
      components: buildComponents(),
      ephemeral: true,
      fetchReply: true,
    });

    const col = reply.createMessageComponentCollector({
      filter: i => i.user.id === interaction.user.id,
      time: 15 * 60 * 1000,
    });

    const refresh = async (i) => {
      cfg = await getOrCreateConfig(interaction.guild.id);
      return i.update({ embeds: [buildEmbed(cfg)], components: buildComponents() });
    };

    const backRow = () => new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('lvl_back').setLabel('← Retour').setStyle(ButtonStyle.Secondary),
    );

    col.on('collect', async i => {
      cfg = await getOrCreateConfig(interaction.guild.id);

      // ── Activer / Désactiver ──────────────────────────────────────────
      if (i.customId === 'lvl_toggle') {
        cfg.enabled = !cfg.enabled;
        await cfg.save();
        return refresh(i);
      }

      // ── XP & Cooldown (modal) ──────────────────────────────────────────
      if (i.customId === 'lvl_xp_settings') {
        const modal = new ModalBuilder().setCustomId('lvl_xp_modal').setTitle('⚙️ XP & Cooldown');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lvl_min').setLabel('XP minimum par message').setStyle(TextInputStyle.Short).setValue(String(cfg.minXp)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lvl_max').setLabel('XP maximum par message').setStyle(TextInputStyle.Short).setValue(String(cfg.maxXp)).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lvl_cd').setLabel('Cooldown entre 2 gains (secondes)').setStyle(TextInputStyle.Short).setValue(String(cfg.cooldownSeconds)).setRequired(true)),
        );
        return i.showModal(modal);
      }

      // ── Annonce de niveau ──────────────────────────────────────────────
      if (i.customId === 'lvl_announce') {
        const rows = [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId('lvl_announce_channel').setPlaceholder('Choisir un salon fixe pour les annonces…').addChannelTypes(ChannelType.GuildText),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('lvl_announce_toggle').setLabel(cfg.announceLevelUp ? "Désactiver l'annonce" : "Activer l'annonce").setStyle(cfg.announceLevelUp ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId('lvl_card_toggle').setLabel(cfg.useCardOnLevelUp ? 'Passer en texte seul' : 'Utiliser la carte visuelle').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('lvl_announce_clear').setLabel('Salon du message (défaut)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('lvucard_open').setLabel('🎉 Carte d\'annonce').setStyle(ButtonStyle.Primary),
          ),
        ];
        if (!cfg.levelUpChannelId) {
          rows.push(new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId('lvl_silent_add').setPlaceholder('🔇 Rendre silencieux un ou plusieurs salons…')
              .addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(5),
          ));
          if (cfg.silentChannels.length) {
            rows.push(new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId('lvl_silent_remove').setPlaceholder('🔊 Réactiver l\'annonce pour…')
                .setMinValues(1).setMaxValues(cfg.silentChannels.length)
                .addOptions(cfg.silentChannels.slice(0, 25).map(id => {
                  const ch = interaction.guild.channels.cache.get(id);
                  return { label: ch ? `#${ch.name}` : id, value: id };
                })),
            ));
          }
        }
        rows.push(backRow());
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('📢 Annonce de niveau')
            .setDescription(`Annonce : ${cfg.announceLevelUp ? '✅ Activée' : '❌ Désactivée'}\nCarte visuelle : ${cfg.useCardOnLevelUp ? '✅ Oui' : '❌ Non'}\nSalon : ${cfg.levelUpChannelId ? `<#${cfg.levelUpChannelId}>` : '*Salon du message*'}\n\n🎉 **Carte d'annonce** — visuels : ${resolveLevelUpTheme(cfg).custom ? 'personnalisés' : 'ceux de la carte de rang'}\nTitre : \`${resolveLevelUpTheme(cfg).title}\` · Sous-titre : \`${resolveLevelUpTheme(cfg).subtitle}\`\n*Utilise « 🎉 Carte d'annonce » pour changer le fond, les couleurs, la barre et les textes, avec aperçu.*` + (cfg.levelUpChannelId ? '\n\n*Salons silencieux désactivés : un salon fixe est déjà défini, toutes les annonces y vont directement.*' : ''))],
          components: rows,
        });
      }
      if (i.customId === 'lvl_announce_channel') { cfg.levelUpChannelId = i.values[0]; await cfg.save(); return refresh(i); }
      if (i.customId === 'lvl_announce_clear')   { cfg.levelUpChannelId = null;        await cfg.save(); return refresh(i); }
      if (i.customId === 'lvl_announce_toggle')  { cfg.announceLevelUp = !cfg.announceLevelUp; await cfg.save(); return refresh(i); }
      if (i.customId === 'lvl_card_toggle')      { cfg.useCardOnLevelUp = !cfg.useCardOnLevelUp; await cfg.save(); return refresh(i); }
      if (i.customId === 'lvl_silent_add') {
        cfg.silentChannels = Array.from(new Set([...cfg.silentChannels, ...i.values]));
        await cfg.save();
        return refresh(i);
      }
      if (i.customId === 'lvl_silent_remove') {
        cfg.silentChannels = cfg.silentChannels.filter(id => !i.values.includes(id));
        await cfg.save();
        return refresh(i);
      }

      // ── Couleur de la carte (modal) ─────────────────────────────────────
      if (i.customId === 'lvl_card_color') {
        const modal = new ModalBuilder().setCustomId('lvl_color_modal').setTitle('🎨 Couleur de la carte');
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('lvl_hex').setLabel('Couleur hexadécimale (ex: #5865F2)').setStyle(TextInputStyle.Short).setValue(cfg.cardColor).setRequired(true)),
        );
        return i.showModal(modal);
      }

      // ── Rôles de niveau ─────────────────────────────────────────────────
      if (i.customId === 'lvl_level_roles') {
        const rows = [
          new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('lvl_role_pick').setPlaceholder('1️⃣ Choisir le rôle à attribuer…'),
          ),
        ];
        if (cfg.levelRoles.length) {
          rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('lvl_role_remove').setPlaceholder('🗑️ Retirer un rôle de niveau existant…')
              .addOptions(cfg.levelRoles.slice(0, 25).map(lr => ({ label: `Niveau ${lr.level}`, value: String(lr.level) }))),
          ));
        }
        rows.push(backRow());
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🎭 Rôles de niveau')
            .setDescription("Choisis un rôle, puis le niveau requis pour l'obtenir. Les rôles sont cumulatifs (le membre garde ceux des niveaux précédents).")],
          components: rows,
        });
      }
      if (i.customId === 'lvl_role_pick') {
        pendingLevelRole.set(i.user.id, i.values[0]);
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🎭 Rôles de niveau')
            .setDescription(`Rôle choisi : <@&${i.values[0]}>\n2️⃣ Choisis maintenant le niveau requis :`)],
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder().setCustomId('lvl_level_pick').setPlaceholder('Choisir le niveau requis…')
                .addOptions(LEVEL_PRESETS.map(l => ({ label: `Niveau ${l}`, value: String(l) }))),
            ),
            backRow(),
          ],
        });
      }
      if (i.customId === 'lvl_level_pick') {
        const roleId = pendingLevelRole.get(i.user.id);
        if (!roleId) return i.reply({ embeds: [errorEmbed('Session expirée', 'Recommence en choisissant un rôle.')], ephemeral: true });
        const level = parseInt(i.values[0], 10);
        cfg.levelRoles = cfg.levelRoles.filter(lr => lr.level !== level);
        cfg.levelRoles.push({ level, roleId });
        await cfg.save();
        pendingLevelRole.delete(i.user.id);
        return refresh(i);
      }
      if (i.customId === 'lvl_role_remove') {
        const level = parseInt(i.values[0], 10);
        cfg.levelRoles = cfg.levelRoles.filter(lr => lr.level !== level);
        await cfg.save();
        return refresh(i);
      }

      // ── Salons exclus ───────────────────────────────────────────────────
      if (i.customId === 'lvl_excluded') {
        const rows = [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId('lvl_excl_add').setPlaceholder('➕ Exclure un ou plusieurs salons…')
              .addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(5),
          ),
        ];
        if (cfg.excludedChannels.length) {
          rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('lvl_excl_remove').setPlaceholder('➖ Retirer un ou plusieurs salons…')
              .setMinValues(1).setMaxValues(cfg.excludedChannels.length)
              .addOptions(cfg.excludedChannels.slice(0, 25).map(id => {
                const ch = interaction.guild.channels.cache.get(id);
                return { label: ch ? `#${ch.name}` : id, value: id };
              })),
          ));
        }
        rows.push(backRow());
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('🚫 Salons exclus')
            .setDescription("Aucun XP n'est gagné dans ces salons.")],
          components: rows,
        });
      }
      if (i.customId === 'lvl_excl_add') {
        cfg.excludedChannels = Array.from(new Set([...cfg.excludedChannels, ...i.values]));
        await cfg.save();
        return refresh(i);
      }
      if (i.customId === 'lvl_excl_remove') {
        cfg.excludedChannels = cfg.excludedChannels.filter(id => !i.values.includes(id));
        await cfg.save();
        return refresh(i);
      }

      // ── Multiplicateurs ─────────────────────────────────────────────────
      if (i.customId === 'lvl_multipliers') {
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle("✖️ Multiplicateurs d'XP")
            .setDescription('Choisis un salon ou un rôle, puis renseigne le multiplicateur (ex: 2 = double XP).')],
          components: [
            new ActionRowBuilder().addComponents(
              new ChannelSelectMenuBuilder().setCustomId('lvl_mult_channel').setPlaceholder('Multiplicateur pour un salon…').addChannelTypes(ChannelType.GuildText),
            ),
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder().setCustomId('lvl_mult_role').setPlaceholder('Multiplicateur pour un rôle…'),
            ),
            backRow(),
          ],
        });
      }
      if (i.customId === 'lvl_mult_channel') {
        const modal = new ModalBuilder().setCustomId(`lvl_mult_channel_modal_${i.values[0]}`).setTitle('✖️ Multiplicateur de salon');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('lvl_mult_value').setLabel('Multiplicateur (ex: 2 = x2, 0 = off)').setStyle(TextInputStyle.Short).setRequired(true),
        ));
        return i.showModal(modal);
      }
      if (i.customId === 'lvl_mult_role') {
        const modal = new ModalBuilder().setCustomId(`lvl_mult_role_modal_${i.values[0]}`).setTitle('✖️ Multiplicateur de rôle');
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('lvl_mult_value').setLabel('Multiplicateur (ex: 1.5 = x1.5, 0 = off)').setStyle(TextInputStyle.Short).setRequired(true),
        ));
        return i.showModal(modal);
      }

      // ── Réinitialiser un membre ─────────────────────────────────────────
      if (i.customId === 'lvl_reset_user') {
        return i.update({
          embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle('🔄 Réinitialiser un membre')
            .setDescription("Choisis le membre dont l'XP et le niveau doivent être remis à zéro.")],
          components: [
            new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('lvl_reset_pick').setPlaceholder('Choisir un membre…')),
            backRow(),
          ],
        });
      }
      if (i.customId === 'lvl_reset_pick') {
        await XP.updateOne({ guildId: interaction.guild.id, userId: i.values[0] }, { $set: { xp: 0, totalXp: 0, level: 0, messages: 0 } });
        await i.reply({ embeds: [successEmbed('Membre réinitialisé', `<@${i.values[0]}> est reparti de niveau 0.`)], ephemeral: true });
        return refresh(i);
      }

      // ── Carte d'annonce de niveau : mêmes réglages que la carte de rang, mais
      // stockés séparément (XPConfig.levelUpCard) et appliqués à l'annonce.
      if (i.customId === 'lvucard_open') {
        return i.update(await levelUpCardPayload(i, cfg, null, 'colors'));
      }
      if (i.customId.startsWith('lvucard_')) {
        const key = optionKeyFromId(i.customId, 'levelup');
        const resolved = resolveLevelUpTheme(cfg);
        const res = applyCardOption(resolved.theme, key, i.values || [], 'levelup');
        const page = res.action?.page || pageForKey(key);

        if (res.action === 'reset') {
          Object.assign(cfg.levelUpCard, levelUpCardResetPatch());
          await cfg.save();
          return i.update(await levelUpCardPayload(i, cfg, '↩️ Carte d\'annonce réinitialisée : elle suit à nouveau la carte de rang.', 'colors'));
        }

        if (res.patch) {
          Object.assign(cfg.levelUpCard, res.patch);
          await cfg.save();
        }

        if (res.action && typeof res.action === 'object' && res.action.modal) {
          const modal = buildCardModal(resolved.theme, res.action.modal, 'levelup', resolved);
          if (modal) return i.showModal(modal);
        }

        return i.update(await levelUpCardPayload(i, cfg, res.notice, page));
      }

      // ── Carte de rang : thème du serveur, aperçu régénéré à chaque étape ──
      if (i.customId === 'lvlcard_open') {
        return i.update(await serverCardPayload(i, cfg, null));
      }
      if (i.customId.startsWith('lvlcard_')) {
        const key = optionKeyFromId(i.customId, 'server');
        const res = applyCardOption(resolveCardTheme(cfg), key, i.values || [], 'server');
        // La page affichée suit l'option touchée : aucun état à mémoriser.
        const page = res.action?.page || pageForKey(key);

        if (res.action === 'reset') {
          Object.assign(cfg.rankCard, { ...DEFAULT_THEME, accentColor: null, bgImage: null });
          cfg.cardColor = DEFAULT_THEME.accentColor;
          await cfg.save();
          return i.update(await serverCardPayload(i, cfg, '↩️ Carte réinitialisée aux valeurs par défaut.', page));
        }

        if (res.patch) {
          Object.assign(cfg.rankCard, res.patch);
          // L'ancien champ cardColor reste la source d'accent pour le reste du bot
          if (res.patch.accentColor) cfg.cardColor = res.patch.accentColor;
          await cfg.save();
        }

        if (res.action && typeof res.action === 'object' && res.action.modal) {
          const modal = buildCardModal(resolveCardTheme(cfg), res.action.modal, 'server');
          if (modal) return i.showModal(modal);
        }

        return i.update(await serverCardPayload(i, cfg, res.notice, page));
      }

      if (i.customId === 'lvl_back') return refresh(i);
    });

    col.on('end', () => interaction.editReply({ components: [] }).catch(() => {}));
  },

  // ─── Modals ───────────────────────────────────────────────────────────────
  async handleXpModal(interaction) {
    const cfg = await getOrCreateConfig(interaction.guild.id);
    const min = Math.max(1, parseInt(interaction.fields.getTextInputValue('lvl_min'), 10) || 15);
    const max = Math.max(min, parseInt(interaction.fields.getTextInputValue('lvl_max'), 10) || min + 10);
    const cd = Math.max(0, parseInt(interaction.fields.getTextInputValue('lvl_cd'), 10) || 60);
    cfg.minXp = min; cfg.maxXp = max; cfg.cooldownSeconds = cd;
    await cfg.save();
    return interaction.reply({ embeds: [successEmbed('Paramètres XP mis à jour', `${min}–${max} XP par message, cooldown ${cd}s`)], ephemeral: true });
  },

  async handleColorModal(interaction) {
    const cfg = await getOrCreateConfig(interaction.guild.id);
    let hex = interaction.fields.getTextInputValue('lvl_hex').trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(hex)) {
      return interaction.reply({ embeds: [errorEmbed('Couleur invalide', 'Utilise un format hexadécimal, ex: #5865F2')], ephemeral: true });
    }
    if (!hex.startsWith('#')) hex = `#${hex}`;
    cfg.cardColor = hex;
    cfg.rankCard.accentColor = hex;
    await cfg.save();
    return interaction.reply({ embeds: [successEmbed('Couleur mise à jour', hex)], ephemeral: true });
  },

  // ─── Modal de la carte de rang (ids `lvlcard_modal_*`) ────────────────────
  async handleCardModal(interaction) {
    const key = modalKeyFromId(interaction.customId, 'server');
    if (!key) return;

    const cfg = await getOrCreateConfig(interaction.guild.id);
    const res = applyCardModal(key, interaction.fields, 'server');
    if (res.error) {
      return interaction.reply({ embeds: [errorEmbed('Valeur invalide', res.error)], ephemeral: true }).catch(() => {});
    }

    Object.assign(cfg.rankCard, res.patch);
    if (res.patch.accentColor) cfg.cardColor = res.patch.accentColor;
    await cfg.save();

    const payload = await serverCardPayload(interaction, cfg, res.notice, pageForKey(key));
    if (interaction.message) {
      try {
        await interaction.message.edit(payload);
        return interaction.reply({ content: res.notice || '✅ Enregistré.', ephemeral: true }).catch(() => {});
      } catch { /* le panneau a expiré : on en renvoie un neuf */ }
    }
    return interaction.reply({ ...payload, ephemeral: true });
  },

  // ─── Modal de la carte d'annonce de niveau (ids `lvucard_modal_*`) ────────
  async handleLevelUpCardModal(interaction) {
    const key = modalKeyFromId(interaction.customId, 'levelup');
    if (!key) return;

    const cfg = await getOrCreateConfig(interaction.guild.id);
    const resolved = resolveLevelUpTheme(cfg);
    const res = applyCardModal(key, interaction.fields, 'levelup');
    if (res.error) {
      return interaction.reply({ embeds: [errorEmbed('Valeur invalide', res.error)], ephemeral: true }).catch(() => {});
    }

    Object.assign(cfg.levelUpCard, res.patch);
    await cfg.save();

    const payload = await levelUpCardPayload(interaction, cfg, res.notice, pageForKey(key));
    if (interaction.message) {
      try {
        await interaction.message.edit(payload);
        return interaction.reply({ content: res.notice || '✅ Enregistré.', ephemeral: true }).catch(() => {});
      } catch { /* le panneau a expiré : on en renvoie un neuf */ }
    }
    return interaction.reply({ ...payload, ephemeral: true });
  },

  async handleMultiplierModal(interaction, customId) {
    const cfg = await getOrCreateConfig(interaction.guild.id);
    const value = parseFloat(interaction.fields.getTextInputValue('lvl_mult_value'));
    if (isNaN(value) || value < 0) {
      return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Renseigne un nombre positif (ex: 2, 1.5, 0).')], ephemeral: true });
    }

    if (customId.startsWith('lvl_mult_channel_modal_')) {
      const channelId = customId.replace('lvl_mult_channel_modal_', '');
      if (value === 0) cfg.channelMultipliers.delete(channelId);
      else cfg.channelMultipliers.set(channelId, value);
    } else if (customId.startsWith('lvl_mult_role_modal_')) {
      const roleId = customId.replace('lvl_mult_role_modal_', '');
      if (value === 0) cfg.roleMultipliers.delete(roleId);
      else cfg.roleMultipliers.set(roleId, value);
    }
    await cfg.save();
    return interaction.reply({ embeds: [successEmbed('Multiplicateur mis à jour', `x${value}`)], ephemeral: true });
  },
};
