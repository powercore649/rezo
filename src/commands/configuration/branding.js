// commands/configuration/branding.js — Identité visuelle 100 % personnalisable
// par serveur, réservée aux serveurs disposant d'une LICENCE ACTIVE.
//
// Discord permet à un bot d'avoir un PROFIL DE MEMBRE par serveur :
// avatar, bannière et surnom via `guild.members.editMe()`. C'est le vrai
// affichage serveur (liste des membres, messages), pas un webhook. L'avatar et
// la bannière GLOBAUX de l'application restent, eux, communs à tous les serveurs.
//
// Le panel rend donc personnalisables : nom affiché, surnom, avatar et bannière
// du profil serveur, couleur, pied de page, vignette et règles de remplacement.
//
// Tous les boutons/modaux sont préfixés `brand_` et routés par
// events/core/interactionCreate.js.

const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');

const guildBrand = require('../../utils/guildBrand');
const licenseGate = require('../../utils/licenseGate');
const nicknameStyle = require('../../utils/nicknameStyle');
const { COLORS, successEmbed, errorEmbed, warningEmbed } = require('../../utils/embeds');

const FIELD_LABELS = {
  name: 'Nom affiché',
  nickname: 'Surnom du bot',
  avatar: 'Avatar (URL)',
  banner: 'Bannière (URL)',
  color: 'Couleur principale',
  footer: 'Pied de page',
  emoji: 'Emoji signature',
};

const FIELD_INPUTS = {
  name: { key: 'displayName', label: 'Nom affiché (2 à 32 caractères)', max: 32, placeholder: 'Ex : Communauté Nova' },
  nickname: { key: 'nickname', label: 'Surnom du bot sur ce serveur', max: 32, placeholder: 'Ex : Nova' },
  avatar: { key: 'avatarUrl', label: 'URL de l’avatar (https://…)', max: 512, placeholder: 'https://exemple.com/avatar.png' },
  banner: { key: 'bannerUrl', label: 'URL de la bannière (https://…)', max: 512, placeholder: 'https://exemple.com/banniere.png' },
  color: { key: 'color', label: 'Couleur hexadécimale (#RRGGBB)', max: 9, placeholder: '#8B1A1A' },
  footer: { key: 'footerText', label: 'Pied de page (120 caractères max)', max: 120, placeholder: 'Ex : Nova • Communauté' },
  emoji: { key: 'emoji', label: 'Emoji affiché à côté du nom', max: 16, placeholder: 'Ex : 🎲' },
};

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

function licenseRequiredEmbed() {
  return licenseGate.fullLicenseEmbed('branding');
}

// ─── Style du pseudonyme (profil du bot uniquement) ────────────────────────
// Discord ne colore un pseudo qu'avec un RÔLE : le style applique donc le
// surnom transformé (police + effet) et un rôle dédié portant la couleur
// (dégradée si le serveur y a droit). Rien d'autre n'est touché : ni les
// embeds, ni le nom d'affichage.
function styleSummary(cfg) {
  const font = nicknameStyle.fontByKey(cfg.nicknameFont) || nicknameStyle.FONTS[0];
  const effect = nicknameStyle.effectByKey(cfg.nicknameEffect) || nicknameStyle.EFFECTS[0];
  const palette = nicknameStyle.activePalette(cfg);
  const preview = nicknameStyle.renderForConfig(cfg);
  return `**${preview}**\n${effect.label} · ${font.label}${palette ? ` · ${palette.swatch} ${palette.label}` : ''}`;
}

