const mongoose = require('mongoose');

const autoRoleSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  type:    { type: String, enum: ['join','level','time','bump'], required: true },
  roleId:  { type: String, required: true },
  level:   { type: Number, default: null },
  days:    { type: Number, default: null },
  bumps:   { type: Number, default: null },
  enabled: { type: Boolean, default: true },
});
autoRoleSchema.index({ guildId: 1, type: 1 });
module.exports = mongoose.model('AutoRole', autoRoleSchema);
