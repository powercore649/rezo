// utils/treasurePanel.js — Panneau du module Trésors cachés (/tresor).
//
// Module PUREMENT fonctionnel : il construit les payloads (embed + composants)
// et calcule les modifications à appliquer. La commande se charge de lire et
// d'écrire en base, de lancer un coffre et de régénérer l'aperçu — ce qui rend
// le panneau testable sans Discord ni MongoDB.
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder, ChannelType,
} = require('discord.js');
const { COLORS } = require('./embeds');
const {
  RARITY_ORDER, RARITY_LABEL, RARITY_EMOJI,
  wordsFor, parseCustomWord, normalizeGuess, DEFAULT_WORDS,
} = require('./treasureWords');

const PREFIX = 'trs';

// Valeurs d'usine : sert à la fois de repli et de cible au bouton Réinitialiser.
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  channels: [],
  announceChannelId: null,
  minDelayMinutes: 60,
  maxDelayMinutes: 180,
  lifetimeSeconds: 600,
  clueIntervalSeconds: 90,
  useCard: true,
  hintOnWrongGuess: false,
  rewardXpMin: 150,
  rewardXpMax: 400,
  rewardCoinsMin: 100,
  rewardCoinsMax: 300,
  xpMultiplier: 1,
  coinsMultiplier: 1,
  legendaryRoleId: null,
  odds: { common: 60, rare: 30, legendary: 10 },
  customWords: [],
});

const PANEL_PAGES = {
  home:     { label: '🎁 Vue d\'ensemble', hint: 'Tout ce qui compte en un coup d\'œil.' },
  channels: { label: '💬 Salons', hint: 'Où les coffres apparaissent et où on annonce les gains.' },
  timing:   { label: '⏱️ Rythme', hint: 'Fréquence des coffres, durée de vie, indices.' },
  rewards:  { label: '🎁 Récompenses', hint: 'XP, pièces, rôle bonus des légendaires.' },
  odds:     { label: '🎲 Raretés', hint: 'Probabilité de chaque rareté.' },
  words:    { label: '🧩 Mots & indices', hint: 'Banque de mots et mots personnalisés.' },
  hunters:  { label: '🏆 Chasseurs', hint: 'Classement et remise à zéro.' },
};

const PAGE_OF_KEY = {
  btn_page_channels: 'channels', btn_page_timing: 'timing', btn_page_rewards: 'rewards',
  btn_page_odds: 'odds', btn_page_words: 'words', btn_page_hunters: 'hunters', btn_back: 'home',
  sel_channel_add: 'channels', sel_channel_remove: 'channels', sel_announce: 'channels',
  btn_lifetime: 'timing', btn_delays: 'timing', btn_clue_interval: 'timing',
  btn_reward_xp: 'rewards', btn_reward_coins: 'rewards', btn_multipliers: 'rewards', sel_legendary_role: 'rewards',
  btn_odds: 'odds',
  btn_word_add: 'words', sel_word_remove: 'words',
  btn_publish_board: 'hunters', sel_reset_hunter: 'hunters', btn_reset_hunter: 'hunters',
  lifetime: 'timing', delays: 'timing', clueInterval: 'timing',
  rewardsXp: 'rewards', rewardsCoins: 'rewards', multipliers: 'rewards',
  odds: 'odds', addWord: 'words',
  btn_toggle: 'home', btn_spawn: 'home', btn_close: 'home',
  btn_card: 'home', btn_hint: 'home', btn_help: 'home',
};

function pageOf(page) {
  return PANEL_PAGES[page] ? page : 'home';
}

function pageForKey(key, fallback = 'home') {
  return PAGE_OF_KEY[key] || pageOf(fallback);
}

const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

const row = (...components) => new ActionRowBuilder().addComponents(...components);

// ── Lecture lisible de la configuration ─────────────────────────────────────
const num = n => Number(n || 0).toLocaleString('fr-FR');

function minutesLabel(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60}` : ''}`;
}

function durationLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function oddsOf(cfg) {
  const odds = cfg?.odds?.toObject ? cfg.odds.toObject() : (cfg?.odds || {});
  return {
    common: Math.max(0, Number(odds.common) || 0),
    rare: Math.max(0, Number(odds.rare) || 0),
    legendary: Math.max(0, Number(odds.legendary) || 0),
  };
}

