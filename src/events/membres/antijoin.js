'use strict';
// events/membres/antijoin.js — Vigie : contrôle du profil à l'arrivée.
//
// ⚠️ ORDRE D'EXÉCUTION : discord.js déclenche les listeners `guildMemberAdd`
// dans l'ordre d'enregistrement, et le noyau enregistre les fichiers triés par
// nom (voir core/registry.js). « antijoin.js » passe donc AVANT « antiraid.js »
// et « guildMemberAdd.js » : un profil dangereux est écarté avant que le
// message de bienvenue ne soit posté et avant tout autre traitement d'arrivée.
//
// La décision (et son application) vit dans src/utils/joinGuardActions.js.

const { handleMemberJoin } = require('../../utils/joinGuardActions');

module.exports = {
  name: 'guildMemberAdd',
  async execute(member, client) {
    try {
      const result = await handleMemberJoin(member, client);
      // Membre écarté : rien d'autre n'a de sens pour lui (bienvenue, rôles…).
      if (result?.action === 'kick' || result?.action === 'ban') return;
    } catch (err) {
      console.error('[vigie] guildMemberAdd:', err.message);
    }
  },
};
