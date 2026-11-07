const mongoose = require('mongoose');
const noteSchema = new mongoose.Schema({
  guildId:   { type: String, required: true },
  userId:    { type: String, required: true },
  modId:     { type: String, required: true },
  note:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
noteSchema.index({ guildId: 1, userId: 1 });
module.exports = mongoose.model('Note', noteSchema);
