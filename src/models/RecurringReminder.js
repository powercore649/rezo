const mongoose = require('mongoose');
const recurringReminderSchema = new mongoose.Schema({
  guildId:    { type: String, required: true },
  channelId:  { type: String, required: true },
  message:    { type: String, required: true },
  interval:   { type: String, enum: ['daily','weekly','hourly'], required: true },
  nextRun:    { type: Date, required: true },
  createdBy:  { type: String, required: true },
  active:     { type: Boolean, default: true },
});
recurringReminderSchema.index({ active: 1, nextRun: 1 });
module.exports = mongoose.model('RecurringReminder', recurringReminderSchema);
