// utils/serverProtection.js — Utilitaires de protection serveur
const ServerProtection = require('../models/ServerProtection');
const { EmbedBuilder } = require('discord.js');
const { COLORS } = require('./embeds');

/**
 * Récupère ou crée la configuration de protection d'un serveur
 */
async function getProtectionConfig(guildId) {
  let config = await ServerProtection.findOne({ guildId });
  
  if (!config) {
    config = new ServerProtection({ guildId });
    await config.save();
  }
  
  return config;
}

/**
 * Vérifie si un raid est en cours (joins massifs)
 */
class RaidDetector {
  constructor() {
    this.joinTracking = new Map(); // guildId -> array of timestamps
  }

  trackJoin(guildId) {
    if (!this.joinTracking.has(guildId)) {
      this.joinTracking.set(guildId, []);
    }
    
    const now = Date.now();
    const joins = this.joinTracking.get(guildId);
    joins.push(now);
    
    // Nettoyer les anciens joins (> 2 minutes)
    const cleaned = joins.filter(time => now - time < 120000);
    this.joinTracking.set(guildId, cleaned);
  }

  async checkRaid(guild, config) {
    if (!config.antiRaid.enabled) return false;
    
    const joins = this.joinTracking.get(guild.id) || [];
    const now = Date.now();
    const timeWindow = config.antiRaid.joinTimeWindow * 1000;
    
    // Compter les joins dans la fenêtre de temps
    const recentJoins = joins.filter(time => now - time < timeWindow);
    
    if (recentJoins.length >= config.antiRaid.joinThreshold) {
      // RAID DÉTECTÉ !
      await this.handleRaid(guild, config, recentJoins.length);
      return true;
    }
    
    return false;
  }

  async handleRaid(guild, config, memberCount) {
    const actions = [];
    
    // Verrouiller le serveur
    if (config.antiRaid.autoLockServer) {
      try {
        await guild.setVerificationLevel(4); // VERY_HIGH
        actions.push('Serveur verrouillé (niveau de vérification maximum)');
      } catch (err) {
        console.error('Erreur verrouillage serveur:', err);
      }
    }
    
    // Envoyer une alerte
    if (config.antiRaid.alertChannelId) {
      try {
        const channel = await guild.channels.fetch(config.antiRaid.alertChannelId);
        const embed = new EmbedBuilder()
          .setColor(COLORS.error)
          .setTitle('🚨 RAID DÉTECTÉ')
          .setDescription(
            `**${memberCount} membres** ont rejoint en moins de **${config.antiRaid.joinTimeWindow}s** !\n\n` +
            `**Actions prises :**\n${actions.map(a => `✅ ${a}`).join('\n')}`
          )
          .setTimestamp();
        
        let content = '';
        if (config.antiRaid.alertRoleId) {
          content = `<@&${config.antiRaid.alertRoleId}>`;
        }
        
        await channel.send({ content, embeds: [embed] });
      } catch (err) {
        console.error('Erreur envoi alerte raid:', err);
      }
    }
    
    // Logger dans la DB
    config.antiRaid.raidDetections.push({
      detectedAt: new Date(),
      memberCount,
      timeWindow: config.antiRaid.joinTimeWindow,
      actionTaken: actions.join(', ')
    });
    
    config.statistics.totalRaidsBlocked++;
    config.statistics.lastIncident = new Date();
    await config.save();
  }
}

/**
 * Détecteur de liens suspects
 */
class LinkScanner {
  constructor() {
    this.suspiciousPatterns = [
      /discord\.gg\/[a-zA-Z0-9]+/gi,
      /discord\.com\/invite\/[a-zA-Z0-9]+/gi,
      /bit\.ly\//gi,
      /tinyurl\.com\//gi,
      /t\.co\//gi,
      /(nitro|steam|free|gift).*\.(ru|tk|ml|ga)/gi,
    ];
  }

  hasSuspiciousLink(message, config) {
    if (!config.linkProtection.enabled) return false;
    
    const content = message.content.toLowerCase();
    
    // Vérifier les invitations Discord
    if (config.linkProtection.blockInvites) {
      if (/(discord\.gg|discord\.com\/invite)/.test(content)) {
        return true;
      }
    }
    
    // Vérifier les patterns suspects
    if (config.linkProtection.blockSuspiciousLinks) {
      for (const pattern of this.suspiciousPatterns) {
        if (pattern.test(content)) {
          return true;
        }
      }
    }
    
    return false;
  }

  async handleSuspiciousLink(message, config) {
    // Supprimer le message
    if (config.linkProtection.deleteMessage) {
      try {
        await message.delete();
      } catch (err) {
        console.error('Erreur suppression message:', err);
      }
    }
    
    // Avertir l'utilisateur
    if (config.linkProtection.warnUser) {
      try {
        const warning = await message.channel.send({
          content: `⚠️ <@${message.author.id}>, les liens de ce type ne sont pas autorisés sur ce serveur.`,
        });
        
        setTimeout(() => warning.delete().catch(() => {}), 5000);
      } catch (err) {
        console.error('Erreur envoi avertissement:', err);
      }
    }
    
    // Timeout automatique
    if (config.linkProtection.autoTimeout) {
      try {
        await message.member.timeout(
          config.linkProtection.timeoutDuration * 1000,
          'Lien suspect posté'
        );
      } catch (err) {
        console.error('Erreur timeout utilisateur:', err);
      }
    }
    
    // Stats
    config.statistics.totalSuspiciousLinksBlocked++;
    await config.save();
  }
}

/**
 * Détecteur de spam
 */
class SpamDetector {
  constructor() {
    this.messageTracking = new Map(); // userId -> array of { content, timestamp }
  }