/** Description de la configuration (utilisée par /tresor et le panneau global). */
function describeTreasure(cfg, { hunt = null, now = Date.now() } = {}) {
  const channels = (cfg?.channels || []).map(id => `<#${id}>`).join(', ') || '*aucun*';
  const custom = (cfg?.customWords || []).length;
  const lines = [
    `**État** : ${cfg?.enabled ? '🟢 activé' : '🔴 désactivé'}`,
    `**Salons de chasse** : ${channels}`,
    `**Annonces** : ${cfg?.announceChannelId ? `<#${cfg.announceChannelId}>` : '*salon du coffre*'}`,
    `**Un coffre** toutes les ${minutesLabel(cfg?.minDelayMinutes)} à ${minutesLabel(cfg?.maxDelayMinutes)}, ouvert ${durationLabel(cfg?.lifetimeSeconds)}`,
    `**Indices** : un toutes les ${Number(cfg?.clueIntervalSeconds) > 0 ? durationLabel(cfg.clueIntervalSeconds) : '— (tous d\'un coup)'}`,
    `**Récompenses** : ${num(cfg?.rewardXpMin)}–${num(cfg?.rewardXpMax)} XP · ${num(cfg?.rewardCoinsMin)}–${num(cfg?.rewardCoinsMax)} pièces (×rareté)`,
    `**Mots** : ${wordsFor(cfg).length} au total, dont ${custom} personnalisé(s)`,
    `**Carte visuelle** : ${cfg?.useCard === false ? '❌' : '✅'} · **Indice si erreur** : ${cfg?.hintOnWrongGuess ? '✅' : '❌'}`,
  ];
  if (hunt) {
    const left = Math.max(0, Math.round((new Date(hunt.expiresAt).getTime() - now) / 1000));
    lines.push(`\n**Coffre en cours** : ${RARITY_EMOJI[hunt.rarity]} ${RARITY_LABEL[hunt.rarity]} dans <#${hunt.channelId}> — ${durationLabel(left)} restantes`);
  } else {
    lines.push('\n**Coffre en cours** : aucun');
  }
  return lines.join('\n');
}

// ── Panneau ──────────────────────────────────────────────────────────────────
/**
 * @param {object} cfg      configuration (document ou objet simple)
 * @param {object} [opts]   { notice, page, hunt, hunters, now }
 */