// Ce que Discord affiche réellement, et pourquoi.
function styleStatusText(status) {
  if (!status) return null;
  const lines = [];

  if (status.currentNick) lines.push(`✅ Pseudo posé sur ce serveur : **${status.currentNick}**`);
  else lines.push('⚠️ Aucun surnom posé sur ce serveur pour l’instant.');

  if (status.expectedNick && status.currentNick && status.currentNick !== status.expectedNick) {
    lines.push('⚠️ Il ne correspond pas encore à l’aperçu : clique **Appliquer au pseudo**.');
  }

  if (status.canChangeNickname === false) lines.push('⛔ Le bot n’a pas **Changer le pseudo** : impossible de modifier son surnom.');

  if (status.palette) {
    if (status.canManageRoles === false) lines.push('⛔ Le bot n’a pas **Gérer les rôles** : aucune couleur de pseudo possible.');
    else if (!status.roleFound) lines.push('🟡 Rôle de couleur pas encore créé — il le sera à l’application.');
    else if (!status.roleAssigned) lines.push('🟡 Le rôle de couleur existe mais n’est pas attribué au bot.');
    else lines.push('✅ Rôle de couleur attribué au bot.');

    lines.push('ℹ️ Vrai dégradé = styles de rôle améliorés (perk **3 boosts**, réglé par un admin dans **Boosts du serveur**). Sans ce perk, Discord affiche la **couleur principale en unie**.');
    if (status.wrap === 'pastilles') lines.push('✨ Pastilles activées : deux teintes visibles **même sans boost**.');
    else lines.push('👉 Sans boost, active **Pastilles** pour voir deux couleurs tout de suite.');
  } else {
    lines.push('ℹ️ Aucune couleur choisie : le pseudo garde la couleur par défaut du serveur.');
  }

  return lines.join('\n').slice(0, 1024);
}

function buildStyleEmbed(cfg, status = null) {
  const font = nicknameStyle.fontByKey(cfg.nicknameFont) || nicknameStyle.FONTS[0];
  const effect = nicknameStyle.effectByKey(cfg.nicknameEffect) || nicknameStyle.EFFECTS[0];
  const palette = nicknameStyle.activePalette(cfg);
  const preview = nicknameStyle.renderForConfig(cfg);
  const colors = palette ? `\`${nicknameStyle.hex(palette.primary)} → ${nicknameStyle.hex(palette.secondary)}\`` : '*Aucune*';
  const statusText = styleStatusText(status);

  const embed = new EmbedBuilder()
    .setColor(palette?.primary ?? COLORS.primary)
    .setTitle('✨ Style du pseudonyme — profil du bot')
    .setDescription(
      (cfg.nickname
        ? '**Pseudo affiché sur ce serveur :**'
        : '**Aucun surnom défini** : choisis d’abord un **Surnom du bot**, le style s’applique dessus.\n**Aperçu :**')
      + `\n━━━━━━━━━━━━━━\n**${preview}**\n━━━━━━━━━━━━━━\n`
      + 'Ce style ne modifie **que le pseudo du bot** : ni les embeds, ni le nom d’affichage, ni aucun autre texte.',
    )
    .addFields(
      { name: 'Police', value: `${font.label}\n*${font.hint}*`, inline: true },
      { name: 'Effet', value: `${effect.label}\n*${effect.hint}*`, inline: true },
      { name: 'Couleur', value: palette ? `${palette.swatch} ${palette.label}\n${colors}` : '⬜ Aucune', inline: true },
    );

  if (statusText) embed.addFields({ name: '📡 Sur ce serveur', value: statusText, inline: false });

  return embed
    .setFooter({ text: 'Licence active • Profil du bot — pseudo uniquement' })
    .setTimestamp();
}

function buildStyleComponents(cfg) {
  const fontRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('brand_style_font')
      .setPlaceholder('🔤 Police du pseudo…')
      .addOptions(nicknameStyle.FONTS.map(font => ({
        label: `${font.key === cfg.nicknameFont ? '✅ ' : ''}${font.label}`.slice(0, 100),
        value: font.key,
        description: font.hint.slice(0, 100),
      }))),
  );

  const effectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('brand_style_effect')
      .setPlaceholder('🎛️ Effet du pseudo…')
      .addOptions(nicknameStyle.EFFECTS.map(effect => ({
        label: `${effect.key === cfg.nicknameEffect ? '✅ ' : ''}${effect.label}`.slice(0, 100),
        value: effect.key,
        description: effect.hint.slice(0, 100),
      }))),
  );

  const colorRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('brand_style_color')
      .setPlaceholder('🎨 Couleur du pseudo…')
      .addOptions(nicknameStyle.PALETTES.map(palette => ({
        label: `${palette.key === cfg.nicknamePalette ? '✅ ' : ''}${palette.label}`.slice(0, 100),
        value: palette.key,
        description: (palette.primary
          ? `Dégradé ${nicknameStyle.hex(palette.primary)} → ${nicknameStyle.hex(palette.secondary)}`
          : 'Aucun rôle de couleur').slice(0, 100),
      }))),
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('brand_style_apply').setLabel('Appliquer au pseudo').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('brand_style_wrap')
      .setLabel(cfg.nicknameWrap === 'pastilles' ? 'Pastilles : ON' : 'Pastilles : OFF')
      .setEmoji('✨')
      .setStyle(cfg.nicknameWrap === 'pastilles' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('brand_style_reset').setLabel('Style par défaut').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('brand_style_back').setLabel('Retour').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
  );

  return [fontRow, effectRow, colorRow, actionRow];
}

