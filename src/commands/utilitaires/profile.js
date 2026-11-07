'use strict';
// commands/utilitaires/profile.js — 🎖️ Système de profil utilisateur.
//
// Une seule commande (le budget Discord de 100 commandes globales est plein),
// quatre sous-commandes :
//   /profile voir [membre]  → carte PNG + badges avancés
//   /profile panel          → panel de création/édition (titre, bio, style,
//                             visibilité, badges épinglés)
//   /profile badges         → galerie complète avec progression
//   /profile supprimer      → réinitialisation (les badges restent)
//
// Tous les composants vivent dans le message : custom_id `prf_*` routé par
// events/core/interactionCreate.js, donc aucun collecteur qui expire.

const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const profileService = require('../../utils/profileService');
const profileBadges = require('../../utils/profileBadges');
const profilePanel = require('../../utils/profilePanelView');
const { renderProfileCard, formatNumber } = require('../../utils/profileCard');
const { computeLevel } = require('../xp/xp');
const { COLORS, errorEmbed, successEmbed } = require('../../utils/embeds');

const { IDS } = profilePanel;

// ─── Aides ──────────────────────────────────────────────────────────────────

function displayNameOf(user, member) {
  return member?.displayName || user?.globalName || user?.username || 'Membre';
}

async function fetchMember(guild, userId) {
  if (!guild) return null;
  const cached = guild.members?.cache?.get(userId);
  if (cached) return cached;
  return guild.members.fetch(userId).catch(() => null);
}

/** Charge la vue du profil du membre qui a cliqué (toujours lui-même). */
async function ownView(interaction) {
  const guild = interaction.guild;
  const member = interaction.member || await fetchMember(guild, interaction.user.id);
  return profileService.loadProfileView({
    guildId: guild.id,
    userId: interaction.user.id,
    guild,
    member,
    viewerId: interaction.user.id,
  });
}

/** Payload du panel principal, régénéré depuis l'état réel à chaque action. */
function panelPayload(view, interaction) {
  const member = interaction.member || null;
  return {
    embeds: [profilePanel.buildMainEmbed({
      profile: view.profile,
      displayName: displayNameOf(interaction.user, member),
      guildName: interaction.guild?.name || 'ce serveur',
      badges: view.badges,
      earned: view.earned,
      next: view.next,
    })],
    components: profilePanel.mainComponents(view.profile),
  };
}

function galleryPayload(view, page = 1) {
  return {
    embeds: [profilePanel.buildBadgesEmbed(view.badges, { page, pinned: view.profile.pinnedBadges })],
    components: profilePanel.badgeComponents(view.badges, { page, pinned: view.profile.pinnedBadges }),
  };
}

/** Carte PNG + embed public. */
async function cardPayload(view, user, member) {
  const { level, xpIntoLevel, xpForNext } = computeLevel(Number(view.stats.totalXp) || 0);
  const accent = profilePanel.accentOf(view.profile);
  const showcase = view.showcase || [];

  const buffer = await renderProfileCard({
    user,
    member,
    profile: view.profile,
    stats: { ...view.stats, level },
    badges: showcase,
    levelProgress: xpForNext > 0 ? xpIntoLevel / xpForNext : 0,
    levelLabel: `Niveau ${level} • ${formatNumber(xpIntoLevel)} / ${formatNumber(xpForNext)} XP`,
  });

  const attachment = new AttachmentBuilder(buffer, { name: 'profil.png' });
  const embed = new EmbedBuilder()
    .setColor(accent)
    .setAuthor({ name: `🎖️ Profil de ${displayNameOf(user, member)}` })
    .setImage('attachment://profil.png');

  if (view.profile.title) embed.setTitle(view.profile.title.slice(0, 256));

  const fields = [];
  if (showcase.length) {
    fields.push({
      name: `🏅 Badges (${view.earned}/${view.badges.length})`,
      value: showcase.map(b => `${b.emoji} ${b.name}`).join(' · ').slice(0, 1024),
    });
  } else if (!view.profile.showBadges) {
    fields.push({ name: '🏅 Badges', value: 'Masqués sur ce profil.' });
  } else {
    fields.push({ name: '🏅 Badges', value: 'Aucun badge débloqué pour l’instant.' });
  }

  if (view.next?.length) {
    fields.push({
      name: '🔓 Prochains badges',
      value: view.next.map(b => `${b.emoji} **${b.name}** — ${b.progressLabel}`).join('\n').slice(0, 1024),
    });
  }

  fields.push({
    name: '📊 Statistiques',
    value: [
      `Niveau **${level}**`,
      `Bumps **${view.stats.bumps}**`,
      `Pièces **${view.stats.coins.toLocaleString('fr-FR')}**`,
      `Vocal **${Math.floor(view.stats.voiceSeconds / 3600)} h**`,
    ].join(' · ').slice(0, 1024),
    inline: false,
  });

  embed.addFields(fields);
  embed.setFooter({ text: `REZO • Profil${view.profile.views ? ` • ${view.profile.views} vue(s)` : ''}` });

  return { embeds: [embed], files: [attachment] };
}

