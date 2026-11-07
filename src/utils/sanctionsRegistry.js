'use strict';
// utils/sanctionsRegistry.js — Registre des sanctions OFFICIELLES de Discord.
//
// Ce que « officiel » veut dire, très exactement :
//   • la **liste des bannissements** d'un serveur (`guild.bans.fetch()`) : c'est
//     Discord qui la tient, pas le bot. Elle survit à une réinstallation, elle
//     contient les bans posés par n'importe quel bot ou par un humain, et elle
//     porte la raison telle qu'elle a été écrite ;
//   • le **journal d'audit** (`BanAdd`, `Kick`, `MemberDisconnect`…) qui ajoute
//     ce que la liste ne donne pas : QUI a sanctionné et QUAND ;
//   • l'**exclusion temporaire en cours** d'un membre
//     (`communicationDisabledUntil`), lue en direct.
//
// Ce que ce module NE prétend PAS faire : lire les sanctions Trust & Safety de
// Discord (« Account Standing » : contenu supprimé, compte suspendu…). Elles ne
// sont exposées par AUCUNE API — seul le titulaire du compte les voit, dans son
// client, et un bot ne peut les obtenir qu'en se faisant passer pour lui, ce qui
// est interdit. Les deviner (scraping, endpoint interne) reviendrait à afficher
// une donnée non vérifiable comme si elle était officielle : on ne le fait pas.
//
// Le module est séparé en deux étages :
//   1. des fonctions PURES (normalisation, filtre, pagination, rendu) — elles se
//      testent sans Discord ni base ;
//   2. un étage d'entrée/sortie (`fetchSnapshot`) isolé, mis en cache borné pour
//      qu'une pagination ne relance pas un `bans.fetch()` à chaque clic.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AuditLogEvent,
} = require('discord.js');
const { COLORS } = require('./embeds');
const { createBoundedCache } = require('./boundedCache');
const brand = require('./brand');

const PAGE_SIZE = 8;          // lignes lisibles par page sans mur de texte
const FILTER_MAX = 48;        // au-delà, l'identifiant de bouton deviendrait trop long
const REASON_MAX = 140;       // troncature d'affichage (la vraie raison reste en export)
const SNAPSHOT_TTL = 45_000;  // 45 s : la liste ne change pas assez vite pour justifier plus

// Les identifiants de boutons doivent tenir en 100 caractères. Le filtre voyage
// donc encodé en base64url (aucun caractère réservé) plutôt que dans une Map
// mémoire : les boutons restent ainsi valides après un redémarrage du bot.
const ID = {
  page: 'sanc_p',
  filter: 'sanc_f',
  member: 'sanc_u',
  export: 'sanc_e',
  refresh: 'sanc_r',
  unban: 'sanc_unban',
  modalFilter: 'sancm_filter',
  modalMember: 'sancm_member',
};

const AUDIT_LABELS = {
  [AuditLogEvent?.BanAdd ?? 22]: '🔨 Bannissement',
  [AuditLogEvent?.BanRemove ?? 23]: '✅ Débannissement',
  [AuditLogEvent?.Kick ?? 20]: '👋 Expulsion',
  [AuditLogEvent?.MemberDisconnect ?? 27]: '🔌 Déconnexion vocale',
  [AuditLogEvent?.MemberRoleUpdate ?? 25]: '🎭 Rôles modifiés',
};

// ─── Texte ──────────────────────────────────────────────────────────────────