// Recalcule l'état réel après une application, sans bloquer l'interaction.
async function stylePayload(guild, cfg) {
  const status = await guildBrand.collectStyleStatus(guild, cfg);
  return { embeds: [buildStyleEmbed(cfg, status)], components: buildStyleComponents(cfg) };
}

async function showStylePanel(interaction) {
  const cfg = await guildBrand.prime(interaction.guildId, { force: true });
  return interaction.update(await stylePayload(interaction.guild, cfg));
}

// Applique le style (pseudo + rôle) puis enregistre l'identifiant du rôle créé.
async function applyStyleAndSave(guild, guildId, userId, cfg) {
  const applied = await guildBrand.applyNicknameOnly(guild, cfg);
  let updated = cfg;
  if (applied.gradient?.roleId !== undefined) {
    updated = await guildBrand.saveBrand(guildId, { nicknameRoleId: applied.gradient.roleId || null }, userId);
  }
  return { applied, updated };
}

function applyProfileError(result) {
  switch (result?.reason) {
    case 'permission':
      return 'Discord a refusé la modification du profil de membre : vérifie que le bot est bien membre du serveur et qu’il peut **changer son pseudonyme** (permission requise pour le surnom), puis réessaie.';
    case 'invalid_image':
      return 'Discord a refusé l’image : utilise une URL publique valide (PNG/JPG/GIF, dimensions raisonnables).';
    case 'invalid_nick':
      return 'Discord a refusé le pseudo : le style dépasse la limite de caractères ou contient un glyphe non accepté. Essaie une police plus simple ou raccourcis le surnom.';
    case 'rate_limit':
      return 'Discord limite temporairement les modifications de profil. Réessaie dans quelques minutes.';
    case 'unsupported':
      return 'Cette version de Discord.js ne permet pas encore de modifier le profil serveur du bot.';
    default:
      return 'Impossible d’appliquer le profil serveur pour le moment. Réessaie plus tard.';
  }
}

