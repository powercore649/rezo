const mongoose = require('mongoose');

const serverSchema = new mongoose.Schema({
  guildId:          { type: String, required: true, unique: true },
  guildName:        { type: String, default: '' },
  guildIcon:        { type: String, default: null },

  // Config bump
  description:      { type: String, default: '' },
  inviteLink:       { type: String, default: '' },
  tags:             { type: [String], default: [] },
  language:         { type: String, default: 'fr' },
  nsfw:             { type: Boolean, default: false },

  // Salons & rôles
  bumpChannelId:    { type: String, default: null },  // salon où /bump est autorisé
  feedChannelId:    { type: String, default: null },  // salon qui reçoit les bumps des autres serveurs
  logChannelId:     { type: String, default: null },  // salon logs internes
  bumpRoleId:       { type: String, default: null },  // rôle pingé au rappel

  // Stats
  bumpCount:        { type: Number, default: 0 },
  weeklyBumps:      { type: Number, default: 0 },   // bumps cette semaine
  monthlyBumps:     { type: Number, default: 0 },  // bumps ce mois
  bumpStreak:       { type: Number, default: 0 },   // jours consécutifs bumpés
  lastStreakDate:   { type: String, default: null }, // 'YYYY-MM-DD' du dernier bump
  totalCoinsEarned: { type: Number, default: 0 },   // coins gagnés via bumps
  featured:         { type: Boolean, default: false }, // serveur mis en avant
  featuredUntil:    { type: Date,   default: null },
  totalVotes:       { type: Number, default: 0 },
  lastBump:         { type: Date,   default: null },
  lastBumpedBy:     { type: String, default: null },
  memberCount:      { type: Number, default: 0 },

  // Rappels
  reminderEnabled:  { type: Boolean, default: true },
  reminderSent:     { type: Boolean, default: false },

  // Blacklist
  blacklisted:      { type: Boolean, default: false },
  blacklistReason:  { type: String,  default: '' },

  // Partenariats — annonce automatique + compteur par membre (voir aussi
  // le modèle PartnerStats pour le compteur individuel)
  partnerChannelId: { type: String, default: null },  // salon où l'annonce de partenariat est postée
  partnerSubmitChannelId: { type: String, default: null }, // salon surveillé : tout lien d'invite posté ici déclenche l'annonce automatiquement
  partnerTitle:     { type: String, default: '🤝 Nouveau partenariat !' },
  partnerMessage:   { type: String, default: "Merci {user} d'avoir effectué un nouveau partenariat avec nous ! 🎉" },
  partnerColor:     { type: String, default: '#7c6cf0' },
  partnerFooter:    { type: String, default: '' },      // texte de pied d'embed, vide = aucun
  partnerThumbnail: { type: String, default: 'avatar' }, // 'avatar' | 'none' | URL personnalisée
  partnerImage:     { type: String, default: null },     // grande image/bannière optionnelle
  totalPartnerships:{ type: Number, default: 0 },        // compteur global du serveur (tous membres confondus)

  // Invitations avancées — annonce automatique à l'arrivée d'un membre
  inviteLogChannelId: { type: String, default: null },
  inviteLogEnabled:   { type: Boolean, default: true },
  inviteLogTitle:     { type: String, default: '📥 Nouveau membre !' },
  inviteLogMessage:   { type: String, default: "{user} a rejoint le serveur, invité par **{inviter}** !" },
  inviteLogColor:     { type: String, default: '#57F287' },
  inviteLogLeaveMessage: { type: String, default: '{user} a quitté le serveur (invité par **{inviter}**).' },

  // Surveillance de bots — salon d'annonce par défaut (voir aussi le modèle
  // WatchedBot, qui peut définir un salon différent par bot surveillé)
  botWatchChannelId: { type: String, default: null },

  // Extra Owners — utilisateurs avec permissions étendues (système de récupération)
  extraOwners: { type: [String], default: [] }, // Array d'IDs Discord

  // Message de remerciement après bump
  bumpThanksEnabled: { type: Boolean, default: true },
  bumpThanksMessage: { type: String, default: 'Merci {user} pour ton bump ! 🚀' },
  bumpThanksColor: { type: String, default: '#2ecc71' },
  bumpThanksTitle: { type: String, default: '✅ Bump enregistré !' },
  bumpThanksImage: { type: String, default: null }, // URL image optionnelle

  createdAt:        { type: Date, default: Date.now },
});

module.exports = mongoose.model('Server', serverSchema);
