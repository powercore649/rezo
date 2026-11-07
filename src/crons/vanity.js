'use strict';
// crons/vanity.js — Rattrapage du vanity par statut.
//
// `presenceUpdate` ne couvre que les changements en direct : après un
// redémarrage, un membre qui affichait déjà le statut n'émettrait aucun
// événement. Cette passe (toutes les 10 minutes, sur chaque shard, pour les
// serveurs qu'il voit) :
//   • attribue le rôle aux présences qui affichent le statut ;
//   • retire le rôle à celles qui ne l'affichent plus, une fois le délai de
//     grâce écoulé.
//
// Elle ne fait rien pour un serveur où le module est désactivé (config lue en
// cache, sans requête par serveur à chaque message).

const vanity = require('../utils/vanityEngine');

module.exports = {
  name: 'vanity-sweep',
  schedule: '*/10 * * * *',
  scope: 'guilds',

  async execute(client) {
    const totals = await vanity.sweepAll(client);
    if (totals.granted || totals.revoked || totals.skipped) {
      console.log(
        `💎 Vanity : ${totals.granted} rôle(s) attribué(s), ${totals.revoked} retiré(s), `
        + `${totals.skipped} en attente de conditions sur ${totals.guilds} serveur(s)`,
      );
    }
    return totals;
  },
};
