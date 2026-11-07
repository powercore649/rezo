const { ActivityType } = require('discord.js');
const BotStatus = require('../models/BotStatus');
const release = require('../core/release');

const TYPE_MAP = {
  Playing:   ActivityType.Playing,
  Watching:  ActivityType.Watching,
  Listening: ActivityType.Listening,
  Competing: ActivityType.Competing,
  Streaming: ActivityType.Streaming,
  Custom:    ActivityType.Custom,
};

const DEFAULTS = {
  presenceStatus: 'online',
  activityType:   'Custom',
  activityText:   `${release.currentRelease().name} — Bump & communauté`,
  streamUrl:      null,
};

// ─── Récupère la config actuelle (ou crée la config par défaut) ──────────────
async function getBotStatus() {
  let cfg = await BotStatus.findOne({ key: 'main' });
  if (!cfg) cfg = await BotStatus.create({ key: 'main', ...DEFAULTS });
  return cfg;
}

// ─── Applique la config persistée à la présence Discord du bot ───────────────
async function applyBotStatus(client) {
  try {
    const cfg = await getBotStatus();

    const type = TYPE_MAP[cfg.activityType] ?? ActivityType.Custom;
    const activity = {
      name: cfg.activityText || DEFAULTS.activityText,
      type,
      state: type === ActivityType.Custom ? (cfg.activityText || DEFAULTS.activityText) : undefined,
    };
    if (cfg.activityType === 'Streaming' && cfg.streamUrl) {
      activity.url = cfg.streamUrl;
    }

    client.user.setPresence({
      status: cfg.presenceStatus || DEFAULTS.presenceStatus,
      activities: [activity],
    });
    return cfg;
  } catch (err) {
    console.error('applyBotStatus:', err.message);
    return null;
  }
}

module.exports = { getBotStatus, applyBotStatus, TYPE_MAP, DEFAULTS };
