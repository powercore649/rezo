'use strict';
// core/defineCommand.js — Contrat de commande v2.
//
// defineCommand({ data, meta, guards, execute }) renvoie un module au format
// attendu par le loader ({ data, execute }) : les commandes v2 et les 116
// commandes historiques cohabitent donc sans rien changer au chargeur.
//
// Ce que le wrapper apporte automatiquement :
//   • exécution des guards (permissions, owner, licence, cooldown…) ;
//   • réponse d'échec propre et éphémère si un guard refuse ;
//   • defer automatique optionnel (meta.defer) ;
//   • capture d'erreur → réponse uniforme, jamais de crash d'interaction.
//
// meta reconnu : { category, description, guildOnly, ownerOnly, permissions,
// botPermissions, license, cooldown, cooldownScope, defer, ephemeral }.

const { runGuards, guardsFromMeta } = require('./guards');
const { handleInteractionError } = require('./errors');

const VALID_DEFER = ['reply', 'update', true, false, undefined, null];

async function replyGuardFailure(interaction, result) {
  const payload = { content: result?.message || 'Accès refusé.', ephemeral: true };
  try {
    if (interaction.deferred && !interaction.replied) await interaction.editReply(payload);
    else if (interaction.replied) await interaction.followUp(payload);
    else if (typeof interaction.reply === 'function') await interaction.reply(payload);
  } catch { /* on ignore : la commande est simplement refusée */ }
  return result;
}

function defineCommand({ data, meta = {}, guards = [], execute } = {}) {
  if (!data || typeof data.name !== 'string') throw new Error('defineCommand : `data` (SlashCommandBuilder avec un nom) est requis.');
  if (typeof execute !== 'function') throw new Error('defineCommand : `execute` (fonction) est requise.');
  if (!VALID_DEFER.includes(meta.defer)) throw new Error(`defineCommand : meta.defer invalide (${meta.defer}).`);

  const allGuards = [...guardsFromMeta(meta, data), ...guards];

  async function wrapped(interaction, client) {
    const ctx = { interaction, client, command: data.name, meta };

    const verdict = await runGuards(allGuards, ctx).catch(err => ({
      ok: false, message: 'Vérification impossible, réessaie.', code: 'GUARD_CRASH', error: err,
    }));
    if (verdict.ok === false) return replyGuardFailure(interaction, verdict);

    // Defer optionnel : évite l'expiration des 3 s sur les commandes longues.
    if (meta.defer && typeof interaction?.deferReply === 'function') {
      const method = meta.defer === 'update' ? 'deferUpdate' : 'deferReply';
      try {
        if (method === 'deferUpdate' && typeof interaction.deferUpdate === 'function') await interaction.deferUpdate();
        else await interaction.deferReply({ ephemeral: meta.ephemeral !== false });
      } catch { /* déjà répondu : on continue */ }
    }

    try {
      return await execute(interaction, client, ctx);
    } catch (err) {
      return handleInteractionError(interaction, err);
    }
  }

  return { data, execute: wrapped, meta, __v2: true };
}

module.exports = { defineCommand };
