// models/GuildBrand.js — Identité visuelle personnalisée par serveur.
//
// Discord permet à un bot d'avoir un PROFIL DE MEMBRE différent par serveur :
// avatar, bannière et surnom via `guild.members.editMe()`. L'avatar/bannière
// GLOBAUX de l'application restent, eux, communs à tous les serveurs.
// Ce modèle stocke donc l'identité réellement affichée dans CE serveur :
//   • le surnom, l'avatar et la bannière du profil de membre ;
//   • le nom d'affichage, la couleur et le pied de page des embeds.
//
// Le tout est réservé aux serveurs disposant d'une licence active (pas l'essai).
const mongoose = require('mongoose');

const guildBrandSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },

  enabled: { type: Boolean, default: false },

  // Nom affiché par le bot dans ses embeds (2 à 32 caractères).
  displayName: { type: String, default: null, maxlength: 32 },

  // Emoji signature affiché à côté du nom (« Nom 🎲 ») et dans les cartes.
  emoji: { type: String, default: null, maxlength: 16 },

  // Surnom réel du bot sur CE serveur (permission « Gérer les pseudos »).
  nickname: { type: String, default: null, maxlength: 32 },

  // Style du surnom (voir utils/nicknameStyle.js) : police Unicode, effet
  // (dont « dégradé », qui passe par la couleur du rôle) et palette.
  nicknameFont:    { type: String, default: 'classique' },
  nicknameEffect:  { type: String, default: 'uni' },
  nicknamePalette: { type: String, default: 'none' },

  // Encadrement du pseudo par deux pastilles colorées : rendu bicolore
  // garanti sans boost (le dégradé de rôle, lui, exige les styles améliorés).
  nicknameWrap:    { type: String, default: 'none' },

  // Rôle Discord qui porte la couleur (dégradée) du pseudo. Créé et géré par
  // le bot, supprimé quand le style est réinitialisé ou l'identité désactivée.
  nicknameRoleId:  { type: String, default: null },

  // Images : URL http(s) accessibles par Discord.
  avatarUrl: { type: String, default: null, maxlength: 512 },
  bannerUrl: { type: String, default: null, maxlength: 512 },

  // Couleur principale des embeds (#RRGGBB).
  color: { type: String, default: null, maxlength: 9 },

  // Pied de page personnalisé.
  footerText: { type: String, default: null, maxlength: 120 },

  // Quand afficher la bannière :
  //   off     → jamais ; missing → seulement si l'embed n'a pas d'image ;
  //   always  → remplace toute image d'embed.
  bannerMode: { type: String, enum: ['off', 'missing', 'always'], default: 'missing' },

  // Remplacer l'auteur / le pied de page même quand l'embed en a déjà un.
  replaceAuthor: { type: Boolean, default: true },
  replaceFooter: { type: Boolean, default: true },

  // Utiliser l'avatar comme vignette quand l'embed n'en a pas.
  avatarThumbnail: { type: Boolean, default: false },

  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
}, { minimize: false });

module.exports = mongoose.models.GuildBrand || mongoose.model('GuildBrand', guildBrandSchema);