function buildTreasurePanel(cfg, opts = {}) {
  const { notice = null, hunt = null, hunters = [], now = Date.now(), banner = null } = opts;
  // Noms de salons (facultatifs) : un menu déroulant n'accepte pas de mention,
  // on affiche donc « #général » plutôt que l'identifiant brut.
  const channelNames = opts.channelNames || {};
  const channelLabel = id => (channelNames[id] ? `#${channelNames[id]}` : `Salon ${id}`);
  const page = pageOf(opts.page);
  const meta = PANEL_PAGES[page];

  const lines = [describeTreasure(cfg, { hunt, now })];
  if (cfg?.stats) {
    lines.push(`\n**Depuis le début** : ${num(cfg.stats.hunts)} coffre(s) apparu(s), ${num(cfg.stats.opened)} ouvert(s), ${num(cfg.stats.expired)} refermé(s)`);
  }
  lines.push(`\n📄 Page **${meta.label}** — ${meta.hint}`);
  if (banner) lines.push(`\n${banner}`);
  if (notice) lines.push(`\n${notice}`);

  const components = [];

  if (page === 'home') {
    if (!cfg?.channels?.length) {
      lines.push('\n⚠️ **Désigne au moins un salon de chasse** (page 💬 Salons) : sans salon, aucun coffre ne se lance.');
    }
    if (hunt) {
      lines.push(`\n🔎 Le coffre est ouvert ! Les membres tapent le mot directement dans <#${hunt.channelId}>.`);
    }
    components.push(row(
      btn(`${PREFIX}_btn_toggle`, cfg?.enabled ? 'Désactiver' : 'Activer', cfg?.enabled ? '🔴' : '🟢', cfg?.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      btn(`${PREFIX}_btn_spawn`, 'Lancer un coffre', '🚀', ButtonStyle.Primary),
      btn(`${PREFIX}_btn_close`, 'Fermer le coffre', '🛑'),
    ));
    components.push(row(
      btn(`${PREFIX}_btn_page_timing`, 'Rythme & durée', '⏱️'),
      btn(`${PREFIX}_btn_page_rewards`, 'Récompenses', '🎁'),
      btn(`${PREFIX}_btn_page_odds`, 'Raretés', '🎲'),
    ));
    components.push(row(
      btn(`${PREFIX}_btn_page_channels`, 'Salons', '💬'),
      btn(`${PREFIX}_btn_page_words`, 'Mots & indices', '🧩'),
      btn(`${PREFIX}_btn_page_hunters`, 'Chasseurs', '🏆'),
    ));
    components.push(row(
      btn(`${PREFIX}_btn_card`, `Carte : ${cfg?.useCard === false ? '❌' : '✅'}`, '🃏'),
      btn(`${PREFIX}_btn_hint`, `Indice si erreur : ${cfg?.hintOnWrongGuess ? '✅' : '❌'}`, '💡'),
      btn(`${PREFIX}_btn_help`, 'Comment ça marche', '❔', ButtonStyle.Primary),
    ));
  }

  if (page === 'channels') {
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId(`${PREFIX}_sel_channel_add`)
      .setPlaceholder('➕ Ajouter un salon de chasse (jusqu\'à 5)')
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(1).setMaxValues(5);
    components.push(row(channelSelect));

    if (cfg?.channels?.length) {
      const options = cfg.channels.slice(0, 25).map(id => ({ label: channelLabel(id).slice(0, 100), value: id }));
      components.push(row(new StringSelectMenuBuilder()
        .setCustomId(`${PREFIX}_sel_channel_remove`)
        .setPlaceholder('➖ Retirer un salon de chasse')
        .setMinValues(1).setMaxValues(Math.min(5, options.length))
        .addOptions(options)));
    }

    components.push(row(new ChannelSelectMenuBuilder()
      .setCustomId(`${PREFIX}_sel_announce`)
      .setPlaceholder('📣 Salon des annonces de gain (optionnel)')
      .addChannelTypes(ChannelType.GuildText)));

    components.push(row(btn(`${PREFIX}_btn_back`, 'Retour', '↩️')));
  }

  if (page === 'timing') {
    lines.push('\nUn coffre apparaît au plus tôt après le délai minimum, au plus tard après le maximum. Les indices tombent ensuite un par un.');
    components.push(row(
      btn(`${PREFIX}_btn_delays`, `Délais : ${minutesLabel(cfg?.minDelayMinutes)} → ${minutesLabel(cfg?.maxDelayMinutes)}`, '🎯'),
      btn(`${PREFIX}_btn_lifetime`, `Durée de vie : ${durationLabel(cfg?.lifetimeSeconds)}`, '⏳'),
      btn(`${PREFIX}_btn_clue_interval`, `Indices : ${Number(cfg?.clueIntervalSeconds) > 0 ? durationLabel(cfg.clueIntervalSeconds) : 'tous d\'un coup'}`, '🧩'),
    ));
    components.push(row(btn(`${PREFIX}_btn_back`, 'Retour', '↩️')));
  }

  if (page === 'rewards') {
    lines.push('\nLa base est tirée dans l\'intervalle, puis multipliée par la rareté (×1 commune, ×2 rare, ×4 légendaire).');
    const role = cfg?.legendaryRoleId ? `<@&${cfg.legendaryRoleId}>` : '*aucun*';
    lines.push(`**Rôle des légendaires** : ${role}`);
    components.push(row(
      btn(`${PREFIX}_btn_reward_xp`, `XP : ${num(cfg?.rewardXpMin)}–${num(cfg?.rewardXpMax)}`, '⭐'),
      btn(`${PREFIX}_btn_reward_coins`, `Pièces : ${num(cfg?.rewardCoinsMin)}–${num(cfg?.rewardCoinsMax)}`, '🪙'),
      btn(`${PREFIX}_btn_multipliers`, `Multiplicateurs : ×${cfg?.xpMultiplier ?? 1} / ×${cfg?.coinsMultiplier ?? 1}`, '✖️'),
    ));
    components.push(row(new RoleSelectMenuBuilder()
      .setCustomId(`${PREFIX}_sel_legendary_role`)
      .setPlaceholder('🎭 Rôle offert sur un coffre légendaire (optionnel)')));
    components.push(row(btn(`${PREFIX}_btn_back`, 'Retour', '↩️')));
  }

  if (page === 'odds') {
    const odds = oddsOf(cfg);
    const total = odds.common + odds.rare + odds.legendary;
    const words = wordsFor(cfg);
    lines.push('');
    for (const rarity of RARITY_ORDER) {
      const pct = total > 0 ? Math.round((odds[rarity] / total) * 100) : 0;
      lines.push(`${RARITY_EMOJI[rarity]} **${RARITY_LABEL[rarity]}** — ${odds[rarity]}% brut (≈${pct}% réel) · ${words.filter(w => w.rarity === rarity).length} mot(s)`);
    }
    components.push(row(btn(`${PREFIX}_btn_odds`, 'Modifier les probabilités', '🎲', ButtonStyle.Primary)));
    components.push(row(btn(`${PREFIX}_btn_back`, 'Retour', '↩️')));
  }

  if (page === 'words') {
    const words = wordsFor(cfg);
    const customs = (cfg?.customWords || []).map(w => String(w.word));
    lines.push('');
    lines.push(`Banque : **${words.length} mots** (dont ${customs.length} personnalisé(s), ${DEFAULT_WORDS.length} par défaut).`);
    if (customs.length) lines.push(`Personnalisés : ${customs.map(w => `\`${w}\``).join(', ')}`);
    components.push(row(
      btn(`${PREFIX}_btn_word_add`, 'Ajouter un mot', '➕', ButtonStyle.Primary),
      btn(`${PREFIX}_btn_back`, 'Retour', '↩️'),
    ));
    if (cfg?.customWords?.length) {
      components.push(row(new StringSelectMenuBuilder()
        .setCustomId(`${PREFIX}_sel_word_remove`)
        .setPlaceholder('🗑️ Retirer un mot personnalisé')
        .setMinValues(1).setMaxValues(Math.min(5, cfg.customWords.length))
        .addOptions(cfg.customWords.slice(0, 25).map(w => ({
          label: String(w.word).slice(0, 90),
          value: normalizeGuess(w.word).slice(0, 90),
        })))));
    }
  }

  if (page === 'hunters') {
    lines.push('');
    if (!hunters.length) {
      lines.push('Aucun chasseur pour le moment.');
    } else {
      const medals = ['🥇', '🥈', '🥉'];
      for (const [i, p] of hunters.entries()) {
        lines.push(`${medals[i] || `**${i + 1}.**`} <@${p.userId}> — ${p.wins} coffre(s) · série max ${p.bestStreak || 0} · ${num(p.coinsEarned)} pièces`);
      }
    }
    components.push(row(
      btn(`${PREFIX}_btn_publish_board`, 'Publier le classement', '📣', ButtonStyle.Primary),
      btn(`${PREFIX}_btn_back`, 'Retour', '↩️'),
    ));
    components.push(row(new UserSelectMenuBuilder()
      .setCustomId(`${PREFIX}_sel_reset_hunter`)
      .setPlaceholder('🔄 Réinitialiser la fiche d\'un chasseur')));
  }

  const embed = new EmbedBuilder()
    .setColor(cfg?.enabled ? COLORS.primary : COLORS.warning)
    .setTitle(`🎁 Trésors cachés — ${meta.label}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: 'REZO • Trésors cachés' });

  return { embed, components, page, config: cfg };
}

