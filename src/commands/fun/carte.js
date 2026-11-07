'use strict';
// commands/fun/carte.js — 🗺️ Carte du monde réelle, navigable aux boutons.
//
// Ce n'est pas une iframe Google Maps (Discord ne sait pas en afficher) : le bot
// assemble des tuiles Esri / OpenStreetMap en une image, et chaque bouton renvoie
// une nouvelle image de la vue voisine. L'utilisateur peut donc se déplacer,
// zoomer, changer de style et ouvrir le même point dans Google Maps.
//
// Découpage :
//   utils/mapEngine.js  — projection, grille de tuiles, état encodé dans le customId
//   utils/mapTiles.js   — géocodage (Photon/Nominatim) + tuiles (Esri/OSM) en cache
//   utils/mapRender.js  — assemblage canvas (épingle, échelle, attribution)
//   utils/mapPanel.js   — embed + boutons, et routage des actions
//
// Aucune clé API n'est nécessaire. Si le réseau ou le canvas manque, la commande
// dégrade proprement : elle affiche le lieu et son lien au lieu de planter.
//
// Fonctionnalité réservée aux serveurs licenciés (essai gratuit accepté) : le
// routeur bloque `/carte` via `licenseGate`, et chaque clic de bouton refait le
// contrôle — un panneau publié pendant l'essai se verrouille donc tout seul
// quand l'essai ou la licence s'arrête.

const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { errorEmbed } = require('../../utils/embeds');
const licenseGate = require('../../utils/licenseGate');
const geocoder = require('../../utils/mapTiles');
const { renderMap } = require('../../utils/mapRender');
const mapPanel = require('../../utils/mapPanel');
const { normalizeState, MIN_ZOOM, MAX_ZOOM } = require('../../utils/mapEngine');

const COMMAND_NAME = 'carte';
const DEFAULT_ZOOM = 12;
const PRESS_COOLDOWN_MS = 1200;
const MAX_TRACKED_PRESSES = 2000;

// Un rendu = ~12 requêtes de tuiles. Sans ce garde-fou, deux membres qui
// martèlent les flèches suffisent à se faire limiter par les serveurs publics.
const presses = new Map();

function pressKey(interaction) {
  return `${interaction.user?.id || 'anon'}:${interaction.message?.id || 'msg'}`;
}

function tooFast(interaction) {
  const key = pressKey(interaction);
  const now = Date.now();
  const last = presses.get(key) || 0;
  if (now - last < PRESS_COOLDOWN_MS) return true;

  if (presses.size >= MAX_TRACKED_PRESSES) {
    const oldest = presses.keys().next().value;
    if (oldest !== undefined) presses.delete(oldest);
  }
  presses.set(key, now);
  return false;
}

/**
 * Compose la réponse complète (embed + image + boutons). Exporté pour les tests :
 * on peut vérifier la charge utile sans réseau ni Discord.
 */
