// commands/configuration/license.js — Panel licence + essai gratuit REZO.
//
// /license → ouvre un panel interactif unique.
// Les admins voient : statut, activer une clé, désactiver.
// L'essai gratuit est réservé au propriétaire du serveur (bouton désactivé
// pour les autres, et licenseGate.startTrial refuse de toute façon).
// Les owners du bot voient en plus : onglet Admin (générer clé, gérer essais, config).
//
// Toute la logique tourne via des boutons/select menus persistants préfixés lc_.

const {
  SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');

const License     = require('../../models/License');
const Trial       = require('../../models/Trial');
const licenseGate = require('../../utils/licenseGate');
const licenseCore = require('../../utils/licenseCore');
const { publicPacks, formatPrice } = require('../../utils/licensePlans');
const { sitePath } = require('../../utils/siteUrl');
const { COLORS, successEmbed, errorEmbed } = require('../../utils/embeds');

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtR(d)  { return d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : '—'; }
function fmtF(d)  { return d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:f>` : '—'; }

function keyPreview(key) {
  const p = String(key).split('-');
  return `${p[0]}-${p[1]}-••••-••••-${p[4]}`;
}

function licenseLine(l) {
  const status = licenseGate.computeStatus(l);
  const s = status === 'revoked' ? '🔴'
    : status === 'expired' ? '🟠'
    : status === 'grace' ? '🟡'
    : status === 'active' ? '🟢' : '⚪';
  const kind  = licenseGate.kindInfo(l.kind);
  const seats = licenseGate.seatsOf(l);
  const exp   = l.expiresAt ? `expire ${fmtR(l.expiresAt)}` : 'illimitée';
  const where = seats.length
    ? `**${l.guildName || seats[0]}**${seats.length > 1 ? ` +${seats.length - 1}` : ''}`
    : '**—**';
  return `${s} ${kind.emoji} \`${keyPreview(l.key)}\` → ${where} (${exp})`;
}

function trialLine(t) {
  const active = !t.expired && new Date(t.expiresAt) > Date.now();
  const s      = active ? '🟣' : '⚫';
  const resets = t.resetCount > 0 ? ` *(${t.resetCount} reset)*` : '';
  return `${s} **${t.guildName || t.guildId}** — expire ${fmtR(t.expiresAt)}${resets}`;
}

// ─── Builders du panel ───────────────────────────────────────────────────────

function buildStatusEmbed(guildId, guildName, licStatus, trialStatus, cfg, isOwnerUser) {
  const { status, license } = licStatus;
  const { status: tStatus, trial } = trialStatus;

  let color, title, statusLine, validityLine;

  if (status === 'active' || status === 'grace') {
    const inGrace  = status === 'grace';
    const kind     = licenseGate.kindInfo(license.kind);
    const seats    = licenseGate.seatsOf(license);
    const maxSeats = licenseGate.maxSeatsOf(license);
    const daysLeft = licenseGate.daysLeft(license);
    const grace    = Number(license.graceDays) || 0;

    color = inGrace ? COLORS.warning : COLORS.success;
    title = inGrace ? '⏳ Licence en période de grâce' : '✅ Licence active';
    statusLine = inGrace
      ? `La licence de **${guildName}** a expiré : l'accès reste ouvert pendant **${grace} jour(s)** de grâce.\nRenouvelez pour éviter le verrouillage.`
      : `**${guildName}** dispose du système complet REZO.\nToutes les fonctionnalités premium sont débloquées pour ce serveur.`;
    validityLine = `🗝️ Clé : \`${keyPreview(license.key)}\`\n`
      + `🏷️ Type : ${kind.emoji} **${kind.label}** — ${seats.length}/${maxSeats} serveur(s)\n`
      + `⏳ Validité : ${license.expiresAt
        ? `${fmtR(license.expiresAt)}${daysLeft !== null ? ` · **${daysLeft} jour(s)**` : ''}`
        : '**Illimitée**'}\n`
      + `📅 Activée : ${fmtF(license.activatedAt)}`;
  } else if (tStatus === 'active') {
    const remaining = new Date(trial.expiresAt).getTime() - Date.now();
    const daysLeft  = Math.ceil(remaining / 86_400_000);
    const filled    = Math.max(0, Math.min(10, Math.round((remaining / (cfg.durationDays * 86_400_000)) * 10)));
    const bar       = '`' + '█'.repeat(filled) + '░'.repeat(10 - filled) + `\` ${daysLeft}j`;
    color = daysLeft <= 1 ? COLORS.warning : 0x9B59B6;
    title = '🧪 Essai gratuit actif';
    statusLine = `🧪 **Mode essai** — expire ${fmtR(trial.expiresAt)}\n`
      + 'Toutes les fonctionnalités premium sont accessibles pendant l\'essai.';
    validityLine = `⏱️ Progression : ${bar}\n📅 Démarré : ${fmtF(trial.startedAt)}\n`
      + '🔑 Activez une licence avant expiration.';
  } else if (tStatus === 'expired') {
    color = COLORS.error;
    title = '⌛ Essai expiré';
    statusLine = `❌ L'essai a expiré le ${fmtF(trial.expiresAt)}`;
    validityLine = 'Activez une licence pour retrouver l\'accès aux fonctionnalités premium.';
  } else {
    color = status === 'none' ? COLORS.info : COLORS.error;
    title = status === 'none' ? '🔒 Aucune licence' : '⛔ Licence inactive';
    const label = { none: 'Aucune licence activée.', expired: 'La licence a **expiré**.', revoked: 'La licence a été **révoquée**.' };
    statusLine = `**${guildName}** — ${label[status] || label.none}`;
    const shop = licenseGate.getLicenseShopConfig();
    validityLine = (cfg.enabled
      ? `🧪 Essai gratuit de **${cfg.durationDays} jours** via le bouton ci-dessous.\n`
        + `Réservé au **propriétaire du serveur**, une seule fois par personne, `
        + `serveur de **${cfg.minMembers}+ membres** et créé depuis au moins **${cfg.minAgeDays} jours**.`
      : '🔑 Activez une licence avec votre clé `REZO-…`.')
      + `\n\n💎 **Achat en pièces :** \`/balance\` → **💎 Licence** — `
      + `**${shop.priceCoins}** pièces pour **${shop.days} jours** (propriétaire ou admin, aucun argent réel).`;
  }

  const featureCount = licenseGate.LICENSE_REQUIRED_COMMANDS.length;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(statusLine)
    .addFields(
      { name: '📋 Détails', value: validityLine, inline: false },
      {
        name: '🎯 Fonctionnalités',
        value: (license
          ? `**${licenseCore.featuresFor(license.kind, license.extras).length}/${featureCount}** modules ouverts par ta licence ${licenseGate.kindInfo(license.kind).label}`
            + (Array.isArray(license.extras) && license.extras.length
              ? ` + **${license.extras.length}** module(s) apportés par un pack`
              : '')
          : `**${featureCount}** modules premium protégés par licence`)
          + '\n*(bump, tickets, leveling, IA…)*',
        inline: false,
      },
    )
    .setFooter({ text: `REZO • ${guildName}${isOwnerUser ? ' • Mode owner' : ''}` })
    .setTimestamp();
}

// ─── Packs ───────────────────────────────────────────────────────────────────
// Décrits dans le bot, mais achetés UNIQUEMENT sur le site : la page dit
// exactement ce que la clé ouvre et ce que le support fait ensuite. Rien n'est
// promis que le bot ne puisse tenir tout seul.
function buildPacksEmbed() {
  const packs = publicPacks();
  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('🛍️ Packs REZO — achat sur le site');

  if (!packs.length) {
    return embed.setDescription('Aucun pack n’est proposé pour le moment.');
  }

  embed.setDescription(
    'Les packs **ne s’achètent pas depuis Discord** : le paiement se fait sur le site, '
    + 'puis la clé s’active ici avec **🔑 Activer une clé**.\n'
    + 'Chaque pack ouvre **en plus** les modules que son palier ne donne pas, '
    + 'et son nombre de serveurs peut dépasser celui de l’offre équivalente.\n'
    + 'Un pack **sur devis** se chiffre avec le support : aucun paiement en ligne.\n'
    + `🛒 ${sitePath('/packs')}\n`
    + `📝 Devis : ${sitePath('/devis')}\n\n`
    + '*Les prestations (installation, visuels, migration) sont réalisées avec le support '
    + 'après l’achat — le bot ne les applique pas automatiquement.*',
  );

  for (const pack of packs) {
    const price = pack.quote ? 'sur devis' : formatPrice(pack.amountCents, pack.currency);
    const compare = !pack.quote && pack.savingsCents
      ? ` — au lieu de ${formatPrice(pack.compareAtCents, pack.currency)}`
      : '';
    const duration = pack.quote
      ? 'durée au choix'
      : pack.days === null ? 'illimitée' : `${pack.days} jours`;
    embed.addFields({
      name: `${pack.label} · ${price}${compare}`,
      value: `${pack.kindLabel} · ${duration} · ${pack.seatsLabel}\n`
        + pack.perks.slice(0, 6).map(p => `• ${p}`).join('\n'),
      inline: false,
    });
  }

  return embed.setFooter({
    text: 'REZO • un pack remplace la licence en cours du serveur, il ne s’y ajoute pas',
  });
}

function buildMainRows(licStatus, trialStatus, cfg, isOwnerUser, { isGuildOwner = false } = {}) {
  const { status } = licStatus;
  const { status: tStatus } = trialStatus;
  // L'essai est réservé au propriétaire du serveur : pour les autres admins,
  // le bouton est visible mais désactivé (et le gate refuse de toute façon).
  const canTrial  = cfg.enabled && status !== 'active' && status !== 'grace' && tStatus === 'none' && (isGuildOwner || isOwnerUser);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lc_view_features')
      .setLabel('📋 Fonctionnalités')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('lc_activate_modal')
      .setLabel('🔑 Activer une clé')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(status === 'active'),
    new ButtonBuilder()
      .setCustomId('lc_start_trial')
      .setLabel('🧪 Essai gratuit')
      .setStyle(canTrial ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!canTrial),
    new ButtonBuilder()
      .setCustomId('lc_deactivate')
      .setLabel('🔓 Désactiver')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(status !== 'active' && status !== 'grace'),
    new ButtonBuilder()
      .setCustomId('lc_packs')
      .setLabel('🛍️ Packs')
      .setStyle(ButtonStyle.Secondary),
  );

  const components = [row1];

  if (isOwnerUser) {
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('lc_admin_panel')
        .setLabel('⚙️ Panel owner')
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(row2);
  }

  return components;
}