// ── Modaux ───────────────────────────────────────────────────────────────────
const MODAL_KEYS = ['delays', 'lifetime', 'clueInterval', 'rewardsXp', 'rewardsCoins', 'multipliers', 'odds', 'addWord'];

function buildTreasureModal(cfg, key) {
  if (!MODAL_KEYS.includes(key)) return null;
  const modal = new ModalBuilder().setCustomId(`${PREFIX}_modal_${key}`);

  const short = (id, label, value, { max = 40, required = true, placeholder = null } = {}) => {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
      .setMaxLength(max).setValue(String(value)).setRequired(required);
    if (placeholder) input.setPlaceholder(placeholder);
    return input;
  };

  if (key === 'delays') {
    modal.setTitle('🎯 Délais entre deux coffres');
    modal.addComponents(
      row(short('min', 'Délai minimum (minutes)', cfg?.minDelayMinutes ?? 60, { max: 5 })),
      row(short('max', 'Délai maximum (minutes)', cfg?.maxDelayMinutes ?? 180, { max: 5 })),
    );
  } else if (key === 'lifetime') {
    modal.setTitle('⏳ Durée de vie d\'un coffre');
    modal.addComponents(row(short('lifetime', 'Durée en secondes (60 → 86400)', cfg?.lifetimeSeconds ?? 600, { max: 5 })));
  } else if (key === 'clueInterval') {
    modal.setTitle('🧩 Intervalle entre deux indices');
    // ⚠️ Discord plafonne un libellé de champ à 45 caractères.
    modal.addComponents(row(short('interval', 'Intervalle en secondes (0 = aucun)', cfg?.clueIntervalSeconds ?? 90, { max: 5 })));
  } else if (key === 'rewardsXp') {
    modal.setTitle('⭐ Récompense en XP');
    modal.addComponents(
      row(short('min', 'XP minimum', cfg?.rewardXpMin ?? 150, { max: 7 })),
      row(short('max', 'XP maximum', cfg?.rewardXpMax ?? 400, { max: 7 })),
    );
  } else if (key === 'rewardsCoins') {
    modal.setTitle('🪙 Récompense en pièces');
    modal.addComponents(
      row(short('min', 'Pièces minimum', cfg?.rewardCoinsMin ?? 100, { max: 7 })),
      row(short('max', 'Pièces maximum', cfg?.rewardCoinsMax ?? 300, { max: 7 })),
    );
  } else if (key === 'multipliers') {
    modal.setTitle('✖️ Multiplicateurs de récompense');
    modal.addComponents(
      row(short('xp', 'Multiplicateur XP (1 = normal)', cfg?.xpMultiplier ?? 1, { max: 5 })),
      row(short('coins', 'Multiplicateur pièces (1 = normal)', cfg?.coinsMultiplier ?? 1, { max: 5 })),
    );
  } else if (key === 'odds') {
    const odds = oddsOf(cfg);
    modal.setTitle('🎲 Probabilités des raretés');
    modal.addComponents(
      row(short('common', 'Commune (%)', odds.common, { max: 3 })),
      row(short('rare', 'Rare (%)', odds.rare, { max: 3 })),
      row(short('legendary', 'Légendaire (%)', odds.legendary, { max: 3 })),
    );
  } else if (key === 'addWord') {
    modal.setTitle('🧩 Ajouter un mot');
    modal.addComponents(
      row(short('word', 'Mot à deviner (2 à 40 caractères)', '', { max: 40, required: true })),
      row(new TextInputBuilder().setCustomId('clues').setLabel('Indices, séparés par « ; » (max 4)')
        .setStyle(TextInputStyle.Paragraph).setMaxLength(600).setRequired(false)),
      row(short('rarity', 'Rareté : commune, rare ou legendaire', 'commune', { max: 12 })),
    );
  }

  return modal;
}