// ─── Commande ───────────────────────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('🎖️ Profil utilisateur : carte, personnalisation et badges')
  .addSubcommand(sub => sub
    .setName('voir')
    .setDescription('Voir une carte de profil avec les badges (toi par défaut)')
    .addUserOption(opt => opt
      .setName('membre')
      .setDescription('Membre à consulter (toi par défaut)')
      .setRequired(false)))
  .addSubcommand(sub => sub
    .setName('panel')
    .setDescription('Créer ou modifier ton profil : titre, bio, style, visibilité, badges'))
  .addSubcommand(sub => sub
    .setName('badges')
    .setDescription('Galerie de tes badges, progression et épinglage'))
  .addSubcommand(sub => sub
    .setName('supprimer')
    .setDescription('Réinitialiser ton profil (tes badges restent acquis)'));

async function execute(interaction, client) {
  if (!interaction.guildId) {
    return interaction.reply({
      embeds: [errorEmbed('Serveur requis', 'Le profil est propre à chaque serveur : utilise la commande dans un serveur.')],
      ephemeral: true,
    });
  }

  const sub = interaction.options.getSubcommand(true);

  // ── /profile voir ─────────────────────────────────────────────────────────
  if (sub === 'voir') {
    await interaction.deferReply();
    const target = interaction.options.getUser('membre') || interaction.user;
    const member = await fetchMember(interaction.guild, target.id);

    const view = await profileService.loadProfileView({
      guildId: interaction.guild.id,
      userId: target.id,
      guild: interaction.guild,
      member,
      viewerId: interaction.user.id,
    });

    if (!view.visible) {
      return interaction.editReply({
        embeds: [errorEmbed('Profil privé', `**${target.username}** a choisi de garder son profil privé.`)],
      });
    }

    let payload;
    try {
      payload = await cardPayload(view, target, member);
    } catch (err) {
      console.error('❌ Profile card error:', err.message);
      payload = {
        embeds: [new EmbedBuilder()
          .setColor(COLORS.primary)
          .setTitle(`🎖️ Profil de ${displayNameOf(target, member)}`)
          .setDescription(view.profile.bio || '_Aucune présentation._')
          .addFields(
            { name: '🏅 Badges', value: `${view.earned}/${view.badges.length} débloqués`, inline: true },
            { name: '📊 Niveau', value: String(view.stats.level), inline: true },
            { name: '🚀 Bumps', value: String(view.stats.bumps), inline: true },
          )],
      };
    }

    // Les vues ne comptent que pour les visites d'autres membres.
    if (target.id !== interaction.user.id && view.profile.exists) {
      await profileService.addView(interaction.guild.id, target.id);
    }

    if (target.id === interaction.user.id) {
      payload.components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.openPanel).setLabel('Personnaliser mon profil').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(IDS.badges).setLabel('Mes badges').setEmoji('🏅').setStyle(ButtonStyle.Secondary),
      )];
    }

    return interaction.editReply(payload);
  }

  // ── Sous-commandes privées ────────────────────────────────────────────────
  await interaction.deferReply({ ephemeral: true });
  const view = await ownView(interaction);

  if (sub === 'panel') {
    return interaction.editReply(panelPayload(view, interaction));
  }

  if (sub === 'badges') {
    return interaction.editReply(galleryPayload(view, 1));
  }

  if (sub === 'supprimer') {
    const existing = view.profile.exists;
    if (!existing) {
      return interaction.editReply({
        embeds: [errorEmbed('Aucun profil à supprimer', 'Tu n’as pas encore créé de profil sur ce serveur. Ouvre `/profile panel` pour commencer.')],
      });
    }
    return interaction.editReply({
      embeds: [profilePanel.buildResetEmbed()],
      components: profilePanel.resetComponents(),
    });
  }
}

// ─── Composants persistants ─────────────────────────────────────────────────

