const mongoose = require('mongoose');
const eventSchema = new mongoose.Schema({
  guildId:     { type: String, required: true },
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  date:        { type: Date,   required: true },
  createdBy:   { type: String, required: true },
  channelId:   { type: String, default: null },
  reminded:    { type: Boolean, default: false },
  participants:{ type: [String], default: [] },
});
eventSchema.index({ guildId: 1, date: 1 });
module.exports = mongoose.model('Event', eventSchema);
