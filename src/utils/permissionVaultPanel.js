'use strict';
// utils/permissionVaultPanel.js — Panneau du coffre-fort de permissions.
//
// Sorti de /securite pour rester testable hors-ligne : tout ce fichier ne fait
// que produire des embeds/composants et traiter les interactions du panneau.
// La logique d'accès vit dans utils/permissionVault.js.

const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const E = require('./permissionVaultEngine');
const V = require('./permissionVault');
const { COLORS } = require('./embeds');

const OK = v => (v ? '🟢' : '🔴');
const fmtDate = d => {
  const t = d ? Math.floor(new Date(d).getTime() / 1000) : null;
  return t ? `<t:${t}:R>` : '—';
};

function botPerms(guild) {
  try {
    const perms = guild?.members?.me?.permissions;
    if (!perms || typeof perms.has !== 'function') return { canManageChannels: true, canManageRoles: true };
    return {
      canManageChannels: perms.has(PermissionFlagsBits.ManageChannels),
      canManageRoles: perms.has(PermissionFlagsBits.ManageRoles),
    };
  } catch {
    return { canManageChannels: true, canManageRoles: true };
  }
}

// ── Embed ────────────────────────────────────────────────────────────────────
function buildVaultEmbed(cfg, guild = null) {
  V.ensureShape(cfg);
  const audit = E.vaultAudit(cfg, { guildId: guild?.id, ...botPerms(guild) });
  const stats = cfg.stats || {};

  const channelLines = cfg.protectedChannels.slice(0, 12).map((c, i) =>
    `${i + 1}. ${c.name ? `**${c.name}**` : `<#${c.channelId}>`} — \`${(c.overwrites || []).length}\` règle(s) · capturé ${fmtDate(c.capturedAt)}`);
  const roleLines = cfg.protectedRoles.slice(0, 10).map((r, i) =>
    `${i + 1}. ${r.name ? `**${r.name}**` : `<@&${r.roleId}>`} — \`${E.permissionCount(r.permissions)}\` permission(s) verrouillée(s)`);
  const trustedLines = cfg.trustedRoles.map(id => `<@&${id}>`);
  const incidentLines = (cfg.incidents || []).slice(-3).reverse().map(E.formatIncident);

  const integrity = [
    ...audit.problems.map(p => `⛔ ${p}`),
    ...audit.warnings.map(w => `ℹ️ ${w}`),
  ];

  const embed = new EmbedBuilder()
    .setColor(audit.problems.length ? COLORS.error : cfg.enabled ? COLORS.success : COLORS.warning)
    .setTitle('🗄️ Coffre-fort de permissions')
    .setDescription(
      'L\'anti-nuke voit ce qui **détruit** ; le coffre voit ce qui **ouvre**.\n' +
      'Il mémorise l\'accès attendu de salons sensibles et les permissions de rôles sensibles, ' +
      'puis détecte toute ouverture silencieuse via le journal d\'audit (nom, rôle, @everyone) — ' +
      'et la referme en mode `revert`.',
    )
    .addFields(
      { name: 'Statut', value: cfg.enabled ? '🟢 Actif' : '🔴 Désactivé', inline: true },
      { name: 'Mode', value: E.describeMode(cfg.mode), inline: true },
      { name: 'Salon de logs', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '*Non défini*', inline: true },
      { name: 'Réparations', value: `\`${stats.reverted || 0}\``, inline: true },
      { name: 'Alertes', value: `\`${stats.alerts || 0}\``, inline: true },
      { name: 'Modifs autorisées', value: `\`${stats.trusted || 0}\``, inline: true },
      { name: `🔒 Salons protégés (${cfg.protectedChannels.length}/${E.MAX_CHANNELS})`,
        value: channelLines.length ? channelLines.join('\n').slice(0, 1024) : '*Aucun — le coffre ne surveille aucun salon*', inline: false },
      { name: `🎭 Rôles verrouillés (${cfg.protectedRoles.length}/${E.MAX_ROLES})`,
        value: roleLines.length ? roleLines.join('\n').slice(0, 1024) : '*Aucun*', inline: false },
      { name: `✅ Rôles de confiance (${cfg.trustedRoles.length})`,
        value: trustedLines.length ? trustedLines.join(' ').slice(0, 1024) : '*Aucun — seuls le propriétaire et le bot sont de confiance*', inline: false },
      { name: '🕓 Derniers incidents',
        value: incidentLines.length ? incidentLines.join('\n').slice(0, 1024) : '*Aucun incident enregistré*', inline: false },
      { name: '🧪 État du coffre',
        value: integrity.length ? integrity.join('\n').slice(0, 1024) : '🔒 Aucune faille détectée.', inline: false },
    )
    .setFooter({ text: 'REZO • Sécurité · Coffre-fort de permissions' })
    .setTimestamp();

  return embed;
}

// ── Composants ───────────────────────────────────────────────────────────────
// Les protections peuvent dépasser 25 entrées (25 salons + 15 rôles + 15
// confiances) : un seul menu tronquerait la liste et rendrait certaines cibles
// impossibles à retirer. On passe donc par un choix de groupe, puis une liste.
function removalGroups(cfg) {
  const groups = [];
  if (cfg.protectedChannels.length) {
    groups.push({ label: `🔒 Salons protégés (${cfg.protectedChannels.length})`, value: 'grp:chan', description: 'Retirer un salon de la surveillance' });
  }
  if (cfg.protectedRoles.length) {
    groups.push({ label: `🎭 Rôles verrouillés (${cfg.protectedRoles.length})`, value: 'grp:role', description: 'Déverrouiller les permissions d\'un rôle' });
  }
  if (cfg.trustedRoles.length) {
    groups.push({ label: `✅ Rôles de confiance (${cfg.trustedRoles.length})`, value: 'grp:trust', description: 'Retirer un rôle de la liste de confiance' });
  }
  return groups;
}

function removalItems(cfg, group, guild = null) {
  const roleName = id => {
    const cached = guild?.roles?.cache?.get?.(id);
    return (cached && cached.name) || id;
  };
  if (group === 'chan') {
    return cfg.protectedChannels.map(c => ({
      label: `Salon · ${String(c.name || c.channelId).slice(0, 60)}`,
      value: `chan:${c.channelId}`,
      description: 'Retirer la protection de ce salon',
    }));
  }
  if (group === 'role') {
    return cfg.protectedRoles.map(r => ({
      label: `Rôle · ${String(r.name || r.roleId).slice(0, 60)}`,
      value: `role:${r.roleId}`,
      description: 'Déverrouiller les permissions de ce rôle',
    }));
  }
  if (group === 'trust') {
    return cfg.trustedRoles.map(id => ({
      label: `Confiance · ${String(roleName(id)).slice(0, 60)}`,
      value: `trust:${id}`,
      description: 'Retirer ce rôle de la liste de confiance',
    }));
  }
  return [];
}

function buildVaultComponents(cfg, guild = null) {
  V.ensureShape(cfg);
  const rows = [];

  const toggle = new ButtonBuilder()
    .setCustomId('sec_vault_toggle')
    .setLabel(cfg.enabled ? '🔴 Désactiver' : '🟢 Activer')
    .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success);
  const mode = new ButtonBuilder()
    .setCustomId('sec_vault_mode')
    .setLabel(cfg.mode === 'revert' ? '🔒 Refermer' : '⚠️ Alerter')
    .setStyle(cfg.mode === 'revert' ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const verify = new ButtonBuilder()
    .setCustomId('sec_vault_verify')
    .setLabel('🔍 Vérifier maintenant')
    .setStyle(ButtonStyle.Secondary);
  const logs = new ButtonBuilder()
    .setCustomId('sec_vault_logs')
    .setLabel('📋 Salon de logs')
    .setStyle(ButtonStyle.Secondary);
  const back = new ButtonBuilder()
    .setCustomId('sec_back')
    .setLabel('↩️ Retour')
    .setStyle(ButtonStyle.Secondary);
  rows.push(new ActionRowBuilder().addComponents(toggle, mode, verify, logs, back));

  rows.push(new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('sec_vault_add_chan')
      .setPlaceholder('🔒 Protéger un salon (capture l\'accès actuel)…')
      .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.GuildCategory)
      .setMaxValues(1),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('sec_vault_add_role')
      .setPlaceholder('🎭 Verrouiller les permissions d\'un rôle…')
      .setMaxValues(1),
  ));

  rows.push(new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('sec_vault_trust_role')
      .setPlaceholder('✅ Ajouter un rôle de confiance…')
      .setMaxValues(1),
  ));

  const groups = removalGroups(cfg);
  if (groups.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('sec_vault_remove')
        .setPlaceholder('🗑️ Retirer une protection…')
        .addOptions(groups),
    ));
  }

  return rows;
}

