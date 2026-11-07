const mongoose = require('mongoose');
const reglementSchema = new mongoose.Schema({
  guildId:    { type: String, required: true, unique: true },
  rules:      { type: [String], default: [] },
  messageId:  { type: String, default: null }, // message publié actuel
  channelId:  { type: String, default: null },
  acceptRoleId:{ type: String, default: null }, // rôle donné quand on accepte
  // ── v2 : personnalisation + éditeur ──
  title:      { type: String, default: '', maxLength: 100 },
  description:{ type: String, default: '', maxLength: 1000 }, // intro libre au-dessus des règles
  footer:     { type: String, default: '', maxLength: 150 },
  color:      { type: String, default: '#8B1A1A', match: /^#[0-9A-Fa-f]{6}$/ },
  acceptLabel:{ type: String, default: '✅ J\'accepte le règlement', maxLength: 80 },
  showNumbering:{ type: Boolean, default: true },
  acceptCount:{ type: Number, default: 0 }, // statistique d'acceptations
  updatedAt:  { type: Date, default: Date.now },
});
module.exports = mongoose.model('Reglement', reglementSchema);