async function buildPayload(state, {
  label = null,
  notice = null,
  renderer = renderMap,
} = {}) {
  const view = normalizeState(state);

  let rendered = null;
  try {
    rendered = await renderer(view);
  } catch (err) {
    console.warn('⚠️ Carte : rendu d’image impossible —', err?.message || err);
  }

  const imageName = mapPanel.imageNameFor(rendered?.mime);
  const embed = mapPanel.mapEmbed(view, {
    label,
    attribution: rendered?.attribution || '© OpenStreetMap contributors',
    hasImage: Boolean(rendered),
    imageName,
    notice,
  });

  if (rendered?.missing) {
    embed.setDescription(`${embed.data.description}\n*${rendered.missing} tuile(s) indisponible(s) — fond partiel.*`.slice(0, 4000));
  }

  const payload = { embeds: [embed], components: [] };
  if (rendered) {
    payload.files = [new AttachmentBuilder(rendered.buffer, { name: imageName })];
    payload.components = mapPanel.mapComponents(view);
  }
  return { payload, rendered, view };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('carte')
    .setDescription('🗺️ Carte réelle d’un lieu — déplaçable aux boutons')
    .addStringOption(o => o
      .setName('lieu')
      .setDescription('Ville, adresse, monument… ou des coordonnées « 48.8566, 2.3522 »')
      .setRequired(true)
      .setMaxLength(120)
      .setAutocomplete(true))
    .addIntegerOption(o => o
      .setName('zoom')
      .setDescription(`Niveau de zoom initial (${MIN_ZOOM} = monde entier, ${MAX_ZOOM} = rue)`)
      .setMinValue(MIN_ZOOM)
      .setMaxValue(MAX_ZOOM)
      .setRequired(false)),

  // Propositions de lieux pendant la saisie : Photon répond en GeoJSON, on
  // renvoie « lat,lon|libellé » pour que la commande n'ait pas à géocoder deux fois.
  async autocomplete(interaction) {
    const focused = interaction.options.getFocused() || '';
    if (String(focused).trim().length < 2) return interaction.respond([]);

    try {
      const places = await geocoder.searchPlaces(focused, { limit: 8 });
      return interaction.respond(places.slice(0, 25).map(place => {
        const label = geocoder.cleanLabel(place.label, 80);
        const value = `${place.lat.toFixed(5)},${place.lon.toFixed(5)}|${label}`;
        return { name: geocoder.cleanLabel(place.label, 95), value: value.slice(0, 100) };
      }));
    } catch {
      return interaction.respond([]);
    }
  },

  async execute(interaction) {
    const raw = (interaction.options.getString('lieu') || '').trim();
    const zoom = interaction.options.getInteger('zoom') || DEFAULT_ZOOM;

    await interaction.deferReply();

    try {
      const place = await geocoder.geocode(raw);
      if (!place) {
        return interaction.editReply({
          embeds: [errorEmbed('Lieu introuvable', `Aucun résultat pour **${raw.slice(0, 80)}**.\nEssaie une ville (« Lyon »), un monument (« Mont-Saint-Michel ») ou des coordonnées (« 48.8566, 2.3522 »).`)],
        });
      }

      const view = normalizeState({ lat: place.lat, lon: place.lon, zoom, theme: 'dark' });
      const { payload } = await buildPayload(view, { label: place.label });

      const sent = await interaction.editReply(payload);
      const messageId = sent?.resource?.message?.id || sent?.message?.id || sent?.id;
      mapPanel.remember(messageId, { label: place.label, origin: view });
      return sent;
    } catch (err) {
      console.error('carte:', err);
      return interaction.editReply({
        embeds: [errorEmbed('Carte indisponible', 'Impossible de construire la carte pour le moment. Réessaie dans un instant.')],
      });
    }
  },

  // ── Boutons : map_<action>_<theme>_<lat>_<lon>_<zoom> ─────────────────────
  async handleButton(interaction) {
    const decoded = mapPanel.decodeState(interaction.customId);
    if (!decoded) return;

    // Contrôle de licence refait au clic (borné à 2 s) : sans lui, une carte
    // publiée pendant l'essai gratuit continuerait de fonctionner après son
    // expiration. On répond en éphémère : le panneau n'est pas abîmé.
    if (interaction.inGuild?.() && licenseGate.isLicenseRequired(COMMAND_NAME)) {
      const access = await licenseGate.checkAccessBounded(interaction.guildId, COMMAND_NAME);
      const refusal = !access
        ? licenseGate.unavailableEmbed(COMMAND_NAME)
        : (access.ok ? null : licenseGate.lockEmbed(COMMAND_NAME, { access }));
      if (refusal) {
        return interaction.reply({ embeds: [refusal], flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }

    if (tooFast(interaction)) {
      return interaction.reply({
        content: '⏳ Doucement — laisse la carte finir de se redessiner.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferUpdate();

    const meta = mapPanel.recall(interaction.message?.id);
    const next = mapPanel.nextState(decoded, meta);
    const { payload } = await buildPayload(next, { label: meta?.label || null });
    return interaction.editReply(payload);
  },

  __testables: { buildPayload, tooFast, presses, DEFAULT_ZOOM, PRESS_COOLDOWN_MS, COMMAND_NAME },
};
