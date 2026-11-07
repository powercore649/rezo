const mongoose = require('mongoose');

const givenBySchema = new mongoose.Schema({
  userId: { type: String, required: true },
  date:   { type: Date,   default: Date.now },
}, { _id: false });

const reputationSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId:  { type: String, required: true },
  points:  { type: Number, default: 0 },
  givenBy: { type: [givenBySchema], default: [] },
});

reputationSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('Reputation', reputationSchema);