function vaultView(cfg, guild = null) {
  return { embeds: [buildVaultEmbed(cfg, guild)], components: buildVaultComponents(cfg, guild) };
}

// ── Interactions ─────────────────────────────────────────────────────────────
async function notify(i, content) {
  if (i.replied || i.deferred) {
    return i.followUp({ content, ephemeral: true }).catch(() => null);
  }
  return i.reply({ content, ephemeral: true }).catch(() => null);
}

async function respondVault(i, cfg, guild) {
  const view = vaultView(cfg, guild);
  // Déjà répondu (prompt éphémère) → on met à jour le panneau lui-même.
  if (i.replied || i.deferred) {
    if (i.message && typeof i.message.edit === 'function') {
      return i.message.edit(view).catch(() => null);
    }
    return null;
  }
  return i.update(view).catch(() => null);
}

function verifySummary(result) {
  if (!result || result.checked === 0) return 'Aucune cible protégée : ajoute au moins un salon ou un rôle.';
  const parts = [`**${result.checked}** cible(s) vérifiée(s)`];
  if (result.drifted) parts.push(`**${result.drifted}** écart(s) détecté(s)`);
  if (result.reverted) parts.push(`**${result.reverted}** refermé(s)`);
  if (result.missing) parts.push(`**${result.missing}** cible(s) disparue(s)`);
  if (!result.drifted) parts.push('aucun écart — le coffre est étanche ✅');
  return parts.join(' · ');
}

