const mongoose = require('mongoose');

// Une étape du portail. Quatre types :
//   text   — le membre répond par un message dans son salon
//   choice — boutons (un clic = une réponse)
//   roles  — menu de rôles : la réponse EST l'attribution des rôles choisis
//   rules  — bouton « J'accepte » (règlement, charte, CGU…)
const questionSchema = new mongoose.Schema({
  id:         { type: String, required: true }, // identifiant court stable (ex: "q_1699999999")
  type:       { type: String, enum: ['text', 'choice', 'roles', 'rules'], default: 'text' },
  prompt:     { type: String, required: true },
  choices:    { type: [String], default: [] },  // libellés (choice) ou IDs de rôles (roles)
  required:   { type: Boolean, default: true },  // si false, le membre peut passer l'étape
  maxChoices: { type: Number, default: 5, min: 1, max: 10 }, // type roles uniquement
}, { _id: false });

const onboardingConfigSchema = new mongoose.Schema({
  guildId:              { type: String, required: true, unique: true },
  enabled:              { type: Boolean, default: false },

  // private = un salon éphémère par membre ; shared = un seul salon pour tous.
  // Le mode partagé évite de créer un salon par arrivée (gros serveurs, quota
  // de salons) et laisse l'historique visible du staff.
  mode:                 { type: String, enum: ['private', 'shared'], default: 'private' },
  sharedChannelId:      { type: String, default: null },
  categoryId:           { type: String, default: null }, // catégorie des salons d'accueil

  unverifiedRoleId:     { type: String, default: null }, // rôle appliqué à l'arrivée (accès restreint)
  accessRoleId:         { type: String, default: null }, // historique : un seul rôle d'accès
  accessRoleIds:        { type: [String], default: [] }, // plusieurs rôles d'accès (nouveau)

  welcomeMessage:       { type: String, default: 'Bienvenue {user} ! Réponds aux quelques questions ci-dessous pour accéder au serveur.' },
  dmWelcome:            { type: Boolean, default: true }, // MP d'accueil avec le lien du portail
  dmMessage:            { type: String, default: '👋 Bienvenue sur **{server}** !\nTon accès passe par un court portail : {link}\nRéponds aux questions, puis tu recevras tes rôles.' },
  completionMessage:    { type: String, default: '✅ Merci {user}, tu as maintenant accès au serveur !' },
  rejectionMessage:     { type: String, default: '⛔ Ta demande d’accès à **{server}** n’a pas été acceptée. Contacte le staff si tu penses qu’il s’agit d’une erreur.' },

  deleteChannelOnComplete: { type: Boolean, default: true },
  timeoutMinutes:       { type: Number, default: 0, min: 0, max: 10080 }, // 0 = pas de limite de temps
  timeoutAction:        { type: String, enum: ['kick', 'none'], default: 'kick' },
  remindAfterMinutes:   { type: Number, default: 0, min: 0, max: 10080 }, // 0 = pas de relance

  logChannelId:         { type: String, default: null }, // journal des passages et décisions

  // Validation manuelle : le portail terminé part au staff, l'accès n'est
  // accordé qu'après approbation. Sans salon de validation, le portail
  // fonctionne normalement (aucun membre ne reste bloqué).
  reviewEnabled:        { type: Boolean, default: false },
  reviewChannelId:      { type: String, default: null },
  reviewPingRoleId:     { type: String, default: null },
  reviewTimeoutMinutes: { type: Number, default: 0, min: 0, max: 10080 }, // 0 = jamais
  reviewRejectAction:   { type: String, enum: ['none', 'kick'], default: 'none' },

  questions:            { type: [questionSchema], default: [] },

  totalStarted:         { type: Number, default: 0 },
  totalCompleted:       { type: Number, default: 0 },
  totalTimedOut:        { type: Number, default: 0 },
  totalApproved:        { type: Number, default: 0 }, // validations manuelles acceptées
  totalRejected:        { type: Number, default: 0 }, // validations manuelles refusées
});

module.exports = mongoose.models.OnboardingConfig || mongoose.model('OnboardingConfig', onboardingConfigSchema);
