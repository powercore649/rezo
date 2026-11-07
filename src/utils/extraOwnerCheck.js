// utils/extraOwnerCheck.js — Vérification des permissions Extra Owner
// Les Extra Owners ont des permissions étendues sur le serveur via le bot

const Server = require('../models/Server');

/**
 * Vérifie si un utilisateur est un Extra Owner sur un serveur
 * @param {string} userId - ID Discord de l'utilisateur
 * @param {string} guildId - ID du serveur Discord
 * @returns {Promise<boolean>}
 */
async function isExtraOwner(userId, guildId) {
  try {
    const serverConfig = await Server.findOne({ guildId });
    
    if (!serverConfig || !serverConfig.extraOwners) {
      return false;
    }
    
    return serverConfig.extraOwners.includes(userId);
  } catch (error) {
    console.error('Erreur lors de la vérification Extra Owner:', error);
    return false;
  }
}

/**
 * Vérifie si un utilisateur est propriétaire du serveur Discord OU Extra Owner
 * @param {Interaction} interaction - Interaction Discord.js
 * @returns {Promise<boolean>}
 */
async function isServerOwnerOrExtra(interaction) {
  // Le propriétaire Discord a toujours accès
  if (interaction.guild.ownerId === interaction.user.id) {
    return true;
  }
  
  // Vérifier si c'est un Extra Owner
  return await isExtraOwner(interaction.user.id, interaction.guild.id);
}

/**
 * Vérifie si un utilisateur est un owner global du bot (OWNER_IDS)
 * @param {string} userId - ID Discord de l'utilisateur
 * @returns {boolean}
 */
function isBotOwner(userId) {
  const ownerIds = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return ownerIds.includes(userId);
}

/**
 * Vérifie si un utilisateur a les permissions maximales (Bot Owner OU Server Owner OU Extra Owner)
 * @param {Interaction} interaction - Interaction Discord.js
 * @returns {Promise<boolean>}
 */
async function hasMaxPermissions(interaction) {
  // Bot Owner a toujours accès
  if (isBotOwner(interaction.user.id)) {
    return true;
  }
  
  // Vérifier Server Owner ou Extra Owner
  return await isServerOwnerOrExtra(interaction);
}

/**
 * Ajoute un Extra Owner à un serveur
 * @param {string} userId - ID Discord de l'utilisateur à ajouter
 * @param {string} guildId - ID du serveur Discord
 * @returns {Promise<boolean>} true si ajouté avec succès
 */
async function addExtraOwner(userId, guildId) {
  try {
    let serverConfig = await Server.findOne({ guildId });
    
    if (!serverConfig) {
      serverConfig = new Server({
        guildId,
        extraOwners: [userId]
      });
    } else {
      if (!serverConfig.extraOwners.includes(userId)) {
        serverConfig.extraOwners.push(userId);
      } else {
        return false; // Déjà présent
      }
    }
    
    await serverConfig.save();
    return true;
  } catch (error) {
    console.error('Erreur lors de l\'ajout d\'un Extra Owner:', error);
    return false;
  }
}

/**
 * Retire un Extra Owner d'un serveur
 * @param {string} userId - ID Discord de l'utilisateur à retirer
 * @param {string} guildId - ID du serveur Discord
 * @returns {Promise<boolean>} true si retiré avec succès
 */
async function removeExtraOwner(userId, guildId) {
  try {
    const serverConfig = await Server.findOne({ guildId });
    
    if (!serverConfig || !serverConfig.extraOwners.includes(userId)) {
      return false;
    }
    
    serverConfig.extraOwners = serverConfig.extraOwners.filter(id => id !== userId);
    await serverConfig.save();
    return true;
  } catch (error) {
    console.error('Erreur lors de la suppression d\'un Extra Owner:', error);
    return false;
  }
}

/**
 * Liste tous les Extra Owners d'un serveur
 * @param {string} guildId - ID du serveur Discord
 * @returns {Promise<string[]>} Array d'IDs Discord
 */
async function listExtraOwners(guildId) {
  try {
    const serverConfig = await Server.findOne({ guildId });
    return serverConfig?.extraOwners || [];
  } catch (error) {
    console.error('Erreur lors de la récupération des Extra Owners:', error);
    return [];
  }
}

module.exports = {
  isExtraOwner,
  isServerOwnerOrExtra,
  isBotOwner,
  hasMaxPermissions,
  addExtraOwner,
  removeExtraOwner,
  listExtraOwners
};