function reasonText(reason, limit) {
  switch (reason) {
    case 'channel_not_found': return '⛔ Salon introuvable sur le serveur.';
    case 'role_not_found':    return '⛔ Rôle introuvable sur le serveur.';
    case 'everyone':          return '⛔ @everyone est porté par tous les membres : il ne peut jamais servir ici.';
    case 'limit':             return `⛔ Limite atteinte (${limit}). Retire une cible avant d'en ajouter une.`;
    case 'no_targets':        return '⛔ Impossible d\'activer le coffre sans au moins **un salon protégé ou un rôle verrouillé**.';
    default:                  return '⛔ Opération refusée.';
  }
}

async function openLogPrompt(i, cfg, guild) {
  if (!i.channel || typeof i.channel.awaitMessageComponent !== 'function') {
    return notify(i, '⛔ Impossible d\'ouvrir le sélecteur de salon ici.');
  }

  const menu = new ChannelSelectMenuBuilder()
    .setCustomId('sec_vault_log_pick')
    .setPlaceholder('📋 Choisir le salon de logs du coffre…')
    .setChannelTypes(ChannelType.GuildText)
    .setMaxValues(1);
  const clear = new ButtonBuilder()
    .setCustomId('sec_vault_log_clear')
    .setLabel('🗑️ Aucun salon')
    .setStyle(ButtonStyle.Danger);

  await i.reply({
    content: '📋 Choisis le salon où le coffre signale chaque tentative (ou retire-le).',
    components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(clear)],
    ephemeral: true,
  }).catch(() => null);

  const sel = await i.channel.awaitMessageComponent({
    filter: s => s.user?.id === i.user?.id && ['sec_vault_log_pick', 'sec_vault_log_clear'].includes(s.customId),
    time: 30_000,
  }).catch(() => null);

  if (!sel) return null;

  if (sel.customId === 'sec_vault_log_clear') {
    await V.setLogChannel(cfg, null);
    await sel.update({ content: '🗑️ Salon de logs retiré : les incidents seront signalés en console.', components: [] }).catch(() => null);
  } else {
    await V.setLogChannel(cfg, sel.values?.[0] || null);
    await sel.update({ content: `✅ Salon de logs enregistré : <#${sel.values?.[0]}>.`, components: [] }).catch(() => null);
  }

  await i.deleteReply().catch(() => null);
  return respondVault(i, cfg, guild);
}