function buildAdminEmbed(cfg) {
  const shop = licenseGate.getLicenseShopConfig();
  return new EmbedBuilder()
    .setColor(0x2C3E50)
    .setTitle('⚙️ Panel owner — Licences & Essais')
    .setDescription('Gérez les clés de licence et les essais gratuits depuis ce panel.')
    .addFields(
      { name: '⚙️ Config essais', value: `Activés : **${cfg.enabled ? 'Oui' : 'Non'}**\nDurée : **${cfg.durationDays} jour(s)**\nMembres min. : **${cfg.minMembers}**\nAncienneté min. : **${cfg.minAgeDays} j**`, inline: true },
      { name: '💎 Boutique licence', value: `Prix : **${shop.priceCoins}** pièces\nDurée : **${shop.days} j**`, inline: true },
      { name: '🗝️ Format des clés', value: '`REZO-XXXX-XXXX-XXXX-XXXX`\nTirets et espaces tolérés', inline: true },
      {
        name: '🏷️ Types de licence',
        value: licenseGate.assignableKinds().map(id => {
          const k = licenseGate.kindInfo(id);
          return `${k.emoji} **${k.label}** — ${k.maxGuilds} serveur(s)`;
        }).join('\n'),
        inline: false,
      },
      { name: '📝 .env permanent', value: '`TRIAL_DURATION_DAYS`\n`TRIAL_ENABLED`\n`TRIAL_MIN_MEMBERS`\n`TRIAL_MIN_AGE_DAYS`\n`LICENSE_PRICE_COINS`\n`LICENSE_DAYS`', inline: false },
    )
    .setFooter({ text: 'REZO • Owner uniquement' })
    .setTimestamp();
}

function buildAdminRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lc_admin_genkey').setLabel('🔑 Générer une clé').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('lc_admin_list_lic').setLabel('📋 Liste licences').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lc_admin_list_trials').setLabel('🧪 Liste essais').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lc_admin_trial_reset_modal').setLabel('🔄 Reset essai').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('lc_admin_trial_revoke_modal').setLabel('🗑️ Révoquer essai').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('lc_admin_revoke_key_modal').setLabel('⛔ Révoquer clé').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('lc_admin_trial_config').setLabel('⚙️ Config essais').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lc_admin_extend_modal').setLabel('⏱️ Prolonger').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('lc_admin_transfer_modal').setLabel('🔄 Transférer').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('lc_admin_sweep').setLabel('🧹 Balayer les expirées').setStyle(ButtonStyle.Secondary),
  );
  const row4 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lc_back_main').setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2, row3, row4];
}

// ─── Envoi/mise à jour du panel principal ─────────────────────────────────────

async function sendMainPanel(interaction, { edit = false } = {}) {
  const guild       = interaction.guild;
  const isOwnerUser = licenseGate.isOwner(interaction.user.id);
  const cfg         = licenseGate.getTrialConfig();
  const licStatus   = await licenseGate.getLicenseStatus(guild.id);
  const trialStatus = await licenseGate.getTrialStatus(guild.id);

  const embed = buildStatusEmbed(guild.id, guild.name, licStatus, trialStatus, cfg, isOwnerUser);
  const rows  = buildMainRows(licStatus, trialStatus, cfg, isOwnerUser, {
    isGuildOwner: guild.ownerId === interaction.user.id,
  });

  const payload = { embeds: [embed], components: rows };

  if (edit) {
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
    return interaction.update(payload).catch(() => {});
  }
  await interaction.deferReply({ ephemeral: true });
  return interaction.editReply(payload);
}

// ─── Slash command ────────────────────────────────────────────────────────────

