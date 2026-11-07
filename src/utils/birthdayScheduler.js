'use strict';
// utils/birthdayScheduler.js — Annonces d'anniversaire fiables.
//
// Le planificateur tourne toutes les heures (et une fois au démarrage). Il est
// donc idempotent : un anniversaire n'est annoncé qu'une fois par jour, même si
// le bot redémarre, rate une heure ou reste hors ligne toute la matinée.
//
// Ce qui est garanti :
//   • l'heure et le fuseau sont ceux du serveur, pas ceux de la machine ;
//   • un 29 février est souhaité le 28 les années non bissextiles ;
//   • un envoi raté (salon supprimé, permissions manquantes) n'est PAS marqué
//     comme annoncé : la tentative suivante réessaie ;
//   • le rôle temporaire est retiré le lendemain, même si le bot était éteint ;
//   • un essai gratuit actif suffit (comme pour les commandes), pas seulement
//     une licence payante.

const Birthday = require('../models/Birthday');
const BirthdayConfig = require('../models/BirthdayConfig');
const { EmbedBuilder } = require('discord.js');
const licenseGate = require('./licenseGate');
const engine = require('./birthdayEngine');

const BIRTHDAY_COLOR = 0xf2a93b;

function buildAnnouncement({ message, member, guild, pingRoleId = null }) {
  const text = engine.renderMessage(message, {
    user: `<@${member.id}>`,
    server: guild.name,
  });
  const embed = new EmbedBuilder()
    .setColor(BIRTHDAY_COLOR)
    .setTitle('🎂 Anniversaire !')
    .setDescription(text)
    .setTimestamp();
  const avatar = typeof member.displayAvatarURL === 'function' ? member.displayAvatarURL() : null;
  if (avatar) embed.setThumbnail(avatar);
  return { content: pingRoleId ? `<@&${pingRoleId}>` : undefined, embeds: [embed] };
}

/**
 * Parcourt les serveurs configurés et annonce les anniversaires dus.
 * @param {import('discord.js').Client} client
 * @param {{now?: Date, logger?: Console}} options
 */
async function checkBirthdays(client, { now = new Date(), logger = console } = {}) {
  const summary = { guilds: 0, announced: 0, failed: 0, rolesCleared: 0, skipped: 0, errors: 0 };

  let configs = [];
  try {
    // Chaque shard ne lit que ses serveurs ; le test `guild` plus bas reste une
    // ceinture de sécurité si le cache change entre la requête et la boucle.
    const { guildScope } = require('../core/sharding');
    configs = await BirthdayConfig.find(guildScope(client, { enabled: true }));
  } catch (err) {
    logger.error('[anniversaires] lecture des configurations impossible :', err.message);
    return { ...summary, errors: 1 };
  }

  for (const config of configs) {
    try {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild) continue;
      summary.guilds++;

      // Même règle que les commandes : licence active OU essai gratuit actif.
      let access = null;
      try {
        access = await licenseGate.checkAccess(config.guildId, 'anniversaire');
      } catch {
        access = null;
      }
      if (!access || !access.ok) { summary.skipped++; continue; }

      const timezone = engine.sanitizeTimezone(config.timezone);
      const today = engine.partsInTimeZone(now, timezone);

      // Pas encore l'heure d'annonce : on repassera à l'heure suivante.
      if (!engine.isAnnounceTime(today, config.announceHour)) { summary.skipped++; continue; }

      const role = config.roleId ? guild.roles.cache.get(config.roleId) : null;

      // ── Retirer les rôles d'anniversaire accordés un autre jour ────────────
      if (role) {
        let stale = [];
        try {
          stale = await Birthday.find({ guildId: config.guildId, roleGrantedOn: { $nin: [null, today.key] } });
        } catch { stale = []; }
        for (const doc of stale) {
          try {
            const member = await guild.members.fetch(doc.userId).catch(() => null);
            if (member?.roles?.cache?.has(role.id)) {
              await member.roles.remove(role, 'Anniversaire terminé').catch(() => {});
            }
            doc.roleGrantedOn = null;
            await doc.save().catch(() => {});
            summary.rolesCleared++;
          } catch (err) {
            logger.warn?.(`[anniversaires] retrait du rôle impossible (${config.guildId}/${doc.userId}) :`, err.message);
          }
        }
      }

      // ── Anniversaires du jour (29/02 compris) ─────────────────────────────
      const pairs = [{ month: today.month, day: today.day }];
      if (today.month === 2 && today.day === 28 && !engine.isLeapYear(today.year)) {
        pairs.push({ month: 2, day: 29 });
      }

      let candidates = [];
      try {
        candidates = await Birthday.find({ guildId: config.guildId, $or: pairs });
      } catch (err) {
        logger.error(`[anniversaires] lecture des inscrits impossible (${config.guildId}) :`, err.message);
        summary.errors++;
        continue;
      }

      const pending = candidates.filter(doc => {
        if (!engine.isBirthdayOn(doc, today)) return false;
        // Nouvelle clé datée ; repli sur l'ancien champ annuel pour les données
        // créées avant la mise à jour.
        if (doc.lastAnnouncedOn) return doc.lastAnnouncedOn !== today.key;
        return doc.lastAnnouncedYear !== today.year;
      });

      if (!pending.length) continue;

      const channel = config.channelId ? guild.channels.cache.get(config.channelId) : null;
      if (!channel || typeof channel.send !== 'function') {
        summary.failed++;
        logger.warn?.(`[anniversaires] salon introuvable sur ${guild.name} — annonce en attente.`);
        continue;
      }

      for (const doc of pending) {
        const member = await guild.members.fetch(doc.userId).catch(() => null);
        if (!member) {
          // Membre parti : on ne marque rien, il sera annoncé s'il revient.
          summary.failed++;
          continue;
        }

        let roleGranted = false;
        if (role) {
          roleGranted = await member.roles.add(role, 'Anniversaire du jour')
            .then(() => true)
            .catch(() => false);
          doc.roleGrantedOn = roleGranted ? today.key : doc.roleGrantedOn;
        }

        const payload = buildAnnouncement({
          message: config.message,
          member,
          guild,
          pingRoleId: config.pingRoleId,
        });

        const sent = await channel.send(payload).then(() => true).catch(err => {
          logger.error(`[anniversaires] envoi impossible (${guild.name}) :`, err.message);
          return false;
        });

        if (!sent) {
          // Ne pas marquer comme annoncé : la prochaine passe réessaiera.
          summary.failed++;
          if (roleGranted) await doc.save().catch(() => {});
          continue;
        }

        doc.lastAnnouncedOn = today.key;
        doc.lastAnnouncedYear = today.year;
        await doc.save().catch(err => logger.error('[anniversaires] sauvegarde impossible :', err.message));
        summary.announced++;
      }
    } catch (err) {
      summary.errors++;
      logger.error(`[anniversaires] échec sur le serveur ${config.guildId} :`, err.message);
    }
  }

  if (summary.announced || summary.failed || summary.rolesCleared) {
    logger.log?.(`🎂 Anniversaires : ${summary.announced} annonce(s), ${summary.failed} en attente, ${summary.rolesCleared} rôle(s) retiré(s).`);
  }
  return summary;
}

module.exports = { checkBirthdays, buildAnnouncement };
