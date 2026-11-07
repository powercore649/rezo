'use strict';
// crons/antiVpn.js — Expiration des vérifications anti-VPN.
//
// Un membre qui n'ouvre jamais son lien ne doit pas rester indéfiniment en
// attente : la politique du serveur (timeoutAction) s'applique. Une passe par
// minute suffit — le délai se règle en minutes et la session porte sa propre
// échéance, donc aucun état à recalculer au redémarrage.
module.exports = {
  name: 'anti-vpn-expiration',
  // Sanction + MP : réservé au shard 0 pour ne jamais expirer deux fois.
  schedule: '* * * * *',
  async execute(client) {
    const { expirePending } = require('../utils/antiVpnFlow');
    const processed = await expirePending(client);
    if (processed) console.log(`[anti-vpn] ${processed} vérification(s) expirée(s)`);
  },
};