// ── Application d'une option ─────────────────────────────────────────────────
const toInt = (value, fallback = 0) => {
  const n = parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * @returns {{ patch?: object, notice?: string, action?: string|{modal?:string,page?:string} }}
 */
function applyTreasureOption(cfg, key, values = []) {
  const value = values[0];

  switch (key) {
    case 'btn_toggle': {
      const enabled = !cfg?.enabled;
      if (enabled && !(cfg?.channels || []).length) {
        return { notice: '⚠️ Ajoute d\'abord un **salon de chasse** : sans salon, rien ne peut apparaître.' };
      }
      return { patch: { enabled }, notice: enabled ? '🟢 Module activé.' : '🔴 Module désactivé.' };
    }

    case 'btn_spawn':   return { action: 'spawnNow' };
    case 'btn_close':   return { action: 'closeHunt' };
    case 'btn_publish_board': return { action: 'publishLeaderboard' };
    case 'btn_reset_hunter':  return { action: { page: 'hunters' } };
    case 'btn_help':          return { action: 'help' };
    case 'sel_reset_hunter':  return { action: 'resetHunter' };

    case 'btn_card':
      return { patch: { useCard: cfg?.useCard === false }, notice: cfg?.useCard === false ? '🃏 Carte visuelle activée.' : '🃏 Carte visuelle désactivée.' };

    case 'btn_hint':
      return { patch: { hintOnWrongGuess: !cfg?.hintOnWrongGuess }, notice: cfg?.hintOnWrongGuess ? '💡 Indice sur mauvaise réponse désactivé.' : '💡 Indice sur mauvaise réponse activé.' };

    case 'sel_channel_add': {
      const channels = [...new Set([...(cfg?.channels || []), ...values])].slice(0, 20);
      return { patch: { channels }, notice: `💬 ${values.length} salon(s) ajouté(s) : ${values.map(id => `<#${id}>`).join(', ')}` };
    }

    case 'sel_channel_remove': {
      const channels = (cfg?.channels || []).filter(id => !values.includes(id));
      const patch = { channels };
      if (!channels.length) patch.enabled = false;
      return {
        patch,
        notice: channels.length
          ? `💬 Salon(s) retiré(s) : ${values.map(id => `<#${id}>`).join(', ')}`
          : '💬 Plus aucun salon de chasse : le module est désactivé.',
      };
    }

    case 'sel_announce':
      return { patch: { announceChannelId: value }, notice: `📣 Annonces de gain dans <#${value}>.` };

    case 'sel_legendary_role':
      return { patch: { legendaryRoleId: value }, notice: `🎭 Rôle des coffres légendaires : <@&${value}>.` };

    case 'sel_word_remove': {
      const removed = (cfg?.customWords || []).filter(w => values.includes(normalizeGuess(w.word)));
      const customWords = (cfg?.customWords || []).filter(w => !values.includes(normalizeGuess(w.word)));
      return { patch: { customWords }, notice: `🗑️ Mot(s) retiré(s) : ${removed.map(w => `\`${w.word}\``).join(', ')}` };
    }

    case 'btn_page_channels': return { action: { page: 'channels' } };
    case 'btn_page_timing':   return { action: { page: 'timing' } };
    case 'btn_page_rewards':  return { action: { page: 'rewards' } };
    case 'btn_page_odds':     return { action: { page: 'odds' } };
    case 'btn_page_words':    return { action: { page: 'words' } };
    case 'btn_page_hunters':  return { action: { page: 'hunters' } };
    case 'btn_back':          return { action: { page: 'home' } };

    case 'btn_delays':         return { action: { modal: 'delays' } };
    case 'btn_lifetime':       return { action: { modal: 'lifetime' } };
    case 'btn_clue_interval':  return { action: { modal: 'clueInterval' } };
    case 'btn_reward_xp':      return { action: { modal: 'rewardsXp' } };
    case 'btn_reward_coins':   return { action: { modal: 'rewardsCoins' } };
    case 'btn_multipliers':    return { action: { modal: 'multipliers' } };
    case 'btn_odds':           return { action: { modal: 'odds' } };
    case 'btn_word_add':       return { action: { modal: 'addWord' } };

    default:
      return { notice: '⚠️ Option inconnue.' };
  }
}

const RARITY_ALIASES = {
  commune: 'common', common: 'common',
  rare: 'rare',
  legendaire: 'legendary', 'légendaire': 'legendary', legendary: 'legendary',
};

/**
 * Valide une soumission de modal.
 * @returns {{ patch?: object, notice?: string, error?: string }}
 */
function applyTreasureModal(cfg, key, fields) {
  const read = name => (fields?.getTextInputValue ? fields.getTextInputValue(name) : fields?.[name]) ?? '';

  if (key === 'delays') {
    const min = toInt(read('min'), 0);
    const max = toInt(read('max'), 0);
    if (min < 1 || max < 1) return { error: 'Indique des délais en minutes, au minimum `1`.' };
    if (max > 10080) return { error: 'Le délai maximum ne peut pas dépasser `10080` minutes (7 jours).' };
    const [lo, hi] = min <= max ? [min, max] : [max, min];
    return { patch: { minDelayMinutes: lo, maxDelayMinutes: hi }, notice: `🎯 Nouveau rythme : entre ${minutesLabel(lo)} et ${minutesLabel(hi)}.` };
  }

  if (key === 'lifetime') {
    const seconds = toInt(read('lifetime'), 0);
    if (seconds < 60 || seconds > 86400) return { error: 'Indique une durée entre `60` et `86400` secondes.' };
    return { patch: { lifetimeSeconds: seconds }, notice: `⏳ Un coffre reste ouvert ${durationLabel(seconds)}.` };
  }

  if (key === 'clueInterval') {
    const seconds = toInt(read('interval'), 0);
    if (seconds < 0 || seconds > 3600) return { error: 'Indique un intervalle entre `0` et `3600` secondes (`0` = tous les indices d\'un coup).' };
    return { patch: { clueIntervalSeconds: seconds }, notice: seconds ? `🧩 Un nouvel indice toutes les ${durationLabel(seconds)}.` : '🧩 Tous les indices tombent à l\'apparition.' };
  }

  if (key === 'rewardsXp' || key === 'rewardsCoins') {
    const min = toInt(read('min'), 0);
    const max = toInt(read('max'), 0);
    if (min < 0 || max < 0) return { error: 'Les montants doivent être positifs.' };
    if (max > 1000000) return { error: 'Montant trop élevé (maximum `1000000`).' };
    const [lo, hi] = min <= max ? [min, max] : [max, min];
    return key === 'rewardsXp'
      ? { patch: { rewardXpMin: lo, rewardXpMax: hi }, notice: `⭐ Récompense XP : ${num(lo)} à ${num(hi)}.` }
      : { patch: { rewardCoinsMin: lo, rewardCoinsMax: hi }, notice: `🪙 Récompense pièces : ${num(lo)} à ${num(hi)}.` };
  }

  if (key === 'multipliers') {
    const xp = Number(String(read('xp')).replace(',', '.'));
    const coins = Number(String(read('coins')).replace(',', '.'));
    if (!Number.isFinite(xp) || xp < 0 || xp > 100) return { error: 'Multiplicateur XP invalide (entre `0` et `100`).' };
    if (!Number.isFinite(coins) || coins < 0 || coins > 100) return { error: 'Multiplicateur pièces invalide (entre `0` et `100`).' };
    return { patch: { xpMultiplier: xp, coinsMultiplier: coins }, notice: `✖️ Multiplicateurs : ×${xp} XP, ×${coins} pièces.` };
  }

  if (key === 'odds') {
    const odds = {};
    for (const rarity of RARITY_ORDER) {
      const n = toInt(read(rarity), -1);
      if (n < 0 || n > 100) return { error: `Probabilité invalide pour **${RARITY_LABEL[rarity]}** (entre \`0\` et \`100\`).` };
      odds[rarity] = n;
    }
    if (odds.common + odds.rare + odds.legendary <= 0) {
      return { error: 'Au moins une rareté doit avoir une probabilité supérieure à `0`.' };
    }
    return { patch: { odds }, notice: `🎲 Probabilités : ${odds.common}% / ${odds.rare}% / ${odds.legendary}%.` };
  }

  if (key === 'addWord') {
    // Le champ « mot » accepte aussi la forme « mot | indice 1 ; indice 2 ».
    const parsed = parseCustomWord(read('word'));
    const word = parsed.word;
    if (normalizeGuess(word).length < 2) return { error: 'Le mot doit contenir au moins **2 lettres** (les chiffres seuls ne suffisent pas).' };
    if (word.length > 40) return { error: 'Le mot est trop long (40 caractères maximum).' };

    const rarity = RARITY_ALIASES[String(read('rarity')).trim().toLowerCase()] || 'common';
    const fromField = String(read('clues') || '').split(/[;\n]/).map(c => c.trim()).filter(Boolean);
    const clues = [...parsed.clues, ...fromField].slice(0, 4);

    const customWords = [...(cfg?.customWords || [])].filter(w => normalizeGuess(w.word) !== normalizeGuess(word));
    // Sans indice saisi, le mot reste jouable : des indices génériques (nombre
    // de lettres, première lettre…) sont calculés au tirage.
    customWords.push({ word, clues, rarity });

    return {
      patch: { customWords: customWords.slice(0, 100) },
      notice: `🧩 Mot ajouté : \`${word}\` (${RARITY_LABEL[rarity].toLowerCase()}, ${clues.length} indice(s) saisi(s)).`,
    };
  }

  return { error: 'Paramètre inconnu.' };
}

/** Options prêtes à être enregistrées après « Réinitialiser ». */
function resetPatch() {
  return { ...DEFAULT_CONFIG, odds: { ...DEFAULT_CONFIG.odds }, customWords: [], channels: [], announceChannelId: null, legendaryRoleId: null };
}

module.exports = {
  PREFIX, PANEL_PAGES, DEFAULT_CONFIG, MODAL_KEYS, RARITY_ALIASES,
  buildTreasurePanel, buildTreasureModal, applyTreasureOption, applyTreasureModal,
  describeTreasure, pageOf, pageForKey, resetPatch, oddsOf, minutesLabel, durationLabel,
};
