const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  userId:   { type: String, required: true },
  joinedAt: { type: Date, default: Date.now },
  entries:  { type: Number, default: 1 }, // poids dans le tirage (1 + bonus de rôle)
}, { _id: false });

const bonusRoleSchema = new mongoose.Schema({
  roleId:  { type: String, required: true },
  entries: { type: Number, required: true },
}, { _id: false });

const giveawaySchema = new mongoose.Schema({
  guildId:           { type: String, required: true },
  channelId:         { type: String, required: true },
  messageId:         { type: String, default: null },
  hostId:            { type: String, required: true },
  prize:             { type: String, required: true },
  description:       { type: String, default: null },   // description custom sous le titre
  imageUrl:          { type: String, default: null },   // image dans l'embed
  thumbnailUrl:      { type: String, default: null },   // thumbnail de l'embed
  winners:           { type: Number, default: 1 },
  participants:      { type: [participantSchema], default: [] },
  requiredRoleId:    { type: String, default: null },   // rôle obligatoire (rétrocompat)
  allowedRoles:      { type: [String], default: [] },   // plusieurs rôles requis (OR)
  blacklistedRoles:  { type: [String], default: [] },   // rôles interdits
  bonusRoles:        { type: [bonusRoleSchema], default: [] },
  maxParticipants:   { type: Number, default: null },   // null = illimité
  dmWinners:         { type: Boolean, default: false }, // DM automatique aux gagnants
  paused:            { type: Boolean, default: false },
  pausedAt:          { type: Date, default: null },
  pausedDuration:    { type: Number, default: 0 },      // ms cumulés en pause (pour recalculer endAt)
  endAt:             { type: Date, required: true },
  ended:             { type: Boolean, default: false },
  cancelled:         { type: Boolean, default: false },
  winnerIds:         { type: [String], default: [] },
  rerollCount:       { type: Number, default: 0 },
  createdAt:         { type: Date, default: Date.now },
});

giveawaySchema.index({ ended: 1, endAt: 1 });
giveawaySchema.index({ guildId: 1, ended: 1 });

module.exports = mongoose.models.Giveaway || mongoose.model('Giveaway', giveawaySchema);
