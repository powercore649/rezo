const mongoose = require('mongoose');

const chapterSchema = new mongoose.Schema({
  title:     { type: String, required: true, maxlength: 100 },
  content:   { type: String, required: true, maxlength: 4000 },
  order:     { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const bookSchema = new mongoose.Schema({
  guildId:     { type: String, required: true },
  ownerId:     { type: String, required: true },
  title:       { type: String, required: true, maxlength: 100 },
  description: { type: String, default: null, maxlength: 300 },
  coverColor:  { type: String, default: '#8B1A1A' },
  coverImage:  { type: String, default: null },
  chapters:    { type: [chapterSchema], default: [] },
  sharedWith:  { type: [String], default: [] }, // userIds autorisés à consulter
  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now },
});

bookSchema.index({ guildId: 1, ownerId: 1 });
bookSchema.index({ guildId: 1, sharedWith: 1 });
// Un même auteur ne peut pas avoir deux livres au même titre (insensible à la casse gérée en code)
bookSchema.index({ guildId: 1, ownerId: 1, title: 1 });

module.exports = mongoose.model('Book', bookSchema);