/**
 * Traite une interaction du panneau coffre-fort.
 * @returns {boolean} true si l'interaction appartenait au coffre
 */
async function openRemovePrompt(i, cfg, guild, group, items) {
  if (!i.channel || typeof i.channel.awaitMessageComponent !== 'function') {
    return notify(i, '⛔ Impossible d\'ouvrir le sélecteur ici.');
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('sec_vault_remove_pick')
    .setPlaceholder('🗑️ Choisir la protection à retirer…')
    .addOptions(items.slice(0, 25));

  await i.reply({
    content: '🗑️ Sélectionne la protection à retirer. Le coffre recapturera la référence à la prochaine protection.',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  }).catch(() => null);

  const sel = await i.channel.awaitMessageComponent({
    filter: s => s.user?.id === i.user?.id && s.customId === 'sec_vault_remove_pick',
    time: 30_000,
  }).catch(() => null);

  if (!sel) return null;

  const raw = String(sel.values?.[0] || '');
  const sep = raw.indexOf(':');
  const kind = sep === -1 ? '' : raw.slice(0, sep);
  const target = sep === -1 ? '' : raw.slice(sep + 1);
  if (kind === 'chan') await V.unprotectChannel(cfg, target);
  else if (kind === 'role') await V.unprotectRole(cfg, target);
  else if (kind === 'trust') await V.removeTrustedRole(cfg, target);

  await sel.update({ content: '🗑️ Protection retirée.', components: [] }).catch(() => null);
  await i.deleteReply().catch(() => null);
  return respondVault(i, cfg, guild);
}

async function handleVaultComponent(i, { guild, cfg }) {
  const id = i?.customId || '';
  if (!id.startsWith('sec_vault_')) return false;
  if (!cfg) return true;
  V.ensureShape(cfg);

  switch (id) {
    case 'sec_vault_toggle': {
      const res = await V.setEnabled(cfg, !cfg.enabled);
      if (!res.ok) { await notify(i, reasonText(res.reason, res.limit)); return true; }
      await respondVault(i, cfg, guild);
      return true;
    }

    case 'sec_vault_mode': {
      await V.setMode(cfg, cfg.mode === 'revert' ? 'alert' : 'revert');
      await respondVault(i, cfg, guild);
      return true;
    }

    case 'sec_vault_verify': {
      if (!cfg.enabled) {
        await notify(i, '⛔ Le coffre est désactivé : active-le avant de lancer une vérification.');
        return true;
      }
      const result = await V.verifyAll(guild, cfg, { clientId: guild?.client?.user?.id || null, source: 'manual', attribute: false });
      await respondVault(i, cfg, guild);
      const summary = verifySummary(result);
      if (i.replied || i.deferred) await i.followUp({ content: `🔍 ${summary}`, ephemeral: true }).catch(() => null);
      return true;
    }

    case 'sec_vault_add_chan': {
      const res = await V.protectChannel(cfg, guild, i.values?.[0]);
      if (!res.ok) { await notify(i, reasonText(res.reason, res.limit)); return true; }
      await respondVault(i, cfg, guild);
      return true;
    }

    case 'sec_vault_add_role': {
      const res = await V.protectRole(cfg, guild, i.values?.[0]);
      if (!res.ok) { await notify(i, reasonText(res.reason, res.limit)); return true; }
      await respondVault(i, cfg, guild);
      return true;
    }

    case 'sec_vault_trust_role': {
      const res = await V.addTrustedRole(cfg, guild, i.values?.[0]);
      if (!res.ok) { await notify(i, reasonText(res.reason, res.limit)); return true; }
      await respondVault(i, cfg, guild);
      return true;
    }

    case 'sec_vault_remove': {
      const group = String(i.values?.[0] || '').split(':')[1];
      const items = removalItems(cfg, group, guild);
      if (!items.length) { await notify(i, '⛔ Ce groupe est vide.'); return true; }
      await openRemovePrompt(i, cfg, guild, group, items);
      return true;
    }

    case 'sec_vault_logs': {
      await openLogPrompt(i, cfg, guild);
      return true;
    }

    default:
      return true;
  }
}

module.exports = {
  buildVaultEmbed,
  buildVaultComponents,
  vaultView,
  handleVaultComponent,
  removalGroups,
  removalItems,
  verifySummary,
  reasonText,
};
