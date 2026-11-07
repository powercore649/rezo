// models/ServerRescue.js — Système de récupération de serveur via 2FA + clé de récupération
// Permet au propriétaire de récupérer les permissions "Extra Owner" si son compte Discord est terminé

const mongoose = require('mongoose');

const serverRescueSchema = new mongoose.Schema({
  guildId: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  
  // Propriétaire d'origine qui a configuré le système
  originalOwnerId: { 
    type: String, 
    required: true 
  },
  
  // Secret TOTP (Google Authenticator / Authy)
  // Stocké crypté en base (à implémenter avec crypto si nécessaire)
  totpSecret: { 
    type: String, 
    required: true 
  },
  
  // Clé de récupération de 16 caractères (format: XXXX-XXXX-XXXX-XXXX)
  // Cette clé ne peut être générée qu'une seule fois
  recoveryKey: { 
    type: String, 
    required: true,
    unique: true 
  },
  
  // Propriétaire actuel (mis à jour après /claimserver)
  currentOwnerId: { 
    type: String, 
    default: null 
  },
  
  // Historique des réclamations
  claimHistory: [{
    userId: String,
    claimedAt: { type: Date, default: Date.now },
    ipAddress: String, // Optionnel pour la sécurité
    success: Boolean
  }],
  
  // Statut du système
  enabled: { 
    type: Boolean, 
    default: true 
  },
  
  // Tentatives échouées (protection anti-brute force)
  failedAttempts: { 
    type: Number, 
    default: 0 
  },
  
  lastFailedAttempt: { 
    type: Date, 
    default: null 
  },
  
  // Verrouillage temporaire après trop de tentatives
  lockedUntil: { 
    type: Date, 
    default: null 
  },
  
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Mise à jour automatique du timestamp
serverRescueSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('ServerRescue', serverRescueSchema);