/** Vérifie admin + licence active (pas l'essai). Répond et renvoie false sinon. */
async function requireAccess(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed('Permission manquante', 'Il faut la permission **Gérer le serveur**.')],
      ephemeral: true,
    }).catch(() => {});
    return false;
  }

  // Même contrôle que le routeur slash : le message doit dire quel PALIER est
  // requis et lequel est actif, pas « licence requise » à un serveur licencié.
  const access = await licenseGate.checkAccessBounded(interaction.guildId, 'branding');
  if (!access) {
    await interaction.reply({ embeds: [licenseGate.unavailableEmbed('branding')], ephemeral: true }).catch(() => {});
    return false;
  }
  if (!access.ok) {
    const embed = access.reason === 'feature_locked'
      ? licenseGate.lockEmbed('branding', { access })
      : licenseRequiredEmbed();
    await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

// ─── Panel ──────────────────────────────────────────────────────────────────
function formatUrl(value) {
  if (!value) return '*Non défini*';
  return `[Défini](${value})`;
}

function buildPanelEmbed(cfg, guild) {
  const bannerModes = { off: 'Désactivée', missing: 'Si aucun visuel', always: 'Toujours' };
  return new EmbedBuilder()
    .setColor(guildBrand.parseHexColor(cfg.color) ?? COLORS.primary)
    .setTitle('🎨 Identité visuelle du serveur')
    .setDescription(
      'Personnalise l’apparence de **REZO** sur **' + guild.name + '**.\n'
      + 'L’avatar, la bannière et le surnom sont appliqués au **profil de membre du bot dans ce serveur** ; '
      + 'le nom, la couleur et l’emoji s’appliquent aux **embeds, aux cartes et aux images** du bot.',
    )
    .setThumbnail(cfg.avatarUrl || guild.iconURL({ dynamic: true }) || null)
    .addFields(
      { name: 'État', value: cfg.enabled ? '🟢 Activée' : '🔴 Désactivée', inline: true },
      { name: 'Nom affiché', value: cfg.displayName ? `**${cfg.displayName}**` : '*REZO*', inline: true },
      { name: 'Emoji signature', value: cfg.emoji || '*Aucun*', inline: true },
      { name: 'Surnom du bot', value: cfg.nickname ? `**${cfg.nickname}**` : '*Aucun*', inline: true },
      { name: 'Style du pseudo', value: styleSummary(cfg), inline: true },
      { name: 'Avatar serveur', value: formatUrl(cfg.avatarUrl), inline: true },
      { name: 'Bannière serveur', value: formatUrl(cfg.bannerUrl), inline: true },
      { name: 'Affichage bannière', value: bannerModes[cfg.bannerMode] || bannerModes.missing, inline: true },
      { name: 'Couleur', value: cfg.color ? `\`${cfg.color}\`` : '*Couleur REZO*', inline: true },
      { name: 'Cartes & images', value: cfg.enabled ? '🎨 Nom et couleur du serveur' : '➖ Apparence REZO', inline: true },
      { name: 'Pied de page', value: cfg.footerText ? cfg.footerText.slice(0, 100) : '*Par défaut*', inline: true },
      {
        name: 'Remplacements',
        value: [
          `${cfg.replaceAuthor ? '✅' : '➖'} Auteur des embeds`,
          `${cfg.replaceFooter ? '✅' : '➖'} Pied de page`,
          `${cfg.avatarThumbnail ? '✅' : '➖'} Avatar en vignette`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '⚠️ Limite Discord',
        value: 'Le bot a maintenant un **profil de membre propre à ce serveur** (avatar, bannière, surnom). '
          + 'L’avatar/bannière **globaux** de l’application restent communs aux autres serveurs.',
        inline: false,
      },
    )
    .setFooter({ text: 'Licence active • Identité par serveur' })
    .setTimestamp();
}

function buildPanelComponents(cfg) {
  const row1 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('brand_field')
      .setPlaceholder('✏️ Modifier un élément visuel…')
      .addOptions(
        { label: 'Nom affiché', value: 'name', emoji: '📝', description: 'Nom du bot dans les embeds' },
        { label: 'Surnom du bot', value: 'nickname', emoji: '🏷️', description: 'Vrai surnom sur ce serveur' },
        { label: 'Style du pseudo', value: 'nickname_style', emoji: '✨', description: 'Police, effet (dégradé) et couleur du pseudo' },
        { label: 'Avatar (URL)', value: 'avatar', emoji: '🖼️', description: 'Avatar du profil serveur et des embeds' },
        { label: 'Bannière (URL)', value: 'banner', emoji: '🌄', description: 'Bannière du profil serveur et des embeds' },
        { label: 'Couleur principale', value: 'color', emoji: '🎨', description: 'Couleur des embeds, cartes et images' },
        { label: 'Emoji signature', value: 'emoji', emoji: '✨', description: 'Petit emoji affiché à côté du nom du bot' },
        { label: 'Pied de page', value: 'footer', emoji: '📄', description: 'Signature en bas des embeds' },
      ),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('brand_toggle')
      .setLabel(cfg.enabled ? 'Désactiver' : 'Activer')
      .setEmoji(cfg.enabled ? '⏸️' : '▶️')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('brand_apply')      .setLabel('Appliquer le profil').setEmoji('✅').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('brand_preview').setLabel('Aperçu').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('brand_reset').setLabel('Réinitialiser').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('brand_toggle_author')
      .setLabel(cfg.replaceAuthor ? 'Auteur : remplacé' : 'Auteur : conservé')
      .setEmoji('👤')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('brand_toggle_footer')
      .setLabel(cfg.replaceFooter ? 'Pied : remplacé' : 'Pied : conservé')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('brand_toggle_thumb')
      .setLabel(cfg.avatarThumbnail ? 'Vignette : avatar' : 'Vignette : libre')
      .setEmoji('🖼️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('brand_banner_mode')
      .setLabel(`Bannière : ${cfg.bannerMode === 'off' ? 'off' : cfg.bannerMode === 'always' ? 'toujours' : 'si vide'}`)
      .setEmoji('🌄')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3];
}

async function sendPanel(interaction, { edit = false } = {}) {
  const cfg = await guildBrand.prime(interaction.guildId, { force: true });
  const payload = {
    embeds: [buildPanelEmbed(cfg, interaction.guild)],
    components: buildPanelComponents(cfg),
  };

  if (edit) {
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
    return interaction.update(payload).catch(() => {});
  }

  await interaction.deferReply({ ephemeral: true });
  return interaction.editReply(payload);
}

// ─── Commande ───────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('branding')
    .setDescription('🎨 Personnaliser l’identité visuelle du bot sur ce serveur (licence active)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),

  async execute(interaction) {
    if (!(await requireAccess(interaction))) return;
    return sendPanel(interaction);
  },

  // ─── Boutons ─────────────────────────────────────────────────────────────
  async handleButton(interaction, client) {
    if (!(await requireAccess(interaction))) return;

    const id = interaction.customId;
    const cfg = await guildBrand.prime(interaction.guildId, { force: true });

    // ── Style du pseudo (profil du bot uniquement) ───────────────────────
    if (id === 'brand_style_back') return sendPanel(interaction, { edit: true });

    if (id === 'brand_style_reset') {
      const previous = cfg;
      const saved = await guildBrand.saveBrand(interaction.guildId, {
        nicknameFont: 'classique',
        nicknameEffect: 'uni',
        nicknamePalette: 'none',
        nicknameWrap: 'none',
        nicknameRoleId: null,
      }, interaction.user.id);
      // Le rôle de couleur est supprimé avec son ancien identifiant.
      await guildBrand.removeStyleRole(interaction.guild, previous);
      if (saved.nickname || saved.displayName) await guildBrand.applyNicknameOnly(interaction.guild, saved);
      return interaction.update(await stylePayload(interaction.guild, saved));
    }

    // Rendu bicolore garanti même sans boost : deux pastilles encadrant le nom.
    if (id === 'brand_style_wrap') {
      await interaction.deferUpdate();
      const next = cfg.nicknameWrap === 'pastilles' ? 'none' : 'pastilles';
      const saved = await guildBrand.saveBrand(interaction.guildId, { nicknameWrap: next }, interaction.user.id);
      const { updated } = await applyStyleAndSave(interaction.guild, interaction.guildId, interaction.user.id, saved);
      return interaction.editReply(await stylePayload(interaction.guild, updated));
    }

    if (id === 'brand_style_apply') {
      await interaction.deferReply({ ephemeral: true });
      const { applied, updated } = await applyStyleAndSave(
        interaction.guild, interaction.guildId, interaction.user.id, cfg,
      );

      if (!applied.ok) {
        const message = applied.reason === 'no_source'
          ? 'Choisis d’abord un **Surnom du bot** (menu du panel) : c’est ce surnom que le style transforme.'
          : applyProfileError(applied);
        return interaction.editReply({ embeds: [errorEmbed('Pseudo non appliqué', message)] });
      }

      const font = nicknameStyle.fontByKey(updated.nicknameFont) || nicknameStyle.FONTS[0];
      const effect = nicknameStyle.effectByKey(updated.nicknameEffect) || nicknameStyle.EFFECTS[0];
      const gradientLine = applied.gradient?.ok === false
        ? `⚠️ Couleur : ${applied.gradient.reason === 'permission' ? 'permission **Gérer les rôles** manquante' : 'Discord a refusé le rôle'}`
        : applied.gradient?.mode === 'gradient'
          ? '✅ Couleur : **dégradé** appliqué (visible si le serveur a le perk 3 boosts)'
          : applied.gradient?.mode === 'solid'
            ? '🟡 Couleur : **unie** (le dégradé demande le perk 3 boosts) — active **Pastilles** pour deux teintes'
            : '➖ Couleur : aucune';

      await interaction.editReply({
        embeds: [successEmbed('Pseudo du bot mis à jour', [
          `Pseudo : **${applied.nick || '—'}**`,
          `Police : ${font.label} · Effet : ${effect.label}`,
          gradientLine,
        ].join('\n'))],
      });
      await interaction.message?.edit(await stylePayload(interaction.guild, updated)).catch(() => {});
      return;
    }

    if (id === 'brand_toggle') {
      const next = !cfg.enabled;
      await guildBrand.saveBrand(interaction.guildId, { enabled: next }, interaction.user.id);
      const applied = await guildBrand.applyServerProfile(interaction.guild, { ...cfg, enabled: next });

      if (!applied.ok) {
        return interaction.update({
          embeds: [warningEmbed('Identité enregistrée, profil serveur non appliqué', applyProfileError(applied))],
          components: buildPanelComponents({ ...cfg, enabled: next }),
        }).catch(() => {});
      }
      return sendPanel(interaction, { edit: true });
    }

    if (id === 'brand_apply') {
      const result = await guildBrand.applyServerProfile(interaction.guild, cfg);
      if (!result.ok) {
        return interaction.reply({
          embeds: [errorEmbed('Profil serveur non appliqué', applyProfileError(result))],
          ephemeral: true,
        });
      }
      const details = [
        cfg.nickname ? `Surnom : **${cfg.nickname}**` : 'Surnom : *par défaut*',
        cfg.avatarUrl ? 'Avatar : **appliqué**' : 'Avatar : *par défaut*',
        cfg.bannerUrl ? 'Bannière : **appliquée**' : 'Bannière : *par défaut*',
      ].join('\n');
      return interaction.reply({
        embeds: [successEmbed('Profil serveur appliqué', `${details}\n\nL’affichage de ce serveur utilise maintenant ce profil de membre.`)],
        ephemeral: true,
      });
    }

    if (id === 'brand_preview') {
      await interaction.deferReply({ ephemeral: true });

      const previewCfg = { ...cfg, enabled: true };
      // On ne touche au vrai profil du serveur que si l’identité est active :
      // un aperçu ne doit jamais appliquer un profil que le serveur a désactivé.
      const applied = cfg.enabled
        ? await guildBrand.applyServerProfile(interaction.guild, cfg)
        : { ok: true, skipped: true };
      let sent = null;
      try {
        sent = await interaction.channel.send({
          content: cfg.displayName ? `Aperçu de l’identité de **${interaction.guild.name}** :` : undefined,
          embeds: [guildBrand.buildPreviewEmbed(previewCfg, interaction.guild.name)],
        });
      } catch { /* salon sans permission d'écriture */ }

      const lines = [];
      if (!applied.ok) lines.push(`⚠️ Profil serveur : ${applyProfileError(applied)}`);
      else if (applied.skipped) lines.push('ℹ️ Identité désactivée : active-la pour appliquer le profil serveur.');
      else lines.push('✅ Profil serveur appliqué (avatar, bannière, surnom).');
      lines.push(sent ? '✅ Message d’aperçu envoyé dans le salon.' : '⚠️ Impossible d’envoyer le message d’aperçu ici.');

      return interaction.editReply({
        embeds: [(applied.ok && sent ? successEmbed : warningEmbed)('Aperçu', lines.join('\n'))],
      });
    }

    if (id === 'brand_reset') {
      await guildBrand.saveBrand(interaction.guildId, {
        enabled: false,
        displayName: null,
        emoji: null,
        nickname: null,
        avatarUrl: null,
        bannerUrl: null,
        color: null,
        footerText: null,
        bannerMode: 'missing',
        replaceAuthor: true,
        replaceFooter: true,
        avatarThumbnail: false,
      }, interaction.user.id);
      await guildBrand.applyServerProfile(interaction.guild, { enabled: false });
      return sendPanel(interaction, { edit: true });
    }

    if (id === 'brand_toggle_author' || id === 'brand_toggle_footer' || id === 'brand_toggle_thumb') {
      const key = id === 'brand_toggle_author' ? 'replaceAuthor'
        : id === 'brand_toggle_footer' ? 'replaceFooter' : 'avatarThumbnail';
      await guildBrand.saveBrand(interaction.guildId, { [key]: !cfg[key] }, interaction.user.id);
      return sendPanel(interaction, { edit: true });
    }

    if (id === 'brand_banner_mode') {
      const order = guildBrand.BANNER_MODES;
      const next = order[(order.indexOf(cfg.bannerMode) + 1) % order.length];
      await guildBrand.saveBrand(interaction.guildId, { bannerMode: next }, interaction.user.id);
      return sendPanel(interaction, { edit: true });
    }
  },

  // ─── Menu de champ → modal ───────────────────────────────────────────────
  async handleSelect(interaction) {
    if (!(await requireAccess(interaction))) return;

    // Style du pseudo : les trois menus (police / effet / couleur) sont
    // persistants et ne concernent que le pseudo du bot.
    const STYLE_KEYS = {
      brand_style_font: 'nicknameFont',
      brand_style_effect: 'nicknameEffect',
      brand_style_color: 'nicknamePalette',
    };
    if (interaction.customId.startsWith('brand_style_')) {
      const key = STYLE_KEYS[interaction.customId];
      if (!key) return;
      const result = guildBrand.validatePatch({ [key]: interaction.values[0] });
      if (!result.ok) {
        return interaction.reply({ embeds: [errorEmbed('Valeur refusée', result.error)], ephemeral: true });
      }
      await interaction.deferUpdate();
      const next = await guildBrand.saveBrand(interaction.guildId, result.patch, interaction.user.id);
      // Application immédiate : le pseudo change en direct, comme dans l'aperçu,
      // au lieu d'attendre un clic sur « Appliquer ».
      const { updated } = await applyStyleAndSave(interaction.guild, interaction.guildId, interaction.user.id, next);
      return interaction.editReply(await stylePayload(interaction.guild, updated));
    }

    if (interaction.customId !== 'brand_field') return;

    const field = interaction.values[0];
    if (field === 'nickname_style') return showStylePanel(interaction);
    const input = FIELD_INPUTS[field];
    if (!input) return interaction.reply({ embeds: [errorEmbed('Champ inconnu', 'Réessaie avec le menu du panel.')], ephemeral: true });

    const cfg = await guildBrand.prime(interaction.guildId, { force: true });
    const current = cfg[input.key] || '';

    const modal = new ModalBuilder()
      .setCustomId(`brand_modal_${field}`)
      .setTitle(`🎨 ${FIELD_LABELS[field]}`);

    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel(input.label)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(input.placeholder)
        .setValue(String(current).slice(0, input.max))
        .setMaxLength(input.max)
        .setRequired(false),
    ));

    return interaction.showModal(modal);
  },

  // ─── Modaux ──────────────────────────────────────────────────────────────
  async handleModal(interaction) {
    if (!(await requireAccess(interaction))) return;

    const field = interaction.customId.replace('brand_modal_', '');
    const input = FIELD_INPUTS[field];
    if (!input) return interaction.reply({ embeds: [errorEmbed('Champ inconnu', 'Réessaie depuis le panel /branding.')], ephemeral: true });

    const raw = interaction.fields.getTextInputValue('value');
    const result = guildBrand.validatePatch({ [input.key]: raw });
    if (!result.ok) {
      return interaction.reply({ embeds: [errorEmbed('Valeur refusée', result.error)], ephemeral: true });
    }

    const cfg = await guildBrand.saveBrand(interaction.guildId, result.patch, interaction.user.id);

    let profileFailure = null;
    if (cfg.enabled && ['nickname', 'avatarUrl', 'bannerUrl'].includes(input.key)) {
      const applied = await guildBrand.applyServerProfile(interaction.guild, cfg);
      if (!applied.ok) profileFailure = applied;
    }

    const valueText = result.patch[input.key]
      ? String(result.patch[input.key]).slice(0, 200)
      : 'Valeur effacée.';
    const confirmation = profileFailure
      ? warningEmbed(`${FIELD_LABELS[field]} enregistré, profil non appliqué`, `${valueText}\n\n${applyProfileError(profileFailure)}`)
      : successEmbed(`${FIELD_LABELS[field]} mis à jour`, valueText);

    return interaction.reply({
      embeds: [confirmation, buildPanelEmbed(cfg, interaction.guild)],
      components: buildPanelComponents(cfg),
      ephemeral: true,
    });
  },

  // Exportés pour les tests (rendu pur, sans Discord).
  buildPanelEmbed,
  buildPanelComponents,
  buildStyleEmbed,
  buildStyleComponents,
  styleSummary,
  licenseRequiredEmbed,
  requireAccess,
  FIELD_INPUTS,
};