/** Minuscules sans accents : « Kévin » et « kevin » se cherchent pareil. */
function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Coupe proprement sans dépasser `max` caractères. */
function truncate(text, max = REASON_MAX) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** « 2 j 3 h », « 42 min », « 18 s ». */
function formatDuration(ms) {
  const total = Math.max(0, Math.trunc(Number(ms) || 0));
  const days = Math.floor(total / 86_400_000);
  const hours = Math.floor((total % 86_400_000) / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  if (days) return `${days} j ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return `${minutes} min${seconds ? ` ${seconds} s` : ''}`;
  return `${seconds} s`;
}

/** Horodatage Discord relatif, ou « — » quand la date manque. */
function relativeStamp(ts) {
  const value = Number(ts) || 0;
  if (!value) return '—';
  return `<t:${Math.floor(value / 1000)}:R>`;
}

// ─── Filtre (transporté dans les identifiants de boutons) ───────────────────

// Plafond en OCTETS, pas en caractères : un filtre d’emojis pèse 4 octets par
// caractère et ferait exploser l’identifiant de bouton (limite Discord : 100).
const FILTER_BYTES = 45;      // → 60 caractères en base64url

function encodeFilter(text) {
  let source = String(text ?? '').trim().slice(0, FILTER_MAX);
  if (!source) return '-';
  while (source.length && Buffer.byteLength(source, 'utf8') > FILTER_BYTES) {
    source = source.slice(0, -1);
  }
  if (!source) return '-';
  return Buffer.from(source, 'utf8').toString('base64url');
}

/**
 * Filtre tel qu'il sera RÉELLEMENT appliqué — et tel qu'il est affiché.
 * Passer par l'encodage de bouton garantit que la page 2 filtre exactement
 * comme la page 1 : on n'affiche jamais un filtre qu'on ne transporte pas.
 */
function normalizeFilter(text) {
  return decodeFilter(encodeFilter(text));
}

function decodeFilter(token) {
  if (!token || token === '-') return '';
  try {
    return Buffer.from(String(token), 'base64url').toString('utf8').slice(0, FILTER_MAX);
  } catch {
    return '';
  }
}


// ─── Normalisation d'un bannissement ────────────────────────────────────────

/**
 * Transforme un `GuildBan` Discord en entrée d'affichage.
 * @param {object} ban
 * @param {Map<string, object>} [auditMap] résultat de `indexAudit`
 */
function buildEntry(ban, auditMap = new Map()) {
  const user = ban?.user || {};
  const id = user.id || (typeof ban?.userId === 'string' ? ban.userId : '') || '';
  const tag = user.tag || user.username || id || 'Inconnu';
  const reason = typeof ban?.reason === 'string' && ban.reason.trim() ? ban.reason.trim() : null;
  const audit = auditMap.get(id) || null;

  return {
    id,
    tag,
    username: user.username || tag,
    displayName: user.globalName || user.displayName || user.username || tag,
    avatar: typeof user.displayAvatarURL === 'function'
      ? user.displayAvatarURL({ extension: 'png', size: 128 })
      : null,
    reason,
    moderatorId: audit?.executorId || null,
    at: Number(audit?.createdTimestamp) || null,
  };
}

/**
 * Ne garde que le bannissement le PLUS RÉCENT par utilisateur.
 * Le journal d'audit est paginé du plus récent au plus ancien : la première
 * occurrence rencontrée est donc la bonne.
 */
function indexAudit(entries) {
  const banAdd = AuditLogEvent?.BanAdd ?? 22;
  const map = new Map();
  for (const entry of entries || []) {
    if (!entry || entry.action !== banAdd) continue;
    const targetId = entry.targetId || entry.target?.id;
    if (!targetId || map.has(targetId)) continue;
    map.set(targetId, entry);
  }
  return map;
}

/**
 * Filtre une liste d'entrées. Chaque mot saisi doit apparaître (pseudo,
 * identifiant ou raison) — donc « kevin spam » retrouve « Kévin » banni pour
 * spam, dans n'importe quel ordre.
 */
function filterEntries(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const needle = normalizeText(query);
  if (!needle) return list;

  const tokens = needle.split(/\s+/).filter(Boolean);
  return list.filter(entry => {
    const haystack = normalizeText([
      entry?.tag,
      entry?.displayName,
      entry?.username,
      entry?.id,
      entry?.reason || '',
    ].join(' '));
    return tokens.every(token => haystack.includes(token));
  });
}

// ─── Pagination ─────────────────────────────────────────────────────────────

/**
 * Découpe une liste et borne la page demandée. Une page hors limites est
 * ramenée dans l'intervalle : un vieux bouton ne produit jamais un écran vide.
 */
function paginate(list, page = 1, perPage = PAGE_SIZE) {
  const items = Array.isArray(list) ? list : [];
  const size = Math.max(1, Math.trunc(perPage) || PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const requested = Math.trunc(Number(page)) || 1;
  const current = Math.min(Math.max(1, requested), pages);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);

  return {
    items: slice,
    page: current,
    pages,
    total: items.length,
    size,
    start,
    end: start + slice.length,
    hasPrev: current > 1,
    hasNext: current < pages,
  };
}

// ─── Exclusions temporaires ─────────────────────────────────────────────────

/** Durée restante d'un timeout, ou `null` s'il n'y en a pas / s'il est fini. */
function describeTimeout(until, now = Date.now()) {
  const timestamp = Number(until) || 0;
  if (!timestamp) return null;
  const left = timestamp - now;
  if (left <= 0) return null;
  return { remaining: left, label: formatDuration(left), until: timestamp };
}

// ─── Lecture Discord (isolée, mise en cache) ────────────────────────────────

const snapshotCache = createBoundedCache({ max: 500, ttl: SNAPSHOT_TTL, name: 'sanctions' });

function errorCode(error) {
  const code = Number(error?.code) || 0;
  if (code === 50013 || code === 50001) return 'forbidden';
  if (code === 10004 || code === 10013) return 'unknown-guild';
  return 'failed';
}

/** Corrèle les bannissements avec le journal d'audit (auteur + date). */
async function fetchAuditMap(guild) {
  if (typeof guild?.fetchAuditLogs !== 'function') return new Map();
  try {
    const logs = await guild.fetchAuditLogs({ limit: 100 });
    const values = logs?.entries?.values ? [...logs.entries.values()] : [];
    return indexAudit(values);
  } catch {
    // Sans « Voir les logs d'audit », la liste reste utilisable : on perd juste
    // l'auteur et la date. Ce n'est pas une raison de refuser le service.
    return new Map();
  }
}

/**
 * Photo complète des bannissements d'un serveur.
 * @returns {Promise<{ok:boolean, entries?:object[], fetchedAt?:number, code?:string}>}
 */
async function fetchSnapshot(guild, { force = false } = {}) {
  if (!guild?.id) return { ok: false, code: 'no-guild' };
  if (!force) {
    const cached = snapshotCache.get(guild.id);
    if (cached) return cached;
  }

  let collection;
  try {
    collection = await guild.bans.fetch();
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }

  const auditMap = await fetchAuditMap(guild);
  const source = collection?.values ? [...collection.values()] : [];
  const entries = source.map(ban => buildEntry(ban, auditMap));

  // Les plus récents d'abord (date d'audit quand on l'a), puis alphabétique :
  // l'ordre ne « saute » donc pas d'un rafraîchissement à l'autre.
  entries.sort((a, b) => (b.at || 0) - (a.at || 0) || a.tag.localeCompare(b.tag));

  const snapshot = { ok: true, entries, fetchedAt: Date.now() };
  snapshotCache.set(guild.id, snapshot);
  return snapshot;
}

/**
 * Historique d'audit d'UN membre (bans, kicks, déconnexions…).
 * @returns {Promise<Array<{action:number, label:string, moderatorId:string|null, at:number|null, reason:string|null}>>}
 */
async function fetchUserHistory(guild, userId, { limit = 50 } = {}) {
  if (!guild?.id || !userId || typeof guild.fetchAuditLogs !== 'function') return [];
  try {
    const logs = await guild.fetchAuditLogs({ limit });
    const values = logs?.entries?.values ? [...logs.entries.values()] : [];
    return values
      .filter(entry => (entry?.targetId || entry?.target?.id) === userId)
      .map(entry => ({
        action: entry.action,
        label: AUDIT_LABELS[entry.action] || '📋 Action',
        moderatorId: entry.executorId || null,
        at: Number(entry.createdTimestamp) || null,
        reason: typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : null,
      }))
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  } catch {
    return [];
  }
}

// ─── Rendu : liste ─────────────────────────────────────────────────────────

/**
 * Embed de la liste paginée.
 * @param {object} view
 * @param {string} view.guildName
 * @param {object} view.page     résultat de `paginate`
 * @param {string} [view.filter]
 * @param {number} [view.fetchedAt]
 */
function buildListEmbed({ guildName = 'ce serveur', page, filter = '', fetchedAt = null } = {}) {
  const view = page || paginate([]);
  const embed = new EmbedBuilder()
    .setColor(view.total ? COLORS.warning : COLORS.success)
    .setAuthor({ name: `🔨 Sanctions officielles Discord — ${guildName}` })
    .setTitle(`${view.total} bannissement${view.total > 1 ? 's' : ''} enregistré${view.total > 1 ? 's' : ''} par Discord`)
    .setThumbnail(view.items[0]?.avatar || null);

  if (!view.total) {
    embed.setDescription(filter
      ? `Aucun bannissement ne correspond à **« ${truncate(filter, 60)} »**.\n\n-# Le filtre est actif : utilise **🔄 Filtrer** puis valide une recherche vide pour revoir toute la liste.`
      : `Aucun membre n'est banni sur **${guildName}**.\n\n-# La liste vient directement de Discord : elle reste juste même si un autre bot a posé le ban.`);
  } else {
    const lines = [
      `-# Lecture directe de la liste tenue par Discord — rien n'est recopié par le bot.`,
      '',
    ];

    view.items.forEach((entry, index) => {
      const position = view.start + index + 1;
      const reason = entry.reason ? truncate(entry.reason) : '*aucune raison enregistrée*';
      lines.push(`**${position}.** <@${entry.id}> · \`${truncate(entry.tag, 32)}\``);
      lines.push(`› ${reason}`);
      lines.push(entry.moderatorId
        ? `› sanctionné par <@${entry.moderatorId}> ${relativeStamp(entry.at)}`
        : '› auteur non retrouvé dans le journal d’audit');
      lines.push('');
    });

    embed.setDescription(lines.join('\n').slice(0, 4096));
  }

  const scope = view.total ? ` • ${view.start + 1}–${view.end} sur ${view.total}` : '';
  const filtered = filter ? ` • filtre « ${truncate(filter, 24)} »` : '';
  const freshness = fetchedAt ? ` • lu ${relativeStamp(fetchedAt)}` : '';
  embed.setFooter({ text: brand.footer(`page ${view.page}/${view.pages}${scope}${filtered}${freshness}`) });

  return brand.applyBrand(embed);
}

