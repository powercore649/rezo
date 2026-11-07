const mongoose = require('mongoose');
const shopItemSchema = new mongoose.Schema({
  guildId:     { type: String,  required: true },
  itemId:      { type: String,  required: true },
  name:        { type: String,  required: true },
  description: { type: String,  default: '' },
  price:       { type: Number,  required: true },
  type:        { type: String,  enum: ['role','badge','perk'], default: 'role' },
  roleId:      { type: String,  default: null },
  badge:       { type: String,  default: null },
  stock:       { type: Number,  default: -1 },
  purchases:   { type: Number,  default: 0 },
  enabled:     { type: Boolean, default: true },
});
shopItemSchema.index({ guildId: 1, itemId: 1 }, { unique: true });
const inventorySchema = new mongoose.Schema({
  userId:   { type: String, required: true },
  guildId:  { type: String, required: true },
  itemId:   { type: String, required: true },
  name:     { type: String },
  type:     { type: String },
  roleId:   { type: String, default: null },
  badge:    { type: String, default: null },
  boughtAt: { type: Date, default: Date.now },
});
inventorySchema.index({ userId: 1, guildId: 1 });
module.exports = {
  ShopItem:  mongoose.model('ShopItem',  shopItemSchema),
  Inventory: mongoose.model('Inventory', inventorySchema),
};
