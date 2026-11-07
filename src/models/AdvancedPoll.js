const mongoose = require('mongoose');
const advancedPollSchema = new mongoose.Schema({
  guildId:    { type: String, required: true },
  messageId:  { type: String, required: true },
  channelId:  { type: String, required: true },
  question:   { type: String, required: true },
  options:    { type: [String], required: true },
  votes:      { type: Map, of: Number, default: {} }, // userId -> optionIndex
  anonymous:  { type: Boolean, default: false },
  multiChoice:{ type: Boolean, default: false },
  endsAt:     { type: Date, default: null },
  closed:     { type: Boolean, default: false },
  createdBy:  { type: String, required: true },
});
advancedPollSchema.index({ guildId: 1, closed: 1 });
module.exports = mongoose.model('AdvancedPoll', advancedPollSchema);
