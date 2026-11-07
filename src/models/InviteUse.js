const mongoose = require('mongoose');

// Une entrée par membre actuellement/déjà présent, traçant qui l'a invité.
const inviteUseSchema = new mongoose.Schema({
  guildId:       { type: String, required: true },
  userId:        { type: String, required: true }, // le membre qui a rejoint
  userTag:       { type: String, default: '' },

  inviterId:     { type: String, default: null },  // celui qui a invité (null = inconnu)
  inviterTag:    { type: String, default: '' },

  code:          { type: String, default: null },  // code d'invitation utilisé (null = inconnu)
  method:        {
    type: String,
    enum: ['invite', 'vanity', 'unknown'],
    default: 'unknown',
  },

  // Anti-fake : compte trop jeune au moment du join
  fake:          { type: Boolean, default: false },

  // Reparti = a quitté le serveur après avoir rejoint (l'invitation ne compte plus dans le total actif)
  left:          { type: Boolean, default: false },
  leftAt:        { type: Date, default: null },

  joinedAt:      { type: Date, default: Date.now },
});

// Un membre ne peut avoir qu'une seule entrée "active" par guild — on garde l'historique
// via left/leftAt plutôt que d'écraser, mais on indexe pour retrouver rapidement son état courant.
inviteUseSchema.index({ guildId: 1, userId: 1, joinedAt: -1 });
inviteUseSchema.index({ guildId: 1, inviterId: 1 });
// Stats (joins / actives / fake) et classement filtrés par serveur : couvre le
// $match { guildId, left, fake, inviterId } et le tri par inviteur.
inviteUseSchema.index({ guildId: 1, left: 1, fake: 1, inviterId: 1 });

module.exports = mongoose.model('InviteUse', inviteUseSchema);
