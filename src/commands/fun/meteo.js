'use strict';
// commands/fun/meteo.js — 🌤️ Météo actuelle d'une ville (OpenWeatherMap).
//
// La mise en forme des données vit dans utils/weatherEngine.js (pure, testable
// sans réseau) ; ce fichier ne fait que l'appel HTTP et le rendu de l'embed.
// Clé requise : WEATHER_KEY dans le .env. Sans clé, la commande l'explique au
// lieu de rester muette.

const axios = require('axios');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { COLORS, errorEmbed } = require('../../utils/embeds');
const { parseWeatherResponse } = require('../../utils/weatherEngine');

const API_URL = 'https://api.openweathermap.org/data/2.5/weather';

function hasWeatherKey(env = process.env) {
  return Boolean(env.WEATHER_KEY);
}

// Appel réseau isolé : permet d'injecter un faux client HTTP dans les tests.
async function fetchWeather(city, { apiKey = process.env.WEATHER_KEY, http = axios } = {}) {
  const { data } = await http.get(API_URL, {
    timeout: 8000,
    params: { q: city, units: 'metric', lang: 'fr', appid: apiKey },
  });
  return parseWeatherResponse(data);
}

function ts(date) {
  return date ? `<t:${Math.floor(new Date(date).getTime() / 1000)}:t>` : null;
}

// Rendu pur (aucune I/O) — exposé pour les tests.
function buildWeatherEmbed(weather) {
  const place = weather.country ? `${weather.cityName}, ${weather.country}` : weather.cityName;
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`${weather.emoji} Météo — ${place}`)
    .setDescription(`**${weather.description}** · ${weather.tempC}°C`)
    .addFields(
      { name: '🌡️ Ressenti', value: `${weather.feelsLikeC}°C`, inline: true },
      { name: '⬇️ Min', value: `${weather.tempMinC}°C`, inline: true },
      { name: '⬆️ Max', value: `${weather.tempMaxC}°C`, inline: true },
      { name: '💧 Humidité', value: `${weather.humidity}%`, inline: true },
      {
        name: '💨 Vent',
        value: weather.windKph === null
          ? '—'
          : `${weather.windKph} km/h${weather.windDirection ? ` (${weather.windDirection})` : ''}`,
        inline: true,
      },
      { name: '🧭 Pression', value: `${weather.pressure} hPa`, inline: true },
    );

  if (weather.cloudiness !== null) embed.addFields({ name: '☁️ Nuages', value: `${weather.cloudiness}%`, inline: true });
  if (weather.visibilityKm !== null) embed.addFields({ name: '👁️ Visibilité', value: `${weather.visibilityKm} km`, inline: true });

  const rise = ts(weather.sunrise);
  const set = ts(weather.sunset);
  if (rise || set) {
    embed.addFields({
      name: '🌅 Soleil',
      value: [rise && `Lever ${rise}`, set && `Coucher ${set}`].filter(Boolean).join(' • '),
      inline: false,
    });
  }

  return embed.setFooter({ text: 'REZO • Météo' }).setTimestamp();
}

function weatherErrorEmbed(err) {
  const status = err?.response?.status;
  if (status === 404) return errorEmbed('Ville introuvable', 'Aucune ville ne correspond à cette recherche. Vérifie l\'orthographe.');
  if (status === 401) return errorEmbed('Clé météo invalide', 'La clé `WEATHER_KEY` est refusée par OpenWeatherMap.');
  return errorEmbed('Météo indisponible', 'Le service météo ne répond pas pour le moment. Réessaie plus tard.');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('meteo')
    .setDescription('🌤️ Météo actuelle d\'une ville')
    .addStringOption(o =>
      o.setName('ville').setDescription('Nom de la ville (ex : Paris)').setRequired(true).setMaxLength(80)),

  async execute(interaction) {
    const city = interaction.options.getString('ville').trim();

    if (!hasWeatherKey()) {
      return interaction.reply({
        embeds: [errorEmbed('Météo non configurée', 'La clé `WEATHER_KEY` n\'est pas définie dans le `.env` du bot. Contacte un administrateur.')],
        ephemeral: true,
      });
    }

    await interaction.deferReply();
    try {
      const weather = await fetchWeather(city);
      return interaction.editReply({ embeds: [buildWeatherEmbed(weather)] });
    } catch (err) {
      return interaction.editReply({ embeds: [weatherErrorEmbed(err)] });
    }
  },

  __testables: { buildWeatherEmbed, fetchWeather, weatherErrorEmbed, hasWeatherKey, API_URL },
};
