const mongoose = require('mongoose');

// Une ligne du menu : le rôle distribué, et son apparence sur le panneau.
// `label` reste facultatif : à défaut on affiche le nom du rôle en direct,
// ce qui évite un panneau figé quand un rôle est renommé.
const entrySchema = new mongoose.Schema({
  roleId: { type: String, required: true },
  label:  { type: String, default: null, maxlength: 80 },
  emoji:  { type: String, default: null, maxlength: 64 },
}, { _id: false });

const roleMenuSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  // Panneau publié : le message est édité sur place à chaque modification,
  // donc les composants survivent aux redémarrages (customId statique).
  channelId: { type: String, default: null },
  messageId: { type: String, default: null },

  // ── Apparence du panneau ────────────────────────────────────────────────
  // Tous ces champs sont facultatifs : sans valeur, le rendu retombe sur un
  // style sobre par défaut. Les URL sont revalidées au rendu (http/https
  // uniquement), une valeur invalide ne casse donc jamais le panneau.
  title:          { type: String, default: '🎭 Choisis tes rôles', maxlength: 256 },
  description:    { type: String, default: null, maxlength: 2000 },
  color:          { type: String, default: null, maxlength: 16 },   // '#5865F2'
  imageUrl:       { type: String, default: null, maxlength: 2048 }, // grande image (bannière)
  thumbnailUrl:   { type: String, default: null, maxlength: 2048 }, // petite image à droite
  authorName:     { type: String, default: null, maxlength: 256 },
  authorIconUrl:  { type: String, default: null, maxlength: 2048 },
  footerText:     { type: String, default: null, maxlength: 2048 },
  footerIconUrl:  { type: String, default: null, maxlength: 2048 },

  // 'buttons' = un bouton par rôle (25 max) · 'select' = menu déroulant (25 max)
  mode:      { type: String, enum: ['buttons', 'select'], default: 'buttons' },
  // true = un seul rôle du menu à la fois (les autres sont retirés)
  exclusive: { type: Boolean, default: false },

  entries:   { type: [entrySchema], default: [] },
  updatedBy: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.models.RoleMenu || mongoose.model('RoleMenu', roleMenuSchema);
