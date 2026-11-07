const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  enabled:   { type: Boolean, default: false },
  channelId: { type: String, default: null },
}, { _id: false });

const guildLogsSchema = new mongoose.Schema({
  guildId:    { type: String, required: true, unique: true },
  moderation: { type: categorySchema, default: () => ({}) },
  membres:    { type: categorySchema, default: () => ({}) },
  messages:   { type: categorySchema, default: () => ({}) },
  vocal:      { type: categorySchema, default: () => ({}) },
});

module.exports = mongoose.model('GuildLogs', guildLogsSchema);