/** Rangée de pagination + rangée d'outils. */
function buildListComponents({ page, filter = '' } = {}) {
  const view = page || paginate([]);
  const enc = encodeFilter(filter);

  // Le dernier segment (la direction) ne sert qu'à rendre les identifiants
  // UNIQUES : sur la page 1, « premier » et « précédent » visent la même page.
  // Deux boutons au même `custom_id` dans un message sont ambigus à déboguer.
  const pagination = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID.page}:1:${enc}:first`)
      .setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(!view.hasPrev),
    new ButtonBuilder().setCustomId(`${ID.page}:${Math.max(1, view.page - 1)}:${enc}:prev`)
      .setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(!view.hasPrev),
    new ButtonBuilder().setCustomId(`${ID.page}:${Math.min(view.pages, view.page + 1)}:${enc}:next`)
      .setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(!view.hasNext),
    new ButtonBuilder().setCustomId(`${ID.page}:${view.pages}:${enc}:last`)
      .setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(!view.hasNext),
  );

  const tools = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${ID.filter}:${enc}`)
      .setLabel('Filtrer').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID.member}:-`)
      .setLabel('Un membre').setEmoji('👤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID.export}:${enc}`)
      .setLabel('Exporter').setEmoji('📄').setStyle(ButtonStyle.Secondary).setDisabled(!view.total),
    new ButtonBuilder().setCustomId(`${ID.refresh}:${enc}`)
      .setLabel('Rafraîchir').setEmoji('🔄').setStyle(ButtonStyle.Success),
  );

  return [pagination, tools];
}

