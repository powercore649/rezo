const mongoose = require('mongoose');
const faqSchema = new mongoose.Schema({
  guildId:  { type: String, required: true },
  question: { type: String, required: true },
  answer:   { type: String, required: true },
  faqId:    { type: String, required: true },
});
faqSchema.index({ guildId: 1, faqId: 1 }, { unique: true });
module.exports = mongoose.model('FAQ', faqSchema);
