'use strict';
// utils/weatherEngine.js — Logique pure de mise en forme météo (OpenWeatherMap)
// Séparée de l'appel réseau pour être testable à 100% sans connexion.

const WIND_DIRECTIONS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];

function windDirectionFromDeg(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return null;
  const index = Math.round((deg % 360) / 22.5) % 16;
  return WIND_DIRECTIONS[index];
}

const WEATHER_EMOJI = {
  '01d': '☀️', '01n': '🌙', '02d': '🌤️', '02n': '☁️', '03d': '☁️', '03n': '☁️',
  '04d': '☁️', '04n': '☁️', '09d': '🌧️', '09n': '🌧️', '10d': '🌦️', '10n': '🌧️',
  '11d': '⛈️', '11n': '⛈️', '13d': '❄️', '13n': '❄️', '50d': '🌫️', '50n': '🌫️',
};

function emojiForIcon(icon) {
  return WEATHER_EMOJI[icon] || '🌡️';
}

/**
 * Transforme la réponse brute de l'API OpenWeatherMap "Current Weather" en objet
 * simple et prêt à afficher. Ne lève jamais d'exception sur des données manquantes.
 * @param {Object} data - JSON renvoyé par https://api.openweathermap.org/data/2.5/weather
 */
function parseWeatherResponse(data) {
  if (!data || !data.main || !data.weather?.length) {
    throw new Error('Réponse météo invalide ou incomplète.');
  }

  const weather = data.weather[0];
  return {
    cityName: data.name || 'Ville inconnue',
    country: data.sys?.country || null,
    description: weather.description ? weather.description.charAt(0).toUpperCase() + weather.description.slice(1) : 'Inconnu',
    emoji: emojiForIcon(weather.icon),
    tempC: Math.round(data.main.temp),
    feelsLikeC: Math.round(data.main.feels_like),
    tempMinC: Math.round(data.main.temp_min),
    tempMaxC: Math.round(data.main.temp_max),
    humidity: data.main.humidity,
    pressure: data.main.pressure,
    windKph: data.wind?.speed !== undefined ? Math.round(data.wind.speed * 3.6) : null, // m/s -> km/h
    windDirection: windDirectionFromDeg(data.wind?.deg),
    cloudiness: data.clouds?.all ?? null,
    sunrise: data.sys?.sunrise ? new Date(data.sys.sunrise * 1000) : null,
    sunset: data.sys?.sunset ? new Date(data.sys.sunset * 1000) : null,
    visibilityKm: data.visibility !== undefined ? Math.round(data.visibility / 100) / 10 : null,
  };
}

module.exports = { parseWeatherResponse, windDirectionFromDeg, emojiForIcon };
