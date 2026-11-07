// models/ServerProtection.js — Modèle de protection avancée du serveur
const mongoose = require('mongoose');

const serverProtectionSchema = new mongoose.Schema({
  guildId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // ═══════════════════════════════════════
  // PROTECTION ANTI-RAID
  // ═══════════════════════════════════════
  antiRaid: {
    enabled: { type: Boolean, default: false },
    
    // Détection de raid par joins massifs
    joinThreshold: { type: Number, default: 10 }, // Nombre de joins
    joinTimeWindow: { type: Number, default: 60 }, // En secondes
    
    // Actions automatiques
    autoLockServer: { type: Boolean, default: true }, // Verrouiller le serveur
    autoKickNewMembers: { type: Boolean, default: false }, // Kick automatique
    alertChannelId: { type: String, default: null },
    alertRoleId: { type: String, default: null }, // Rôle à ping en cas de raid
    
    // Whitelist
    whitelistedUsers: { type: [String], default: [] }, // Ne seront jamais kickés
    
    // Logs
    raidDetections: [{
      detectedAt: Date,
      memberCount: Number,
      timeWindow: Number,
      actionTaken: String // 'locked', 'kicked', 'alerted'
    }]
  },

  // ═══════════════════════════════════════
  // PROTECTION ANTI-NUKE
  // ═══════════════════════════════════════
  antiNuke: {
    enabled: { type: Boolean, default: false },
    
    // Surveillance des actions dangereuses
    maxChannelDeletes: { type: Number, default: 3 }, // En 60 secondes
    maxRoleDeletes: { type: Number, default: 3 },
    maxBans: { type: Number, default: 5 },
    maxKicks: { type: Number, default: 10 },
    
    // Actions de protection
    autoRemovePermissions: { type: Boolean, default: true }, // Retirer permissions dangereuses
    autoRevokeBot: { type: Boolean, default: false }, // Kick bot malveillant
    
    // Whitelist (admins de confiance)
    trustedAdmins: { type: [String], default: [] },
    
    // Logs d'incidents
    nukeAttempts: [{
      userId: String,
      action: String, // 'channel_delete', 'role_delete', 'mass_ban', etc.
      timestamp: Date,
      prevented: Boolean,
      details: String
    }]
  },

  // ═══════════════════════════════════════
  // PROTECTION LIENS & SPAM
  // ═══════════════════════════════════════
  linkProtection: {
    enabled: { type: Boolean, default: false },
    
    // Filtres de liens
    blockInvites: { type: Boolean, default: true }, // Bloquer invitations Discord
    blockSuspiciousLinks: { type: Boolean, default: true }, // Liens raccourcis, phishing
    allowedDomains: { type: [String], default: [] }, // Domaines autorisés
    
    // Exceptions
    whitelistedRoles: { type: [String], default: [] }, // Rôles autorisés à poster des liens
    whitelistedChannels: { type: [String], default: [] }, // Salons où liens OK
    
    // Actions
    deleteMessage: { type: Boolean, default: true },
    warnUser: { type: Boolean, default: true },
    autoTimeout: { type: Boolean, default: false },
    timeoutDuration: { type: Number, default: 300 }, // En secondes (5 min)
  },

  // ═══════════════════════════════════════
  // PROTECTION ANTI-SPAM
  // ═══════════════════════════════════════
  antiSpam: {
    enabled: { type: Boolean, default: false },
    
    // Détection
    maxMessages: { type: Number, default: 5 }, // Nombre de messages
    timeWindow: { type: Number, default: 5 }, // En secondes
    maxDuplicates: { type: Number, default: 3 }, // Messages identiques
    
    // Actions
    deleteMessages: { type: Boolean, default: true },
    muteUser: { type: Boolean, default: true },
    muteDuration: { type: Number, default: 600 }, // 10 minutes
    
    // Exceptions
    ignoredRoles: { type: [String], default: [] },
    ignoredChannels: { type: [String], default: [] },
  },

  // ═══════════════════════════════════════
  // PROTECTION MENTIONS MASSIVES
  // ═══════════════════════════════════════
  antiMassMention: {
    enabled: { type: Boolean, default: false },
    maxMentions: { type: Number, default: 5 }, // Mentions max par message
    
    // Actions
    deleteMessage: { type: Boolean, default: true },
    timeoutUser: { type: Boolean, default: true },
    timeoutDuration: { type: Number, default: 3600 }, // 1 heure
    
    // Exceptions
    allowedRoles: { type: [String], default: [] },
  },

  // ═══════════════════════════════════════
  // VÉRIFICATION DE NOUVEAUX MEMBRES
  // ═══════════════════════════════════════
  memberVerification: {
    enabled: { type: Boolean, default: false },
    
    // Méthode de vérification
    method: { 
      type: String, 
      enum: ['button', 'captcha', 'reaction'], 
      default: 'button' 
    },
    
    // Configuration
    verificationChannelId: { type: String, default: null },
    verifiedRoleId: { type: String, default: null },
    unverifiedRoleId: { type: String, default: null },
    
    // Auto-kick non vérifiés
    autoKickUnverified: { type: Boolean, default: false },
    kickAfterMinutes: { type: Number, default: 10 },
    
    // Message personnalisé
    welcomeMessage: { 
      type: String, 
      default: '👋 Bienvenue ! Cliquez sur le bouton ci-dessous pour accéder au serveur.' 
    },
  },

  // ═══════════════════════════════════════
  // PROTECTION COMPTE RÉCENT
  // ═══════════════════════════════════════
  accountAgeProtection: {
    enabled: { type: Boolean, default: false },
    minAccountAgeDays: { type: Number, default: 7 }, // Âge minimum du compte
    
    // Actions
    action: { 
      type: String, 
      enum: ['kick', 'role', 'alert'], 
      default: 'alert' 
    },
    quarantineRoleId: { type: String, default: null }, // Rôle de quarantaine
    alertChannelId: { type: String, default: null },
  },

  // ═══════════════════════════════════════
  // LOGS & STATISTIQUES
  // ═══════════════════════════════════════
  securityLogChannelId: { type: String, default: null }, // Salon de logs sécurité
  
  statistics: {
    totalRaidsBlocked: { type: Number, default: 0 },
    totalNukesPrevented: { type: Number, default: 0 },
    totalSpamMessagesDeleted: { type: Number, default: 0 },
    totalSuspiciousLinksBlocked: { type: Number, default: 0 },
    totalUsersTimedOut: { type: Number, default: 0 },
    totalUsersKicked: { type: Number, default: 0 },
    lastIncident: { type: Date, default: null },
  },

  // ═══════════════════════════════════════
  // BACKUP AUTOMATIQUE
  // ═══════════════════════════════════════
  autoBackup: {
    enabled: { type: Boolean, default: false },
    frequency: { 
      type: String, 
      enum: ['daily', 'weekly', 'monthly'], 
      default: 'weekly' 
    },
    includeMessages: { type: Boolean, default: false },
    lastBackup: { type: Date, default: null },
    backupCount: { type: Number, default: 0 },
  },

  // Métadonnées
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastModifiedBy: { type: String, default: null }, // User ID qui a modifié la config
});

// Mise à jour automatique du champ updatedAt
serverProtectionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('ServerProtection', serverProtectionSchema);