// ─── Rendu : fiche d'un membre ─────────────────────────────────────────────

/**
 * Fiche « situation » d'un membre : bannissement officiel, timeout en cours,
 * avertissements du bot et historique du journal d'audit.
 */
function buildMemberEmbed({
  guildName = 'ce serveur',
  user = null,
  member = null,
  ban = null,
  timeout = null,
  warns = 0,
  history = [],
  filterHint = '',
} = {}) {
  const id = user?.id || ban?.id || member?.id || '';
  const name = user?.displayName || user?.username || ban?.displayName || ban?.tag || id;

  const embed = new EmbedBuilder()
    .setColor(ban ? COLORS.error : timeout ? COLORS.warning : COLORS.success)
    .setAuthor({ name: `⚖️ Situation de ${name} — ${guildName}` })
    .setDescription(`<@${id}> · \`${id}\`\n-# Bannissement et exclusion temporaire viennent de Discord ; les avertissements viennent de ce bot.`)
    .setThumbnail(user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || ban?.avatar || null);

  embed.addFields({
    name: '🔨 Bannissement',
    value: ban
      ? [
        `**Banni**${ban.at ? ` ${relativeStamp(ban.at)}` : ''}`,
        `**Raison** : ${ban.reason ? truncate(ban.reason, 300) : '*aucune raison enregistrée*'}`,
        ban.moderatorId ? `**Par** : <@${ban.moderatorId}>` : '**Par** : *non retrouvé dans le journal d’audit*',
      ].join('\n')
      : '**Non banni** sur ce serveur.',
    inline: false,
  });

  embed.addFields({
    name: '⏱️ Exclusion temporaire',
    value: timeout
      ? `**${timeout.label} restantes** — jusqu’à ${relativeStamp(timeout.until)}`
      : 'Aucune exclusion temporaire en cours.',
    inline: true,
  });

  embed.addFields({
    name: '⚠️ Avertissements (bot)',
    value: `**${Number(warns) || 0}** au total`,
    inline: true,
  });

  embed.addFields({
    name: '📅 Compte',
    value: [
      user?.createdTimestamp ? `**Créé** ${relativeStamp(user.createdTimestamp)}` : null,
      member?.joinedTimestamp ? `**Arrivé** ${relativeStamp(member.joinedTimestamp)}` : '**Arrivé** : *absent du serveur*',
    ].filter(Boolean).join('\n'),
    inline: true,
  });

  const recent = (history || []).slice(0, 5);
  embed.addFields({
    name: `🧾 Historique officiel${history?.length > 5 ? ` (${history.length})` : ''}`,
    value: recent.length
      ? recent.map(item => `${item.label} · ${relativeStamp(item.at)}${item.moderatorId ? ` · <@${item.moderatorId}>` : ''}`).join('\n')
      : 'Aucune entrée dans le journal d’audit (ou accès aux logs manquant).',
    inline: false,
  });

  embed.setFooter({ text: brand.footer(`sanctions Discord${filterHint ? ` • ${filterHint}` : ''}`) });
  return brand.applyBrand(embed);
}