module.exports = {
  // Exposé pour les tests : les descriptions des packs affichées dans Discord
  // doivent rester celles du catalogue, jamais une copie qui dérive.
  buildPacksEmbed,

  data: new SlashCommandBuilder()
    .setName('license')
    .setDescription('🔑 Gérer la licence et l\'essai gratuit de ce serveur')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction, client) {
    await sendMainPanel(interaction);
  },

  // ─── Handlers boutons (routés depuis interactionCreate) ────────────────────
  async handleButton(interaction, client) {
    const id    = interaction.customId;
    const guild = interaction.guild;
    const isOwnerUser = licenseGate.isOwner(interaction.user.id);

    // ── Retour panel principal ──────────────────────────────────────────────
    if (id === 'lc_back_main') {
      return sendMainPanel(interaction, { edit: true });
    }

    // ── Voir les fonctionnalités ────────────────────────────────────────────
    if (id === 'lc_view_features') {
      const { status, license } = await licenseGate.getLicenseStatus(guild.id);
      const { status: tStatus } = await licenseGate.getTrialStatus(guild.id);
      const hasAccess = status === 'active' || status === 'grace' || tStatus === 'active';

      // Chaque type de licence ouvre un palier précis : on affiche l'état réel
      // de chaque fonctionnalité, pas seulement « une licence existe ».
      const kind = license?.kind || (tStatus === 'active' ? 'trial' : null);
      // Les extras du pack comptent : un module acheté en plus reste ouvert
      // même si le palier, seul, le refuserait.
      const allowed = (name) => (kind ? licenseGate.featureAllowed(kind, name, license?.extras) : false);
      const tierLabel = kind ? licenseGate.kindInfo(kind).label : null;

      const cols = licenseGate.LICENSE_REQUIRED_COMMANDS;
      const mid  = Math.ceil(cols.length / 2);
      const col1 = cols.slice(0, mid).map(c => `${allowed(c) ? '✅' : '🔒'} \`/${c}\``).join('\n');
      const col2 = cols.slice(mid).map(c => `${allowed(c) ? '✅' : '🔒'} \`/${c}\``).join('\n');

      const embed = new EmbedBuilder()
        .setColor(hasAccess ? COLORS.success : COLORS.warning)
        .setTitle('🎯 Fonctionnalités premium REZO')
        .addFields(
          { name: '\u200b', value: col1, inline: true },
          { name: '\u200b', value: col2, inline: true },
        )
        .setFooter({ text: kind
          ? `Palier ${tierLabel} — 🔒 = une autre licence est requise`
          : 'Activez une licence ou démarrez un essai' });

      const back = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lc_back_main').setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
      );
      if (interaction.deferred || interaction.replied) return interaction.editReply({ embeds: [embed], components: [back] }).catch(() => {});
      return interaction.update({ embeds: [embed], components: [back] });
    }

    // ── Découvrir les packs ─────────────────────────────────────────────────
    if (id === 'lc_packs') {
      const back = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lc_back_main').setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
      );
      const payload = { embeds: [buildPacksEmbed()], components: [back] };
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => {});
      return interaction.update(payload).catch(() => {});
    }

    // ── Activer une clé → modal ─────────────────────────────────────────────
    if (id === 'lc_activate_modal') {
      const modal = new ModalBuilder()
        .setCustomId('lc_modal_activate')
        .setTitle('🔑 Activer une licence');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('key')
          .setLabel('Clé de licence (REZO-XXXX-XXXX-XXXX-XXXX)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('REZO-XXXX-XXXX-XXXX-XXXX')
          .setRequired(true)
          .setMinLength(24).setMaxLength(24),
      ));
      return interaction.showModal(modal);
    }

    // ── Démarrer l'essai ────────────────────────────────────────────────────
    if (id === 'lc_start_trial') {
      const cfg = licenseGate.getTrialConfig();
      if (!cfg.enabled) {
        const back = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('lc_back_main').setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
        );
        if (interaction.deferred || interaction.replied) return interaction.editReply({ embeds: [errorEmbed('Essais désactivés', 'Les essais gratuits sont actuellement désactivés.')], components: [back] }).catch(() => {});
        return interaction.update({ embeds: [errorEmbed('Essais désactivés', 'Les essais gratuits sont actuellement désactivés.')], components: [back] });
      }

      await interaction.deferUpdate();
      const res = await licenseGate.startTrial(guild.id, guild.name, interaction.user.id, {
        guildOwnerId: guild.ownerId,
        memberCount: guild.memberCount,
        guildCreatedAt: guild.createdTimestamp,
      });

      if (!res.ok) {
        const msgs = {
          has_license:      'Ce serveur a déjà une **licence active**.',
          already_active:   `Un essai est déjà en cours — expire ${fmtR(res.trial?.expiresAt)}.`,
          already_used:     `L'essai a déjà été utilisé (expiré ${fmtR(res.trial?.expiresAt)}).\nUn seul essai par serveur — activez une licence.`,
          disabled:         'Les essais gratuits sont désactivés.',
          not_owner:        'Seul le **propriétaire du serveur** peut démarrer l\'essai gratuit — pas les autres administrateurs.\nTransmets-lui ce message.',
          too_small:        `Ce serveur compte **${res.memberCount} membre(s)** : il en faut au moins **${res.minMembers}** pour un essai.`,
          too_young:        `Un essai est possible seulement après **${res.minAgeDays} jours** d\'existence du serveur (disponible ${fmtR(res.opensAt)}).`,
          user_already_used:'Un essai gratuit a déjà été utilisé par **ton compte** sur un autre serveur.\nUn seul essai par personne — active une licence pour continuer.',
        };
        const back = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('lc_back_main').setLabel('↩️ Retour').setStyle(ButtonStyle.Secondary),
        );
        return interaction.editReply({ embeds: [errorEmbed('Impossible', msgs[res.reason] || 'Erreur inconnue.')], components: [back] });
      }

      // Succès — rafraîchir le panel
      return sendMainPanel(interaction, { edit: true });
    }

    // ── Désactiver ──────────────────────────────────────────────────────────
    if (id === 'lc_deactivate') {
      await licenseGate.unlinkGuild(guild.id);
      return sendMainPanel(interaction, { edit: true });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ── Section owner ───────────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════════

    if (!isOwnerUser) {
      return interaction.reply({ embeds: [errorEmbed('Accès refusé', 'Section réservée au propriétaire du bot.')], ephemeral: true });
    }

    // ── Ouvrir panel admin ──────────────────────────────────────────────────
    if (id === 'lc_admin_panel') {
      const cfg   = licenseGate.getTrialConfig();
      const embed = buildAdminEmbed(cfg);
      const rows  = buildAdminRows();
      if (interaction.deferred || interaction.replied) return interaction.editReply({ embeds: [embed], components: rows }).catch(() => {});
      return interaction.update({ embeds: [embed], components: rows });
    }

    // ── Prolonger une clé → modal ────────────────────────────────────────────
    if (id === 'lc_admin_extend_modal') {
      const modal = new ModalBuilder().setCustomId('lc_modal_extend').setTitle('⏱️ Prolonger une licence');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('key').setLabel('Clé complète (REZO-…)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('jours').setLabel('Jours à ajouter (1–3650)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('Ex: 30'),
        ),
      );
      return interaction.showModal(modal);
    }

    // ── Transférer une clé → modal ────────────────────────────────────────────
    if (id === 'lc_admin_transfer_modal') {
      const modal = new ModalBuilder().setCustomId('lc_modal_transfer').setTitle('🔄 Transférer une licence');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('key').setLabel('Clé complète (REZO-…)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('guildid').setLabel('ID du serveur de destination').setStyle(TextInputStyle.Short).setRequired(true),
        ),
      );
      return interaction.showModal(modal);
    }

    // ── Balayage des licences expirées ────────────────────────────────────────
    if (id === 'lc_admin_sweep') {
      await interaction.deferReply({ ephemeral: true });
      const res = await licenseGate.sweepExpired();
      return interaction.editReply({
        embeds: [successEmbed(
          '🧹 Balayage terminé',
          `**${res.licenses}** licence(s) expirée(s) vérifiée(s) : **${res.expired}** hors grâce, **${res.grace}** en grâce.\n`
          + `**${res.trials}** essai(s) marqué(s) comme terminé(s).`,
        )],
      });
    }

    // ── Générer clé → modal ─────────────────────────────────────────────────
    if (id === 'lc_admin_genkey') {
      const modal = new ModalBuilder().setCustomId('lc_modal_genkey').setTitle('🔑 Nouvelle clé de licence');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('type')
            .setLabel('Type : essentiel, standard, network, partner')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('essentiel · standard · network · partner · owner')
            .setValue('standard')
            .setMaxLength(20),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('jours').setLabel('Durée (jours — vide = illimitée)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('Ex: 30'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('note').setLabel('Note interne (ex: client #42)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200),
        ),
      );
      return interaction.showModal(modal);
    }

    // ── Liste licences ──────────────────────────────────────────────────────
    if (id === 'lc_admin_list_lic') {
      await interaction.deferUpdate();
      const all   = await licenseGate.listLicenses({});
      const lines = all.slice(0, 20).map(licenseLine);
      const embed = new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle(`🔑 Licences (${all.length})`)
        .setDescription(lines.join('\n') || '*Aucune clé.*');
      if (all.length > 20) embed.setFooter({ text: `+ ${all.length - 20} autres — utilisez la recherche du panel owner` });
      const back = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lc_admin_panel').setLabel('↩️ Retour admin').setStyle(ButtonStyle.Secondary),
      );
      return interaction.editReply({ embeds: [embed], components: [back] });
    }

    // ── Liste essais ────────────────────────────────────────────────────────
    if (id === 'lc_admin_list_trials') {
      await interaction.deferUpdate();
      const all   = await licenseGate.listTrials({});
      const lines = all.slice(0, 20).map(trialLine);
      const cfg   = licenseGate.getTrialConfig();
      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`🧪 Essais (${all.length})`)
        .setDescription(lines.join('\n') || '*Aucun essai.*')
        .setFooter({ text: `Durée : ${cfg.durationDays}j • ${cfg.enabled ? 'Activés' : 'Désactivés'}` });
      if (all.length > 20) embed.addFields({ name: '\u200b', value: `+ ${all.length - 20} autres` });
      const back = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lc_admin_panel').setLabel('↩️ Retour admin').setStyle(ButtonStyle.Secondary),
      );
      return interaction.editReply({ embeds: [embed], components: [back] });
    }

    // ── Reset essai → modal ─────────────────────────────────────────────────
    if (id === 'lc_admin_trial_reset_modal') {
      const modal = new ModalBuilder().setCustomId('lc_modal_trial_reset').setTitle('🔄 Reset essai');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('guildid').setLabel('ID du serveur').setStyle(TextInputStyle.Short).setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('note').setLabel('Note interne (raison)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200),
        ),
      );
      return interaction.showModal(modal);
    }

    // ── Révoquer essai → modal ──────────────────────────────────────────────
    if (id === 'lc_admin_trial_revoke_modal') {
      const modal = new ModalBuilder().setCustomId('lc_modal_trial_revoke').setTitle('🗑️ Révoquer essai');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('guildid').setLabel('ID du serveur').setStyle(TextInputStyle.Short).setRequired(true),
      ));
      return interaction.showModal(modal);
    }

    // ── Révoquer clé → modal ────────────────────────────────────────────────
    if (id === 'lc_admin_revoke_key_modal') {
      const modal = new ModalBuilder().setCustomId('lc_modal_revoke_key').setTitle('⛔ Révoquer une clé');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('key').setLabel('Clé complète (REZO-…)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(24),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('raison').setLabel('Motif (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200),
        ),
      );
      return interaction.showModal(modal);
    }

    // ── Config essais → modal ───────────────────────────────────────────────
    if (id === 'lc_admin_trial_config') {
      const cfg   = licenseGate.getTrialConfig();
      const modal = new ModalBuilder().setCustomId('lc_modal_trial_config').setTitle('⚙️ Config essais');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('duree')
            .setLabel('Durée en jours (1–90)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(String(cfg.durationDays))
            .setPlaceholder('Ex: 7'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('activer')
            .setLabel('Activer les essais ? (oui / non)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(cfg.enabled ? 'oui' : 'non')
            .setPlaceholder('oui ou non'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('membres')
            .setLabel('Membres minimum du serveur (0 = aucun)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(String(cfg.minMembers))
            .setPlaceholder('Ex: 5'),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('age')
            .setLabel('Ancienneté min. du serveur (jours, 0 = aucun)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(String(cfg.minAgeDays))
            .setPlaceholder('Ex: 2'),
        ),
      );
      return interaction.showModal(modal);
    }
  },

  // ─── Handlers modaux ────────────────────────────────────────────────────────
  async handleModal(interaction, client) {
    const id    = interaction.customId;
    const guild = interaction.guild;
    const isOwnerUser = licenseGate.isOwner(interaction.user.id);

    // ── Activer une clé ─────────────────────────────────────────────────────
    if (id === 'lc_modal_activate') {
      const rawKey = interaction.fields.getTextInputValue('key').trim().toUpperCase();
      await interaction.deferReply({ ephemeral: true });

      const res = await licenseGate.activateLicense(rawKey, guild.id, guild.name, interaction.user.id);
      if (!res.ok) {
        const messages = {
          invalid_format: 'Format de clé invalide. Exemple : `REZO-XXXX-XXXX-XXXX-XXXX`.',
          not_found:      'Cette clé n\'existe pas. Vérifiez la saisie.',
          revoked:        'Cette clé a été **révoquée**.',
          expired:        'Cette clé a **expiré**, grâce incluse. Demandez une prolongation à l\'owner du bot.',
          used_elsewhere: 'Cette clé est **déjà activée sur un autre serveur**.\nUne clé standard = un serveur : demandez une clé **réseau** pour plusieurs serveurs.',
          full:           'Cette clé a atteint son **nombre maximum de serveurs**.\nL\'owner peut la prolonger ou libérer un siège.',
          unavailable:    'Cette clé est momentanément indisponible. Réessayez dans un instant.',
        };
        return interaction.editReply({ embeds: [errorEmbed('Activation impossible', messages[res.reason] || 'Erreur inconnue.')] });
      }

      const { status: tStatus } = await licenseGate.getTrialStatus(guild.id);
      const trialTxt = tStatus === 'active' ? '\n\n✅ Votre **essai gratuit** a été remplacé par cette licence.' : '';
      const lic = res.license;

      const embed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('🎉 Licence activée !')
        .setDescription(`**${guild.name}** dispose maintenant du système complet REZO.${trialTxt}`)
        .addFields(
          { name: '🗝️ Clé',      value: `\`${keyPreview(lic.key)}\``, inline: true },
          { name: '⏳ Validité',  value: lic.expiresAt ? fmtR(lic.expiresAt) : 'Illimitée', inline: true },
          { name: '📅 Activée',   value: fmtF(lic.activatedAt), inline: true },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ════════════════════════════════════════════════════════════════════════
    // ── Modaux owner ────────────────────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════════
    if (!isOwnerUser) {
      return interaction.reply({ embeds: [errorEmbed('Accès refusé', 'Section réservée au propriétaire du bot.')], ephemeral: true });
    }

    // ── Prolonger une licence ───────────────────────────────────────────────
    if (id === 'lc_modal_extend') {
      const key   = interaction.fields.getTextInputValue('key').trim();
      const jours = parseInt(interaction.fields.getTextInputValue('jours').trim(), 10);
      await interaction.deferReply({ ephemeral: true });

      if (!Number.isFinite(jours) || jours < 1 || jours > 3650) {
        return interaction.editReply({ embeds: [errorEmbed('Durée invalide', 'Entre 1 et 3650 jours.')] });
      }

      const res = await licenseGate.extendLicense(key, jours, interaction.user.id);
      if (!res.ok) {
        const msgs = {
          invalid_format: 'Format de clé invalide.',
          not_found:      'Aucune clé ne correspond.',
          revoked:        'Cette clé est révoquée.',
          unlimited:      'Cette licence est **illimitée** : rien à prolonger.',
          duration:       'Durée invalide.',
        };
        return interaction.editReply({ embeds: [errorEmbed('Prolongation impossible', msgs[res.reason] || 'Erreur inconnue.')] });
      }

      return interaction.editReply({
        embeds: [successEmbed(
          '⏱️ Licence prolongée',
          `\`${keyPreview(res.license.key)}\` gagne **${res.days} jour(s)**.\nNouvelle validité : ${fmtR(res.license.expiresAt)}.`,
        )],
      });
    }

    // ── Transférer une licence ───────────────────────────────────────────────
    if (id === 'lc_modal_transfer') {
      const key     = interaction.fields.getTextInputValue('key').trim();
      const guildId = interaction.fields.getTextInputValue('guildid').trim();
      await interaction.deferReply({ ephemeral: true });

      if (!/^\d{5,25}$/.test(guildId)) {
        return interaction.editReply({ embeds: [errorEmbed('ID invalide', 'Un identifiant de serveur est numérique (17–20 chiffres).')] });
      }

      const target = client.guilds.cache.get(guildId) || null;
      const res = await licenseGate.transferLicense(key, guildId, target?.name || null, interaction.user.id);
      if (!res.ok) {
        const msgs = {
          invalid_format: 'Format de clé invalide.',
          not_found:      'Aucune clé ne correspond.',
          revoked:        'Cette clé est révoquée.',
          expired:        'Cette licence est expirée : prolongez-la d\'abord.',
          invalid:        'Serveur de destination invalide.',
        };
        return interaction.editReply({ embeds: [errorEmbed('Transfert impossible', msgs[res.reason] || 'Erreur inconnue.')] });
      }

      const freed = res.from.filter(id => id !== guildId);
      return interaction.editReply({
        embeds: [successEmbed(
          '🔄 Licence transférée',
          `\`${keyPreview(res.license.key)}\` est maintenant liée à **${target?.name || guildId}**.`
          + (freed.length ? `\nServeur(s) libéré(s) : ${freed.map(id => `\`${id}\``).join(', ')}.` : ''),
        )],
      });
    }

    // ── Générer une clé ─────────────────────────────────────────────────────
    if (id === 'lc_modal_genkey') {
      const joursRaw = interaction.fields.getTextInputValue('jours').trim();
      const note     = interaction.fields.getTextInputValue('note').trim();
      const typeRaw  = (interaction.fields.getTextInputValue('type') || '').trim().toLowerCase();
      const kind     = licenseGate.kindInfo(typeRaw || 'standard');
      const jours    = joursRaw ? parseInt(joursRaw) : null;

      if (jours !== null && (isNaN(jours) || jours < 1 || jours > 3650)) {
        return interaction.reply({ embeds: [errorEmbed('Durée invalide', 'La durée doit être entre 1 et 3650 jours.')], ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      // Une erreur de validation (clé refusée par le schéma, base indisponible)
      // ne doit jamais laisser l'owner devant une interaction muette.
      let license;
      try {
        license = await licenseGate.createLicense(interaction.user.id, {
          jours, note, kind: kind.id, maxGuilds: kind.maxGuilds, planId: kind.id,
        });
      } catch (err) {
        console.error('[license] génération impossible :', err.message);
        return interaction.editReply({
          embeds: [errorEmbed('Génération impossible',
            'La clé n\'a pas pu être créée (base ou validation en erreur).\nRéessaie dans un instant ; si le problème persiste, consulte les logs.')],
        });
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle('🔑 Clé de licence générée')
        .setDescription(`Transmettez cette clé à l'admin du serveur :\n\`/license\` → **🔑 Activer une clé** → \`${license.key}\``)
        .addFields(
          { name: '🗝️ Clé complète', value: `\`${license.key}\`` },
          { name: '🏷️ Type',         value: `${kind.emoji} **${kind.label}** — ${kind.maxGuilds} serveur(s)`, inline: true },
          { name: '⏳ Validité',     value: jours ? `${jours} jour(s) (expire ${fmtR(license.expiresAt)})` : 'Illimitée', inline: true },
          { name: '📝 Note',         value: note || '*Aucune*', inline: true },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // ── Reset essai ─────────────────────────────────────────────────────────
    if (id === 'lc_modal_trial_reset') {
      const guildId = interaction.fields.getTextInputValue('guildid').trim();
      const note    = interaction.fields.getTextInputValue('note').trim();
      await interaction.deferReply({ ephemeral: true });

      const cfg   = licenseGate.getTrialConfig();
      const trial = await licenseGate.resetTrial(guildId, interaction.user.id, { note });
      const name  = client.guilds.cache.get(guildId)?.name || trial.guildName || guildId;

      return interaction.editReply({
        embeds: [successEmbed(
          '🔄 Essai réinitialisé',
          `**${name}** a un nouvel essai de **${cfg.durationDays} jours**.\nExpire ${fmtR(trial.expiresAt)}${note ? `\n📝 ${note}` : ''}`,
        )],
      });
    }

    // ── Révoquer essai ──────────────────────────────────────────────────────
    if (id === 'lc_modal_trial_revoke') {
      const guildId = interaction.fields.getTextInputValue('guildid').trim();
      const trial   = await Trial.findOne({ guildId }).lean();

      if (!trial || trial.expired || new Date(trial.expiresAt) <= new Date()) {
        return interaction.reply({ embeds: [errorEmbed('Introuvable / déjà expiré', 'Aucun essai actif pour ce serveur.')], ephemeral: true });
      }

      await licenseGate.revokeTrial(guildId);
      const name = client.guilds.cache.get(guildId)?.name || trial.guildName || guildId;
      return interaction.reply({
        embeds: [successEmbed('Essai révoqué', `L'essai de **${name}** est terminé immédiatement.`)],
        ephemeral: true,
      });
    }

    // ── Révoquer clé ────────────────────────────────────────────────────────
    if (id === 'lc_modal_revoke_key') {
      const key    = interaction.fields.getTextInputValue('key').trim().toUpperCase();
      const raison = interaction.fields.getTextInputValue('raison').trim();
      const res    = await licenseGate.revokeLicense(key, interaction.user.id, raison);

      if (!res.ok) return interaction.reply({ embeds: [errorEmbed('Introuvable', 'Aucune clé ne correspond.')], ephemeral: true });

      const where = res.affectedGuild
        ? `Features reverrouillées sur \`${res.affectedGuild}\`.`
        : 'Clé non liée à un serveur.';
      return interaction.reply({
        embeds: [successEmbed('Clé révoquée', `\`${keyPreview(res.license.key)}\` révoquée.\n${where}`)],
        ephemeral: true,
      });
    }

    // ── Config essais ────────────────────────────────────────────────────────
    if (id === 'lc_modal_trial_config') {
      const dRaw    = interaction.fields.getTextInputValue('duree').trim();
      const aRaw    = interaction.fields.getTextInputValue('activer').trim().toLowerCase();
      const mRaw    = interaction.fields.getTextInputValue('membres').trim();
      const ageRaw  = interaction.fields.getTextInputValue('age').trim();
      const jours   = dRaw ? parseInt(dRaw) : null;
      const enabled = aRaw === 'oui' ? true : aRaw === 'non' ? false : null;
      const minMembers = mRaw ? parseInt(mRaw) : null;
      const minAgeDays = ageRaw ? parseInt(ageRaw) : null;

      if (jours !== null && (isNaN(jours) || jours < 1 || jours > 90)) {
        return interaction.reply({ embeds: [errorEmbed('Durée invalide', 'Entre 1 et 90 jours.')], ephemeral: true });
      }
      if (aRaw && enabled === null) {
        return interaction.reply({ embeds: [errorEmbed('Valeur invalide', 'Entrez `oui` ou `non` pour l\'activation.')], ephemeral: true });
      }
      if (minMembers !== null && (isNaN(minMembers) || minMembers < 0 || minMembers > 100000)) {
        return interaction.reply({ embeds: [errorEmbed('Minimum de membres invalide', 'Entre 0 et 100 000.')], ephemeral: true });
      }
      if (minAgeDays !== null && (isNaN(minAgeDays) || minAgeDays < 0 || minAgeDays > 365)) {
        return interaction.reply({ embeds: [errorEmbed('Ancienneté invalide', 'Entre 0 et 365 jours.')], ephemeral: true });
      }

      licenseGate.setTrialConfig({
        durationDays: jours ?? undefined,
        enabled: enabled ?? undefined,
        minMembers: minMembers ?? undefined,
        minAgeDays: minAgeDays ?? undefined,
      });
      const cfg     = licenseGate.getTrialConfig();
      const changes = [];
      if (jours !== null)      changes.push(`⏱️ Durée → **${cfg.durationDays} jour(s)**`);
      if (enabled !== null)    changes.push(`${cfg.enabled ? '✅' : '❌'} Essais → **${cfg.enabled ? 'activés' : 'désactivés'}**`);
      if (minMembers !== null) changes.push(`👥 Membres min. → **${cfg.minMembers}**`);
      if (minAgeDays !== null) changes.push(`📅 Ancienneté min. → **${cfg.minAgeDays} jour(s)**`);

      return interaction.reply({
        embeds: [successEmbed(
          '⚙️ Config mise à jour',
          (changes.join('\n') || 'Aucun changement.')
          + '\n\n⚠️ *En mémoire uniquement. Pour persister, éditez votre `.env`.*',
        )],
        ephemeral: true,
      });
    }
  },
};
