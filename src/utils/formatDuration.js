// utils/formatDuration.js — Formate une durée en millisecondes en texte
// lisible français (ex: "2h 15min", "3j 4h", "moins d'une minute").
function formatDuration(ms) {
  if (!ms || ms < 0) return "moins d'une minute";

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "moins d'une minute";

  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}j`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && mins > 0) parts.push(`${mins}min`); // on n'affiche pas les minutes si ça fait déjà des jours, pour rester lisible

  return parts.join(' ') || "moins d'une minute";
}

module.exports = { formatDuration };