/** Boutons de la fiche : débannir si besoin, rafraîchir, revenir à la liste. */
function buildMemberComponents({ userId, banned = false, filter = '' } = {}) {
  const enc = encodeFilter(filter);
  const row = new ActionRowBuilder();

  if (banned) {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`${ID.unban}:${userId}`)
      .setLabel('Débannir').setEmoji('✅').setStyle(ButtonStyle.Danger));
  }

  row.addComponents(
    new ButtonBuilder().setCustomId(`${ID.member}:${userId}`)
      .setLabel('Actualiser').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${ID.page}:1:${enc}:back`)
      .setLabel('Liste').setEmoji('📋').setStyle(ButtonStyle.Primary),
  );

  return [row];
}

// ─── Rendu : modaux ─────────────────────────────────────────────────────────

function buildFilterModal({ filter = '' } = {}) {
  const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
  const modal = new ModalBuilder()
    .setCustomId(ID.modalFilter)
    .setTitle('🔎 Filtrer les bannissements');

  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('q')
      .setLabel('Pseudo, identifiant ou motif (vide = tout)').setStyle(TextInputStyle.Short)
      .setRequired(false).setMaxLength(FILTER_MAX).setValue(String(filter || '').slice(0, FILTER_MAX)),
  ));

  return modal;
}

function buildMemberModal() {
  const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
  const modal = new ModalBuilder()
    .setCustomId(ID.modalMember)
    .setTitle('👤 Situation d’un membre');

  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('member').setLabel('Identifiant Discord ou mention')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30),
  ));

  return modal;
}

// ─── Export ────────────────────────────────────────────────────────────────

/** Texte brut prêt à coller (rapport, dossier de plainte, ticket staff). */
function buildExport(entries, { guildName = 'ce serveur', filter = '', now = Date.now() } = {}) {
  const lines = [
    `Bannissements Discord — ${guildName}`,
    `Exporté le ${new Date(now).toISOString()}`,
    `Total : ${(entries || []).length}${filter ? ` (filtre « ${filter} »)` : ''}`,
    'Source : liste des bannissements de l’API Discord + journal d’audit.',
    ''.padEnd(60, '-'),
  ];

  (entries || []).forEach((entry, index) => {
    const date = entry.at ? new Date(entry.at).toISOString() : 'date inconnue';
    const reason = entry.reason || 'aucune raison';
    const by = entry.moderatorId ? `par ${entry.moderatorId}` : 'auteur inconnu';
    lines.push(`${index + 1}. ${entry.tag} (${entry.id}) — ${date} — ${by} — ${reason}`);
  });

  if (!(entries || []).length) lines.push('Aucun bannissement.');
  return lines.join('\n');
}

module.exports = {
  PAGE_SIZE,
  FILTER_MAX,
  REASON_MAX,
  SNAPSHOT_TTL,
  ID,
  AUDIT_LABELS,
  normalizeText,
  truncate,
  formatDuration,
  relativeStamp,
  encodeFilter,
  decodeFilter,
  normalizeFilter,
  FILTER_BYTES,
  buildEntry,
  indexAudit,
  filterEntries,
  paginate,
  describeTimeout,
  errorCode,
  fetchAuditMap,
  fetchSnapshot,
  fetchUserHistory,
  snapshotCache,
  buildListEmbed,
  buildListComponents,
  buildMemberEmbed,
  buildMemberComponents,
  buildFilterModal,
  buildMemberModal,
  buildExport,
  brand,
};
