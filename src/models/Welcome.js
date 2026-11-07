const mongoose = require('mongoose');

// ─── Bienvenue ────────────────────────────────────────────────────────────────
// Système complet "Bienvenue+" : message/contenu, embed riche, image canvas
// (4 styles uniques REZO), MP de bienvenue, boutons, compteur vocal, stats.
const welcomeSchema = new mongoose.Schema({
  guildId:        { type: String, required: true, unique: true },
  enabled:        { type: Boolean, default: false },
  channelId:      { type: String, default: null },

  // ── Rendu du message ──
  // renderStyle : 'embed' (par défaut) | 'plain' (message brut avec mentions actives)
  renderStyle:    { type: String, default: 'embed', enum: ['embed', 'plain'] },
  message:        { type: String, default: 'Bienvenue {user} sur **{server}** !' },
  embedTitle:     { type: String, default: '👋 Bienvenue' },
  embedColor:     { type: String, default: '#57F287' },

  // ── Image canvas ──
  // imageStyle : 'off' | 'gradient' (grille néon) | 'glass' (vitrail glace)
  //              | 'banner' (bandeau + pastille) | 'minimal' (carte épurée)
  imageStyle:     { type: String, default: 'gradient',
                    enum: ['off', 'gradient', 'glass', 'banner', 'minimal'] },
  backgroundUrl:  { type: String, default: null },
  imageText:      { type: String, default: null }, // grand titre "BIENVENUE" personnalisé
  imageSubtitle:  { type: String, default: null }, // ligne d'info personnalisée ({user}, {server}, {count})
  accentColor:    { type: String, default: null }, // couleur d'accent (anneau, bandeau, cadre) #RRGGBB
  textColor:      { type: String, default: null }, // couleur des textes de la carte #RRGGBB
  showFooter:     { type: Boolean, default: true }, // signature REZO sur l'image

  // ── MP de bienvenue ──
  dmEnabled:      { type: Boolean, default: false },
  dmMessage:      { type: String, default: 'Bienvenue sur **{server}** {user} ! Lis le règlement et amuse-toi bien 🎉' },
  dmEmbed:        { type: Boolean, default: true },

  // ── Boutons d'accueil ──
  buttons: [{
    label:  { type: String, required: true, maxlength: 80 },
    url:    { type: String, required: true },
    emoji:  { type: String, default: null },
  }],

  // ── Compteur de membres dans un salon vocal ──
  // {count} et {server} sont remplacés dans counterTemplate.
  counterEnabled: { type: Boolean, default: false },
  counterChannelId: { type: String, default: null },
  counterTemplate:{ type: String, default: '👥 {count} membres' },

  // ── Statistiques de bienvenue ──
  stats: {
    joinsToday:    { type: Number, default: 0 },
    joinsWeek:     { type: Number, default: 0 },
    joinsTotal:    { type: Number, default: 0 },
    lastJoinDate:  { type: Date, default: null },
    lastWeekReset: { type: Date, default: null },
  },

  // ── Embeds d'au revoir partagés avec Farewell (voir plus bas) ──
}, { minimize: false });

welcomeSchema.index({ 'stats.lastJoinDate': 1 }, { sparse: true });

// ─── Au revoir ────────────────────────────────────────────────────────────────
const farewellSchema = new mongoose.Schema({
  guildId:        { type: String, required: true, unique: true },
  enabled:        { type: Boolean, default: false },
  channelId:      { type: String, default: null },
  renderStyle:    { type: String, default: 'embed', enum: ['embed', 'plain'] },
  message:        { type: String, default: '**{username}** ({user}) a quitté le serveur.' },
  embedTitle:     { type: String, default: '👋 Au revoir' },
  embedColor:     { type: String, default: '#FF6B6B' },
  imageStyle:     { type: String, default: 'off', enum: ['off', 'gradient', 'glass', 'banner', 'minimal'] },
  backgroundUrl:  { type: String, default: null },
  // Personnalisation de la carte d'au revoir (mêmes réglages que la carte
  // d'arrivée : le rendu est assuré par le même moteur, utils/welcomeCards.js).
  imageText:      { type: String, default: null },
  imageSubtitle:  { type: String, default: null },
  accentColor:    { type: String, default: null },
  textColor:      { type: String, default: null },
  showFooter:     { type: Boolean, default: true },
}, { minimize: false });

module.exports = {
  Welcome:  mongoose.model('Welcome', welcomeSchema),
  Farewell: mongoose.model('Farewell', farewellSchema),
};
