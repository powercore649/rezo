const mongoose = require('mongoose');

const inviteSchema = new mongoose.Schema({
  code:         { type: String, required: true },
  guildId:      { type: String, required: true },
  createdBy:    { type: String, required: true }, // userId
  createdByTag: { type: String, default: '' },
  uses:         { type: Number, default: 0 },
  createdAt:    { type: Date, default: Date.now },
});

inviteSchema.index({ guildId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Invite', inviteSchema);
