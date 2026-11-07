'use strict';
const mongoose = require('mongoose');

const AVIS_TAGS = [
  'communaute_active', 'bonne_moderation', 'evenements', 'partenariats_sympas',
  'bon_design', 'peu_actif', 'en_croissance', 'support_reactif',
];

const reviewSchema = new mongoose.Schema({
  guildId:      { type: String, required: true }, // serveur noté
  reviewerId:   { type: String, required: true },
  rating:       { type: Number, required: true, min: 1, max: 5 },
  comment:      { type: String, required: true, maxlength: 500 },
  tags:         { type: [String], default: [] },
  anonymous:    { type: Boolean, default: false },
  mediaUrls:    { type: [String], default: [] }, // captures d'écran / images jointes à l'avis (max 3)

  helpfulUp:    { type: [String], default: [] },
  helpfulDown:  { type: [String], default: [] },

  ownerReply: {
    text:       { type: String, default: null },
    repliedBy:  { type: String, default: null },
    repliedAt:  { type: Date, default: null },
  },

  reported: {
    count:        { type: Number, default: 0 },
    reporterIds:  { type: [String], default: [] },
  },
  hidden:       { type: Boolean, default: false },

  approved:     { type: Boolean, default: true }, // false si modération manuelle activée et en attente
  editedAt:     { type: Date, default: null },
  createdAt:    { type: Date, default: Date.now },
});
reviewSchema.index({ guildId: 1, reviewerId: 1 }, { unique: true });
reviewSchema.index({ guildId: 1, createdAt: -1 });

const avisConfigSchema = new mongoose.Schema({
  guildId:            { type: String, required: true, unique: true },
  enabled:            { type: Boolean, default: true },

  minJoinDays:        { type: Number, default: 3 },   // ancienneté minimale sur CE serveur pour pouvoir noter
  minAccountAgeDays:  { type: Number, default: 0 },    // âge minimal du compte Discord

  allowAnonymous:     { type: Boolean, default: true },
  allowOwnerReply:    { type: Boolean, default: true },
  requireApproval:    { type: Boolean, default: false }, // modération manuelle avant publication
  reportThreshold:    { type: Number, default: 3 },      // nombre de signalements avant masquage auto

  editCooldownHours:  { type: Number, default: 24 },

  logChannelId:       { type: String, default: null },   // notifie chaque nouvel avis / signalement
  reviewChannelId:    { type: String, default: null },   // publie automatiquement chaque avis approuvé

  activeTags:         { type: [String], default: [...AVIS_TAGS] },
}, { timestamps: true });

module.exports = {
  AVIS_TAGS,
  Review:     mongoose.model('Review', reviewSchema),
  AvisConfig: mongoose.model('AvisConfig', avisConfigSchema),
};
