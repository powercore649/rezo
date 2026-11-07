const mongoose = require('mongoose');

// Un document par salon forum configuré. Placeholders supportés dans `message` :
// {username} — mention de l'auteur du post
// {titre}    — titre du post
// {forum}    — nom du salon forum
// {tags}     — tags appliqués au post (ou "Aucun tag")
const forumWelcomeSchema = new mongoose.Schema({
  guildId:        { type: String, required: true },
  forumChannelId: { type: String, required: true },
  enabled:        { type: Boolean, default: true },
  title:          { type: String, default: '📋 Merci pour ton post !' },
  message:        {
    type: String,
    default: 'Salut {username} 👋\nMerci d\'avoir posté dans **{forum}** !\n\nPense à bien décrire ton sujet et à patienter, un membre de la communauté ne devrait pas tarder à te répondre.',
  },
  pinMessage:     { type: Boolean, default: true },
  buttonLabel:    { type: String, default: null },
  buttonUrl:      { type: String, default: null },
  color:          { type: String, default: null }, // hex, ex: "#5865F2"
});

forumWelcomeSchema.index({ guildId: 1, forumChannelId: 1 }, { unique: true });

module.exports = mongoose.model('ForumWelcome', forumWelcomeSchema);
