'use strict';
// models/Todo.js — Tâche de la todo-list partagée du serveur

const mongoose = require('mongoose');

const todoSchema = new mongoose.Schema({
  guildId:    { type: String, required: true },
  createdBy:  { type: String, required: true },
  text:       { type: String, required: true },
  done:       { type: Boolean, default: false },
  doneBy:     { type: String, default: null },
  dueDate:    { type: Date, default: null },
  priority:   { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  createdAt:  { type: Date, default: Date.now },
});

todoSchema.index({ guildId: 1, done: 1 });

module.exports = mongoose.models.Todo || mongoose.model('Todo', todoSchema);