  trackMessage(message) {
    const userId = message.author.id;
    
    if (!this.messageTracking.has(userId)) {
      this.messageTracking.set(userId, []);
    }
    
    const messages = this.messageTracking.get(userId);
    messages.push({
      content: message.content,
      timestamp: Date.now(),
      messageId: message.id
    });
    
    // Nettoyer les anciens messages (> 30 secondes)
    const cleaned = messages.filter(m => Date.now() - m.timestamp < 30000);
    this.messageTracking.set(userId, cleaned);
  }

  async checkSpam(message, config) {
    if (!config.antiSpam.enabled) return false;
    
    const userId = message.author.id;
    const messages = this.messageTracking.get(userId) || [];
    const now = Date.now();
    const timeWindow = config.antiSpam.timeWindow * 1000;
    
    // Messages récents
    const recentMessages = messages.filter(m => now - m.timestamp < timeWindow);
    
    // Trop de messages
    if (recentMessages.length >= config.antiSpam.maxMessages) {
      await this.handleSpam(message, config, 'too_many');
      return true;
    }
    
    // Messages dupliqués
    const duplicates = recentMessages.filter(m => m.content === message.content);
    if (duplicates.length >= config.antiSpam.maxDuplicates) {
      await this.handleSpam(message, config, 'duplicates');
      return true;
    }
    
    return false;
  }

  async handleSpam(message, config, type) {
    // Supprimer les messages
    if (config.antiSpam.deleteMessages) {
      try {
        const messages = this.messageTracking.get(message.author.id) || [];
        for (const msg of messages) {
          try {
            const discordMsg = await message.channel.messages.fetch(msg.messageId);
            await discordMsg.delete();
          } catch (err) {
            // Message déjà supprimé ou introuvable
          }
        }
        this.messageTracking.delete(message.author.id);
      } catch (err) {
        console.error('Erreur suppression spam:', err);
      }
    }
    
    // Mute l'utilisateur
    if (config.antiSpam.muteUser) {
      try {
        await message.member.timeout(
          config.antiSpam.muteDuration * 1000,
          `Spam détecté (${type})`
        );
        
        const warning = await message.channel.send({
          content: `🔇 <@${message.author.id}> a été mis en timeout pour spam (${config.antiSpam.muteDuration / 60} minutes).`,
        });
        
        setTimeout(() => warning.delete().catch(() => {}), 10000);
      } catch (err) {
        console.error('Erreur timeout spam:', err);
      }
    }
    
    // Stats
    config.statistics.totalSpamMessagesDeleted++;
    config.statistics.totalUsersTimedOut++;
    await config.save();
  }
}

/**
 * Détecteur de mass mentions
 */
async function checkMassMention(message, config) {
  if (!config.antiMassMention.enabled) return false;
  
  const mentions = message.mentions.users.size + message.mentions.roles.size;
  
  if (mentions > config.antiMassMention.maxMentions) {
    // Supprimer le message
    if (config.antiMassMention.deleteMessage) {
      try {
        await message.delete();
      } catch (err) {
        console.error('Erreur suppression mass mention:', err);
      }
    }
    
    // Timeout
    if (config.antiMassMention.timeoutUser) {
      try {
        await message.member.timeout(
          config.antiMassMention.timeoutDuration * 1000,
          'Mentions massives'
        );
        
        const warning = await message.channel.send({
          content: `⚠️ <@${message.author.id}> a été mis en timeout pour mentions massives.`,
        });
        
        setTimeout(() => warning.delete().catch(() => {}), 10000);
      } catch (err) {
        console.error('Erreur timeout mass mention:', err);
      }
    }
    
    config.statistics.totalUsersTimedOut++;
    await config.save();
    
    return true;
  }
  
  return false;
}

/**
 * Vérifier l'âge du compte
 */
async function checkAccountAge(member, config) {
  if (!config.accountAgeProtection.enabled) return;
  
  const accountAge = Date.now() - member.user.createdTimestamp;
  const minAge = config.accountAgeProtection.minAccountAgeDays * 24 * 60 * 60 * 1000;
  
  if (accountAge < minAge) {
    const action = config.accountAgeProtection.action;
    
    if (action === 'kick') {
      try {
        await member.kick('Compte trop récent');
        config.statistics.totalUsersKicked++;
        await config.save();
      } catch (err) {
        console.error('Erreur kick compte récent:', err);
      }
    } else if (action === 'role' && config.accountAgeProtection.quarantineRoleId) {
      try {
        await member.roles.add(config.accountAgeProtection.quarantineRoleId);
      } catch (err) {
        console.error('Erreur ajout rôle quarantaine:', err);
      }
    } else if (action === 'alert' && config.accountAgeProtection.alertChannelId) {
      try {
        const channel = await member.guild.channels.fetch(config.accountAgeProtection.alertChannelId);
        const embed = new EmbedBuilder()
          .setColor(COLORS.warning)
          .setTitle('⚠️ Compte récent détecté')
          .setDescription(
            `<@${member.id}> vient de rejoindre.\n\n` +
            `**Âge du compte :** ${Math.floor(accountAge / (24 * 60 * 60 * 1000))} jours\n` +
            `**Minimum requis :** ${config.accountAgeProtection.minAccountAgeDays} jours`
          )
          .setThumbnail(member.user.displayAvatarURL())
          .setTimestamp();
        
        await channel.send({ embeds: [embed] });
      } catch (err) {
        console.error('Erreur alerte compte récent:', err);
      }
    }
  }
}

// Exports des instances
const raidDetector = new RaidDetector();
const linkScanner = new LinkScanner();
const spamDetector = new SpamDetector();

module.exports = {
  getProtectionConfig,
  raidDetector,
  linkScanner,
  spamDetector,
  checkMassMention,
  checkAccountAge,
};
