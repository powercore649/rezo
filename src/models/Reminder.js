const mongoose = require('mongoose');
const reminderSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  guildId:   { type: String, default: null },
  channelId: { type: String, default: null },
  message:   { type: String, required: true },
  remindAt:  { type: Date, required: true },
  done:      { type: Boolean, default: false },
});
reminderSchema.index({ done: 1, remindAt: 1 });
module.exports = mongoose.model('Reminder', reminderSchema);