async function handleButton(interaction, client) {
  const id = interaction.customId;
  if (!id.startsWith('prf_')) return;
  if (!interaction.guild) {
    return interaction.reply({ embeds: [errorEmbed('Serveur requis', 'Le profil est propre à chaque serveur.')], ephemeral: true });
  }

  // Ouvrir le panel depuis une carte publique : réponse éphémère, la carte
  // publique n'est jamais remplacée.
  if (id === IDS.openPanel) {
    const view = await ownView(interaction);
    return interaction.reply({ ...panelPayload(view, interaction), ephemeral: true });
  }

  if (id === IDS.identity) {
    const view = await ownView(interaction);
    return interaction.showModal(profilePanel.buildIdentityModal(view.profile));
  }

  if (id === IDS.style) {
    const view = await ownView(interaction);
    return interaction.showModal(profilePanel.buildStyleModal(view.profile));
  }

  await interaction.deferUpdate();

  if (id === IDS.badges) {
    return interaction.editReply(galleryPayload(await ownView(interaction), 1));
  }

  const pageMatch = id.match(/^prf_btn_page_(prev|next):(\d+)$/);
  if (pageMatch) {
    const page = Math.max(1, Number(pageMatch[2]) || 1);
    return interaction.editReply(galleryPayload(await ownView(interaction), page));
  }

  if (id === IDS.back) {
    return interaction.editReply(panelPayload(await ownView(interaction), interaction));
  }

  if (id === IDS.preview) {
    const view = await ownView(interaction);
    const member = interaction.member || await fetchMember(interaction.guild, interaction.user.id);
    try {
      const payload = await cardPayload(view, interaction.user, member);
      return interaction.editReply({ ...payload, components: profilePanel.backComponents() });
    } catch (err) {
      console.error('❌ Profile preview error:', err.message);
      return interaction.editReply({
        embeds: [errorEmbed('Aperçu indisponible', 'La carte n’a pas pu être générée. Réessaie dans un instant.')],
        components: profilePanel.backComponents(),
      });
    }
  }

  if (id === IDS.toggleBadges) {
    const view = await ownView(interaction);
    await profileService.saveProfile(interaction.guild.id, interaction.user.id, {
      showBadges: !view.profile.showBadges,
    });
    return interaction.editReply(panelPayload(await ownView(interaction), interaction));
  }

  if (id === IDS.reset) {
    return interaction.editReply({
      embeds: [profilePanel.buildResetEmbed()],
      components: profilePanel.resetComponents(),
    });
  }

  if (id === IDS.resetConfirm) {
    await profileService.deleteProfile(interaction.guild.id, interaction.user.id);
    return interaction.editReply({
      embeds: [successEmbed('Profil réinitialisé', 'Ton profil est reparti de zéro. Tes badges, ton niveau et tes statistiques sont intacts : `/profile panel` pour le recréer.')],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.identity).setLabel('Recréer mon profil').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      )],
    });
  }

  if (id === IDS.cancel) {
    return interaction.editReply(panelPayload(await ownView(interaction), interaction));
  }
}

async function handleSelect(interaction, client) {
  const id = interaction.customId;
  if (!id.startsWith('prf_sel_')) return;
  if (!interaction.guild) return;

  await interaction.deferUpdate();

  if (id === IDS.visibilitySelect) {
    const value = interaction.values?.[0];
    await profileService.saveProfile(interaction.guild.id, interaction.user.id, { visibility: value });
    return interaction.editReply(panelPayload(await ownView(interaction), interaction));
  }

  if (id === IDS.badgeSelect) {
    const view = await ownView(interaction);
    const allowed = profileBadges.pinnableIds(view.badges, 200);
    await profileService.saveProfile(
      interaction.guild.id,
      interaction.user.id,
      { pinnedBadges: interaction.values || [] },
      { allowedBadgeIds: allowed },
    );
    const updated = await ownView(interaction);
    return interaction.editReply(galleryPayload(updated, 1));
  }
}

async function handleModal(interaction, client) {
  const id = interaction.customId;
  if (!id.startsWith('prf_modal')) return;
  if (!interaction.guild) return;

  await interaction.deferUpdate();

  let patch;
  if (id === IDS.identityModal) {
    patch = {
      title: interaction.fields.getTextInputValue('title'),
      bio: interaction.fields.getTextInputValue('bio'),
    };
  } else if (id === IDS.styleModal) {
    patch = {
      color: interaction.fields.getTextInputValue('color'),
      bannerUrl: interaction.fields.getTextInputValue('banner'),
    };
  } else {
    return;
  }

  const result = await profileService.saveProfile(interaction.guild.id, interaction.user.id, patch);
  if (!result.ok) {
    return interaction.editReply({
      embeds: [errorEmbed('Valeur refusée', `${result.reason}\n\nAucune modification n’a été enregistrée.`)],
      components: profilePanel.backComponents(),
    });
  }

  return interaction.editReply(panelPayload(await ownView(interaction), interaction));
}

module.exports = {
  data,
  execute,
  handleButton,
  handleSelect,
  handleModal,
  __testables: {
    panelPayload,
    galleryPayload,
    cardPayload,
    displayNameOf,
  },
};
