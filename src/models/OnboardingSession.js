const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  questionId: { type: String, required: true },
  label:      { type: String, default: '' }, // intitulé de la question au moment de la réponse
  answer:     { type: String, default: '' },
}, { _id: false });

// Cycle de vie d'un portail :
//   in_progress → (captcha?) → awaiting_captcha → approved
//                 ↘ (validation staff?) → pending_review → approved | rejected
const onboardingSessionSchema = new mongoose.Schema({
  guildId:            { type: String, required: true },
  userId:             { type: String, required: true },
  channelId:          { type: String, required: true },
  status:             {
    type: String,
    enum: ['in_progress', 'awaiting_captcha', 'pending_review', 'approved', 'rejected'],
    default: 'in_progress',
  },
  currentQuestionIdx: { type: Number, default: 0 },
  answers:            { type: [answerSchema], default: [] },
  completed:          { type: Boolean, default: false },
  // Portail terminé mais accès refusé tant que le captcha n'est pas résolu
  awaitingCaptcha:    { type: Boolean, default: false },

  remindedAt:         { type: Date, default: null },
  submittedAt:        { type: Date, default: null },
  reviewMessageId:    { type: String, default: null },
  decidedBy:          { type: String, default: null },
  decidedAt:          { type: Date, default: null },

  createdAt:          { type: Date, default: Date.now },
});

onboardingSessionSchema.index({ guildId: 1, userId: 1 }, { unique: true });
onboardingSessionSchema.index({ channelId: 1 });
onboardingSessionSchema.index({ status: 1 });

module.exports = mongoose.models.OnboardingSession || mongoose.model('OnboardingSession', onboardingSessionSchema);
