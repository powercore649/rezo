'use strict';
// events/guildMemberUpdate.js — Détecte les boosts (début ET fin).
//
//  • début (premiumSinceTimestamp null → date) : message d'annonce + rôle bonus ;
//  • fin (date → null) : retrait du rôle bonus ;
//  • membre partiel : on le récupère avant de lire premiumSinceTimestamp,
//    sinon un boost serait silencieusement ignoré.

const BoostConfig = require('../../models/BoostConfig');
const { sendBoostMessage, removeBoosterRole } = require('../../utils/boostManager');

// Séparé de l'event pour être testable hors-ligne.
async function handleBoostUpdate(oldMember, newMember) {
  if (newMember?.partial && typeof newMember.fetch === 'function') {
    await newMember.fetch().catch(() => {});
  }

  const wasBoosting = Boolean(oldMember?.premiumSinceTimestamp);
  const isBoosting = Boolean(newMember?.premiumSinceTimestamp);
  if (wasBoosting === isBoosting) return { handled: false };

  const guildId = newMember?.guild?.id;
  if (!guildId) return { handled: false };

  const config = await BoostConfig.findOne({ guildId });
  if (!config || !config.enabled) return { handled: false, reason: 'disabled' };

  if (isBoosting) {
    const result = await sendBoostMessage(newMember, config);
    return { handled: true, action: 'boost', ...result };
  }

  const removed = await removeBoosterRole(newMember, config);
  return { handled: true, action: 'unboost', roleRemoved: removed };
}

module.exports = {
  name: 'guildMemberUpdate',
  async execute(oldMember, newMember) {
    try {
      return await handleBoostUpdate(oldMember, newMember);
    } catch (err) {
      console.error('❌ guildMemberUpdate (boost):', err.message);
      return { handled: false, error: err.message };
    }
  },
  handleBoostUpdate,
};
