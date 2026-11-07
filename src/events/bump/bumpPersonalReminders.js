// events/bumpPersonalReminders.js — Vérifie toutes les minutes les rappels DM
// personnels arrivés à échéance et les envoie.
//
// Fichier INDÉPENDANT de events/ready.js : Node/discord.js autorisent
// plusieurs listeners 'ready' (client.once en enregistre un de plus, sans
// jamais toucher à celui déjà existant). Persistant en base (BumpReminder) :
// contrairement à un setTimeout en mémoire, un redémarrage du bot ne fait
// perdre aucun rappel en attente — le prochain passage du intervalle (≤60s
// après le redémarrage) le rattrape normalement.
const BumpReminder = require('../../models/BumpReminder');
const { EmbedBuilder } = require('discord.js');

async function checkDueReminders(client) {
  try {
    const due = await BumpReminder.find({ dueAt: { $lte: new Date() } }).lean();
    for (const reminder of due) {
      try {
        const guild = await client.guilds.fetch(reminder.guildId).catch(() => null);
        const user = await client.users.fetch(reminder.userId).catch(() => null);
        if (user) {
          const embed = new EmbedBuilder()
            .setColor(0xFEE75C)
            .setTitle('⏰ Cooldown terminé !')
            .setDescription(
              `Le cooldown de bump est terminé pour **${guild?.name || 'ton serveur'}** !\n` +
              "Utilise `/bump` pour le remettre en avant sur le réseau 🚀"
            )
            .setFooter({ text: 'Rappel personnel que tu as demandé' })
            .setTimestamp();
          await user.send({ embeds: [embed] }).catch(() => {
            // DMs fermés — on ignore silencieusement, le rappel est quand
            // même supprimé pour ne pas re-tenter indéfiniment.
          });
        }
      } catch (err) {
        console.error('❌ bumpPersonalReminders (envoi):', err.message);
      } finally {
        await BumpReminder.deleteOne({ _id: reminder._id }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('❌ bumpPersonalReminders:', err.message);
  }
}

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    checkDueReminders(client);
    setInterval(() => checkDueReminders(client), 60 * 1000);
  },
};
